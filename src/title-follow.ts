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
import { findTerminalForSession, PARKED_PREFIX } from './profile-provider';
import { isWalkingTabs, runTabWalk } from './tab-order';
import type { TerminalTracker } from './terminal-tracker';

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
// A name you give the session (Rename) while following is on pins it.

/** A title must hold this long before a tab takes it (titles get revised). */
const SETTLE_MS = 2000;
const TICK_MS = 3000;
/** No input for this long, with the window unfocused, counts as away. */
const AWAY_MS = 60_000;
/** A non-Claude transcript is re-read at most this often. */
const OTHER_READ_MS = 15_000;
const MAX_TITLE = 60;
const TITLE_MARKS = ['"ai-title"', '"custom-title"'];
const CHUNK = 4 * 1024 * 1024;

export interface TitleCache {
  size: number;
  mtimeMs: number;
  /** Claude: bytes scanned, up to the last complete line. */
  offset: number;
  custom?: string;
  auto?: string;
  readAt: number;
  reading?: boolean;
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

/** Claude appends `ai-title` / `custom-title` records: only the new bytes are
 *  read, and only lines carrying one of them are parsed. */
export async function scanClaudeTitles(tp: string, c: TitleCache, st: fs.Stats): Promise<void> {
  c.reading = true;
  try {
    // Rewritten or truncated: start over.
    if (st.size < c.offset) { c.offset = 0; c.custom = undefined; c.auto = undefined; }
    const fh = await fs.promises.open(tp, 'r');
    try {
      // In chunks, so a long transcript read for the first time is never
      // held whole; a line cut by a chunk end is carried to the next.
      let carry = '';
      let at = c.offset;
      while (at < st.size) {
        const buf = Buffer.alloc(Math.min(CHUNK, st.size - at));
        // eslint-disable-next-line no-await-in-loop
        const { bytesRead } = await fh.read(buf, 0, buf.length, at);
        if (bytesRead === 0) break;
        at += bytesRead;
        const text = carry + buf.subarray(0, bytesRead).toString('utf8');
        const end = text.lastIndexOf('\n');
        if (end < 0) { carry = text; continue; }
        for (const line of text.slice(0, end).split('\n')) {
          if (!TITLE_MARKS.some(m => line.includes(m))) continue;
          try {
            const r = JSON.parse(line);
            if (r?.type === 'custom-title' && typeof r.customTitle === 'string') c.custom = r.customTitle || undefined;
            else if (r?.type === 'ai-title' && typeof r.aiTitle === 'string') c.auto = r.aiTitle;
          } catch { /* not a whole record */ }
        }
        carry = text.slice(end + 1);
      }
      // Up to the last complete line: a half-written one is read next time.
      c.offset = at - Buffer.byteLength(carry, 'utf8');
    } finally { await fh.close(); }
    // A /rename can also live in the sidecar file.
    c.custom = readClaudeCustomTitle(tp) ?? c.custom;
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
  private timer: NodeJS.Timeout | undefined;
  private walking = false;
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
    if (parsed && this.index.getSessionMeta(parsed.hash, sessionName)?.titlePinned) return undefined;
    return this.shown.get(sessionName);
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

  /** Stop following this session's conversation (a Rename), or follow again. */
  setPinned(hash: string, sessionName: string, pinned: boolean): void {
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
    this.timer = undefined;
    if (this.enabled()) {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      void this.tick();
    } else {
      this.shown.clear();
      this.settling.clear();
      this.refresh();
      // Put back the tab names it gave, as tabs come to the front.
      void this.applyActive();
    }
  }

  private async tick(): Promise<void> {
    if (!this.enabled()) return;
    const now = Date.now();
    let changed = false;
    const live = new Set<string>();
    for (const [, ws] of Object.entries(this.index.getAllWorkspaces())) {
      for (const [name, meta] of Object.entries(ws.sessions ?? {})) {
        if (meta.stopped) continue;
        live.add(name);
        const title = this.currentTitle(name);
        if (!title) continue;
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
    if (changed) this.refresh();
    await this.applyActive();
    await this.maybeWalkAway();
  }

  /** The title of the conversation running in a session, read on change. */
  private currentTitle(sessionName: string): string | undefined {
    const snap = this.tracker.getSnapshot(sessionName);
    const tp = snap?.transcriptPath;
    if (!snap || !tp) return undefined;
    const c = this.readTitles(tp, snap.agent ?? 'claude');
    return cleanTitle(conversationTitle(
      { sessionId: snap.sessionId ?? '', customTitle: c?.custom, autoTitle: c?.auto },
      id => (id ? this.index.getSessionName(id) : undefined),
      200,
    ).title);
  }

  private readTitles(tp: string, agent: string): TitleCache | undefined {
    let st: fs.Stats;
    try { st = fs.statSync(tp); } catch { return this.caches.get(tp); }
    let c = this.caches.get(tp);
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c;
    if (!c) { c = { size: 0, mtimeMs: 0, offset: 0, readAt: 0 }; this.caches.set(tp, c); }
    if (agent === 'claude') {
      if (!c.reading) void scanClaudeTitles(tp, c, st);
      return c;
    }
    // Other agents: their own summary reader, not more often than OTHER_READ_MS.
    if (Date.now() - c.readAt < OTHER_READ_MS) return c;
    c.readAt = Date.now();
    c.size = st.size;
    c.mtimeMs = st.mtimeMs;
    try {
      const s = this.registry.getProvider(agent)?.readTranscriptSummary?.(tp);
      c.custom = s?.customTitle;
      c.auto = s?.autoTitle;
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
        const term = findTerminalForSession(sessionName);
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
    const sessionName = this.sessionOf(term);
    if (!sessionName) return;
    const name = this.desiredName(term, sessionName);
    if (name) await this.renameActive(term, sessionName, name);
  }

  private async renameActive(term: vscode.Terminal, sessionName: string, name: string): Promise<void> {
    const parsed = parseSessionName(sessionName, getConfig().sessionPrefix);
    if (!parsed) return;
    this.terminals.expectName(term, name);
    await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
    this.index.setSessionFollowedTabName(parsed.hash, sessionName,
      this.titleFor(sessionName) !== undefined ? name : undefined);
  }

  private sessionOf(term: vscode.Terminal): string | undefined {
    for (const [, ws] of Object.entries(this.index.getAllWorkspaces())) {
      for (const sessionName of Object.keys(ws.sessions ?? {})) {
        if (findTerminalForSession(sessionName) === term) return sessionName;
      }
    }
    return undefined;
  }

  private async away(): Promise<boolean> {
    if (vscode.window.state.focused) return false;
    const idle = await systemIdleMs();
    return idle !== undefined && idle >= AWAY_MS && !vscode.window.state.focused;
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
        try {
          for (const { term } of waiting) {
            // Back at the keyboard: stop before anything else moves.
            // eslint-disable-next-line no-await-in-loop
            if (!(await this.away())) break;
            const sessionName = this.sessionOf(term);
            const name = sessionName && this.desiredName(term, sessionName);
            if (!sessionName || !name) continue;
            term.show(true);
            // eslint-disable-next-line no-await-in-loop
            for (let i = 0; i < 20 && vscode.window.activeTerminal !== term; i++) await new Promise(r => setTimeout(r, 50));
            if (vscode.window.activeTerminal !== term || vscode.window.state.focused) break;
            // eslint-disable-next-line no-await-in-loop
            await this.renameActive(term, sessionName, name);
          }
        } finally {
          if (prevTerm && !prevTerm.exitStatus && vscode.window.activeTerminal !== prevTerm) prevTerm.show(true);
          if (prevEditor && vscode.window.activeTextEditor !== prevEditor) {
            try {
              await vscode.window.showTextDocument(prevEditor.document, { viewColumn: prevEditor.viewColumn, preserveFocus: true });
            } catch { /* closed meanwhile */ }
          }
        }
      });
    } finally { this.walking = false; }
  }
}
