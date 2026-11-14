// lib/firefox/provider.js
// Firefox browser provider — the high-level API the MCP server calls.
// Composes the BiDi protocol layer into agent-shaped operations.
//
// Design notes:
//   - ONE instance + ONE BiDi session per plugin process. Firefox's remote
//     agent allows a single active session per endpoint, so sharing is not
//     optional.
//   - Commands are serialized inside the BiDi client (see client.js#_enqueue),
//     but the orchestration layer is NOT: the MCP server dispatches inbound
//     messages without awaiting them, so two tool calls can run here at the
//     same time. `start()` therefore shares one in-flight promise, and every
//     action pins its target context for its whole duration.
//   - Every public method returns a plain `{ok, ...}` object — never throws.
//     The MCP layer can pass the result straight to the caller.
//
// Module ownership (each resource has exactly one owner):
//   provider.js  → the class: the state every method shares
//   provider/    → the methods, one module per concern (session, tabs,
//                  action, target, inspect, diagnostic, firefox, captcha,
//                  workflow, events, support)
//   snapshot.js  → the ref registry
//   network.js   → the network request buffer
//   profile.js   → the profile copy
//
// The methods live in their own modules and are attached to the prototype
// below. They stay prototype methods, so `this` inside them is the provider
// instance — exactly as it was when they were written inside the class.

/**
 * Normalize a URL for navigation.
 *
 * Firefox rejects a scheme-less URL outright (NS_ERROR_MALFORMED_URI), and
 * agents routinely pass bare hostnames. Local addresses keep their scheme.
 *
 * @param {string} url
 * @returns {string}
 */

import { sessionMethods } from './provider/session.js'
import { processMethods } from './provider/process.js'
import { eventsMethods } from './provider/events.js'
import { tabsMethods } from './provider/tabs.js'
import { actionMethods } from './provider/action.js'
import { targetMethods } from './provider/target.js'
import { inspectMethods } from './provider/inspect.js'
import { diagnosticMethods } from './provider/diagnostic.js'
import { firefoxMethods } from './provider/firefox.js'
import { captchaMethods } from '#captcha-methods'
import { workflowMethods } from './provider/workflow.js'
import { verifyMethods } from './provider/verify.js'
import { findMethods } from './provider/find.js'
import { netMethods } from './provider/net.js'
import { supportMethods } from './provider/support.js'
import { STATE } from './provider/constants.js'
import { defaultCopyBase } from './provider/helpers.js'
import { ProviderState } from './provider/state.js'
import { NetworkLog } from './network.js'
import { ImageServer } from './images.js'
import { createRegistryKey, REF_MODE } from './registry.js'
import { DialogManager } from './dialogs.js'
import { AuditCounter } from './audit.js'
import { CapabilitySet } from './capabilities.js'
import { EgressProxy } from './egress.js'
import { join } from 'node:path'

// Re-exported so the long-standing import path keeps working: the script
// root allow-list and the preset tables belong to the workflow concern, but
// callers have always reached them through provider.js.
export { scriptRoots, presetTools, presetNotes } from './provider/workflow.js'
export { STATE, DEFAULT_MAX_TEXT_CHARS } from './provider/constants.js'
export { normalizeUrl, defaultCopyBase } from './provider/helpers.js'
export { ProviderState } from './provider/state.js'

/**
 * @typedef {FirefoxProvider & Record<string, any>} FirefoxProviderBase
 */

/**
 * @typedef {FirefoxProvider
 *   & typeof sessionMethods
 *   & typeof processMethods
 *   & typeof eventsMethods
 *   & typeof tabsMethods
 *   & typeof actionMethods
 *   & typeof targetMethods
 *   & typeof inspectMethods
 *   & typeof diagnosticMethods
 *   & typeof firefoxMethods
 *   & typeof workflowMethods
 *   & typeof verifyMethods
 *   & typeof findMethods
 *   & typeof netMethods
 *   & typeof supportMethods
 *   & Record<string, any>} FirefoxProviderInstance
 */

/**
 * The default window an action waits for a late dialog event.
 *
 * The `browsingContext.userPromptOpened` event arrives before the action's
 * own command returns, so this is only a race safety net — not a "wait for
 * the dialog" delay.
 */
const DEFAULT_DIALOG_SETTLE_MS = 40

/**
 * Read the settle window from the environment.
 *
 * @returns {number} milliseconds
 */
function readSettleMs() {
  const raw = (process.env.FIREFOX_BROWSER_DIALOG_SETTLE_MS || '').trim()
  if (!raw) return DEFAULT_DIALOG_SETTLE_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DIALOG_SETTLE_MS
  return Math.min(parsed, 2000)
}

