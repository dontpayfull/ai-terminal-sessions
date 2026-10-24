// Start on a stopped session runs `claude --resume`, which appends bookkeeping
// lines to the old transcript. The fresh mtime alone must not read as a turn
// in flight: the row stays idle until a prompt is submitted.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeTracker } from '../src/claude-tracker';
import { AgentRegistry } from '../src/agents/registry';

const ROOT = path.join(os.homedir(), '.terminal-sessions');
const LOG = path.join(ROOT, 'agent-events.log');
const SESSION = '00000000-0000-4000-8000-00000000c0de';
const TMUX = 'ts-9c396db3-77';

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

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}

function hook(event: string, transcriptPath: string): string {
  return JSON.stringify({
    agent: 'claude', event, ts: Math.floor(Date.now() / 1000),
    sessionId: SESSION, tmuxSession: TMUX, cwd: '/tmp', transcriptPath,
  }) + '\n';
}

test('a resumed session with no new prompt is idle, not working', async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const transcript = path.join(os.homedir(), 'resume.jsonl');
  const day = Date.now() - 24 * 3600_000;
  fs.writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: 'Count to 3' }, uuid: 'u-1', timestamp: new Date(day).toISOString() },
    {
      type: 'assistant', uuid: 'a-1', timestamp: new Date(day + 5000).toISOString(),
      message: { id: 'msg-1', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: '1, 2, 3' }] },
    },
    // What the resume appends: no timestamp, but the mtime is now.
    { type: 'last-prompt', sessionId: SESSION },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');

  const ctx = { extensionPath: fs.mkdtempSync(path.join(os.homedir(), 'ts-ext-')) };
  const tracker = new ClaudeTracker(ctx as never, new AgentRegistry(), fakeIndex() as never);
  tracker.start();
  try {
    fs.appendFileSync(LOG, hook('SessionStart', transcript));
    await until(() => tracker.getSnapshot(TMUX)?.lastAssistantMessage === '1, 2, 3');
    assert.equal(tracker.getSnapshot(TMUX)?.state, 'idle');

    fs.appendFileSync(LOG, hook('UserPromptSubmit', transcript));
    await until(() => tracker.getSnapshot(TMUX)?.state === 'working');
  } finally {
    tracker.dispose();
  }
});
