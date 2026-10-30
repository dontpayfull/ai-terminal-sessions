import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanTitle, scanClaudeTitles, TitleCache } from '../src/title-follow';

const line = (o: object): string => JSON.stringify(o) + '\n';

test('Claude titles are read from the new bytes only, a half line waits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-titles-'));
  const tp = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(tp, line({ type: 'user', message: { content: 'hi' } }) + line({ type: 'ai-title', aiTitle: 'First title' }));
  const c: TitleCache = { size: 0, mtimeMs: 0, offset: 0, readAt: 0 };
  await scanClaudeTitles(tp, c, fs.statSync(tp));
  assert.equal(c.auto, 'First title');
  assert.equal(c.offset, fs.statSync(tp).size);

  // A newer title, and half of a record still being written.
  const half = '{"type":"ai-title","aiTi';
  fs.appendFileSync(tp, line({ type: 'ai-title', aiTitle: 'Better title' }) + half);
  await scanClaudeTitles(tp, c, fs.statSync(tp));
  assert.equal(c.auto, 'Better title');
  assert.equal(c.offset, fs.statSync(tp).size - half.length);

  // The rest of it lands; then a /rename, then the /rename cleared.
  fs.appendFileSync(tp, 'tle":"Third title"}\n' + line({ type: 'custom-title', customTitle: 'Mine' }));
  await scanClaudeTitles(tp, c, fs.statSync(tp));
  assert.equal(c.auto, 'Third title');
  assert.equal(c.custom, 'Mine');
  fs.appendFileSync(tp, line({ type: 'custom-title', customTitle: '' }));
  await scanClaudeTitles(tp, c, fs.statSync(tp));
  assert.equal(c.custom, undefined);

  // Rewritten shorter: read again from the start.
  fs.writeFileSync(tp, line({ type: 'ai-title', aiTitle: 'New file' }));
  await scanClaudeTitles(tp, c, fs.statSync(tp));
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
