import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { COMMAND, SEPARATOR_PROFILE_ID, SEPARATOR_LAST_PROFILE_ID } from './config';
import { isWalkingTabs, onTabWalkEnd } from './tab-order';

/**
 * Separator tabs: named dividers in the native terminal tab list, dragged
 * into place like any other tab. Each one is a real (if idle) process, so the
 * panel keeps it in position across a window reload, unlike a pty-backed tab
 * the extension would have to recreate at the end of the list. The processes
 * are a waiting `sh` and its `sleep`: about 2 MB, no CPU, no tmux.
 *
 * Clicking a separator would only show an empty screen, so focus bounces
 * straight back to the tab that was active before (or the nearest real tab
 * when there is none).
 */

// A separator is a look (a run of one character, or a blank row), an
// alignment of its name and a length. The name is upper-cased; at one length
// every separator ends in the same column. The tab name carries all three, so
// a recreated separator reads exactly as before.
export type SeparatorStyle = 'line' | 'double' | 'thin' | 'dots' | 'band' | 'solid' | 'shade' | 'blank';
export type SeparatorAlign = 'center' | 'left' | 'flush';
export type SeparatorLength = 'short' | 'medium' | 'long';
const FILL: Record<Exclude<SeparatorStyle, 'blank'>, string> = {
  line: '━', double: '═', thin: '─', dots: '·', band: '▓', solid: '█', shade: '░',
};
const WIDTH: Record<SeparatorLength, number> = { short: 20, medium: 30, long: 42 };
// U+2800 (braille blank) draws nothing but, unlike a space, is not trimmed
// away, so the tab keeps a name of its own instead of the shell's.
const BLANK = '⠀';
const BLANK_WIDTH = 8;
// Names before v0.40: `── Research ──`, and `─` × 12 for a plain line.
const LEGACY = '──';
const ICONS: Record<SeparatorStyle, string> = {
  line: 'dash', double: 'dash', thin: 'dash', dots: 'ellipsis',
  band: 'primitive-square', solid: 'primitive-square', shade: 'primitive-square', blank: 'blank',
};
/** Icon colour of every separator but the blank one; tab-color.ts paints
 *  their name the same. */
export const SEPARATOR_COLOR = new vscode.ThemeColor('terminal.ansiBlue');
// Passed as the shell's $0, so the shell's own command line in `ps` names it:
// that is how a reload-restored separator, which has lost its creationOptions,
// is told apart from any other terminal.
const MARKER = 'terminal-sessions-separator';
// Hide the cursor and keyboard echo, ignore Ctrl+C / Ctrl+\\ / Ctrl+Z (a stray
// one would end the tab and lose its place), print the name dimmed, then wait.
// The shell stays alive (no exec) so its command line keeps the marker. The
// name arrives as $1, never inside the script text.
const SCRIPT = `trap '' INT QUIT TSTP; printf '\\033[?25l\\033[2J\\033[H'; stty -echo 2>/dev/null; `
  + `printf '\\n  \\033[2m%s\\033[0m\\n' "$1"; while :; do sleep 2147483647; done`;

/** The tab name for a separator with this label, look, alignment and length.
 *  `center` puts the name in the middle, `left` after a short lead and
 *  `flush` at the very start; without a name it is an unbroken run. */
export function separatorName(
  label: string,
  style: SeparatorStyle,
  align: SeparatorAlign = 'center',
  length: SeparatorLength = 'medium',
): string {
  if (style === 'blank') return BLANK.repeat(BLANK_WIDTH);
  const fill = FILL[style];
  const width = WIDTH[length];
  // Control characters would reach the terminal raw when the name is printed.
  // eslint-disable-next-line no-control-regex
  // Fill marks at either end of the name would blur into the run around it
  // and make the name unreadable back from the tab.
  const text = label.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 60).toUpperCase()
    .replace(/^[\s━═─·▓█░⠀]+|[\s━═─·▓█░⠀]+$/g, '');
  if (!text) return fill.repeat(width);
  if (align === 'flush') return `${text}  ${fill.repeat(Math.max(3, width - text.length - 2))}`;
  if (align === 'left') return `${fill.repeat(2)}  ${text}  ${fill.repeat(Math.max(3, width - text.length - 6))}`;
  const room = Math.max(6, width - text.length - 4);
  const left = Math.floor(room / 2);
  return `${fill.repeat(left)}  ${text}  ${fill.repeat(room - left)}`;
}

