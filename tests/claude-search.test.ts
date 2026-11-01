import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanTranscript, promptSnippet } from '../src/claude-search';
import { persistedTitle } from '../src/title-follow';

const line = (o: object): string => JSON.stringify(o) + '\n';
const user = (text: string, extra: object = {}): string =>
  line({ type: 'user', cwd: '/work/app', message: { role: 'user', content: text }, ...extra });

test('scanTranscript keeps every human prompt and skips tool results, meta and sidechains', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-search-'));
  const tp = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(tp,
    user('find open source coupon projects')
    + line({ type: 'assistant', message: { content: 'ok' } })
    + line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'huge output' }] } })
    + user('<system-reminder>injected</system-reminder>', { isMeta: true })
    + user('subagent turn', { isSidechain: true })
    + user('/clear')
    + user('now compare Caramel with Honey')
    + line({ type: 'ai-title', aiTitle: 'Open source coupon projects' }));
  const e = await scanTranscript(tp, fs.statSync(tp), 'conv');
  assert.ok(e);
  assert.deepEqual(e.prompts, ['find open source coupon projects', 'now compare Caramel with Honey']);
  assert.equal(e.firstPrompt, 'find open source coupon projects');
  assert.equal(e.lastPrompt, 'now compare Caramel with Honey');
  assert.equal(e.aiTitle, 'Open source coupon projects');
  assert.equal(e.cwd, '/work/app');
  assert.equal(e.turns, 1);
  assert.equal(e.subsessionRole, undefined);
  assert.equal(e.scannedBytes, fs.statSync(tp).size);
});

test('scanTranscript continues a grown transcript from where it stopped, a half line waits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-search-'));
  const tp = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(tp, user('first question'));
  const first = await scanTranscript(tp, fs.statSync(tp), 'conv');
  assert.ok(first);

  const half = '{"type":"user","message":{"role":"user","content":"thi';
  fs.appendFileSync(tp, user('second question') + half);
  const second = await scanTranscript(tp, fs.statSync(tp), 'conv', first);
  assert.ok(second);
  assert.deepEqual(second.prompts, ['first question', 'second question']);
  assert.equal(second.scannedBytes, fs.statSync(tp).size - half.length);
  // The earlier entry is not mutated.
  assert.deepEqual(first.prompts, ['first question']);

  fs.appendFileSync(tp, 'rd question"}}\n');
  const third = await scanTranscript(tp, fs.statSync(tp), 'conv', second);
  assert.deepEqual(third?.prompts, ['first question', 'second question', 'third question']);
});

test('scanTranscript caps prompts, keeping the start and the latest ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-search-'));
  const tp = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(tp, Array.from({ length: 80 }, (_, i) => user(`question ${i}`)).join(''));
  const e = await scanTranscript(tp, fs.statSync(tp), 'conv');
  assert.equal(e?.prompts.length, 50);
  assert.equal(e?.prompts[0], 'question 0');
  assert.equal(e?.prompts[24], 'question 24');
  assert.equal(e?.prompts[49], 'question 79');
});

test('promptSnippet cuts the matching prompt around the hit', () => {
  const e = { prompts: ['hello', 'we need a parser for global prices in many currencies'] };
  assert.equal(
    promptSnippet(e as never, 'prices', 20),
    '…lobal prices in many…',
  );
  assert.equal(promptSnippet(e as never, 'nothing'), undefined);
});

test('persistedTitle holds only while its conversation is still the head', () => {
  const meta = { followedTitle: 'Coupon projects', followedTitleConv: 'a', agentSessions: [{ agent: 'claude' as const, id: 'a', ts: 1 }] };
  assert.equal(persistedTitle(meta), 'Coupon projects');
  assert.equal(persistedTitle({ ...meta, agentSessions: [{ agent: 'claude' as const, id: 'b', ts: 2 }] }), undefined);
  assert.equal(persistedTitle({ followedTitle: 'X', followedTitleConv: 'c', lastClaudeSessionId: 'c' }), 'X');
  assert.equal(persistedTitle(undefined), undefined);
});

test('scanTranscript: "-title" in a folder or prompt is not a title record', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-search-'));
  const tp = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(tp,
    line({ type: 'user', cwd: '/work/page-title', gitBranch: 'fix-title', message: { role: 'user', content: 'rename the page-title' } })
    + line({ type: 'assistant', message: { content: 'ok' } }));
  const e = await scanTranscript(tp, fs.statSync(tp), 'conv');
  assert.deepEqual(e?.prompts, ['rename the page-title']);
  assert.equal(e?.subsessionRole, undefined);
});

test('scanTranscript: agentName inside tool input does not make a teammate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-search-'));
  const tp = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(tp,
    user('start a reviewer')
    + line({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { agentName: 'reviewer' } }] } }));
  assert.equal((await scanTranscript(tp, fs.statSync(tp), 'conv'))?.subsessionRole, undefined);
  fs.writeFileSync(tp, line({ type: 'user', agentName: 'reviewer', message: { role: 'user', content: 'do it' } }));
  assert.equal((await scanTranscript(tp, fs.statSync(tp), 'conv'))?.subsessionRole, 'teammate');
});

test('scanTranscript: a prompt starting with a path is a prompt, a slash command is not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-search-'));
  const tp = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(tp, user('/clear') + user('/model opus') + user('/work/app/main.ts crashes; fix it'));
  assert.deepEqual((await scanTranscript(tp, fs.statSync(tp), 'conv'))?.prompts, ['/work/app/main.ts crashes; fix it']);
});

test('scanTranscript keeps a small promptless conversation that has a title', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-search-'));
  const tp = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(tp, user('/clear') + line({ type: 'ai-title', aiTitle: 'Titled' }));
  assert.equal((await scanTranscript(tp, fs.statSync(tp), 'conv'))?.aiTitle, 'Titled');
  fs.writeFileSync(tp, user('/clear'));
  assert.equal(await scanTranscript(tp, fs.statSync(tp), 'conv'), undefined);
});

test('scanTranscript: a changed sidecar wins over an older custom-title record', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-search-'));
  const tp = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(tp, user('hi') + line({ type: 'custom-title', customTitle: 'Old' }));
  const first = await scanTranscript(tp, fs.statSync(tp), 'conv');
  assert.equal(first?.customTitle, 'Old');
  // No sidecar on disk: the name was cleared.
  const second = await scanTranscript(tp, fs.statSync(tp), 'conv', first, true);
  assert.equal(second?.customTitle, undefined);
});

test('scanTranscript records the entrypoint, and claude -p runs count as automated', async () => {
  const { archivedFromEntry } = await import('../src/conversation-search');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-search-'));
  const tp = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(tp, user('summarize', { entrypoint: 'sdk-cli' }));
  const e = await scanTranscript(tp, fs.statSync(tp), 'conv');
  assert.equal(e?.entrypoint, 'sdk-cli');
  assert.equal(archivedFromEntry(e!, () => undefined).automated, true);
  fs.writeFileSync(tp, user('hello', { entrypoint: 'cli' }));
  const typed = await scanTranscript(tp, fs.statSync(tp), 'conv');
  assert.equal(archivedFromEntry(typed!, () => undefined).automated, undefined);
});
