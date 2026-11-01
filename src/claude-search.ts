import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { claudeCustomTitlePath, readClaudeCustomTitle, slugFromCwd, unwrapLocalCommand } from './claude-transcript';

export interface SessionIndexEntry {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  title: string;        // derived from first user prompt
  customTitle?: string; // `/rename` title (custom-title.json sidecar or record)
  aiTitle?: string;     // Claude's generated `ai-title`
  firstPrompt: string;
  lastPrompt: string;
  /** Every human prompt, each cut to PROMPT_MAX chars; past MAX_PROMPTS the
   *  middle ones go, keeping how the conversation started and where it is. */
  prompts: string[];
  turns: number;        // assistant records
  lineCount: number;
  lastModified: number; // ms since epoch
  byteSize: number;
  /** Bytes read so far, up to the last complete line: the next scan of a
   *  growing transcript starts here instead of at 0. */
  scannedBytes: number;
  /** mtime of Claude's custom-title.json sidecar (0 = none). Part of the cache
   *  key: a rename/clear touches only the sidecar, not the transcript. */
  titleModified?: number;
  /** Agent-team teammate, or a transcript of subagent turns only: hidden from
   *  the archive, like the provider's own listing does. */
  subsessionRole?: 'teammate' | 'subagent';
  /** Claude's `entrypoint` (`cli`, `sdk-cli` for `claude -p`…). */
  entrypoint?: string;
  // Scan state carried between incremental reads.
  customTitleRecord?: string; // last custom-title record ('' = cleared)
  teammate?: boolean;
  sawMainUser?: boolean;
  userAssistantCount?: number;
}

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
// v4: entries carry every user prompt, the entrypoint, and resume their scan
// where they left off. New file name so an older cache is rebuilt once.
const INDEX_PATH = path.join(os.homedir(), '.terminal-sessions', 'search-index.v4.json');
const CHUNK_BYTES = 4 * 1024 * 1024;
const PROMPT_MAX = 200;
const MAX_PROMPTS = 50;
const MAX_PREVIEW = 200;
// A promptless transcript this small is a sidechain/summary stub: not indexed.
const STUB_BYTES = 256 * 1024;
// Save partial progress during the first full build, so a reload keeps it.
const SAVE_EVERY_FILES = 300;
// A slash command (`/clear`, `/model opus`) or its recorded wrapper; a prompt
// that merely starts with a path (`/work/app/main.ts crashes`) is a prompt.
const SLASH_CMD_RE = /^(<command-name>|<command-message>|<command-args>|<local-command-[^>]+>|\/[A-Za-z][\w:-]*(?:\s|$))/;
// Teammates carry their role on early records; past this many lines a match
// would only come from tool input that mentions `agentName`.
const TEAMMATE_SCAN_LINES = 200;
const CWD_FIELD = /"cwd":"((?:[^"\\]|\\.)*)"/;

interface IndexFile { version: 4; complete: boolean; entries: Record<string, SessionIndexEntry> }

