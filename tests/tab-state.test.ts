import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  shortAge,
  tabStateKind,
  progressFor,
  formatTabState,
  titleSequence,
  progressSequence,
  stateSequence,
  withSequenceFirst,
  PROGRESS,
} from '../src/tab-state';
import type { ClaudeSnapshot } from '../src/claude-tracker';

function makeSnapshot(overrides: Partial<ClaudeSnapshot> = {}): ClaudeSnapshot {
  return {
    state: 'idle',
    messageCount: 1,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0 },
    subagents: [],
    ...overrides,
  };
}

test('shortAge formats durations coarsely with minute granularity', () => {
  assert.equal(shortAge(0), '');
  assert.equal(shortAge(30_000), '');
  assert.equal(shortAge(59_999), '');
  assert.equal(shortAge(60_000), '1m');
  assert.equal(shortAge(119_999), '1m');
  assert.equal(shortAge(59 * 60_000), '59m');
  assert.equal(shortAge(60 * 60_000), '1h');
  assert.equal(shortAge(23 * 3600_000 + 30 * 60_000), '23h');
  assert.equal(shortAge(24 * 3600_000), '1d');
  assert.equal(shortAge(48 * 3600_000), '2d');
});

test('tabStateKind returns none for missing snapshot or inactive states', () => {
  assert.deepEqual(tabStateKind(undefined), { kind: 'none', ageMs: 0 });

  const unstopped = makeSnapshot({ state: 'idle', lastStopAt: undefined });
  assert.deepEqual(tabStateKind(unstopped), { kind: 'none', ageMs: 0 });
});

test('tabStateKind returns working for working or tool states and for idle sessions with running subagents', () => {
  const workingSnap = makeSnapshot({ state: 'working' });
  assert.deepEqual(tabStateKind(workingSnap), { kind: 'working', ageMs: 0 });

  const toolSnap = makeSnapshot({ state: 'tool' });
  assert.deepEqual(tabStateKind(toolSnap), { kind: 'working', ageMs: 0 });

  const idleWithSubagent = makeSnapshot({
    state: 'idle',
    lastStopAt: new Date(Date.now() - 5000),
    subagents: [
      {
        id: 'sa-1',
        depth: 0,
        state: 'working',
        startedAt: new Date(),
        viaDir: true,
      },
    ],
  });
  assert.deepEqual(tabStateKind(idleWithSubagent), { kind: 'working', ageMs: 0 });
});

test('tabStateKind returns waiting with elapsed time when blocked on user input', () => {
  const now = 1_000_000;
  const waitingSnap = makeSnapshot({
    state: 'waiting',
    waitingSince: new Date(now - 120_000),
  });
  assert.deepEqual(tabStateKind(waitingSnap, now), { kind: 'waiting', ageMs: 120_000 });

  const waitingNoDate = makeSnapshot({ state: 'waiting', waitingSince: undefined });
  assert.deepEqual(tabStateKind(waitingNoDate, now), { kind: 'waiting', ageMs: 0 });
});

test('tabStateKind handles relaunched, future, or explicitly cleared sessions', () => {
  const now = 1_000_000;
  const stopAt = new Date(now - 10_000);

  // Relaunched after stop
  const relaunched = makeSnapshot({
    state: 'idle',
    lastStopAt: stopAt,
    lastStartAt: new Date(now - 5_000),
  });
  assert.deepEqual(tabStateKind(relaunched, now), { kind: 'none', ageMs: 0 });

  // Future timestamp
  const futureStop = makeSnapshot({
    state: 'idle',
    lastStopAt: new Date(now + 5_000),
  });
  assert.deepEqual(tabStateKind(futureStop, now), { kind: 'none', ageMs: 0 });

  // Explicitly cleared via tabClearedAt
  const cleared = makeSnapshot({
    state: 'idle',
    lastStopAt: stopAt,
    tabClearedAt: new Date(now - 2_000),
  });
  assert.deepEqual(tabStateKind(cleared, now, 'seen'), { kind: 'none', ageMs: 0 });
  assert.deepEqual(tabStateKind(cleared, now, 'timer'), { kind: 'none', ageMs: 0 });
});

