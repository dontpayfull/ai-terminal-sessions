// Preloaded into every test process (see the `test` script). Two jobs:
//
// 1. Point HOME at a fresh temp folder before any source module loads, so
//    nothing under test can read or write the real ~/.terminal-sessions,
//    ~/.claude or ~/.codex. Modules compute those paths at load time.
// 2. Answer `require('vscode')` with a small stand-in. The real module only
//    exists inside an extension host; the logic tested here only needs its
//    shapes (EventEmitter, configuration defaults, a few enums).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Module = require('module');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } });

type Listener<T> = (e: T) => unknown;

class EventEmitter<T> {
  private listeners = new Set<Listener<T>>();
  readonly event = (fn: Listener<T>) => {
    this.listeners.add(fn);
    return { dispose: () => { this.listeners.delete(fn); } };
  };
  fire(e: T): void { for (const fn of [...this.listeners]) fn(e); }
  dispose(): void { this.listeners.clear(); }
}

class Disposable {
  constructor(private fn: () => void = () => undefined) {}
  static from(...items: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => items.forEach(i => i.dispose()));
  }
  dispose(): void { this.fn(); }
}

class ThemeColor { constructor(readonly id: string) {} }
class ThemeIcon { constructor(readonly id: string, readonly color?: ThemeColor) {} }
class MarkdownString {
  constructor(public value = '') {}
  appendMarkdown(s: string): this { this.value += s; return this; }
  appendText(s: string): this { this.value += s; return this; }
}

class Uri {
  private constructor(readonly scheme: string, readonly path: string, readonly query = '') {}
  static file(p: string): Uri { return new Uri('file', p); }
  static parse(s: string): Uri {
    const m = /^([a-z][\w+.-]*):(?:\/\/[^/]*)?([^?]*)(?:\?(.*))?$/i.exec(s);
    return m ? new Uri(m[1], m[2], m[3] ?? '') : new Uri('file', s);
  }
  get fsPath(): string { return this.path; }
  toString(): string { return `${this.scheme}://${this.path}`; }
}

/** Settings the test sets; anything else falls back to the caller's default. */
export const settings = new Map<string, unknown>();

const noopEvent = () => ({ dispose: () => undefined });

/** Anything not modelled resolves to a callable no-op, so importing a module
 *  that touches vscode at load time does not throw. */
function loose(name: string): unknown {
  const fn = () => undefined;
  return new Proxy(fn, {
    get: (_t, prop) => (prop === 'then' ? undefined : loose(`${name}.${String(prop)}`)),
    apply: () => undefined,
  });
}

const vscode = {
  EventEmitter, Disposable, ThemeColor, ThemeIcon, MarkdownString, Uri,
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  FileDecoration: class { constructor(readonly badge?: string, readonly tooltip?: string, readonly color?: ThemeColor) {} },
  workspace: {
    getConfiguration: (section?: string) => ({
      get: <T>(key: string, def?: T): T | undefined => {
        const full = section ? `${section}.${key}` : key;
        return settings.has(full) ? settings.get(full) as T : def;
      },
      update: async () => undefined,
      inspect: () => undefined,
    }),
    onDidChangeConfiguration: noopEvent,
    workspaceFolders: undefined,
  },
  window: {
    terminals: [] as unknown[],
    activeTerminal: undefined,
    onDidOpenTerminal: noopEvent,
    onDidCloseTerminal: noopEvent,
    onDidChangeActiveTerminal: noopEvent,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    setStatusBarMessage: () => ({ dispose: () => undefined }),
    createOutputChannel: () => ({ appendLine: () => undefined, append: () => undefined, show: () => undefined, dispose: () => undefined }),
  },
  env: { sessionId: 'test-session', appName: 'Visual Studio Code', clipboard: { writeText: async () => undefined, readText: async () => '' } },
  commands: { executeCommand: async () => undefined, registerCommand: () => ({ dispose: () => undefined }) },
};

const stub = new Proxy(vscode as Record<string, unknown>, {
  get: (t, prop: string) => (prop in t ? t[prop] : loose(`vscode.${prop}`)),
});

const mod = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const realLoad = mod._load;
mod._load = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return stub;
  return realLoad.call(this, request, ...rest);
};
