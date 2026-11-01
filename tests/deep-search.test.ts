import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { assistantTextHit, queryTokens } from '../src/deep-search';

const line = (o: object): string => JSON.stringify(o);

test('assistantTextHit matches only the assistant text, every word, case-insensitive', () => {
  const answer = line({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'Caramel is hidden here' },
    { type: 'text', text: 'Caramel is AGPL, so we reimplement it.' },
  ] } });
  assert.equal(assistantTextHit(answer, queryTokens('caramel AGPL')), 'Caramel is AGPL, so we reimplement it.');
  assert.equal(assistantTextHit(answer, queryTokens('caramel MIT')), undefined);
});

test('assistantTextHit ignores tool calls, tool results, user records and subagents', () => {
  const toolUse = line({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { command: 'grep Caramel' } }] } });
  const toolResult = line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Caramel' }] } });
  const sidechain = line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'Caramel' }] } });
  for (const l of [toolUse, toolResult, sidechain, 'not json "type":"assistant" Caramel']) {
    assert.equal(assistantTextHit(l, ['caramel']), undefined);
  }
});

test('assistantTextHit cuts a long answer around the first word', () => {
  const text = 'x'.repeat(300) + ' needle ' + 'y'.repeat(300);
  const hit = assistantTextHit(line({ type: 'assistant', message: { content: [{ type: 'text', text }] } }), ['needle']);
  assert.ok(hit?.startsWith('…') && hit.endsWith('…') && hit.includes('needle'));
});
