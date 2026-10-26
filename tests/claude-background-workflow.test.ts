// A Workflow's agents write under `subagents/workflows/<runId>/`, not in
// `subagents/` itself. While the run goes, the lead's turn has ended (it
// waits for the run's notification), so those agents are the only sign the
// session is busy. Once the run's record lands in `workflows/<runId>.json`
// they are history and drop out.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanBackgroundAgents } from '../src/claude-transcript';
import { runningAgents } from '../src/claude-tracker';

function tailState(transcript: string) {
  return {
    snapshot: { path: transcript, subagents: [] },
    offset: 0,
    pendingToolUseIds: new Set<string>(),
    seenMessageIds: new Set<string>(),
    subagentMap: new Map(),
    msgInfo: new Map(),
    currentLineStart: 0,
    provider: {},
  };
}

const line = (content: unknown[]): string =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'gemini-3.8-flash', content } }) + '\n';

test('agents of a running workflow count as at work until the run is recorded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-wf-'));
  const transcript = path.join(root, 'sess.jsonl');
  fs.writeFileSync(transcript, '');
  const run = path.join(root, 'sess', 'subagents', 'workflows', 'wf_abc-123');
  fs.mkdirSync(run, { recursive: true });
  const agent = path.join(run, 'agent-a1b2c3.jsonl');
  fs.writeFileSync(path.join(run, 'agent-a1b2c3.meta.json'), JSON.stringify({ agentType: 'gemini-flash', description: 'sweep-s1' }));
  fs.writeFileSync(agent, line([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]));

  const state = tailState(transcript);
  const snap = () => ({ subagents: Array.from(state.subagentMap.values()) });
  assert.equal(scanBackgroundAgents(state as never), true);
  assert.equal(runningAgents(snap()), 1);
  assert.equal(state.subagentMap.get('a1b2c3')?.state, 'tool');
  assert.equal(state.subagentMap.get('a1b2c3')?.description, 'sweep-s1');

  // Lines added later are read on the next poll, a half-written one waits.
  fs.appendFileSync(agent, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] } }) + '\n');
  fs.appendFileSync(agent, line([{ type: 'text', text: 'Group done.' }]) + '{"type":"assist');
  scanBackgroundAgents(state as never);
  assert.equal(state.subagentMap.get('a1b2c3')?.state, 'working');
  assert.equal(state.subagentMap.get('a1b2c3')?.lastMessage, 'Group done.');

  // The run finished: its record is written and its agents drop out.
  fs.mkdirSync(path.join(root, 'sess', 'workflows'));
  fs.writeFileSync(path.join(root, 'sess', 'workflows', 'wf_abc-123.json'), '{}');
  scanBackgroundAgents(state as never);
  assert.equal(runningAgents(snap()), 0);
  assert.equal(state.subagentMap.size, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
