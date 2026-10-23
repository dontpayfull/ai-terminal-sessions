import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import {
  readTranscriptSummary as readClaudeSummary,
  readTranscriptCwd as readClaudeCwd,
  slugFromCwd,
  reduceClaudeTranscriptLine,
} from '../src/claude-transcript';
import {
  readCodexTranscriptSummary,
  readCodexTranscriptCwd,
  reduceCodexTranscriptLine,
} from '../src/agents/codex/transcript';
import {
  readAgyTranscriptSummary,
  reduceAgyTranscriptLine,
} from '../src/agents/agy/transcript';
import {
  readOpencodeTranscriptSummary,
  readOpencodeTranscriptCwd,
  isDefaultOpencodeTitle,
  reduceOpencodeTranscriptLine,
} from '../src/agents/opencode/transcript';
import { claudeProvider } from '../src/agents/claude';
import { codexProvider } from '../src/agents/codex/provider';
import { agyProvider } from '../src/agents/agy/provider';
import { opencodeProvider } from '../src/agents/opencode/provider';
import type { AgentProvider, TranscriptTailState } from '../src/agents/types';

const FIXTURES = path.resolve(__dirname, '../../tests/fixtures');

function makeTailState(provider: AgentProvider, sessionId = 'test-session', filePath = '/tmp/fake.jsonl'): TranscriptTailState {
  return {
    snapshot: {
      sessionId,
      path: filePath,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0 },
      messageCount: 0,
      cost: 0,
      costByModel: {},
      currentContextTokens: 0,
      currentContextLimit: 200_000,
      maxContextSeen: 0,
      subagents: [],
    },
    offset: 0,
    pendingToolUseIds: new Set(),
    seenMessageIds: new Set(),
    subagentMap: new Map(),
    msgInfo: new Map(),
    currentLineStart: 0,
    provider,
  };
}

// ───────────────────────────── Claude Tests ─────────────────────────────

test('Claude readTranscriptSummary extracts fields from sample fixture', () => {
  const p = path.join(FIXTURES, 'claude', 'sample.jsonl');
  const s = readClaudeSummary(p);
  assert.ok(s);
  assert.equal(s.cwd, '/Users/test/projects/my-app');
  assert.equal(s.firstUserMessage, 'Please refactor the parser');
  assert.equal(s.customTitle, 'Parser Refactor Task');
  assert.equal(s.autoTitle, 'Refactor parser');
  assert.equal(s.lineCount, 6);
  assert.equal(s.userAssistantCount, 4);
  assert.equal(s.hasSummary, false);
});

test('Claude readTranscriptSummary unwraps slash commands from fixture', () => {
  const p = path.join(FIXTURES, 'claude', 'slash-command.jsonl');
  const s = readClaudeSummary(p);
  assert.ok(s);
  assert.equal(s.firstUserMessage, '/clear');
  assert.equal(s.lineCount, 2);
});

test('Claude readTranscriptSummary handles truncated and empty files without throwing', () => {
  const truncated = path.join(FIXTURES, 'claude', 'truncated-last-line.jsonl');
  const sTrunc = readClaudeSummary(truncated);
  assert.ok(sTrunc);
  assert.equal(sTrunc.firstUserMessage, 'Initial prompt');

  const empty = path.join(FIXTURES, 'claude', 'empty.jsonl');
  const sEmpty = readClaudeSummary(empty);
  assert.ok(sEmpty);
  assert.equal(sEmpty.lineCount, 0);
  assert.equal(sEmpty.byteSize, 0);

  const missing = path.join(FIXTURES, 'claude', 'nonexistent.jsonl');
  assert.equal(readClaudeSummary(missing), undefined);
});

test('Claude readTranscriptCwd extracts cwd and slugFromCwd replaces metacharacters', () => {
  const p = path.join(FIXTURES, 'claude', 'sample.jsonl');
  assert.equal(readClaudeCwd(p), '/Users/test/projects/my-app');
  assert.equal(readClaudeCwd(path.join(FIXTURES, 'claude', 'empty.jsonl')), undefined);

  assert.equal(slugFromCwd('/Users/test/MyWork/Projects/__app_db'), '-Users-test-MyWork-Projects---app-db');
  assert.equal(slugFromCwd('/var/log/my.app-test'), '-var-log-my-app-test');
  assert.equal(slugFromCwd(''), '');
});