export class FirefoxProvider {
  /**
   * @param {Record<string, any>} [opts]
   */
  constructor(opts = {}) {
    this.opts = opts
    this.state = STATE.IDLE
    this.error = null
    /** @type {any} */
    this.client = null
    this.bin = opts.bin || null
    this.port = opts.port || null
    this.pid = null
    this.sourceProfile = opts.profileDir || null
    this.copyDir = opts.copyDir || null
    this.profileInfo = null
    /** @type {Array<Record<string, any>>} */
    this.logs = []
    this._lastContextId = null
    /** True when the session was replaced and the recorded context may be gone. */
    this._contextsStale = false
    /** @type {NetworkLog} */
    this.networkLog = new NetworkLog()
    /** In-flight start promise — concurrent callers await the same one. */
    this._startPromise = null
    /** An instance that was kept alive by `stop({keep:true})`. */
    this._retained = null
    /**
     * Explicit state container owning snapshot baselines, tab URLs,
     * scan warnings/signals, acted coordinates, and runtime configuration.
     *
     * @type {ProviderState}
     */
    this._state = new ProviderState(opts)
    /**
     * The tool names, in catalogue order.
     *
     * @type {string[]}
     */
    this._toolCatalogue = []
    /** Subscription bookkeeping for diagnostics. */
    this.subscriptions = {
      subscribed: /** @type {string[]} */ ([]),
      failed: /** @type {any[]} */ ([]),
    }
    /**
     * The page-side ref registry key (random per session, never written to DOM).
     */
    this._registryKey = createRegistryKey()
    /** Which storage mode the refs currently use. */
    this._refMode = REF_MODE.REGISTRY
    /** Frame label → frame context id. */
    this._frameMap = new Map()
    /** @type {Set<string>} */
    this._captchaPreloads = new Set()
    /** @type {DialogManager} */
    this.dialogs = new DialogManager()
    /** @type {AuditCounter} */
    this.audit = new AuditCounter()
    /** Counts the dialogs that have opened. */
    this._dialogEpoch = 0
    /** How long an action waits for a late dialog event, in milliseconds. */
    this._dialogSettleMs = readSettleMs()
    /** @type {Array<{resolve: (dialog: Record<string, any>) => void, cancelled: boolean}>} */
    this._dialogWaiters = []
    /** @type {CapabilitySet} */
    this.capabilities = new CapabilitySet()
    /** Intercepts we installed, so they can be removed later. */
    this._interceptors = new Map()
    /** Requests paused by an intercept, waiting for a decision. */
    this._pausedRequests = new Map()
    /** Container id → the tabs this plugin opened inside it. */
    this._contextTabs = new Map()
    /** When the current session started (for the status report). */
    this._startedAt = Date.now()
    /** @type {{diagnosis: string, target: string, at: number, suggestEgress: boolean}|null} */
    this._lastNetCheck = null
    /** @type {Record<string, string|number|boolean>} */
    this._runtimePrefs = {}
    /** Cached version of the Firefox binary ('' when it cannot be read). */
    this._binaryVersionCache = null
    /** Serves screenshots by URL so a chat client can render them. */
    this.images = new ImageServer({
      dir: join(this.opts.copyBaseDir || defaultCopyBase(), 'images'),
    })
    /** @type {EgressProxy} */
    this.egressProxy = new EgressProxy({
      onEvent: (event) => /** @type {any} */ (this)._recordEgress(event),
    })
  }

  /** Is the provider usable right now? */
  get ready() {
    return this.state === STATE.READY || this.state === STATE.DEGRADED
  }

  // Backward-compatible property aliases backed by `this._state`.
  get _snapshotSeq() {
    return this._state.snapshotSeq
  }
  set _snapshotSeq(value) {
    this._state.snapshotSeq = value
  }
  get _lastSnapshotElements() {
    return this._state.lastSnapshotElements
  }
  set _lastSnapshotElements(value) {
    this._state.lastSnapshotElements = value
  }
  get _snapshotBaselines() {
    return this._state.snapshotBaselines
  }
  set _snapshotBaselines(value) {
    this._state.snapshotBaselines = value
  }
  get _snapshotByContext() {
    return this._state.snapshotByContext
  }
  set _snapshotByContext(value) {
    this._state.snapshotByContext = value
  }
  get _pageWarnings() {
    return this._state.pageWarnings
  }
  set _pageWarnings(value) {
    this._state.pageWarnings = value
  }
  get _pageSignals() {
    return this._state.pageSignals
  }
  set _pageSignals(value) {
    this._state.pageSignals = value
  }
  get _lastUrl() {
    return this._state.lastUrl
  }
  set _lastUrl(value) {
    this._state.lastUrl = value
  }
  get _tabUrls() {
    return this._state.tabUrls
  }
  set _tabUrls(value) {
    this._state.tabUrls = value
  }
  get config_() {
    return this._state.config
  }
  set config_(value) {
    this._state.config = value
  }

