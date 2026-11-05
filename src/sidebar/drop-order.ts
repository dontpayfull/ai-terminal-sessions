// Ordering rules for drag and drop in the sidebar, kept free of the vscode
// API so they can be tested on their own.

/** Where dragged rows land: an index into the rows that stay put, given the
 *  container's rows in order (`key`, and `setId` for a fork). */
export function dropInsertIndex(
  children: ReadonlyArray<{ key: string; setId?: string }>,
  dragged: ReadonlySet<string>,
  targetKey: string | undefined,
  targetSetId: string | undefined,
  /** Dragged rows that were in this container before the drop; the default
   *  is all of them. Rows moved in from elsewhere carry sort numbers from
   *  their old container, so they cannot tell up from down. */
  stayed?: ReadonlySet<string>,
): number {
  const firstDragged = children.findIndex(c => dragged.has(c.key) && (!stayed || stayed.has(c.key)));
  /** How many of the rows staying put sit before position `at`. */
  const restBefore = (at: number): number => children.slice(0, at).filter(c => !dragged.has(c.key)).length;
  const restCount = restBefore(children.length);
  // A fork cluster shows as one row. Rows from outside it, dropped on it or
  // on one of its forks, go before or after the whole set, never between
  // its forks (the cluster would hide them there).
  const setIdx = targetSetId ? children.flatMap((c, i) => (c.setId === targetSetId ? [i] : [])) : [];
  const setKeys = new Set(setIdx.map(i => children[i].key));
  if (setIdx.length >= 2 && [...dragged].some(k => !setKeys.has(k))) {
    const down = firstDragged >= 0 && firstDragged < setIdx[0];
    return down ? restBefore(setIdx[setIdx.length - 1] + 1) : restBefore(setIdx[0]);
  }
  // Dropping INTO a master: the master is not a row of the container, so
  // the dragged rows go at the end.
  const t = targetKey ? children.findIndex(c => c.key === targetKey) : -1;
  if (t < 0) return restCount;
  // Dropped on itself (a cluster on its own row or on its forks): no move,
  // the block stays where the target row is.
  if (dragged.has(targetKey!)) return restBefore(t);
  const down = firstDragged >= 0 && firstDragged < t;
  return restBefore(t) + (down ? 1 : 0);
}

/** Drag entries once each, first one kept: a fork cluster selected together
 *  with one of its forks names that fork twice. */
export function uniqueDragEntries<T extends { kind: string; hash: string; name?: string; groupId?: string; tagId?: string; sepId?: string }>(list: readonly T[]): T[] {
  const seen = new Set<string>();
  return list.filter(p => {
    const k = `${p.kind}\u0000${p.hash}\u0000${p.name ?? ''}\u0000${p.groupId ?? ''}\u0000${p.tagId ?? ''}\u0000${p.sepId ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The dragged keys in pick order, plus the forks of each dragged set that
 *  already sit in this container (`children`), placed in front of their set
 *  in container order. Forks of the target's own set stay put: that is a
 *  reorder inside the cluster. */
export function withSetMates(
  children: ReadonlyArray<{ key: string; setId?: string }>,
  picked: readonly string[],
  targetSetId: string | undefined,
): string[] {
  const setOf = new Map(children.map(c => [c.key, c.setId]));
  const pickedSet = new Set(picked);
  const out = [...new Set(picked)];
  const sets = new Set(out.map(k => setOf.get(k)).filter((id): id is string => !!id && id !== targetSetId));
  for (const id of sets) {
    const mates = children.filter(c => c.setId === id && !pickedSet.has(c.key)).map(c => c.key);
    if (mates.length === 0) continue;
    const at = out.findIndex(k => setOf.get(k) === id);
    out.splice(at, 0, ...mates);
  }
  return out;
}
