import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  captureFlags,
  materializeFlags,
  isYolo,
  matchedYoloFlags,
  setYolo,
  hasCoPane,
  setCoPane,
  withFlags,
  type FlagSpec,
} from '../src/agents/launch-flags';
import { yoloSpecFor } from '../src/agents/registry';

const CLAUDE_FLAG_SPEC: FlagSpec = {
  bool: ['--dangerously-skip-permissions', '--strict-mcp-config'],
  value: {
    '--model': {},
    '--permission-mode': {},
    '--add-dir': { path: true },
    '--settings': { path: true },
    '--mcp-config': { path: true },
    '--dangerously-load-development-channels': {},
  },
  companion: { '--strict-mcp-config': '--mcp-config' },
};

const CODEX_FLAG_SPEC: FlagSpec = {
  bool: ['--full-auto', '--dangerously-bypass-approvals-and-sandbox', '--yolo'],
  value: {
    '--model': {},
    '--sandbox': {},
    '--ask-for-approval': {},
    '--profile': {},
    '--config': {},
  },
  alias: { '-m': '--model', '-s': '--sandbox', '-a': '--ask-for-approval', '-c': '--config' },
};

test('captureFlags separates boolean flags, value flags, and drops positionals', () => {
  const argv = [
    'claude',
    '--dangerously-skip-permissions',
    '--model',
    'claude-sonnet-4-6',
    'some',
    'positional',
    'prompt',
  ];
  const captured = captureFlags(argv, CLAUDE_FLAG_SPEC);
  assert.deepEqual(captured, [
    '--dangerously-skip-permissions',
    '--model',
    'claude-sonnet-4-6',
  ]);
});

test('captureFlags handles --flag=value inline syntax and alias expansion', () => {
  const argv = [
    'codex',
    '--model=gpt-5',
    '--sandbox=workspace-write',
    '-a',
    'never',
    'resume',
    '019ea6e0-752a-7500-ae0b-000000000001',
  ];
  const captured = captureFlags(argv, CODEX_FLAG_SPEC);
  assert.deepEqual(captured, [
    '--model',
    'gpt-5',
    '--sandbox',
    'workspace-write',
    '--ask-for-approval',
    'never',
  ]);
});

