import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AgentId, AgentProvider, AgentSessionSummary } from './agents/types';
import type { TranscriptSummary } from './claude-transcript';
import type { KilledEntry, SessionLabel, WorkspaceEntry } from './types';

/** A past session found on disk, plus its sidecar friendly name if any. */
export interface ArchivedSession extends AgentSessionSummary {
  friendlyName?: string;
}

/** Terminal Sessions metadata linked to a conversation (or a standalone
 *  killed/stopped/live session row in the archive picker). */
export interface LinkedTerminalSession {
  status: 'live' | 'stopped' | 'killed';
  workspaceHash: string;
  workspacePath: string;
  workspaceLabel: string;
  sessionName: string;
  label?: string;
  tabName?: string;
  folderPath?: string;
  killedEntry?: KilledEntry;
  killedAt?: string;
  stoppedAt?: string;
  isHead: boolean;
}

function collectSessionAgentRefs(meta: SessionLabel): Array<{ agent: AgentId; id: string; isHead: boolean }> {
  const out: Array<{ agent: AgentId; id: string; isHead: boolean }> = [];
  const seen = new Set<string>();
  const tagged = meta.agentSessions ?? [];
  tagged.forEach((r, idx) => {
    const key = `${r.agent}:${r.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ agent: r.agent, id: r.id, isHead: idx === 0 });
    }
  });
  const legacy: string[] = [];
  if (meta.lastClaudeSessionId) legacy.push(meta.lastClaudeSessionId);
  for (const id of meta.claudeSessionHistory ?? []) {
    if (!legacy.includes(id)) legacy.push(id);
  }
  legacy.forEach((id, idx) => {
    const key = `claude:${id}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ agent: 'claude', id, isHead: out.length === 0 && idx === 0 });
    }
  });
  return out;
}

/**
 * Build a lookup from conversation `sessionId` to the Terminal Sessions pane
 * (live, stopped, or killed in the graveyard) that owns or ran it, plus a list
 * of killed/stopped sessions that have no matching on-disk transcript in the
 * current scan so the user can still find and restore them by session name.
 *
 * Precedence when multiple panes reference the same conversation id:
 *   1. Live/stopped session where the id is the head conversation
 *   2. Killed session where the id is the head conversation
 *   3. Live/stopped session where the id is in history
 *   4. Killed session where the id is in history
 */
export function buildSessionConversationIndex(
  workspaces: Record<string, WorkspaceEntry>,
): {
  byConversationId: Map<string, LinkedTerminalSession>;
  allLinkedSessions: LinkedTerminalSession[];
} {
  const byConversationId = new Map<string, LinkedTerminalSession>();
  const rankOf = (link: LinkedTerminalSession): number => {
    if (link.status !== 'killed' && link.isHead) return 4;
    if (link.status === 'killed' && link.isHead) return 3;
    if (link.status !== 'killed') return 2;
    return 1;
  };
  const allLinkedSessions: LinkedTerminalSession[] = [];

  for (const [hash, ws] of Object.entries(workspaces)) {
    for (const [sessionName, meta] of Object.entries(ws.sessions ?? {})) {
      const status: 'live' | 'stopped' = meta.stopped ? 'stopped' : 'live';
      const base: LinkedTerminalSession = {
        status,
        workspaceHash: hash,
        workspacePath: ws.path,
        workspaceLabel: ws.label,
        sessionName,
        label: meta.label,
        tabName: meta.tabName,
        folderPath: meta.folderPath,
        stoppedAt: meta.stoppedAt,
        isHead: true,
      };
      allLinkedSessions.push(base);
      for (const ref of collectSessionAgentRefs(meta)) {
        const candidate: LinkedTerminalSession = { ...base, isHead: ref.isHead };
        const prev = byConversationId.get(ref.id);
        if (!prev || rankOf(candidate) > rankOf(prev)) {
          byConversationId.set(ref.id, candidate);
        }
      }
    }

    for (const k of ws.killed ?? []) {
      const base: LinkedTerminalSession = {
        status: 'killed',
        workspaceHash: hash,
        workspacePath: ws.path,
        workspaceLabel: ws.label,
        sessionName: k.name,
        label: k.meta.label,
        tabName: k.meta.tabName,
        folderPath: k.meta.folderPath,
        killedEntry: k,
        killedAt: k.killedAt,
        isHead: true,
      };
      allLinkedSessions.push(base);
      for (const ref of collectSessionAgentRefs(k.meta)) {
        const candidate: LinkedTerminalSession = { ...base, isHead: ref.isHead };
        const prev = byConversationId.get(ref.id);
        if (!prev || rankOf(candidate) > rankOf(prev)) {
          byConversationId.set(ref.id, candidate);
        }
      }
    }
  }

  return { byConversationId, allLinkedSessions };
}