test('tabStateKind under seen clear mode stays until seen or dismissed', () => {
  const now = 1_000_000;
  const stopAt = new Date(now - 3_600_000); // 1 hour ago

  const unseenOk = makeSnapshot({
    state: 'idle',
    lastStopAt: stopAt,
    outcome: { kind: 'ok' },
  });
  // In 'seen' mode, it does NOT clear after 30 minutes; it remains done
  assert.deepEqual(tabStateKind(unseenOk, now, 'seen'), { kind: 'done', ageMs: 3_600_000 });

  const unseenBad = makeSnapshot({
    state: 'idle',
    lastStopAt: stopAt,
    outcome: { kind: 'failed' },
  });
  assert.deepEqual(tabStateKind(unseenBad, now, 'seen'), { kind: 'failed', ageMs: 3_600_000 });

  // Seen after stop clears the state
  const seenAfterStop = makeSnapshot({
    state: 'idle',
    lastStopAt: stopAt,
    tabSeenAt: new Date(now - 1_000),
  });
  assert.deepEqual(tabStateKind(seenAfterStop, now, 'seen'), { kind: 'none', ageMs: 0 });

  // Seen before stop does not clear it
  const seenBeforeStop = makeSnapshot({
    state: 'idle',
    lastStopAt: stopAt,
    tabSeenAt: new Date(now - 4_000_000),
  });
  assert.deepEqual(tabStateKind(seenBeforeStop, now, 'seen'), { kind: 'done', ageMs: 3_600_000 });

  // Dismissed clears the mark
  const dismissed = makeSnapshot({
    state: 'idle',
    lastStopAt: stopAt,
    dismissed: true,
  });
  assert.deepEqual(tabStateKind(dismissed, now, 'seen'), { kind: 'none', ageMs: 0 });
});

test('tabStateKind under timer clear mode clears exactly at and after the timeout boundary', () => {
  const now = 1_000_000;
  const timeoutMs = 300_000; // 5 minutes

  // Exactly at timeout boundary (dt === clearAfterMs): still visible
  const atBoundary = makeSnapshot({
    state: 'idle',
    lastStopAt: new Date(now - timeoutMs),
  });
  assert.deepEqual(tabStateKind(atBoundary, now, 'timer', timeoutMs), {
    kind: 'done',
    ageMs: timeoutMs,
  });

  // 1 millisecond past timeout (dt === clearAfterMs + 1): cleared
  const pastBoundary = makeSnapshot({
    state: 'idle',
    lastStopAt: new Date(now - (timeoutMs + 1)),
  });
  assert.deepEqual(tabStateKind(pastBoundary, now, 'timer', timeoutMs), {
    kind: 'none',
    ageMs: 0,
  });

  // tabSeenAt does NOT clear under timer mode (only expiration or tabClearedAt does)
  const seenDuringTimer = makeSnapshot({
    state: 'idle',
    lastStopAt: new Date(now - 60_000),
    tabSeenAt: new Date(now - 10_000),
  });
  assert.deepEqual(tabStateKind(seenDuringTimer, now, 'timer', timeoutMs), {
    kind: 'done',
    ageMs: 60_000,
  });
});

test('progressFor maps each state to its OSC 9;4 progress code', () => {
  assert.equal(progressFor('working'), PROGRESS.spin); // 3
  assert.equal(progressFor('waiting'), PROGRESS.error); // 2
  assert.equal(progressFor('done'), PROGRESS.error); // 2
  assert.equal(progressFor('failed'), PROGRESS.error); // 2
  assert.equal(progressFor('none'), PROGRESS.clear); // 0
});

