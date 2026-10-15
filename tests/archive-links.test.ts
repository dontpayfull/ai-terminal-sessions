import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildSessionConversationIndex } from '../src/archive';
import type { WorkspaceEntry } from '../src/types';

test('buildSessionConversationIndex links live, stopped, and killed sessions to conversation IDs', () => {
  const workspaces: Record<string, WorkspaceEntry> = {
    abc12345: {
      path: '/Users/test/projects/app',
      label: 'app',
      lastSeen: '2026-10-15T10:00:00.000Z',
      sessions: {
        'ts-abc12345-1': {
          label: 'Active Feature',
          tabName: 'Active Feature #1',
          createdAt: '2026-10-15T08:00:00.000Z',
          agentSessions: [
            { agent: 'claude', id: 'conv-live-head', ts: 200 },
            { agent: 'claude', id: 'conv-shared-old', ts: 100 },
          ],
        },
        'ts-abc12345-2': {
          label: 'Stopped Job',
          createdAt: '2026-10-15T07:00:00.000Z',
          stopped: true,
          stoppedAt: '2026-10-15T09:00:00.000Z',
          lastClaudeSessionId: 'conv-stopped-legacy',
        },
      },
      killed: [
        {
          name: 'ts-abc12345-99',
          killedAt: '2026-10-15T09:30:00.000Z',
          meta: {
            label: 'Killed SMS Session',
            tabName: 'Killed SMS Session #99',
            createdAt: '2026-10-14T12:00:00.000Z',
            agentSessions: [
              { agent: 'grok', id: 'conv-killed-head', ts: 300 },
              { agent: 'claude', id: 'conv-shared-old', ts: 150 },
            ],
          },
        },
      ],
    },
  };

  const { byConversationId, allLinkedSessions } = buildSessionConversationIndex(workspaces);

  assert.equal(allLinkedSessions.length, 3);

  const liveHit = byConversationId.get('conv-live-head');
  assert.ok(liveHit);
  assert.equal(liveHit.status, 'live');
  assert.equal(liveHit.label, 'Active Feature');
  assert.equal(liveHit.isHead, true);

  const stoppedHit = byConversationId.get('conv-stopped-legacy');
  assert.ok(stoppedHit);
  assert.equal(stoppedHit.status, 'stopped');
  assert.equal(stoppedHit.label, 'Stopped Job');

  const killedHit = byConversationId.get('conv-killed-head');
  assert.ok(killedHit);
  assert.equal(killedHit.status, 'killed');
  assert.equal(killedHit.label, 'Killed SMS Session');
  assert.equal(killedHit.killedEntry?.name, 'ts-abc12345-99');

  // Shared non-head conversation prefers live/stopped over killed
  const sharedHit = byConversationId.get('conv-shared-old');
  assert.ok(sharedHit);
  assert.equal(sharedHit.status, 'live');
  assert.equal(sharedHit.sessionName, 'ts-abc12345-1');
  assert.equal(sharedHit.isHead, false);
});

test('buildSessionConversationIndex lets killed head outrank live non-head history', () => {
  const workspaces: Record<string, WorkspaceEntry> = {
    abc12345: {
      path: '/Users/test/projects/app',
      label: 'app',
      lastSeen: '2026-10-15T10:00:00.000Z',
      sessions: {
        'ts-abc12345-1': {
          label: 'Main Pane',
          createdAt: '2026-10-15T08:00:00.000Z',
          agentSessions: [
            { agent: 'claude', id: 'conv-current', ts: 500 },
            { agent: 'claude', id: 'conv-moved-to-killed', ts: 100 },
          ],
        },
      },
      killed: [
        {
          name: 'ts-abc12345-50',
          killedAt: '2026-10-15T09:45:00.000Z',
          meta: {
            label: 'Dedicated Killed Pane',
            createdAt: '2026-10-15T08:30:00.000Z',
            agentSessions: [
              { agent: 'claude', id: 'conv-moved-to-killed', ts: 400 },
            ],
          },
        },
      ],
    },
  };

  const { byConversationId } = buildSessionConversationIndex(workspaces);
  const hit = byConversationId.get('conv-moved-to-killed');
  assert.ok(hit);
  assert.equal(hit.status, 'killed');
  assert.equal(hit.label, 'Dedicated Killed Pane');
  assert.equal(hit.isHead, true);
});