test('Claude reduceClaudeTranscriptLine updates messages, usage, cost, context, and handles dedup', () => {
  const state = makeTailState(claudeProvider);

  // User turn
  const userLine = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'Count to 3' },
    uuid: 'u-1',
    timestamp: '2026-10-10T10:00:00.000Z',
  });
  const changedUser = reduceClaudeTranscriptLine(state, userLine);
  assert.equal(changedUser, true);
  assert.equal(state.snapshot.lastUserMessage, 'Count to 3');
  assert.equal(state.snapshot.messageCount, 1);
  assert.ok(state.snapshot.turn);

  // Assistant turn with token usage and cost calculation
  const assistantLine = JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg-1',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: '1, 2, 3' }],
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 100,
      },
    },
    uuid: 'a-1',
    timestamp: '2026-10-10T10:00:05.000Z',
  });
  const changedAssistant = reduceClaudeTranscriptLine(state, assistantLine);
  assert.equal(changedAssistant, true);
  assert.equal(state.snapshot.lastAssistantMessage, '1, 2, 3');
  assert.equal(state.snapshot.messageCount, 2);
  assert.equal(state.snapshot.tokens.input, 1000);
  assert.equal(state.snapshot.tokens.output, 200);
  assert.equal(state.snapshot.tokens.cacheRead, 500);
  assert.equal(state.snapshot.tokens.cacheCreate5m, 100);
  assert.equal(state.snapshot.currentContextTokens, 1600); // 1000 + 500 + 100
  assert.ok(state.snapshot.cost > 0);
  assert.ok(state.snapshot.costByModel['claude-sonnet-4-6'] > 0);

  const initialCost = state.snapshot.cost;
  // Replaying identical assistant message id should NOT bill twice
  reduceClaudeTranscriptLine(state, assistantLine);
  assert.equal(state.snapshot.cost, initialCost);

  // Malformed line does not throw and returns false
  assert.equal(reduceClaudeTranscriptLine(state, '{invalid-json'), false);
});

test('Claude reduceClaudeTranscriptLine records when a local slash command logged its output', () => {
  // `/clear`: the output lands in a system local_command record.
  const clear = makeTailState(claudeProvider);
  reduceClaudeTranscriptLine(clear, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>' },
    timestamp: '2026-10-19T11:37:46.737Z',
  }));
  assert.equal(clear.snapshot.lastUserMessage, '/clear');
  assert.equal(clear.snapshot.lastLocalCommandAt === undefined, true);
  const changed = reduceClaudeTranscriptLine(clear, JSON.stringify({
    type: 'system',
    subtype: 'local_command',
    content: '<local-command-stdout></local-command-stdout>',
    timestamp: '2026-10-19T11:37:46.964Z',
  }));
  assert.equal(changed, true);
  assert.equal(clear.snapshot.lastLocalCommandAt?.toISOString(), '2026-10-19T11:37:46.964Z');
  assert.ok(clear.snapshot.lastLocalCommandAt! >= clear.snapshot.lastUserMessageAt!);
  assert.equal(clear.snapshot.lastLocalCommandName, '/clear');

  // `/compact`, `/model`: the output lands in a user record, which must not
  // count as a new prompt or replace the preview.
  const model = makeTailState(claudeProvider);
  reduceClaudeTranscriptLine(model, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '<command-name>/model</command-name>' },
    timestamp: '2026-10-19T11:38:19.758Z',
  }));
  reduceClaudeTranscriptLine(model, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '<local-command-stdout>Set model to opus</local-command-stdout>' },
    timestamp: '2026-10-19T11:38:20.100Z',
  }));
  assert.equal(model.snapshot.lastUserMessage, '/model');
  assert.equal(model.snapshot.messageCount, 1);
  assert.equal(model.snapshot.lastLocalCommandAt?.toISOString(), '2026-10-19T11:38:20.100Z');
  assert.equal(model.snapshot.lastLocalCommandName, '/model');

  // A real prompt after the command is newer than the command output.
  reduceClaudeTranscriptLine(model, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'next question' },
    timestamp: '2026-10-19T11:39:00.000Z',
  }));
  assert.ok(model.snapshot.lastUserMessageAt! > model.snapshot.lastLocalCommandAt!);
});