function parseSeparator(name: string): { label: string; style: SeparatorStyle; legacy?: true } | undefined {
  if (name === LEGACY.repeat(6)) return { label: '', style: 'line', legacy: true };
  const legacy = new RegExp(`^${LEGACY} (.+) ${LEGACY}$`).exec(name);
  if (legacy) return { label: legacy[1], style: 'line', legacy: true };
  if (new RegExp(`^${BLANK}+$`).test(name)) return { label: '', style: 'blank' };
  for (const [style, f] of Object.entries(FILL) as Array<[Exclude<SeparatorStyle, 'blank'>, string]>) {
    if (new RegExp(`^${f}{6,}$`).test(name)) return { label: '', style };
    const lead = new RegExp(`^${f}{2,}  (.+)  ${f}{3,}$`).exec(name);
    if (lead) return { label: lead[1], style };
    const flush = new RegExp(`^([^${f}].*?)  ${f}{3,}$`).exec(name);
    if (flush) return { label: flush[1], style };
  }
  return undefined;
}

/** The label a separator tab was named with ('' for none), or undefined when
 *  `name` is not a separator name. Works on a dead tab too: the name is all
 *  that is left. */
export function separatorLabel(name: string): string | undefined {
  return parseSeparator(name)?.label;
}

/** The look of a separator tab, or undefined when `name` is not one. */
export function separatorStyle(name: string): SeparatorStyle | undefined {
  return parseSeparator(name)?.style;
}

/** What it takes to open this separator again: its own name, or for an
 *  older `── x ──` (or plain `─` line) the heavy line, the same a tag's bare
 *  label opens as, so the two count as one. Undefined for other tabs. */
export function separatorOf(name: string): string | undefined {
  const p = parseSeparator(name);
  if (!p) return undefined;
  return p.legacy ? separatorName(p.label, p.style) : name;
}

/** A separator as a tag stores it: a full name, or a bare label from before
 *  the looks existed, which opens as a heavy line. */
export function separatorSpec(nameOrLabel: string): string {
  return separatorOf(nameOrLabel) ?? separatorName(nameOrLabel, 'line');
}

function separatorOptions(name: string): vscode.TerminalOptions {
  const style = separatorStyle(name) ?? 'line';
  return {
    name,
    shellPath: '/bin/sh',
    shellArgs: ['-c', SCRIPT, MARKER, name],
    // The tab list shows the name of the folder a terminal sits in; `/` has
    // none, so nothing stands next to the separator.
    cwd: '/',
    iconPath: new vscode.ThemeIcon(ICONS[style]),
    color: style === 'blank' ? undefined : SEPARATOR_COLOR,
  };
}

/** Open a separator tab (at the end of the list, not focused) from a tab
 *  name or a stored tag entry (see separatorSpec). */
export function openSeparator(spec: string): vscode.Terminal {
  return vscode.window.createTerminal(separatorOptions(separatorSpec(spec)));
}

const known = new WeakMap<vscode.Terminal, boolean>();

/** The process's command line, or undefined when `ps` could not say. */
function processCommand(pid: number): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { timeout: 2000 }, (err, out) => {
      // `ps` exits 1 for a pid that is gone: a definite "not a separator".
      if (err && (err as { code?: unknown }).code !== 1) { resolve(undefined); return; }
      resolve(err ? '' : out.trim());
    });
  });
}

function isSeparatorCommand(command: string): boolean {
  return command.includes('while :; do sleep 2147483647; done') && command.includes(` ${MARKER} `);
}

/** True for a separator tab, including one restored by a window reload. */
export async function isSeparator(t: vscode.Terminal): Promise<boolean> {
  const cached = known.get(t);
  if (cached !== undefined) return cached;
  const opts = t.creationOptions as vscode.TerminalOptions | undefined;
  const args = opts && !('pty' in opts) ? opts.shellArgs : undefined;
  if (Array.isArray(args)) {
    // Shell args survive only on tabs created in this window: they decide.
    const result = args.includes(MARKER);
    known.set(t, result);
    return result;
  }
  // A reload-restored tab has no shellArgs: ask its process. Nothing is
  // cached while the pid or `ps` cannot answer, so a later switch asks again.
  const pid = await t.processId;
  if (!pid) return false;
  const command = await processCommand(pid);
  if (command === undefined) return false;
  const result = isSeparatorCommand(command);
  known.set(t, result);
  return result;
}

