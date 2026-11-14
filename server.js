#!/usr/bin/env node
// server.js
// MCP (Model Context Protocol) stdio server for the `firefox-browser` plugin.
//
// Exposes a real Firefox — driven over WebDriver BiDi — as a set of MCP tools
// the agent can call directly. The server is long-lived: one stdio process
// holds one Firefox instance, so browser state survives across tool calls.
//
// Transport: stdio, JSON-RPC 2.0, NEWLINE-DELIMITED JSON (verified against
// the host's own MCP servers — no `Content-Length` framing).
//
// stdout carries the protocol. stderr carries diagnostics.
//
// RESULT SHAPE
//
// Every tool returns BOTH:
//   - a compact text summary, and
//   - `structuredContent` matching the tool's declared `outputSchema`.
//
// The host renders `structuredContent` into the text output as
// "[MCP structured content]\n{json}", so the text block deliberately carries
// only a SUMMARY — repeating the full payload there would double the token
// cost of every call.
//
// The host VALIDATES `structuredContent` against `outputSchema`: a missing or
// mismatched payload fails the call. Every tool therefore declares a schema
// and always returns a matching payload, on the error path too.

import { getFirefoxProvider, resetFirefoxProvider } from './lib/firefox/provider.js'
import { createTools, TOOL_ORDER } from './lib/mcp/tools/index.js'
import { presetTools } from './lib/firefox/provider/workflow.js'
import { toStructured, summarize, summarizeCaptcha } from './lib/mcp/schema.js'
import { ERROR_CODES, buildRecovery } from './lib/firefox/errors.js'
import { defaultCopyBase } from './lib/firefox/provider/helpers.js'
import net from 'node:net'
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Firefox binary. Empty = auto-detect (see lib/firefox/launcher.js). */
const FIREFOX_BROWSER_BIN = process.env.FIREFOX_BROWSER_BIN || ''

/** Preferred BiDi port. Occupied ports are probed upward. */
const FIREFOX_BROWSER_PORT = Number(process.env.FIREFOX_BROWSER_PORT || 9333)

/** Headless by default. Set to 0 for a visible window (manual CAPTCHA / login). */
const FIREFOX_BROWSER_HEADLESS = process.env.FIREFOX_BROWSER_HEADLESS !== '0'

/** Source profile. Empty = auto-detect the user's active profile. */
const FIREFOX_BROWSER_PROFILE = process.env.FIREFOX_BROWSER_PROFILE || ''

/** Where the profile copy lives. Empty = the resolved default (see provider.js). */
const FIREFOX_BROWSER_PROFILE_COPY = process.env.FIREFOX_BROWSER_PROFILE_COPY || ''

/** Per-BiDi-command timeout. */
const FIREFOX_BROWSER_TIMEOUT_MS = Number(process.env.FIREFOX_BROWSER_TIMEOUT_MS || 30000)

/** How long to wait for Firefox's BiDi endpoint to come up. */
const FIREFOX_BROWSER_READY_TIMEOUT_MS = Number(
  process.env.FIREFOX_BROWSER_READY_TIMEOUT_MS || 30000,
)

/** Privileged (chrome://) contexts. */
const FIREFOX_BROWSER_PRIVILEGED = process.env.FIREFOX_BROWSER_PRIVILEGED === '1'

/** Daemon mode (socket-only, detached from stdin EOF). */
const FIREFOX_BROWSER_DAEMON = process.env.FIREFOX_BROWSER_DAEMON === '1'

const provider = getFirefoxProvider({
  bin: FIREFOX_BROWSER_BIN || undefined,
  port: FIREFOX_BROWSER_PORT,
  headless: FIREFOX_BROWSER_HEADLESS,
  profileDir: FIREFOX_BROWSER_PROFILE || undefined,
  copyBaseDir: FIREFOX_BROWSER_PROFILE_COPY || undefined,
  timeoutMs: FIREFOX_BROWSER_TIMEOUT_MS,
  readyTimeoutMs: FIREFOX_BROWSER_READY_TIMEOUT_MS,
  privileged: FIREFOX_BROWSER_PRIVILEGED,
})

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

