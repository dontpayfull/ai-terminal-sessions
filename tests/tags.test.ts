import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  TagLayoutItem, cleanTagName, tagEntries, toLayout, trimLayout, moveInLayout, layoutKey, startPlan, MemberAction,
} from '../src/tags';

const s = (name: string): { name: string } => ({ name });

test('cleanTagName drops the leading # and joins words', () => {
  assert.equal(cleanTagName('  #DPF proxy  work '), 'DPF-proxy-work');
  assert.equal(cleanTagName('###'), '');
  assert.equal(cleanTagName('x'.repeat(60)).length, 40);
});

test('tagEntries follows the layout, skips untagged entries, appends new members', () => {
  const layout: TagLayoutItem[] = [{ separator: 'A' }, { session: 'b' }, { session: 'gone' }, { session: 'a' }];
  const entries = tagEntries(layout, [s('a'), s('b'), s('c')]);
  assert.deepEqual(toLayout(entries), [
    { separator: 'A' }, { session: 'b' }, { session: 'a' }, { session: 'c' },
  ]);
});

test('trimLayout drops separators that head nothing and repeated sessions', () => {
  assert.deepEqual(trimLayout([
    { separator: 'empty' }, { separator: 'A' }, { session: 'a' }, { session: 'a' }, { separator: 'end' },
  ]), [{ separator: 'A' }, { session: 'a' }]);
});

test('moveInLayout moves sessions and separators in front of a slot, or to the end', () => {
  const layout: TagLayoutItem[] = [{ session: 'a' }, { separator: 'S' }, { session: 'b' }, { session: 'c' }];
  assert.equal(layoutKey(layout, 1), 'p:1');
  assert.deepEqual(moveInLayout(layout, ['s:c'], 'p:1'), [
    { session: 'a' }, { session: 'c' }, { separator: 'S' }, { session: 'b' },
  ]);
  assert.deepEqual(moveInLayout(layout, ['p:1'], undefined), [
    { session: 'a' }, { session: 'b' }, { session: 'c' }, { separator: 'S' },
  ]);
  // A session that is not in the layout yet becomes a new slot.
  assert.deepEqual(moveInLayout(layout, ['s:new'], 's:b'), [
    { session: 'a' }, { separator: 'S' }, { session: 'new' }, { session: 'b' }, { session: 'c' },
  ]);
});

test('startPlan opens a separator before the first new tab of its section only', () => {
  const m = (name: string, action: MemberAction) => ({ session: { name, action } });
  const entries = [
    { separator: 'One' }, m('a', 'none'), m('b', 'newTab'), m('c', 'newTab'),
    { separator: 'Two' }, m('d', 'inPlace'),
    { separator: 'Three' }, m('e', 'newTab'),
  ];
  assert.deepEqual(startPlan(entries, new Set()), [
    { separator: 'One' }, { session: 'b' }, { session: 'c' },
    { session: 'd' },
    { separator: 'Three' }, { session: 'e' },
  ]);
  // A separator already open is not opened twice.
  assert.deepEqual(startPlan(entries, new Set(['One', 'Three'])), [
    { session: 'b' }, { session: 'c' }, { session: 'd' }, { session: 'e' },
  ]);
});
