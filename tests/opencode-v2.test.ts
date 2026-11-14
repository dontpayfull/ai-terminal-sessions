// OpenCode 2 support: the TUI-part plugin (media/opencode-plugin-v2-tui.js),
// the `session_v2` database schema, the two-file hook install and the fork
// command that works on both major versions.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  opencodeProvider,
  setOpencodePluginSource,
  PLUGIN_PATH,
  PLUGIN_V2_PATH,
} from '../src/agents/opencode/provider';
import { listOpencodeSessions, opencodeSessionDirectory } from '../src/agents/opencode/storage';

const REPO = path.resolve(__dirname, '..', '..');
const PLUGIN_V1_SRC = path.join(REPO, 'media', 'opencode-plugin.js');
const PLUGIN_V2_SRC = path.join(REPO, 'media', 'opencode-plugin-v2-tui.js');

function sqlite3(): string | undefined {
  for (const c of ['/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3', '/usr/local/bin/sqlite3']) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

// ───────────────────────── plugin: events → hooks + transcript ─────────────────────────

/** Runs the plugin in a child Node process against a fake TUI context and
 *  returns the hook calls and the transcript lines it produced. */
function runPlugin(script: string): { hooks: any[]; lines: Record<string, any[]> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-oc2-'));
  try {
    const home = path.join(dir, 'home');
    const root = path.join(home, '.terminal-sessions');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'agent-hook.sh'),
      '#!/bin/bash\nprintf \'%s\\n\' "$(cat)" >> "$HOME/hooks.log"\n', { mode: 0o755 });
    fs.copyFileSync(PLUGIN_V2_SRC, path.join(dir, 'tui.mjs'));
    fs.writeFileSync(path.join(dir, 'driver.mjs'), `
      import plugin from './tui.mjs'
      let route = { type: 'home' }
      let listener
      const sessions = new Map()
      const context = {
        location: { directory: '/work/app' },
        ui: { router: { current: () => route } },
        data: {
          listen: (fn) => { listener = fn; return () => { listener = undefined } },
          session: { get: (id) => sessions.get(id) },
          location: { default: () => ({ directory: '/work/app' }) },
        },
      }
      const cleanup = plugin.setup(context)
      const fire = (type, data) => listener && listener({ name: type, details: { type, data } })
      const show = (sessionID) => { route = sessionID ? { type: 'session', sessionID } : { type: 'home' } }
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      ${script}
      if (typeof cleanup === 'function') cleanup()
      await sleep(600)
    `);
    const r = spawnSync(process.execPath, [path.join(dir, 'driver.mjs')], {
      env: { ...process.env, HOME: home, USERPROFILE: home, TMUX: '/tmp/tmux-test,1,0', TMUX_PANE: '%9' },
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(r.status, 0, r.stderr);
    const read = (f: string) => fs.existsSync(f)
      ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    const lines: Record<string, any[]> = {};
    const tdir = path.join(root, 'opencode');
    for (const f of fs.existsSync(tdir) ? fs.readdirSync(tdir).filter(n => n.endsWith('.jsonl')) : []) lines[f.replace(/\.jsonl$/, '')] = read(path.join(tdir, f));
    return { hooks: read(path.join(home, 'hooks.log')), lines };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const TURN = `
  show('ses_A')
  fire('session.created', { sessionID: 'ses_A', version: '2.3.0', agent: 'build', location: { directory: '/work/app' } })
  fire('session.inbox.enqueued', { sessionID: 'ses_A', inboxID: 'msg_1', item: { type: 'user', payload: { text: 'run echo hi' } } })
  fire('session.execution.started', { sessionID: 'ses_A' })
  fire('session.step.started', { sessionID: 'ses_A', agent: 'build', assistantMessageID: 'msg_2', started: 5, model: { id: 'gpt-x', providerID: 'openai' } })
  fire('session.renamed', { sessionID: 'ses_A', title: 'Shell echo command' })
  fire('session.tool.input.started', { sessionID: 'ses_A', id: 'call_1', name: 'shell' })
  fire('session.tool.called', { sessionID: 'ses_A', assistantMessageID: 'msg_2', id: 'call_1', input: { command: 'echo hi' } })
  fire('permission.asked', { id: 'per_1', sessionID: 'ses_A', action: 'shell', resources: ['echo hi'], source: { type: 'tool', messageID: 'msg_2', id: 'call_1' } })
  fire('permission.replied', { sessionID: 'ses_A', requestID: 'per_1', reply: 'once' })
  fire('session.tool.success', { sessionID: 'ses_A', assistantMessageID: 'msg_2', id: 'call_1', content: [{ type: 'text', text: 'hi\\n' }] })
  fire('session.step.ended', { sessionID: 'ses_A', assistantMessageID: 'msg_2', finish: 'tool-calls', cost: 0.5, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } } })
  fire('session.text.ended', { sessionID: 'ses_A', assistantMessageID: 'msg_3', text: 'done' })
  fire('session.execution.succeeded', { sessionID: 'ses_A' })
`;

test('OpenCode 2 plugin maps a turn to Claude-style hooks and the 1.x transcript format', () => {
  const { hooks, lines } = runPlugin(TURN);
  assert.deepEqual(hooks.map(h => h.hook_event_name), [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd',
  ]);
  for (const h of hooks) {
    assert.equal(h.session_id, 'ses_A');
    assert.equal(h.cwd, '/work/app');
    assert.ok(String(h.transcript_path).endsWith('/.terminal-sessions/opencode/ses_A.jsonl'));
    assert.equal(typeof h.pid, 'number');
  }
  assert.equal(hooks[2].tool_name, 'shell');
  assert.equal(hooks[2].tool_input, 'echo hi');
  assert.equal(hooks[3].kind, 'permission');
  assert.match(hooks[3].message, /permission to use shell \(echo hi\)/);
  // Allowing the permission puts the pane back on the tool it was waiting for.
  assert.equal(hooks[4].tool_name, 'shell');
  assert.equal(hooks[4].tool_input, 'echo hi');
  assert.equal(hooks[6].error, false);

  const t = lines.ses_A;
  assert.deepEqual(t.map(l => l.type), ['session', 'user', 'session', 'tool', 'tool', 'assistant', 'text', 'turn_end']);
  assert.equal(t[0].directory, '/work/app');
  assert.equal(t[2].title, 'Shell echo command');
  assert.equal(t[3].status, 'running');
  assert.equal(t[4].status, 'completed');
  assert.equal(t[4].output, 'hi\n');
  assert.equal(t[5].providerID, 'openai');
  assert.equal(t[5].modelID, 'gpt-x');
  assert.deepEqual(t[5].tokens, { input: 10, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 1, total: 21 });

  // The extension's own reducer reads these lines without a version branch.
  const state: any = {
    snapshot: { tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate5m: 0 }, cost: 0, costByModel: {}, messageCount: 0, maxContextSeen: 0 },
    seenMessageIds: new Set(), subagentMap: new Map(), sessionId: 'ses_A',
  };
  assert.doesNotThrow(() => { for (const l of t) opencodeProvider.reduceTranscriptLine(state, JSON.stringify(l)); });
});

test('OpenCode 2 plugin ignores sessions shown in another terminal and tags subagents', () => {
  const { hooks, lines } = runPlugin(`
    show('ses_A')
    fire('session.created', { sessionID: 'ses_A', location: { directory: '/work/app' } })
    // Another pane's conversation on the same shared server.
    fire('session.created', { sessionID: 'ses_B', location: { directory: '/work/other' } })
    fire('session.inbox.enqueued', { sessionID: 'ses_B', inboxID: 'm', item: { type: 'user', payload: { text: 'not mine' } } })
    fire('session.execution.started', { sessionID: 'ses_B' })
    fire('session.execution.succeeded', { sessionID: 'ses_B' })
    // A subagent of the conversation on screen.
    fire('session.created', { sessionID: 'ses_C', parentID: 'ses_A', title: 'helper', agent: 'general', location: { directory: '/work/app' } })
    fire('session.inbox.enqueued', { sessionID: 'ses_C', inboxID: 'm2', item: { type: 'user', payload: { text: 'sub prompt' } } })
    fire('form.created', { form: { id: 'frm_1', sessionID: 'ses_A', title: 'Questions', fields: [{ description: 'Red or blue?' }] } })
  `);
  assert.ok(!hooks.some(h => h.session_id === 'ses_B'));
  assert.equal(lines.ses_B, undefined);
  const sub = hooks.find(h => h.agent_id === 'ses_C');
  assert.equal(sub.hook_event_name, 'UserPromptSubmit');
  assert.equal(sub.agent_type, 'subagent');
  assert.ok(lines.ses_A.some(l => l.type === 'session' && l.id === 'ses_C' && l.parentID === 'ses_A'));
  assert.equal(lines.ses_C, undefined);
  const q = hooks.find(h => h.hook_event_name === 'Notification');
  assert.equal(q.kind, 'question');
  assert.equal(q.message, 'OpenCode asks: Red or blue?');
});

test('OpenCode 2 plugin announces a resumed conversation and reports failed turns', () => {
  const { hooks, lines } = runPlugin(`
    sessions.set('ses_R', { id: 'ses_R', title: 'Old talk', agent: 'build', location: { directory: '/work/old' } })
    show('ses_R')
    await sleep(1300)
    fire('session.execution.started', { sessionID: 'ses_R' })
    fire('session.step.failed', { sessionID: 'ses_R', error: { type: 'provider.auth', message: 'API key not valid' } })
    fire('session.execution.failed', { sessionID: 'ses_R' })
  `);
  assert.equal(hooks[0].hook_event_name, 'SessionStart');
  assert.equal(hooks[0].source, 'resume');
  assert.equal(hooks[0].cwd, '/work/old');
  assert.equal(hooks[0].title, 'Old talk');
  const stop = hooks.find(h => h.hook_event_name === 'Stop');
  assert.equal(stop.error, true);
  assert.deepEqual(lines.ses_R.map(l => l.type), ['session', 'error', 'turn_end']);
  assert.equal(lines.ses_R[0].title, 'Old talk');
  assert.equal(lines.ses_R[1].message, 'API key not valid');
});

test('OpenCode 2 plugin holds a new conversation until the screen shows it', () => {
  const { hooks, lines } = runPlugin(`
    // The server announces the session before the router leaves the home screen.
    fire('session.created', { sessionID: 'ses_N', agent: 'build', location: { directory: '/work/app' } })
    fire('session.inbox.enqueued', { sessionID: 'ses_N', inboxID: 'm', item: { type: 'user', payload: { text: 'first prompt' } } })
    fire('session.execution.started', { sessionID: 'ses_N' })
    // Another terminal's new conversation never reaches this screen.
    fire('session.created', { sessionID: 'ses_X', location: { directory: '/work/other' } })
    fire('session.inbox.enqueued', { sessionID: 'ses_X', inboxID: 'x', item: { type: 'user', payload: { text: 'not mine' } } })
    show('ses_N')
    fire('session.execution.succeeded', { sessionID: 'ses_N' })
  `);
  assert.deepEqual(hooks.map(h => h.hook_event_name), ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']);
  assert.equal(hooks[0].source, undefined);            // a fresh start, not a resume
  assert.equal(hooks[1].message, 'first prompt');
  assert.ok(hooks.every(h => h.session_id === 'ses_N'));
  assert.deepEqual(lines.ses_N.map(l => l.type), ['session', 'user', 'turn_end']);
  assert.equal(lines.ses_X, undefined);
});

test('OpenCode 2 plugin keeps the binding on the home screen and restores a wait on return', () => {
  const { hooks } = runPlugin(`
    show('ses_A')
    fire('session.created', { sessionID: 'ses_A', location: { directory: '/work/app' } })
    fire('session.execution.started', { sessionID: 'ses_A' })
    // The user opens the session list while the turn runs: still reported.
    show(null)
    fire('session.tool.input.started', { sessionID: 'ses_A', id: 'call_1', name: 'shell' })
    fire('session.tool.called', { sessionID: 'ses_A', id: 'call_1', input: { command: 'make' } })
    fire('permission.asked', { id: 'per_1', sessionID: 'ses_A', action: 'shell', resources: ['make'], source: { id: 'call_1' } })
    // Another conversation is opened and closed again; the wait must come back.
    sessions.set('ses_B', { id: 'ses_B', title: 'Other', location: { directory: '/work/b' } })
    show('ses_B'); await sleep(1200)
    show('ses_A'); await sleep(1200)
    // The turn of the conversation left behind still cleans up without a hook.
    fire('permission.rejected', { sessionID: 'ses_A', requestID: 'per_1' })
    fire('session.execution.interrupted', { sessionID: 'ses_A' })
  `);
  assert.deepEqual(hooks.map(h => `${h.hook_event_name}:${h.session_id}`), [
    'SessionStart:ses_A', 'PreToolUse:ses_A', 'Notification:ses_A',
    'SessionStart:ses_B',
    'SessionStart:ses_A', 'Notification:ses_A',
    'PostToolUse:ses_A', 'Stop:ses_A', 'SessionEnd:ses_A',
  ]);
  assert.equal(hooks[4].source, 'resume');
  assert.equal(hooks[5].kind, 'permission');
});

test('OpenCode 2 plugin restores a running turn and writes headers for subagents that already exist', () => {
  const { hooks, lines } = runPlugin(`
    sessions.set('ses_R', { id: 'ses_R', title: 'Busy talk', location: { directory: '/work/app' } })
    sessions.set('ses_K', { id: 'ses_K', parentID: 'ses_R', title: 'helper', agent: 'general', location: { directory: '/work/app' } })
    context.data.session.status = () => 'busy'
    show('ses_R'); await sleep(1200)
    fire('session.text.ended', { sessionID: 'ses_K', assistantMessageID: 'm', text: 'pong' })
    fire('session.execution.succeeded', { sessionID: 'ses_R' })
  `);
  assert.deepEqual(hooks.map(h => h.hook_event_name), ['SessionStart', 'PostToolUse', 'Stop', 'SessionEnd']);
  const t = lines.ses_R;
  assert.deepEqual(t.map(l => `${l.type}:${l.id || l.sessionID}`), ['session:ses_R', 'session:ses_K', 'text:ses_K', 'turn_end:ses_R']);
  assert.equal(t[1].parentID, 'ses_R');
  assert.equal(t[1].agent, 'general');
  assert.equal(lines.ses_K, undefined);
});

test('OpenCode 2 plugin adopts requests asked before it was bound and survives a flood of deltas', () => {
  const { hooks, lines } = runPlugin(`
    sessions.set('ses_W', { id: 'ses_W', title: 'Renamed elsewhere', agent: 'build', model: { id: 'gpt-x', providerID: 'openai' }, location: { directory: '/work/app' } })
    context.data.session.permission = {
      sync: async () => {},
      list: () => [{ id: 'per_9', sessionID: 'ses_W', action: 'shell', resources: ['make deploy'] }],
    }
    context.data.session.form = { sync: async () => {}, list: () => [] }
    show('ses_W'); await sleep(1300)
    // A step that started before the binding still gets its model.
    fire('session.step.ended', { sessionID: 'ses_W', assistantMessageID: 'msg_late', finish: 'stop', tokens: { input: 1, output: 1 } })

    // A new conversation whose stream outruns the router.
    fire('session.created', { sessionID: 'ses_F', location: { directory: '/work/app' } })
    fire('session.inbox.enqueued', { sessionID: 'ses_F', inboxID: 'm', item: { type: 'user', payload: { text: 'go' } } })
    for (let i = 0; i < 500; i++) fire('session.text.delta', { sessionID: 'ses_F', delta: 'x' })
    fire('session.execution.succeeded', { sessionID: 'ses_F' })
    show('ses_F'); await sleep(1300)
    // The conversation on screen is deleted.
    fire('session.deleted', { sessionID: 'ses_F' })
  `);
  assert.deepEqual(hooks.map(h => `${h.hook_event_name}:${h.session_id}`), [
    'SessionStart:ses_W', 'Notification:ses_W',
    'SessionStart:ses_F', 'UserPromptSubmit:ses_F', 'Stop:ses_F', 'SessionEnd:ses_F',
  ]);
  assert.match(hooks[1].message, /permission to use shell \(make deploy\)/);
  assert.equal(hooks[5].reason, 'deleted');
  assert.equal(lines.ses_W[0].title, 'Renamed elsewhere');
  const late = lines.ses_W.find(l => l.type === 'assistant');
  assert.equal(late.providerID, 'openai');
  assert.equal(late.modelID, 'gpt-x');
});

test('OpenCode 2 plugin lets one pane report a conversation: the last one that opened it', () => {
  const { hooks } = runPlugin(`
    const owner = process.env.HOME + '/.terminal-sessions/opencode/ses_A.owner'
    const fsx = await import('node:fs')
    show('ses_A')
    fire('session.created', { sessionID: 'ses_A', location: { directory: '/work/app' } })
    await sleep(100)
    // Another terminal (a live process) opened the same conversation.
    fsx.writeFileSync(owner, String(process.ppid))
    await sleep(700)
    fire('session.inbox.enqueued', { sessionID: 'ses_A', inboxID: 'm1', item: { type: 'user', payload: { text: 'theirs' } } })
    fire('session.execution.succeeded', { sessionID: 'ses_A' })
    // It moved on (or exited): this pane reports again.
    fsx.unlinkSync(owner)
    await sleep(700)
    fire('session.inbox.enqueued', { sessionID: 'ses_A', inboxID: 'm2', item: { type: 'user', payload: { text: 'mine again' } } })
  `);
  assert.deepEqual(hooks.map(h => `${h.hook_event_name}:${h.message ?? ''}`), [
    'SessionStart:', 'UserPromptSubmit:mine again', 'SessionEnd:',
  ]);
});

// ───────────────────────── database: session_v2 ─────────────────────────

test('OpenCode 2 database: sessions come from session_v2 with the first prompt', { skip: !sqlite3() }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-oc2-db-'));
  const db = path.join(dir, 'opencode.db');
  const before = process.env.OPENCODE_DB;
  try {
    execFileSync(sqlite3()!, [db, `
      CREATE TABLE session_v2 (id TEXT, parent_id TEXT, directory TEXT, title TEXT, agent TEXT, model TEXT,
        cost REAL, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT);
      INSERT INTO session_v2 VALUES
        ('ses_aaaaaaaaaaaaaaaaaaaaaaaa', NULL, '/work/app', 'Shell echo command', 'build', '{"id":"gpt-x","providerID":"openai"}', 0.5, 1, 20, NULL),
        ('ses_bbbbbbbbbbbbbbbbbbbbbbbb', NULL, '/work/app/sub', NULL, 'build', NULL, 0, 2, 30, NULL),
        ('ses_cccccccccccccccccccccccc', 'ses_aaaaaaaaaaaaaaaaaaaaaaaa', '/work/app', 'child', 'general', NULL, 0, 3, 40, NULL),
        ('ses_dddddddddddddddddddddddd', NULL, '/elsewhere', 'Other project', 'build', NULL, 0, 4, 50, NULL),
        ('ses_eeeeeeeeeeeeeeeeeeeeeeee', NULL, '/work/app', 'Archived', 'build', NULL, 0, 5, 60, 7);
      INSERT INTO session_message VALUES
        ('msg_2', 'ses_aaaaaaaaaaaaaaaaaaaaaaaa', 'assistant', 2, '{"content":[]}'),
        ('msg_3', 'ses_aaaaaaaaaaaaaaaaaaaaaaaa', 'user', 3, '{"text":"second prompt"}'),
        ('msg_0', 'ses_aaaaaaaaaaaaaaaaaaaaaaaa', 'user', 0, '{"text":"","files":["a.png"]}'),
        ('msg_1', 'ses_aaaaaaaaaaaaaaaaaaaaaaaa', 'user', 1, '{"text":"first   prompt"}');
    `]);
    process.env.OPENCODE_DB = db;
    const rows = listOpencodeSessions('/work/app');
    assert.deepEqual(rows.map(r => r.id), ['ses_bbbbbbbbbbbbbbbbbbbbbbbb', 'ses_aaaaaaaaaaaaaaaaaaaaaaaa']);
    assert.equal(rows[0].title, '');
    assert.equal(rows[1].title, 'Shell echo command');
    assert.equal(rows[1].model, 'openai/gpt-x');
    assert.equal(rows[1].firstUserMessage, 'first prompt');
    assert.equal(opencodeSessionDirectory('ses_dddddddddddddddddddddddd'), '/elsewhere');
  } finally {
    if (before === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────── hook install + fork command ─────────────────────────

test('OpenCode hook install writes the 1.x file and the 2.x TUI part', { skip: !!process.env.XDG_CONFIG_HOME }, async () => {
  const read = (f: string) => () => fs.readFileSync(f, 'utf8');
  setOpencodePluginSource(read(PLUGIN_V1_SRC), read(PLUGIN_V2_SRC));
  assert.equal(await opencodeProvider.installHook(''), true);
  assert.equal(fs.readFileSync(PLUGIN_PATH, 'utf8'), fs.readFileSync(PLUGIN_V1_SRC, 'utf8'));
  assert.equal(fs.readFileSync(PLUGIN_V2_PATH, 'utf8'), fs.readFileSync(PLUGIN_V2_SRC, 'utf8'));
  assert.equal(opencodeProvider.needsHookUpgrade(), false);

  // An install that predates OpenCode 2 support is upgraded to add the part.
  fs.unlinkSync(PLUGIN_V2_PATH);
  assert.equal(opencodeProvider.needsHookUpgrade(), true);
  // A foreign file at our path is never overwritten, and is not ours to upgrade.
  fs.writeFileSync(PLUGIN_V2_PATH, 'export default {}\n');
  assert.equal(await opencodeProvider.installHook(''), true);
  assert.equal(fs.readFileSync(PLUGIN_V2_PATH, 'utf8'), 'export default {}\n');
  assert.equal(opencodeProvider.needsHookUpgrade(), false);
  fs.unlinkSync(PLUGIN_V2_PATH);

  // An OpenCode 2 user who removed the 1.x file still counts as installed,
  // and a foreign 1.x file does not block the 2.x part.
  assert.equal(await opencodeProvider.installHook(''), true);
  fs.writeFileSync(PLUGIN_PATH, '// someone else\n');
  assert.equal(opencodeProvider.isHookInstalled(), true);
  assert.equal(opencodeProvider.needsHookUpgrade(), false);
  fs.unlinkSync(PLUGIN_V2_PATH);
  assert.equal(await opencodeProvider.installHook(''), true);
  assert.equal(fs.existsSync(PLUGIN_V2_PATH), true);
  assert.equal(await opencodeProvider.uninstallHook(), true);
  assert.equal(fs.readFileSync(PLUGIN_PATH, 'utf8'), '// someone else\n');
  assert.equal(opencodeProvider.isHookInstalled(), false);
  fs.unlinkSync(PLUGIN_PATH);

  assert.equal(await opencodeProvider.installHook(''), true);
  assert.equal(await opencodeProvider.uninstallHook(), true);
  assert.equal(fs.existsSync(PLUGIN_PATH), false);
  assert.equal(fs.existsSync(path.dirname(PLUGIN_V2_PATH)), false);
});

test('OpenCode resume command drops 1.x-only flags on OpenCode 2, and stays plain when it can', () => {
  const id = 'ses_aaaaaaaaaaaaaaaaaaaaaaaa';
  assert.equal(opencodeProvider.buildResumeCommand(id, '/work/app', undefined, ['--auto', '--standalone']),
    `opencode -s '${id}' '--auto' '--standalone'`);
  assert.equal(opencodeProvider.buildResumeCommand(id, '/work/app'), `opencode -s '${id}'`);
  const cmd = opencodeProvider.buildResumeCommand(id, '/work/app', undefined, ['--model', 'openai/gpt-x', '--yolo']);
  assert.equal(cmd, `case "$(opencode --version 2>/dev/null | tail -1)" in *v[2-9].*|[2-9].*) opencode -s '${id}' '--auto' ;; `
    + `*) opencode -s '${id}' '--model' 'openai/gpt-x' '--yolo' ;; esac`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-oc2-resume-'));
  try {
    const run = (version: string) => {
      fs.writeFileSync(path.join(dir, 'opencode'),
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'warning: config notice'; echo '${version}'; exit 0; fi\necho "$*"\n`, { mode: 0o755 });
      return spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` } }).stdout.trim();
    };
    assert.equal(run('opencode v2.3.0'), `-s ${id} --auto`);
    assert.equal(run('opencode v3.0.1'), `-s ${id} --auto`);
    assert.equal(run('1.19.4'), `-s ${id} --model openai/gpt-x --yolo`);
    assert.equal(run('1.2.0'), `-s ${id} --model openai/gpt-x --yolo`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OpenCode fork command covers the 1.x flag and the 2.x server API', () => {
  const flags = ['--model', 'openai/gpt-x', '--yolo', '--server', 'http://remote:4096'];
  const cmd = opencodeProvider.buildForkCommand!('ses_aaaaaaaaaaaaaaaaaaaaaaaa', '/work/app', undefined, flags);
  assert.match(cmd, /^case "\$\(opencode --version 2>\/dev\/null \| tail -1\)" in /);
  // 1.x keeps every captured flag.
  assert.ok(cmd.includes(`*) opencode -s 'ses_aaaaaaaaaaaaaaaaaaaaaaaa' --fork '--model' 'openai/gpt-x' '--yolo' '--server' 'http://remote:4096' ;; esac`));
  // 2.x: the fork is made on the same server the TUI opens, with the flags
  // the 2.x TUI still has, and a failure says so instead of doing nothing.
  assert.ok(cmd.includes(`opencode api session.fork '--server' 'http://remote:4096' --param sessionID='ses_aaaaaaaaaaaaaaaaaaaaaaaa' -d '{}'`));
  assert.ok(cmd.includes(`then opencode -s "$f" '--auto' '--server' 'http://remote:4096'; else echo`));
  assert.ok(!/opencode -s "\$f"[^;]*--model/.test(cmd));

  // Run it for real against a fake `opencode` on PATH, once per major version.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-oc2-fork-'));
  try {
    const fake = (version: string, reply: string) => {
      fs.writeFileSync(path.join(dir, 'opencode'), [
        '#!/bin/sh',
        `if [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi`,
        `if [ "$1" = "api" ]; then echo "api $*" >> "${dir}/calls"; cat <<'JSON'`,
        reply,
        'JSON',
        'exit 0; fi',
        `echo "tui $*" >> "${dir}/calls"`,
      ].join('\n'), { mode: 0o755 });
      fs.rmSync(path.join(dir, 'calls'), { force: true });
      const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` } });
      const calls = fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n') : [];
      return { calls, stderr: r.stderr };
    };
    const pretty = '{\n  "data": {\n    "id": "ses_new0000000000000000000",\n    "fork": { "sessionID": "ses_aaaaaaaaaaaaaaaaaaaaaaaa" }\n  }\n}';
    assert.deepEqual(fake('opencode v2.3.0', pretty).calls, [
      "api api session.fork --server http://remote:4096 --param sessionID=ses_aaaaaaaaaaaaaaaaaaaaaaaa -d {}",
      'tui -s ses_new0000000000000000000 --auto --server http://remote:4096',
    ]);
    const broken = fake('opencode v2.3.0', '{"_tag":"InvalidRequestError"}');
    assert.equal(broken.calls.length, 1);
    assert.match(broken.stderr, /could not fork this conversation/);
    assert.deepEqual(fake('1.19.4', '').calls, [
      'tui -s ses_aaaaaaaaaaaaaaaaaaaaaaaa --fork --model openai/gpt-x --yolo --server http://remote:4096',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
