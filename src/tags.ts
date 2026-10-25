// Session tags: named sets of sessions that start and stop together. A session
// can carry any number of tags (SessionLabel.tags holds their ids). Each tag
// keeps the order its tabs open in, separators included, because the API
// cannot read the order of the tab list itself. Pure helpers only: the index
// stores tags (session-manager.ts) and tag-commands.ts acts on them.

/** One slot of a tag's tab order: a session (tmux name) or a separator.
 *  A separator carries an id of its own: two can share a label, and a
 *  drag or a removal must name the one the user pointed at. */
export type TagLayoutItem = { session: string } | { separator: string; id: string };

export function newSeparatorId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export interface TagDef {
  name: string;
  /** Tab order for Start All. Members it does not list come after the rest;
   *  entries for sessions that no longer carry the tag are skipped. */
  layout?: TagLayoutItem[];
}

/** A tag's rows as shown and started: a member session or a separator. */
export type TagEntry<S> = { session: S } | { separator: string; id: string };

export const TAG_NAME_MAX = 40;

/** A typed tag name made uniform: no leading `#` (the sidebar adds it),
 *  inner whitespace joined with `-`. Empty when nothing usable is left. */
export function cleanTagName(raw: string): string {
  return raw.trim().replace(/^#+/, '').trim().replace(/\s+/g, '-').slice(0, TAG_NAME_MAX);
}

/** The tag's rows in order: its layout first, then every member the layout
 *  does not list yet (newly tagged sessions), in the order given. */
export function tagEntries<S extends { name: string }>(
  layout: readonly TagLayoutItem[] | undefined,
  members: readonly S[],
): TagEntry<S>[] {
  const byName = new Map(members.map(m => [m.name, m]));
  const seen = new Set<string>();
  const out: TagEntry<S>[] = [];
  for (const it of layout ?? []) {
    if ('separator' in it) { out.push({ separator: it.separator, id: it.id }); continue; }
    const s = byName.get(it.session);
    if (!s || seen.has(s.name)) continue;
    seen.add(s.name);
    out.push({ session: s });
  }
  for (const m of members) {
    if (!seen.has(m.name)) { seen.add(m.name); out.push({ session: m }); }
  }
  return out;
}

export function toLayout(entries: readonly TagEntry<{ name: string }>[]): TagLayoutItem[] {
  return entries.map(e => ('separator' in e ? { separator: e.separator, id: e.id } : { session: e.session.name }));
}

/** Drops separators that head no session (another separator or the end
 *  follows them) and repeated sessions. */
export function trimLayout(layout: readonly TagLayoutItem[]): TagLayoutItem[] {
  const out: TagLayoutItem[] = [];
  const seen = new Set<string>();
  let pending: TagLayoutItem | undefined;
  for (const it of layout) {
    if ('separator' in it) { pending = it; continue; }
    if (seen.has(it.session)) continue;
    seen.add(it.session);
    if (pending) { out.push(pending); pending = undefined; }
    out.push({ session: it.session });
  }
  return out;
}

/** Key of a layout slot for a move: `s:<session>` or `p:<separator id>`. */
export function layoutKey(it: TagLayoutItem): string {
  return 'separator' in it ? `p:${it.id}` : `s:${it.session}`;
}

/** Moves the slots named by `moving` (keys from layoutKey) in front of the
 *  slot `before`, keeping their order. When `before` is itself moving, the
 *  first slot after it that stays is the anchor; with none (or no `before`)
 *  they go to the end. Sessions not yet in the layout (`s:<name>` keys that
 *  match nothing) are inserted as new slots. */
export function moveInLayout(
  layout: readonly TagLayoutItem[],
  moving: readonly string[],
  before?: string,
): TagLayoutItem[] {
  const want = new Set(moving);
  const moved: TagLayoutItem[] = [];
  const kept: Array<{ key: string; item: TagLayoutItem }> = [];
  const all = new Set(moving);
  let anchor = before;
  if (anchor !== undefined && all.has(anchor)) {
    const from = layout.findIndex(it => layoutKey(it) === anchor);
    anchor = from < 0 ? undefined
      : layout.slice(from + 1).map(layoutKey).find(k => !all.has(k));
  }
  for (const item of layout) {
    const key = layoutKey(item);
    if (want.has(key)) { moved.push(item); want.delete(key); } else kept.push({ key, item });
  }
  for (const key of moving) {
    if (want.has(key) && key.startsWith('s:')) moved.push({ session: key.slice(2) });
  }
  const at = anchor === undefined ? -1 : kept.findIndex(k => k.key === anchor);
  const items = kept.map(k => k.item);
  if (at < 0) return [...items, ...moved];
  return [...items.slice(0, at), ...moved, ...items.slice(at)];
}

/** What Start All has to do for one member. `none`: running with its tab
 *  open; `inPlace`: stopped with its tab kept, Start reuses that tab;
 *  `newTab`: needs a tab (stopped, or running in the background). */
export type MemberAction = 'none' | 'inPlace' | 'newTab';

export type StartStep = { separator: string } | { session: string };

/** Start All's steps, in tag order. A separator opens just before the first
 *  session of its section that gets a new tab (new tabs land at the end of
 *  the list, so the section reads right). `openSeparators` counts the open
 *  separator tabs by label: each one stands in for one section of the tag
 *  with that label, so it is not opened twice, while a second section that
 *  reuses the label still gets its own. */
export function startPlan(
  entries: readonly TagEntry<{ name: string; action: MemberAction }>[],
  openSeparators: ReadonlyMap<string, number>,
): StartStep[] {
  const open = new Map(openSeparators);
  const steps: StartStep[] = [];
  let pending: string | undefined;
  for (const e of entries) {
    if ('separator' in e) { pending = e.separator; continue; }
    const { name, action } = e.session;
    if (action === 'none') continue;
    if (action === 'newTab' && pending !== undefined) {
      const n = open.get(pending) ?? 0;
      if (n > 0) open.set(pending, n - 1);
      else steps.push({ separator: pending });
      pending = undefined;
    }
    steps.push({ session: name });
  }
  return steps;
}