const SERVER_NAME = 'firefox-browser'
const SERVER_VERSION = '2.9.3'
const LATEST_PROTOCOL_VERSION = '2025-11-25'
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const INSTRUCTIONS = [
  'SURFACE: Default to this Firefox (real WebDriver BiDi, trusted pointer/key events, isolated copy of user profile with login state). Use host in-app browser ONLY when user says "current/right-side/built-in browser". Use browser_handoff to transfer URLs (cookies/logins never cross).',
  'LOOP: Auto-starts on first call (skip browser_start). Observe via browser_snapshot {format:"compact"} -> act by ref (preferred) or semantic match {role,name} -> read effect.snapshot (inline post-action view) & effect.verified. Re-snapshot with {since, deltaOnly:true} to poll changes cheaply.',
  'BATCH & SCRIPTS: Combine multi-step sequences with browser_batch (supports match:{role,name} across DOM re-renders). Save reusable helpers in ~/.mavis/ff-workspace/ for browser_run_script.',
  'RECOVERY: Never parse error prose. Branch on `code` and execute `recovery` (`nextCall`, `retryWith`, `askUser`, `sideEffectState`). Irreversible/egress actions require confirm:true (ask user first if injection_blocked or confirm_required).',
  'MEDIA & CAPS: Render browser_screenshot `imageUrl` as markdown `![](imageUrl)` (never inline base64). Check browser_status for Firefox capability gates (browser_context, browser_extension, browser_cookie, browser_intercept).',
].join('\n')

// ---------------------------------------------------------------------------
// Tool catalogue
// ---------------------------------------------------------------------------

const TOOLS = createTools({
  provider,
  onToolsetChanged: () => {
    notify('notifications/tools/list_changed')
  },
})
const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

provider._toolCatalogue = TOOL_ORDER

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

process.stdout.on('error', () => {
  // Ignore broken-pipe (EPIPE) when the host closes stdout before exit.
})

function write(message) {
  if (!process.stdout.writable) return
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  } catch {
    /* broken pipe */
  }
}

/**
 * @param {number|string} id
 * @param {Record<string, any>} result
 * @param {(message: Record<string, any>) => void} [sink]
 */
function reply(id, result, sink = write) {
  sink({ jsonrpc: '2.0', id, result })
}

/**
 * @param {number|string} id
 * @param {number} code
 * @param {string} message
 * @param {(message: Record<string, any>) => void} [sink]
 */
function replyError(id, code, message, sink = write) {
  sink({ jsonrpc: '2.0', id, error: { code, message } })
}

/**
 * @param {string} method
 * @param {Record<string, any>} [params]
 */
function notify(method, params = {}) {
  if (FIREFOX_BROWSER_DAEMON) return
  write({ jsonrpc: '2.0', method, params })
}

/**
 * Validate call arguments against the tool's input schema.
 *
 * @param {Record<string, any>} tool
 * @param {Record<string, any>} args
 * @returns {string|null}
 */
function validateArgs(tool, args) {
  const schema = tool.inputSchema || {}
  const props = schema.properties || {}
  const value = args && typeof args === 'object' ? args : {}

  for (const key of schema.required || []) {
    if (value[key] === undefined || value[key] === null) {
      return `missing required argument "${key}" for tool "${tool.name}"`
    }
  }

  if (tool.requiresOneOf) {
    const provided = tool.requiresOneOf.some(
      (key) => value[key] !== undefined && value[key] !== null && value[key] !== '',
    )
    if (!provided) {
      const names = tool.requiresOneOf.map((k) => `"${k}"`).join(' or ')
      return `missing required argument ${names} for tool "${tool.name}"`
    }
  }

  for (const [key, raw] of Object.entries(value)) {
    const spec = props[key]
    if (!spec) {
      return `unknown argument "${key}" for tool "${tool.name}"`
    }
    if (raw === undefined || raw === null) continue
    if (spec.type === 'string' && typeof raw !== 'string') {
      return `argument "${key}" of tool "${tool.name}" must be a string`
    }
    if (spec.type === 'number' && typeof raw !== 'number') {
      return `argument "${key}" of tool "${tool.name}" must be a number`
    }
    if (spec.type === 'boolean' && typeof raw !== 'boolean') {
      return `argument "${key}" of tool "${tool.name}" must be a boolean`
    }
    if (spec.type === 'array' && !Array.isArray(raw)) {
      return `argument "${key}" of tool "${tool.name}" must be an array`
    }
    if (spec.type === 'object' && (typeof raw !== 'object' || Array.isArray(raw))) {
      return `argument "${key}" of tool "${tool.name}" must be an object`
    }
    if (spec.enum && !spec.enum.includes(raw)) {
      return `argument "${key}" of tool "${tool.name}" must be one of: ${spec.enum.join(', ')}`
    }
  }
  return null
}

