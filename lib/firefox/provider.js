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
//   provider.js  → the Firefox process, the BiDi client/session, the
//                  currently focused tab, the console log buffer
//   snapshot.js  → the ref registry
//   network.js   → the network request buffer
//   profile.js   → the profile copy

import { BidiClient } from '../bidi/client.js'
import * as bidi from '../bidi/protocol.js'
import {
  detectUserProfile,
  isProfileLocked,
  ensureProfileCopy,
  applyProfilePrefs,
  prefsFromEnvironment,
  profileCopyPath,
  profileLabel,
  profileLockMarkers,
} from './profile.js'
import {
  detectFirefoxBin,
  findFreePort,
  readBinaryVersion,
  spawnFirefox,
  waitForBiDi,
} from './launcher.js'
import { NetworkLog, attachNetworkLog } from './network.js'
import { ImageServer } from './images.js'
import { takeSnapshot, clearRefs, DEFAULT_MAX_ELEMENTS, MAX_ELEMENTS_LIMIT } from './snapshot.js'
import { resolveTarget, inspectElement, resolveSharedId } from './selector.js'
import { evaluateGate, ACTION_KINDS } from './confirm.js'
import { solveCaptcha, checkSolved, prepareContext } from './captcha.js'
import * as inputs from './inputs.js'
import * as waiter from './wait.js'
import { FINGERPRINT_EXPRESSION } from './fingerprint.js'
import {
  createRegistryKey,
  ensureRegistry,
  clearRegistry,
  frameLabel,
  splitRef,
  isRefShape,
  LOOKUP_ELEMENT,
  REF_MODE,
} from './registry.js'
import { DialogManager, DIALOG_POLICY } from './dialogs.js'
import { CapabilitySet, capabilityError, expectedFeatures, FEATURES } from './capabilities.js'
import * as contexts from './contexts.js'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This plugin's package name — used to derive the profile-copy location. */
const PLUGIN_NAME = 'firefox-browser'

/** Provider lifecycle states. */
export const STATE = {
  IDLE: 'idle',
  STARTING: 'starting',
  READY: 'ready',
  DEGRADED: 'degraded',
  FAILED: 'failed',
}

/**
 * Normalize a URL for navigation.
 *
 * Firefox rejects a scheme-less URL outright (NS_ERROR_MALFORMED_URI), and
 * agents routinely pass bare hostnames. Local addresses keep their scheme.
 *
 * @param {string} url
 * @returns {string}
 */
export function normalizeUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) return raw
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(raw)) {
    return `http://${raw}`
  }
  return `https://${raw}`
}

/**
 * Default number of characters `browser_text` returns.
 *
 * Deliberately kept below the ~8195-char budget a single tool result should
 * occupy: reading a page must not flood the agent's context. Longer pages
 * are truncated and the caller pages through with `offset`/`nextOffset`.
 */
