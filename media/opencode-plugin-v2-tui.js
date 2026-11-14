// terminal-sessions opencode hook (OpenCode 2.x, TUI part)
// @terminal-sessions-hook-version 1
// Managed by the Terminal Sessions VS Code extension. Regenerated on hook
// install/upgrade — edits here are overwritten. Uninstall via the extension's
// "Uninstall AI Agent Hooks" command, or delete this directory.
//
// OpenCode 2 does not run 1.x plugins, and its server is a background service
// shared by every terminal: a server plugin no longer knows which tmux pane a
// conversation is in. The TUI part of a plugin still runs inside the `opencode`
// process of the pane (it inherits $TMUX_PANE), so everything lives here:
//   1. lifecycle events go to ~/.terminal-sessions/agent-hook.sh in the
//      Claude-Code hook vocabulary, exactly like the 1.x plugin;
//   2. the same per-conversation JSONL is appended under
//      ~/.terminal-sessions/opencode/<session-id>.jsonl.
// The line and payload formats match media/opencode-plugin.js (1.x) so the
// extension needs no version branch.
//
// Design notes:
//   • Every TUI receives the events of EVERY session on the shared server.
//     This instance only handles the family (root + subagents) of the session
//     its own screen shows; the TUI of another pane handles the others.
//   • The pane is bound to the last conversation its screen showed. Showing
//     another one (resume, session list, tab switch) is announced as a resumed
//     SessionStart; the home screen keeps the binding, so a turn that ends
//     while the user looks at the session list is still reported.
//   • A root created from the home screen is announced before the router has
//     moved to it: its events are held for a few seconds until the screen
//     shows it, then replayed in order.
//   • A conversation is reported by ONE pane: the last one whose screen opened
//     it (a small owner file next to the transcript). The extension allows a
//     conversation in one tmux session only, so two panes reporting the same
//     one would take it from each other on every event.
//   • Binding to a conversation that is already running or already waiting on
//     the user restores that state right after the SessionStart.
//   • Turn end = `session.execution.succeeded|failed|interrupted`. These are
//     explicit in OpenCode 2, so no "busy" latch is needed.
//   • No imports from `@opencode/plugin`: the default export is the plain
//     definition object, so the file has no dependency to install.

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = os.homedir()
const ROOT = path.join(HOME, ".terminal-sessions")
const FORWARDER = path.join(ROOT, "agent-hook.sh")
const TRANSCRIPT_DIR = path.join(ROOT, "opencode")
const PID = process.pid
const PREVIEW_MAX = 400
const TEXT_MAX = 2000
const OUTPUT_MAX = 4000
const MAX_TRACKED = 500

function clip(value, max) {
  try {
    const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value)
    if (!text) return ""
    return text.length > max ? text.slice(0, max) + "…" : text
  } catch {
    return ""
  }
}

/** Short label for a tool's input: the command/path/query inside it. */
function toolInputPreview(args) {
  if (!args || typeof args !== "object") return clip(args, PREVIEW_MAX)
  for (const k of ["command", "filePath", "file_path", "path", "pattern", "query", "url", "description", "prompt"]) {
    const v = args[k]
    if (typeof v === "string" && v) return clip(v, PREVIEW_MAX)
  }
  return clip(args, PREVIEW_MAX)
}

// ───────────── per-file append queue (keeps line order under racing handlers) ─────────────
const pendingLines = new Map()   // file → string[]
const flushing = new Set()
let dirReady = false

const MAX_QUEUED_LINES = 5000
const RETRY_MS = 2000

function ensureDir() {
  if (dirReady) return true
  try { fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true, mode: 0o700 }); dirReady = true } catch {}
  return dirReady
}

function retryLater(file) {
  const t = setTimeout(() => flush(file), RETRY_MS)
  if (t && typeof t.unref === "function") t.unref()
}