/**
 * Render `browser_status` as one compact line.
 *
 * @param {Record<string, any>} status
 * @returns {string}
 */
function summarizeStatus(status) {
  const bits = []
  bits.push(`state ${status.state || 'unknown'}`)
  if (status.bin) bits.push(`firefox ${status.bin}`)
  if (status.port) bits.push(`port ${status.port}`)
  if (status.refMode) bits.push(`refs ${status.refMode}`)
  if (status.dialogPolicy) bits.push(`dialogs ${status.dialogPolicy}`)
  if (status.pendingDialogs) bits.push(`${status.pendingDialogs} dialog open`)
  const caps = status.capabilities
  if (caps && caps.features) {
    const names = Object.keys(caps.features)
    const on = names.filter((name) => caps.features[name])
    bits.push(`capabilities ${on.length}/${names.length}${caps.probed ? '' : ' (expected)'}`)
    if (caps.browserVersion) bits.push(`browser ${caps.browserVersion}`)
  }
  if (status.snapshotSeq) bits.push(`snapshot #${status.snapshotSeq}`)
  if (status.networkCount) bits.push(`${status.networkCount} requests`)
  return bits.join(' · ')
}

/**
 * Turn a provider result into an MCP tool result.
 *
 * Every tool emits a compact 1-line summary in `content[0].text` and the
 * machine-readable payload in `structuredContent` (avoiding 2x JSON duplication).
 *
 * @param {*} result
 * @param {Record<string, any>|null} tool
 * @returns {Record<string, any>}
 */
function toToolResult(result, tool) {
  const structured = toStructured(result)
  const isError = structured.ok === false

  if (tool && tool.name === 'browser_screenshot' && !isError) {
    const data = structured.data
    if (typeof data !== 'string' || !data) {
      return errorResult('screenshot produced no image data', tool, ERROR_CODES.INTERNAL)
    }
    /** @type {Record<string, any>} */
    const extra = {}
    if (structured.imageUrl) extra.imageUrl = structured.imageUrl
    if (structured.imageUrlError) extra.imageUrlError = structured.imageUrlError

    return {
      content: [
        { type: 'image', data, mimeType: structured.mimeType || 'image/png' },
        {
          type: 'text',
          text: summarize(structured, {
            summary:
              `screenshot captured (${structured.fullPage ? 'full page' : 'viewport'}, ${data.length} base64 chars)` +
              (structured.imageUrl ? ` — image url: ${structured.imageUrl}` : ''),
          }),
        },
      ],
      structuredContent: {
        ok: true,
        contextId: structured.contextId,
        mimeType: structured.mimeType || 'image/png',
        encoding: 'base64',
        bytes: data.length,
        fullPage: !!structured.fullPage,
        ...extra,
      },
      isError: false,
    }
  }

  return {
    content: [
      {
        type: 'text',
        text:
          tool && (tool.name === 'browser_captcha' || tool.name === 'browser_captcha_status')
            ? summarizeCaptcha(structured)
            : tool && tool.name === 'browser_status'
              ? summarizeStatus(structured)
              : summarize(structured),
      },
    ],
    structuredContent: structured,
    isError,
  }
}

/**
 * Build a failure result for a call that never reached the provider.
 *
 * @param {string} text
 * @param {Record<string, any>|null} tool
 * @param {string} code
 * @returns {Record<string, any>}
 */
function errorResult(text, tool, code) {
  return {
    content: [{ type: 'text', text }],
    structuredContent: { ok: false, code, error: text, recovery: buildRecovery(code) },
    isError: true,
  }
}

