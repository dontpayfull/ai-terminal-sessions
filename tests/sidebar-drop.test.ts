import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { dropInsertIndex, uniqueDragEntries, withSetMates } from '../src/sidebar/drop-order';

// Container rows: S1, cluster [F1, F2], S2, S3.
const rows = [
  { key: 's:S1' },
  { key: 's:F1', setId: 'set' },
  { key: 's:F2', setId: 'set' },
  { key: 's:S2' },
  { key: 's:S3' },
];
/** The order after the drop, as handleDrop builds it. */
function apply(dragged: string[], targetKey: string | undefined, targetSetId?: string): string[] {
  const set = new Set(dragged);
  const rest = rows.map(r => r.key).filter(k => !set.has(k));
  const at = dropInsertIndex(rows, set, targetKey, targetSetId);
  return [...rest.slice(0, at), ...dragged, ...rest.slice(at)];
}

test('a cluster dropped on its own row does not move', () => {
  assert.deepEqual(apply(['s:F1', 's:F2'], 's:F1', 'set'), ['s:S1', 's:F1', 's:F2', 's:S2', 's:S3']);
});

test('a cluster dropped on one of its own forks does not move', () => {
  assert.deepEqual(apply(['s:F1', 's:F2'], 's:F2', 'set'), ['s:S1', 's:F1', 's:F2', 's:S2', 's:S3']);
});

test('a cluster dropped down on a session goes after it', () => {
  assert.deepEqual(apply(['s:F1', 's:F2'], 's:S2'), ['s:S1', 's:S2', 's:F1', 's:F2', 's:S3']);
});

test('a cluster dropped up on a session goes before it', () => {
  assert.deepEqual(apply(['s:F1', 's:F2'], 's:S1'), ['s:F1', 's:F2', 's:S1', 's:S2', 's:S3']);
});

test('a session dragged down onto a cluster goes after the whole set', () => {
  assert.deepEqual(apply(['s:S1'], 's:F1', 'set'), ['s:F1', 's:F2', 's:S1', 's:S2', 's:S3']);
});

test('a session dragged up onto a fork goes before the whole set', () => {
  assert.deepEqual(apply(['s:S3'], 's:F2', 'set'), ['s:S1', 's:S3', 's:F1', 's:F2', 's:S2']);
});

test('forks reorder among themselves', () => {
  assert.deepEqual(apply(['s:F2'], 's:F1', 'set'), ['s:S1', 's:F2', 's:F1', 's:S2', 's:S3']);
});

test('a session dropped on itself does not move', () => {
  assert.deepEqual(apply(['s:S2'], 's:S2'), ['s:S1', 's:F1', 's:F2', 's:S2', 's:S3']);
});

test('no target row (drop into a master) appends', () => {
  assert.deepEqual(apply(['s:S1'], 'g:master'), ['s:F1', 's:F2', 's:S2', 's:S3', 's:S1']);
});

test('a cluster selected with one of its forks drags each fork once, in order', () => {
  const raw = [
    { kind: 'session', hash: 'h', name: 'F1' },
    { kind: 'session', hash: 'h', name: 'F2' },
    { kind: 'session', hash: 'h', name: 'F1' },
  ];
  assert.deepEqual(uniqueDragEntries(raw).map(r => r.name), ['F1', 'F2']);
});

test('rows moved in from another container land before the target, whatever their old sort numbers', () => {
  // A1 and A2 come from another group; their old numbers interleave them.
  const merged = [
    { key: 's:A1', setId: 'a' },
    { key: 's:B1', setId: 'b' },
    { key: 's:A2', setId: 'a' },
    { key: 's:B2', setId: 'b' },
  ];
  const dragged = new Set(['s:A1', 's:A2']);
  assert.equal(dropInsertIndex(merged, dragged, 's:B1', 'b', new Set()), 0);
  const swapped = [merged[1], merged[0], merged[3], merged[2]];
  assert.equal(dropInsertIndex(swapped, dragged, 's:B1', 'b', new Set()), 0);
});

test('a cluster with a hidden fork sorted above a foreign row stays put when dropped on itself', () => {
  // Saved order: A0 (hidden by the filter), X, A1, A2; shown: X, cluster at A1.
  const list = [
    { key: 's:A0', setId: 'a' },
    { key: 's:X' },
    { key: 's:A1', setId: 'a' },
    { key: 's:A2', setId: 'a' },
  ];
  const dragged = new Set(['s:A0', 's:A1', 's:A2']);
  assert.equal(dropInsertIndex(list, dragged, 's:A1', 'a'), 1); // after X
});

test('forks of a dragged set already in the container move with it', () => {
  const list = [
    { key: 's:B1', setId: 'b' },
    { key: 's:S' },
    { key: 's:B2', setId: 'b' },
    { key: 's:B3', setId: 'b' },
  ];
  assert.deepEqual(withSetMates(list, ['s:B2', 's:B3'], undefined), ['s:B1', 's:B2', 's:B3']);
  // Reordering inside the target's own cluster leaves the others alone.
  assert.deepEqual(withSetMates(list, ['s:B3'], 'b'), ['s:B3']);
});
