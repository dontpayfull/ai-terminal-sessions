import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'child_process';
import type * as vscode from 'vscode';
import { isSeparator, separatorLabel, separatorName, separatorOf, separatorSpec, separatorStyle } from '../src/separator';

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
    // Right after spawn the child can still be the forked node process, not
    // yet /bin/sh: ask again (each fake tab is a fresh, uncached terminal).
    let found = false;
    for (let i = 0; i < 20 && !found; i++) {
      found = await isSeparator(fakeTerminal({}, child.pid));
      if (!found) await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(found, true);
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

test('separatorLabel reads the label back from a separator tab name', () => {
  assert.equal(separatorLabel('── Research ──'), 'Research');
  assert.equal(separatorLabel('────────────'), '');
  assert.equal(separatorLabel('2026.Q4 - Research #315'), undefined);
  assert.equal(separatorLabel('── half'), undefined);
});

test('separatorName centres an upper-cased name in a fixed width', () => {
  const line = separatorName('Diverse', 'line');
  assert.equal(line, '━━━━━━━━━  DIVERSE  ━━━━━━━━━━');
  assert.equal(line.length, 30);
  assert.equal(separatorName('Diverse', 'band', 'center', 'short'), '▓▓▓▓  DIVERSE  ▓▓▓▓▓');
  assert.equal(separatorName('Diverse', 'double', 'center', 'long').length, 42);
  // A long name keeps three marks a side.
  assert.match(separatorName('x'.repeat(40), 'line'), /^━{3}  X{40}  ━{3}$/);
});

test('separatorName puts the name after a short lead, or at the very start', () => {
  assert.equal(separatorName('Diverse', 'line', 'left', 'medium'), '━━  DIVERSE  ━━━━━━━━━━━━━━━━━');
  assert.equal(separatorName('Diverse', 'shade', 'flush', 'short'), 'DIVERSE  ░░░░░░░░░░░');
  assert.equal(separatorName('Diverse', 'line', 'left').length, 30);
  assert.equal(separatorName('Diverse', 'line', 'flush').length, 30);
});

test('a separator without a name is a run at the chosen length; blank is blank', () => {
  assert.equal(separatorName('', 'line', 'center', 'short'), '━'.repeat(20));
  assert.equal(separatorName('', 'dots', 'left', 'long'), '·'.repeat(42));
  assert.equal(separatorName('ignored', 'blank'), '⠀'.repeat(8));
});

test('every look, alignment and length reads back and opens again as is', () => {
  const styles = ['line', 'double', 'thin', 'dots', 'band', 'solid', 'shade', 'blank'] as const;
  for (const style of styles) {
    for (const align of ['center', 'left', 'flush'] as const) {
      for (const length of ['short', 'medium', 'long'] as const) {
        for (const label of ['Research', 'Two Words', '']) {
          const name = separatorName(label, style, align, length);
          assert.equal(separatorStyle(name), style, name);
          assert.equal(separatorLabel(name), style === 'blank' ? '' : label.toUpperCase(), name);
          assert.equal(separatorOf(name), name);
        }
      }
    }
  }
  assert.equal(separatorOf('2026.Q4 - Research #315'), undefined);
  assert.equal(separatorOf('⏸ 2026.Q4 - DPF Workspace #320'), undefined);
});

test('an old separator, or a bare label stored in a tag, opens as a heavy line', () => {
  assert.equal(separatorOf('── Research ──'), separatorName('Research', 'line'));
  // The old plain line matches a tag's empty label, so Start All sees it open.
  assert.equal(separatorOf('────────────'), separatorSpec(''));
  assert.equal(separatorSpec('Research'), separatorName('Research', 'line'));
  const band = separatorName('Research', 'band', 'flush', 'long');
  assert.equal(separatorSpec(band), band);
});

test('fill marks around a name are dropped, so the name still reads back', () => {
  const name = separatorName('━ Work ━', 'line', 'flush', 'short');
  assert.equal(name, 'WORK  ━━━━━━━━━━━━━━');
  assert.equal(separatorOf(name), name);
  assert.equal(separatorLabel(name), 'WORK');
});
