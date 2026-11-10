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
import { createTools } from './lib/mcp/tools/index.js'
import { presetTools } from './lib/firefox/provider/workflow.js'
import { toStructured, summarize, summarizeCaptcha, prettyJson } from './lib/mcp/schema.js'
import { ERROR_CODES } from './lib/firefox/errors.js'

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

/**
 * Privileged (chrome://) contexts.
 *
 * Off by default: the flag widens what the browser exposes to the driver
 * (about:preferences, about:addons, about:logins). Turn it on when the task
 * needs to read the real preferences or the extension list.
 */
const FIREFOX_BROWSER_PRIVILEGED = process.env.FIREFOX_BROWSER_PRIVILEGED === '1'

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
const SERVER_VERSION = '2.3.0'
const LATEST_PROTOCOL_VERSION = '2025-11-25'
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const INSTRUCTIONS = [
  'Drive a real Firefox over WebDriver BiDi.',
  'The browser starts on demand — there is no separate launch step.',
  'Clicks use real pointer events, so they work on sites that require trusted input.',
  'The browser reuses a copy of the user profile, so logged-in sites stay logged in.',
  '',
  'WORKFLOW: call browser_snapshot first to see the page as a list of elements with',
  'stable refs (role + name), then act on a ref. Guessing CSS selectors is',
  'unreliable; a ref is not. Refs expire when the page re-renders — if a tool',
  'reports that a ref is stale, take a fresh snapshot.',
  '',
  'EFFICIENCY: browser_batch runs several actions in one call, which is usually',
  'cheaper than one call per action. For a repeatable sequence, write a helper',
  'script under ~/.mavis/ff-workspace/ and run it with browser_run_script.',
  '',
  'Every action returns an `effect` block. `effect.verified` is honest: when it is',
  'false, nothing on the page observably changed, so the action probably did not',
  'take effect. If the effect carries a `dialog`, the page raised a JavaScript',
  'dialog — it was closed automatically, and the message is what it said.',
  '',
  'Actions that cannot be undone (submitting a form, downloading, uploading,',
  'posting account data, installing an extension, writing a cookie) are refused',
  'unless you pass confirm: true.',
  '',
  'FIREFOX-ONLY TOOLS: browser_context (isolated identities), browser_extension',
  '(install extensions), browser_cookie (HttpOnly cookies), browser_intercept',
  '(block requests). They need a recent Firefox — browser_status reports exactly',
  'what the running browser supports.',
  '',
  'WHICH BROWSER: default to this plugin’s Firefox — it runs the real Firefox',
  'and carries the user’s login state. Switch to the host’s in-app browser only',
  'when the user explicitly says "current browser" / "right-side browser" /',
  '"built-in browser". Use browser_handoff to move a page between the two;',
  'session state (logins, cookies, tabs) never travels with it.',
  '',
  'SCREENSHOTS: browser_screenshot returns an imageUrl. If the user is chatting',
  'in a web client, put that URL into your reply as a markdown image so they',
  'can see the picture. Never inline base64 image data.',
].join(' ')

// ---------------------------------------------------------------------------
// Tool catalogue
// ---------------------------------------------------------------------------

// The tool definitions live in lib/mcp/tools/, one module per concern. The
// list order is fixed there and must not change: the host injects the tool
// schemas in the order the server returns them, and that order is part of
// the prompt cache.
//
// The catalogue is TRIMMED to the active preset when it is listed. The
// host re-reads it whenever the preset changes, so the trimmed list is
// what the agent actually carries in its context.
const TOOLS = createTools({
  provider,
  onToolsetChanged: () => {
    notify('notifications/tools/list_changed')
  },
})
const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/**
 * The twelve tools that existed before this version.
 *
 * They keep their ORIGINAL text contract: the text block carries the
 * pretty-printed JSON payload, exactly as before. Existing callers parse
 * that text, so changing it would be a breaking change — and the plugin's
 * own test suite depends on it.
 *
 * The newly added tools use the newer contract instead: a compact summary
 * in the text block plus the full payload in `structuredContent`.
 *
 * `legacy: true` therefore means "keep the old text shape", not "no
 * structured output" — the original tools still return `structuredContent`
 * too, so a caller can migrate to it at its own pace.
 */
const LEGACY_TOOLS = new Set([
  'browser_start',
  'browser_stop',
  'browser_tabs',
  'browser_new_tab',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_text',
  'browser_evaluate',
  'browser_screenshot',
  'browser_logs',
])

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } })
}

/**
 * Send a notification to the host.
 *
 * Notifications carry no id and get no reply — see the `handleMessage`
 * switch, which ignores any message without an id.
 *
 * @param {string} method
 * @param {object} [params]
 */
function notify(method, params = {}) {
  write({ jsonrpc: '2.0', method, params })
}

/**
 * Validate the call arguments against the tool's input schema.
 *
 * Only the subset that matters here is enforced: required properties present,
 * and property types matching. Unknown properties are rejected too — a typo in
 * an argument name should fail loudly rather than silently do nothing.
 *
 * `requiresOneOf` handles the dual addressing: an element may be named by a
 * snapshot `ref` OR by a CSS `selector`, so neither can be "required" in the
 * JSON Schema — but one of them must be present.
 *
 * @returns {string|null} an error message, or null when the args are valid
 */