/**
 * Merge every provider's on-disk session list into one mtime-desc list and
 * attach friendly names. Pure: providers and the name lookup are injected, so
 * this stays vscode-free and node-testable. `scopeCwd` is forwarded to each
 * provider's listSessions (undefined = all projects, a cwd = that slug only).
 *
 * Spawned sub-sessions (agent-team teammates, pure subagent transcripts) are
 * dropped by default so callers see only top-level, user-driven main threads.
 * Providers tag them via `subsessionRole`; filtering here keeps the policy in
 * one place so it applies uniformly to every agent (Claude/Codex/agy/grok) and
 * to both the resume picker and the cleanup scan. Pass
 * `{ includeSubsessions: true }` to keep them (none of today's callers do).
 */
export function scanArchive(
  providers: Pick<AgentProvider, 'listSessions'>[],
  nameLookup: (sessionId: string) => string | undefined,
  scopeCwd?: string,
  opts?: { includeSubsessions?: boolean },
): ArchivedSession[] {
  const merged: ArchivedSession[] = [];
  for (const p of providers) {
    let list: AgentSessionSummary[] = [];
    try { list = p.listSessions(scopeCwd); } catch { list = []; }
    for (const s of list) {
      if (s.subsessionRole && !opts?.includeSubsessions) continue;
      merged.push({ ...s, friendlyName: nameLookup(s.sessionId) });
    }
  }
  merged.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  return merged;
}

/**
 * Decide a cleanup verdict for one session.
 *   - empty   = 0 user/assistant records and no summary line.
 *   - invalid = first user message is an "Invalid API key" stub.
 *   - keep    = everything else (and any unreadable summary — never delete
 *               something we couldn't classify).
 */
export function classifyForCleanup(
  summary: TranscriptSummary | undefined,
): 'empty' | 'invalid' | 'keep' {
  if (!summary) return 'keep';
  const first = summary.firstUserMessage || '';
  if (/Invalid API key|Please run \/login/i.test(first)) return 'invalid';
  if (summary.userAssistantCount === 0 && !summary.hasSummary) return 'empty';
  return 'keep';
}

/**
 * Soft-delete a session transcript by moving it into
 * `~/.claude/projects/.bak/<slug>__<id>.jsonl`. Also moves the session's
 * `<id>/subagents` sibling dir if present. A 0-byte file is unlinked outright.
 *
 * HARD BOUNDARY: only the `.jsonl` (+ its subagents dir) is touched. We never
 * read or write __store.db, sessions-index.json, history, or any other Claude
 * state — so Claude's index goes stale but is never corrupted.
 */
export function softDeleteSession(
  transcriptPath: string,
): { ok: boolean; dest?: string; error?: string } {
  try {
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    // Defense in depth: the .bak slug scheme only makes sense for the
    // ~/.claude/projects layout. Refuse anything outside it so a mis-routed
    // non-Claude transcript (e.g. ~/.codex/sessions/YYYY/MM/…) can never be moved
    // and have its date-path destroyed.
    const resolved = path.resolve(transcriptPath);
    if (resolved !== projectsRoot && !resolved.startsWith(projectsRoot + path.sep)) {
      return { ok: false, error: 'refused: path outside ~/.claude/projects' };
    }
    const slug = path.basename(path.dirname(transcriptPath));
    const id = path.basename(transcriptPath, '.jsonl');

    let stat: fs.Stats;
    try { stat = fs.statSync(transcriptPath); }
    catch { return { ok: false, error: 'not found' }; }

    if (stat.size === 0) {
      fs.unlinkSync(transcriptPath);
      // Best-effort: drop an empty subagents dir too.
      try { fs.rmSync(path.join(path.dirname(transcriptPath), id, 'subagents'), { recursive: true, force: true }); } catch { /* none */ }
      return { ok: true, dest: '(unlinked empty file)' };
    }

    const bakDir = path.join(projectsRoot, '.bak');
    try { fs.mkdirSync(bakDir, { recursive: true }); }
    catch (e) { return { ok: false, error: `mkdir .bak failed: ${String(e)}` }; }

    const dest = path.join(bakDir, `${slug}__${id}.jsonl`);
    fs.renameSync(transcriptPath, dest);

    // Move the background-agent transcripts dir if it exists.
    const subDir = path.join(path.dirname(transcriptPath), id, 'subagents');
    if (fs.existsSync(subDir)) {
      try { fs.renameSync(subDir, path.join(bakDir, `${slug}__${id}__subagents`)); } catch { /* best effort */ }
    }
    return { ok: true, dest };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}