let memento: vscode.Memento | undefined;
const LAST_KEY = 'separatorLast';

interface SeparatorChoice { style: SeparatorStyle; align: SeparatorAlign; length: SeparatorLength }

function lastChoice(): SeparatorChoice {
  return { style: 'line', align: 'center', length: 'medium', ...memento?.get<Partial<SeparatorChoice>>(LAST_KEY) };
}

function askSeparatorLabel(prompt: string, title: string, token?: vscode.CancellationToken): Thenable<string | undefined> {
  return vscode.window.showInputBox({ title, prompt, placeHolder: 'e.g. Research' }, token);
}

type PickItem<T> = vscode.QuickPickItem & { value?: T };

/** One choice from `items`, the current one highlighted; undefined on Esc. */
function pickOne<T>(title: string, items: PickItem<T>[], current: T, token?: vscode.CancellationToken): Promise<T | undefined> {
  return new Promise(resolve => {
    const qp = vscode.window.createQuickPick<PickItem<T>>();
    qp.title = title;
    qp.items = items;
    qp.matchOnDescription = true;
    const cur = items.find(i => i.value === current);
    if (cur) qp.activeItems = [cur];
    let done = false;
    const finish = (v: T | undefined): void => {
      if (done) return;
      done = true;
      sub?.dispose();
      qp.dispose();
      resolve(v);
    };
    // The highlighted row, which is the last choice until the user moves.
    qp.onDidAccept(() => finish((qp.activeItems[0] ?? qp.selectedItems[0])?.value));
    qp.onDidHide(() => finish(undefined));
    const sub = token?.onCancellationRequested(() => finish(undefined));
    qp.show();
  });
}

const STYLE_GROUPS: Array<[string, Array<[SeparatorStyle, string]>]> = [
  ['Lines', [['line', 'Heavy line'], ['double', 'Double line'], ['thin', 'Thin line'], ['dots', 'Dots']]],
  ['Bands', [['band', 'Band'], ['solid', 'Solid block'], ['shade', 'Light shade']]],
  ['Blank', [['blank', 'Blank row, no name and no line']]],
];

/** Look, then alignment (only with a name), then length, each list drawn
 *  with the name as it will read and the last choice highlighted. */
async function askSeparatorLook(label: string, token?: vscode.CancellationToken): Promise<SeparatorChoice | undefined> {
  const last = lastChoice();
  const styleItems: PickItem<SeparatorStyle>[] = STYLE_GROUPS.flatMap(([group, looks]) => [
    { label: group, kind: vscode.QuickPickItemKind.Separator },
    ...looks.map(([style, what]) => ({
      label: style === 'blank' ? '(blank)' : separatorName(label, style, last.align, last.length),
      description: what,
      value: style,
    })),
  ]);
  const style = await pickOne('Separator look (1/3)', styleItems, last.style, token);
  if (style === undefined) return undefined;
  if (style === 'blank') return { ...last, style };
  let align = last.align;
  if (label.trim()) {
    const aligns: Array<[SeparatorAlign, string]> = [['center', 'Centred'], ['left', 'Left, after a short lead'], ['flush', 'At the very start']];
    const picked = await pickOne('Separator name position (2/3)', aligns.map(([value, what]) => ({
      label: separatorName(label, style, value, last.length), description: what, value,
    })), last.align, token);
    if (picked === undefined) return undefined;
    align = picked;
  }
  const lengths: Array<[SeparatorLength, string]> = [['short', 'Short'], ['medium', 'Medium'], ['long', 'Long']];
  const length = await pickOne('Separator length (3/3)', lengths.map(([value, what]) => ({
    label: separatorName(label, style, align, value), description: what, value,
  })), last.length, token);
  if (length === undefined) return undefined;
  return { style, align, length };
}

/** Ask for a separator's name and look; its tab name, or undefined on Esc.
 *  `lastUsed` skips the look and reuses the one picked last. */