export const DEFAULT_MAX_TEXT_CHARS = 8000

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

  /**
   * The version of the Firefox binary, read once and cached.
   *
   * `session.status` refuses to report the version once a session is running
   * ("Session already started"), so the binary is the reliable source. The
   * status uses it to describe the capabilities of a browser that is not
   * running yet.
   *
   * @returns {string} e.g. "140.11.0esr", or '' when it cannot be read
   */
  binaryVersion() {
    if (this.browserVersion) return this.browserVersion
    if (this._binaryVersionCache === null) {
      const bin = this.bin || this.opts.bin || detectFirefoxBin()
      this._binaryVersionCache = bin ? readBinaryVersion(bin) || '' : ''
    }
    return this._binaryVersionCache
  }

  /**
   * Start Firefox (if needed) and open a BiDi session.
   *
   * Idempotent AND concurrency-safe: concurrent callers share one in-flight
   * start and all receive the same result. A previously kept-alive instance
   * is re-adopted rather than replaced, so its tabs and login state survive.
   *
   * @returns {Promise<{ok: boolean, error?: string, port?: number, sessionId?: string, profile?: object}>}
   */
  async start() {
    if (this.ready && this.client && this.client.connected) {
      return this._startResult(true)
    }
    // Share one in-flight start with every concurrent caller.
    if (this._startPromise) return this._startPromise
    this._startPromise = this._startInternal().finally(() => {
      this._startPromise = null
    })
    return this._startPromise
  }

  async _startInternal() {
    this.state = STATE.STARTING
    this.error = null

    // 0) Re-adopt a kept-alive instance when one is around.
    //
    //    `stop({keep:true})` leaves Firefox running with the profile copy
    //    locked. Starting a second Firefox on that copy fails with
    //    "Firefox is already running" — but the kept instance's BiDi
    //    endpoint is still alive and accepts a new session. Re-adopting it
    //    preserves the tabs and the login state.
    if (this._retained) {
      const adopted = await this._adoptRetained()
      if (adopted.ok) return adopted
      this._retained = null
    }

    // 1) Locate Firefox.
    this.bin = this.opts.bin || detectFirefoxBin()
    if (this.bin) {
      // The Firefox version has to come from the BINARY: `session.status`
      // refuses to report it once a session is running ("Session already
      // started"), and the capability matrix depends on knowing it.
      this.browserVersion = readBinaryVersion(this.bin)
    }
    if (!this.bin) {
      this.state = STATE.FAILED
      this.error =
        'firefox not found — install Firefox or set FIREFOX_BROWSER_BIN to its path'
      return { ok: false, error: this.error }
    }

    // 2) Locate + copy the user profile.
    const srcProfile = this.sourceProfile || detectUserProfile()
    if (!srcProfile) {
      this.state = STATE.FAILED
      this.error =
        'no Firefox profile found — set FIREFOX_BROWSER_PROFILE to a profile path'
      return { ok: false, error: this.error }
    }
    const copyDir =
      this.copyDir || profileCopyPath(this.opts.copyBaseDir || defaultCopyBase(), srcProfile)

    const copy = ensureProfileCopy({ srcDir: srcProfile, destDir: copyDir })
    if (!copy.ok) {
      this.state = STATE.FAILED
      this.error = `profile copy failed: ${copy.error}`
      return { ok: false, error: this.error }
    }
    this.sourceProfile = srcProfile
    this.copyDir = copyDir
    this.profileInfo = {
      source: srcProfile,
      sourceLabel: profileLabel(srcProfile),
      copy: copyDir,
      copied: copy.copied.length,
      refreshed: copy.refreshed,
      locked: isProfileLocked(srcProfile),
    }

    // 2b) Apply the operator's extra preferences to the COPY.
    //
    //     Only the copy is touched — the user's real profile is never
    //     modified. This is how an operator can, for example, turn on
    //     resistFingerprinting for the automation session.
    const envPrefs = prefsFromEnvironment()
    if (!envPrefs.ok) {
      this.profilePrefsError = envPrefs.error
    } else if (Object.keys(envPrefs.prefs).length) {
      const applied = applyProfilePrefs(copyDir, envPrefs.prefs)
      this.profilePrefs = applied
      if (!applied.ok) this.profilePrefsError = applied.error
    }

    // 3) Pick a port, launch, and open a session.
    //
    //    A port can LOOK free and still belong to another Firefox: the check
    //    and the launch are not atomic, and a stale browser from an earlier
    //    run may still hold the port. When that happens our own Firefox
    //    cannot bind, and the BiDi endpoint we reach belongs to the OTHER
    //    browser — driving it would silently control the wrong instance.
    //
    //    The tell-tale sign: we just launched this Firefox, so it cannot
    //    already carry a session. A `session.new` refusal therefore proves
    //    the endpoint is not ours. In that case we kill our doomed process
    //    and move on to the next port.
    const preferred = this.opts.port || 9333
    const maxAttempts = this.opts.portAttempts || 3
    const headless = this.opts.headless !== false
    let portCursor = preferred
    let lastError = null

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const port = await findFreePort(portCursor, 10)
      if (!port) {
        lastError = `no free port in ${portCursor}..${portCursor + 9} for the firefox BiDi endpoint`
        break
      }
      // Advance past the port we just tried. The step is deliberately
      // irregular: two plugin processes that race for the same port would
      // otherwise march to the SAME next port in lockstep — and collide
      // again on every retry. A per-process offset breaks that lockstep.
      portCursor = port + 1 + (process.pid % 8)

      const spawned = await spawnFirefox({
        bin: this.bin,
        port,
        profileDir: copyDir,
        headless,
        privileged: this.opts.privileged,
      })
      if (spawned.spawnError) {
        lastError = `failed to launch firefox: ${spawned.spawnError.message}`
        break
      }
      this.port = port
      this.pid = spawned.pid

      // 3a) Wait for the BiDi endpoint — but give up early if Firefox died.
      //     When it cannot open the profile (it is locked) or cannot bind
      //     the port it exits immediately, and there is no point waiting out
      //     the full ready timeout for it.
      const readyTimeoutMs = this.opts.readyTimeoutMs || 30000
      const ready = await Promise.race([
        waitForBiDi({ port, timeoutMs: readyTimeoutMs }).then((r) => (r ? 'ready' : 'not-ready')),
        this._waitForExit(this.pid, readyTimeoutMs + 2000).then((exited) =>
          exited ? 'exited' : 'alive',
        ),
      ])
      if (ready === 'exited') {
        this._killProcess(this.pid)
        this.pid = null
        // Attribute the failure by evidence, not by guesswork: a locked
        // profile copy is a very different problem from a busy port.
        lastError = this._explainLaunchFailure(copyDir, port)
        continue
      }
      if (ready !== 'ready') {
        this._killProcess(this.pid)
        this.pid = null
        lastError = `firefox started but its BiDi endpoint on port ${port} never became ready`
        continue
      }

      // 3b) Connect.
      const client = new BidiClient({
        host: '127.0.0.1',
        port,
        timeoutMs: this.opts.timeoutMs || 30000,
      })
      try {
        await client.connect()
      } catch (e) {
        try {
          client.close()
        } catch {}
        this._killProcess(this.pid)
        this.pid = null
        lastError = `bidi connect failed: ${e.message}`
        continue
      }

      // 3c) Is this endpoint OUR browser? A fresh Firefox has no session, so
      //     an existing one means another instance owns the port.
      //
      //     This is only a hint: Firefox does not always expose a foreign
      //     session's id on a connection that has not created one, so a
      //     null result here does NOT prove the endpoint is ours. The
      //     authoritative check is the `session.new` refusal in 3d.
      let status = null
      try {
        status = await bidi.sessionStatus(client)
      } catch {
        status = null
      }
      if (status && status.sessionId) {
        try {
          client.close()
        } catch {}
        this._killProcess(this.pid)
        this.pid = null
        lastError = `port ${port} is served by another Firefox instance (session ${status.sessionId})`
        continue
      }

      this.client = client
      client.on('event', (method, params) => this._onEvent(method, params))
      client.on('commandError', (method, message) =>
        this._log('bidi', 'error', `${method}: ${message}`),
      )
      client.on('close', () => {
        if (this.state === STATE.READY) this.state = STATE.DEGRADED
      })

      // 3d) Open the session.
      let session
      try {
        session = await bidi.sessionNew(client)
      } catch (e) {
        try {
          client.close()
        } catch {}
        this.client = null
        this._killProcess(this.pid)
        this.pid = null
        lastError = `bidi session failed: ${e.message}`
        continue
      }

      if (session.reused) {
        // We just launched this Firefox, so it cannot already carry a
        // session. `session.new` being refused therefore means the endpoint
        // belongs to a DIFFERENT Firefox that owns this port — driving it
        // would silently control the wrong browser. Drop it and try the
        // next port.
        try {
          client.close()
        } catch {}
        this.client = null
        this._killProcess(this.pid)
        this.pid = null
        lastError = `port ${port} is served by another Firefox instance`
        continue
      }

      this.sessionId = session.sessionId
      this.sessionReused = false
      await this._subscribe()

      this.state = STATE.READY
      return this._startResult(false)
    }

    this.state = STATE.FAILED
    this.error = lastError || 'failed to start firefox'
    return { ok: false, error: this.error }
  }

  /**
   * Re-adopt an instance that was kept alive by `stop({keep:true})`.
   *
   * The kept Firefox still owns the profile copy (its lock files remain), so
   * launching a second Firefox on the same copy fails. But its BiDi endpoint
   * is still serving and accepts a new session — verified on Firefox 140
   * ESR. Re-adopting is therefore the correct recovery.
   *
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async _adoptRetained() {
    const retained = this._retained
    if (!retained || !retained.port) return { ok: false, error: 'no retained instance' }

    const client = new BidiClient({
      host: '127.0.0.1',
      port: retained.port,
      timeoutMs: this.opts.timeoutMs || 30000,
    })
    try {
      await client.connect()
    } catch (e) {
      try {
        client.close()
      } catch {}
      return { ok: false, error: `retained instance is unreachable: ${e.message}` }
    }

    let session
    try {
      session = await bidi.sessionNew(client)
    } catch (e) {
      try {
        client.close()
      } catch {}
      return { ok: false, error: `retained instance refused a new session: ${e.message}` }
    }
    if (session.reused) {
      try {
        client.close()
      } catch {}
      return { ok: false, error: 'retained instance still owns its session' }
    }

    this.client = client
    this.port = retained.port
    this.pid = retained.pid
    this.sessionId = session.sessionId
    this.sessionReused = false
    client.on('event', (method, params) => this._onEvent(method, params))
    client.on('commandError', (method, message) =>
      this._log('bidi', 'error', `${method}: ${message}`),
    )
    client.on('close', () => {
      if (this.state === STATE.READY) this.state = STATE.DEGRADED
    })
    await this._subscribe()

    this.state = STATE.READY
    this.error = null
    const result = this._startResult(true)
    result.reused = true
    result.adopted = true
    return result
  }

  /**
   * Explain why a Firefox launch failed, using evidence.
   *
   * A locked profile copy is a different problem from a busy port, and the
   * old message guessed "port already in use?" — which sent agents (and
   * humans) looking in the wrong place.
   *
   * @param {string} copyDir
   * @param {number} port
   * @returns {string}
   */
  _explainLaunchFailure(copyDir, port) {
    const markers = profileLockMarkers(copyDir)
    if (markers.length > 0) {
      return (
        `firefox exited immediately: the profile copy at ${copyDir} is locked by another ` +
        `instance (${markers.join(', ')}). Close that instance, or stop this plugin with ` +
        `browser_stop({keep:true}) so the existing browser can be re-adopted.`
      )
    }
    return `firefox exited while binding the BiDi port ${port} (port already in use?)`
  }

  /**
   * Subscribe to the events the plugin needs.
   *
   * Each event is subscribed to individually because Firefox's
   * `session.subscribe` is all-or-nothing — one invalid event name would
   * void the whole batch.
   *
   * @returns {Promise<void>}
   */
  async _subscribe() {
    const subscribed = []
    const failed = []

    const logSub = await bidi.subscribe(this.client, ['log.entryAdded'])
    subscribed.push(...logSub.subscribed)
    failed.push(...logSub.failed)

    const netSub = await attachNetworkLog(this.client, this.networkLog)
    subscribed.push(...netSub.subscribed)
    failed.push(...netSub.failed)

    // JavaScript dialogs. Without this the page can BLOCK on an alert() and
    // every later command times out with no explanation.
    const dialogSub = await bidi.subscribeUserPrompt(this.client)
    subscribed.push(...dialogSub.subscribed)
    failed.push(...dialogSub.failed)

    this.subscriptions = { subscribed, failed }
    this.capabilities.reset()
    // A new session means a new page world: use a fresh registry key so a
    // page can never correlate two sessions through the same key.
    this._registryKey = createRegistryKey()
    this._frameMap.clear()
    this._interceptors.clear()
    this._pausedRequests.clear()
  }

  /**
   * Resolve when the Firefox process exits, or after `timeoutMs`.
   *
   * @param {number} pid
   * @param {number} timeoutMs
   * @returns {Promise<boolean>} true when the process is gone
   */
  _waitForExit(pid, timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs
      const tick = () => {
        let alive = true
        try {
          process.kill(pid, 0) // signal 0 = existence check
        } catch {
          alive = false
        }
        if (!alive) return resolve(true)
        if (Date.now() >= deadline) return resolve(false)
        setTimeout(tick, 100)
      }
      tick()
    })
  }

  _startResult(reused) {
    return {
      ok: true,
      reused,
      port: this.port,
      pid: this.pid,
      sessionId: this.sessionId,
      sessionReused: !!this.sessionReused,
      profile: this.profileInfo,
    }
  }

  /**
   * Close the BiDi session.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.kill]  also terminate the Firefox process we
   *   started. Default true — otherwise every `start` leaves an orphaned
   *   headless Firefox behind, which is a resource leak. Pass false to
   *   leave the window open for the user to look at.
   * @returns {Promise<{ok: boolean, killed?: boolean}>}
   */
  async stop(opts = {}) {
    const kill = opts.kill !== false
    // Release anything the intercepts are holding: a paused request would
    // keep the page frozen even after the browser is going away.
    try {
      await this._clearIntercepts()
    } catch {
      /* best effort */
    }
    // The image server holds published screenshots on disk. They are of no
    // use once the browser is gone, and they can contain anything the user
    // was looking at — so they go away with the session.
    try {
      await this.images.stop()
    } catch {
      /* best effort */
    }
    if (this.client) {
      try {
        await bidi.sessionEnd(this.client)
      } catch {
        // The browser may already be gone; closing is best-effort.
      }
      try {
        this.client.close()
      } catch {}
    }
    this.client = null
    this.state = STATE.IDLE
    this.sessionId = null
    // The capability matrix describes a RUNNING browser. Once the browser is
    // gone the cached probe is stale, so the status falls back to the
    // version-based expectation instead of reporting a dead session's probe.
    this.capabilities.reset()

    let killed = false
    if (kill && this.pid) {
      // Wait for the process to actually be gone: a caller that re-checks
      // the pid right after stop() must not still see it alive.
      killed = await this._killProcessAndWait(this.pid)
      if (killed) this.pid = null
      this._retained = null
    } else if (!kill && this.pid) {
      // Keep the browser alive, but remember it: a later start() re-adopts
      // it instead of fighting it over the locked profile copy.
      this._retained = { port: this.port, pid: this.pid }
    }
    return { ok: true, killed }
  }

  /**
   * Terminate a Firefox process we started.
   *
   * The process was spawned detached (its own process group), so it must be
   * signalled as a group — otherwise the content-process children survive.
   *
   * @param {number} pid
   * @returns {boolean} true when the process was signalled
   */
  _killProcess(pid) {
    if (!pid) return false
    const signalled = this._signalGroup(pid, 'SIGTERM')
    if (!signalled) return false
    // Firefox can take a moment to shut down. Escalate if it lingers, so a
    // stopped provider never leaves a headless browser behind.
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if (!this._isAlive(pid)) return true
      sleepSync(100)
    }
    this._signalGroup(pid, 'SIGKILL')
    return true
  }

  /**
   * Terminate a Firefox process and WAIT until it is really gone.
   *
   * `_killProcess` signals and returns; the process may still be shutting
   * down when it returns, so a caller that immediately re-checks the pid can
   * still see it alive. `stop()` uses this variant so that "the browser is
   * stopped" is true by the time the call returns.
   *
   * @param {number} pid
   * @returns {Promise<boolean>} true when the process is gone
   */
  async _killProcessAndWait(pid) {
    if (!pid) return false
    if (!this._signalGroup(pid, 'SIGTERM')) return false

    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if (!this._isAlive(pid)) return true
      await delay(100)
    }

    this._signalGroup(pid, 'SIGKILL')
    // Give the kernel a moment to reap the process before reporting.
    const killDeadline = Date.now() + 2000
    while (Date.now() < killDeadline) {
      if (!this._isAlive(pid)) return true
      await delay(50)
    }
    return !this._isAlive(pid)
  }

  /**
   * Signal a detached process group, falling back to the single process.
   *
   * @param {number} pid
   * @param {string} signal
   * @returns {boolean}
   */
  _signalGroup(pid, signal) {
    try {
      // Negative pid = signal the whole process group.
      process.kill(-pid, signal)
      return true
    } catch {
      try {
        process.kill(pid, signal)
        return true
      } catch {
        return false
      }
    }
  }

  /**
   * Is a process still alive?
   *
   * @param {number} pid
   * @returns {boolean}
   */
  _isAlive(pid) {
    try {
      process.kill(pid, 0) // signal 0 = existence check
      return true
    } catch {
      return false
    }
  }

  /**
   * Terminate the Firefox process immediately and synchronously.
   *
   * `stop()` is async, which makes it unusable from a process `exit` handler —
   * there is no time left to await. This is the last-resort net that stops
   * an orphaned headless Firefox from outliving the plugin.
   *
   * @returns {boolean} true when a process was signalled
   */
  killNow() {
    if (!this.pid) return false
    const killed = this._killProcess(this.pid)
    if (killed) this.pid = null
    return killed
  }

  /**
   * Ensure a live session before running a command.
   * Restarts the browser if it died.
   */
  async _ensureReady() {
    if (this.client && this.client.connected) return true
    if (this.state === STATE.FAILED && this.bin) {
      // A previous start failed — try again from scratch.
      this.state = STATE.IDLE
    }
    const res = await this.start()
    return !!res.ok
  }

  _onEvent(method, params) {
    if (method === 'log.entryAdded') {
      const level = params?.level || 'info'
      const text = params?.text || ''
      const source = params?.source?.context || ''
      this.logs.push({ channel: 'console', level, text, source, at: Date.now() })
      // Keep the buffer bounded — the agent rarely needs more than the tail.
      if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500)
      return
    }

    if (method === 'browsingContext.userPromptOpened') {
      const dialog = this.dialogs.onPromptOpened(params || {})
      this._log('plugin', 'info', `dialog opened (${dialog.type}): ${dialog.message || '(no message)'}`)
      // Close it right away under the current policy. This is what keeps the
      // agent from hanging: while a dialog is open, Firefox refuses to
      // evaluate scripts or accept input.
      this._scheduleDialogAutoHandle()
      return
    }

    if (method === 'browsingContext.userPromptClosed') {
      this.dialogs.onPromptClosed(params || {})
      return
    }

    if (method === 'network.beforeRequestSent') {
      this._onInterceptedRequest(params || {})
      return
    }
  }

  /**
   * Decide what happens to a request that an intercept has paused.
   *
   * While an intercept is active Firefox holds every request until someone
   * continues or fails it. Forgetting that leaves the page frozen — so the
   * decision is made here, in the plugin, where the URL is visible.
   *
   * @param {object} params  the BiDi `network.beforeRequestSent` payload
   */
  _onInterceptedRequest(params) {
    if (!this._interceptors.size) return
    const requestId = params?.request?.request
    const url = params?.request?.url || ''
    if (!requestId) return

    const blocked = Array.from(this._interceptors.values()).some((interceptor) =>
      interceptor.patterns.some((pattern) => url.includes(pattern)),
    )

    if (blocked) {
      bidi
        .failRequest(this.client, requestId, 'blocked by the firefox-browser intercept')
        .catch(() => {})
      return
    }

    // Not blocked: let it through, but remember it so an interrupted session
    // can never leave a request hanging.
    const timer = setTimeout(() => {
      this._pausedRequests.delete(requestId)
      bidi.continueRequest(this.client, requestId).catch(() => {})
    }, 30000)
    if (typeof timer.unref === 'function') timer.unref()
    this._pausedRequests.set(requestId, timer)
    bidi
      .continueRequest(this.client, requestId)
      .then(() => {
        const pending = this._pausedRequests.get(requestId)
        if (pending) clearTimeout(pending)
        this._pausedRequests.delete(requestId)
      })
      .catch(() => {})
  }

  /**
   * Queue the automatic handling of open dialogs.
   *
   * The chain matters: several dialogs can open in quick succession, and
   * each one has to be closed before the page is usable again.
   */
  _scheduleDialogAutoHandle() {
    if (!this._dialogChain) this._dialogChain = Promise.resolve()
    this._dialogChain = this._dialogChain
      .then(() => this.dialogs.autoHandle(this.client))
      .catch(() => [])
    return this._dialogChain
  }

  /**
   * Wait for any pending automatic dialog handling to finish.
   *
   * Called before an action reports its effect, so the agent learns about a
   * dialog in the same response as the action that triggered it.
   *
   * @returns {Promise<object[]>} the dialogs that were handled
   */
  async _settleDialogs() {
    if (this._dialogChain) {
      try {
        await this._dialogChain
      } catch {
        /* best effort */
      }
    }
    // The event may arrive a moment after the action returned; give it a
    // short window before deciding that nothing happened.
    const deadline = Date.now() + 250
    while (Date.now() < deadline) {
      if (this.dialogs.recent.length || this.dialogs.pending.size) break
      await delay(25)
    }
    return this.dialogs.drain()
  }

  /**
   * Record a plugin-level event in the log buffer.
   *
   * The log has three channels so a diagnosis can tell them apart:
   * `console` (the page's own output), `plugin` (what this plugin did), and
   * `bidi` (a command the browser refused). "The page logged an error" and
   * "the plugin could not reach Firefox" need different fixes.
   *
   * @param {'plugin'|'bidi'} channel
   * @param {string} level
   * @param {string} text
   */
  _log(channel, level, text) {
    this.logs.push({ channel, level, text, at: Date.now() })
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500)
  }

  /**
   * Resolve which context to act on.
   *
   * The resolved context is returned to the caller and MUST be reused for
   * the whole action: concurrent calls each resolve their own target, so
   * one call can never land on another call's tab.
   *
   * @param {string} [contextId]
   * @returns {Promise<string|null>}
   */
  async _resolveContext(contextId) {
    if (contextId) return contextId
    if (this._lastContextId) return this._lastContextId
    const tabs = await this.listTabs()
    const first = tabs.find((t) => t.url && t.url !== 'about:blank') || tabs[0]
    return first ? first.contextId : null
  }

  /**
   * Resolve an action target (ref or selector) into something actionable.
   *
   * A ref that lives inside an iframe carries the frame's label; the resolved
   * `contextId` is then the FRAME's browsing context, so the action lands
   * where the agent pointed.
   *
   * @param {string} [selector]
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} [opts.ref]
   * @returns {Promise<{ok: true, target: string, resolved: object}
   *          | {ok: false, error: string, hint?: string, requiresResnapshot?: boolean}>}
   */
  async _resolveActionTarget(selector, contextId, opts = {}) {
    const target = await this._resolveContext(contextId)
    if (!target) {
      return { ok: false, error: 'no browsing context available' }
    }
    const resolved = await resolveTarget(this.client, {
      ref: opts.ref,
      selector,
      contextId: target,
      key: this._registryKey,
      legacy: this._refMode === REF_MODE.ATTRIBUTE,
      frameMap: this._frameMap,
    })
    if (!resolved.ok) {
      return {
        ok: false,
        error: resolved.error,
        hint: resolved.hint,
        requiresResnapshot: resolved.requiresResnapshot,
      }
    }
    return { ok: true, target, resolved }
  }

  /**
   * The element addressing arguments the input primitives expect.
   *
   * @param {object} resolved  the result of `resolveTarget`
   * @returns {{context: string, key: string, ref: string, selector: string}}
   */
  _elementArgs(resolved) {
    return {
      context: resolved.contextId,
      key: this._registryKey,
      ref: resolved.ref || '',
      selector: resolved.selector || '',
    }
  }

  /**
   * Describe the target for error messages.
   *
   * @param {object} resolved
   * @returns {string}
   */
  _describeTarget(resolved) {
    if (resolved.ref) return `ref "${resolved.ref}"`
    return `selector "${resolved.selector || ''}"`
  }

  /**
   * List open tabs.
   *
   * Failures are swallowed into an empty list — callers that only need "is
   * there a tab" should not have to handle errors. Use `tabsStatus()` when
   * the reason matters.
   *
   * @returns {Promise<Array<{contextId: string, url: string, type: string}>>}
   */
  async listTabs() {
    try {
      return await this._listTabs()
    } catch (e) {
      this.state = STATE.DEGRADED
      this.error = e.message
      return []
    }
  }

  /**
   * List open tabs, keeping the failure reason.
   *
   * An empty tab list is ambiguous — it can mean "no tabs" or "the query
   * failed". This variant tells the two apart.
   *
   * @returns {Promise<{ok: boolean, count?: number, tabs?: Array, error?: string}>}
   */
  async tabsStatus() {
    try {
      const tabs = await this._listTabs()
      return { ok: true, count: tabs.length, tabs }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  async _listTabs() {
    if (!(await this._ensureReady())) {
      throw new Error(this.error || 'firefox provider is not running')
    }
    const tree = await bidi.getTree(this.client)
    const flat = []
    const walk = (nodes, parent) => {
      for (const n of nodes) {
        flat.push({
          contextId: n.contextId,
          url: n.url,
          type: n.children && n.children.length > 0 ? 'tab' : 'page',
          parent: parent || null,
        })
        for (const ch of n.children || []) {
          flat.push({
            contextId: ch.contextId,
            url: ch.url,
            type: 'iframe',
            parent: n.contextId,
          })
          // Frames can nest — Firefox really does return grandchildren.
          for (const g of ch.children || []) {
            flat.push({
              contextId: g.contextId,
              url: g.url,
              type: 'iframe',
              parent: ch.contextId,
            })
          }
        }
      }
    }
    walk(tree, null)
    return flat
  }

  /**
   * Open a new tab (and optionally navigate it).
   * @param {string} url
   */
  async newTab(url) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    try {
      const contextId = await bidi.createTab(this.client, url ? normalizeUrl(url) : undefined)
      this._lastContextId = contextId
      return { ok: true, contextId, url }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  /**
   * Navigate a tab.
   * @param {string} url
   * @param {string} [contextId]
   * @param {string} [wait]  'none' | 'load' | 'complete'
   */
  async navigate(url, contextId, wait = 'complete') {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const target = await this._resolveContext(contextId)
    if (!target) return { ok: false, error: 'no browsing context available' }
    try {
      // Install the CAPTCHA preload patch BEFORE navigating: it has to run
      // before the page's own scripts, otherwise a closed shadow root that
      // is created during load is already unreachable by the time we look.
      await prepareContext(this.client, this._captchaPreloads, target)
      await bidi.navigate(this.client, normalizeUrl(url), target, wait)
      this._lastContextId = target
      const dialogs = await this._settleDialogs()
      const result = { ok: true, contextId: target, url: normalizeUrl(url) }
      if (dialogs.length) result.dialog = dialogs[0]
      return result
    } catch (e) {
      // A `beforeunload` dialog can block the navigation itself. The
      // auto-handler closes it, but the command may already have timed out.
      const dialogs = await this._settleDialogs()
      const result = { ok: false, error: e.message, contextId: target }
      if (dialogs.length) {
        result.dialog = dialogs[0]
        result.hint = 'the page raised a beforeunload dialog while navigating'
      }
      return result
    }
  }

  /**
   * Capture a lightweight fingerprint of the current page.
   *
   * Used to tell whether an action actually changed anything. Deliberately
   * cheap: it must not cost more than the action it is verifying.
   *
   * The fingerprint covers the body shape, the visible text length, and the
   * focused field's value. The last part matters because an <input>'s value
   * is not part of innerText: without it, typing into a field leaves the
   * fingerprint untouched and the action is reported as having had no
   * effect — even though the characters really were sent.
   *
   * A password field's value is never read into the fingerprint.
   *
   * @param {string} contextId
   * @returns {Promise<{url: string, title: string, fingerprint: string}>}
   */
  async _pageState(contextId) {
    try {
      const result = await bidi.evaluate(
        this.client,
        FINGERPRINT_EXPRESSION,
        contextId,
      )
      const value = bidi.unwrapRemoteValue(result)
      return {
        url: (value && value.url) || '',
        title: (value && value.title) || '',
        fingerprint: (value && value.fingerprint) || '',
      }
    } catch {
      return { url: '', title: '', fingerprint: '' }
    }
  }

  /**
   * Compare the page before and after an action.
   *
   * `verified` is honest: it is true only when there is observable evidence
   * that something changed. A command that returned successfully but left
   * the page untouched reports `verified: false`.
   *
   * @param {string} contextId
   * @param {object} before
   * @returns {Promise<object>}
   */
  async _effect(contextId, before) {
    const after = await this._pageState(contextId)
    const navigated = !!before.url && !!after.url && before.url !== after.url
    const domChanged = !!before.fingerprint && before.fingerprint !== after.fingerprint
    const verified = navigated || domChanged
    const effect = {
      url: after.url,
      title: after.title,
      navigated,
      domChanged,
      verified,
    }
    if (!verified) {
      effect.hint = 'no observable page change — the action may not have taken effect'
    }
    return effect
  }

  /**
   * Click an element.
   *
   * Uses real pointer input (pointerMove → pointerDown → pointerUp) rather
   * than `element.click()`. A synthetic DOM click does not produce the
   * trusted events many sites require, and it skips hit-testing.
   *
   * @param {string} [selector]  CSS selector (legacy path)
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} [opts.ref]        snapshot ref (preferred)
   * @param {boolean} [opts.confirm]   explicit confirmation for irreversible actions
   * @param {number} [opts.button]     0 left, 1 middle, 2 right
   * @param {number} [opts.clickCount] 2 for a double click
   */
  async click(selector, contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const resolution = await this._resolveActionTarget(selector, contextId, opts)
    if (!resolution.ok) {
      return { ...resolution, contextId: contextId || this._lastContextId }
    }
    const { target, resolved } = resolution
    const actionContext = resolved.contextId

    const info = await inspectElement(this.client, {
      contextId: actionContext,
      selector: resolved.selector,
      ref: resolved.ref,
      key: this._registryKey,
    })
    if (!info) {
      return {
        ok: false,
        error: `element not found: ${this._describeTarget(resolved)}`,
        contextId: actionContext,
      }
    }
    if (info.w === 0 || info.h === 0) {
      return {
        ok: false,
        error: `element has zero size (hidden or not laid out): ${this._describeTarget(resolved)}`,
        contextId: actionContext,
      }
    }

    // The irreversibility gate. A click that submits a form, downloads a
    // file or posts account data must be confirmed explicitly.
    const gate = evaluateGate({ info, confirm: opts.confirm })
    if (!gate.allowed) {
      return {
        ok: false,
        error: gate.error,
        hint: gate.hint,
        blocked: true,
        action: gate.action,
        requiresConfirm: true,
        contextId: actionContext,
      }
    }

    try {
      // Scroll the element into view first — a pointer click at
      // off-screen coordinates hits nothing.
      await bidi.callFunction(
        this.client,
        `(key, ref, selector) => {
          const el = (${LOOKUP_ELEMENT})(key, ref, selector);
          if (el) el.scrollIntoView({block: 'center', inline: 'center'});
          return !!el;
        }`,
        [
          { type: 'string', value: this._registryKey },
          { type: 'string', value: resolved.ref || '' },
          { type: 'string', value: resolved.selector || '' },
        ],
        actionContext,
      )
      const before = await this._pageState(actionContext)

      await inputs.pointerClick(this.client, {
        context: actionContext,
        x: info.x,
        y: info.y,
        button: opts.button,
        clickCount: opts.clickCount,
      })

      this._lastContextId = target
      const effect = await this._effect(actionContext, before)
      const dialogs = await this._settleDialogs()
      if (dialogs.length) effect.dialog = dialogs[0]
      const result = {
        ok: true,
        contextId: actionContext,
        ref: resolved.ref,
        selector: resolved.selector,
        via: resolved.via,
        x: info.x,
        y: info.y,
        effect,
      }
      if (resolved.ignoredSelector) {
        result.hint = `ref "${opts.ref}" took precedence; the selector argument was ignored`
      }
      return result
    } catch (e) {
      return { ok: false, error: e.message, contextId: actionContext }
    }
  }

  /**
   * Type text into an element.
   *
   * Focuses the element, then sends one key action per character so the page
   * receives genuine keyboard events (needed by search boxes, editors and
   * anything with keydown handlers).
   *
   * @param {string} [selector]  CSS selector (legacy path)
   * @param {string} text
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} [opts.ref]       snapshot ref (preferred)
   * @param {boolean} [opts.clear]    clear the field first
   * @param {boolean} [opts.submit]   press Enter afterwards
   * @param {boolean} [opts.confirm]  explicit confirmation if submitting
   */
  async type(selector, text, contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const resolution = await this._resolveActionTarget(selector, contextId, opts)
    if (!resolution.ok) {
      return { ...resolution, contextId: contextId || this._lastContextId }
    }
    const { target, resolved } = resolution
    const actionContext = resolved.contextId

    const info = await inspectElement(this.client, {
      contextId: actionContext,
      selector: resolved.selector,
      ref: resolved.ref,
      key: this._registryKey,
    })
    if (!info) {
      return {
        ok: false,
        error: `element not found: ${this._describeTarget(resolved)}`,
        contextId: actionContext,
      }
    }

    try {
      const args = this._elementArgs(resolved)
      if (opts.clear) {
        await inputs.clearElement(this.client, args)
      }
      const focused = await inputs.focusElement(this.client, args)
      if (!focused) {
        return {
          ok: false,
          error: `element not found: ${this._describeTarget(resolved)}`,
          contextId: actionContext,
        }
      }

      const before = await this._pageState(actionContext)
      await inputs.typeText(this.client, { context: actionContext, text: String(text ?? '') })

      // Typing that ends with Enter submits a form — that is irreversible,
      // so it goes through the same gate as a click.
      let submitted = false
      if (opts.submit) {
        const gate = evaluateGate({ info, confirm: opts.confirm })
        if (!gate.allowed) {
          return {
            ok: false,
            error: gate.error,
            hint: gate.hint,
            blocked: true,
            action: gate.action,
            requiresConfirm: true,
            contextId: actionContext,
          }
        }
        await inputs.pressKeys(this.client, {
          context: actionContext,
          keys: [inputs.encodeKey('Enter')],
        })
        submitted = true
      }

      this._lastContextId = target
      const effect = await this._effect(actionContext, before)
      const dialogs = await this._settleDialogs()
      if (dialogs.length) effect.dialog = dialogs[0]
      const result = {
        ok: true,
        contextId: actionContext,
        ref: resolved.ref,
        selector: resolved.selector,
        via: resolved.via,
        typed: String(text ?? '').length,
        submitted,
        effect,
      }
      if (resolved.ignoredSelector) {
        result.hint = `ref "${opts.ref}" took precedence; the selector argument was ignored`
      }
      return result
    } catch (e) {
      return { ok: false, error: e.message, contextId: actionContext }
    }
  }

  /**
   * Take an ARIA-style snapshot of the page.
   *
   * Refs are stored in a page-side registry, so the page cannot see the
   * plugin's bookkeeping. The registry is (re)created on demand: a
   * navigation wipes the page's realm, and the registry with it.
   *
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {number} [opts.maxElements]
   * @param {number} [opts.offset]
   * @param {string[]} [opts.roleFilter]
   * @param {string} [opts.nameContains]
   * @param {boolean} [opts.includeText]
   * @param {'none'|'all'} [opts.frames]  include iframe contents
   */
  async snapshot(contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const target = await this._resolveContext(contextId)
    if (!target) return { ok: false, error: 'no browsing context available' }
    try {
      const maxElements = Math.min(
        MAX_ELEMENTS_LIMIT,
        Math.max(1, opts.maxElements || this.config_.maxSnapshotElements || DEFAULT_MAX_ELEMENTS),
      )
      const legacy = !(await ensureRegistry(this.client, target, this._registryKey))
      // A page that refuses script evaluation cannot hold a registry; fall
      // back to the attribute mode and say so in the result.
      this._refMode = legacy ? REF_MODE.ATTRIBUTE : REF_MODE.REGISTRY

      const result = await takeSnapshot(this.client, {
        contextId: target,
        key: this._registryKey,
        maxElements,
        offset: opts.offset,
        roleFilter: opts.roleFilter,
        nameContains: opts.nameContains,
        includeText: opts.includeText,
        legacy,
      })
      this._snapshotSeq += 1
      this._lastContextId = target

      const payload = {
        ok: true,
        contextId: target,
        snapshotId: this._snapshotSeq,
        elements: result.elements,
        count: result.elements.length,
        total: result.total,
        truncated: result.truncated,
        hasMore: result.hasMore,
        nextOffset: result.nextOffset,
        refMode: this._refMode,
      }
      if (result.texts) payload.texts = result.texts

      if (opts.frames && opts.frames !== 'none') {
        const frames = await this._snapshotFrames(target, maxElements, legacy)
        payload.frames = frames
        payload.count += frames.reduce((sum, f) => sum + (f.elementCount || 0), 0)
      }

      return payload
    } catch (e) {
      return { ok: false, error: e.message, contextId: target }
    }
  }

  /**
   * Snapshot the child frames of a context.
   *
   * Each frame is a separate browsing context with its own realm, so it needs
   * its own registry instance — the same key works, because each realm has
   * its own `window`. Refs from a frame carry the frame's label so an action
   * can be routed back to it.
   *
   * @param {string} parentContextId
   * @param {number} maxElements
   * @param {boolean} legacy
   * @returns {Promise<Array<{frameId: string, url: string, elementCount: number}>>}
   */
  async _snapshotFrames(parentContextId, maxElements, legacy) {
    const frames = []
    let tree = []
    try {
      tree = await bidi.getTree(this.client)
    } catch {
      return frames
    }

    const children = []
    const collect = (nodes, parent) => {
      for (const node of nodes) {
        if (node.contextId === parentContextId) {
          for (const child of node.children || []) children.push(child)
        }
        if (node.children) collect(node.children, parent)
      }
    }
    collect(tree, parentContextId)

    for (const child of children) {
      if (!child || !child.contextId) continue
      const label = frameLabel(child.contextId)
      this._frameMap.set(label, child.contextId)
      try {
        if (!legacy) await ensureRegistry(this.client, child.contextId, this._registryKey)
        const frameSnap = await takeSnapshot(this.client, {
          contextId: child.contextId,
          key: this._registryKey,
          maxElements,
          legacy,
        })
        // Prefix the frame's refs so the agent can tell them apart and the
        // action can be routed to the right context.
        for (const element of frameSnap.elements) {
          element.ref = `${label}:${element.ref}`
          element.frameId = label
        }
        frames.push({
          frameId: label,
          contextId: child.contextId,
          url: child.url || '',
          elementCount: frameSnap.elements.length,
          elements: frameSnap.elements,
        })
      } catch {
        // A frame we cannot reach is skipped, not fatal.
      }
    }
    return frames
  }

  /**
   * Press a key or a key combination.
   *
   * @param {string} key  e.g. "Enter", "Escape", "Ctrl+Enter"
   * @param {string} [contextId]
   */
  async pressKey(key, contextId) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const target = await this._resolveContext(contextId)
    if (!target) return { ok: false, error: 'no browsing context available' }

    const combo = inputs.encodeCombo(key)
    if (combo.error) {
      return { ok: false, error: combo.error, contextId: target }
    }
    try {
      const before = await this._pageState(target)
      await inputs.pressKeys(this.client, { context: target, keys: combo.keys })
      this._lastContextId = target
      const effect = await this._effect(target, before)
      const dialogs = await this._settleDialogs()
      if (dialogs.length) effect.dialog = dialogs[0]
      return { ok: true, contextId: target, key, pressed: combo.keys.length, effect }
    } catch (e) {
      return { ok: false, error: e.message, contextId: target }
    }
  }

  /**
   * Choose an option in a `<select>`.
   *
   * @param {string} [selector]
   * @param {string} value
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} [opts.ref]
   * @param {boolean} [opts.byText]  match the visible text, not the value
   */
  async selectOption(selector, value, contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const resolution = await this._resolveActionTarget(selector, contextId, opts)
    if (!resolution.ok) {
      return { ...resolution, contextId: contextId || this._lastContextId }
    }
    const { target, resolved } = resolution
    const actionContext = resolved.contextId

    try {
      const result = await inputs.selectOption(this.client, {
        ...this._elementArgs(resolved),
        value,
        byText: opts.byText,
      })
      if (!result.ok) {
        return {
          ok: false,
          error: result.error || 'select failed',
          contextId: actionContext,
          options: result.options,
        }
      }
      this._lastContextId = target
      return {
        ok: true,
        contextId: actionContext,
        ref: resolved.ref,
        selector: resolved.selector,
        selected: result.selected,
        options: result.options,
      }
    } catch (e) {
      return { ok: false, error: e.message, contextId: actionContext }
    }
  }

  /**
   * Check or uncheck a checkbox / radio button.
   *
   * @param {string} [selector]
   * @param {boolean} checked
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} [opts.ref]
   */
  async check(selector, checked, contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const resolution = await this._resolveActionTarget(selector, contextId, opts)
    if (!resolution.ok) {
      return { ...resolution, contextId: contextId || this._lastContextId }
    }
    const { target, resolved } = resolution
    const actionContext = resolved.contextId

    try {
      const result = await inputs.checkElement(this.client, {
        ...this._elementArgs(resolved),
        checked,
      })
      if (!result.ok) {
        return { ok: false, error: result.error || 'check failed', contextId: actionContext }
      }
      this._lastContextId = target
      return {
        ok: true,
        contextId: actionContext,
        ref: resolved.ref,
        selector: resolved.selector,
        checked: result.checked,
      }
    } catch (e) {
      return { ok: false, error: e.message, contextId: actionContext }
    }
  }

  /**
   * Hover over an element.
   *
   * @param {string} [selector]
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} [opts.ref]
   */
  async hover(selector, contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const resolution = await this._resolveActionTarget(selector, contextId, opts)
    if (!resolution.ok) {
      return { ...resolution, contextId: contextId || this._lastContextId }
    }
    const { target, resolved } = resolution
    const actionContext = resolved.contextId

    const info = await inspectElement(this.client, {
      contextId: actionContext,
      selector: resolved.selector,
      ref: resolved.ref,
      key: this._registryKey,
    })
    if (!info) {
      return {
        ok: false,
        error: `element not found: ${this._describeTarget(resolved)}`,
        contextId: actionContext,
      }
    }
    if (info.w === 0 || info.h === 0) {
      return {
        ok: false,
        error: `element has zero size (hidden or not laid out): ${this._describeTarget(resolved)}`,
        contextId: actionContext,
      }
    }
    try {
      await bidi.callFunction(
        this.client,
        `(key, ref, selector) => {
          const el = (${LOOKUP_ELEMENT})(key, ref, selector);
          if (el) el.scrollIntoView({block: 'center', inline: 'center'});
          return !!el;
        }`,
        [
          { type: 'string', value: this._registryKey },
          { type: 'string', value: resolved.ref || '' },
          { type: 'string', value: resolved.selector || '' },
        ],
        actionContext,
      )
      await inputs.pointerMove(this.client, { context: actionContext, x: info.x, y: info.y })
      this._lastContextId = target
      return {
        ok: true,
        contextId: actionContext,
        ref: resolved.ref,
        selector: resolved.selector,
        x: info.x,
        y: info.y,
      }
    } catch (e) {
      return { ok: false, error: e.message, contextId: actionContext }
    }
  }

  /**
   * Scroll the page or bring an element into view.
   *
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} [opts.ref]
   * @param {string} [opts.selector]
   * @param {string} [opts.direction]  up | down | top | bottom
   * @param {number} [opts.amount]
   */
  async scroll(contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const target = await this._resolveContext(contextId)
    if (!target) return { ok: false, error: 'no browsing context available' }

    let selector = opts.selector
    let ref = ''
    let actionContext = target
    if (opts.ref) {
      const resolution = await this._resolveActionTarget(opts.selector, target, {
        ref: opts.ref,
      })
      if (!resolution.ok) {
        return { ...resolution, contextId: target }
      }
      selector = resolution.resolved.selector
      ref = resolution.resolved.ref || ''
      actionContext = resolution.resolved.contextId
    }
    try {
      const result = await inputs.scroll(this.client, {
        context: actionContext,
        key: this._registryKey,
        ref,
        selector,
        direction: opts.direction,
        amount: opts.amount,
      })
      if (!result.ok) {
        return { ok: false, error: result.error || 'scroll failed', contextId: actionContext }
      }
      this._lastContextId = target
      return {
        ok: true,
        contextId: actionContext,
        scrollY: result.scrollY,
        moved: result.moved,
      }
    } catch (e) {
      return { ok: false, error: e.message, contextId: actionContext }
    }
  }

  /**
   * Upload a file to a file input.
   *
   * Uploading sends local data to a remote site — that is irreversible from
   * the user's point of view, so it goes through the confirmation gate.
   *
   * @param {string} [selector]
   * @param {string[]} paths  absolute file paths
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} [opts.ref]
   * @param {boolean} [opts.confirm]
   */
  async upload(selector, paths, contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const resolution = await this._resolveActionTarget(selector, contextId, opts)
    if (!resolution.ok) {
      return { ...resolution, contextId: contextId || this._lastContextId }
    }
    const { target, resolved } = resolution
    const actionContext = resolved.contextId

    const info = await inspectElement(this.client, {
      contextId: actionContext,
      selector: resolved.selector,
      ref: resolved.ref,
      key: this._registryKey,
    })
    if (!info) {
      return {
        ok: false,
        error: `element not found: ${this._describeTarget(resolved)}`,
        contextId: actionContext,
      }
    }

    const gate = evaluateGate({ info, confirm: opts.confirm })
    if (!gate.allowed) {
      return {
        ok: false,
        error: gate.error,
        hint: gate.hint,
        blocked: true,
        action: gate.action,
        requiresConfirm: true,
        contextId: actionContext,
      }
    }

    try {
      const sharedId = await resolveSharedId(this.client, {
        contextId: actionContext,
        selector: resolved.selector,
        ref: resolved.ref,
        key: this._registryKey,
      })
      if (!sharedId) {
        return {
          ok: false,
          error: `could not resolve a file input at ${resolved.selector}`,
          contextId: target,
        }
      }
      await bidi.setFiles(this.client, {
        context: target,
        sharedId,
        files: paths,
      })
      this._lastContextId = target
      return {
        ok: true,
        contextId: target,
        selector: resolved.selector,
        uploaded: paths.length,
        files: paths,
      }
    } catch (e) {
      return { ok: false, error: e.message, contextId: target }
    }
  }

  /**
   * Wait for a condition.
   *
   * @param {string} [contextId]
   * @param {object} opts
   * @param {string} [opts.for]       selector | text | load | networkIdle
   * @param {string} [opts.selector]
   * @param {string} [opts.text]
   * @param {number} [opts.timeoutMs]
   */
  async waitFor(contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const target = await this._resolveContext(contextId)
    if (!target) return { ok: false, error: 'no browsing context available' }

    const kind = opts.for || 'load'
    let result
    try {
      if (kind === 'selector') {
        if (!opts.selector) {
          return { ok: false, error: 'wait_for "selector" needs a selector argument' }
        }
        result = await waiter.waitFor(this.client, {
          context: target,
          expression: waiter.selectorExpression(opts.selector),
          timeoutMs: opts.timeoutMs,
        })
      } else if (kind === 'text') {
        if (!opts.text) {
          return { ok: false, error: 'wait_for "text" needs a text argument' }
        }
        result = await waiter.waitFor(this.client, {
          context: target,
          expression: waiter.textExpression(opts.text),
          timeoutMs: opts.timeoutMs,
        })
      } else if (kind === 'networkIdle') {
        result = await waiter.waitForNetworkIdle(this.client, {
          context: target,
          log: this.networkLog,
          timeoutMs: opts.timeoutMs,
        })
      } else {
        result = await waiter.waitForLoad(this.client, {
          context: target,
          timeoutMs: opts.timeoutMs,
        })
      }
    } catch (e) {
      return { ok: false, error: e.message, contextId: target }
    }

    if (!result.matched) {
      return {
        ok: false,
        error: `timed out after ${result.elapsedMs}ms waiting for ${kind}`,
        hint: 'The condition did not become true in time. Inspect the page or check the network log.',
        contextId: target,
        elapsedMs: result.elapsedMs,
        timeoutMs: result.timeoutMs,
      }
    }
    return {
      ok: true,
      contextId: target,
      for: kind,
      elapsedMs: result.elapsedMs,
      timeoutMs: result.timeoutMs,
    }
  }

  /**
   * Close a tab.
   * @param {string} [contextId]
   */
  async closeTab(contextId) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const target = await this._resolveContext(contextId)
    if (!target) return { ok: false, error: 'no browsing context available' }
    try {
      await bidi.closeTab(this.client, target)
      if (this._lastContextId === target) this._lastContextId = null
      return { ok: true, contextId: target }
    } catch (e) {
      return { ok: false, error: e.message, contextId: target }
    }
  }

  /**
   * Capture a screenshot (base64 PNG).
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {boolean} [opts.fullPage]
   * @param {string} [opts.elementRef]
   */
  async screenshot(contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const target = await this._resolveContext(contextId)
    try {
      let elementSharedId = null
      if (opts.elementRef) {
        const resolution = await this._resolveActionTarget(null, target, {
          ref: opts.elementRef,
        })
        if (!resolution.ok) {
          return { ...resolution, contextId: target }
        }
        const resolved = resolution.resolved
        elementSharedId = await resolveSharedId(this.client, {
          contextId: resolved.contextId,
          selector: resolved.selector,
          ref: resolved.ref,
          key: this._registryKey,
        })
        if (!elementSharedId) {
          return {
            ok: false,
            error: `could not resolve an element for ref "${opts.elementRef}"`,
            contextId: target,
          }
        }
      }
      const data = await bidi.screenshot(this.client, target, {
        fullPage: opts.fullPage,
        elementSharedId,
      })
      const result = {
        ok: true,
        contextId: target,
        data,
        encoding: 'base64',
        mimeType: 'image/png',
        fullPage: !!opts.fullPage,
      }
      // Publish the PNG behind a loopback URL so a chat client can render it.
      // The image bytes stay out of the model's context — the model only ever
      // sees the short URL, which it can hand to the user.
      try {
        const published = await this.images.publish(data)
        result.imageUrl = published.url
        result.imageBytes = published.bytes
      } catch (e) {
        // The screenshot itself succeeded; only the URL is missing.
        result.imageUrlError = e.message
      }
      return result
    } catch (e) {
      return { ok: false, error: e.message, contextId: target }
    }
  }

  /**
   * Hand the current page over to the other browser surface.
   *
   * There are two surfaces in play: this plugin's Firefox and the host's
   * in-app browser (`mcp_browser`). The in-app browser is owned by the host —
   * the plugin cannot drive it — so a handoff *to* it only produces the data
   * the agent needs to perform the step. A handoff *to* Firefox is something
   * this plugin can do itself.
   *
   * Neither direction carries session state: logins, cookies and tabs stay
   * on the surface they came from, and the guidance says so.
   *
   * @param {'in-app'|'firefox'} to
   * @param {object} [opts]
   * @param {string} [opts.url]        target URL (required for 'firefox')
   * @param {string} [opts.contextId]
   * @param {'url'|'url+summary'|'none'} [opts.carry]
   */
  async handoff(to, opts = {}) {
    if (to !== 'firefox' && to !== 'in-app') {
      return { ok: false, error: `unknown handoff target: ${to}` }
    }
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const target = await this._resolveContext(opts.contextId)
    if (!target) return { ok: false, error: 'no browsing context available' }

    if (to === 'firefox') {
      if (!opts.url) {
        return {
          ok: false,
          error: 'a handoff to firefox needs a url',
          hint: 'read the current url from the other surface first',
        }
      }
      const before = await this._pageState(target)
      const nav = await this.navigate(opts.url, target)
      if (!nav.ok) return { ok: false, error: nav.error, hint: nav.hint }
      const effect = await this._effect(target, before)
      return {
        ok: true,
        from: 'in-app',
        to: 'firefox',
        url: effect.url,
        title: effect.title,
        contextId: target,
        effect,
      }
    }

    const state = await this._pageState(target)
    const out = {
      ok: true,
      from: 'firefox',
      to: 'in-app',
      url: opts.url || state.url,
      title: state.title,
      contextId: target,
      guidance:
        'Navigate the in-app browser to this URL and continue there. ' +
        'Firefox session state (logins, cookies, tabs) does not travel with it.',
    }
    if (opts.carry === 'url+summary') {
      const snap = await this.snapshot(target, { maxElements: 20 })
      if (snap.ok) {
        out.summary = snap.elements.map((e) => `${e.role}:${e.name}`).join(' | ')
      }
    }
    return out
  }

  /**
   * Evaluate JavaScript in the page.
   *
   * @param {string} expression
   * @param {string} [contextId]
   */
  async evaluate(expression, contextId) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const target = await this._resolveContext(contextId)
    try {
      const remote = await bidi.evaluate(this.client, expression, target)
      return { ok: true, contextId: target, value: bidi.unwrapRemoteValue(remote) }
    } catch (e) {
      return { ok: false, error: e.message, contextId: target }
    }
  }

  /**
   * Read the visible text of a page.
   *
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {number} [opts.maxChars]
   * @param {number} [opts.offset]
   * @param {string} [opts.selector]  read a subtree instead of the whole body
   */
  async text(contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const target = await this._resolveContext(contextId)
    const maxChars = opts.maxChars === undefined ? DEFAULT_MAX_TEXT_CHARS : opts.maxChars
    const offset = Math.max(0, opts.offset || 0)

    const expression = opts.selector
      ? `(document.querySelector(${JSON.stringify(opts.selector)})||{}).innerText||""`
      : 'document.body ? document.body.innerText : ""'

    try {
      const remote = await bidi.evaluate(this.client, expression, target)
      const full = String(bidi.unwrapRemoteValue(remote) ?? '')
      const slice = full.slice(offset, offset + maxChars)
      const nextOffset = offset + slice.length
      const truncated = nextOffset < full.length
      return {
        ok: true,
        contextId: target,
        value: slice,
        length: full.length,
        truncated,
        nextOffset: truncated ? nextOffset : undefined,
      }
    } catch (e) {
      return { ok: false, error: e.message, contextId: target }
    }
  }

  /**
   * Read buffered console logs.
   *
   * @param {number} [limit]
   * @param {object} [opts]
   * @param {string[]} [opts.levels]
   * @param {string} [opts.filter]
   */
  async consoleLogs(limit = 100, opts = {}) {
    let entries = this.logs
    if (opts.levels && opts.levels.length) {
      const allowed = new Set(opts.levels.map((l) => String(l).toLowerCase()))
      entries = entries.filter((e) => allowed.has(String(e.level).toLowerCase()))
    }
    if (opts.channel && opts.channel !== 'all') {
      // The three channels answer different questions: "what did the page
      // log", "what did the plugin do", "what did Firefox refuse".
      const wanted = String(opts.channel).toLowerCase()
      entries = entries.filter((e) => String(e.channel || 'console').toLowerCase() === wanted)
    }
    if (opts.filter) {
      const needle = String(opts.filter).toLowerCase()
      entries = entries.filter((e) => String(e.text).toLowerCase().includes(needle))
    }
    const slice = entries.slice(-limit)
    const channels = {}
    for (const entry of slice) {
      const name = entry.channel || 'console'
      channels[name] = (channels[name] || 0) + 1
    }
    return { ok: true, count: slice.length, logs: slice, channels }
  }

  /**
   * Query the captured network requests.
   *
   * @param {object} [opts]
   * @param {string[]} [opts.status]
   * @param {string} [opts.filter]
   * @param {string[]} [opts.types]
   * @param {number} [opts.afterSeq]
   * @param {number} [opts.limit]
   */
  async network(opts = {}) {
    const result = this.networkLog.query(opts)
    const payload = { ok: true, ...result }

    // Response bodies are a Firefox 144+ feature (BiDi milestone 17). When
    // they are not available, say so plainly rather than leaving the agent
    // to wonder why the data is missing.
    if (opts.body || opts.requestId) {
      const caps = await this._ensureCapabilities()
      if (!caps.features.networkBodies) {
        return {
          ...payload,
          bodyAvailable: false,
          reason: 'requires Firefox >= 144',
          hint: 'Response bodies need Firefox 144 or newer. Use browser_evaluate with fetch() as a fallback.',
        }
      }
      const requestId = opts.requestId || opts.body
      try {
        const data = await bidi.getResponseData(this.client, {
          request: requestId,
          dataType: opts.bodyType === 'base64' ? 'base64' : 'text',
        })
        payload.body = data && data.data !== undefined ? data.data : data
        payload.bodyAvailable = true
      } catch (e) {
        payload.bodyAvailable = false
        payload.bodyError = e.message
      }
    }
    return payload
  }

  /**
   * Current status snapshot.
   */
  status() {
    const version = this.browserVersion || this.binaryVersion()
    const probed = this.capabilities.result
    let capabilities
    if (probed) {
      capabilities = {
        probed: true,
        browserVersion: probed.browserVersion,
        features: probed.features,
        featureDetails: probed.featureDetails,
        knownRisks: probed.knownRisks,
      }
    } else {
      // The browser is not running, so nothing could be probed. The version
      // gates still say what this Firefox will support once it starts — that
      // is an expectation, and it is labelled as one.
      const expected = expectedFeatures(version, { privileged: !!this.opts.privileged })
      capabilities = {
        ...expected,
        knownRisks: [
          ...expected.knownRisks,
          'the browser is not running, so this matrix is a version-based expectation, not a live probe',
        ],
      }
    }
    return {
      ok: true,
      state: this.state,
      error: this.error,
      connected: !!(this.client && this.client.connected),
      port: this.port,
      pid: this.pid,
      sessionId: this.sessionId,
      bin: this.bin,
      browserVersion: version || '',
      headless: this.opts.headless !== false,
      profile: this.profileInfo,
      logCount: this.logs.length,
      networkCount: this.networkLog.entries.length,
      snapshotSeq: this._snapshotSeq,
      retained: !!this._retained,
      subscriptions: this.subscriptions,
      refMode: this._refMode,
      dialogPolicy: this.config_.dialogPolicy,
      preset: this.config_.preset,
      pendingDialogs: this.dialogs.open().length,
      uptimeMs: Date.now() - this._startedAt,
      capabilities,
    }
  }

  // -------------------------------------------------------------------------
  // JavaScript dialogs
  // -------------------------------------------------------------------------

  /**
   * Handle an open JavaScript dialog.
   *
   * @param {object} opts
   * @param {'accept'|'dismiss'|'acceptWithText'} opts.action
   * @param {string} [opts.text]
   * @param {string} [opts.contextId]
   */
  async handleDialog(opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const action = opts.action || 'dismiss'
    if (!['accept', 'dismiss', 'acceptWithText'].includes(action)) {
      return {
        ok: false,
        error: `unknown dialog action: ${action}`,
        hint: 'Use "accept", "dismiss" or "acceptWithText".',
      }
    }
    try {
      const result = await this.dialogs.handle(this.client, {
        action,
        text: opts.text,
        contextId: opts.contextId,
      })
      if (!result.ok) {
        return {
          ...result,
          hint:
            result.hint ||
            'Dialogs are closed automatically under the current policy. Set dialogPolicy to "manual" to keep them open.',
        }
      }
      return { ok: true, ...result }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  // -------------------------------------------------------------------------
  // Firefox containers (user contexts)
  // -------------------------------------------------------------------------

  /**
   * Manage Firefox containers.
   *
   * @param {object} opts
   * @param {'list'|'create'|'select'|'remove'} opts.action
   * @param {string} [opts.userContext]
   * @param {string} [opts.label]
   * @param {string} [opts.url]
   */
  async userContext(opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const caps = await this._ensureCapabilities()
    if (!caps.features.userContexts) {
      return capabilityError('userContexts', caps.browserVersion)
    }

    const action = opts.action || 'list'
    try {
      if (action === 'list') {
        const listed = await contexts.listUserContexts(this.client)
        if (!listed.ok) return { ok: false, error: listed.error }
        return { ok: true, userContexts: listed.userContexts, count: listed.userContexts.length }
      }

      if (action === 'create') {
        const created = await contexts.createUserContext(this.client, { label: opts.label })
        if (!created.ok) return { ok: false, error: created.error }
        return { ok: true, userContext: created.userContext, label: opts.label }
      }

      if (action === 'select') {
        if (!opts.userContext) {
          return { ok: false, error: 'select needs a userContext id' }
        }
        const opened = await contexts.openTabInUserContext(
          this.client,
          opts.userContext,
          opts.url ? normalizeUrl(opts.url) : undefined,
        )
        if (!opened.ok) return { ok: false, error: opened.error }
        this._lastContextId = opened.contextId
        this._contextTabs.set(opts.userContext, [
          ...(this._contextTabs.get(opts.userContext) || []),
          opened.contextId,
        ])
        return { ok: true, userContext: opts.userContext, contextId: opened.contextId }
      }

      if (action === 'remove') {
        if (!opts.userContext) {
          return { ok: false, error: 'remove needs a userContext id' }
        }
        // Firefox refuses to remove a container that still has open tabs, so
        // the tabs we opened in it are closed first. That is a loss, and the
        // closed tabs are reported.
        const closed = []
        const tabs = this._contextTabs.get(opts.userContext) || []
        for (const contextId of tabs) {
          try {
            await bidi.closeTab(this.client, contextId)
            closed.push(contextId)
            if (this._lastContextId === contextId) this._lastContextId = null
          } catch {
            // The tab may already be gone.
          }
        }
        this._contextTabs.delete(opts.userContext)
        const removed = await contexts.removeUserContext(this.client, opts.userContext)
        if (!removed.ok) {
          return {
            ok: false,
            error: removed.error,
            hint: 'Firefox refuses to remove a container that still has open tabs. Close them first.',
            closed,
          }
        }
        return { ok: true, userContext: opts.userContext, closed }
      }

      return { ok: false, error: `unknown container action: ${action}` }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  // -------------------------------------------------------------------------
  // Extensions
  // -------------------------------------------------------------------------

  /**
   * Manage WebExtensions.
   *
   * @param {object} opts
   * @param {'install'|'uninstall'|'list'} opts.action
   * @param {string} [opts.path]
   * @param {string} [opts.extensionId]
   * @param {boolean} [opts.permanent]
   */
  async extension(opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const caps = await this._ensureCapabilities()
    if (!caps.features.webExtension) {
      return capabilityError(
        'webExtension',
        caps.browserVersion,
        'Extension management needs Firefox 137 or newer.',
      )
    }

    const action = opts.action || 'list'
    try {
      if (action === 'install') {
        if (!opts.path) return { ok: false, error: 'install needs a path to an unpacked extension or an XPI' }
        // Installing an extension changes what the browser can do on every
        // page — it is not something to do silently.
        const gate = evaluateGate({
          action: ACTION_KINDS.EXTENSION_INSTALL,
          hint: `this installs an extension into the browser (${opts.path})`,
          confirm: opts.confirm,
        })
        if (!gate.allowed) {
          return {
            ok: false,
            error: gate.error,
            hint: gate.hint,
            blocked: true,
            action: gate.action,
            requiresConfirm: true,
          }
        }
        const result = await bidi.installExtension(this.client, {
          path: opts.path,
          permanent: !!opts.permanent,
        })
        return {
          ok: true,
          extensionId: result && result.extensionId,
          installed: true,
          permanent: !!opts.permanent,
          note: opts.permanent
            ? 'Requested a permanent install.'
            : 'Firefox 138+ installs extensions temporarily unless a permanent install is requested.',
        }
      }

      if (action === 'uninstall') {
        if (!opts.extensionId) return { ok: false, error: 'uninstall needs an extensionId' }
        await bidi.uninstallExtension(this.client, opts.extensionId)
        return { ok: true, extensionId: opts.extensionId, installed: false }
      }

      if (action === 'list') {
        // BiDi has no "list extensions" command, so read about:addons through
        // a privileged context when one is available.
        const listed = await this._listExtensions()
        if (!listed.ok) return listed
        return { ok: true, extensions: listed.extensions }
      }

      return { ok: false, error: `unknown extension action: ${action}` }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  /**
   * Read the installed extensions.
   *
   * BiDi has no "list extensions" command, so the list is read from
   * `about:addons` — which needs a browser started with
   * `--remote-enable-system-access`.
   *
   * The page exposes Firefox's own `AddonManager` API, which is far more
   * reliable than scraping the rendered list: the cards are built lazily and
   * are not in the DOM until the list is opened.
   *
   * @returns {Promise<{ok: boolean, extensions?: Array, error?: string}>}
   */
  async _listExtensions() {
    const caps = await this._ensureCapabilities()
    if (!caps.features.privilegedContext) {
      return capabilityError(
        'privilegedContext',
        caps.browserVersion,
        'Reading the extension list needs a privileged context. Start Firefox with FIREFOX_BROWSER_PRIVILEGED=1.',
      )
    }

    let contextId = null
    try {
      contextId = await bidi.createTab(this.client)
      await bidi.navigate(this.client, 'about:addons', contextId, 'complete')

      const result = await bidi.evaluate(
        this.client,
        `(async () => {
          if (!window.AddonManager) return { __ffbError: 'AddonManager is not available on this page' };
          const list = await window.AddonManager.getAllAddons();
          return list.map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            version: a.version,
            active: a.isActive === true,
            userDisabled: a.userDisabled === true,
          }));
        })()`,
        contextId,
        { awaitPromise: true },
      )
      const value = bidi.unwrapRemoteValue(result)
      if (value && typeof value === 'object' && value.__ffbError) {
        return { ok: false, error: value.__ffbError }
      }
      return { ok: true, extensions: Array.isArray(value) ? value : [] }
    } catch (e) {
      return { ok: false, error: e.message }
    } finally {
      // The tab was only a window onto the extension list — close it again.
      if (contextId) {
        try {
          await bidi.closeTab(this.client, contextId)
        } catch {
          // Best effort.
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cookies
  // -------------------------------------------------------------------------

  /**
   * Read or write cookies.
   *
   * @param {object} opts
   * @param {'get'|'set'} opts.action
   * @param {object} [opts.filter]
   * @param {object} [opts.cookie]
   */
  async cookie(opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const caps = await this._ensureCapabilities()
    if (!caps.features.storageCookies) {
      return capabilityError('storageCookies', caps.browserVersion)
    }
    try {
      if ((opts.action || 'get') === 'set') {
        if (!opts.cookie || !opts.cookie.name) {
          return { ok: false, error: 'set needs a cookie with at least a name' }
        }
        // Writing a cookie can change who the site thinks you are.
        const gate = evaluateGate({
          action: ACTION_KINDS.COOKIE_SET,
          hint: `this writes the cookie "${opts.cookie.name}" for ${opts.cookie.domain || 'the current site'}`,
          confirm: opts.confirm,
        })
        if (!gate.allowed) {
          return {
            ok: false,
            error: gate.error,
            hint: gate.hint,
            blocked: true,
            action: gate.action,
            requiresConfirm: true,
          }
        }
        const result = await bidi.setCookie(this.client, opts.cookie)
        const written = result && result.cookie
        return {
          ok: true,
          cookie: written ? bidi.unwrapRemoteValue(written) : opts.cookie,
        }
      }
      const filter = opts.filter || {}
      let result = await bidi.getCookies(this.client, filter)
      let cookies = result.cookies || []
      // A BiDi domain filter is an EXACT match: "example.com" does not match
      // ".example.com", which is how cookies are usually stored. Try the
      // cookie-jar form too rather than reporting "no cookies" for a domain
      // that plainly has some.
      if (!cookies.length && filter.domain && !String(filter.domain).startsWith('.')) {
        try {
          const retry = await bidi.getCookies(this.client, {
            ...filter,
            domain: '.' + String(filter.domain),
          })
          cookies = retry.cookies || []
        } catch {
          // Keep the empty result from the first attempt.
        }
      }
      // The cookie VALUE comes back as a serialized RemoteValue.
      const plain = cookies.map((entry) => ({
        ...entry,
        value: entry && entry.value !== undefined ? bidi.unwrapRemoteValue(entry.value) : entry.value,
      }))
      return { ok: true, cookies: plain, count: plain.length }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  // -------------------------------------------------------------------------
  // Request interception
  // -------------------------------------------------------------------------

  /**
   * Install or remove request interception.
   *
   * The URL matching happens in THIS PLUGIN, not in Firefox: Firefox pauses
   * every request while an intercept is active, and the plugin decides what
   * to do with each one. That keeps the feature working regardless of which
   * subset of Firefox's `urlPatterns` support is available.
   *
   * @param {object} opts
   * @param {'block'|'allow'|'clear'} opts.action
   * @param {string[]} [opts.patterns]  substrings; a request is blocked when
   *   its URL contains any of them
   */
  async intercept(opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const caps = await this._ensureCapabilities()
    if (!caps.features.networkIntercept) {
      return capabilityError('networkIntercept', caps.browserVersion)
    }
    const action = opts.action || 'block'
    try {
      if (action === 'clear' || action === 'allow') {
        const removed = await this._clearIntercepts()
        return { ok: true, active: 0, removed }
      }
      if (action !== 'block') {
        return { ok: false, error: `unknown intercept action: ${action}` }
      }
      const patterns = Array.isArray(opts.patterns) ? opts.patterns.filter(Boolean) : []
      if (!patterns.length) {
        return { ok: false, error: 'block needs at least one URL pattern to match' }
      }
      const added = await bidi.addIntercept(this.client, { phases: ['beforeRequestSent'] })
      // Firefox 140 returns the id as "intercept"; the spec calls it
      // "interceptId". Accept both rather than depending on the build.
      const interceptId = added && (added.interceptId || added.intercept)
      if (!interceptId) {
        return { ok: false, error: 'Firefox did not return an intercept id' }
      }
      this._interceptors.set(interceptId, { patterns, createdAt: Date.now() })
      this._log('plugin', 'info', `intercept installed (${patterns.length} pattern(s))`)
      return { ok: true, interceptId, active: this._interceptors.size, patterns }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  /**
   * Remove every intercept and release the requests that were paused.
   *
   * @returns {Promise<number>} how many intercepts were removed
   */
  async _clearIntercepts() {
    let removed = 0
    for (const interceptId of Array.from(this._interceptors.keys())) {
      try {
        await bidi.removeIntercept(this.client, interceptId)
        removed += 1
      } catch {
        // Best effort — the intercept may already be gone.
      }
      this._interceptors.delete(interceptId)
    }
    // Release anything still waiting: a paused request would hang the page.
    await this._releasePausedRequests()
    if (removed) this._log('plugin', 'info', `intercept removed (${removed})`)
    return removed
  }

  /**
   * Continue every request that is still waiting for a decision.
   */
  async _releasePausedRequests() {
    const pending = Array.from(this._pausedRequests.keys())
    for (const requestId of pending) {
      const timer = this._pausedRequests.get(requestId)
      if (timer) clearTimeout(timer)
      this._pausedRequests.delete(requestId)
      try {
        await bidi.continueRequest(this.client, requestId)
      } catch {
        // The request may have been failed or completed already.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Detectability
  // -------------------------------------------------------------------------

  /**
   * Report how detectable this session is.
   *
   * The honest answer matters more than a flattering one: Firefox sets
   * `navigator.webdriver` whenever the Remote Agent runs, and there is NO
   * pref or flag that turns it off. This tool exists so the agent knows the
   * real state instead of assuming it is invisible.
   *
   * @param {string} [contextId]
   */
  async detectability(contextId) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const target = await this._resolveContext(contextId)
    if (!target) return { ok: false, error: 'no browsing context available' }
    try {
      const result = await bidi.evaluate(
        this.client,
        `(() => {
          const ua = navigator.userAgent || '';
          const names = Object.getOwnPropertyNames(window).filter((k) => k.indexOf('__ffb_') === 0);
          return {
            webdriver: navigator.webdriver === true,
            userAgent: ua,
            headlessUA: /Headless/i.test(ua),
            domRefAttributes: document.querySelectorAll('[data-mavis-ff-ref]').length,
            registryKeys: names.length,
            enumerableRegistryKeys: Object.keys(window).filter((k) => k.indexOf('__ffb_') === 0).length,
            plugins: navigator.plugins ? navigator.plugins.length : 0,
            languages: (navigator.languages || []).join(','),
          };
        })()`,
        target,
      )
      const value = bidi.unwrapRemoteValue(result) || {}
      const notes = []
      if (value.webdriver) {
        notes.push(
          'navigator.webdriver is true. Firefox sets it whenever the Remote Agent runs, and no pref or flag disables it — this cannot be hidden.',
        )
      }
      if (value.headlessUA) {
        notes.push('The user agent contains "Headless". Set FIREFOX_BROWSER_HEADLESS=0 for a visible window.')
      }
      if (value.domRefAttributes > 0) {
        notes.push(
          `${value.domRefAttributes} element(s) still carry a data-mavis-ff-ref attribute — the plugin is in attribute fallback mode.`,
        )
      }
      if (value.registryKeys > 0) {
        notes.push(
          `${value.registryKeys} registry key(s) exist on window. They are non-enumerable, so a plain Object.keys(window) does not show them, but Object.getOwnPropertyNames(window) does.`,
        )
      }
      return {
        ok: true,
        contextId: target,
        ...value,
        automationDetectable: value.webdriver === true,
        refMode: this._refMode,
        notes,
      }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  // -------------------------------------------------------------------------
  // CAPTCHA solving
  // -------------------------------------------------------------------------

  /**
   * Solve a CAPTCHA challenge on the current page.
   *
   * The challenge is detected first, then handed to the solver that knows how
   * to answer it. A solve is only reported as successful when the SITE
   * issued a token — a click that "worked" is not a solved challenge.
   *
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} [opts.solver]     'auto' (default) or a challenge id
   * @param {string} [opts.sttUrl]      speech-to-text endpoint (audio challenges)
   * @param {string} [opts.visionUrl]   image-recognition endpoint (image grids)
   * @param {number} [opts.timeoutMs]
   */
  async captcha(contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const target = await this._resolveContext(contextId)
    if (!target) {
      return { ok: false, error: 'no browsing context available' }
    }
    try {
      const result = await solveCaptcha({
        client: this.client,
        topContextId: target,
        preloadInstalled: this._captchaPreloads,
        solver: opts.solver,
        sttUrl: opts.sttUrl,
        visionUrl: opts.visionUrl,
        timeoutMs: opts.timeoutMs,
      })
      return { ...result, contextId: target }
    } catch (e) {
      return { ok: false, error: e.message, contextId: target }
    }
  }

  /**
   * Report whether a challenge of the given kind is currently solved.
   *
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} opts.kind  the challenge id
   */
  async captchaStatus(contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const target = await this._resolveContext(contextId)
    if (!target) {
      return { ok: false, error: 'no browsing context available' }
    }
    try {
      const state = await checkSolved(this.client, target, opts.kind)
      return { ok: true, ...state, contextId: target }
    } catch (e) {
      return { ok: false, error: e.message, contextId: target }
    }
  }

  // -------------------------------------------------------------------------
  // Batching
  // -------------------------------------------------------------------------

  /**
   * Run a sequence of actions in one call.
   *
   * The point is fewer round trips: "click, type, snapshot" is three MCP
   * calls and three model turns when done one at a time, and one here.
   *
   * @param {Array<object>} steps
   * @param {object} [opts]
   */
  async batch(steps, opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    if (!Array.isArray(steps) || !steps.length) {
      return { ok: false, error: 'batch needs a non-empty steps array' }
    }
    const stopOnError = opts.stopOnError !== false
    const results = []
    let failedAt = undefined

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] || {}
      const action = step.action
      let outcome
      try {
        outcome = await this._runBatchStep(action, step, opts.contextId)
      } catch (e) {
        outcome = { ok: false, error: e.message }
      }
      const entry = { index: i, action, ok: !!outcome.ok }
      if (outcome.ok) {
        if (outcome.effect) entry.effect = outcome.effect
        if (outcome.snapshot) entry.snapshot = outcome.snapshot
        for (const key of ['selected', 'checked', 'typed', 'scrollY', 'moved', 'url', 'title']) {
          if (outcome[key] !== undefined) entry[key] = outcome[key]
        }
      } else {
        entry.error = outcome.error
        if (outcome.hint) entry.hint = outcome.hint
        if (outcome.blocked) entry.blocked = true
        if (outcome.requiresConfirm) entry.requiresConfirm = true
        if (outcome.action) entry.action = outcome.action
        if (outcome.requiresResnapshot) entry.requiresResnapshot = true
      }
      results.push(entry)
      if (!outcome.ok && stopOnError) {
        failedAt = i
        break
      }
    }

    return {
      ok: failedAt === undefined,
      steps: results,
      completed: results.filter((r) => r.ok).length,
      failedAt,
      note:
        failedAt === undefined
          ? undefined
          : `stopped at step ${failedAt}; the steps before it already ran and were not rolled back`,
    }
  }

  /**
   * Run one step of a batch.
   *
   * @param {string} action
   * @param {object} step
   * @param {string} [contextId]
   */
  async _runBatchStep(action, step, contextId) {
    const ctx = step.contextId || contextId
    switch (action) {
      case 'click':
        return this.click(step.selector, ctx, {
          ref: step.ref,
          confirm: step.confirm,
          button: step.button,
          clickCount: step.clickCount,
        })
      case 'type':
        return this.type(step.selector, step.text, ctx, {
          ref: step.ref,
          clear: step.clear,
          submit: step.submit,
          confirm: step.confirm,
        })
      case 'press_key':
        return this.pressKey(step.key, ctx)
      case 'select_option':
        return this.selectOption(step.selector, step.value, ctx, {
          ref: step.ref,
          byText: step.byText,
        })
      case 'check':
        return this.check(step.selector, step.checked, ctx, { ref: step.ref })
      case 'hover':
        return this.hover(step.selector, ctx, { ref: step.ref })
      case 'scroll':
        return this.scroll(ctx, {
          ref: step.ref,
          selector: step.selector,
          direction: step.direction,
          amount: step.amount,
        })
      case 'wait_for':
        return this.waitFor(ctx, {
          for: step.for,
          selector: step.selector,
          text: step.text,
          timeoutMs: step.timeoutMs,
        })
      case 'navigate':
        return this.navigate(step.url, ctx, step.wait || 'complete')
      case 'snapshot': {
        const snap = await this.snapshot(ctx, {
          maxElements: step.maxElements,
          offset: step.offset,
          roleFilter: step.roleFilter,
          nameContains: step.nameContains,
          includeText: step.includeText,
          frames: step.frames,
        })
        if (!snap.ok) return snap
        return {
          ok: true,
          snapshot: {
            elements: snap.elements,
            count: snap.count,
            total: snap.total,
            nextOffset: snap.nextOffset,
            frames: snap.frames,
            texts: snap.texts,
          },
        }
      }
      default:
        return {
          ok: false,
          error: `unknown batch action: ${action}`,
          hint: 'Supported: click, type, press_key, select_option, check, hover, scroll, wait_for, navigate, snapshot.',
        }
    }
  }

  // -------------------------------------------------------------------------
  // Scripts
  // -------------------------------------------------------------------------

  /**
   * Run a JavaScript file in the page.
   *
   * This is the browser-harness pattern: the agent writes a small helper for
   * something it keeps doing, and the helper stays on disk for the next task.
   *
   * @param {string} path
   * @param {object} [opts]
   */
  async runScript(path, opts = {}) {
    if (!(await this._ensureReady())) {
      return { ok: false, error: this.error || 'firefox provider is not running' }
    }
    const allowed = scriptRoots()
    const resolvedPath = resolve(String(path || ''))
    if (!allowed.some((root) => resolvedPath === root || resolvedPath.startsWith(root + '/'))) {
      return {
        ok: false,
        error: 'path_not_allowed',
        hint: `Scripts may only be read from: ${allowed.join(', ')}`,
      }
    }
    let source
    try {
      const { readFileSync } = await import('node:fs')
      source = readFileSync(resolvedPath, 'utf8')
    } catch (e) {
      return { ok: false, error: `cannot read script: ${e.message}` }
    }

    const target = await this._resolveContext(opts.contextId)
    if (!target) return { ok: false, error: 'no browsing context available' }
    try {
      // The file holds a function expression (a leading "return" is
      // tolerated). It is called with the arguments and its return value
      // comes back. `new Function` keeps the plugin from having to trust
      // the file with anything but a string.
      const result = await bidi.callFunction(
        this.client,
        `(body, argsJson) => {
          const source = String(body || '').trim().replace(/^return\\s+/, '');
          const args = argsJson ? JSON.parse(argsJson) : {};
          const factory = new Function('return (' + source + ')');
          const fn = factory();
          if (typeof fn !== 'function') {
            return { __ffbError: 'the script must evaluate to a function' };
          }
          return fn(args);
        }`,
        [
          { type: 'string', value: source },
          { type: 'string', value: JSON.stringify(opts.args || {}) },
        ],
        target,
        { awaitPromise: true },
      )
      const value = bidi.unwrapRemoteValue(result)
      if (value && typeof value === 'object' && value.__ffbError) {
        return { ok: false, error: value.__ffbError, path: resolvedPath }
      }
      return {
        ok: true,
        contextId: target,
        path: resolvedPath,
        result: safeSerializable(value),
      }
    } catch (e) {
      return { ok: false, error: e.message, path: resolvedPath }
    }
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Read or change the plugin's runtime configuration.
   *
   * @param {object} opts
   */
  async config(opts = {}) {
    const changed = {}
    if (opts.preset && !['slim', 'basic', 'developer', 'all'].includes(opts.preset)) {
      return { ok: false, error: `unknown preset: ${opts.preset}` }
    }
    if (opts.preset) {
      this.config_.preset = opts.preset
      changed.preset = opts.preset
    }
    if (opts.dialogPolicy) {
      if (!this.dialogs.setPolicy(opts.dialogPolicy)) {
        return { ok: false, error: `unknown dialog policy: ${opts.dialogPolicy}` }
      }
      this.config_.dialogPolicy = opts.dialogPolicy
      changed.dialogPolicy = opts.dialogPolicy
    }
    if (opts.maxSnapshotElements) {
      const value = Math.min(MAX_ELEMENTS_LIMIT, Math.max(1, opts.maxSnapshotElements))
      this.config_.maxSnapshotElements = value
      changed.maxSnapshotElements = value
    }
    return {
      ok: true,
      ...this.config_,
      changed,
      effectiveTools: presetTools(this.config_.preset),
      notes: presetNotes(this.config_.preset),
    }
  }

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  /**
   * Probe (and cache) what this Firefox supports.
   *
   * @returns {Promise<object>}
   */
  async _ensureCapabilities() {
    if (this.capabilities.result) return this.capabilities.result
    if (!this.client || !this.client.connected) {
      // Nothing to probe yet — the browser has not started.
      return {
        browserVersion: 'unknown',
        features: {},
        featureDetails: {},
        knownRisks: ['the browser is not running, so no capability could be probed'],
      }
    }
    try {
      const result = await this.capabilities.ensure(this.client, {
        browserVersion: this.browserVersion,
        subscriptions: this.subscriptions,
        privileged: !!this.opts.privileged,
      })
      const on = Object.entries(result.features)
        .filter(([, available]) => available)
        .map(([name]) => name)
      this._log(
        'plugin',
        'info',
        `capabilities probed: firefox ${result.browserVersion}; available: ${on.join(', ') || 'none'}`,
      )
      return result
    } catch (e) {
      // A failed probe must not break the tools that need it: report the
      // feature as unavailable with the reason attached.
      return {
        browserVersion: 'unknown',
        features: {},
        featureDetails: {},
        knownRisks: [`capability probe failed: ${e.message}`],
      }
    }
  }

  /**
   * Run the capability probe and report the result.
   *
   * `browser_status` calls this so the status can answer "what can this
   * Firefox do?" in one go.
   *
   * @returns {Promise<object|null>}
   */
  async probeCapabilities() {
    if (!this.client || !this.client.connected) return null
    await this._ensureCapabilities()
    return this.capabilities.result
  }
}

/**
 * The directories a page script may be read from.
 *
 * @returns {string[]}
 */
export function scriptRoots() {
  const roots = []
  const override = (process.env.FIREFOX_BROWSER_SCRIPT_ROOTS || '').trim()
  if (override) {
    for (const part of override.split(':')) {
      if (part.trim()) roots.push(resolve(part.trim()))
    }
  }
  const home = homedir()
  if (home) roots.push(join(home, '.mavis', 'ff-workspace'))
  return roots
}

/**
 * The tools a preset recommends.
 *
 * The plugin cannot reliably hide tools at runtime (the MCP tool list is sent
 * once, and the host may not support `tools/list_changed`), so a preset is
 * ADVICE: the SKILL tells the agent which tools a slim preset does not need.
 *
 * @param {string} preset
 * @returns {string[]}
 */
export function presetTools(preset) {
  const all = [
    'browser_start',
    'browser_stop',
    'browser_status',
    'browser_tabs',
    'browser_new_tab',
    'browser_navigate',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_press_key',
    'browser_select_option',
    'browser_check',
    'browser_hover',
    'browser_scroll',
    'browser_upload',
    'browser_wait_for',
    'browser_network',
    'browser_close_tab',
    'browser_handoff',
    'browser_text',
    'browser_evaluate',
    'browser_screenshot',
    'browser_logs',
    'browser_handle_dialog',
    'browser_context',
    'browser_extension',
    'browser_cookie',
    'browser_intercept',
    'browser_detectability',
    'browser_batch',
    'browser_run_script',
    'browser_config',
  ]
  if (preset === 'slim') {
    return all.filter(
      (name) =>
        ![
          'browser_press_key',
          'browser_check',
          'browser_hover',
          'browser_scroll',
          'browser_select_option',
          'browser_new_tab',
          'browser_close_tab',
          'browser_logs',
          'browser_upload',
        ].includes(name),
    )
  }
  if (preset === 'developer') {
    return all
  }
  return all
}

/**
 * A note about what a preset means.
 *
 * @param {string} preset
 * @returns {string[]}
 */
export function presetNotes(preset) {
  if (preset === 'slim') {
    return [
      'The slim preset does not remove any tool — it only marks the rarely needed ones as unnecessary.',
      'Prefer browser_batch over several single-action calls.',
    ]
  }
  return []
}

/**
 * Make a value safe to send over JSON-RPC.
 *
 * @param {*} value
 * @returns {*}
 */
function safeSerializable(value) {
  if (value === null || value === undefined) return value
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return value
  if (Array.isArray(value)) return value.map(safeSerializable)
  if (type === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      const safe = safeSerializable(v)
      if (safe !== undefined) out[k] = safe
    }
    return out
  }
  return String(value)
}

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
export function defaultCopyBase() {
  const explicit = (process.env.FIREFOX_BROWSER_PROFILE_COPY || '').trim()
  if (explicit) return explicit

  const pluginData = (process.env.PLUGIN_DATA || '').trim()
  if (pluginData) return pluginData

  // Derived from import.meta.url — works no matter how the plugin was started.
  try {
    const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
    return resolve(pluginRoot, '..', '.plugin-data', PLUGIN_NAME)
  } catch {
    // Fall through to the HOME-derived paths below.
  }

  const home = homedir()
  if (home) {
    return join(home, '.minimax', 'v2', 'plugin-data', 'agent-plugins', PLUGIN_NAME)
  }
  return join('.cache', PLUGIN_NAME, 'profile')
}

/**
 * Busy-wait synchronously.
 *
 * Only used on the shutdown path, where an await is not possible.
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* spin */
  }
}

/**
 * Pause asynchronously.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
