import * as vscode from 'vscode';
import * as os from 'os';
import {
  TRAFFIC_FLAG,
  TrafficFlagFinding,
  findTrafficFlag,
  fixTrafficFlagEverywhere,
  shellFixInstructions,
} from './title-traffic-flag';

// The dialog shown when Follow Conversation Title is on and Claude Code is
// told not to generate titles (see title-traffic-flag.ts).

const DISMISSED_KEY = 'followTitle.trafficFlagDismissed';
const STARTUP_SHOWN_KEY = 'followTitle.trafficFlagStartupShown';
/** When a window last put the dialog up: other windows starting in the same
 *  minute do not ask the same question on top of it. */
const SHOWING_AT_KEY = 'followTitle.trafficFlagShowingAt';
const SHOWING_MS = 60_000;
let open = false;

const TURN_ON = 'Turn On Titles';
const SHOW = 'Show the Setting';
const COPY = 'Copy Fix Instructions';
const KEEP = 'Use First Prompt Instead';

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
}

/** A stored list of finding keys (older builds stored one string). */
function keys(ctx: vscode.ExtensionContext, name: string): string[] {
  const v = ctx.globalState.get<string[] | string>(name);
  return Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
}
async function addKey(ctx: vscode.ExtensionContext, name: string, key: string): Promise<void> {
  const list = keys(ctx, name);
  if (!list.includes(key)) await ctx.globalState.update(name, [...list, key].slice(-50));
}

function findingKey(f: TrafficFlagFinding): string {
  return f.kind === 'file' ? f.path : 'env';
}

function tildePath(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

/**
 * Look for the variable and, when it is there, ask what to do.
 * `reason`: 'enabled' = the user just turned Follow Conversation Title on
 * (always asks); 'startup' = it was already on (asks once per finding, and
 * never after "Use First Prompt Instead").
 */
export async function maybeOfferTitleFix(ctx: vscode.ExtensionContext, reason: 'enabled' | 'startup'): Promise<void> {
  if (open) return;
  const folders = workspaceFolders();
  const finding = findTrafficFlag(folders);
  if (!finding) return;
  const key = findingKey(finding);
  if (reason === 'startup') {
    if (keys(ctx, DISMISSED_KEY).includes(key)) return;
    if (keys(ctx, STARTUP_SHOWN_KEY).includes(key)) return;
  } else if (!vscode.window.state.focused) {
    // The setting change reaches every window: the one in front asks.
    return;
  }
  // Another window put the same dialog up a moment ago.
  if (Date.now() - (ctx.globalState.get<number>(SHOWING_AT_KEY) ?? 0) < SHOWING_MS) return;
  open = true;
  try {
    await ctx.globalState.update(SHOWING_AT_KEY, Date.now());
    await ask(ctx, finding, key, folders);
  } finally {
    open = false;
  }
}

async function ask(
  ctx: vscode.ExtensionContext,
  finding: TrafficFlagFinding,
  key: string,
  folders: string[],
): Promise<void> {

  const common = 'Follow Conversation Title uses the title Claude Code writes for each conversation. '
    + `Since Claude Code 2.1.316, the setting ${TRAFFIC_FLAG} also turns those titles off. `
    + 'Without a title, a session shows the first prompt of its conversation.';
  const detail = finding.kind === 'file'
    ? `${common}\n\nFound in: ${tildePath(finding.path)}\n\n`
      + `"${TURN_ON}" replaces that setting with the four separate switches it stands for `
      + '(telemetry, error reporting, the /bug command, auto-update), so nothing else changes. '
      + 'Running Claude sessions pick it up after a restart.'
    : `${common}\n\nFound in: the environment this editor runs in (a shell export).\n\n`
      + `The extension does not edit shell profiles. "${COPY}" copies the steps to do it by hand.`;
  const buttons = finding.kind === 'file' ? [TURN_ON, SHOW, KEEP] : [COPY, KEEP];
  const choice = await vscode.window.showWarningMessage(
    'Claude Code is not generating conversation titles',
    { modal: true, detail },
    ...buttons,
  );

  // Asked and answered: startup does not ask again for this finding. Closing
  // the dialog with Escape is not an answer, so the next startup asks again.
  if (choice !== undefined) await addKey(ctx, STARTUP_SHOWN_KEY, key);

  if (choice === TURN_ON && finding.kind === 'file') {
    const { fixed, failed } = fixTrafficFlagEverywhere(folders);
    if (!failed && fixed.length > 0) {
      void vscode.window.showInformationMessage(
        `Titles are on: ${TRAFFIC_FLAG} was replaced in ${fixed.map(tildePath).join(', ')}. Restart the running Claude sessions to pick it up.`,
      );
    } else {
      const bad = failed ?? finding.path;
      const again = findTrafficFlag(folders, {});
      const openIt = await vscode.window.showErrorMessage(
        `Could not change ${tildePath(bad)}. Open it and remove ${TRAFFIC_FLAG} by hand.`,
        SHOW,
      );
      if (openIt === SHOW) await showSetting(again && again.kind === 'file' ? again : { kind: 'file', path: bad, line: 0 });
    }
  } else if (choice === SHOW && finding.kind === 'file') {
    await showSetting(finding);
  } else if (choice === COPY) {
    await vscode.env.clipboard.writeText(shellFixInstructions());
    void vscode.window.showInformationMessage('Fix instructions copied to the clipboard.');
  } else if (choice === KEEP) {
    await addKey(ctx, DISMISSED_KEY, key);
  }
}

async function showSetting(finding: Extract<TrafficFlagFinding, { kind: 'file' }>): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(finding.path));
    const range = doc.lineAt(Math.min(finding.line, doc.lineCount - 1)).range;
    await vscode.window.showTextDocument(doc, { selection: range });
  } catch { /* file gone meanwhile */ }
}