function flush(file) {
  if (flushing.has(file)) return
  const lines = pendingLines.get(file)
  if (!lines || lines.length === 0) { pendingLines.delete(file); return }
  if (!ensureDir()) { retryLater(file); return }
  pendingLines.set(file, [])
  flushing.add(file)
  fs.appendFile(file, lines.join(""), { mode: 0o600 }, (err) => {
    flushing.delete(file)
    if (err) {
      // Transient failure (dir removed, disk full): put the batch back in front
      // of whatever queued meanwhile and try again later — never drop silently.
      const later = pendingLines.get(file) || []
      pendingLines.set(file, lines.concat(later).slice(-MAX_QUEUED_LINES))
      retryLater(file)
      return
    }
    flush(file)
  })
}

function appendLine(file, obj) {
  try {
    const line = JSON.stringify(obj) + "\n"
    const q = pendingLines.get(file)
    if (q) { q.push(line); if (q.length > MAX_QUEUED_LINES) q.shift() }
    else pendingLines.set(file, [line])
    flush(file)
  } catch {}
}

// ───────────── forwarder (JSON on stdin, one child at a time) ─────────────
let forwarderOk = null
let forwarderCheckedAt = 0
const FORWARDER_RECHECK_MS = 30000
const FORWARDER_TIMEOUT_MS = 4000

function forwarderAvailable() {
  const now = Date.now()
  // A missing forwarder is re-checked every 30s: installing the extension's
  // hooks while OpenCode is running starts the flow without a restart.
  if (forwarderOk === null || (!forwarderOk && now - forwarderCheckedAt > FORWARDER_RECHECK_MS)) {
    forwarderCheckedAt = now
    try { fs.accessSync(FORWARDER, fs.constants.X_OK); forwarderOk = true }
    catch { forwarderOk = false }
  }
  return forwarderOk
}

// Events leave ONE AT A TIME, each waiting for the previous forwarder to exit
// (capped): every event is its own process, and without this the log order
// would follow the scheduler — a Notification landing after the Stop that
// resolves it would leave the pane "waiting" for good. The forwarder is a bash
// script (here-strings, `${var//}`), so it runs through its own shebang —
// never `/bin/sh`, which is dash on Debian-family hosts.
let chain = Promise.resolve()
function emit(event, data) {
  if (!forwarderAvailable()) return
  let payload
  try { payload = JSON.stringify({ hook_event_name: event, pid: PID, ...data }) } catch { return }
  chain = chain.then(() => new Promise((resolve) => {
    let done = false
    let timer
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve() }
    try {
      const child = spawn(FORWARDER, ["opencode", event], { stdio: ["pipe", "ignore", "ignore"] })
      timer = setTimeout(() => { try { child.kill("SIGKILL") } catch {} finish() }, FORWARDER_TIMEOUT_MS)
      child.on("error", finish)
      child.on("close", finish)
      child.stdin.on("error", () => {})
      child.stdin.end(payload)
    } catch { finish() }
  })).catch(() => {})
}

/** Text of a tool result's `content` array. */
function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
}

const ROUTE_POLL_MS = 1000
/** Event types `handle` acts on. */
const HANDLED = new Set([
  "session.created", "session.renamed", "session.deleted", "session.inbox.enqueued",
  "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
  "session.step.started", "session.step.ended", "session.step.failed", "session.text.ended",
  "session.tool.input.started", "session.tool.called", "session.tool.success", "session.tool.failed",
  "permission.asked", "permission.replied", "permission.rejected",
  "form.created", "form.replied", "form.cancelled",
])
/** `context.data.session.status()` values that mean a turn is in progress. */
const RUNNING = new Set(["running", "busy", "retry"])
const FRESH_HOLD_MS = 30000
const OWNER_CHECK_MS = 500
const FRESH_MAX_EVENTS = 200

