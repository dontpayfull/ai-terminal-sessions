// Follow Conversation Title, last resort: a conversation the agent never
// titled shows its first prompt. Claude Code writes its title a few seconds
// after the first prompt, so a running conversation waits before falling back
// (the tab would otherwise be renamed twice); a stopped one does not wait.

import * as fs from 'fs';
import { unwrapLocalCommand } from './claude-transcript';

/** The first prompt sits at the top of a transcript: never read past this. A
 *  whole-file read of a 300 MB transcript blocks the extension host. */
const HEAD_BYTES = 2 * 1024 * 1024;
const HEAD_LINES = 200;
/** Agents other than Claude are read through their provider's summary; one
 *  larger than this is left without a stand-in title rather than read whole. */
export const SUMMARY_MAX_BYTES = 32 * 1024 * 1024;

/** The first typed prompt of a Claude transcript, from its first lines only.
 *  A turn that is only a slash command (`/clear`) is skipped: its name would
 *  stay as the title after a real prompt follows. */
export function readClaudeFirstPrompt(transcriptPath: string): string | undefined {
  let head: string;
  let fd: number | undefined;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, fs.fstatSync(fd).size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    head = buf.toString('utf8', 0, n);
  } catch { return undefined; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } } }
  for (const line of head.split('\n').slice(0, HEAD_LINES)) {
    if (!line.includes('"type":"user"') || line.includes('"isSidechain":true')) continue;
    let rec: { type?: string; message?: { content?: unknown } };
    try { rec = JSON.parse(line); } catch { continue; }   // a line cut by the head limit
    if (rec.type !== 'user') continue;
    const c = rec.message?.content;
    let text: string | undefined;
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      const part = c.find(p => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string');
      text = part?.text;
    }
    if (!text) continue;
    const u = unwrapLocalCommand(text);
    if (u.text) return u.text.slice(0, 200);
  }
  return undefined;
}

/** How long a running conversation may stay untitled before its first prompt
 *  stands in. */
export const FIRST_PROMPT_WAIT_MS = 45_000;
/** A transcript with no prompt yet is looked at again at most this often. */
export const FIRST_PROMPT_RETRY_MS = 30_000;

export interface FirstPromptCache {
  custom?: string;
  auto?: string;
  /** The first prompt, once found; it never changes. */
  first?: string;
  /** When it was found. */
  firstAt?: number;
  /** When the transcript was last read for it. */
  firstReadAt?: number;
  /** It has been shown already: a stopped session that starts again keeps it
   *  instead of going back to its own name for the length of the wait. */
  firstShown?: boolean;
}

/**
 * The first prompt to show as the title, or undefined when the conversation
 * has a real title, has no prompt yet, or (running) is still inside the wait.
 * `read` returns the transcript's first user message; it is called at most
 * once per retry window and never again after it answers.
 */
export function firstPromptTitle(
  c: FirstPromptCache,
  read: () => string | undefined,
  now: number,
  immediate: boolean,
): string | undefined {
  if (c.custom || c.auto) return undefined;
  if (!c.first && now - (c.firstReadAt ?? 0) >= FIRST_PROMPT_RETRY_MS) {
    c.firstReadAt = now;
    let first: string | undefined;
    try { first = read()?.trim() || undefined; } catch { first = undefined; }
    if (first) { c.first = first; c.firstAt = now; }
  }
  if (!c.first) return undefined;
  if (c.firstShown || immediate || now - (c.firstAt ?? now) >= FIRST_PROMPT_WAIT_MS) {
    c.firstShown = true;
    return c.first;
  }
  return undefined;
}