// ───────────────────────────── Codex Tests ─────────────────────────────

test('Codex readCodexTranscriptSummary extracts fields and cwd from rollout fixture', () => {
  const p = path.join(FIXTURES, 'codex', 'sample.jsonl');
  const s = readCodexTranscriptSummary(p);
  assert.ok(s);
  assert.equal(s.cwd, '/Users/test/projects/codex-app');
  assert.equal(s.firstUserMessage, 'Implement feature X');
  assert.equal(s.lineCount, 7);

  assert.equal(readCodexTranscriptCwd(p), '/Users/test/projects/codex-app');
});

test('Codex readCodexTranscriptSummary handles truncated and empty files gracefully', () => {
  const trunc = path.join(FIXTURES, 'codex', 'truncated-last-line.jsonl');
  const sTrunc = readCodexTranscriptSummary(trunc);
  assert.ok(sTrunc);
  assert.equal(sTrunc.firstUserMessage, 'Implement feature X');

  const empty = path.join(FIXTURES, 'codex', 'empty.jsonl');
  const sEmpty = readCodexTranscriptSummary(empty);
  assert.ok(sEmpty);
  assert.equal(sEmpty.lineCount, 0);

  assert.equal(readCodexTranscriptSummary(path.join(FIXTURES, 'codex', 'missing.jsonl')), undefined);
  assert.equal(readCodexTranscriptCwd(empty), undefined);
});

test('Codex reduceCodexTranscriptLine parses session_meta, messages, tools, and token_count', () => {
  const state = makeTailState(codexProvider);

  // session_meta
  reduceCodexTranscriptLine(state, JSON.stringify({
    timestamp: '2026-10-10T10:00:00.000Z',
    type: 'turn_context',
    payload: { model: 'gpt-5' },
  }));
  assert.equal(state.snapshot.model, 'gpt-5');

  // response_item user message
  reduceCodexTranscriptLine(state, JSON.stringify({
    timestamp: '2026-10-10T10:00:01.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Write a sorting algorithm' }] },
  }));
  assert.equal(state.snapshot.lastUserMessage, 'Write a sorting algorithm');
  assert.equal(state.snapshot.messageCount, 1);

  // function_call tool
  reduceCodexTranscriptLine(state, JSON.stringify({
    timestamp: '2026-10-10T10:00:02.000Z',
    type: 'response_item',
    payload: { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"npm test"}' },
  }));
  assert.equal(state.snapshot.currentToolName, 'exec_command');
  assert.equal(state.snapshot.currentToolInput, 'npm test');

  // function_call_output resolves tool
  reduceCodexTranscriptLine(state, JSON.stringify({
    timestamp: '2026-10-10T10:00:03.000Z',
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'call_1', output: '{"output":"ok","metadata":{"exit_code":0}}' },
  }));
  assert.equal(state.snapshot.currentToolName, undefined);

  // token_count event
  reduceCodexTranscriptLine(state, JSON.stringify({
    timestamp: '2026-10-10T10:00:04.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model_context_window: 256000,
        last_token_usage: {
          input_tokens: 1500,
          cached_input_tokens: 500,
          output_tokens: 300,
        },
      },
    },
  }));
  assert.equal(state.snapshot.currentContextTokens, 1800); // 1500 + 300
  assert.equal(state.snapshot.currentContextLimit, 256000);
  assert.equal(state.snapshot.tokens.input, 1500);
  assert.equal(state.snapshot.tokens.cacheRead, 500);
  assert.equal(state.snapshot.tokens.output, 300);
  assert.ok(state.snapshot.cost > 0);

  // Malformed line does not throw
  assert.equal(reduceCodexTranscriptLine(state, '{invalid'), false);
});

// ───────────────────────────── Antigravity (agy) Tests ─────────────────────────────

