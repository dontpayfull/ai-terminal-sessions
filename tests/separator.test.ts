import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'child_process';
import type * as vscode from 'vscode';
import { isSeparator } from '../src/separator';

function fakeTerminal(creationOptions: object, pid?: number): vscode.Terminal {
  return { creationOptions, processId: Promise.resolve(pid) } as unknown as vscode.Terminal;
}

test('isSeparator recognizes a separator tab by its shell args', async () => {
  const t = fakeTerminal({ shellPath: '/bin/sh', shellArgs: ['-c', 'x', 'terminal-sessions-separator', 'name'] });
  assert.equal(await isSeparator(t), true);
});

test('isSeparator rejects a tmux session tab and a tab with no known process', async () => {
  const tmuxTab = fakeTerminal({ shellPath: 'tmux', shellArgs: ['new-session', '-A', '-s', 'ts-abc-1'] }, process.pid);
  assert.equal(await isSeparator(tmuxTab), false);
  assert.equal(await isSeparator(fakeTerminal({})), false);
});

test('isSeparator recognizes a reload-restored separator by its process', async () => {
  const script = "trap '' INT; while :; do sleep 2147483647; done";
  const child = spawn('/bin/sh', ['-c', script, 'terminal-sessions-separator', '── x ──'], { stdio: 'ignore', detached: true });
  try {
    assert.equal(await isSeparator(fakeTerminal({}, child.pid)), true);
  } finally {
    process.kill(-child.pid!, 'SIGKILL');
  }
});

test('isSeparator does not claim an ordinary long sleep', async () => {
  const child = spawn('sleep', ['2147483647'], { stdio: 'ignore' });
  try {
    assert.equal(await isSeparator(fakeTerminal({}, child.pid)), false);
  } finally {
    child.kill();
  }
});
