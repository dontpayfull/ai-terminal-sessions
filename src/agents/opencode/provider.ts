import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentProvider, AgentSessionSummary, TranscriptTailState } from '../types';
import { commandOnPath } from '../detect';
import { FlagSpec, captureFlags, withFlags } from '../launch-flags';
import { posixQuote } from '../../shell-escape';
import {
  reduceOpencodeTranscriptLine,
  readOpencodeTranscriptSummary,
  readOpencodeTranscriptCwd,
  isDefaultOpencodeTitle,
} from './transcript';
import {
  OPENCODE_SESSION_ID_RE,
  contextLimitForModelString,
  listOpencodeSessions,
  opencodeSessionDirectory,
} from './storage';

const SESSION_ID_RE = OPENCODE_SESSION_ID_RE;

const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, 'opencode')
  : path.join(os.homedir(), '.config', 'opencode');
/** The one file we install. OpenCode loads every `plugin/*.{js,ts}` in its
 *  config dir as a plugin, so nothing in opencode.json needs to change. */
export const PLUGIN_PATH = path.join(CONFIG_DIR, 'plugin', 'terminal-sessions.js');
/** OpenCode 2 does not run 1.x plugins, and its server is a background service
 *  shared by every terminal, so the 2.x plugin is a TUI part: a directory under
 *  `plugins/` holding `tui.js`. 1.x only loads direct files and ignores it; 2.x
 *  logs one warning for the 1.x file and moves on. Both are installed, so the
 *  integration survives an upgrade (or a downgrade) of OpenCode itself. */
export const PLUGIN_V2_DIR = path.join(CONFIG_DIR, 'plugins', 'terminal-sessions');
export const PLUGIN_V2_PATH = path.join(PLUGIN_V2_DIR, 'tui.js');
/** Where our plugin writes the per-conversation JSONL we tail. */
export const TRANSCRIPT_DIR = path.join(os.homedir(), '.terminal-sessions', 'opencode');

const HOOK_VERSION_RE = /^\/\/ @terminal-sessions-hook-version (\d+)/m;

// OpenCode "character" launch flags. `--session/-s`, `--continue/-c`, `--fork`,
// `--prompt` and `--port/--hostname` are launch-specific and deliberately NOT
// carried; the positional project dir is dropped too (resume cd's into the
// recorded directory instead). `--auto` is the auto-approve switch; `--yolo`
// and `--dangerously-skip-permissions` are its hidden aliases.
const OPENCODE_FLAGS: FlagSpec = {
  // `--standalone` / `--server` are OpenCode 2 (private or remote server
  // instead of the background service); 2.x dropped `--model` and `--agent`
  // from the TUI, and argv only ever carries what the running binary accepted.
  bool: ['--auto', '--yolo', '--dangerously-skip-permissions', '--mini', '--pure', '--standalone'],
  value: {
    '--model': {},
    '--agent': {},
    '--log-level': {},
    '--server': {},
  },
  alias: { '-m': '--model' },
};

/** `opencode --version` of OpenCode 2 and later ("opencode v2.3.0"); 1.x
 *  prints the bare number ("1.19.4"). A shell `case` pattern. */
const V2_VERSION = '*v[2-9].*|[2-9].*';
/** Launch flags the OpenCode 2 TUI accepts, from a captured set that may come
 *  from a 1.x process (2.x dropped `--model`, `--agent`, `--mini`, `--pure`,
 *  and knows only `--auto` for auto-approve). */
const V2_BOOL = new Set(['--auto', '--standalone']);
const V2_VALUE = new Set(['--server', '--log-level']);
const V2_AUTO_ALIAS = new Set(['--yolo', '--dangerously-skip-permissions']);
function v2Flags(flags: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const list = flags ?? [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const eq = f.indexOf('=');
    const name = eq > 0 ? f.slice(0, eq) : f;
    if (V2_AUTO_ALIAS.has(name)) { if (!out.includes('--auto')) out.push('--auto'); continue; }
    if (V2_BOOL.has(name)) { if (!out.includes(name)) out.push(name); continue; }
    const takesValue = name in (OPENCODE_FLAGS.value ?? {});
    if (V2_VALUE.has(name)) {
      out.push(f);
      if (eq < 0 && i + 1 < list.length) out.push(list[++i]);
    } else if (takesValue && eq < 0) {
      i++;   // skip the value of a flag 2.x does not have
    }
  }
  return out;
}
/** The server-selection flags of a 2.x flag set (`opencode api` takes them too). */
function serverFlags(flags: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const name = flags[i].split('=')[0];
    if (name === '--standalone') out.push(flags[i]);
    else if (name === '--server') {
      out.push(flags[i]);
      if (!flags[i].includes('=') && i + 1 < flags.length) out.push(flags[++i]);
    }
  }
  return out;
}

