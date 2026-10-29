import * as vscode from 'vscode';
import { COMMAND, getConfig } from './config';
import * as tmux from './tmux';
import { SessionIndex, enrichSessions } from './session-manager';
import { SessionInfo } from './types';
import { refreshSidebar } from './sidebar/tree-provider';
import { SessionTreeItem } from './sidebar/items';
import { TagTreeItem, TagSeparatorItem } from './sidebar/tag-items';
import { findVerifiedTabForSession, resolveTmuxNameForTerminalLive, sessionNameForTerminal } from './profile-provider';
import { currentWorkspace, parseSessionName } from './workspace-id';
import { separatorOf, separatorSpec, openSeparator, isSeparator, askSeparator } from './separator';
import { readTabOrder } from './tab-order';
import {
  TagLayoutItem, MemberAction, cleanTagName, tagEntries, toLayout, trimLayout, startPlan, newSeparatorId,
} from './tags';

/** Start All and Stop All ask first above this many sessions. */
const CONFIRM_ABOVE = 3;

type Invocation = (item?: SessionTreeItem | vscode.Terminal, selection?: vscode.TreeItem[]) => unknown;

/** What the tag commands borrow from commands.ts. */
export interface TagCommandDeps {
  start(name: string): Promise<void>;
  stop(session: SessionInfo): Promise<void>;
  /** The sessions a row or tab menu invocation names (a multi-selection too). */
  targets(item?: SessionTreeItem | vscode.Terminal, selection?: vscode.TreeItem[]): Promise<SessionInfo[]>;
  /** Registers a command that also takes a multi-selection of terminal tabs. */
  registerTabBulk(id: string, run: Invocation): vscode.Disposable;
}