  // -------------------------------------------------------------------------
  // JavaScript dialogs
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Firefox containers (user contexts)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Extensions
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Cookies
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Request interception
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Detectability
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // CAPTCHA solving
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Batching
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Scripts
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------
}

/**
 * Attach a group of methods to the prototype.
 *
 * The methods were moved out of the class body into one module per concern.
 * They are attached here rather than inherited, so `this` inside them is the
 * provider instance — exactly as it was when they lived in the class.
 *
 * The property attributes mirror a class method: writable, configurable and
 * NOT enumerable.
 *
 * @param {Record<string, any>} target   the prototype to extend
 * @param {Record<string, any>} methods  the method bag to attach
 */
function applyMethods(target, methods) {
  for (const [name, fn] of Object.entries(methods)) {
    Object.defineProperty(target, name, {
      value: fn,
      writable: true,
      configurable: true,
      enumerable: false,
    })
  }
}

applyMethods(FirefoxProvider.prototype, sessionMethods)
applyMethods(FirefoxProvider.prototype, processMethods)
applyMethods(FirefoxProvider.prototype, eventsMethods)
applyMethods(FirefoxProvider.prototype, tabsMethods)
applyMethods(FirefoxProvider.prototype, actionMethods)
applyMethods(FirefoxProvider.prototype, targetMethods)
applyMethods(FirefoxProvider.prototype, inspectMethods)
applyMethods(FirefoxProvider.prototype, diagnosticMethods)
applyMethods(FirefoxProvider.prototype, firefoxMethods)
applyMethods(FirefoxProvider.prototype, captchaMethods)
applyMethods(FirefoxProvider.prototype, workflowMethods)
applyMethods(FirefoxProvider.prototype, verifyMethods)
applyMethods(FirefoxProvider.prototype, findMethods)
applyMethods(FirefoxProvider.prototype, netMethods)
applyMethods(FirefoxProvider.prototype, supportMethods)

/**
 * Make a value safe to send over JSON-RPC.
 *
 * @param {*} value
 * @returns {*}
 */

/**
 * Resolve the base directory for the profile copy.
 *
 * The copy holds LIVE CREDENTIALS (cookies.sqlite, key4.db, logins.json), so
 * it must live outside the plugin package: the package is size-limited,
 * scanned, and may be reinstalled at any time.
 *
 * Resolution order (first hit wins):
 *
 *   1. `FIREFOX_BROWSER_PROFILE_COPY` — explicit operator override.
 *   2. `PLUGIN_DATA` — the platform's own per-plugin data dir. Injected by
 *      some host/plugin-format combinations, absent in others.
 *   3. The platform's plugin-data convention
 *      (`<plugins-root>/.plugin-data/<plugin-name>`), derived from this
 *      file's own location — needs NO injection, so it works regardless of
 *      how the plugin was loaded.
 *   4. `<HOME>/.minimax/v2/plugin-data/agent-plugins/<plugin-name>` — the
 *      same shape the runtime uses for Agent Plugins V1 packages.
 *   5. `<HOME>/.cache/<plugin-name>/profile` — last resort.
 *
 * @returns {string} an absolute base directory
 */

/**
 * Busy-wait synchronously.
 *
 * Only used on the shutdown path, where an await is not possible.
 *
 * @param {number} ms
 */

/**
 * Pause asynchronously.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */

/**
 * Process-wide singleton — one Firefox instance per plugin process.
 *
 * @type {FirefoxProviderInstance|null}
 */
let _singleton = null

/**
 * Get (or create) the shared provider.
 *
 * @param {Record<string, any>} [opts]
 * @returns {FirefoxProviderInstance}
 */
export function getFirefoxProvider(opts = {}) {
  if (!_singleton) {
    _singleton = /** @type {FirefoxProviderInstance} */ (new FirefoxProvider(opts))
  }
  return _singleton
}

/** Drop the singleton (tests / restart). */
export function resetFirefoxProvider() {
  if (_singleton) {
    try {
      _singleton.client && _singleton.client.close()
    } catch {}
  }
  _singleton = null
}
