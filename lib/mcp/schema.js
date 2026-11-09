// lib/mcp/schema.js
// Structured output for the MCP server.
//
// WHY THIS EXISTS
//
// The host runtime (verified against @minimax-ai/code 0.7.6) enforces a
// strict contract for tools that declare an `outputSchema`:
//   - a result WITHOUT `structuredContent` and without `isError` is rejected
//     with "Tool X has an output schema but did not return structured content";
//   - a `structuredContent` that does not match the schema is rejected with
//     "Structured content does not match the tool's output schema".
//
// So a declared schema is a CONTRACT: every result — success AND failure —
// must carry a matching `structuredContent`. The helpers here make that
// hard to get wrong.
//
// The host ALSO renders `structuredContent` into the text output as
// "[MCP structured content]\n{json}". Emitting the same payload twice
// (once as pretty text, once as structured) would double the token cost of
// every call. The convention in this plugin is therefore:
//   - the TEXT block carries a compact human/agent summary;
//   - `structuredContent` carries the machine-readable payload.
//
// Every schema below is deliberately permissive: `additionalProperties` is
// allowed everywhere, and only `ok` is required. That keeps the contract
// enforceable while leaving room for the provider to grow new fields
// without silently breaking every call.

/**
 * Build an output schema for a tool.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.required]  fields required on every result
 * @param {object} [opts.properties]   field → {type, description, items?}
 * @returns {object} a JSON Schema object
 */
export function outputSchema(opts = {}) {
  const properties = { ok: { type: 'boolean', description: 'Whether the operation succeeded.' } }
  for (const [key, spec] of Object.entries(opts.properties || {})) {
    properties[key] = { type: spec.type || 'string', description: spec.description || '' }
    if (spec.type === 'array') {
      // An array property here is always a list of RECORDS (elements, requests),
      // never a list of scalars — so the item schema defaults to a permissive
      // object. Declaring `items: {type:'string'}` would contradict the
      // payload the provider actually returns.
      properties[key].items = spec.items || { type: 'object', additionalProperties: true }
    }
    if (spec.type === 'object') properties[key].additionalProperties = true
  }
  return {
    type: 'object',
    properties,
    required: opts.required || ['ok'],
    additionalProperties: true,
  }
}

/**
 * The error shape every tool returns on failure.
 *
 * @returns {object}
 */
export function errorSchema() {
  return outputSchema({
    properties: {
      error: { type: 'string', description: 'What went wrong, in actionable terms.' },
      hint: { type: 'string', description: 'What the agent should do next.' },
    },
  })
}

/**
 * Normalize a provider result into a structured payload.
 *
 * Provider methods never throw — they return `{ok:false, error}` — so this
 * just guarantees the shape the schema promises: `ok` is always a boolean,
 * and `error`/`hint` are strings when present.
 *
 * @param {*} result
 * @returns {object} a structured payload matching the tool's schema
 */
export function toStructured(result) {
  if (!result || typeof result !== 'object') {
    return { ok: false, error: 'the browser operation returned no result' }
  }
  const payload = { ...result, ok: result.ok === true }
  if (payload.error !== undefined && typeof payload.error !== 'string') {
    payload.error = String(payload.error)
  }
  if (payload.hint !== undefined && typeof payload.hint !== 'string') {
    payload.hint = String(payload.hint)
  }
  return payload
}

/**
 * How many array items the text block shows before it truncates.
 */
const SUMMARY_ITEM_LIMIT = 12

/**
 * Render a list of element records compactly: `e0 button "Submit"`.
 *
 * The ref is what the agent acts on, so it leads.
 *
 * @param {Array<object>} items
 * @returns {string}
 */
function summarizeElements(items) {
  const shown = items.slice(0, SUMMARY_ITEM_LIMIT)
  const rendered = shown.map((el) => {
    const ref = el && el.ref ? el.ref : '?'
    const role = el && el.role ? el.role : 'element'
    const name = el && el.name ? ` "${String(el.name).slice(0, 60)}"` : ''
    return `${ref} ${role}${name}`
  })
  if (items.length > shown.length) {
    rendered.push(`… +${items.length - shown.length} more`)
  }
  return rendered.join(' | ')
}

/**
 * Render a list of network records compactly: `GET https://host/path 200`.
 *
 * @param {Array<object>} items
 * @returns {string}
 */
function summarizeRequests(items) {
  const shown = items.slice(0, SUMMARY_ITEM_LIMIT)
  const rendered = shown.map((req) => {
    const method = (req && req.method) || 'GET'
    const url = (req && req.url) || ''
    const status =
      req && req.status !== null && req.status !== undefined
        ? req.status
        : (req && req.bucket) || 'pending'
    return `${method} ${url} ${status}`
  })
  if (items.length > shown.length) {
    rendered.push(`… +${items.length - shown.length} more`)
  }
  return rendered.join(' | ')
}

