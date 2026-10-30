import * as vscode from 'vscode';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { SessionIndex } from './session-manager';
import { ClaudeTracker } from './claude-tracker';
import { AgentRegistry } from './agents/registry';
import { getConfig } from './config';
import { parseSessionName } from './workspace-id';
import { conversationTitle } from './conversation-title';
import { readClaudeCustomTitle } from './claude-transcript';
import { isDefaultOpencodeTitle } from './agents/opencode/transcript';
import { PARKED_PREFIX } from './profile-provider';
import { isWalkingTabs, runTabWalk } from './tab-order';
import type { TerminalTracker } from './terminal-tracker';
import type { SessionLabel } from './types';

// Follow Conversation Title (opt-in): a session shows the title of the
// conversation running in it, the one the agent generated or the one set with
// its own /rename, on its sidebar row and on its terminal tab.
//
// The sidebar follows at once. A tab is harder: VS Code renames only the ACTIVE
// terminal, and making a background tab active for a moment would send your
// keys there, move the editor tabs and read its unread mark. So a tab takes
// its new title only when no key can land in the wrong place:
//   - it is the active tab already (when the title arrives, or when you open it);
//   - you are away: the window has no focus AND (macOS) no key or mouse input
//     for a minute. Then the waiting tabs are renamed in one walk, which gives
//     the previous tab and editor back and stops the moment the window is
//     focused again;
//   - Re-attach / Restart All, and any reopen, name the new tab from the start.
// A session you named keeps its name; only unnamed ones follow, unless you
// choose Follow Conversation Title Again on a named one.

/** A named session keeps its name, unless the user chose to follow it anyway
 *  (titlePinned false). A label equal to the workspace or folder name is the
 *  extension's default, not a name. */
export function isTitlePinned(
  meta: Pick<SessionLabel, 'label' | 'folderPath' | 'titlePinned'> | undefined,
  wsLabel: string | undefined,
): boolean {
  if (meta?.titlePinned !== undefined) return meta.titlePinned;
  const label = meta?.label?.trim();
  if (!label) return false;
  return label !== wsLabel?.trim() && label !== meta?.folderPath?.split('/').pop();
}

/** A title must hold this long before a tab takes it (titles get revised). */
const SETTLE_MS = 2000;
const TICK_MS = 3000;
/** No input for this long, with the window unfocused, counts as away. */
const AWAY_MS = 60_000;
/** A non-Claude transcript is re-read at most this often. */
const OTHER_READ_MS = 15_000;
const MAX_TITLE = 60;
const CHUNK = 4 * 1024 * 1024;

export interface TitleCache {
  size: number;
  mtimeMs: number;
  /** Claude: bytes scanned, up to the last complete line. */
  offset: number;
  /** The title set inside the agent (/rename), as the agent last wrote it. */
  custom?: string;
  auto?: string;
  readAt: number;
  reading?: boolean;
  /** Claude: the custom title from the transcript records, kept apart from
   *  the sidecar file so neither hides a newer value of the other. */
  recordCustom?: string;
  /** A custom-title record was seen, an empty one (a cleared /rename) too. */
  recordSeen?: boolean;
}

/** Seconds since the last keyboard or mouse input, macOS only. */
function systemIdleMs(): Promise<number | undefined> {
  if (process.platform !== 'darwin') return Promise.resolve(undefined);
  return new Promise(resolve => {
    execFile('ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime'], { timeout: 2000 }, (err, out) => {
      const m = !err && /"HIDIdleTime"\s*=\s*(\d+)/.exec(out);
      resolve(m ? Number(m[1]) / 1e6 : undefined);
    });
  });
}

