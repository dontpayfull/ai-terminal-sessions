import type { ArchivedSession } from './archive';
import type { SessionIndexEntry } from './claude-search';

// Helpers shared by the conversation search in the archive picker.

const DAY_MS = 24 * 3600 * 1000;

/** An index entry in the shape the archive and resume code take. */
export function archivedFromEntry(e: SessionIndexEntry, nameLookup: (id: string) => string | undefined): ArchivedSession {
  return {
    agent: 'claude',
    sessionId: e.sessionId,
    transcriptPath: e.transcriptPath,
    cwd: e.cwd || undefined,
    firstUserMessage: e.firstPrompt || undefined,
    customTitle: e.customTitle,
    autoTitle: e.aiTitle,
    lineCount: e.lineCount,
    byteSize: e.byteSize,
    mtimeMs: e.lastModified,
    friendlyName: nameLookup(e.sessionId),
    // `claude -p` and SDK runs, not typed in by the user.
    automated: e.entrypoint?.startsWith('sdk') || undefined,
  };
}

export function cutoffFor(days: number, now = Date.now()): number {
  return days > 0 ? now - days * DAY_MS : 0;
}

/** Split `@agent` and `<N>d` prefixes off a query. `2d` and `3d` stay words. */
export function parseArchiveQuery(raw: string, agentIds: readonly string[]): { text: string; agents?: string[]; days?: number } {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  const rest: string[] = [];
  const agents: string[] = [];
  let days: number | undefined;
  for (const w of words) {
    const lw = w.toLowerCase();
    if (lw.startsWith('@') && agentIds.includes(lw.slice(1))) agents.push(lw.slice(1));
    else if (/^\d{1,4}d$/.test(lw) && lw !== '2d' && lw !== '3d') days = Number(lw.slice(0, -1));
    else rest.push(w);
  }
  return { text: rest.join(' '), agents: agents.length ? agents : undefined, days };
}