/**
 * Render a short, token-cheap summary for the text block.
 *
 * The full payload travels in `structuredContent`; the text block exists so
 * the agent (and a human reading the transcript) can see at a glance what
 * happened without re-reading a large JSON blob.
 *
 * Array payloads are rendered inline rather than left behind a rendering
 * indirection: an element list that only shows a count is not actionable,
 * because the agent cannot see which refs exist or what they are.
 *
 * @param {*} result
 * @param {object} [opts]
 * @param {string} [opts.summary]  explicit summary; overrides the default
 * @returns {string}
 */
export function summarize(result, opts = {}) {
  if (opts.summary) return opts.summary
  if (!result || typeof result !== 'object') return String(result ?? '')
  if (result.ok === false) {
    // `message` is the fallback for tools that report an OUTCOME in prose
    // instead of `error` (the CAPTCHA solvers do). Without it the text block
    // collapses to a generic sentence, which sends the agent looking for a
    // broken browser instead of reading the actual reason.
    const reason = result.error || result.message || 'the browser operation failed'
    const parts = [result.status ? `${result.status} — ${reason}` : reason]
    if (result.hint) parts.push(result.hint)
    if (result.requiresConfirm) {
      parts.push('Re-call with confirm: true to proceed.')
    }
    return parts.join(' — ')
  }
  const bits = []
  if (result.status) bits.push(String(result.status))
  if (result.contextId) bits.push(`context ${String(result.contextId).slice(0, 8)}`)
  if (result.selector) bits.push(`selector ${result.selector}`)
  if (result.ref) bits.push(`ref ${result.ref}`)
  if (result.typed !== undefined) bits.push(`typed ${result.typed} chars`)
  if (result.clicked !== undefined) bits.push('clicked')
  if (result.count !== undefined) bits.push(`count ${result.count}`)
  if (result.truncated === true) bits.push('truncated')
  if (result.blocked === true) bits.push('blocked — confirmation required')
  if (Array.isArray(result.elements) && result.elements.length) {
    bits.push(summarizeElements(result.elements))
  }
  if (Array.isArray(result.requests) && result.requests.length) {
    bits.push(summarizeRequests(result.requests))
  }
  return bits.length ? bits.join(' · ') : 'ok'
}

/**
 * Render a CAPTCHA result as one readable line.
 *
 * The captcha tools report an OUTCOME — a status plus a sentence about what
 * happened — not an exception. The generic summary flattens both the success
 * and the failure into something unreadable ("context 988fe195", or worse,
 * "the browser operation failed" for a page that simply has no challenge),
 * so these tools get their own renderer.
 *
 * @param {object} result
 * @returns {string}
 */
export function summarizeCaptcha(result) {
  if (!result || typeof result !== 'object') return String(result ?? '')

  // The status-only shape of browser_captcha_status.
  if (typeof result.solved === 'boolean') {
    const bits = [result.solved ? 'solved' : 'not solved']
    if (result.tokenLength !== undefined) bits.push(`token ${result.tokenLength} chars`)
    if (result.contextId) bits.push(`context ${String(result.contextId).slice(0, 8)}`)
    return bits.join(' · ')
  }

  if (result.ok === false) {
    const parts = []
    parts.push(result.status || 'failed')
    if (Array.isArray(result.detected) && result.detected.length) {
      parts.push(`detected ${result.detected.join(', ')}`)
    }
    if (Array.isArray(result.attempts) && result.attempts.length) {
      parts.push(
        result.attempts
          .map((attempt) => {
            const name = (attempt && attempt.solver) || '?'
            const state =
              (attempt && attempt.status) || (attempt && attempt.ok ? 'solved' : 'failed')
            return `${name}: ${state}`
          })
          .join(' · '),
      )
    }
    if (result.message) parts.push(result.message)
    return parts.join(' — ')
  }

  const bits = []
  bits.push(result.status || 'ok')
  if (result.solver) bits.push(String(result.solver))
  if (result.tokenLength !== undefined) bits.push(`token ${result.tokenLength} chars`)
  if (Array.isArray(result.detected) && result.detected.length) {
    bits.push(`detected ${result.detected.join(', ')}`)
  }
  if (result.contextId) bits.push(`context ${String(result.contextId).slice(0, 8)}`)
  return bits.join(' · ')
}

/**
 * Compact JSON. The pretty form (`JSON.stringify(x, null, 2)`) inflates
 * nested payloads noticeably and buys nothing for a machine consumer.
 *
 * @param {*} value
 * @returns {string}
 */
export function compactJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ ok: false, error: 'the result could not be serialized' })
  }
}

/**
 * Pretty JSON — the shape the original tools returned.
 *
 * The twelve original tools keep their exact previous text contract (a
 * pretty-printed JSON object) so that existing callers — and the plugin's
 * own test suite — keep working unchanged. New tools use a compact summary
 * plus `structuredContent` instead.
 *
 * @param {*} value
 * @returns {string}
 */
export function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return JSON.stringify({ ok: false, error: 'the result could not be serialized' })
  }
}
