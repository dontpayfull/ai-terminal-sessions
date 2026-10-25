// Start on a stopped session runs `claude --resume`, which appends bookkeeping
// lines to the old transcript. The fresh mtime alone must not read as a turn
// in flight: the row stays idle until a prompt is submitted. A compaction's
// SessionStart, though, can land in the middle of a turn and must not.

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

/** Waits for `cond`, appending a blank line to the log now and then: macOS
 *  drops folder events in the moment after the watch starts, and a blank
 *  line (ignored by the tracker) makes it look again, as the next real event
 *  would. */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  let nudge = Date.now() + 200;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    if (Date.now() > nudge) { fs.appendFileSync(LOG, '\n'); nudge = Date.now() + 200; }
    await new Promise(r => setTimeout(r, 20));
  }
}

let n = 0;

function setup() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const session = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const tmux = `ts-9c396db3-${70 + n}`;
  const transcript = path.join(os.homedir(), `resume-${n}.jsonl`);
  const day = Date.now() - 24 * 3600_000;
  fs.writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: 'Count to 3' }, uuid: 'u-1', timestamp: new Date(day).toISOString() },
    {
      type: 'assistant', uuid: 'a-1', timestamp: new Date(day + 5000).toISOString(),
      message: { id: 'msg-1', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: '1, 2, 3' }] },
    },
    // What the resume appends: no timestamp, but the mtime is now.
    { type: 'last-prompt', sessionId: session },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');

  const hook = (event: string, extra: Record<string, unknown> = {}, ts = Math.floor(Date.now() / 1000)): void => {
    fs.appendFileSync(LOG, JSON.stringify({
      agent: 'claude', event, ts, sessionId: session, tmuxSession: tmux, cwd: '/tmp', transcriptPath: transcript, ...extra,
    }) + '\n');
  };
  const ctx = { extensionPath: fs.mkdtempSync(path.join(os.homedir(), 'ts-ext-')) };
  const tracker = new ClaudeTracker(ctx as never, new AgentRegistry(), fakeIndex() as never);
  tracker.start();
  return { tracker, tmux, hook };
}

test('a resumed session with no new prompt is idle, not working', async () => {
  const { tracker, tmux, hook } = setup();
  try {
    hook('SessionStart', { source: 'resume' });
    await until(() => tracker.getSnapshot(tmux)?.lastAssistantMessage === '1, 2, 3');
    assert.equal(tracker.getSnapshot(tmux)?.state, 'idle');

    hook('UserPromptSubmit');
    await until(() => tracker.getSnapshot(tmux)?.state === 'working');
  } finally {
    tracker.dispose();
  }
});

test('a compaction in the middle of a turn keeps it working', async () => {
  const { tracker, tmux, hook } = setup();
  try {
    const now = Math.floor(Date.now() / 1000);
    hook('UserPromptSubmit', {}, now - 30);
    hook('SessionStart', { source: 'compact' }, now);
    await until(() => tracker.getSnapshot(tmux)?.lastAssistantMessage === '1, 2, 3');
    assert.equal(tracker.getSnapshot(tmux)?.state, 'working');
  } finally {
    tracker.dispose();
  }
});