export function registerTagCommands(index: SessionIndex, deps: TagCommandDeps): vscode.Disposable[] {
  return [
    deps.registerTabBulk(COMMAND.tagSessions, async (item, selection) => cmdTag(index, await deps.targets(item, selection))),
    vscode.commands.registerCommand(COMMAND.saveOpenAsTag, () => cmdSaveOpenAsTag(index)),
    vscode.commands.registerCommand(COMMAND.startTag, (item?: TagTreeItem) => cmdStartTag(index, deps, item)),
    vscode.commands.registerCommand(COMMAND.stopTag, (item?: TagTreeItem) => cmdStopTag(index, deps, item)),
    vscode.commands.registerCommand(COMMAND.renameTag, (item?: TagTreeItem) => cmdRenameTag(index, item)),
    vscode.commands.registerCommand(COMMAND.deleteTag, (item?: TagTreeItem) => cmdDeleteTag(index, item)),
    vscode.commands.registerCommand(COMMAND.addTagSeparator, (item?: TagTreeItem) => cmdAddTagSeparator(index, item)),
    vscode.commands.registerCommand(COMMAND.removeTagSeparator, (item?: TagSeparatorItem) => cmdRemoveTagSeparator(index, item)),
  ];
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Separator tabs this window opened or saved for a tag. Stop All closes
 *  only these: a tab with the same label may head someone else's section.
 *  Lost on a reload, when a restored separator simply stays open. */
const ownedSeparators = new Map<string, Set<vscode.Terminal>>();

function own(tagId: string, tabs: readonly vscode.Terminal[]): void {
  if (tabs.length === 0) return;
  const set = ownedSeparators.get(tagId) ?? new Set<vscode.Terminal>();
  for (const t of tabs) set.add(t);
  ownedSeparators.set(tagId, set);
}

async function allSessions(index: SessionIndex): Promise<SessionInfo[]> {
  const cfg = getConfig();
  const tmuxPath = await tmux.detectTmuxPath(cfg.tmuxPath);
  return tmuxPath ? enrichSessions(tmuxPath, cfg.sessionPrefix, index) : [];
}

/** The tag's live members, of one workspace when `hash` is set. */
function membersOf(index: SessionIndex, tagId: string, all: SessionInfo[], hash?: string): SessionInfo[] {
  return all.filter(s => (!hash || s.workspaceHash === hash)
    && index.getSessionMeta(s.workspaceHash, s.name)?.tags?.includes(tagId));
}

/** The tag's whole order to write back: every live member placed, and the
 *  killed ones keep their slots for a Restore. */
function fullLayout(index: SessionIndex, tagId: string, all: SessionInfo[]): TagLayoutItem[] {
  const members: Array<{ name: string }> = [
    ...membersOf(index, tagId, all),
    ...index.killedTagMembers(tagId).map(name => ({ name })),
  ];
  return toLayout(tagEntries(index.getTags()[tagId]?.layout, members));
}

/** The tag's name, or undefined when another window deleted it meanwhile. */
function tagName(index: SessionIndex, id: string): string | undefined {
  return index.getTags()[id]?.name;
}

function gone(): void {
  vscode.window.showInformationMessage('That tag no longer exists (deleted in another window?).');
  refreshSidebar();
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The workspace a tag command acts in: the tag row's own, else (palette)
 *  this window's, else every workspace. */
function scopeOf(item: TagTreeItem | undefined): string | undefined {
  return item?.workspaceHash ?? currentWorkspace()?.hash;
}

/** The tag a menu row names, or one picked from the list. */
async function resolveTag(
  index: SessionIndex,
  item: TagTreeItem | undefined,
  all: SessionInfo[],
  placeHolder: string,
): Promise<string | undefined> {
  if (item?.tag?.id) return index.getTags()[item.tag.id] ? item.tag.id : undefined;
  index.pruneUnusedTags();
  const hash = scopeOf(item);
  interface Pick extends vscode.QuickPickItem { id: string }
  const picks: Pick[] = Object.entries(index.getTags())
    .map(([id, t]) => {
      const members = membersOf(index, id, all, hash);
      const stopped = members.filter(s => s.stopped).length;
      return {
        id,
        label: `$(tag) #${t.name}`,
        description: `${plural(members.length, 'session')} · ${stopped} stopped`,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  if (picks.length === 0) {
    vscode.window.showInformationMessage('No tags yet. Select sessions or tabs, right-click → Tag…, or use Save Open Tabs as Tag.');
    return undefined;
  }
  return (await vscode.window.showQuickPick(picks, { placeHolder }))?.id;
}

function validateName(index: SessionIndex, exceptId?: string) {
  return (v: string): string | undefined => {
    const name = cleanTagName(v);
    if (!name) return 'Type a name.';
    const clash = Object.entries(index.getTags()).find(([id, t]) => id !== exceptId && t.name.toLowerCase() === name.toLowerCase());
    return clash && exceptId ? `#${clash[1].name} already exists.` : undefined;
  };
}

// ── Tag… ───────────────────────────────────────────────────────────────────

/** One picker that adds and removes. A tag every target has starts checked
 *  (uncheck to remove it); one only some have says so, and checking then
 *  unchecking it removes it from all. Typing filters; when nothing matches,
 *  the text becomes a new tag, checked for Enter. */
async function cmdTag(index: SessionIndex, targets: SessionInfo[]): Promise<void> {
  if (targets.length === 0) {
    vscode.window.showErrorMessage('Use the menu of a session row or a session tab.');
    return;
  }
  index.pruneUnusedTags();
  interface Item extends vscode.QuickPickItem { id?: string; create?: string }
  const metaTags = targets.map(s => index.getSessionMeta(s.workspaceHash, s.name)?.tags ?? []);
  const existing: Item[] = Object.entries(index.getTags())
    .map(([id, t]) => {
      const n = metaTags.filter(ts => ts.includes(id)).length;
      return {
        id,
        label: `$(tag) #${t.name}`,
        description: n > 0 && n < targets.length ? `on ${n} of ${targets.length}` : undefined,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  const initially = new Set(existing.filter(i => metaTags.every(ts => ts.includes(i.id!))).map(i => i.id!));
  const partial = new Set(existing.filter(i => i.description).map(i => i.id!));

  const qp = vscode.window.createQuickPick<Item>();
  qp.canSelectMany = true;
  qp.title = targets.length === 1
    ? `Tag "${targets[0].label || targets[0].name}"`
    : `Tag ${targets.length} sessions`;
  qp.placeholder = 'Check tags, or type a new name and press Enter';
  const checked = new Set(initially);
  const touched = new Set<string>();
  let createItem: Item | undefined;
  let createPicked = false;
  let createDeclined = false;
  const render = (): void => {
    const name = cleanTagName(qp.value);
    const lower = name.toLowerCase();
    const exact = existing.some(i => i.label.toLowerCase() === `$(tag) #${lower}`);
    // Typing that still matches a tag is a search: offer the new name, unchecked.
    const matches = lower !== '' && existing.some(i => i.label.toLowerCase().includes(lower));
    createItem = name && !exact ? { label: `$(add) Create #${name}`, create: name, alwaysShow: true } : undefined;
    if (!name) createDeclined = false;
    qp.items = createItem ? [createItem, ...existing] : existing;
    createPicked = Boolean(createItem && !matches && !createDeclined);
    qp.selectedItems = [...(createPicked ? [createItem!] : []), ...existing.filter(i => checked.has(i.id!))];
  };
  qp.onDidChangeValue(render);
  qp.onDidChangeSelection(sel => {
    // Only an uncheck of the row we checked is a "no": the events that echo
    // our own selection carry it as it was set.
    if (createItem && createPicked && !sel.includes(createItem)) { createDeclined = true; createPicked = false; }
    for (const i of existing) {
      const on = sel.includes(i);
      if (on !== checked.has(i.id!)) touched.add(i.id!);
      if (on) checked.add(i.id!);
      else checked.delete(i.id!);
    }
  });
  render();
  const accepted = await new Promise<readonly Item[] | undefined>(resolve => {
    qp.onDidAccept(() => {
      // Typing a tag's exact name and pressing Enter means that tag.
      const exact = existing.find(i => i.label.toLowerCase() === `$(tag) #${cleanTagName(qp.value).toLowerCase()}`);
      if (exact && !touched.has(exact.id!)) checked.add(exact.id!);
      resolve(qp.selectedItems);
      qp.hide();
    });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (!accepted) return;

  const refs = targets.map(s => ({ hash: s.workspaceHash, name: s.name }));
  const added: string[] = [];
  const removed: string[] = [];
  const createName = accepted.find(i => i.create)?.create;
  if (createName) {
    index.setSessionsTagged(refs, index.ensureTag(createName), true);
    added.push(createName);
  }
  for (const i of existing) {
    const id = i.id!;
    const name = tagName(index, id);
    if (name === undefined) continue;
    if (checked.has(id) && !initially.has(id)) {
      index.setSessionsTagged(refs, id, true);
      added.push(name);
    } else if (!checked.has(id) && (initially.has(id) || (partial.has(id) && touched.has(id)))) {
      index.setSessionsTagged(refs, id, false);
      removed.push(name);
    }
  }
  refreshSidebar();
  const parts = [
    added.length ? `added ${added.map(n => `#${n}`).join(' ')}` : '',
    removed.length ? `removed ${removed.map(n => `#${n}`).join(' ')}` : '',
  ].filter(Boolean);
  if (parts.length) vscode.window.setStatusBarMessage(`Tags: ${parts.join(', ')}`, 3000);
}

// ── Save Open Tabs as Tag… ──────────────────────────────────────────────────

/** The open tabs in tab-list order: session tabs and our separators, with
 *  the separator tabs themselves so the tag can own them. */
async function openTabsLayout(index: SessionIndex): Promise<{ layout: TagLayoutItem[]; separators: vscode.Terminal[] }> {
  const prefix = getConfig().sessionPrefix;
  const out: TagLayoutItem[] = [];
  const tabs = new Map<string, vscode.Terminal>();
  for (const t of await readTabOrder()) {
    if (t.exitStatus) continue;
    const sep = separatorOf(t.name);
    // eslint-disable-next-line no-await-in-loop
    if (sep !== undefined && await isSeparator(t)) {
      const id = newSeparatorId();
      tabs.set(id, t);
      out.push({ separator: sep, id });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const name = sessionNameForTerminal(t) ?? await resolveTmuxNameForTerminalLive(t, index, prefix);
    const parsed = name ? parseSessionName(name, prefix) : undefined;
    if (name && parsed && index.getSessionMeta(parsed.hash, name)) out.push({ session: name });
  }
  const layout = trimLayout(out);
  const kept = layout.flatMap(i => ('separator' in i && tabs.has(i.id) ? [tabs.get(i.id)!] : []));
  return { layout, separators: kept };
}

async function cmdSaveOpenAsTag(index: SessionIndex): Promise<void> {
  const { layout, separators } = await openTabsLayout(index);
  const names = layout.flatMap(i => ('session' in i ? [i.session] : []));
  if (names.length === 0) {
    vscode.window.showInformationMessage('No session tabs are open.');
    return;
  }
  const seps = layout.length - names.length;
  const raw = await vscode.window.showInputBox({
    title: 'Save Open Tabs as Tag',
    prompt: `${plural(names.length, 'session tab')}${seps ? ` and ${plural(seps, 'separator')}` : ''}, in this order. Start All opens them again.`,
    placeHolder: 'e.g. research',
    validateInput: validateName(index),
  });
  if (raw === undefined) return;
  const name = cleanTagName(raw);
  const prefix = getConfig().sessionPrefix;
  const refs = names.flatMap(n => {
    const parsed = parseSessionName(n, prefix);
    return parsed ? [{ hash: parsed.hash, name: n }] : [];
  });
  index.pruneUnusedTags();
  const existingId = Object.entries(index.getTags()).find(([, t]) => t.name.toLowerCase() === name.toLowerCase())?.[0];
  let id: string;
  if (existingId) {
    id = existingId;
    const all = await allSessions(index);
    const current = membersOf(index, id, all);
    const choice = await vscode.window.showWarningMessage(
      `#${tagName(index, id) ?? name} already has ${plural(current.length, 'session')}. Replace them with the open tabs, or add the open tabs to it?`,
      { modal: true }, 'Replace', 'Add',
    );
    if (!choice) return;
    if (tagName(index, id) === undefined) { gone(); return; }
    // Its order before the new members join, or they would already sit at
    // the end without their separators.
    const before = fullLayout(index, id, all);
    // Tag the new ones first: untagging the last member deletes a tag.
    index.setSessionsTagged(refs, id, true);
    if (choice === 'Replace') {
      const keep = new Set(names);
      index.setSessionsTagged(current.filter(s => !keep.has(s.name)).map(s => ({ hash: s.workspaceHash, name: s.name })), id, false);
      index.untagKilled(id);
      index.setTagLayout(id, layout);
    } else {
      index.setTagLayout(id, trimLayout([...before, ...layout]));
    }
  } else {
    id = index.ensureTag(name);
    index.setSessionsTagged(refs, id, true);
    index.setTagLayout(id, layout);
  }
  own(id, separators);
  refreshSidebar();
  vscode.window.setStatusBarMessage(`Saved ${plural(names.length, 'session')} as #${name}`, 3000);
}

// ── Start All / Stop All ───────────────────────────────────────────────────

/** Open separator tabs by label, each counted once per tab. */
function openSeparatorCounts(): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of vscode.window.terminals) {
    const sep = t.exitStatus ? undefined : separatorOf(t.name);
    if (sep !== undefined) out.set(sep, (out.get(sep) ?? 0) + 1);
  }
  return out;
}

async function actionFor(s: SessionInfo): Promise<MemberAction> {
  const hasTab = Boolean(await findVerifiedTabForSession(s.name));
  if (s.stopped) return s.parked && hasTab ? 'inPlace' : 'newTab';
  if (hasTab) return 'none';
  // Running with a client attached and no tab here: its tab is in another
  // window. Opening a second one here would split the session between them.
  return s.attached ? 'none' : 'newTab';
}

async function cmdStartTag(index: SessionIndex, deps: TagCommandDeps, item?: TagTreeItem): Promise<void> {
  const all = await allSessions(index);
  const id = await resolveTag(index, item, all, 'Start the sessions of which tag?');
  if (!id) return;
  const name = tagName(index, id);
  if (name === undefined) { gone(); return; }
  const members = membersOf(index, id, all, scopeOf(item));
  const actions = new Map<string, MemberAction>();
  // eslint-disable-next-line no-await-in-loop
  for (const s of members) actions.set(s.name, await actionFor(s));
  const entries = tagEntries(index.getTags()[id]?.layout, members)
    // Stored separators compare in their current form with the open tabs.
    .map(e => ('separator' in e ? { ...e, separator: separatorSpec(e.separator) } : { session: { name: e.session.name, action: actions.get(e.session.name)! } }));
  let steps = startPlan(entries, openSeparatorCounts());
  // Separator tabs need a POSIX shell.
  if (process.platform === 'win32') steps = steps.filter(s => 'session' in s);
  const count = steps.filter(s => 'session' in s).length;
  if (count === 0) {
    vscode.window.showInformationMessage(`Every session in #${name} is already open.`);
    return;
  }
  if (count > CONFIRM_ABOVE) {
    const ok = await vscode.window.showWarningMessage(
      `Open ${plural(count, 'session')} from #${name}?`, { modal: true }, 'Open',
    );
    if (ok !== 'Open') return;
  }
  const failed: string[] = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `#${name}` },
    async progress => {
      let done = 0;
      for (const step of steps) {
        if ('separator' in step) { own(id, [openSeparator(step.separator)]); continue; }
        progress.report({ message: `starting ${++done} of ${count}`, increment: 100 / count });
        try {
          // eslint-disable-next-line no-await-in-loop
          await deps.start(step.session);
        } catch (e) {
          console.error('[terminal-sessions] tag start failed:', e);
          const s = members.find(m => m.name === step.session);
          failed.push(s?.label || step.session);
        }
      }
    },
  );
  refreshSidebar();
  if (failed.length) vscode.window.showWarningMessage(`#${name}: could not start ${failed.join(', ')}.`);
}

async function cmdStopTag(index: SessionIndex, deps: TagCommandDeps, item?: TagTreeItem): Promise<void> {
  const all = await allSessions(index);
  const id = await resolveTag(index, item, all, 'Stop the sessions of which tag?');
  if (!id) return;
  const name = tagName(index, id);
  if (name === undefined) { gone(); return; }
  const hash = scopeOf(item);
  const live = membersOf(index, id, all, hash).filter(s => !s.stopped);
  if (live.length === 0) {
    vscode.window.showInformationMessage(`Every session in #${name} is already stopped.`);
    return;
  }
  if (live.length > CONFIRM_ABOVE) {
    const ok = await vscode.window.showWarningMessage(
      `Stop ${plural(live.length, 'session')} in #${name}?`, { modal: true }, 'Stop',
    );
    if (ok !== 'Stop') return;
  }
  // eslint-disable-next-line no-await-in-loop
  for (const s of live) await deps.stop(s);
  // Once no member has a tab here (a kept, parked tab counts), the separators
  // this window opened for the tag go too: Start All opens them again.
  const after = membersOf(index, id, await allSessions(index), hash);
  const tabs = await Promise.all(after.map(s => findVerifiedTabForSession(s.name)));
  if (tabs.every(t => !t)) {
    for (const t of ownedSeparators.get(id) ?? []) {
      if (vscode.window.terminals.includes(t)) t.dispose();
    }
    ownedSeparators.delete(id);
  }
  refreshSidebar();
}

// ── Rename / Delete / separators ───────────────────────────────────────────

async function cmdRenameTag(index: SessionIndex, item?: TagTreeItem): Promise<void> {
  const id = await resolveTag(index, item, await allSessions(index), 'Rename which tag?');
  if (!id) return;
  const raw = await vscode.window.showInputBox({
    title: 'Rename Tag',
    value: tagName(index, id) ?? '',
    validateInput: validateName(index, id),
  });
  if (raw === undefined) return;
  if (tagName(index, id) === undefined) { gone(); return; }
  index.renameTag(id, cleanTagName(raw));
  refreshSidebar();
}

async function cmdDeleteTag(index: SessionIndex, item?: TagTreeItem): Promise<void> {
  const all = await allSessions(index);
  const id = await resolveTag(index, item, all, 'Delete which tag?');
  if (!id) return;
  const n = membersOf(index, id, all).length;
  const ok = await vscode.window.showWarningMessage(
    `Delete #${tagName(index, id) ?? ''}? Its ${plural(n, 'session')} stay as they are; only the tag goes.`,
    { modal: true }, 'Delete',
  );
  if (ok !== 'Delete') return;
  index.deleteTag(id);
  ownedSeparators.delete(id);
  refreshSidebar();
}

async function cmdAddTagSeparator(index: SessionIndex, item?: TagTreeItem): Promise<void> {
  const all = await allSessions(index);
  const id = await resolveTag(index, item, all, 'Add a separator to which tag?');
  if (!id) return;
  const sep = await askSeparator(
    `Add Separator to #${tagName(index, id) ?? ''}`,
    'Name shown on the separator tab. Empty for a plain line. It lands at the end: drag it into place.',
  );
  if (sep === undefined) return;
  if (tagName(index, id) === undefined) { gone(); return; }
  index.setTagLayout(id, [...fullLayout(index, id, await allSessions(index)), { separator: sep, id: newSeparatorId() }]);
  refreshSidebar();
}

async function cmdRemoveTagSeparator(index: SessionIndex, item?: TagSeparatorItem): Promise<void> {
  if (!item) return;
  const layout = fullLayout(index, item.tagId, await allSessions(index));
  const at = layout.findIndex(it => 'separator' in it && it.id === item.sepId);
  if (at < 0) return;
  layout.splice(at, 1);
  index.setTagLayout(item.tagId, layout);
  refreshSidebar();
}
