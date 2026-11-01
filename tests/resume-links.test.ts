import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { findResumeLinks } from '../src/links-matcher';

const ID = '01f3cfc5-fd36-4aee-b644-de80ab512859';

test('findResumeLinks reads id and agent from a resume link in any editor scheme', () => {
  for (const scheme of ['cursor', 'vscode', 'vscode-insiders']) {
    const url = `${scheme}://visul.terminal-sessions/resume?agent=claude&id=${ID}`;
    const line = `   Open: ${url}`;
    assert.deepEqual(findResumeLinks(line), [
      { start: line.indexOf(url), length: url.length, id: ID, agent: 'claude' },
    ]);
  }
});

test('findResumeLinks strips trailing prose punctuation and allows a missing agent', () => {
  const url = `cursor://visul.terminal-sessions/resume?id=${ID}`;
  const [hit] = findResumeLinks(`(${url}).`);
  assert.equal(hit.length, url.length);
  assert.equal(hit.id, ID);
  assert.equal(hit.agent, undefined);
});

test('findResumeLinks ignores links without an id and other extensions', () => {
  assert.deepEqual(findResumeLinks('cursor://visul.terminal-sessions/resume?agent=claude'), []);
  assert.deepEqual(findResumeLinks(`cursor://other.ext/resume?id=${ID}`), []);
  assert.deepEqual(findResumeLinks('plain text'), []);
});
