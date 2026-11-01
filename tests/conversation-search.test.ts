import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { cutoffFor } from '../src/conversation-search';

test('cutoffFor: 0 days means any time, else now minus N days', () => {
  assert.equal(cutoffFor(0, 1_000_000_000), 0);
  assert.equal(cutoffFor(7, 1_000_000_000), 1_000_000_000 - 7 * 86_400_000);
});

test('parseArchiveQuery takes @agent and Nd prefixes off the query', async () => {
  const { parseArchiveQuery } = await import('../src/conversation-search');
  assert.deepEqual(parseArchiveQuery('@codex redis 7d', ['claude', 'codex']), { text: 'redis', agents: ['codex'], days: 7 });
  assert.deepEqual(parseArchiveQuery('3d viewer', ['claude']), { text: '3d viewer', agents: undefined, days: undefined });
  assert.deepEqual(parseArchiveQuery('@nobody redis', ['claude']), { text: '@nobody redis', agents: undefined, days: undefined });
  assert.deepEqual(parseArchiveQuery('  ', ['claude']), { text: '', agents: undefined, days: undefined });
});
