import * as vscode from 'vscode';
import { COMMAND, getConfig } from './config';
import * as tmux from './tmux';
import { SessionIndex, enrichSessions } from './session-manager';
import { SessionInfo } from './types';
import { refreshSidebar } from './sidebar/tree-provider';
import { SessionTreeItem } from './sidebar/items';
import { TagTreeItem, TagSeparatorItem } from './sidebar/tag-items';
import { findTerminalForSession, resolveTmuxNameForTerminalLive, sessionNameForTerminal } from './profile-provider';
import { parseSessionName } from './workspace-id';
import { separatorLabel, openSeparator } from './separator';
import {
  TagLayoutItem, MemberAction, cleanTagName, tagEntries, toLayout, trimLayout, startPlan,
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

async function allSessions(index: SessionIndex): Promise<SessionInfo[]> {
  const cfg = getConfig();
  const tmuxPath = await tmux.detectTmuxPath(cfg.tmuxPath);
  return tmuxPath ? enrichSessions(tmuxPath, cfg.sessionPrefix, index) : [];
}

function membersOf(index: SessionIndex, tagId: string, all: SessionInfo[]): SessionInfo[] {
  return all.filter(s => index.getSessionMeta(s.workspaceHash, s.name)?.tags?.includes(tagId));
}

/** The tag's whole order, every member placed (the same one the sidebar shows). */
function fullLayout(index: SessionIndex, tagId: string, all: SessionInfo[]): TagLayoutItem[] {
  return toLayout(tagEntries(index.getTags()[tagId]?.layout, membersOf(index, tagId, all)));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The tag a menu row names, or one picked from the list. */
async function resolveTag(
  index: SessionIndex,
  item: TagTreeItem | undefined,
  all: SessionInfo[],
  placeHolder: string,
): Promise<string | undefined> {
  if (item?.tag?.id) return index.getTags()[item.tag.id] ? item.tag.id : undefined;
  interface Pick extends vscode.QuickPickItem { id: string }
  const picks: Pick[] = Object.entries(index.getTags())
    .map(([id, t]) => {
      const members = membersOf(index, id, all);
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

/** One picker that adds and removes: a tag every target has starts checked
 *  (uncheck to remove it), typing a new name offers to create it. */
async function cmdTag(index: SessionIndex, targets: SessionInfo[]): Promise<void> {
  if (targets.length === 0) {
    vscode.window.showErrorMessage('Use the menu of a session row or a session tab.');
    return;
  }
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

  const qp = vscode.window.createQuickPick<Item>();
  qp.canSelectMany = true;
  qp.title = targets.length === 1
    ? `Tag "${targets[0].label || targets[0].name}"`
    : `Tag ${targets.length} sessions`;
  qp.placeholder = 'Check tags, or type a new name and press Enter';
  const checked = new Set(initially);
  let createItem: Item | undefined;
  const render = (): void => {
    const name = cleanTagName(qp.value);
    const known = existing.some(i => i.label.toLowerCase() === `$(tag) #${name}`.toLowerCase());
    createItem = name && !known ? { label: `$(add) Create #${name}`, create: name, alwaysShow: true } : undefined;
    qp.items = createItem ? [createItem, ...existing] : existing;
    qp.selectedItems = [...(createItem ? [createItem] : []), ...existing.filter(i => checked.has(i.id!))];
  };
  qp.onDidChangeValue(render);
  qp.onDidChangeSelection(sel => {
    // Track the user's checks across re-renders; the create row is not a tag yet.
    for (const i of existing) {
      if (sel.includes(i)) checked.add(i.id!);
      else if (qp.items.includes(i)) checked.delete(i.id!);
    }
  });
  render();
  const accepted = await new Promise<readonly Item[] | undefined>(resolve => {
    qp.onDidAccept(() => { resolve(qp.selectedItems); qp.hide(); });
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
    const on = accepted.includes(i);
    const name = index.getTags()[i.id!]?.name ?? '';
    if (on && !initially.has(i.id!)) { index.setSessionsTagged(refs, i.id!, true); added.push(name); }
    else if (!on && initially.has(i.id!)) { index.setSessionsTagged(refs, i.id!, false); removed.push(name); }
  }
  refreshSidebar();
  const parts = [
    added.length ? `added ${added.map(n => `#${n}`).join(' ')}` : '',
    removed.length ? `removed ${removed.map(n => `#${n}`).join(' ')}` : '',
  ].filter(Boolean);
  if (parts.length) vscode.window.setStatusBarMessage(`Tags: ${parts.join(', ')}`, 3000);
}

// ── Save Open Tabs as Tag… ──────────────────────────────────────────────────

/** The open tabs in the order the API knows (creation, or the restored order
 *  after a reload): session tabs and separators. */
async function openTabsLayout(index: SessionIndex): Promise<TagLayoutItem[]> {
  const prefix = getConfig().sessionPrefix;
  const out: TagLayoutItem[] = [];
  for (const t of vscode.window.terminals) {
    if ((t.creationOptions as vscode.TerminalOptions | undefined)?.hideFromUser || t.exitStatus) continue;
    const sep = separatorLabel(t.name);
    if (sep !== undefined) { out.push({ separator: sep }); continue; }
    // eslint-disable-next-line no-await-in-loop
    const name = sessionNameForTerminal(t) ?? await resolveTmuxNameForTerminalLive(t, index, prefix);
    const parsed = name ? parseSessionName(name, prefix) : undefined;
    if (name && parsed && index.getSessionMeta(parsed.hash, name)) out.push({ session: name });
  }
  return trimLayout(out);
}

async function cmdSaveOpenAsTag(index: SessionIndex): Promise<void> {
  const layout = await openTabsLayout(index);
  const names = layout.flatMap(i => ('session' in i ? [i.session] : []));
  if (names.length === 0) {
    vscode.window.showInformationMessage('No session tabs are open.');
    return;
  }
  const seps = layout.length - names.length;
  const raw = await vscode.window.showInputBox({
    title: 'Save Open Tabs as Tag',
    prompt: `${plural(names.length, 'session tab')}${seps ? ` and ${plural(seps, 'separator')}` : ''}, in this order. Start All on the tag opens them again.`,
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
  const existingId = Object.entries(index.getTags()).find(([, t]) => t.name.toLowerCase() === name.toLowerCase())?.[0];
  if (existingId) {
    const all = await allSessions(index);
    const current = membersOf(index, existingId, all);
    const choice = await vscode.window.showWarningMessage(
      `#${index.getTags()[existingId].name} already has ${plural(current.length, 'session')}. Replace them with the open tabs, or add the open tabs to it?`,
      { modal: true }, 'Replace', 'Add',
    );
    if (!choice) return;
    // Tag the new ones first: untagging the last member deletes a tag.
    index.setSessionsTagged(refs, existingId, true);
    if (choice === 'Replace') {
      const keep = new Set(names);
      index.setSessionsTagged(current.filter(s => !keep.has(s.name)).map(s => ({ hash: s.workspaceHash, name: s.name })), existingId, false);
      index.setTagLayout(existingId, layout);
    } else {
      index.setTagLayout(existingId, trimLayout([...fullLayout(index, existingId, all), ...layout]));
    }
  } else {
    const id = index.ensureTag(name);
    index.setSessionsTagged(refs, id, true);
    index.setTagLayout(id, layout);
  }
  refreshSidebar();
  vscode.window.setStatusBarMessage(`Saved ${plural(names.length, 'session')} as #${name}`, 3000);
}

// ── Start All / Stop All ───────────────────────────────────────────────────

function openSeparatorLabels(): Set<string> {
  const out = new Set<string>();
  for (const t of vscode.window.terminals) {
    const sep = t.exitStatus ? undefined : separatorLabel(t.name);
    if (sep !== undefined) out.add(sep);
  }
  return out;
}

function actionFor(s: SessionInfo): MemberAction {
  const tab = findTerminalForSession(s.name);
  const hasTab = Boolean(tab && !tab.exitStatus);
  if (s.stopped) return s.parked && hasTab ? 'inPlace' : 'newTab';
  return hasTab ? 'none' : 'newTab';
}

async function cmdStartTag(index: SessionIndex, deps: TagCommandDeps, item?: TagTreeItem): Promise<void> {
  const all = await allSessions(index);
  const id = await resolveTag(index, item, all, 'Start the sessions of which tag?');
  if (!id) return;
  const tagName = index.getTags()[id].name;
  const entries = tagEntries(index.getTags()[id].layout, membersOf(index, id, all))
    .map(e => ('separator' in e ? e : { session: { name: e.session.name, action: actionFor(e.session) } }));
  let steps = startPlan(entries, openSeparatorLabels());
  // Separator tabs need a POSIX shell.
  if (process.platform === 'win32') steps = steps.filter(s => 'session' in s);
  const count = steps.filter(s => 'session' in s).length;
  if (count === 0) {
    vscode.window.showInformationMessage(`Every session in #${tagName} is already open.`);
    return;
  }
  if (count > CONFIRM_ABOVE) {
    const ok = await vscode.window.showWarningMessage(
      `Open ${plural(count, 'session')} from #${tagName}?`, { modal: true }, 'Open',
    );
    if (ok !== 'Open') return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `#${tagName}` },
    async progress => {
      let done = 0;
      for (const step of steps) {
        if ('separator' in step) { openSeparator(step.separator); continue; }
        progress.report({ message: `starting ${++done} of ${count}`, increment: 100 / count });
        // eslint-disable-next-line no-await-in-loop
        await deps.start(step.session);
      }
    },
  );
  refreshSidebar();
}

async function cmdStopTag(index: SessionIndex, deps: TagCommandDeps, item?: TagTreeItem): Promise<void> {
  const all = await allSessions(index);
  const id = await resolveTag(index, item, all, 'Stop the sessions of which tag?');
  if (!id) return;
  const tagName = index.getTags()[id].name;
  const live = membersOf(index, id, all).filter(s => !s.stopped);
  if (live.length === 0) {
    vscode.window.showInformationMessage(`Every session in #${tagName} is already stopped.`);
    return;
  }
  if (live.length > CONFIRM_ABOVE) {
    const ok = await vscode.window.showWarningMessage(
      `Stop ${plural(live.length, 'session')} in #${tagName}?`, { modal: true }, 'Stop',
    );
    if (ok !== 'Stop') return;
  }
  // eslint-disable-next-line no-await-in-loop
  for (const s of live) await deps.stop(s);
  // With the whole tag stopped, its separator tabs go too: Start All opens
  // them again with the sessions.
  const after = membersOf(index, id, await allSessions(index));
  if (after.every(s => s.stopped)) {
    const labels = new Set(fullLayout(index, id, after).flatMap(i => ('separator' in i ? [i.separator] : [])));
    for (const t of vscode.window.terminals) {
      const sep = separatorLabel(t.name);
      if (sep !== undefined && labels.has(sep)) t.dispose();
    }
  }
  refreshSidebar();
}

// ── Rename / Delete / separators ───────────────────────────────────────────

async function cmdRenameTag(index: SessionIndex, item?: TagTreeItem): Promise<void> {
  const id = await resolveTag(index, item, await allSessions(index), 'Rename which tag?');
  if (!id) return;
  const raw = await vscode.window.showInputBox({
    title: 'Rename Tag',
    value: index.getTags()[id].name,
    validateInput: validateName(index, id),
  });
  if (raw === undefined) return;
  index.renameTag(id, cleanTagName(raw));
  refreshSidebar();
}

async function cmdDeleteTag(index: SessionIndex, item?: TagTreeItem): Promise<void> {
  const all = await allSessions(index);
  const id = await resolveTag(index, item, all, 'Delete which tag?');
  if (!id) return;
  const t = index.getTags()[id];
  const n = membersOf(index, id, all).length;
  const ok = await vscode.window.showWarningMessage(
    `Delete #${t.name}? Its ${plural(n, 'session')} stay as they are; only the tag goes.`,
    { modal: true }, 'Delete',
  );
  if (ok !== 'Delete') return;
  index.deleteTag(id);
  refreshSidebar();
}

async function cmdAddTagSeparator(index: SessionIndex, item?: TagTreeItem): Promise<void> {
  const all = await allSessions(index);
  const id = await resolveTag(index, item, all, 'Add a separator to which tag?');
  if (!id) return;
  const label = await vscode.window.showInputBox({
    title: `Add Separator to #${index.getTags()[id].name}`,
    prompt: 'Name shown on the separator tab. Empty for a plain line. It lands at the end: drag it into place.',
    placeHolder: 'e.g. Research',
  });
  if (label === undefined) return;
  index.setTagLayout(id, [...fullLayout(index, id, all), { separator: label.trim() }]);
  refreshSidebar();
}

async function cmdRemoveTagSeparator(index: SessionIndex, item?: TagSeparatorItem): Promise<void> {
  if (!item) return;
  const layout = fullLayout(index, item.tagId, await allSessions(index));
  const it = layout[item.position];
  if (!it || !('separator' in it)) return;
  layout.splice(item.position, 1);
  index.setTagLayout(item.tagId, layout);
  refreshSidebar();
}
