import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'os';
import * as tmux from '../src/tmux';

test('parkSession keeps the session on a placeholder and unparkSession brings a shell back', async (t) => {
  const tmuxPath = await tmux.detectTmuxPath('');
  if (!tmuxPath) { t.skip('tmux not installed'); return; }
  const name = `ts-parktest-${process.pid}`;
  await tmux.createDetachedSession(tmuxPath, name, os.tmpdir());
  try {
    assert.equal(await tmux.isParked(tmuxPath, name), false);
    await tmux.parkSession(tmuxPath, name, 'My Session');
    assert.equal(await tmux.hasSession(tmuxPath, name), true);
    assert.equal(await tmux.isParked(tmuxPath, name), true);
    await tmux.unparkSession(tmuxPath, name, os.tmpdir());
    assert.equal(await tmux.isParked(tmuxPath, name), false);
    assert.equal(await tmux.hasSession(tmuxPath, name), true);
  } finally {
    await tmux.killSession(tmuxPath, name);
  }
});