async function callTool(name, args) {
  const tool = TOOLS_BY_NAME.get(name)
  if (!tool) {
    return errorResult(`unknown tool "${name}"`, null, ERROR_CODES.UNKNOWN_TOOL)
  }
  const invalid = validateArgs(tool, args)
  if (invalid) return errorResult(invalid, tool, ERROR_CODES.INVALID_ARGUMENT)

  let result
  try {
    result = await tool.run(args || {})
  } catch (e) {
    return errorResult(
      `tool "${name}" failed: ${e && e.message ? e.message : String(e)}`,
      tool,
      ERROR_CODES.INTERNAL,
    )
  }

  // The action audit trail. This browser carries the user's real login
  // state, so what the agent DID is worth recording on disk. The audit
  // never records typed text or cookie values — see lib/firefox/audit.js.
  try {
    provider.recordAudit(name, result)
  } catch {
    /* the audit must never break a tool call */
  }

  return toToolResult(result, tool)
}

async function handleMessage(message, sink = write) {
  const { id, method, params } = message

  // Notifications carry no id and get no reply.
  if (id === undefined || id === null) {
    if (method === 'notifications/cancelled') {
      log(`cancelled: ${params && params.requestId}`)
    } else if (method === 'notifications/exit') {
      shutdown('client asked to exit')
    }
    return
  }

  switch (method) {
    case 'shutdown': {
      // The MCP lifecycle's shutdown, and the clean way to stop a daemon:
      // the caller asks over the control socket, the server runs its own
      // cleanup (close the socket, stop the browser, remove the socket
      // file) instead of being killed.
      //
      // The reply goes out FIRST — the process is about to exit, and a
      // shutdown nobody hears from looks like a failure.
      reply(id, { ok: true }, sink)
      setTimeout(() => shutdown('remote request'), 50)
      return
    }
    case 'initialize': {
      const requested = params && params.protocolVersion
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION
      reply(
        id,
        {
          protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        },
        sink,
      )
      return
    }
    case 'ping':
      reply(id, {}, sink)
      return
    case 'tools/list': {
      // The catalogue is trimmed to the current preset. `browser_config`
      // is always in the list, so the agent can widen it again.
      const names = new Set(presetTools(provider.config_.preset, TOOL_ORDER))
      const visible = TOOLS.filter((t) => names.has(t.name))
      reply(
        id,
        {
          tools: visible.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            outputSchema: t.outputSchema,
            annotations: t.annotations,
          })),
        },
        sink,
      )
      return
    }
    case 'tools/call': {
      const name = params && params.name
      const args = params && params.arguments
      reply(id, await callTool(name, args), sink)
      return
    }
    default:
      replyError(id, -32601, `method not found: ${method}`, sink)
  }
}

// ---------------------------------------------------------------------------
// stdin loop
// ---------------------------------------------------------------------------

function log(message) {
  process.stderr.write(`[firefox-browser] ${message}\n`)
}

let buffer = ''

// The stdio transport is the WHOLE conversation for a normal server, and
// EOF means the client is gone. A daemon has no client on stdin — it is
// reached through the control socket — so wiring the reader there would
// kill the server the moment it was started detached.
// ---------------------------------------------------------------------------
// Shutdown state (declared before stdin listeners and top-level await so an
// early EOF or SIGTERM during socket probing never hits a temporal dead zone)
// ---------------------------------------------------------------------------

let shuttingDown = false
let controlServer = null

