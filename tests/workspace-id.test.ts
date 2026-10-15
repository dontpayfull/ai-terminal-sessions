import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  hashPath,
  sessionName,
  parseSessionName,
  currentWorkspace,
} from '../src/workspace-id';

test('hashPath produces deterministic 8-character hex strings', () => {
  const p1 = '/Users/test/projects/repo-a';
  const p2 = '/Users/test/projects/repo-b';

  const h1 = hashPath(p1);
  const h2 = hashPath(p2);

  assert.equal(h1.length, 8);
  assert.equal(h2.length, 8);
  assert.match(h1, /^[0-9a-f]{8}$/);
  assert.match(h2, /^[0-9a-f]{8}$/);

  // Determinism
  assert.equal(hashPath(p1), h1);
  assert.notEqual(h1, h2);

  // Empty string
  assert.equal(hashPath('').length, 8);
});

test('sessionName formats prefix, hash, and tabId correctly', () => {
  assert.equal(sessionName('ts', '9c396db3', 1), 'ts-9c396db3-1');
  assert.equal(sessionName('dev+', 'abcdef', 0), 'dev+-abcdef-0');
  assert.equal(sessionName('c++', '12345678', 42), 'c++-12345678-42');
});

test('parseSessionName parses standard session names', () => {
  const parsed1 = parseSessionName('ts-9c396db3-1', 'ts');
  assert.deepEqual(parsed1, { hash: '9c396db3', tabId: 1 });

  const parsed2 = parseSessionName('ts-abcdef-0', 'ts');
  assert.deepEqual(parsed2, { hash: 'abcdef', tabId: 0 });

  const parsed16 = parseSessionName('ts-0123456789abcdef-99', 'ts');
  assert.deepEqual(parsed16, { hash: '0123456789abcdef', tabId: 99 });
});

test('parseSessionName handles prefixes containing regex metacharacters', () => {
  // Metacharacters: +, *, ?, ., [, ], (, ), $, ^, |, {, }, \
  assert.deepEqual(parseSessionName('c++-9c396db3-2', 'c++'), { hash: '9c396db3', tabId: 2 });
  assert.deepEqual(parseSessionName('dev+-9c396db3-3', 'dev+'), { hash: '9c396db3', tabId: 3 });
  assert.deepEqual(parseSessionName('[test]-abcdef-4', '[test]'), { hash: 'abcdef', tabId: 4 });
  assert.deepEqual(parseSessionName('a.b-abcdef-5', 'a.b'), { hash: 'abcdef', tabId: 5 });
  assert.deepEqual(parseSessionName('a*b-abcdef-6', 'a*b'), { hash: 'abcdef', tabId: 6 });
  assert.deepEqual(parseSessionName('a(b)-abcdef-7', 'a(b)'), { hash: 'abcdef', tabId: 7 });
  assert.deepEqual(parseSessionName('a?b-abcdef-8', 'a?b'), { hash: 'abcdef', tabId: 8 });
  assert.deepEqual(parseSessionName('a^b$c-abcdef-9', 'a^b$c'), { hash: 'abcdef', tabId: 9 });
  assert.deepEqual(parseSessionName('a|b-abcdef-10', 'a|b'), { hash: 'abcdef', tabId: 10 });
  assert.deepEqual(parseSessionName('a{2}-abcdef-11', 'a{2}'), { hash: 'abcdef', tabId: 11 });
  assert.deepEqual(parseSessionName('a\\b-abcdef-12', 'a\\b'), { hash: 'abcdef', tabId: 12 });
});

test('parseSessionName returns undefined for invalid, malformed, or mismatched names', () => {
  // Wrong prefix
  assert.equal(parseSessionName('other-9c396db3-1', 'ts'), undefined);

  // Regex metacharacter prefix mismatch (e.g. c+ should not match c if escaped)
  assert.equal(parseSessionName('c-9c396db3-1', 'c++'), undefined);
  assert.equal(parseSessionName('axb-abcdef-5', 'a.b'), undefined);

  // Hash too short (< 6 hex chars)
  assert.equal(parseSessionName('ts-abcde-1', 'ts'), undefined);

  // Hash too long (> 16 hex chars)
  assert.equal(parseSessionName('ts-0123456789abcdef0-1', 'ts'), undefined);

  // Non-hex characters in hash
  assert.equal(parseSessionName('ts-ghijkl-1', 'ts'), undefined);
  assert.equal(parseSessionName('ts-9C396DB3-1', 'ts'), undefined);

  // Missing or non-numeric tabId
  assert.equal(parseSessionName('ts-9c396db3', 'ts'), undefined);
  assert.equal(parseSessionName('ts-9c396db3-', 'ts'), undefined);
  assert.equal(parseSessionName('ts-9c396db3-abc', 'ts'), undefined);

  // Leading or trailing extra content
  assert.equal(parseSessionName('extra-ts-9c396db3-1', 'ts'), undefined);
  assert.equal(parseSessionName('ts-9c396db3-1-extra', 'ts'), undefined);
});

test('currentWorkspace returns workspace info or undefined when no folder is open', () => {
  const wsWorkspace = vscode.workspace as Record<string, unknown>;
  const originalFolders = wsWorkspace.workspaceFolders;
  try {
    wsWorkspace.workspaceFolders = undefined;
    assert.equal(currentWorkspace(), undefined);

    wsWorkspace.workspaceFolders = [];
    assert.equal(currentWorkspace(), undefined);

    wsWorkspace.workspaceFolders = [
      {
        uri: vscode.Uri.file('/Users/test/projects/my-workspace'),
        name: 'my-workspace',
        index: 0,
      },
    ];

    const ws = currentWorkspace();
    assert.ok(ws);
    assert.equal(ws.path, '/Users/test/projects/my-workspace');
    assert.equal(ws.hash, hashPath('/Users/test/projects/my-workspace'));
    assert.equal(ws.label, 'my-workspace');
  } finally {
    wsWorkspace.workspaceFolders = originalFolders;
  }
});
