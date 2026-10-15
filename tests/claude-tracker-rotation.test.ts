// The event logs are shared by every open window, and any window that starts
// while a log is over the cap rotates it (<log> -> <log>.1, fresh <log>).
// Windows that were already open must keep reading the new file.

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
  const recorded: string[] = [];
  const index = {
    recorded,
    recordAgentSession: (_h: string, _n: string, _a: string, id: string) => { recorded.push(id); },
    recordClaudeSession: (_h: string, _n: string, id: string) => { recorded.push(id); },
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
  return index;
}

let n = 0;
function event(tab: number): { id: string; line: string } {
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const line = JSON.stringify({
    agent: 'claude', event: 'UserPromptSubmit', ts: Math.floor(Date.now() / 1000),
    sessionId: id, tmuxSession: `ts-9c396db3-${tab}`, cwd: '/tmp',
  }) + '\n';
  return { id, line };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}

/** What a newly opened window does to a log over the cap. */
function rotateLikeAnotherWindow(): void {
  fs.renameSync(LOG, `${LOG}.1`);
  fs.writeFileSync(LOG, '');
}

function startTracker() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const index = fakeIndex();
  const ctx = { extensionPath: fs.mkdtempSync(path.join(os.homedir(), 'ts-ext-')) };
  const tracker = new ClaudeTracker(ctx as never, new AgentRegistry(), index as never);
  tracker.start();
  return { tracker, index };
}

test('keeps reading the log after another window rotates it', async () => {
  const { tracker, index } = startTracker();
  try {
    const a = event(1);
    fs.appendFileSync(LOG, a.line);
    await until(() => index.recorded.includes(a.id));

    rotateLikeAnotherWindow();
    const b = event(2);
    fs.appendFileSync(LOG, b.line);
    await until(() => index.recorded.includes(b.id));
  } finally {
    tracker.dispose();
  }
});

test('reads the end of the old log that was written just before the rotation', async () => {
  const { tracker, index } = startTracker();
  try {
    const a = event(3);
    fs.appendFileSync(LOG, a.line);
    await until(() => index.recorded.includes(a.id));

    // Appended and rotated in the same tick: the watcher has not run yet.
    const late = event(4);
    fs.appendFileSync(LOG, late.line);
    rotateLikeAnotherWindow();
    const b = event(5);
    fs.appendFileSync(LOG, b.line);

    await until(() => index.recorded.includes(b.id));
    assert.ok(index.recorded.includes(late.id), 'event left in <log>.1 was lost');
    assert.equal(index.recorded.filter(id => id === a.id).length, 1, 'old events were read twice');
  } finally {
    tracker.dispose();
  }
});
