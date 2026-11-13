// Follow Conversation Title vs CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
// finding the variable, replacing it in a settings file, and the first-prompt
// title of last resort.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  TRAFFIC_FLAG,
  TRAFFIC_FLAG_PARTS,
  claudeSettingsCandidates,
  findTrafficFlag,
  fixTrafficFlagFile,
  replaceTrafficFlag,
  shellFixInstructions,
} from '../src/title-traffic-flag';
import { FIRST_PROMPT_RETRY_MS, FIRST_PROMPT_WAIT_MS, firstPromptTitle } from '../src/title-first-prompt';

const envOf = (text: string): Record<string, unknown> => JSON.parse(text).env;

test('replaceTrafficFlag swaps the variable for the four switches in place', () => {
  const before = [
    '{',
    '  "model": "opus",',
    '  "env": {',
    '    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317",',
    `    "${TRAFFIC_FLAG}": "1",`,
    '    "ENABLE_TOOL_SEARCH": "true"',
    '  }',
    '}',
    '',
  ].join('\n');
  const after = replaceTrafficFlag(before)!;
  assert.deepEqual(after.split('\n'), [
    '{',
    '  "model": "opus",',
    '  "env": {',
    '    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317",',
    '    "DISABLE_TELEMETRY": "1",',
    '    "DISABLE_ERROR_REPORTING": "1",',
    '    "DISABLE_BUG_COMMAND": "1",',
    '    "DISABLE_AUTOUPDATER": "1",',
    '    "ENABLE_TOOL_SEARCH": "true"',
    '  }',
    '}',
    '',
  ]);
});

test('replaceTrafficFlag keeps switches already set and valid JSON when the variable is the last key', () => {
  const lastKey = `{\n\t"env": {\n\t\t"DISABLE_TELEMETRY": "0",\n\t\t"${TRAFFIC_FLAG}": "true"\n\t}\n}`;
  const a = replaceTrafficFlag(lastKey)!;
  assert.deepEqual(envOf(a), {
    DISABLE_TELEMETRY: '0', DISABLE_ERROR_REPORTING: '1', DISABLE_BUG_COMMAND: '1', DISABLE_AUTOUPDATER: '1',
  });
  assert.ok(a.includes('\t\t"DISABLE_AUTOUPDATER": "1"\n\t}'));

  // Nothing to add: the key before it loses its comma.
  const allThere = `{\n  "env": {\n${TRAFFIC_FLAG_PARTS.map(k => `    "${k}": "1",`).join('\n')}\n    "${TRAFFIC_FLAG}": "1"\n  }\n}\n`;
  const b = replaceTrafficFlag(allThere)!;
  assert.deepEqual(Object.keys(envOf(b)), [...TRAFFIC_FLAG_PARTS]);

  // CRLF files stay CRLF.
  const crlf = `{\r\n  "env": {\r\n    "${TRAFFIC_FLAG}": "1"\r\n  }\r\n}\r\n`;
  const c = replaceTrafficFlag(crlf)!;
  assert.ok(!/[^\r]\n/.test(c));
  assert.equal(Object.keys(envOf(c)).length, 4);
});

test('replaceTrafficFlag falls back to re-serializing a one-line file and refuses what it cannot read', () => {
  const oneLine = `{"env":{"A":"b","${TRAFFIC_FLAG}":1,"Z":["x"]},"model":"opus"}`;
  const out = replaceTrafficFlag(oneLine)!;
  assert.deepEqual(JSON.parse(out), {
    env: { A: 'b', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_BUG_COMMAND: '1', DISABLE_AUTOUPDATER: '1', Z: ['x'] },
    model: 'opus',
  });
  assert.equal(replaceTrafficFlag('{ not json'), undefined);
  assert.equal(replaceTrafficFlag('{"env":{"OTHER":"1"}}'), undefined);
  assert.equal(replaceTrafficFlag(`{"${TRAFFIC_FLAG}":"1"}`), undefined);   // not inside env
});

