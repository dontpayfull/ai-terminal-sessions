import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'os';
import { clampClearMinutes } from '../src/config';

test('HOME points at a temp folder', () => {
  assert.match(os.homedir(), /ts-test-home-/);
});

test('clampClearMinutes keeps whole minutes in 1..1440', () => {
  assert.equal(clampClearMinutes(90), 90);
  assert.equal(clampClearMinutes(0), 1);
  assert.equal(clampClearMinutes(5000), 1440);
  assert.equal(clampClearMinutes('x'), 30);
});