export async function askSeparator(
  title: string,
  prompt: string,
  token?: vscode.CancellationToken,
  lastUsed = false,
): Promise<string | undefined> {
  const last = lastChoice();
  if (lastUsed && last.style === 'blank') return separatorName('', 'blank');
  const label = await askSeparatorLabel(
    lastUsed ? `${prompt} Reads like: ${separatorName('Name', last.style, last.align, last.length)}` : prompt,
    title,
    token,
  );
  if (label === undefined) return undefined;
  const choice = lastUsed ? last : await askSeparatorLook(label, token);
  if (!choice) return undefined;
  void memento?.update(LAST_KEY, choice);
  return separatorName(label, choice.style, choice.align, choice.length);
}

const ADD_TITLE = 'Add Session Separator';
const ADD_LAST_TITLE = 'Add Session Separator (Last Used)';
const ADD_PROMPT = 'Name shown on the separator tab. Empty for a plain line. Drag the tab to place it.';

export function registerSeparators(ctx: vscode.ExtensionContext): void {
  memento = ctx.globalState;
  let lastReal: vscode.Terminal | undefined;
  const alive = (t: vscode.Terminal | undefined): t is vscode.Terminal =>
    !!t && !t.exitStatus && vscode.window.terminals.includes(t);
  // The nearest tab that is not a separator, scanning outwards from `sep`.
  const nearestReal = async (sep: vscode.Terminal): Promise<vscode.Terminal | undefined> => {
    const terms = vscode.window.terminals;
    const at = terms.indexOf(sep);
    for (let d = 1; d < terms.length; d++) {
      for (const i of [at + d, at - d]) {
        const t = terms[i];
        // eslint-disable-next-line no-await-in-loop
        if (t && !t.exitStatus && !(await isSeparator(t))) return t;
      }
    }
    return undefined;
  };
  const note = async (t: vscode.Terminal | undefined, bounce = true): Promise<void> => {
    if (!t) return;
    const sep = await isSeparator(t);
    // The user may have moved on while `ps` ran: only the tab still active counts.
    if (vscode.window.activeTerminal !== t) return;
    if (!sep) {
      // Only a definite answer: a tab `ps` could not identify yet may still
      // be a separator, and bouncing back onto it would land on one.
      if (known.get(t) === false) lastReal = t;
      return;
    }
    if (!bounce) return;
    const back = alive(lastReal) && lastReal !== t ? lastReal : await nearestReal(t);
    // preserveFocus: a slow `ps` must not pull focus back from the editor.
    if (back && vscode.window.activeTerminal === t) back.show(true);
  };
  // At startup only learn where we are: bouncing would open a hidden panel.
  void note(vscode.window.activeTerminal, false);

  ctx.subscriptions.push(
    ...([false, true] as const).flatMap(lastUsed => [
      vscode.window.registerTerminalProfileProvider(lastUsed ? SEPARATOR_LAST_PROFILE_ID : SEPARATOR_PROFILE_ID, {
        async provideTerminalProfile(token) {
          if (process.platform === 'win32') {
            throw new Error('Separator tabs need a POSIX shell (macOS, Linux, WSL or Remote-SSH).');
          }
          const name = await askSeparator(lastUsed ? ADD_LAST_TITLE : ADD_TITLE, ADD_PROMPT, token, lastUsed);
          // A profile provider cannot decline without the panel reporting an
          // error, so Esc adds a plain line too; closing the tab removes it.
          return new vscode.TerminalProfile(separatorOptions(name ?? separatorName('', 'line')));
        },
      }),
      // The same from the tab menu or the palette, where Esc can cancel. The
      // tab still lands at the end of the list: the API cannot place it.
      vscode.commands.registerCommand(lastUsed ? COMMAND.addSeparatorLastUsed : COMMAND.addSeparator, async () => {
        if (process.platform === 'win32') {
          void vscode.window.showWarningMessage('Separator tabs need a POSIX shell (macOS, Linux, WSL or Remote-SSH).');
          return;
        }
        const name = await askSeparator(lastUsed ? ADD_LAST_TITLE : ADD_TITLE, ADD_PROMPT, undefined, lastUsed);
        if (name === undefined) return;
        openSeparator(name);
        // A blank one has no title to spot at the end of the list.
        if (separatorStyle(name) === 'blank') vscode.window.setStatusBarMessage('Blank separator added at the end of the tab list', 4000);
      }),
    ]),
    vscode.window.onDidChangeActiveTerminal(t => { if (!isWalkingTabs()) void note(t); }),
    onTabWalkEnd(() => void note(vscode.window.activeTerminal)),
  );
}
