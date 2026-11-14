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
//   session_stuck          — the BiDi session stopped answering; a command
//                            that never returns holds the queue, and only a
//                            session reset clears it
//   dialog_open            — a modal dialog is open and the page is blocked;
//                            the action was abandoned instead of hanging
//   network_error          — the request itself failed
//   path_not_allowed       — a file path outside the permitted roots
//   navigation_blocked     — the URL is not one the browser may visit
//   injection_blocked      — the page carries a hidden instruction, so the
//                            action would carry data out of the browser
//   evaluate_failed        — the page-side expression threw or failed to parse
//   redacted_value         — the target is a credential whose value is never
//                            read out of the page, so it cannot be compared
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
  /**
   * The BiDi session stopped answering.
   *
   * A command that never returns holds the session's command queue, and
   * every command behind it waits. The agent needs to know that the
   * difference is not "the page is slow" — the session itself is stuck, and
   * only a session reset clears it.
   */
  SESSION_STUCK: 'session_stuck',
  /**
   * A modal dialog is open and the browser is blocked.
   *
   * Under the `manual` dialog policy nothing closes the dialog, so every
   * command aimed at the page waits forever. The agent has to know that the
   * page is not slow — it is behind a dialog that is waiting to be handled.
   */
  DIALOG_OPEN: 'dialog_open',
  NETWORK_ERROR: 'network_error',
  PATH_NOT_ALLOWED: 'path_not_allowed',
  NAVIGATION_BLOCKED: 'navigation_blocked',
  INJECTION_BLOCKED: 'injection_blocked',
  EVALUATE_FAILED: 'evaluate_failed',
  REDACTED_VALUE: 'redacted_value',
  UNKNOWN_TOOL: 'unknown_tool',
  INTERNAL: 'internal',
  /**
   * A preference could not be applied right now.
   *
   * The value may still have been written for the next start — the agent
   * needs to know which.
   */
  PRIVILEGED_UNAVAILABLE: 'privileged_unavailable',
  PREFS_WRITE_FAILED: 'prefs_write_failed',
  /** The network check itself could not be completed. */
  NET_CHECK_FAILED: 'net_check_failed',
  /** The local egress proxy could not be started. */
  EGRESS_START_FAILED: 'egress_start_failed',
  /** A name could not be resolved, neither by the system nor over DoH. */
  EGRESS_RESOLVE_FAILED: 'egress_resolve_failed',
}

const KNOWN_ERROR_CODES = new Set(Object.values(ERROR_CODES))

/**
 * Build a machine-executable recovery descriptor for an error code.
 *
 * Agents should never have to parse English `hint` prose to decide:
 *   1. whether retrying the identical call is safe (`retrySameCall`),
 *   2. whether side effects on the page may already have landed (`sideEffectState`),
 *   3. whether human confirmation is required (`askUser`),
 *   4. what exact tool call repairs or re-observes state (`nextCall` / `retryWith`).
 *
 * @param {string} code
 * @param {Record<string, any>} [extra]
 * @returns {{
 *   retrySameCall: boolean,
 *   sideEffectState: 'none' | 'unknown_must_observe',
 *   askUser?: boolean,
 *   retryWith?: Record<string, any>,
 *   nextCall?: { tool: string, args: Record<string, any> },
 * }}
 */
export function buildRecovery(code, extra = {}) {
  const ctxArgs = extra && typeof extra.contextId === 'string' ? { contextId: extra.contextId } : {}
  const snapArgs = { ...ctxArgs, format: 'compact' }

  switch (code) {
    case ERROR_CODES.NOT_RUNNING:
      return {
        retrySameCall: false,
        sideEffectState: 'none',
        nextCall: { tool: 'browser_start', args: {} },
      }
    case ERROR_CODES.NO_CONTEXT:
      return {
        retrySameCall: false,
        sideEffectState: 'none',
        nextCall: { tool: 'browser_tabs', args: {} },
      }
    case ERROR_CODES.ELEMENT_NOT_FOUND:
    case ERROR_CODES.ELEMENT_NOT_ACTIONABLE:
    case ERROR_CODES.REF_STALE:
    case ERROR_CODES.FRAME_GONE:
      return {
        retrySameCall: false,
        sideEffectState: 'none',
        nextCall: { tool: 'browser_snapshot', args: snapArgs },
      }
    case ERROR_CODES.CONFIRM_REQUIRED:
      return {
        retrySameCall: true,
        sideEffectState: 'none',
        askUser: true,
        retryWith: { confirm: true },
      }
    case ERROR_CODES.INJECTION_BLOCKED:
      return {
        retrySameCall: false,
        sideEffectState: 'none',
        askUser: true,
      }
    case ERROR_CODES.NAVIGATION_BLOCKED:
      return {
        retrySameCall: false,
        sideEffectState: 'none',
        askUser: true,
      }
    case ERROR_CODES.DIALOG_OPEN:
      return {
        retrySameCall: false,
        sideEffectState: 'none',
        nextCall: { tool: 'browser_handle_dialog', args: { ...ctxArgs, action: 'dismiss' } },
      }
    case ERROR_CODES.SESSION_STUCK:
      return {
        retrySameCall: false,
        sideEffectState: 'unknown_must_observe',
        nextCall: { tool: 'browser_restart', args: { scope: 'session' } },
      }
    case ERROR_CODES.TIMEOUT:
      return {
        retrySameCall: false,
        sideEffectState: 'unknown_must_observe',
        nextCall: { tool: 'browser_snapshot', args: snapArgs },
      }
    case ERROR_CODES.NETWORK_ERROR:
    case ERROR_CODES.EGRESS_RESOLVE_FAILED:
      return {
        retrySameCall: false,
        sideEffectState: 'none',
        nextCall: { tool: 'browser_net_check', args: {} },
      }
    case ERROR_CODES.EVALUATE_FAILED:
    case ERROR_CODES.INTERNAL:
      return {
        retrySameCall: false,
        sideEffectState: 'unknown_must_observe',
      }
    default:
      return {
        retrySameCall: false,
        sideEffectState: 'none',
      }
  }
}