test('findTrafficFlag reads the known settings files first, then the environment', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-flag-'));
  const userFile = path.join(os.homedir(), '.claude', 'settings.json');
  const local = path.join(ws, '.claude', 'settings.local.json');
  try {
    assert.deepEqual(claudeSettingsCandidates([ws, 'relative/dir']), [
      userFile, local, path.join(ws, '.claude', 'settings.json'),
    ]);
    assert.equal(findTrafficFlag([ws], {}), undefined);
    assert.deepEqual(findTrafficFlag([ws], { [TRAFFIC_FLAG]: '1' }), { kind: 'env' });
    assert.equal(findTrafficFlag([ws], { [TRAFFIC_FLAG]: '' }), undefined);

    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, `{\n  "env": {\n    "A": "1",\n    "${TRAFFIC_FLAG}": "1"\n  }\n}\n`, { mode: 0o600 });
    assert.deepEqual(findTrafficFlag([ws], { [TRAFFIC_FLAG]: '1' }), { kind: 'file', path: local, line: 3 });

    // Only the known files can be edited, and the mode survives the edit.
    const stray = path.join(ws, 'other.json');
    fs.copyFileSync(local, stray);
    assert.equal(fixTrafficFlagFile(stray, [ws]), false);
    assert.equal(fixTrafficFlagFile(path.join(ws, '.claude', '..', '.claude', 'settings.local.json'), [ws]), true);
    assert.equal(fs.statSync(local).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(envOf(fs.readFileSync(local, 'utf8'))), ['A', ...TRAFFIC_FLAG_PARTS]);
    assert.equal(findTrafficFlag([ws], {}), undefined);
    assert.equal(fixTrafficFlagFile(local, [ws]), false);   // nothing left to fix
    assert.deepEqual(fs.readdirSync(path.dirname(local)), ['settings.local.json']);   // no temp or backup file
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('shellFixInstructions names the variable and every replacement', () => {
  const text = shellFixInstructions();
  assert.ok(text.includes(TRAFFIC_FLAG));
  for (const k of TRAFFIC_FLAG_PARTS) assert.ok(text.includes(`export ${k}=1`));
});

test('firstPromptTitle stands in only for an untitled conversation, after the wait', () => {
  let reads = 0;
  const read = (v: string | undefined) => () => { reads++; return v; };
  const t0 = 1_000_000;

  // A real title always wins and the transcript is not even read.
  assert.equal(firstPromptTitle({ auto: 'Fix login' }, read('hello'), t0, true), undefined);
  assert.equal(firstPromptTitle({ custom: 'Mine' }, read('hello'), t0, true), undefined);
  assert.equal(reads, 0);

  // Running: found at once, shown after the wait, read only once.
  const c: { first?: string; firstAt?: number; firstReadAt?: number; auto?: string } = {};
  assert.equal(firstPromptTitle(c, read('  hello world '), t0, false), undefined);
  assert.equal(firstPromptTitle(c, read('other'), t0 + FIRST_PROMPT_WAIT_MS - 1, false), undefined);
  assert.equal(firstPromptTitle(c, read('other'), t0 + FIRST_PROMPT_WAIT_MS, false), 'hello world');
  assert.equal(reads, 1);
  // The agent's title arrives late: it takes over.
  c.auto = 'Greeting';
  assert.equal(firstPromptTitle(c, read('other'), t0 + FIRST_PROMPT_WAIT_MS * 2, false), undefined);

  // Stopped: no wait. No prompt yet: looked at again only after the retry window.
  assert.equal(firstPromptTitle({}, read('resume me'), t0, true), 'resume me');
  const empty: { firstReadAt?: number } = {};
  reads = 0;
  assert.equal(firstPromptTitle(empty, read(undefined), t0, true), undefined);
  assert.equal(firstPromptTitle(empty, read(undefined), t0 + FIRST_PROMPT_RETRY_MS - 1, true), undefined);
  assert.equal(reads, 1);
  assert.equal(firstPromptTitle(empty, read('now'), t0 + FIRST_PROMPT_RETRY_MS, true), 'now');
  assert.equal(firstPromptTitle({}, () => { throw new Error('locked'); }, t0, true), undefined);
});
