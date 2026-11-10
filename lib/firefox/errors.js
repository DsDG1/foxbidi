// lib/firefox/errors.js
// The error contract.
//
// WHY THIS MODULE EXISTS
//
// Every provider method returns `{ok: false, error: 'some English sentence'}`
// on failure and never throws. That worked while the only consumer was a
// human reading a transcript. It stops working the moment an AGENT has to
// decide what to do next, because deciding requires BRANCHING, and branching
// on an English sentence means matching on its wording — which breaks the
// moment someone rewords the message.
//
// So every failure now carries a machine-readable `code` next to the
// human-readable `error`:
//
//   { ok: false, code: 'ref_stale', error: 'ref "e12" no longer exists…',
//     hint: 'The page re-rendered…', requiresResnapshot: true }
//
// The agent branches on `code`; the human (and any existing script) still
// reads `error`. Adding a field is backwards compatible — nothing that read
// `error` before stops working.
//
// WHAT THE CODES MEAN
//
//   not_running            — the browser is not up (and could not be started)
//   no_context             — no browsing context to act on
//   element_not_found      — the selector/ref matched nothing
//   element_not_actionable — the element exists but cannot be used (hidden,
//                            disabled, wrong type)
//   ref_stale              — the snapshot ref no longer exists in the page
//   frame_gone             — the iframe that carried the ref is gone
//   capability_unavailable — this Firefox does not have the feature
//   confirm_required       — the action is irreversible and was not confirmed
//   invalid_argument       — the caller passed something impossible
//   timeout                — the operation ran out of time
//   network_error          — the request itself failed
//   path_not_allowed       — a file path outside the permitted roots
//   navigation_blocked     — the URL is not one the browser may visit
//   unknown_tool           — the MCP layer was asked for a tool that is not there
//   internal               — a bug on our side

/** The machine-readable failure codes. */
export const ERROR_CODES = {
  NOT_RUNNING: 'not_running',
  NO_CONTEXT: 'no_context',
  ELEMENT_NOT_FOUND: 'element_not_found',
  ELEMENT_NOT_ACTIONABLE: 'element_not_actionable',
  REF_STALE: 'ref_stale',
  FRAME_GONE: 'frame_gone',
  CAPABILITY_UNAVAILABLE: 'capability_unavailable',
  CONFIRM_REQUIRED: 'confirm_required',
  INVALID_ARGUMENT: 'invalid_argument',
  TIMEOUT: 'timeout',
  NETWORK_ERROR: 'network_error',
  PATH_NOT_ALLOWED: 'path_not_allowed',
  NAVIGATION_BLOCKED: 'navigation_blocked',
  UNKNOWN_TOOL: 'unknown_tool',
  INTERNAL: 'internal',
}

/**
 * Build a failure result.
 *
 * The shape is always `{ok: false, code, error, ...extra}`:
 *   - `code`  — the machine-readable reason (see ERROR_CODES)
 *   - `error` — the human-readable sentence
 *   - `extra` — whatever the caller wants to add (hint, contextId, feature…)
 *
 * @param {string} code    one of ERROR_CODES
 * @param {string} message the human-readable explanation
 * @param {object} [extra] additional fields
 * @returns {{ok: false, code: string, error: string}}
 */
export function fail(code, message, extra = {}) {
  // The invariants come LAST so that a stray `extra` field cannot turn a
  // failure into a success or rewrite its code.
  return { ...extra, ok: false, code, error: message }
}

/**
 * Build a success result.
 *
 * The counterpart of `fail()`, so both halves of the contract live together
 * and a reader can see the shape in one place.
 *
 * @param {object} [data] the payload
 * @returns {{ok: true}}
 */
export function ok(data = {}) {
  return { ok: true, ...data }
}

/**
 * Classify a failure that came back from a PAGE script.
 *
 * The scripts injected into the page cannot import this module — they are
 * strings evaluated in the browser — so they report a human-readable
 * sentence and the plugin maps it to a code here. That keeps the mapping in
 * ONE place instead of duplicating it at every call site.
 *
 * @param {string} message the sentence the page script produced
 * @returns {string} one of ERROR_CODES
 */
export function classifyPageError(message) {
  const text = String(message || '')
  if (/not found|no such element/i.test(text)) return ERROR_CODES.ELEMENT_NOT_FOUND
  if (/disabled|not a checkbox|not a <select>|is not a/i.test(text)) {
    return ERROR_CODES.ELEMENT_NOT_ACTIONABLE
  }
  if (/no option matched/i.test(text)) return ERROR_CODES.INVALID_ARGUMENT
  return ERROR_CODES.INTERNAL
}

/**
 * Classify a caught exception into a failure code.
 *
 * A BiDi timeout is a timeout; a refused command is a capability problem;
 * anything else is internal. This keeps `catch (e) { return fail(...) }`
 * from having to guess in every one of the ~100 places that catch.
 *
 * @param {*} error the caught value
 * @returns {string} one of ERROR_CODES
 */
export function classifyError(error) {
  const message = String((error && error.message) || error || '')
  if (/timed out/i.test(message)) return ERROR_CODES.TIMEOUT
  if (/unknown command|not a valid command|not implemented|unsupported/i.test(message)) {
    return ERROR_CODES.CAPABILITY_UNAVAILABLE
  }
  if (/no such|browsing context/i.test(message)) return ERROR_CODES.NO_CONTEXT
  return ERROR_CODES.INTERNAL
}