test('captureFlags greedily absorbs split path tokens when path exists on disk', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts space test '));
  try {
    // Simulated split tokens from ps output: ['claude', '--add-dir', '/tmp/ts', 'space', 'test', '123']
    const parts = tmpDir.split(' ');
    const argv = ['claude', '--add-dir', ...parts];
    const captured = captureFlags(argv, CLAUDE_FLAG_SPEC);
    assert.deepEqual(captured, ['--add-dir', tmpDir]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('materializeFlags keeps existing path flags and drops vanished path flags', () => {
  const existingFile = path.join(os.tmpdir(), 'real-settings.json');
  fs.writeFileSync(existingFile, '{}');
  const missingFile = path.join(os.tmpdir(), 'vanished-temp-file.json');
  if (fs.existsSync(missingFile)) fs.unlinkSync(missingFile);

  try {
    const flags = [
      '--model',
      'claude-sonnet-4-6',
      '--settings',
      existingFile,
      '--mcp-config',
      missingFile,
    ];
    const live = materializeFlags(flags, CLAUDE_FLAG_SPEC);
    assert.deepEqual(live, [
      '--model',
      'claude-sonnet-4-6',
      '--settings',
      existingFile,
    ]);
  } finally {
    try { fs.unlinkSync(existingFile); } catch { /* cleanup */ }
  }
});

test('materializeFlags drops companion flag when its partner is dropped', () => {
  const missingMcp = path.join(os.tmpdir(), 'vanished-mcp.json');
  if (fs.existsSync(missingMcp)) fs.unlinkSync(missingMcp);

  const flagsWithMissingPartner = [
    '--strict-mcp-config',
    '--mcp-config',
    missingMcp,
    '--model',
    'claude-sonnet-4-6',
  ];
  const result1 = materializeFlags(flagsWithMissingPartner, CLAUDE_FLAG_SPEC);
  assert.deepEqual(result1, ['--model', 'claude-sonnet-4-6']);

  const realMcp = path.join(os.tmpdir(), 'real-mcp.json');
  fs.writeFileSync(realMcp, '{}');
  try {
    const flagsWithRealPartner = [
      '--strict-mcp-config',
      '--mcp-config',
      realMcp,
      '--model',
      'claude-sonnet-4-6',
    ];
    const result2 = materializeFlags(flagsWithRealPartner, CLAUDE_FLAG_SPEC);
    assert.deepEqual(result2, [
      '--strict-mcp-config',
      '--mcp-config',
      realMcp,
      '--model',
      'claude-sonnet-4-6',
    ]);
  } finally {
    try { fs.unlinkSync(realMcp); } catch { /* cleanup */ }
  }
});

test('isYolo and matchedYoloFlags identify boolean and value YOLO flags for Claude', () => {
  const claudeYolo = yoloSpecFor('claude');
  assert.ok(claudeYolo);

  assert.equal(isYolo(['--dangerously-skip-permissions'], claudeYolo), true);
  assert.deepEqual(matchedYoloFlags(['--dangerously-skip-permissions'], claudeYolo), [
    '--dangerously-skip-permissions',
  ]);

  assert.equal(isYolo(['--permission-mode', 'bypassPermissions'], claudeYolo), true);
  assert.deepEqual(matchedYoloFlags(['--permission-mode', 'bypassPermissions'], claudeYolo), [
    '--permission-mode bypassPermissions',
  ]);

  // Non-YOLO permission modes must be false
  assert.equal(isYolo(['--permission-mode', 'dontAsk'], claudeYolo), false);
  assert.equal(isYolo(['--permission-mode', 'acceptEdits'], claudeYolo), false);
  assert.deepEqual(matchedYoloFlags(['--permission-mode', 'dontAsk'], claudeYolo), []);
  assert.equal(isYolo(['--model', 'claude-sonnet-4-6'], claudeYolo), false);
  assert.equal(isYolo([], undefined), false);
});

test('isYolo and matchedYoloFlags recognize Codex YOLO flags and aliases', () => {
  const codexYolo = yoloSpecFor('codex');
  assert.ok(codexYolo);

  assert.equal(isYolo(['--yolo'], codexYolo), true);
  assert.equal(isYolo(['--full-auto'], codexYolo), true);
  assert.equal(isYolo(['--dangerously-bypass-approvals-and-sandbox'], codexYolo), true);
  assert.equal(isYolo(['--sandbox', 'read-only'], codexYolo), false);
  assert.equal(isYolo(['--ask-for-approval', 'never'], codexYolo), false);
});

test('setYolo on/off round trip preserves unrelated flags and handles conflicts', () => {
  const codexYolo = yoloSpecFor('codex');
  assert.ok(codexYolo);

  const initial = [
    '--model',
    'gpt-5',
    '--ask-for-approval',
    'never',
    '--sandbox',
    'workspace-write',
  ];

  // Turning YOLO on removes conflicting --ask-for-approval and appends --yolo
  const yoloOn = setYolo(initial, codexYolo, true);
  assert.deepEqual(yoloOn, [
    '--model',
    'gpt-5',
    '--sandbox',
    'workspace-write',
    '--yolo',
  ]);

  // Turning YOLO off strips --yolo, leaving the surviving flags intact
  const yoloOff = setYolo(yoloOn, codexYolo, false);
  assert.deepEqual(yoloOff, [
    '--model',
    'gpt-5',
    '--sandbox',
    'workspace-write',
  ]);

  // Turning YOLO on again produces canonical yolo.on
  const yoloOnAgain = setYolo(yoloOff, codexYolo, true);
  assert.deepEqual(yoloOnAgain, [
    '--model',
    'gpt-5',
    '--sandbox',
    'workspace-write',
    '--yolo',
  ]);
});

test('setYolo canonicalizes Claude YOLO modes from bypassPermissions to --dangerously-skip-permissions', () => {
  const claudeYolo = yoloSpecFor('claude');
  assert.ok(claudeYolo);

  const initial = ['--model', 'claude-sonnet-4-6', '--permission-mode', 'bypassPermissions'];
  const yoloOn = setYolo(initial, claudeYolo, true);
  assert.deepEqual(yoloOn, [
    '--model',
    'claude-sonnet-4-6',
    '--dangerously-skip-permissions',
  ]);

  const yoloOff = setYolo(yoloOn, claudeYolo, false);
  assert.deepEqual(yoloOff, ['--model', 'claude-sonnet-4-6']);
});

test('hasCoPane detects server:copanel and legacy server:copane', () => {
  assert.equal(
    hasCoPane(['--dangerously-load-development-channels', 'server:copanel']),
    true,
  );
  assert.equal(
    hasCoPane(['--dangerously-load-development-channels', 'server:copane']),
    true,
  );
  assert.equal(
    hasCoPane(['--dangerously-load-development-channels', 'server:other']),
    false,
  );
  assert.equal(hasCoPane(['--model', 'claude-sonnet-4-6']), false);
  assert.equal(hasCoPane([]), false);
});

test('setCoPane on/off round trip removes legacy channel and preserves other --mcp-config entries', () => {
  const copaneConfig = '/path/to/copane.json';
  const userConfig = '/path/to/user-mcp.json';

  // Session has user MCP config and legacy CoPane channel
  const initial = [
    '--model',
    'claude-sonnet-4-6',
    '--mcp-config',
    userConfig,
    '--mcp-config',
    copaneConfig,
    '--dangerously-load-development-channels',
    'server:copane',
  ];

  // Turning CoPane off removes copaneConfig and legacy server:copane, keeping userConfig
  const off = setCoPane(initial, copaneConfig, false);
  assert.deepEqual(off, [
    '--model',
    'claude-sonnet-4-6',
    '--mcp-config',
    userConfig,
  ]);

  // Turning CoPane on adds copaneConfig and modern server:copanel
  const on = setCoPane(off, copaneConfig, true);
  assert.deepEqual(on, [
    '--model',
    'claude-sonnet-4-6',
    '--mcp-config',
    userConfig,
    '--mcp-config',
    copaneConfig,
    '--dangerously-load-development-channels',
    'server:copanel',
  ]);
});

test('withFlags appends single-quoted flags and shields shell metacharacters', () => {
  const spec: FlagSpec = {
    bool: ['--dangerously-skip-permissions'],
    value: {
      '--model': {},
      '--settings': { path: false },
    },
  };

  const extraFlags = [
    '--model',
    'sonnet 3.5 $(id)',
    '--settings',
    "/Users/user's dir/file.json",
    '--dangerously-skip-permissions',
  ];

  const cmd = withFlags('claude --resume 1234', extraFlags, spec);
  assert.equal(
    cmd,
    "claude --resume 1234 '--model' 'sonnet 3.5 $(id)' '--settings' '/Users/user'\\''s dir/file.json' '--dangerously-skip-permissions'",
  );
});

test('withFlags returns original command when extraFlags is empty or undefined', () => {
  assert.equal(withFlags('claude --resume 123', [], CLAUDE_FLAG_SPEC), 'claude --resume 123');
  assert.equal(withFlags('claude --resume 123', undefined, CLAUDE_FLAG_SPEC), 'claude --resume 123');
});