export function cleanTitle(v: string | undefined): string | undefined {
  // eslint-disable-next-line no-control-regex
  const t = v?.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1).trimEnd()}…` : t;
}

/** Agents whose transcript carries the title as appended records, read
 *  incrementally: the marker a title line contains, and what it sets. */
const TITLE_RECORDS: Record<string, { marks: string[]; take: (r: Record<string, unknown>, c: TitleCache) => void }> = {
  // Claude: `ai-title`, and `custom-title` from /rename ('' clears it).
  claude: {
    marks: ['"ai-title"', '"custom-title"'],
    take: (r, c) => {
      if (r.type === 'custom-title' && typeof r.customTitle === 'string') {
        c.recordSeen = true;
        c.recordCustom = r.customTitle || undefined;
      }
      else if (r.type === 'ai-title' && typeof r.aiTitle === 'string') c.auto = r.aiTitle;
    },
  },
  // OpenCode (our plugin's JSONL): a `session` line each time the title
  // changes. Child sessions (subagents) write into the root's file too, so
  // only a line without a parent counts.
  opencode: {
    marks: ['"type":"session"'],
    take: (r, c) => {
      if (r.type !== 'session' || r.parentID) return;
      if (typeof r.title === 'string' && !isDefaultOpencodeTitle(r.title)) c.auto = r.title;
    },
  },
};

/** Read the bytes appended since the last scan and pick the title records
 *  out of them; only lines carrying a marker are parsed. Works on raw bytes,
 *  cut only at newlines, so a character split by a chunk end is never
 *  decoded in halves and the offset stays exact. */
export async function scanTitles(tp: string, c: TitleCache, st: fs.Stats, agent: string): Promise<void> {
  const rec = TITLE_RECORDS[agent];
  if (!rec) return;
  const marks = rec.marks.map(m => Buffer.from(m));
  c.reading = true;
  try {
    // Rewritten or truncated: start over.
    if (st.size < c.offset) { c.offset = 0; c.custom = undefined; c.recordCustom = undefined; c.recordSeen = undefined; c.auto = undefined; }
    const fh = await fs.promises.open(tp, 'r');
    try {
      let carry: Buffer = Buffer.alloc(0);
      let at = c.offset;
      while (at < st.size) {
        const chunk = Buffer.allocUnsafe(Math.min(CHUNK, st.size - at));
        // eslint-disable-next-line no-await-in-loop
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, at);
        if (bytesRead === 0) break;
        at += bytesRead;
        const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        const end = buf.lastIndexOf(0x0a);
        if (end < 0) { carry = Buffer.from(buf); continue; }
        const whole = buf.subarray(0, end);
        // Most chunks carry no title at all: skip them without splitting.
        if (marks.some(m => whole.includes(m))) {
          for (const line of whole.toString('utf8').split('\n')) {
            if (!rec.marks.some(m => line.includes(m))) continue;
            try {
              const r = JSON.parse(line);
              if (r && typeof r === 'object') rec.take(r, c);
            } catch { /* not a whole record */ }
          }
        }
        carry = Buffer.from(buf.subarray(end + 1));
      }
      // Up to the last complete line: a half-written one is read next time.
      c.offset = at - carry.length;
    } finally { await fh.close(); }
    // A Claude /rename lives in the records; the sidecar (written by Rename
    // from the extension, next to a record) only stands in when none is there.
    if (agent === 'claude') c.custom = c.recordSeen ? c.recordCustom : readClaudeCustomTitle(tp);
    c.size = st.size;
    c.mtimeMs = st.mtimeMs;
  } catch { /* gone or unreadable: next change tries again */ }
  finally { c.reading = false; }
}

export class TitleFollower implements vscode.Disposable {
  private readonly caches = new Map<string, TitleCache>();
  /** Per tmux session: the title being shown, and one still settling. */
  private readonly shown = new Map<string, string>();
  private readonly settling = new Map<string, { title: string; since: number }>();
  /** Per tmux session: the conversation the shown title belongs to. */
  private readonly conversation = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private walking = false;
  private ticking = false;
  /** No `ioreg` before this: the last answer said you were around. */
  private nextAwayCheck = 0;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly index: SessionIndex,
    private readonly tracker: ClaudeTracker,
    private readonly registry: AgentRegistry,
    private readonly terminals: TerminalTracker,
    private readonly refresh: () => void,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('terminalSessions.followConversationTitle')) this.restart();
      }),
    );
    this.restart();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.disposables.forEach(d => d.dispose());
  }

  private enabled(): boolean { return getConfig().followConversationTitle; }

  /** The title a session's row and tab show instead of its own name, if any. */
  titleFor(sessionName: string): string | undefined {
    if (!this.enabled()) return undefined;
    const parsed = parseSessionName(sessionName, getConfig().sessionPrefix);
    if (parsed && this.isPinned(parsed.hash, sessionName)) return undefined;
    return this.shown.get(sessionName);
  }

  /** Whether the session keeps its own name instead of the conversation's. */
  isPinned(hash: string, sessionName: string): boolean {
    return isTitlePinned(this.index.getSessionMeta(hash, sessionName), this.index.getWorkspace(hash)?.label);
  }

  /** The tab title the session should have now. */
  tabNameFor(sessionName: string): string | undefined {
    const parsed = parseSessionName(sessionName, getConfig().sessionPrefix);
    if (!parsed) return undefined;
    const meta = this.index.getSessionMeta(parsed.hash, sessionName);
    const title = this.titleFor(sessionName);
    const label = (title ?? meta?.label ?? '').trim();
    const base = label
      ? `${label} #${parsed.tabId}`
      : `${this.index.getWorkspace(parsed.hash)?.label || parsed.hash}#${parsed.tabId}`;
    return (meta?.parked ? PARKED_PREFIX : '') + base;
  }

  /** Follow this session's conversation even though it has a name (false). */
  setPinned(hash: string, sessionName: string, pinned: boolean | undefined): void {
    this.index.setSessionTitlePinned(hash, sessionName, pinned);
    this.refresh();
    void this.applyActive();
  }

  /** The user switched to `term`: it is active, so it can be renamed safely. */
  onTabActivated(term: vscode.Terminal | undefined): void {
    if (term && !isWalkingTabs()) void this.rename(term);
  }

  private restart(): void {
    if (this.timer) clearInterval(this.timer);
    if (!this.enabled()) {
      this.shown.clear();
      this.settling.clear();
      this.conversation.clear();
      this.refresh();
    }
    // Off, it still runs until every tab it renamed has its own name back
    // (as tabs come to the front, or in a walk while you are away).
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try { await this.step(); } finally { this.ticking = false; }
  }

  private async step(): Promise<void> {
    if (!this.enabled()) {
      await this.applyActive();
      await this.maybeWalkAway();
      if (this.pendingTabs().length === 0 && this.timer) { clearInterval(this.timer); this.timer = undefined; }
      return;
    }
    const now = Date.now();
    let changed = false;
    const live = new Set<string>();
    for (const [, ws] of Object.entries(this.index.getAllWorkspaces())) {
      for (const [name, meta] of Object.entries(ws.sessions ?? {})) {
        if (meta.stopped) continue;
        live.add(name);
        // Another conversation in the same session (/clear, a resume): the
        // old title goes at once, the session's own name until a new one.
        const conv = this.conversationOf(name);
        if (conv !== this.conversation.get(name)) {
          if (conv === undefined) this.conversation.delete(name); else this.conversation.set(name, conv);
          this.settling.delete(name);
          if (this.shown.delete(name)) changed = true;
        }
        const title = await this.currentTitle(name);
        // No title (yet, or the agent has gone): the session's own name.
        if (!title) {
          this.settling.delete(name);
          if (this.shown.delete(name)) changed = true;
          continue;
        }
        if (this.shown.get(name) === title) { this.settling.delete(name); continue; }
        const s = this.settling.get(name);
        if (!s || s.title !== title) { this.settling.set(name, { title, since: now }); continue; }
        if (now - s.since < SETTLE_MS) continue;
        this.settling.delete(name);
        this.shown.set(name, title);
        changed = true;
      }
    }
    for (const name of [...this.shown.keys()]) if (!live.has(name)) { this.shown.delete(name); changed = true; }
    for (const name of [...this.conversation.keys()]) if (!live.has(name)) this.conversation.delete(name);
    if (changed) this.refresh();
    await this.applyActive();
    await this.maybeWalkAway();
  }

  private conversationOf(sessionName: string): string | undefined {
    const snap = this.tracker.getSnapshot(sessionName);
    return snap?.sessionId || snap?.transcriptPath || undefined;
  }

  /** The title of the conversation running in a session, read on change. */
  private async currentTitle(sessionName: string): Promise<string | undefined> {
    const snap = this.tracker.getSnapshot(sessionName);
    const tp = snap?.transcriptPath;
    // 'none': no agent runs in the session (any more).
    if (!snap || snap.state === 'none' || !tp) return undefined;
    const c = await this.readTitles(tp, snap.agent ?? 'claude');
    return cleanTitle(conversationTitle(
      { sessionId: snap.sessionId ?? '', customTitle: c?.custom, autoTitle: c?.auto },
      id => (id ? this.index.getSessionName(id) : undefined),
      200,
    ).title);
  }

  private async readTitles(tp: string, agent: string): Promise<TitleCache | undefined> {
    let st: fs.Stats;
    try { st = fs.statSync(tp); } catch { return this.caches.get(tp); }
    let c = this.caches.get(tp);
    if (!c) { c = { size: 0, mtimeMs: 0, offset: 0, readAt: 0 }; this.caches.set(tp, c); }
    if (TITLE_RECORDS[agent]) {
      if (c.size === st.size && c.mtimeMs === st.mtimeMs) return c;
      // Awaited, so a new title shows on this tick, not the next one.
      if (!c.reading) await scanTitles(tp, c, st, agent);
      return c;
    }
    // Other agents keep the title beside the transcript (Codex's session
    // index, Grok's summary, Antigravity's db), so it can change while the
    // transcript does not: their reader runs every OTHER_READ_MS regardless.
    if (Date.now() - c.readAt < OTHER_READ_MS) return c;
    c.readAt = Date.now();
    c.size = st.size;
    c.mtimeMs = st.mtimeMs;
    try {
      const p = this.registry.getProvider(agent);
      const t = p?.readTitles ? p.readTitles(tp) : p?.readTranscriptSummary?.(tp);
      // A lookup that came back empty (a locked db, a file mid-write) keeps
      // the titles already shown.
      if (t?.customTitle || t?.autoTitle) { c.custom = t.customTitle; c.auto = t.autoTitle; }
    } catch { /* keep the last titles */ }
    return c;
  }

  /** Rename the active tab when its name is out of date. */
  private async applyActive(): Promise<void> {
    const t = vscode.window.activeTerminal;
    if (t && !isWalkingTabs()) await this.rename(t);
  }

  /** The tabs of open sessions whose title is out of date. */
  private pendingTabs(): Array<{ term: vscode.Terminal; name: string }> {
    const out: Array<{ term: vscode.Terminal; name: string }> = [];
    for (const [, ws] of Object.entries(this.index.getAllWorkspaces())) {
      for (const sessionName of Object.keys(ws.sessions ?? {})) {
        // The tracker's own match (tmux args or the live process), never a
        // tab that merely ends in the same `#<id>` in another workspace.
        const term = this.terminals.terminalFor(sessionName);
        const name = term && this.desiredName(term, sessionName);
        if (term && name) out.push({ term, name });
      }
    }
    return out;
  }

  /** The name to give `term` now, or undefined when it is right as it is or
   *  the follower has no say over it (a name it did not give, while off). */
  private desiredName(term: vscode.Terminal, sessionName: string): string | undefined {
    if (term.exitStatus) return undefined;
    const parsed = parseSessionName(sessionName, getConfig().sessionPrefix);
    if (!parsed) return undefined;
    const meta = this.index.getSessionMeta(parsed.hash, sessionName);
    // A title nobody has recorded yet is most likely one the user just typed
    // on the tab: the rename tracker reads it first (and pins the session).
    if (term.name !== meta?.tabName && term.name !== meta?.followedTabName) return undefined;
    const following = this.titleFor(sessionName) !== undefined;
    // Not following this one: only a tab still carrying a title the follower
    // gave gets its own name back.
    if (!following && (!meta?.followedTabName || term.name !== meta.followedTabName)) return undefined;
    const name = this.tabNameFor(sessionName);
    return name && name !== term.name ? name : undefined;
  }

  /** Rename `term` if it is the active tab and out of date. */
  private async rename(term: vscode.Terminal): Promise<void> {
    if (vscode.window.activeTerminal !== term) return;
    // Not identified yet (a tab restored by a reload): its new title would be
    // read as a rename by the user. Next tick.
    if (!this.terminals.isTracked(term)) return;
    const sessionName = this.sessionOf(term);
    if (!sessionName) return;
    const name = this.desiredName(term, sessionName);
    if (name) await this.renameActive(term, sessionName, name);
  }

  private async renameActive(term: vscode.Terminal, sessionName: string, name: string): Promise<void> {
    const parsed = parseSessionName(sessionName, getConfig().sessionPrefix);
    if (!parsed) return;
    // Recorded before the rename lands, so neither the tracker's poll nor a
    // reload in between can take the new title for one the user typed.
    // Giving a tab its own name back, the record of the title it carried is
    // dropped only once the new name shows: a rename that fails or lands late
    // leaves it, so the next tick tries again and the tracker still knows it.
    const following = this.titleFor(sessionName) !== undefined;
    if (following) this.index.setSessionFollowedTabName(parsed.hash, sessionName, name);
    this.terminals.expectName(term, name);
    try {
      await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
    } catch { return; }
    if (term.name !== name) return;
    this.index.setSessionTabName(parsed.hash, sessionName, name);
    if (!following) this.index.setSessionFollowedTabName(parsed.hash, sessionName, undefined);
  }

  private sessionOf(term: vscode.Terminal): string | undefined {
    return this.terminals.sessionFor(term);
  }

  private async away(): Promise<boolean> {
    if (vscode.window.state.focused || Date.now() < this.nextAwayCheck) return false;
    const idle = await systemIdleMs();
    if (idle === undefined) { this.nextAwayCheck = Date.now() + AWAY_MS; return false; }
    // Active a moment ago: no point asking again before a minute can pass.
    if (idle < AWAY_MS) { this.nextAwayCheck = Date.now() + (AWAY_MS - idle); return false; }
    return !vscode.window.state.focused;
  }

  /** While you are away, rename the waiting tabs in one walk. */
  private async maybeWalkAway(): Promise<void> {
    if (this.walking || isWalkingTabs()) return;
    const waiting = this.pendingTabs().filter(p => p.term !== vscode.window.activeTerminal);
    if (waiting.length === 0 || !(await this.away())) return;
    this.walking = true;
    try {
      await runTabWalk(async () => {
        const prevTerm = vscode.window.activeTerminal;
        const prevEditor = vscode.window.activeTextEditor;
        // What the walk itself left showing: only that is put back, never a
        // tab or file the user opened after coming back mid-walk.
        let walkedTerm: vscode.Terminal | undefined;
        let walkedEditor: vscode.TextEditor | undefined;
        try {
          for (const { term } of waiting) {
            // Back at the keyboard: stop before anything else moves.
            // eslint-disable-next-line no-await-in-loop
            if (!(await this.away())) break;
            const sessionName = this.sessionOf(term);
            const name = sessionName && this.desiredName(term, sessionName);
            if (!sessionName || !name || !this.terminals.isTracked(term)) continue;
            term.show(true);
            // eslint-disable-next-line no-await-in-loop
            for (let i = 0; i < 20 && vscode.window.activeTerminal !== term; i++) await new Promise(r => setTimeout(r, 50));
            if (vscode.window.activeTerminal !== term || vscode.window.state.focused) break;
            walkedTerm = term;
            walkedEditor = vscode.window.activeTextEditor;
            // eslint-disable-next-line no-await-in-loop
            await this.renameActive(term, sessionName, name);
          }
        } finally {
          const ours = walkedTerm !== undefined && vscode.window.activeTerminal === walkedTerm;
          const editorOurs = walkedTerm !== undefined && vscode.window.activeTextEditor === walkedEditor;
          if (ours && prevTerm && !prevTerm.exitStatus) {
            prevTerm.show(true);
            // The walk's guard holds until the tab is really back, or the
            // switch would be read as the user opening the last walked tab.
            // eslint-disable-next-line no-await-in-loop
            for (let i = 0; i < 20 && vscode.window.activeTerminal !== prevTerm; i++) await new Promise(r => setTimeout(r, 50));
          }
          if (editorOurs && prevEditor && vscode.window.activeTextEditor !== prevEditor) {
            try {
              await vscode.window.showTextDocument(prevEditor.document, { viewColumn: prevEditor.viewColumn, preserveFocus: true });
            } catch { /* closed meanwhile */ }
          }
        }
      });
    } finally { this.walking = false; }
  }
}