test('Agy readAgyTranscriptSummary extracts user prompt and handles truncated/empty files', () => {
  const p = path.join(FIXTURES, 'agy', 'sample.jsonl');
  const s = readAgyTranscriptSummary(p);
  assert.ok(s);
  assert.equal(s.firstUserMessage, 'Add authentication');
  assert.equal(s.lineCount, 3);

  const trunc = path.join(FIXTURES, 'agy', 'truncated-last-line.jsonl');
  const sTrunc = readAgyTranscriptSummary(trunc);
  assert.ok(sTrunc);
  assert.equal(sTrunc.firstUserMessage, 'Add authentication');

  const empty = path.join(FIXTURES, 'agy', 'empty.jsonl');
  const sEmpty = readAgyTranscriptSummary(empty);
  assert.ok(sEmpty);
  assert.equal(sEmpty.lineCount, 0);

  assert.equal(readAgyTranscriptSummary(path.join(FIXTURES, 'agy', 'missing.jsonl')), undefined);
});

test('Agy reduceAgyTranscriptLine unwraps user request, handles tools and completion', () => {
  const state = makeTailState(agyProvider);

  // USER_INPUT wrapped in <USER_REQUEST>
  const userLine = JSON.stringify({
    step_index: 1,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: '2026-10-10T10:00:00.000Z',
    content: '<USER_REQUEST>Build login page</USER_REQUEST><ADDITIONAL_METADATA></ADDITIONAL_METADATA>',
  });
  reduceAgyTranscriptLine(state, userLine);
  assert.equal(state.snapshot.lastUserMessage, 'Build login page');
  assert.equal(state.snapshot.messageCount, 1);

  // PLANNER_RESPONSE with tool_calls
  const toolLine = JSON.stringify({
    step_index: 2,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'IN_PROGRESS',
    created_at: '2026-10-10T10:00:02.000Z',
    content: 'Running command',
    tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', toolAction: 'Running tests' } }],
  });
  reduceAgyTranscriptLine(state, toolLine);
  assert.equal(state.snapshot.currentToolName, 'run_command');
  assert.equal(state.snapshot.currentToolInput, 'Running tests');

  // PLANNER_RESPONSE done clears tool
  const doneLine = JSON.stringify({
    step_index: 3,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-10-10T10:00:05.000Z',
    content: 'Login page created successfully.',
  });
  reduceAgyTranscriptLine(state, doneLine);
  assert.equal(state.snapshot.currentToolName, undefined);
  assert.equal(state.snapshot.lastAssistantMessage, 'Login page created successfully.');

  // Malformed line does not throw
  assert.equal(reduceAgyTranscriptLine(state, '{invalid'), false);
});

// ───────────────────────────── OpenCode Tests ─────────────────────────────

test('OpenCode readOpencodeTranscriptSummary extracts fields and isDefaultOpencodeTitle identifies placeholders', () => {
  const p = path.join(FIXTURES, 'opencode', 'sample.jsonl');
  const s = readOpencodeTranscriptSummary(p);
  assert.ok(s);
  assert.equal(s.isRoot, true);
  assert.equal(s.cwd, '/Users/test/projects/opencode-app');
  assert.equal(s.firstUserMessage, 'Refactor the auth layer');
  assert.equal(s.autoTitle, 'Refactor auth');
  assert.equal(s.lineCount, 8);

  assert.equal(readOpencodeTranscriptCwd(p), '/Users/test/projects/opencode-app');

  assert.equal(isDefaultOpencodeTitle('New session - 2026-10-10'), true);
  assert.equal(isDefaultOpencodeTitle(undefined), true);
  assert.equal(isDefaultOpencodeTitle('Refactor auth'), false);
});

test('OpenCode readOpencodeTranscriptSummary handles truncated and empty files gracefully', () => {
  const trunc = path.join(FIXTURES, 'opencode', 'truncated-last-line.jsonl');
  const sTrunc = readOpencodeTranscriptSummary(trunc);
  assert.ok(sTrunc);
  assert.equal(sTrunc.firstUserMessage, 'Refactor the auth layer');

  const empty = path.join(FIXTURES, 'opencode', 'empty.jsonl');
  const sEmpty = readOpencodeTranscriptSummary(empty);
  assert.ok(sEmpty);
  assert.equal(sEmpty.isRoot, false);
  assert.equal(sEmpty.lineCount, 0);

  assert.equal(readOpencodeTranscriptSummary(path.join(FIXTURES, 'opencode', 'missing.jsonl')), undefined);
  assert.equal(readOpencodeTranscriptCwd(empty), undefined);
});