/**
 * Build a failure result.
 *
 * The shape is always `{ok: false, code, error, recovery, ...extra}`:
 *   - `code`     — the machine-readable reason (see ERROR_CODES)
 *   - `error`    — the human-readable sentence
 *   - `recovery` — machine-actionable next step & side-effect safety
 *   - `extra`    — whatever the caller wants to add (hint, contextId, feature…)
 *
 * @param {string} code    one of ERROR_CODES
 * @param {string} message the human-readable explanation
 * @param {Record<string, any>} [extra] additional fields
 * @returns {any}
 */
export function fail(code, message, extra = {}) {
  const recovery =
    extra && extra.recovery && typeof extra.recovery === 'object'
      ? extra.recovery
      : buildRecovery(code, extra)
  // The invariants come LAST so that a stray `extra` field cannot turn a
  // failure into a success or rewrite its code.
  return { ...extra, recovery, ok: false, code, error: message }
}

/**
 * Build a success result.
 *
 * The counterpart of `fail()`, so both halves of the contract live together
 * and a reader can see the shape in one place.
 *
 * @param {Record<string, any>} [data] the payload
 * @returns {Record<string, any> & {ok: true}}
 */
export function ok(data = {}) {
  return { ok: true, ...data }
}

/**
 * Classify a failure that came back from a PAGE script.
 *
 * Page scripts in `lib/firefox/page/*` return a structured `code` directly;
 * legacy string error messages fall back to regex classification here.
 *
 * @param {string | Record<string, any> | null | undefined} input
 * @returns {string} one of ERROR_CODES
 */
export function classifyPageError(input) {
  if (input && typeof input === 'object') {
    if (typeof input.code === 'string' && KNOWN_ERROR_CODES.has(input.code)) {
      return input.code
    }
    return classifyPageError(input.error || '')
  }
  const text = String(input || '')
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

/**
 * What to tell the agent when the BiDi session stopped answering.
 *
 * The point of the message is to name the ONE repair that works and say
 * what it costs, because the two obvious repairs are not equal: resetting
 * the session keeps Firefox and every tab, restarting the browser does not.
 */
export const SESSION_STUCK_HINT =
  'The BiDi session is stuck — a previous command never finished, and every command ' +
  'behind it is waiting. Run browser_restart {scope:"session"} to reset the session ' +
  '(this keeps Firefox, the tabs and the page you were on), or browser_restart to ' +
  'restart the browser instead.'

/**
 * What to tell the agent when a modal dialog is blocking the page.
 *
 * Two repairs exist and they are not equal: handling the dialog unblocks the
 * page the agent is already on, while switching the policy only stops the
 * NEXT dialog from blocking. So the hint names the repair that keeps the
 * current page first.
 */
export const DIALOG_OPEN_HINT =
  'A modal dialog is open, so the page is blocked and the action was abandoned. ' +
  'Handle it with browser_handle_dialog {action:"accept"|"dismiss"} — or switch the ' +
  'policy with browser_config {dialogPolicy:"autoDismiss"} so the plugin closes ' +
  'dialogs on its own.'

/**
 * An actionable hint for a failure that smells like the network.
 *
 * Firefox's own error text names the SYMPTOM ("NS_ERROR_UNKNOWN_HOST"),
 * not the cause. On a machine whose resolver is broken, that one string
 * covers "the browser cannot reach anything at all" — and the agent's next
 * move (retry, change the proxy, give up) depends entirely on which case
 * it is. So the hint points at the check that tells them apart.
 *
 * @param {string} message the error text
 * @returns {string|null} a hint, or null when the error is not network-shaped
 */
export function networkHint(message) {
  const text = String(message || '')
  if (/NS_ERROR_UNKNOWN_HOST|unknown host|name not resolved|dns/i.test(text)) {
    return 'The name did not resolve. Run browser_net_check to find out whether this is the resolver, the machine, or the browser process.'
  }
  if (/NS_ERROR_CONNECTION_REFUSED|ECONNREFUSED|connection refused/i.test(text)) {
    return 'The host refused the connection. Run browser_net_check to see whether this machine can reach it either.'
  }
  if (/NS_ERROR_NET_TIMEOUT|timeout|timed out/i.test(text)) {
    return 'The request timed out. Run browser_net_check to see whether this machine can reach the host at all.'
  }
  return null
}
