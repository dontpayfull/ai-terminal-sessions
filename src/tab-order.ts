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
export async function readTabOrder(): Promise<vscode.Terminal[]> {
  const all = listed();
  if (all.length < 2) return all;
  const start = vscode.window.activeTerminal;
  walking++;
  try {
    await vscode.commands.executeCommand('workbench.action.terminal.focusAtIndex1');
    const first = await nextActive(start, 400);
    if (!first || !all.includes(first)) return all;
    const seen: vscode.Terminal[] = [first];
    let at = first;
    for (let i = 0; i < all.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      await vscode.commands.executeCommand('workbench.action.terminal.focusNext');
      // eslint-disable-next-line no-await-in-loop
      const t = await nextActive(at, 400);
      // Back where it began (or nowhere else to go): the round is complete.
      if (!t || t === first || t === at) break;
      if (!seen.includes(t)) seen.push(t);
      at = t;
    }
    if (seen.length < 2) return all;
    return [...seen.filter(t => all.includes(t)), ...all.filter(t => !seen.includes(t))];
  } catch (e) {
    console.error('[terminal-sessions] reading the tab order failed:', e);
    return all;
  } finally {
    if (start && vscode.window.activeTerminal !== start && vscode.window.terminals.includes(start)) {
      start.show(false);
      await nextActive(vscode.window.activeTerminal, 400);
    }
    walking--;
  }
}