test('OpenCode reduceOpencodeTranscriptLine processes sessions, subagents, tokens, cost, and tools', () => {
  const state = makeTailState(opencodeProvider, 'root-sess-1');

  // Root session header
  reduceOpencodeTranscriptLine(state, JSON.stringify({
    ts: 1775822400000,
    type: 'session',
    id: 'root-sess-1',
    directory: '/Users/test/projects/opencode-app',
    title: 'Refactor auth',
  }));

  // Child session (subagent)
  reduceOpencodeTranscriptLine(state, JSON.stringify({
    ts: 1775822401000,
    type: 'session',
    id: 'sub-1',
    parentID: 'root-sess-1',
    title: 'Code review helper',
    agent: 'reviewer',
  }));
  assert.equal(state.subagentMap.size, 1);
  assert.equal(state.subagentMap.get('sub-1')?.agentType, 'reviewer');

  // User turn
  reduceOpencodeTranscriptLine(state, JSON.stringify({
    ts: 1775822402000,
    type: 'user',
    sessionID: 'root-sess-1',
    messageID: 'm-1',
    text: 'Check database migrations',
  }));
  assert.equal(state.snapshot.lastUserMessage, 'Check database migrations');

  // Assistant turn with cost and tokens
  reduceOpencodeTranscriptLine(state, JSON.stringify({
    ts: 1775822403000,
    type: 'assistant',
    sessionID: 'root-sess-1',
    messageID: 'm-2',
    providerID: 'anthropic',
    modelID: 'claude-3-5-sonnet',
    cost: 0.025,
    tokens: { input: 1000, output: 200, reasoning: 50, cacheRead: 300, cacheWrite: 100, total: 1650 },
  }));
  assert.equal(state.snapshot.tokens.input, 1000);
  assert.equal(state.snapshot.tokens.output, 200);
  assert.equal(state.snapshot.tokens.cacheRead, 300);
  assert.equal(state.snapshot.tokens.cacheCreate5m, 100);
  assert.equal(state.snapshot.cost, 0.025);
  assert.equal(state.snapshot.currentContextTokens, 1650); // 1000 + 200 + 50 + 300 + 100

  // Assistant text
  reduceOpencodeTranscriptLine(state, JSON.stringify({
    ts: 1775822404000,
    type: 'text',
    sessionID: 'root-sess-1',
    messageID: 'm-2',
    role: 'assistant',
    text: 'Migrations look good.',
  }));
  assert.equal(state.snapshot.lastAssistantMessage, 'Migrations look good.');

  // Tool running and completed
  reduceOpencodeTranscriptLine(state, JSON.stringify({
    ts: 1775822405000,
    type: 'tool',
    sessionID: 'root-sess-1',
    messageID: 'm-2',
    callID: 'call_1',
    tool: 'bash',
    status: 'running',
    input: 'npm test',
  }));
  assert.equal(state.snapshot.currentToolName, 'bash');
  assert.equal(state.snapshot.currentToolInput, 'npm test');

  reduceOpencodeTranscriptLine(state, JSON.stringify({
    ts: 1775822406000,
    type: 'tool',
    sessionID: 'root-sess-1',
    messageID: 'm-2',
    callID: 'call_1',
    tool: 'bash',
    status: 'completed',
    output: 'PASS',
  }));
  assert.equal(state.snapshot.currentToolName, undefined);

  // Malformed line returns false without throwing
  assert.equal(reduceOpencodeTranscriptLine(state, '{invalid'), false);
});

