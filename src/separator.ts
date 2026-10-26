import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { COMMAND, SEPARATOR_PROFILE_ID } from './config';
import { isWalkingTabs } from './tab-order';

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

const PREFIX = '──';
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

function separatorName(label: string): string {
  // Control characters would reach the terminal raw when the name is printed.
  // eslint-disable-next-line no-control-regex
  const trimmed = label.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 60);
  return trimmed ? `${PREFIX} ${trimmed} ${PREFIX}` : PREFIX.repeat(6);
}

function separatorOptions(label: string): vscode.TerminalOptions {
  const name = separatorName(label);
  return {
    name,
    shellPath: '/bin/sh',
    shellArgs: ['-c', SCRIPT, MARKER, name],
    iconPath: new vscode.ThemeIcon('dash'),
  };
}

/** The label a separator tab was named with, or undefined when `name` is not
 *  a separator name. Works on a dead tab too: the name is all that is left. */
export function separatorLabel(name: string): string | undefined {
  if (name === PREFIX.repeat(6)) return '';
  const m = new RegExp(`^${PREFIX} (.+) ${PREFIX}$`).exec(name);
  return m ? m[1] : undefined;
}

/** Open a separator tab (at the end of the list, not focused). */
export function openSeparator(label: string): vscode.Terminal {
  return vscode.window.createTerminal(separatorOptions(label));
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

function askSeparatorLabel(token?: vscode.CancellationToken): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Add Session Separator',
    prompt: 'Name shown on the separator tab. Empty for a plain line. Drag the tab to place it.',
    placeHolder: 'e.g. Research',
  }, token);
}

export function registerSeparators(ctx: vscode.ExtensionContext): void {
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
    vscode.window.registerTerminalProfileProvider(SEPARATOR_PROFILE_ID, {
      async provideTerminalProfile(token) {
        if (process.platform === 'win32') {
          throw new Error('Separator tabs need a POSIX shell (macOS, Linux, WSL or Remote-SSH).');
        }
        const label = await askSeparatorLabel(token);
        // A profile provider cannot decline without the panel reporting an
        // error, so Esc adds a plain line too; closing the tab removes it.
        return new vscode.TerminalProfile(separatorOptions(label ?? ''));
      },
    }),
    // The same from the tab menu or the palette, where Esc can cancel. The
    // tab still lands at the end of the list: the API cannot place it.
    vscode.commands.registerCommand(COMMAND.addSeparator, async () => {
      if (process.platform === 'win32') {
        void vscode.window.showWarningMessage('Separator tabs need a POSIX shell (macOS, Linux, WSL or Remote-SSH).');
        return;
      }
      const label = await askSeparatorLabel();
      if (label !== undefined) openSeparator(label);
    }),
    vscode.window.onDidChangeActiveTerminal(t => { if (!isWalkingTabs()) void note(t); }),
  );
}
