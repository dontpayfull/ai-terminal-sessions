// A prompt sent while the agent is still busy is queued: Claude Code then
// writes no user line for it (a queue operation and an attachment instead),
// and a turn of thinking and tool calls writes no assistant text either. The
// transcript alone then still ends on the previous turn's answer, which the
// last Stop hook covers. The hooks, though, report a turn in flight since
// that Stop, and the row must show it working.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeTracker } from '../src/claude-tracker';
import { AgentRegistry } from '../src/agents/registry';

const ROOT = path.join(os.homedir(), '.terminal-sessions');
const LOG = path.join(ROOT, 'agent-events.log');

function fakeIndex() {
  return {
    recordAgentSession: () => undefined,
    recordClaudeSession: () => undefined,
    getSessionMeta: () => ({ folderPath: '/tmp' }),
    setSessionFolderPath: () => undefined,
    getAllWorkspaces: () => ({}),
    getWorkspace: () => undefined,
    isSessionMuted: () => false,
    isSessionAlertOnDone: () => false,
    getSessionUnread: () => false,
    setSessionUnread: () => undefined,
    recordResumeFlags: () => undefined,
  };
}

/** Waits for `cond`, appending a blank line to the log now and then (macOS
 *  drops folder events right after the watch starts; see the resume test). */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  let nudge = Date.now() + 200;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    if (Date.now() > nudge) { fs.appendFileSync(LOG, '\n'); nudge = Date.now() + 200; }
    await new Promise(r => setTimeout(r, 20));
  }
}

test('a queued prompt running tools after the last Stop shows working', async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const session = '00000000-0000-4000-8000-0000000000a1';
  const tmux = 'ts-9c396db3-901';
  const transcript = path.join(os.homedir(), 'queued.jsonl');
  const now = Date.now();
  const iso = (ms: number): string => new Date(now - ms).toISOString();
  const sec = (ms: number): number => Math.floor((now - ms) / 1000);
  fs.writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: 'Check the pool' }, uuid: 'u-1', timestamp: iso(120_000) },
    {
      type: 'assistant', uuid: 'a-1', timestamp: iso(100_000),
      message: { id: 'msg-1', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'Pool is fine.' }] },
    },
    // The next prompt, queued: no user line.
    { type: 'queue-operation', operation: 'enqueue', timestamp: iso(30_000), sessionId: session, content: 'Now resize it' },
    {
      type: 'assistant', uuid: 'a-2', timestamp: iso(20_000),
      message: { id: 'msg-2', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'thinking', thinking: 'resize' }] },
    },
    {
      type: 'assistant', uuid: 'a-3', timestamp: iso(15_000),
      message: { id: 'msg-3', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id: 't-1', name: 'Edit', input: {} }] },
    },
    { type: 'user', uuid: 'u-2', timestamp: iso(14_000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-1', content: 'ok' }] } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.mkdirSync(ROOT, { recursive: true });
  const hook = (event: string, ms: number, extra: Record<string, unknown> = {}): string => JSON.stringify({
    agent: 'claude', event, ts: sec(ms), sessionId: session, tmuxSession: tmux, cwd: '/tmp', transcriptPath: transcript, ...extra,
  });
  fs.writeFileSync(LOG, [
    hook('UserPromptSubmit', 120_000),
    hook('Stop', 100_000),
    hook('UserPromptSubmit', 30_000),
    hook('PreToolUse', 15_000, { toolName: 'Edit' }),
    hook('PostToolUse', 14_000, { toolName: 'Edit' }),
  ].join('\n') + '\n');

  const ctx = { extensionPath: fs.mkdtempSync(path.join(os.homedir(), 'ts-ext-')) };
  const tracker = new ClaudeTracker(ctx as never, new AgentRegistry(), fakeIndex() as never);
  tracker.start();
  try {
    await until(() => tracker.getSnapshot(tmux)?.lastAssistantMessage === 'Pool is fine.');
    assert.equal(tracker.getSnapshot(tmux)?.state, 'working');
  } finally {
    tracker.dispose();
  }
});