export default {
  id: "terminal-sessions",

  setup(context) {
    // Nothing to attribute outside tmux: the extension only tracks tmux panes.
    if (!process.env.TMUX) return
    if (!context || !context.data || typeof context.data.listen !== "function") return

    // ── per-session bookkeeping (every map is bounded by `remember`) ──
    const parentOf = new Map()      // sessionID → parentID | null (only when known)
    const dirOf = new Map()         // sessionID → directory
    const titleOf = new Map()       // sessionID → last title written to the transcript
    const metaOf = new Map()        // sessionID → { agent, version }
    const cachedTitle = new Map()   // sessionID → title read from the TUI cache, not yet written
    const errored = new Map()       // sessionID → true: the turn hit a failed step
    const waiting = new Map()       // request id → { sessionID, message, kind, tool, input }
    const toolOf = new Map()        // callID → { name, input }
    const stepOf = new Map()        // assistantMessageID → { providerID, modelID, agent, started }
    const announced = new Map()     // root → true: this pane already sent a SessionStart for it
    const fresh = new Map()         // root created off-screen → { at, events: [[type, data]] }
    let bound = null                // root conversation this pane is bound to

    function remember(map, key, value) {
      if (!map.has(key) && map.size >= MAX_TRACKED) {
        // Oldest first, but never this pane's own conversation or its
        // subagents: other terminals' sessions must not push them out.
        for (const k of map.keys()) {
          if (k === bound || parentOf.get(k) === bound) continue
          map.delete(k)
          break
        }
      }
      map.set(key, value)
    }

    // ── which pane reports a conversation (one file per root, holds a pid) ──
    const ownerFile = (root) => path.join(TRANSCRIPT_DIR, root + ".owner")
    let ownerSeen = { root: null, at: 0, mine: false }
    function claim(root) {
      try {
        if (ensureDir()) fs.writeFileSync(ownerFile(root), String(PID), { mode: 0o600 })
      } catch {}
      ownerSeen = { root, at: Date.now(), mine: true }
    }
    /** True while this pane is the one reporting `root`. A pane whose owner
     *  exited (or never wrote the file) takes over. */
    function isOwner(root) {
      const now = Date.now()
      if (ownerSeen.root === root && now - ownerSeen.at < OWNER_CHECK_MS) return ownerSeen.mine
      let pid = NaN
      try { pid = parseInt(fs.readFileSync(ownerFile(root), "utf8"), 10) } catch {}
      let mine = pid === PID
      if (!mine) {
        let alive = false
        if (pid > 0) { try { process.kill(pid, 0); alive = true } catch (e) { alive = !!e && e.code === "EPERM" } }
        if (!alive) { claim(root); return true }
      }
      ownerSeen = { root, at: now, mine }
      return mine
    }
    function release(root) {
      try { if (parseInt(fs.readFileSync(ownerFile(root), "utf8"), 10) === PID) fs.unlinkSync(ownerFile(root)) } catch {}
    }

    const defaultDirectory = () => {
      try {
        const loc = context.location || context.data.location.default()
        return (loc && loc.directory) || process.cwd()
      } catch { return process.cwd() }
    }

    /** Learn a session's parent/directory/title from the TUI's own cache.
     *  Unknown stays unknown, so a later call can still find the real parent. */
    function learn(id) {
      if (typeof id !== "string") return false
      if (parentOf.has(id)) return true
      let info
      try { info = context.data.session.get(id) } catch { info = undefined }
      if (!info || typeof info !== "object") return false
      remember(parentOf, id, info.parentID || null)
      const dir = info.location && info.location.directory
      if (typeof dir === "string") remember(dirOf, id, dir)
      remember(metaOf, id, { agent: info.agent || null, version: info.version || null })
      if (typeof info.title === "string" && !titleOf.has(id)) remember(cachedTitle, id, info.title)
      return true
    }

    function rootOf(id) {
      let cur = id
      for (let i = 0; i < 16; i++) {
        if (!parentOf.has(cur)) learn(cur)
        const parent = parentOf.get(cur)
        if (!parent) return cur
        cur = parent
      }
      return cur
    }

    const isChild = (id) => !!parentOf.get(id)
    const transcriptOf = (id) => path.join(TRANSCRIPT_DIR, rootOf(id) + ".jsonl")

    function base(id) {
      const b = {
        session_id: rootOf(id),
        cwd: dirOf.get(rootOf(id)) || defaultDirectory(),
        transcript_path: transcriptOf(id),
      }
      if (isChild(id)) {
        // Tagging with agent_id makes the extension drop the event from pane
        // state (same mechanism as Claude teammates/subagents).
        b.agent_id = id
        b.agent_type = "subagent"
        b.session_id = id
      }
      return b
    }

    /** Write the `session` header line when the title is new for this id. */
    function writeSession(id, title) {
      const t = typeof title === "string" ? title : ""
      if (titleOf.has(id) && titleOf.get(id) === t) return
      remember(titleOf, id, t)
      cachedTitle.delete(id)
      const meta = metaOf.get(id) || {}
      appendLine(transcriptOf(id), {
        ts: Date.now(),
        type: "session",
        id,
        parentID: parentOf.get(id) || null,
        directory: dirOf.get(id) || defaultDirectory(),
        title: t,
        agent: meta.agent || null,
        version: meta.version || null,
      })
    }

    /** The reducer needs a `session` header before a session's first record:
     *  write the ones still missing, ancestors first (a subagent that existed
     *  before this pane showed its conversation has none yet). */
    function ensureHeaders(id) {
      const chain = []
      let cur = id
      for (let i = 0; i < 16 && typeof cur === "string"; i++) {
        chain.unshift(cur)
        cur = parentOf.get(cur)
      }
      for (const sid of chain) {
        if (!titleOf.has(sid)) writeSession(sid, cachedTitle.has(sid) ? cachedTitle.get(sid) : "")
      }
    }

    /** The root session on screen, or null on the home/plugin screens. */
    function shownRoot() {
      let route
      try { route = context.ui.router.current() } catch { return null }
      if (!route || route.type !== "session" || typeof route.sessionID !== "string") return null
      return rootOf(route.sessionID)
    }

    const sessionStatus = (id) => {
      try { return context.data.session.status(id) } catch { return undefined }
    }

    /** Bind the pane to `root` and announce it. `created` = the session.created
     *  payload when this TUI saw the conversation being born. */
    function bind(root, created) {
      if (bound && bound !== root) release(bound)
      bound = root
      claim(root)
      const first = !announced.has(root)
      remember(announced, root, true)
      learn(root)
      ensureHeaders(root)
      // Renamed while another conversation was on screen: the TUI's record has
      // the current title, the transcript still the old one.
      if (!created) {
        let info
        try { info = context.data.session.get(root) } catch { info = undefined }
        if (info && typeof info.title === "string" && info.title !== titleOf.get(root)) writeSession(root, info.title)
      }
      if (created && first) {
        emit("SessionStart", { ...base(root), title: created.title || null })
        return
      }
      emit("SessionStart", { ...base(root), title: titleOf.get(root) || null, resumed: true, source: "resume" })
      // A SessionStart reads as "idle". Restore what the conversation is doing:
      // a turn in progress (OpenCode 2 reports "running"), then any wait.
      if (RUNNING.has(sessionStatus(root))) emit("PostToolUse", { ...base(root), tool_name: "", tool_input: "" })
      for (const w of waiting.values()) {
        if (rootOf(w.sessionID) === root) emit("Notification", { ...base(w.sessionID), message: w.message, kind: w.kind })
      }
      void adoptPending(root)
    }

    /** Requests that were asked before this pane was bound to the conversation
     *  (another terminal, or before this TUI started) are only in the server's
     *  list: fetch it and report the ones not announced yet. */
    async function adoptPending(root) {
      const data = context.data.session
      try {
        await Promise.allSettled([
          Promise.resolve(data.permission && data.permission.sync && data.permission.sync(root)),
          Promise.resolve(data.form && data.form.sync && data.form.sync(root, context.location)),
        ])
        if (bound !== root) return
        let perms, forms
        try { perms = data.permission.list(root) } catch { perms = undefined }
        try { forms = data.form.list(root, context.location) } catch { forms = undefined }
        for (const p of Array.isArray(perms) ? perms : []) handle("permission.asked", p)
        for (const f of Array.isArray(forms) ? forms : []) handle("form.created", { form: f })
      } catch {}
    }

    /** Follow the screen. The home screen keeps the current binding. */
    function checkRoute() {
      const root = shownRoot()
      if (!root || root === bound) return
      const held = fresh.get(root)
      fresh.delete(root)
      bind(root, held ? held.created : undefined)
      if (held) for (const [type, data] of held.events) dispatch(type, data)
    }

    /** True when the session belongs to the conversation this pane is bound to. */
    function owned(id) {
      if (typeof id !== "string") return false
      checkRoute()
      if (bound === null || rootOf(id) !== bound) return false
      // Another pane opened this conversation since: it reports it now.
      if (!isOwner(bound)) return false
      if (id !== bound) ensureHeaders(id)
      return true
    }

    /** Session id an event is about, for the "held until shown" queue. */
    const sessionIdOf = (d) => d.sessionID || (d.form && d.form.sessionID) || undefined

    function dropExpiredFresh() {
      const now = Date.now()
      for (const [id, held] of fresh) if (now - held.at > FRESH_HOLD_MS) fresh.delete(id)
    }

    function dispatch(type, d) {
      // Streaming deltas and the rest are not ours: they must not fill the
      // hold queue of a conversation that is about to be shown.
      if (!HANDLED.has(type)) return
      // Events of a root that was just created but is not on screen yet wait
      // for the router (or expire: it was another terminal's conversation).
      if (type !== "session.created" && fresh.size) {
        const sid = sessionIdOf(d)
        const held = typeof sid === "string" ? fresh.get(rootOf(sid)) : undefined
        if (held) {
          checkRoute()
          const still = fresh.get(rootOf(sid))
          if (still) {
            if (still.events.length < FRESH_MAX_EVENTS) still.events.push([type, d])
            return
          }
        }
      }
      handle(type, d)
    }

    function handle(type, d) {
      switch (type) {
        case "session.created": {
          const id = d.sessionID
          if (typeof id !== "string") break
          if (d.parentID) {
            // A subagent: only worth remembering inside our own conversation.
            if (bound === null || rootOf(d.parentID) !== bound) {
              const held = fresh.get(rootOf(d.parentID))
              if (held && held.events.length < FRESH_MAX_EVENTS) held.events.push([type, d])
              break
            }
          }
          remember(parentOf, id, d.parentID || null)
          const dir = d.location && d.location.directory
          if (typeof dir === "string") remember(dirOf, id, dir)
          remember(metaOf, id, { agent: d.agent || null, version: d.version || null })
          if (typeof d.title === "string") remember(cachedTitle, id, d.title)
          if (d.parentID) { ensureHeaders(id); break }
          // A root: ours when the screen shows it — now, or within a few seconds.
          if (shownRoot() === id) { bind(id, d); break }
          dropExpiredFresh()
          remember(fresh, id, { at: Date.now(), created: d, events: [] })
          break
        }

        case "session.renamed": {
          const id = d.sessionID
          if (typeof d.title !== "string") break
          if (!owned(id)) { if (cachedTitle.has(id)) remember(cachedTitle, id, d.title); break }
          writeSession(id, d.title)
          break
        }

        case "session.deleted": {
          const id = d.sessionID
          if (typeof id !== "string") break
          // The conversation on this pane is gone: say so before forgetting it.
          if (bound === id) {
            if (isOwner(id)) emit("SessionEnd", { ...base(id), reason: "deleted" })
            release(id)
          }
          errored.delete(id); announced.delete(id); fresh.delete(id)
          parentOf.delete(id); dirOf.delete(id); titleOf.delete(id); metaOf.delete(id); cachedTitle.delete(id)
          for (const [rid, w] of waiting) if (w.sessionID === id) waiting.delete(rid)
          if (bound === id) bound = null
          break
        }

        case "session.inbox.enqueued": {
          const id = d.sessionID
          const item = d.item
          if (!owned(id) || !item || item.type !== "user") break
          // A new prompt starts a clean turn.
          errored.delete(id)
          const text = clip(item.payload && item.payload.text, TEXT_MAX)
          appendLine(transcriptOf(id), {
            ts: Date.now(), type: "user", sessionID: id,
            messageID: d.inboxID || null, agent: (metaOf.get(id) || {}).agent || null, text,
          })
          emit("UserPromptSubmit", { ...base(id), message: clip(text, PREVIEW_MAX) })
          break
        }

        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted": {
          const id = d.sessionID
          if (typeof id !== "string") break
          // Bookkeeping ends with the turn, whoever reports it.
          const hadError = errored.delete(id)
          for (const [rid, w] of waiting) if (w.sessionID === id) waiting.delete(rid)
          if (!owned(id)) break
          const wasError = hadError || type === "session.execution.failed"
          appendLine(transcriptOf(id), { ts: Date.now(), type: "turn_end", sessionID: id, error: wasError })
          emit("Stop", { ...base(id), error: wasError })
          break
        }

        case "session.step.started": {
          if (!owned(d.sessionID) || typeof d.assistantMessageID !== "string") break
          const m = d.model || {}
          remember(stepOf, d.assistantMessageID, {
            providerID: m.providerID || null, modelID: m.id || null,
            agent: d.agent || null, started: d.started || null,
          })
          break
        }

        case "session.step.ended": {
          const id = d.sessionID
          if (typeof d.assistantMessageID !== "string") break
          let step = stepOf.get(d.assistantMessageID)
          stepOf.delete(d.assistantMessageID)
          if (!owned(id)) break
          if (!step) {
            // The step started before this pane was bound: the session's own
            // record still says which model and agent it runs on.
            let info
            try { info = context.data.session.get(id) } catch { info = undefined }
            const m = (info && info.model) || {}
            step = { providerID: m.providerID || null, modelID: m.id || null, agent: (info && info.agent) || null, started: null }
          }
          const t = d.tokens || {}
          const cache = t.cache || {}
          const input = t.input || 0, output = t.output || 0, reasoning = t.reasoning || 0
          const cacheRead = cache.read || 0, cacheWrite = cache.write || 0
          appendLine(transcriptOf(id), {
            ts: Date.now(),
            type: "assistant",
            sessionID: id,
            messageID: d.assistantMessageID,
            providerID: step.providerID || null,
            modelID: step.modelID || null,
            agent: step.agent || null,
            cost: typeof d.cost === "number" ? d.cost : 0,
            tokens: { input, output, reasoning, cacheRead, cacheWrite, total: input + output + reasoning + cacheRead + cacheWrite },
            finish: d.finish || null,
            error: null,
            created: step.started || null,
            completed: Date.now(),
          })
          break
        }

        case "session.step.failed": {
          const id = d.sessionID
          if (!owned(id)) break
          const err = d.error || {}
          remember(errored, id, true)
          appendLine(transcriptOf(id), {
            ts: Date.now(), type: "error", sessionID: id,
            name: err.type || err.name || null,
            message: clip(err.message || (err.data && err.data.message), PREVIEW_MAX) || null,
          })
          break
        }

        case "session.text.ended": {
          const id = d.sessionID
          if (!owned(id) || typeof d.text !== "string" || !d.text) break
          appendLine(transcriptOf(id), {
            ts: Date.now(), type: "text", sessionID: id,
            messageID: d.assistantMessageID || null, role: "assistant", text: clip(d.text, TEXT_MAX),
          })
          break
        }

        case "session.tool.input.started": {
          if (owned(d.sessionID) && typeof d.id === "string" && typeof d.name === "string") remember(toolOf, d.id, { name: d.name, input: "" })
          break
        }

        case "session.tool.called": {
          const id = d.sessionID
          if (!owned(id) || typeof d.id !== "string") break
          const tool = (toolOf.get(d.id) || {}).name || null
          const input = toolInputPreview(d.input)
          remember(toolOf, d.id, { name: tool, input })
          appendLine(transcriptOf(id), {
            ts: Date.now(), type: "tool", sessionID: id, messageID: d.assistantMessageID || null,
            callID: d.id, tool, status: "running", input, title: null, start: Date.now(), end: null,
          })
          // The question itself is the wait (`form.created` follows); a
          // PreToolUse after it would flip the pane back to "running a tool".
          if (tool === "question") break
          emit("PreToolUse", { ...base(id), tool_name: tool || "tool", tool_input: input })
          break
        }

        case "session.tool.success":
        case "session.tool.failed": {
          const id = d.sessionID
          if (typeof d.id !== "string") break
          const tool = (toolOf.get(d.id) || {}).name || null
          toolOf.delete(d.id)
          if (!owned(id)) break
          const failed = type === "session.tool.failed"
          const err = d.error || {}
          appendLine(transcriptOf(id), {
            ts: Date.now(), type: "tool", sessionID: id, messageID: d.assistantMessageID || null,
            callID: d.id, tool, status: failed ? "error" : "completed", input: "", title: null,
            output: failed ? undefined : clip(contentText(d.content), OUTPUT_MAX),
            error: failed ? clip(err.message || err.type, PREVIEW_MAX) : undefined,
            start: null, end: Date.now(),
          })
          emit("PostToolUse", { ...base(id), tool_name: tool || "tool", tool_input: "" })
          break
        }

        case "permission.asked": {
          const id = d.sessionID
          if (!owned(id) || typeof d.id !== "string") break
          if (waiting.has(d.id)) break                  // repeats happen; notify once
          const message = "OpenCode needs your permission to use " + (d.action || "a tool")
            + (Array.isArray(d.resources) && d.resources.length ? " (" + clip(d.resources.join(", "), PREVIEW_MAX) + ")" : "")
          const call = (d.source && toolOf.get(d.source.id)) || {}
          remember(waiting, d.id, { sessionID: id, message, kind: "permission", tool: call.name || d.action || "tool", input: call.input || "" })
          emit("Notification", { ...base(id), message, kind: "permission" })
          break
        }

        case "form.created": {
          const form = d.form
          if (!form || !owned(form.sessionID) || typeof form.id !== "string") break
          if (waiting.has(form.id)) break
          const field = Array.isArray(form.fields) ? form.fields[0] : null
          const ask = clip((field && (field.description || field.title)) || form.title || "", PREVIEW_MAX)
          const message = "OpenCode asks: " + (ask || "question needs your answer")
          remember(waiting, form.id, { sessionID: form.sessionID, message, kind: "question" })
          emit("Notification", { ...base(form.sessionID), message, kind: "question" })
          break
        }

        // The answer ends the wait even when nothing else follows for a while
        // (a long tool, a long thinking step): say what the pane does now.
        case "permission.replied":
        case "permission.rejected": {
          const w = typeof d.requestID === "string" ? waiting.get(d.requestID) : undefined
          if (!w) break
          waiting.delete(d.requestID)
          if (!owned(w.sessionID)) break
          const allowed = type === "permission.replied" && d.reply !== "reject"
          if (allowed) emit("PreToolUse", { ...base(w.sessionID), tool_name: w.tool, tool_input: w.input })
          else emit("PostToolUse", { ...base(w.sessionID), tool_name: w.tool, tool_input: "" })
          break
        }

        case "form.replied":
        case "form.cancelled": {
          const w = typeof d.id === "string" ? waiting.get(d.id) : undefined
          if (!w) break
          waiting.delete(d.id)
          if (owned(w.sessionID)) emit("PostToolUse", { ...base(w.sessionID), tool_name: "question", tool_input: "" })
          break
        }
      }
    }

    const stop = context.data.listen((x) => {
      try {
        const details = x && x.details
        if (!details || typeof details.type !== "string") return
        dispatch(details.type, details.data || {})
      } catch {}
    })

    // The route changes without a server event when the user opens another
    // conversation from the list; poll it cheaply.
    const poll = setInterval(() => { try { checkRoute(); dropExpiredFresh() } catch {} }, ROUTE_POLL_MS)
    if (poll && typeof poll.unref === "function") poll.unref()
    try { checkRoute() } catch {}

    return () => {
      clearInterval(poll)
      try { if (typeof stop === "function") stop() } catch {}
      if (bound && isOwner(bound)) {
        emit("SessionEnd", { ...base(bound), reason: "shutdown" })
        release(bound)
      }
    }
  },
}