export class ClaudeSearchIndex {
  private entries = new Map<string, SessionIndexEntry>();  // key: transcriptPath
  private loaded = false;
  /** True once a full walk has finished: until then the archive keeps
   *  reading transcripts itself instead of trusting a partial index. */
  private complete = false;
  private refreshing?: Promise<number>;

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await fs.promises.readFile(INDEX_PATH, 'utf8')) as IndexFile;
      if (data?.version === 4 && data.entries) {
        for (const [k, v] of Object.entries(data.entries)) this.entries.set(k, v);
        this.complete = data.complete === true;
      }
    } catch { /* no index yet */ }
    this.loaded = true;
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
      const file: IndexFile = { version: 4, complete: this.complete, entries: Object.fromEntries(this.entries) };
      const tmp = `${INDEX_PATH}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(file));
      fs.renameSync(tmp, INDEX_PATH);
    } catch (e) {
      console.error('[terminal-sessions] search-index save:', e);
    }
  }

  isComplete(): boolean { return this.complete; }

  entry(transcriptPath: string): SessionIndexEntry | undefined { return this.entries.get(transcriptPath); }

  entryById(sessionId: string): SessionIndexEntry | undefined {
    for (const e of this.entries.values()) if (e.sessionId === sessionId) return e;
    return undefined;
  }

  /** Walk ~/.claude/projects/, index any .jsonl file we haven't seen or that
   *  changed (a grown one only from where the last scan stopped). Returns the
   *  number of entries added/updated. Async throughout so a large projects
   *  tree never freezes the extension host; concurrent calls share one walk. */
  async refresh(): Promise<number> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.walk();
    try { return await this.refreshing; }
    finally { this.refreshing = undefined; }
  }

  private async walk(): Promise<number> {
    if (!this.loaded) await this.load();
    let changed = 0;
    let unsaved = 0;
    let projectDirs: string[] = [];
    try { projectDirs = await fs.promises.readdir(PROJECTS_ROOT); }
    catch { return 0; }
    const live = new Set<string>();
    for (const dir of projectDirs) {
      if (dir === '.bak') continue;
      const full = path.join(PROJECTS_ROOT, dir);
      let files: string[] = [];
      try { files = (await fs.promises.readdir(full)).filter(f => f.endsWith('.jsonl')); }
      catch { continue; }
      for (const f of files) {
        const fpath = path.join(full, f);
        live.add(fpath);
        let stat: fs.Stats;
        try { stat = await fs.promises.stat(fpath); }
        catch { continue; }
        const existing = this.entries.get(fpath);
        const titleModified = sidecarMtime(fpath);
        if (existing && existing.lastModified >= stat.mtimeMs && existing.byteSize === stat.size
            && (existing.titleModified ?? 0) === titleModified) continue;
        // Transcripts only grow; a shorter file was replaced: read it again.
        const resume = existing && stat.size >= existing.scannedBytes ? existing : undefined;
        // A rename through the sidecar is newer than any title record read so far.
        const sidecarChanged = Boolean(existing && (existing.titleModified ?? 0) !== titleModified);
        const entry = await scanTranscript(fpath, stat, f.replace(/\.jsonl$/, ''), resume, sidecarChanged);
        if (entry) {
          entry.titleModified = titleModified;
          this.entries.set(fpath, entry);
          changed++;
          if (!this.complete && ++unsaved >= SAVE_EVERY_FILES) { this.save(); unsaved = 0; }
        } else if (existing) {
          this.entries.delete(fpath);
          changed++;
        }
      }
    }
    for (const p of Array.from(this.entries.keys())) {
      if (!live.has(p)) { this.entries.delete(p); changed++; }
    }
    const wasComplete = this.complete;
    this.complete = true;
    if (changed > 0 || !wasComplete) this.save();
    return changed;
  }

  list(): SessionIndexEntry[] {
    return [...this.entries.values()].sort((a, b) => b.lastModified - a.lastModified);
  }

  /** Entries of one project folder (`scopeCwd`), or all; newest first. */
  listScope(scopeCwd?: string): SessionIndexEntry[] {
    const all = this.list();
    if (!scopeCwd) return all;
    const slug = slugFromCwd(scopeCwd);
    return all.filter(e => path.basename(path.dirname(e.transcriptPath)) === slug);
  }

  /** `extra` adds per-session text that lives outside the transcript (the name
   *  given in the extension's Rename Conversation) so the title the picker SHOWS
   *  is also the title it MATCHES. */
  search(query: string, extra?: (sessionId: string) => string | undefined): SessionIndexEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list();
    const tokens = q.split(/\s+/);
    const results: Array<{ e: SessionIndexEntry; score: number }> = [];
    for (const e of this.entries.values()) {
      // Titles and prompt edges first: a hit there ranks above one deep in the
      // prompt list.
      const hay = `${e.customTitle ?? ''} ${extra?.(e.sessionId) ?? ''} ${e.aiTitle ?? ''} ${e.title} ${e.firstPrompt} ${e.lastPrompt} ${e.cwd} ${(e.prompts ?? []).join(' ')}`.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        const idx = hay.indexOf(t);
        if (idx < 0) { score = -1; break; }
        score += 100 - Math.min(99, idx / 10);  // earlier match → higher score
      }
      if (score >= 0) {
        // Freshness bonus: recent sessions rank higher on ties
        score += Math.max(0, 10 - (Date.now() - e.lastModified) / (24 * 3600 * 1000));
        results.push({ e, score });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.map(r => r.e);
  }
}

/** The prompt that matched `query`, cut around the first hit, for a picker's
 *  detail line. Undefined when the match is not in a prompt. */
export function promptSnippet(e: SessionIndexEntry, query: string, width = 110): string | undefined {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  const prompts = e.prompts ?? [];
  // The prompt with the most of the words (others may be in the title or folder).
  let hit: string | undefined;
  let best = 0;
  for (const p of prompts) {
    const lp = p.toLowerCase();
    const n = tokens.filter(t => lp.includes(t)).length;
    if (n > best) { best = n; hit = p; }
    if (n === tokens.length) break;
  }
  if (!hit) return undefined;
  const lower = hit.toLowerCase();
  const at = lower.indexOf(tokens.find(t => lower.includes(t))!);
  const start = Math.max(0, at - Math.floor(width / 3));
  const cut = hit.slice(start, start + width);
  return `${start > 0 ? '…' : ''}${cut}${start + width < hit.length ? '…' : ''}`;
}

/** Read a transcript from `prev.scannedBytes` (or the start) to its last
 *  complete line, folding what it finds into the entry. */
export async function scanTranscript(
  fpath: string,
  stat: fs.Stats,
  sessionId: string,
  prev?: SessionIndexEntry,
  sidecarChanged = false,
): Promise<SessionIndexEntry | undefined> {
  const e: SessionIndexEntry = prev
    ? { ...prev, prompts: [...(prev.prompts ?? [])] }
    : {
      sessionId, transcriptPath: fpath, cwd: '', title: '', firstPrompt: '', lastPrompt: '', prompts: [],
      turns: 0, lineCount: 0, lastModified: 0, byteSize: 0, scannedBytes: 0,
    };
  let fh: fs.promises.FileHandle;
  // The sidecar now speaks for the custom title, until a newer record lands.
  if (sidecarChanged) delete e.customTitleRecord;
  try { fh = await fs.promises.open(fpath, 'r'); } catch { return undefined; }
  try {
    let offset = e.scannedBytes;
    let carry: Buffer = Buffer.alloc(0);
    const buf = Buffer.alloc(CHUNK_BYTES);
    while (offset < stat.size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK_BYTES, stat.size - offset), offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const lastNl = data.lastIndexOf(0x0a);
      if (lastNl < 0) { carry = Buffer.from(data); continue; }
      const text = data.subarray(0, lastNl).toString('utf8');
      carry = Buffer.from(data.subarray(lastNl + 1));
      for (const line of text.split('\n')) if (line) foldLine(e, line);
      e.scannedBytes = offset - carry.length;
      await new Promise(r => setImmediate(r));
    }
  } finally {
    await fh.close();
  }

  e.lastModified = stat.mtimeMs;
  e.byteSize = stat.size;
  e.subsessionRole = e.teammate ? 'teammate'
    : (e.userAssistantCount ?? 0) > 0 && !e.sawMainUser ? 'subagent' : undefined;
  e.customTitle = e.customTitleRecord !== undefined ? e.customTitleRecord || undefined : readClaudeCustomTitle(fpath);
  if (!e.firstPrompt) {
    // Promptless: a titled or large one is still worth listing, a small
    // untitled one is a sidechain/summary stub.
    if (stat.size <= STUB_BYTES && !e.customTitle && !e.aiTitle) return undefined;
    e.title = `session ${sessionId.slice(0, 8)}`;
  } else {
    e.title = e.firstPrompt.slice(0, 80);
  }
  return e;
}

function foldLine(e: SessionIndexEntry, line: string): void {
  e.lineCount++;
  if (line[0] !== '{') return;
  if (!e.entrypoint && line.includes('"entrypoint":"')) {
    e.entrypoint = /"entrypoint":"([^"]*)"/.exec(line)?.[1];
  }
  if (!e.cwd && line.includes('"cwd":"')) {
    const m = CWD_FIELD.exec(line);
    if (m) { try { e.cwd = JSON.parse(`"${m[1]}"`); } catch { /* malformed */ } }
  }
  // Agent-team teammates tag their records with a top-level `agentName` role;
  // the rename record `agent-name` names the conversation and is not a role.
  if (!e.teammate && e.lineCount <= TEAMMATE_SCAN_LINES && line.includes('"agentName":"')) {
    const d = safeParse(line);
    if (d && d.type !== 'agent-name' && typeof d.agentName === 'string' && d.agentName) e.teammate = true;
  }
  if (line.includes('"type":"assistant"')) {
    e.turns++;
    e.userAssistantCount = (e.userAssistantCount ?? 0) + 1;
    return;
  }
  if (line.includes('"type":"custom-title"') || line.includes('"type":"ai-title"')) {
    const d = safeParse(line);
    if (d?.type === 'custom-title' && typeof d.customTitle === 'string') { e.customTitleRecord = d.customTitle; return; }
    if (d?.type === 'ai-title' && typeof d.aiTitle === 'string') { e.aiTitle = d.aiTitle; return; }
  }
  if (!line.includes('"type":"user"')) return;
  e.userAssistantCount = (e.userAssistantCount ?? 0) + 1;
  if (line.includes('"isSidechain":true')) return;
  e.sawMainUser = true;
  // Tool results and meta records are user records too, and the bulk of a
  // transcript: skip them before paying for a parse.
  if (line.includes('"tool_use_id"') || line.includes('"isMeta":true')) return;
  const d = safeParse(line);
  const prompt = d ? extractUserPrompt(d) : '';
  if (!prompt) return;
  if (!e.firstPrompt) e.firstPrompt = prompt.slice(0, MAX_PREVIEW);
  e.lastPrompt = prompt.slice(0, MAX_PREVIEW);
  e.prompts.push(prompt.slice(0, PROMPT_MAX));
  if (e.prompts.length > MAX_PROMPTS) e.prompts.splice(Math.floor(MAX_PROMPTS / 2), 1);
}

function sidecarMtime(transcriptPath: string): number {
  try { return fs.statSync(claudeCustomTitlePath(transcriptPath)).mtimeMs; }
  catch { return 0; }
}

function safeParse(line: string): Record<string, unknown> | undefined {
  try { return JSON.parse(line); }
  catch { return undefined; }
}

function extractUserPrompt(data: Record<string, unknown>): string {
  if (data.type !== 'user') return '';
  // Skip sidechain (subagent) turns and meta records (command caveats, hook /
  // system-reminder injections) — neither is a human-typed prompt.
  if (data.isSidechain === true || data.isMeta === true) return '';
  const msg = data.message as { role?: string; content?: unknown } | undefined;
  if (!msg || msg.role !== 'user') return '';
  let text = '';
  if (typeof msg.content === 'string') text = msg.content;
  else if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (!b || typeof b !== 'object') continue;
      const block = b as Record<string, unknown>;
      if (block.type === 'text' && typeof block.text === 'string') text += ' ' + block.text;
    }
  }
  // What was typed after a local command (`/clear` output, its caveat).
  text = (unwrapLocalCommand(text.trim()).text ?? '').trim();
  if (!text) return '';
  // Skip command-only messages ("/clear", hook outputs, etc.)
  if (SLASH_CMD_RE.test(text)) return '';
  return text.replace(/\s+/g, ' ').trim();
}
