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
import { captchaMethods } from './provider/captcha.js'
import { workflowMethods } from './provider/workflow.js'
import { verifyMethods } from './provider/verify.js'
import { findMethods } from './provider/find.js'
import { supportMethods } from './provider/support.js'
import { STATE } from './provider/constants.js'
import { defaultCopyBase } from './provider/helpers.js'
import { NetworkLog } from './network.js'
import { ImageServer } from './images.js'
import { DEFAULT_MAX_ELEMENTS } from './snapshot.js'
import { createRegistryKey, REF_MODE } from './registry.js'
import { DialogManager, DIALOG_POLICY } from './dialogs.js'
import { AuditCounter } from './audit.js'
import { CapabilitySet } from './capabilities.js'
import { join } from 'node:path'

// Re-exported so the long-standing import path keeps working: the script
// root allow-list and the preset tables belong to the workflow concern, but
// callers have always reached them through provider.js.
export { scriptRoots, presetTools, presetNotes } from './provider/workflow.js'
export { STATE, DEFAULT_MAX_TEXT_CHARS } from './provider/constants.js'
export { normalizeUrl, defaultCopyBase } from './provider/helpers.js'

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
   * @param {object} [opts]
   * @param {string} [opts.bin]         Firefox binary (auto-detect when unset)
   * @param {number} [opts.port]        preferred BiDi port
   * @param {boolean} [opts.headless]
   * @param {string} [opts.profileDir]  source profile (auto-detect when unset)
   * @param {string} [opts.copyDir]     where the profile copy lives
   * @param {number} [opts.timeoutMs]   per-BiDi-command timeout
   */
  constructor(opts = {}) {
    this.opts = opts
    this.state = STATE.IDLE
    this.error = null
    this.client = null
    this.bin = opts.bin || null
    this.port = opts.port || null
    this.pid = null
    this.sourceProfile = opts.profileDir || null
    this.copyDir = opts.copyDir || null
    this.profileInfo = null
    this.logs = []
    this._lastContextId = null
    /** @type {NetworkLog} */
    this.networkLog = new NetworkLog()
    /** In-flight start promise — concurrent callers await the same one. */
    this._startPromise = null
    /** An instance that was kept alive by `stop({keep:true})`. */
    this._retained = null
    /** Monotonic snapshot id. */
    this._snapshotSeq = 0
    /**
     * The tool names, in catalogue order.
     *
     * The provider needs the order to report the effective tool set, but
     * the order belongs to the MCP layer — it is the prompt-cache prefix.
     * The server sets this once the catalogue is built.
     *
     * @type {string[]}
     */
    this._toolCatalogue = []
    /**
     * The last snapshot's elements, used to compute a delta.
     *
     * @type {Array<object>}
     */
    this._lastSnapshotElements = []
    /**
     * The current page's injection warnings.
     *
     * Refreshed on every read, cleared on every navigation. L3's gate
     * reads this to decide whether an action is a data-egress action on a
     * page that carries a high-severity injection.
     *
     * @type {Array<object>}
     */
    this._pageWarnings = []
    /**
     * The current page's instruction-shaped signals.
     *
     * Signals do not warn and never block — they are the facts L3's first
     * level (the confirm upgrade) is built on.
     *
     * @type {Array<object>}
     */
    this._pageSignals = []
    /**
     * The current page's URL, used for the provenance origin.
     *
     * Only ever used to derive an ORIGIN — never returned whole, because
     * a query string routinely carries session tokens.
     *
     * @type {string}
     */
    this._lastUrl = ''
    /** Subscription bookkeeping for diagnostics. */
    this.subscriptions = { subscribed: [], failed: [] }
    /**
     * The page-side ref registry key.
     *
     * Random per session: it names a non-enumerable property on `window` that
     * holds the element→ref map. Nothing is written to the DOM, so the page
     * cannot see the plugin's bookkeeping.
     */
    this._registryKey = createRegistryKey()
    /** Which storage mode the refs currently use. */
    this._refMode = REF_MODE.REGISTRY
    /**
     * Frame label → frame context id.
     *
     * Refs that live inside an iframe carry the frame's label, so an action
     * can be routed to the right browsing context.
     */
    this._frameMap = new Map()
    /**
     * Contexts that already carry the CAPTCHA preload script.
     *
     * The patch has to be installed exactly once per context: a second
     * install would wrap `attachShadow` twice, and the second wrapper would
     * overwrite the root the first one stored.
     *
     * @type {Set<string>}
     */
    this._captchaPreloads = new Set()
    /** @type {DialogManager} */
    this.dialogs = new DialogManager()
    /**
     * The action audit trail.
     *
     * @type {AuditCounter}
     */
    this.audit = new AuditCounter()
    /**
     * Counts the dialogs that have opened.
     *
     * An action captures the counter BEFORE it runs and compares afterwards:
     * if it moved, a dialog opened during that action and the action's
     * result should say so. Without the counter the only way to find out is
     * to wait a fixed window for an event that may never arrive — which is
     * what the plugin used to do, and it cost every single action 250ms.
     */
    this._dialogEpoch = 0
    /**
     * How long an action waits for a dialog event that may still be in
     * flight, in milliseconds.
     *
     * The event normally arrives BEFORE the action's own command returns, so
     * this window is only a safety net for the race. It is short on
     * purpose; raise it with FIREFOX_BROWSER_DIALOG_SETTLE_MS if a page is
     * known to open its dialog late.
     */
    this._dialogSettleMs = readSettleMs()
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
    /** Cached version of the Firefox binary ('' when it cannot be read). */
    this._binaryVersionCache = null
    /** Tool preset / behavioural configuration. */
    this.config_ = {
      preset: 'basic',
      dialogPolicy: DIALOG_POLICY.AUTO_DISMISS,
      maxSnapshotElements: DEFAULT_MAX_ELEMENTS,
      /**
       * Whether an action's response carries a light view of the page as it
       * looks after the action.
       *
       * On by default: an action changes the page, and the agent's next
       * question is almost always "what does it look like now?". Answering
       * that in the same response saves a round trip. Turn it off when the
       * page is large and the extra elements are noise.
       */
      inlineSnapshot: true,
    }
    /**
     * Serves screenshots by URL so a chat client can render them.
     *
     * It lives next to the profile copies — the plugin data directory, which
     * is outside the package — and it starts lazily on the first screenshot.
     */
    this.images = new ImageServer({
      dir: join(this.opts.copyBaseDir || defaultCopyBase(), 'images'),
    })
  }

  /** Is the provider usable right now? */
  get ready() {
    return this.state === STATE.READY || this.state === STATE.DEGRADED
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
 * @param {object} target   the prototype to extend
 * @param {object} methods  the method bag to attach
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
 */
let _singleton = null

/**
 * Get (or create) the shared provider.
 *
 * @param {object} [opts]
 * @returns {FirefoxProvider}
 */
export function getFirefoxProvider(opts = {}) {
  if (!_singleton) _singleton = new FirefoxProvider(opts)
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