// The plugin emits Claude-Code hook names, so the tracker needs no OpenCode branch.
const OPENCODE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

/** Reads the version marker of an installed plugin file, 0 when absent/foreign. */
function installedPluginVersion(file: string = PLUGIN_PATH): number {
  let head: string;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(512);
    const n = fs.readSync(fd, b, 0, 512, 0);
    head = b.toString('utf8', 0, n);
  } catch { return 0; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } } }
  const m = head.match(HOOK_VERSION_RE);
  return m ? parseInt(m[1], 10) : 0;
}

/** The plugin source shipped with this build of the extension. Resolved from
 *  the forwarder path (…/.terminal-sessions/agent-hook.sh) at install time so
 *  the provider stays free of the VS Code extension context. */
let bundledPluginSource: (() => string | undefined) | undefined;
let bundledPluginV2Source: (() => string | undefined) | undefined;
export function setOpencodePluginSource(
  reader: () => string | undefined,
  readerV2?: () => string | undefined,
): void {
  bundledPluginSource = reader;
  bundledPluginV2Source = readerV2;
}

/** Write one plugin file atomically. Only ever replaces a file that is ours
 *  (marker in the head) or absent. */
function writePluginFile(file: string, src: string): boolean {
  try {
    if (fs.existsSync(file) && installedPluginVersion(file) === 0) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, src, { mode: 0o644 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
function bundledPluginVersion(src: string): number {
  const m = src.match(HOOK_VERSION_RE);
  return m ? parseInt(m[1], 10) : 0;
}

function safeReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir); }
  catch { return []; }
}

function transcriptPathFor(sessionId: string): string {
  return path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
}