async function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutting down (${reason})`)
  if (controlServer) {
    try {
      controlServer.close()
      unlinkSync(controlSocketPath())
    } catch {
      /* best effort */
    }
  }
  try {
    await provider.stop()
  } catch (e) {
    log(`stop failed: ${e && e.message ? e.message : e}`)
  }
  resetFirefoxProvider()
  process.exit(0)
}

if (!FIREFOX_BROWSER_DAEMON) {
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch (e) {
        log(`ignoring unparseable line: ${e.message}`)
        continue
      }
      Promise.resolve(handleMessage(message)).catch((err) => {
        log(`handler error: ${err && err.stack ? err.stack : err}`)
      })
    }
  })

  process.stdin.on('end', () => {
    shutdown('stdin closed')
  })
} else {
  log('daemon mode: the control socket is the transport, stdin is not read')
}

// ---------------------------------------------------------------------------
// Control socket (optional)
// ---------------------------------------------------------------------------

/**
 * Where the control socket lives.
 *
 * It sits next to the profile copies — the plugin's own data directory,
 * which is outside the package. The path is stable, so a caller can find
 * it without being told.
 *
 * @returns {string}
 */
export function controlSocketPath() {
  return join(provider.opts.copyBaseDir || defaultCopyBase(), 'control.sock')
}

/**
 * Is somebody answering on that socket RIGHT NOW?
 *
 * A socket file can outlive the process that created it — a crashed server
 * leaves the file behind — so the file's existence proves nothing. This
 * asks the socket itself.
 *
 * @param {string} path
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function socketIsLive(path, timeoutMs = 1500) {
  return new Promise((resolvePromise) => {
    let settled = false
    let socket = null
    const done = (value) => {
      if (settled) return
      settled = true
      try {
        if (socket) socket.destroy()
      } catch {
        /* already gone */
      }
      resolvePromise(value)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    try {
      socket = net.createConnection(path)
      socket.setEncoding('utf8')
      socket.on('data', () => {
        clearTimeout(timer)
        done(true)
      })
      socket.on('error', () => {
        clearTimeout(timer)
        done(false)
      })
      socket.on('connect', () => {
        socket.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
        )
      })
    } catch {
      clearTimeout(timer)
      done(false)
    }
  })
}

/**
 * Start the control socket.
 *
 * WHY IT EXISTS
 *
 * The plugin's tools reach the agent through the host, which injects them
 * as MCP tools. When that injection does not happen — a host-side
 * problem, or a client that does not speak MCP — the plugin would be
 * unreachable even though it is running perfectly well.
 *
 * This socket is the way out: it speaks the same JSON-RPC over the same
 * provider, so a caller can drive the very same browser from a shell.
 * It is OFF unless FIREFOX_BROWSER_CONTROL_SOCKET=1, and ON by default in
 * daemon mode, where it is the only transport the server has.
 *
 * @returns {Promise<Record<string, any>|null>}
 */
async function startControlSocket() {
  const enabled =
    String(process.env.FIREFOX_BROWSER_CONTROL_SOCKET || '') === '1' || FIREFOX_BROWSER_DAEMON
  if (!enabled) return null
  const path = controlSocketPath()
  let server
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (existsSync(path)) {
      // A LIVE socket means another server already owns it — and another
      // server means another Firefox, which the BiDi session does not
      // allow. Do not steal it.
      if (await socketIsLive(path)) {
        log(`control socket already served by a live server: ${path}`)
        if (FIREFOX_BROWSER_DAEMON) {
          log('daemon mode: refusing to take over a live socket')
          process.exit(3)
        }
        return null
      }
      // A stale socket from a crashed server would make listen() fail.
      try {
        unlinkSync(path)
      } catch {
        /* there was none */
      }
    }
    server = net.createServer((socket) => {
      let buffer = ''
      socket.setEncoding('utf8')
      const sink = (payload) => {
        try {
          socket.write(`${JSON.stringify(payload)}\n`)
        } catch {
          /* the client went away */
        }
      }
      socket.on('data', (chunk) => {
        buffer += chunk
        let index
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (!line) continue
          let message
          try {
            message = JSON.parse(line)
          } catch (e) {
            log(`control socket: ignoring unparseable line: ${e.message}`)
            continue
          }
          Promise.resolve(handleMessage(message, sink)).catch((err) => {
            log(`control socket handler error: ${err && err.stack ? err.stack : err}`)
          })
        }
      })
      socket.on('error', () => {
        /* the client went away */
      })
    })
    server.listen(path, () => {
      try {
        chmodSync(path, 0o600)
      } catch {
        /* best effort */
      }
      log(`control socket listening on ${path}`)
    })
    server.on('error', (e) => {
      log(`control socket failed: ${e && e.message ? e.message : e}`)
    })
  } catch (e) {
    log(`control socket not started: ${e && e.message ? e.message : e}`)
    server = null
  }
  return server
}

// The socket may already be owned by a live server, and finding that out
// takes a round trip — so this is the one await in the module's top level.
controlServer = await startControlSocket()

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Last-resort net: if the process dies without a signal, take the browser
// with it rather than leaving an orphaned headless Firefox behind.
process.on('exit', () => {
  try {
    provider.killNow()
  } catch {
    // Nothing more we can do at exit time.
  }
})

log(
  `ready — firefox=${FIREFOX_BROWSER_BIN || '(auto)'} port=${FIREFOX_BROWSER_PORT} ` +
    `headless=${FIREFOX_BROWSER_HEADLESS} tools=${TOOLS.length} ` +
    `preset=${provider.config_.preset} visible=${presetTools(provider.config_.preset, TOOL_ORDER).length}`,
)
