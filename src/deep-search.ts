import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Search inside the agent's answers, on demand. The search index keeps only
// what the user typed; answers are far larger, so instead of indexing them we
// run ripgrep (shipped with VS Code / Cursor) over the Claude transcripts when
// asked, keep the lines that are the assistant's own text (not tool output,
// which is full of file contents) and report one hit per conversation.

export interface DeepHit {
  sessionId: string;
  transcriptPath: string;
  snippet: string;
  mtimeMs: number;
}

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const MAX_SESSIONS = 100;
const TIMEOUT_MS = 30_000;
const SNIPPET = 140;
const MAX_LINE = 400_000;

/** ripgrep from the editor install, else one on PATH. */
export function findRipgrep(appRoot: string): string | undefined {
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  for (const base of ['node_modules', 'node_modules.asar.unpacked']) {
    const p = path.join(appRoot, base, '@vscode', 'ripgrep', 'bin', exe);
    if (fs.existsSync(p)) return p;
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** Lower-cased search words; the longest one goes to ripgrep (fewest hits). */
export function queryTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** The assistant's own text in one transcript line, when it contains every
 *  token: a snippet around the first one. Undefined for anything else (user
 *  records, tool calls and results, subagent turns, other records). */
export function assistantTextHit(line: string, tokens: readonly string[]): string | undefined {
  if (!line.includes('"type":"assistant"')) return undefined;
  let rec: { type?: unknown; isSidechain?: unknown; message?: { content?: unknown } };
  try { rec = JSON.parse(line); } catch { return undefined; }
  if (rec.type !== 'assistant' || rec.isSidechain === true) return undefined;
  const content = rec.message?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
        const t = (b as { text?: unknown }).text;
        if (typeof t === 'string') text += ' ' + t;
      }
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  if (!text || !tokens.every(t => lower.includes(t))) return undefined;
  const at = lower.indexOf(tokens[0]);
  const start = Math.max(0, at - Math.floor(SNIPPET / 3));
  return `${start > 0 ? '…' : ''}${text.slice(start, start + SNIPPET)}${start + SNIPPET < text.length ? '…' : ''}`;
}

/** The Claude project folders to search: one (`scopeCwd`'s) or all. */
export function searchDirs(scopeCwd: string | undefined, slugOf: (cwd: string) => string): string[] {
  if (scopeCwd) {
    const d = path.join(PROJECTS_ROOT, slugOf(scopeCwd));
    return fs.existsSync(d) ? [d] : [];
  }
  try {
    return fs.readdirSync(PROJECTS_ROOT)
      .filter(d => d !== '.bak')
      .map(d => path.join(PROJECTS_ROOT, d))
      .filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  } catch { return []; }
}

/** Shortest word worth a full search of the answers: one or two letters
 *  match nearly every line of every transcript. */
export const MIN_ANSWER_QUERY = 3;

/** The transcripts in `dirs` touched since `cutoff` (ms): with a time filter,
 *  ripgrep reads only those, so old matches cannot use up the hit limit. */
export function recentTranscripts(dirs: readonly string[], cutoff: number): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    let names: string[] = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const p = path.join(d, n);
      try { if (fs.statSync(p).mtimeMs >= cutoff) out.push(p); } catch { /* gone */ }
    }
  }
  return out;
}

/** Run ripgrep over the top-level transcripts in `targets` (folders or
 *  files) and return one hit per conversation whose answers contain every
 *  word, newest first. `accept` drops conversations before they count toward
 *  the limit. Stops at MAX_SESSIONS, after TIMEOUT_MS, or when `isCancelled`
 *  turns true. */
export function deepSearch(
  rgPath: string,
  targets: readonly string[],
  query: string,
  isCancelled: () => boolean,
  accept?: (sessionId: string, mtimeMs: number) => boolean,
): Promise<DeepHit[]> {
  const tokens = queryTokens(query);
  const longest = tokens.reduce((m, t) => Math.max(m, t.length), 0);
  if (longest < MIN_ANSWER_QUERY || targets.length === 0) return Promise.resolve([]);
  const dirs = targets;
  const needle = [...tokens].sort((a, b) => b.length - a.length)[0];
  const args = [
    '--no-config', '--fixed-strings', '--ignore-case', '--no-heading', '--with-filename',
    '--no-line-number', '--color', 'never', '--max-depth', '1', '--glob', '*.jsonl',
    // Newest transcripts first, so the hit limit keeps the recent ones.
    '--sortr=modified',
    // A huge line is a tool result or a pasted file, not an answer; parsing
    // it would hold up the editor.
    '--max-columns', String(MAX_LINE),
    '--', needle, ...dirs,
  ];
  return new Promise(resolve => {
    const hits = new Map<string, DeepHit>();
    const rejected = new Set<string>();
    let done = false;
    let carry = '';
    const child = spawn(rgPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (): void => {
      if (done) return;
      done = true;
      clearInterval(watch);
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      resolve([...hits.values()].sort((a, b) => b.mtimeMs - a.mtimeMs));
    };
    const timer = setTimeout(finish, TIMEOUT_MS);
    const watch = setInterval(() => { if (isCancelled()) finish(); }, 200);
    const onLine = (raw: string): void => {
      // `<path>:<line>`; the path ends at `.jsonl:`.
      const cut = raw.indexOf('.jsonl:');
      if (cut < 0) return;
      const file = raw.slice(0, cut + 6);
      const sessionId = path.basename(file, '.jsonl');
      if (hits.has(sessionId) || rejected.has(sessionId)) return;
      const snippet = assistantTextHit(raw.slice(cut + 7), tokens);
      if (!snippet) return;
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* gone meanwhile */ }
      if (accept && !accept(sessionId, mtimeMs)) { rejected.add(sessionId); return; }
      hits.set(sessionId, { sessionId, transcriptPath: file, snippet, mtimeMs });
      if (hits.size >= MAX_SESSIONS) finish();
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (done) return;
      const text = carry + chunk;
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      for (const l of lines) { onLine(l); if (done) return; }
    });
    child.on('error', finish);
    child.on('close', () => { if (carry) onLine(carry); finish(); });
  });
}
