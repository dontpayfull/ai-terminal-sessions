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

const sep = (label: string, id = label): TagLayoutItem => ({ separator: label, id });

test('tagEntries follows the layout, skips untagged entries, appends new members', () => {
  const layout: TagLayoutItem[] = [sep('A'), { session: 'b' }, { session: 'gone' }, { session: 'a' }];
  const entries = tagEntries(layout, [s('a'), s('b'), s('c')]);
  assert.deepEqual(toLayout(entries), [
    sep('A'), { session: 'b' }, { session: 'a' }, { session: 'c' },
  ]);
});

test('trimLayout drops separators that head nothing and repeated sessions', () => {
  assert.deepEqual(trimLayout([
    sep('empty'), sep('A'), { session: 'a' }, { session: 'a' }, sep('end'),
  ]), [sep('A'), { session: 'a' }]);
});

test('moveInLayout moves sessions and separators in front of a slot, or to the end', () => {
  const layout: TagLayoutItem[] = [{ session: 'a' }, sep('S', 'x1'), { session: 'b' }, { session: 'c' }];
  assert.equal(layoutKey(layout[1]), 'p:x1');
  assert.deepEqual(moveInLayout(layout, ['s:c'], 'p:x1'), [
    { session: 'a' }, { session: 'c' }, sep('S', 'x1'), { session: 'b' },
  ]);
  assert.deepEqual(moveInLayout(layout, ['p:x1'], undefined), [
    { session: 'a' }, { session: 'b' }, { session: 'c' }, sep('S', 'x1'),
  ]);
  // A session that is not in the layout yet becomes a new slot.
  assert.deepEqual(moveInLayout(layout, ['s:new'], 's:b'), [
    { session: 'a' }, sep('S', 'x1'), { session: 'new' }, { session: 'b' }, { session: 'c' },
  ]);
});

test('moveInLayout anchors past a target that is itself moving', () => {
  const layout: TagLayoutItem[] = ['a', 'b', 'c', 'd', 'e'].map(n => ({ session: n }));
  // A and C dropped below B: the anchor C moves too, so D is the anchor.
  assert.deepEqual(moveInLayout(layout, ['s:a', 's:c'], 's:c').map(i => ('session' in i ? i.session : '')),
    ['b', 'a', 'c', 'd', 'e']);
});

test('startPlan opens a separator before the first new tab of its section only', () => {
  const m = (name: string, action: MemberAction) => ({ session: { name, action } });
  const entries = [
    { separator: 'One', id: '1' }, m('a', 'none'), m('b', 'newTab'), m('c', 'newTab'),
    { separator: 'Two', id: '2' }, m('d', 'inPlace'),
    { separator: 'Three', id: '3' }, m('e', 'newTab'),
  ];
  assert.deepEqual(startPlan(entries, new Map()), [
    { separator: 'One' }, { session: 'b' }, { session: 'c' },
    { session: 'd' },
    { separator: 'Three' }, { session: 'e' },
  ]);
  // A separator already open is not opened twice.
  assert.deepEqual(startPlan(entries, new Map([['One', 1], ['Three', 1]])), [
    { session: 'b' }, { session: 'c' }, { session: 'd' }, { session: 'e' },
  ]);
});

test('startPlan opens a second section that reuses an open label', () => {
  const m = (name: string) => ({ session: { name, action: 'newTab' as MemberAction } });
  const entries = [{ separator: 'R', id: '1' }, m('a'), { separator: 'R', id: '2' }, m('b')];
  assert.deepEqual(startPlan(entries, new Map([['R', 1]])), [
    { session: 'a' }, { separator: 'R' }, { session: 'b' },
  ]);
});
