import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { SEPARATOR_PROFILE_ID } from './config';

/**
 * Separator tabs: named dividers in the native terminal tab list, dragged
 * into place like any other tab. Each one is a real (if idle) process, so the
 * panel keeps it in position across a window reload, unlike a pty-backed tab
 * the extension would have to recreate at the end of the list. The process is
 * a single `sleep`: about 1 MB, no CPU, no tmux.
 *
 * Clicking a separator would only show an empty screen, so focus bounces
 * straight back to the tab that was active before.
 */

const PREFIX = '──';
// Long enough to never end (about 68 years) and unusual enough that a
// reload-restored separator, which has lost its creationOptions, can be told
// apart by its process command line.
const SLEEP_ARG = '2147483647';
const SLEEP_COMMAND = `sleep ${SLEEP_ARG}`;
// Hide the cursor and keyboard echo, print the name dimmed, then become the
// sleep. The name arrives as $1, never inside the script text.
const SCRIPT = `printf '\\033[?25l\\033[2J\\033[H'; stty -echo 2>/dev/null; `
  + `printf '\\n  \\033[2m%s\\033[0m\\n' "$1"; exec sleep ${SLEEP_ARG}`;

function separatorName(label: string): string {
  const trimmed = label.trim().slice(0, 60);
  return trimmed ? `${PREFIX} ${trimmed} ${PREFIX}` : PREFIX.repeat(6);
}

function separatorOptions(label: string): vscode.TerminalOptions {
  const name = separatorName(label);
  return {
    name,
    shellPath: '/bin/sh',
    shellArgs: ['-c', SCRIPT, 'terminal-sessions-separator', name],
    iconPath: new vscode.ThemeIcon('dash'),
  };
}

const known = new WeakMap<vscode.Terminal, boolean>();

function processCommand(pid: number): Promise<string> {
  return new Promise(resolve => {
    execFile('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 2000 }, (err, out) => {
      resolve(err ? '' : out.trim());
    });
  });
}

/** True for a separator tab, including one restored by a window reload. */
export async function isSeparator(t: vscode.Terminal): Promise<boolean> {
  const cached = known.get(t);
  if (cached !== undefined) return cached;
  const opts = t.creationOptions as vscode.TerminalOptions | undefined;
  const args = opts && !('pty' in opts) ? opts.shellArgs : undefined;
  if (Array.isArray(args) && args.includes('terminal-sessions-separator')) {
    known.set(t, true);
    return true;
  }
  // A reload-restored tab has no shellArgs: ask its process. Not cached when
  // the pid is not known yet, so a later switch asks again.
  const pid = await t.processId;
  if (!pid) return false;
  const result = (await processCommand(pid)) === SLEEP_COMMAND;
  known.set(t, result);
  return result;
}

export function registerSeparators(ctx: vscode.ExtensionContext): void {
  let lastReal: vscode.Terminal | undefined;
  const note = async (t: vscode.Terminal | undefined): Promise<void> => {
    if (!t) return;
    if (await isSeparator(t)) {
      // The user may have moved on while `ps` ran.
      if (vscode.window.activeTerminal !== t) return;
      if (lastReal && lastReal !== t && !lastReal.exitStatus
          && vscode.window.terminals.includes(lastReal)) {
        lastReal.show(false);
      }
      return;
    }
    lastReal = t;
  };
  void note(vscode.window.activeTerminal);

  ctx.subscriptions.push(
    vscode.window.registerTerminalProfileProvider(SEPARATOR_PROFILE_ID, {
      async provideTerminalProfile(token) {
        const label = await vscode.window.showInputBox({
          title: 'Add Separator',
          prompt: 'Name shown on the separator tab. Empty for a plain line. Drag the tab to place it.',
          placeHolder: 'e.g. Research',
        }, token);
        // A profile provider cannot decline without the panel reporting an
        // error, so Esc adds a plain line too; closing the tab removes it.
        return new vscode.TerminalProfile(separatorOptions(label ?? ''));
      },
    }),
    vscode.window.onDidChangeActiveTerminal(t => { void note(t); }),
  );
}
