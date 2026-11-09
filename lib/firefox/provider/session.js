// lib/firefox/provider/session.js
// Session lifecycle: the Firefox process, the BiDi session, and the event stream.
//
// The methods below were moved here verbatim from the single FirefoxProvider
// class. They stay prototype methods, so `this` means exactly what it meant
// before: the provider instance, with its client, registry key, log buffer
// and dialog manager.

/**
 * The session methods.
 *
 * @type an object of methods
 */
import * as bidi from '../../bidi/protocol.js'
import { ERROR_CODES, fail } from '../errors.js'
import {
  detectFirefoxBin,
  findFreePort,
  readBinaryVersion,
  spawnFirefox,
  waitForBiDi,
} from '../launcher.js'
import { attachNetworkLog } from '../network.js'
import {
  detectUserProfile,
  isProfileLocked,
  ensureProfileCopy,
  applyProfilePrefs,
  prefsFromEnvironment,
  profileCopyPath,
  profileLabel,
  profileLockMarkers,
} from '../profile.js'
import { createRegistryKey } from '../registry.js'
import { join, resolve } from 'node:path'
import { STATE } from './constants.js'
import { BidiClient } from '../../bidi/client.js'
import { defaultCopyBase } from './helpers.js'
export const sessionMethods = {
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
  },
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
  },
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
      this.error = 'firefox not found — install Firefox or set FIREFOX_BROWSER_BIN to its path'
      return fail(ERROR_CODES.NOT_RUNNING, this.error)
    }

    // 2) Locate + copy the user profile.
    const srcProfile = this.sourceProfile || detectUserProfile()
    if (!srcProfile) {
      this.state = STATE.FAILED
      this.error = 'no Firefox profile found — set FIREFOX_BROWSER_PROFILE to a profile path'
      return fail(ERROR_CODES.NOT_RUNNING, this.error)
    }
    const copyDir =
      this.copyDir || profileCopyPath(this.opts.copyBaseDir || defaultCopyBase(), srcProfile)

    const copy = ensureProfileCopy({ srcDir: srcProfile, destDir: copyDir })
    if (!copy.ok) {
      this.state = STATE.FAILED
      this.error = `profile copy failed: ${copy.error}`
      return fail(ERROR_CODES.NOT_RUNNING, this.error)
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
    return fail(ERROR_CODES.NOT_RUNNING, this.error)
  },
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
    if (!retained || !retained.port)
      return fail(ERROR_CODES.INVALID_ARGUMENT, 'no retained instance')

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
      return fail(ERROR_CODES.INVALID_ARGUMENT, `retained instance is unreachable: ${e.message}`)
    }

    let session
    try {
      session = await bidi.sessionNew(client)
    } catch (e) {
      try {
        client.close()
      } catch {}
      return fail(
        ERROR_CODES.INVALID_ARGUMENT,
        `retained instance refused a new session: ${e.message}`,
      )
    }
    if (session.reused) {
      try {
        client.close()
      } catch {}
      return fail(ERROR_CODES.INVALID_ARGUMENT, 'retained instance still owns its session')
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
  },
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
  },
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
  },
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
  },
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
  },
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
  },
}