test('formatTabState renders appropriate symbols and ages across all styles', () => {
  const now = 1_000_000;
  const snapDone5m = makeSnapshot({
    state: 'idle',
    lastStopAt: new Date(now - 300_000),
  });
  const snapDoneFresh = makeSnapshot({
    state: 'idle',
    lastStopAt: new Date(now - 30_000),
  });
  const snapWorking = makeSnapshot({
    state: 'working',
  });
  const snapWaiting = makeSnapshot({
    state: 'waiting',
    waitingSince: new Date(now - 120_000),
  });
  const snapFailed = makeSnapshot({
    state: 'idle',
    lastStopAt: new Date(now - 60_000),
    outcome: { kind: 'failed' },
  });

  // blue style (default)
  assert.equal(formatTabState(snapDone5m, now, 'blue'), '🟢 5m');
  assert.equal(formatTabState(snapDoneFresh, now, 'blue'), '🟢');
  assert.equal(formatTabState(snapWorking, now, 'blue'), '🔵');
  assert.equal(formatTabState(snapWaiting, now, 'blue'), '🟢 2m');
  assert.equal(formatTabState(snapFailed, now, 'blue'), '🟢 1m');

  // dark style
  assert.equal(formatTabState(snapWorking, now, 'dark'), '⚫');
  assert.equal(formatTabState(snapDone5m, now, 'dark'), '🟢 5m');

  // glyphs style
  assert.equal(formatTabState(snapWorking, now, 'glyphs'), '⟳');
  assert.equal(formatTabState(snapWaiting, now, 'glyphs'), '⚠ 2m');
  assert.equal(formatTabState(snapDone5m, now, 'glyphs'), '✓ 5m');
  assert.equal(formatTabState(snapFailed, now, 'glyphs'), '✗ 1m');

  // words style
  assert.equal(formatTabState(snapWorking, now, 'words'), 'running');
  assert.equal(formatTabState(snapWaiting, now, 'words'), 'needs you 2m');
  assert.equal(formatTabState(snapDone5m, now, 'words'), 'done 5m');
  assert.equal(formatTabState(snapFailed, now, 'words'), 'failed 1m');

  // none returns empty string
  assert.equal(formatTabState(undefined, now), '');
});

test('titleSequence generates OSC 2 inside tmux passthrough, truncates to 24 chars, and strips controls', () => {
  const basic = titleSequence('🟢 5m');
  assert.equal(basic, '\x1bPtmux;\x1b\x1b]2;🟢 5m\x07\x1b\\');

  // Blank/empty text defaults to a single space to preserve VS Code tab label
  const empty = titleSequence('');
  assert.equal(empty, '\x1bPtmux;\x1b\x1b]2; \x07\x1b\\');

  // Long text truncated to 24 chars
  const longText = '123456789012345678901234567890';
  assert.equal(titleSequence(longText), '\x1bPtmux;\x1b\x1b]2;123456789012345678901234\x07\x1b\\');

  // Control characters stripped (e.g. \x07, \x1b, \n, \x7f)
  const withControls = 'hello\x07\x1b\n\x7fworld';
  assert.equal(titleSequence(withControls), '\x1bPtmux;\x1b\x1b]2;helloworld\x07\x1b\\');
});

test('progressSequence generates OSC 9;4 progress escape inside tmux passthrough', () => {
  assert.equal(progressSequence(PROGRESS.spin), '\x1bPtmux;\x1b\x1b]9;4;3;0\x07\x1b\\');
  assert.equal(progressSequence(PROGRESS.error), '\x1bPtmux;\x1b\x1b]9;4;2;0\x07\x1b\\');
  assert.equal(progressSequence(PROGRESS.clear), '\x1bPtmux;\x1b\x1b]9;4;0;0\x07\x1b\\');
});

test('stateSequence concatenates progress and title sequences', () => {
  const seq = stateSequence('done', PROGRESS.error);
  assert.equal(seq, progressSequence(PROGRESS.error) + titleSequence('done'));
});

test('withSequenceFirst places ${progress} in front and removes ${sequence} or misplaced progress', () => {
  assert.equal(withSequenceFirst('${cwdFolder}'), '${progress} ${cwdFolder}');
  assert.equal(withSequenceFirst('${cwdFolder} ${sequence}'), '${progress} ${cwdFolder}');
  assert.equal(withSequenceFirst('${sequence} ${cwdFolder}'), '${progress} ${cwdFolder}');
  assert.equal(withSequenceFirst('${progress} ${cwdFolder}'), '${progress} ${cwdFolder}');
  assert.equal(withSequenceFirst('${cwdFolder} ${progress}'), '${progress} ${cwdFolder}');
  assert.equal(withSequenceFirst('${sequence}'), '${progress}');
  assert.equal(withSequenceFirst('${progress}'), '${progress}');
  assert.equal(withSequenceFirst(''), '${progress}');
  assert.equal(withSequenceFirst('   '), '${progress}');
});
