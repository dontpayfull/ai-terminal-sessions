import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanTitle, scanTitles, TitleCache } from '../src/title-follow';

const line = (o: object): string => JSON.stringify(o) + '\n';

test('Claude titles are read from the new bytes only, a half line waits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-titles-'));
  const tp = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(tp, line({ type: 'user', message: { content: 'hi' } }) + line({ type: 'ai-title', aiTitle: 'First title' }));
  const c: TitleCache = { size: 0, mtimeMs: 0, offset: 0, readAt: 0 };
  await scanTitles(tp, c, fs.statSync(tp), 'claude');
  assert.equal(c.auto, 'First title');
  assert.equal(c.offset, fs.statSync(tp).size);

  // A newer title, and half of a record still being written.
  const half = '{"type":"ai-title","aiTi';
  fs.appendFileSync(tp, line({ type: 'ai-title', aiTitle: 'Better title' }) + half);
  await scanTitles(tp, c, fs.statSync(tp), 'claude');
  assert.equal(c.auto, 'Better title');
  assert.equal(c.offset, fs.statSync(tp).size - half.length);

  // The rest of it lands; then a /rename, then the /rename cleared.
  fs.appendFileSync(tp, 'tle":"Third title"}\n' + line({ type: 'custom-title', customTitle: 'Mine' }));
  await scanTitles(tp, c, fs.statSync(tp), 'claude');
  assert.equal(c.auto, 'Third title');
  assert.equal(c.custom, 'Mine');
  fs.appendFileSync(tp, line({ type: 'custom-title', customTitle: '' }));
  await scanTitles(tp, c, fs.statSync(tp), 'claude');
  assert.equal(c.custom, undefined);

  // Rewritten shorter: read again from the start.
  fs.writeFileSync(tp, line({ type: 'ai-title', aiTitle: 'New file' }));
  await scanTitles(tp, c, fs.statSync(tp), 'claude');
  assert.equal(c.auto, 'New file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanTitle flattens, strips control characters and caps the length', () => {
  assert.equal(cleanTitle('  Fix\nlogin \u0007 redirect  '), 'Fix login redirect');
  assert.equal(cleanTitle('   '), undefined);
  const long = cleanTitle('x'.repeat(100))!;
  assert.equal(long.length, 60);
  assert.ok(long.endsWith('…'));
});

test('OpenCode: the newest root session title wins, a subagent\'s never does', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-titles-'));
  const tp = path.join(dir, 'ses_root.jsonl');
  fs.writeFileSync(tp,
    line({ type: 'session', id: 'ses_root', parentID: null, title: 'New session - 2026-10-30T10:00:00' })
    + line({ type: 'user', text: 'x'.repeat(300_000) })
    + line({ type: 'session', id: 'ses_root', parentID: null, title: 'Fix the login redirect' })
    + line({ type: 'session', id: 'ses_child', parentID: 'ses_root', title: 'Explore auth code' }));
  const c: TitleCache = { size: 0, mtimeMs: 0, offset: 0, readAt: 0 };
  await scanTitles(tp, c, fs.statSync(tp), 'opencode');
  assert.equal(c.auto, 'Fix the login redirect');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Claude: a /rename record wins over the sidecar, a cleared one too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-titles-'));
  const tp = path.join(dir, 'abc.jsonl');
  fs.mkdirSync(path.join(dir, 'abc'));
  fs.writeFileSync(path.join(dir, 'abc', 'custom-title.json'), JSON.stringify({ customTitle: 'From sidecar' }));
  fs.writeFileSync(tp, line({ type: 'ai-title', aiTitle: 'Auto' }));
  const c: TitleCache = { size: 0, mtimeMs: 0, offset: 0, readAt: 0 };
  await scanTitles(tp, c, fs.statSync(tp), 'claude');
  assert.equal(c.custom, 'From sidecar');
  fs.appendFileSync(tp, line({ type: 'custom-title', customTitle: 'From record' }));
  await scanTitles(tp, c, fs.statSync(tp), 'claude');
  assert.equal(c.custom, 'From record');
  fs.appendFileSync(tp, line({ type: 'custom-title', customTitle: '' }));
  await scanTitles(tp, c, fs.statSync(tp), 'claude');
  assert.equal(c.custom, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a character split by a chunk end keeps the offset exact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-titles-'));
  const tp = path.join(dir, 'utf.jsonl');
  // Diacritics and emoji in a long line, then a title record after it.
  fs.writeFileSync(tp, line({ type: 'user', text: 'ăîșț🙂'.repeat(800_000) }) + line({ type: 'ai-title', aiTitle: 'După diacritice' }));
  const c: TitleCache = { size: 0, mtimeMs: 0, offset: 0, readAt: 0 };
  await scanTitles(tp, c, fs.statSync(tp), 'claude');
  assert.equal(c.auto, 'După diacritice');
  assert.equal(c.offset, fs.statSync(tp).size);
  fs.rmSync(dir, { recursive: true, force: true });
});
