import * as vscode from 'vscode';

// The tab list's order as you see it. `window.terminals` lists terminals in the
// order they were opened (or restored); dragging a tab moves it in the panel
// only, and no event tells an extension. "Focus Terminal 1" lands on the
// first tab shown and "Focus Next Terminal Group" steps through the groups in
// the order shown, so walking them once and noting the active terminal at
// each step reads the real order. It moves the focus,
// so it runs only on an explicit command, and the handlers that react to a
// tab switch (unread marks, sidebar reveal, separator bounce) stand aside
// while it runs (see isWalkingTabs).

let walking = 0;
/** How long a focus step may take to show. A step that times out reads as
 *  the end of the list, so these err long: the first step can also have to
 *  open the panel. */
const FIRST_STEP_MS = 1500;
const STEP_MS = 1000;
/** The walk in progress, if any: the next one starts after it. */
let queue: Promise<unknown> = Promise.resolve();
const walkEnded = new vscode.EventEmitter<void>();

/** Fires after a walk that could not return to the tab it started on (that
 *  tab closed meanwhile): the handlers it held off catch up with the tab it
 *  left active. */
export const onTabWalkEnd = walkEnded.event;

/** True while readTabOrder is stepping through the tabs: a tab switch then
 *  is not the user looking at that tab. */
export function isWalkingTabs(): boolean {
  return walking > 0;
}

function listed(): vscode.Terminal[] {
  return vscode.window.terminals.filter(t =>
    !(t.creationOptions as vscode.TerminalOptions | undefined)?.hideFromUser);
}

/** Resolves once the active terminal is no longer `from`, or after `ms`. */
function nextActive(from: vscode.Terminal | undefined, ms: number): Promise<vscode.Terminal | undefined> {
  if (vscode.window.activeTerminal !== from) return Promise.resolve(vscode.window.activeTerminal);
  return new Promise(resolve => {
    const done = (): void => { clearTimeout(timer); sub.dispose(); resolve(vscode.window.activeTerminal); };
    const sub = vscode.window.onDidChangeActiveTerminal(done);
    const timer = setTimeout(done, ms);
  });
}

/**
 * The listed terminals in tab-list order. Terminals the walk cannot reach
 * (the other panes of a split, terminals in the editor area) follow at the
 * end in API order. Falls back to the API order when there is nothing to
 * walk or the walk goes wrong. The tab that was active is active again after.
 */
export function readTabOrder(): Promise<vscode.Terminal[]> {
  // One walk at a time: two at once move the same focus and read each
  // other's steps.
  const run = queue.then(walkTabs, walkTabs);
  queue = run.catch(() => undefined);
  return run;
}

async function walkTabs(): Promise<vscode.Terminal[]> {
  const all = listed();
  if (all.length < 2) return all;
  const start = vscode.window.activeTerminal;
  walking++;
  try {
    await vscode.commands.executeCommand('workbench.action.terminal.focusAtIndex1');
    const first = await nextActive(start, FIRST_STEP_MS);
    if (!first || !all.includes(first)) return all;
    const seen: vscode.Terminal[] = [first];
    let at = first;
    for (let i = 0; i < all.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      await vscode.commands.executeCommand('workbench.action.terminal.focusNext');
      // eslint-disable-next-line no-await-in-loop
      const t = await nextActive(at, STEP_MS);
      // Back where it began (or nowhere else to go): the round is complete.
      if (!t || t === first || t === at) break;
      if (!seen.includes(t)) seen.push(t);
      at = t;
    }
    if (seen.length < 2) return all;
    // A tab closed during the walk is not in the order; one opened during it
    // goes at the end.
    const open = listed();
    const order = [...seen.filter(t => all.includes(t)), ...all.filter(t => !seen.includes(t))]
      .filter(t => open.includes(t));
    return [...order, ...open.filter(t => !order.includes(t))];
  } catch (e) {
    console.error('[terminal-sessions] reading the tab order failed:', e);
    return all;
  } finally {
    try {
      if (start && vscode.window.activeTerminal !== start && vscode.window.terminals.includes(start)) {
        start.show(false);
        await nextActive(vscode.window.activeTerminal, STEP_MS);
      }
    } catch { /* closed between the check and the call */ }
    walking--;
    if (vscode.window.activeTerminal !== start) walkEnded.fire();
  }
}