test('Claude reduceClaudeTranscriptLine ignores a prompt that only quotes the output tag', () => {
  const state = makeTailState(claudeProvider);
  reduceClaudeTranscriptLine(state, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'Explain the <local-command-stdout>x</local-command-stdout> tag' },
    timestamp: '2026-10-19T12:00:00.000Z',
  }));
  assert.equal(state.snapshot.lastLocalCommandAt === undefined, true);
  // A system record without the output wrapper is not a command's output either.
  reduceClaudeTranscriptLine(state, JSON.stringify({
    type: 'system', subtype: 'local_command', content: '<command-name>/model</command-name>',
    timestamp: '2026-10-19T12:00:01.000Z',
  }));
  assert.equal(state.snapshot.lastLocalCommandAt === undefined, true);
});

test('Claude reduceClaudeTranscriptLine names a combined command+output record by its own command', () => {
  const state = makeTailState(claudeProvider);
  reduceClaudeTranscriptLine(state, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '<command-name>/compact</command-name>' },
    timestamp: '2026-10-19T12:00:00.000Z',
  }));
  reduceClaudeTranscriptLine(state, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '<command-name>/model</command-name><local-command-stdout>Set model</local-command-stdout>' },
    timestamp: '2026-10-19T12:01:00.000Z',
  }));
  assert.equal(state.snapshot.lastLocalCommandName, '/model');
  assert.equal(state.snapshot.lastLocalCommandAt?.toISOString(), '2026-10-19T12:01:00.000Z');
});

test('Claude reduceClaudeTranscriptLine treats stderr output as a finished local command', () => {
  const state = makeTailState(claudeProvider);
  reduceClaudeTranscriptLine(state, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '<command-name>/model</command-name>' },
    timestamp: '2026-10-19T12:00:00.000Z',
  }));
  reduceClaudeTranscriptLine(state, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '<local-command-stderr>Unknown model</local-command-stderr>' },
    timestamp: '2026-10-19T12:00:01.000Z',
  }));
  assert.equal(state.snapshot.lastUserMessage, '/model');
  assert.equal(state.snapshot.lastLocalCommandName, '/model');
  // A second output with no command line of its own is not a second `/model`.
  reduceClaudeTranscriptLine(state, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '<local-command-stdout>later</local-command-stdout>' },
    timestamp: '2026-10-19T12:00:05.000Z',
  }));
  assert.equal(state.snapshot.lastLocalCommandName, undefined);
});

test('Claude reduceClaudeTranscriptLine marks a cancelled compaction as failed', () => {
  const state = makeTailState(claudeProvider);
  reduceClaudeTranscriptLine(state, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '<command-name>/compact</command-name>' },
    timestamp: '2026-10-19T12:00:00.000Z',
  }));
  reduceClaudeTranscriptLine(state, JSON.stringify({
    type: 'system', subtype: 'local_command',
    content: '<local-command-stdout>Compaction canceled.</local-command-stdout>',
    timestamp: '2026-10-19T12:00:03.000Z',
  }));
  assert.equal(state.snapshot.lastLocalCommandName, '/compact');
  assert.equal(state.snapshot.lastLocalCommandFailed, true);
  reduceClaudeTranscriptLine(state, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '<command-name>/compact</command-name>' },
    timestamp: '2026-10-19T12:01:00.000Z',
  }));
  reduceClaudeTranscriptLine(state, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' },
    timestamp: '2026-10-19T12:02:00.000Z',
  }));
  assert.equal(state.snapshot.lastLocalCommandFailed, false);
});

test('Claude reduceClaudeTranscriptLine does not take a compaction summary for a user prompt', () => {
  const state = makeTailState(claudeProvider);
  reduceClaudeTranscriptLine(state, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'real prompt' },
    timestamp: '2026-10-19T12:00:00.000Z',
  }));
  reduceClaudeTranscriptLine(state, JSON.stringify({
    type: 'user',
    isCompactSummary: true,
    message: { role: 'user', content: 'This session is being continued from a previous conversation...' },
    timestamp: '2026-10-19T12:05:00.000Z',
  }));
  assert.equal(state.snapshot.lastUserMessage, 'real prompt');
  assert.equal(state.snapshot.lastUserMessageAt?.toISOString(), '2026-10-19T12:00:00.000Z');
  assert.equal(state.snapshot.messageCount, 1);
});