function validateArgs(tool, args) {
  const schema = tool.inputSchema || {}
  const props = schema.properties || {}
  const value = args && typeof args === 'object' ? args : {}

  for (const key of schema.required || []) {
    if (value[key] === undefined || value[key] === null || value[key] === '') {
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
    if (spec.enum && !spec.enum.includes(raw)) {
      return `argument "${key}" of tool "${tool.name}" must be one of: ${spec.enum.join(', ')}`
    }
  }
  return null
}

/**
 * Render the status as one screenful of answers.
 *
 * The status carries the capability matrix, the ref mode, the dialog policy
 * and the session counters — a payload far too long to dump as text. The
 * summary answers the four questions an agent actually has: which Firefox is
 * this, what can it do, how are refs stored, is anything pending.
 *
 * @param {object} status
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
    // "expected" means the browser was not running, so the matrix comes from
    // the version gates instead of a live probe.
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
 * Provider methods never throw — they return `{ok:false, error}` on failure —
 * so the error text is taken straight from the provider's message.
 *
 * The result carries BOTH a text block and the full structured payload.
 *
 * The twelve original tools keep their original text shape — the
 * pretty-printed JSON payload — because existing callers parse that text
 * and changing it would be a breaking change. The tools added in this
 * version use a compact summary in the text block instead, so the payload
 * is not stated twice (the host renders `structuredContent` into the text
 * output as well).
 *
 * `browser_status` left the legacy set in 2.0: its payload grew to include
 * the capability matrix, and a status dump is exactly the kind of thing that
 * belongs in `structuredContent` rather than in the text.
 */
function toToolResult(result, tool) {
  const structured = toStructured(result)
  const isError = structured.ok === false
  const isLegacy = tool ? LEGACY_TOOLS.has(tool.name) : false

  // A screenshot is delivered as an MCP image content block so the model
  // receives an actual image rather than an opaque base64 blob.
  if (tool && tool.name === 'browser_screenshot' && !isError) {
    const data = structured.data
    if (typeof data !== 'string' || !data) {
      return errorResult('screenshot produced no image data', tool)
    }
    // The image URL lets a chat client (the webui renders markdown) show the
    // picture to the user, while the image bytes stay out of the model's
    // context — only the short URL travels through the reply.
    const extra = {}
    if (structured.imageUrl) extra.imageUrl = structured.imageUrl
    if (structured.imageUrlError) extra.imageUrlError = structured.imageUrlError
    const hint = structured.imageUrl
      ? 'Paste imageUrl into your reply as a markdown image so the user can see the screenshot.'
      : undefined

    const legacyPayload = {
      ok: true,
      contextId: structured.contextId,
      mimeType: structured.mimeType || 'image/png',
      encoding: 'base64',
      bytes: data.length,
      fullPage: !!structured.fullPage,
      ...extra,
    }
    if (hint) legacyPayload.hint = hint

    return {
      content: [
        { type: 'image', data, mimeType: structured.mimeType || 'image/png' },
        {
          type: 'text',
          text: isLegacy
            ? prettyJson(legacyPayload)
            : summarize(structured, {
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
        text: isLegacy
          ? prettyJson(structured)
          : tool && (tool.name === 'browser_captcha' || tool.name === 'browser_captcha_status')
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
 * The `error` text stays exactly as it was — that is the human-readable
 * contract. The `code` is added on top of it, so an agent can tell an
 * unknown tool from a bad argument from a crashed tool without matching
 * English.
 *
 * @param {string} text  the human-readable sentence
 * @param {object|null} tool  the tool it was for (null when unknown)
 * @param {string} code  one of ERROR_CODES
 * @returns {object}
 */
function errorResult(text, tool, code) {
  return {
    content: [{ type: 'text', text }],
    structuredContent: { ok: false, code, error: text },
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

async function handleMessage(message) {
  const { id, method, params } = message

  // Notifications carry no id and get no reply.
  if (id === undefined || id === null) {
    if (method === 'notifications/cancelled') {
      log(`cancelled: ${params && params.requestId}`)
    }
    return
  }

  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION
      reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      })
      return
    }
    case 'ping':
      reply(id, {})
      return
    case 'tools/list': {
      // The catalogue is trimmed to the current preset. `browser_config`
      // is always in the list, so the agent can widen it again.
      const names = new Set(presetTools(provider.config_.preset))
      const visible = TOOLS.filter((t) => names.has(t.name))
      reply(id, {
        tools: visible.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema,
          annotations: t.annotations,
        })),
      })
      return
    }
    case 'tools/call': {
      const name = params && params.name
      const args = params && params.arguments
      reply(id, await callTool(name, args))
      return
    }
    default:
      replyError(id, -32601, `method not found: ${method}`)
  }
}

// ---------------------------------------------------------------------------
// stdin loop
// ---------------------------------------------------------------------------

function log(message) {
  process.stderr.write(`[firefox-browser] ${message}\n`)
}

let buffer = ''

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

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false

async function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutting down (${reason})`)
  try {
    await provider.stop()
  } catch (e) {
    log(`stop failed: ${e && e.message ? e.message : e}`)
  }
  resetFirefoxProvider()
  process.exit(0)
}

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
    `preset=${provider.config_.preset} visible=${presetTools(provider.config_.preset).length}`,
)
