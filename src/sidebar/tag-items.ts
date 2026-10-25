import * as vscode from 'vscode';
import { SessionInfo } from '../types';
import { TagEntry } from '../tags';

/** One tag as the sidebar shows it under a workspace: its rows in tag order
 *  (only this workspace's members) and the counts for its badge. */
export interface TagView {
  id: string;
  name: string;
  entries: TagEntry<SessionInfo>[];
}

/** Pinned virtual folder "Tags": one row per tag with members in this
 *  workspace. Hidden while there is none. */
export class TagsFolderItem extends vscode.TreeItem {
  constructor(
    public readonly workspaceHash: string,
    public readonly tags: TagView[],
  ) {
    super('Tags', vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `tagf:${workspaceHash}`;
    this.iconPath = new vscode.ThemeIcon('tag');
    this.description = String(tags.length);
    this.contextValue = 'tagsFolder';
    this.tooltip = 'Sets of sessions that start and stop together. Select sessions or tabs, right-click → Tag…, or save every open tab as a tag with the + on this row.';
  }
}

/** A tag: its member sessions and separators, in the order Start All opens
 *  them. Drag rows to reorder; drop a session here to add it. */
export class TagTreeItem extends vscode.TreeItem {
  constructor(
    public readonly workspaceHash: string,
    public readonly tag: TagView,
  ) {
    super(`#${tag.name}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `tag:${workspaceHash}:${tag.id}`;
    this.iconPath = new vscode.ThemeIcon('tag');
    const sessions = tag.entries.flatMap(e => ('session' in e ? [e.session] : []));
    const stopped = sessions.filter(s => s.stopped).length;
    const running = sessions.length - stopped;
    this.description = [String(sessions.length), stopped ? `${stopped}⏸` : '', running ? `${running}▶` : '']
      .filter(Boolean).join(' · ');
    this.contextValue = 'tag';
    this.tooltip = new vscode.MarkdownString([
      `**#${tag.name}**: ${sessions.length} session${sessions.length === 1 ? '' : 's'}`
        + ` (${running} running, ${stopped} stopped)`,
      '▶ Start All opens them in this order, separators included; ■ Stop All stops them.',
      'Drag rows to reorder. Drop a session on this row to add it.',
    ].join('\n\n'));
  }
}

/** A separator in a tag's order: Start All opens it as a separator tab just
 *  before the first session of its section that gets a new tab. */
export class TagSeparatorItem extends vscode.TreeItem {
  constructor(
    public readonly workspaceHash: string,
    public readonly tagId: string,
    public readonly label: string,
    /** Its index in the tag's full order (TagLayoutItem[]), for a move. */
    public readonly position: number,
  ) {
    super(label ? `── ${label} ──` : '────────', vscode.TreeItemCollapsibleState.None);
    this.id = `tagsep:${workspaceHash}:${tagId}:${position}`;
    this.iconPath = new vscode.ThemeIcon('dash');
    this.contextValue = 'tagSeparator';
    this.tooltip = 'Separator tab. Start All opens it above the next sessions. Drag it to move it; right-click to remove it.';
  }
}

/** Id prefix of a session row mirrored inside a tag: `tagm:<tagId>:`. */
export function tagMemberPrefix(tagId: string): string {
  return `tagm:${tagId}:`;
}

/** The tag a mirrored session row sits in, read back from its id. */
export function tagOfMemberRow(id: string | undefined): string | undefined {
  const m = /^tagm:([^:]+):/.exec(id ?? '');
  return m ? m[1] : undefined;
}