export const opencodeProvider: AgentProvider = {
  id: 'opencode',
  displayName: 'OpenCode',
  badge: 'opencode',
  badgeIcon: 'code',
  // `opencode -s <id>` finds a session from any directory (the db is global),
  // but the instance binds to the cwd it starts in — project config, agents,
  // MCP servers and the title bar all follow it — so resume cd's back first.
  resumeNeedsCwd: true,
  supportsFork: true,
  hookEvents: OPENCODE_HOOK_EVENTS,

  isInstalled(): boolean {
    if (commandOnPath('opencode')) return true;
    // The curl installer drops the binary in ~/.opencode/bin, which a GUI-
    // launched IDE's PATH often lacks.
    return fs.existsSync(path.join(os.homedir(), '.opencode', 'bin', 'opencode'));
  },

  settingsPath(): string {
    return PLUGIN_PATH;
  },

  installHook(_forwarderPath: string): Promise<boolean> {
    const src = bundledPluginSource?.();
    if (!src) return Promise.resolve(false);
    // The two parts are independent: a foreign or unwritable file at one path
    // must not keep the other major version of OpenCode untracked.
    const ok = writePluginFile(PLUGIN_PATH, src);
    const srcV2 = bundledPluginV2Source?.();
    const okV2 = srcV2 ? writePluginFile(PLUGIN_V2_PATH, srcV2) : false;
    return Promise.resolve(ok || okV2);
  },

  uninstallHook(): Promise<boolean> {
    try {
      const hadV1 = installedPluginVersion() > 0;
      const hadV2 = installedPluginVersion(PLUGIN_V2_PATH) > 0;
      if (!hadV1 && !hadV2) return Promise.resolve(false);
      if (hadV2) {
        try { fs.unlinkSync(PLUGIN_V2_PATH); } catch { /* reported below */ }
        try { fs.rmdirSync(PLUGIN_V2_DIR); } catch { /* not empty: never a user's files */ }
      }
      if (hadV1) {
        try { fs.unlinkSync(PLUGIN_PATH); } catch { /* reported below */ }
      }
      // Success only when no plugin of ours is left behind to keep running.
      return Promise.resolve(installedPluginVersion() === 0 && installedPluginVersion(PLUGIN_V2_PATH) === 0);
    } catch {
      return Promise.resolve(false);
    }
  },

  isHookInstalled(): boolean {
    // Either part counts: an OpenCode 2 user may have removed the 1.x file.
    return installedPluginVersion() > 0 || installedPluginVersion(PLUGIN_V2_PATH) > 0;
  },

  needsHookUpgrade(): boolean {
    const installed = installedPluginVersion();
    const installedV2 = installedPluginVersion(PLUGIN_V2_PATH);
    if (installed === 0 && installedV2 === 0) return false;
    const src = bundledPluginSource?.();
    if (src && installed > 0 && bundledPluginVersion(src) > installed) return true;
    const srcV2 = bundledPluginV2Source?.();
    if (!srcV2) return false;
    if (installedV2 > 0) return bundledPluginVersion(srcV2) > installedV2;
    // Installs that predate OpenCode 2 support get the 2.x part the same way.
    // A foreign file at that path is left alone (and is not ours to upgrade).
    return installed > 0 && !fs.existsSync(PLUGIN_V2_PATH);
  },

  isValidSessionId(id: string): boolean {
    return SESSION_ID_RE.test(id);
  },

  resolveTranscriptPath(sessionId: string, _cwd: string, hintedPath?: string): string | undefined {
    if (hintedPath && fs.existsSync(hintedPath)) return hintedPath;
    if (!SESSION_ID_RE.test(sessionId)) return undefined;
    // Our plugin writes the file on the first event; return the computed path so
    // the tailer starts watching and picks it up when it appears.
    return transcriptPathFor(sessionId);
  },

  reduceTranscriptLine(state: TranscriptTailState, line: string): boolean {
    return reduceOpencodeTranscriptLine(state, line);
  },

  contextLimitFor(model: string | undefined): number {
    return contextLimitForModelString(model) ?? 200_000;
  },

  // The npm package ships the binary as `opencode.exe` on every platform.
  processNames: ['opencode', 'opencode.exe'],

  captureResumeFlags(argv: readonly string[]): string[] {
    return captureFlags(argv, OPENCODE_FLAGS);
  },

  // `--auto` = "auto-approve permissions that are not explicitly denied"; the
  // two hidden aliases mean the same. Argv reflects the INITIAL mode only — the
  // TUI can toggle auto-approve at runtime — but a live permission prompt is
  // reported by the plugin regardless, so the ⚠ is never wrong.
  yolo: {
    on: ['--auto'],
    off: ['--auto', '--yolo', '--dangerously-skip-permissions'],
  },

  buildResumeCommand(
    sessionId: string,
    terminalCwd: string,
    transcriptPath?: string,
    extraFlags?: readonly string[],
  ): string {
    const recorded = (transcriptPath ? readOpencodeTranscriptCwd(transcriptPath) : undefined)
      ?? opencodeSessionDirectory(sessionId);
    const id = posixQuote(sessionId);
    const v1 = withFlags(`opencode -s ${id}`, extraFlags, OPENCODE_FLAGS);
    // Flags captured from a 1.x process (`--model`, `--agent`, `--yolo`) make
    // the 2.x TUI exit with a usage error. Only when the set differs between
    // the two versions does the pane's shell pick the form to run.
    const flagsV2 = v2Flags(extraFlags);
    const same = flagsV2.length === (extraFlags?.length ?? 0) && flagsV2.every((f, i) => f === extraFlags![i]);
    const cmd = same ? v1
      : `case "$(opencode --version 2>/dev/null | tail -1)" in ${V2_VERSION}) ${withFlags(`opencode -s ${id}`, flagsV2, OPENCODE_FLAGS)} ;; *) ${v1} ;; esac`;
    return recorded && recorded !== terminalCwd ? `cd ${posixQuote(recorded)} && ${cmd}` : cmd;
  },

  buildForkCommand(
    sessionId: string,
    terminalCwd: string,
    transcriptPath?: string,
    extraFlags?: readonly string[],
  ): string {
    // `--fork` with `-s` branches the conversation into a NEW session id
    // ("<title> (fork #N)") and opens that, so both branches can run live.
    // OpenCode 2 has no such flag on the TUI: the fork is made through the
    // server API and the new id is opened. Which binary the pane will run is
    // only known in the pane, so the shell picks the form there.
    const recorded = (transcriptPath ? readOpencodeTranscriptCwd(transcriptPath) : undefined)
      ?? opencodeSessionDirectory(sessionId);
    const id = posixQuote(sessionId);
    const v1 = withFlags(`opencode -s ${id} --fork`, extraFlags, OPENCODE_FLAGS);
    const flagsV2 = v2Flags(extraFlags);
    const v2 = withFlags('opencode -s "$f"', flagsV2, OPENCODE_FLAGS);
    // The fork must be made on the server the TUI will then open it on.
    const api = withFlags('opencode api session.fork', serverFlags(flagsV2), OPENCODE_FLAGS);
    // First `"id"` of the reply is the new session's (`data.id`); the pattern
    // does not depend on the JSON being compact or on one line.
    const fork = `${api} --param sessionID=${id} -d '{}'`
      + ` | grep -o '"id" *: *"ses_[0-9A-Za-z]*"' | head -1 | grep -o 'ses_[0-9A-Za-z]*'`;
    const failed = `echo 'Terminal Sessions: OpenCode could not fork this conversation' >&2`;
    const branch = `case "$(opencode --version 2>/dev/null | tail -1)" in`
      + ` ${V2_VERSION}) f=$(${fork}); if [ -n "$f" ]; then ${v2}; else ${failed}; fi ;;`
      + ` *) ${v1} ;; esac`;
    return recorded && recorded !== terminalCwd ? `cd ${posixQuote(recorded)} && ${branch}` : branch;
  },

  listSessions(cwd?: string): AgentSessionSummary[] {
    const out = new Map<string, AgentSessionSummary>();
    // OpenCode's own database is the complete history (conversations that
    // predate our plugin included) …
    for (const r of listOpencodeSessions(cwd)) {
      const tp = transcriptPathFor(r.id);
      const hasTp = fs.existsSync(tp);
      const s = hasTp ? readOpencodeTranscriptSummary(tp) : undefined;
      out.set(r.id, {
        agent: 'opencode',
        sessionId: r.id,
        transcriptPath: hasTp ? tp : undefined,
        cwd: r.directory,
        firstUserMessage: s?.firstUserMessage ?? r.firstUserMessage,
        autoTitle: !isDefaultOpencodeTitle(r.title) ? r.title : s?.autoTitle,
        lineCount: s?.lineCount,
        byteSize: s?.byteSize,
        mtimeMs: r.timeUpdated,
      });
    }
    // … and our transcripts cover the case where sqlite3 is missing or the db
    // moved: anything we recorded is still listable and resumable.
    for (const f of safeReaddir(TRANSCRIPT_DIR)) {
      if (!f.endsWith('.jsonl')) continue;
      const sessionId = f.slice(0, -'.jsonl'.length);
      if (!SESSION_ID_RE.test(sessionId) || out.has(sessionId)) continue;
      const tp = path.join(TRANSCRIPT_DIR, f);
      const s = readOpencodeTranscriptSummary(tp);
      // No root header = a subagent's stray file (older plugin), not a conversation.
      if (!s || !s.isRoot) continue;
      if (cwd && s.cwd) {
        const a = s.cwd.replace(/\/+$/, '');
        const b = cwd.replace(/\/+$/, '');
        if (a !== b && !a.startsWith(b + '/')) continue;
      }
      out.set(sessionId, {
        agent: 'opencode',
        sessionId,
        transcriptPath: tp,
        cwd: s.cwd,
        firstUserMessage: s.firstUserMessage,
        autoTitle: s.autoTitle,
        lineCount: s.lineCount,
        byteSize: s.byteSize,
        mtimeMs: s.mtimeMs,
      });
    }
    return [...out.values()].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  },

  readTranscriptSummary(transcriptPath: string) {
    return readOpencodeTranscriptSummary(transcriptPath);
  },
};
