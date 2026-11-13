// lib/firefox/provider/process.js
// Split out of session.js to keep every module within a readable size.
//
// Process teardown: stopping the browser and reclaiming the process.

import * as bidi from '../../bidi/protocol.js'

import { STATE } from './constants.js'
import { delay, sleepSync } from './helpers.js'
/**
 * The process methods.
 *
 * @type an object of methods
 */
export const processMethods = {
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
    // The egress proxy is normally stopped with the browser. A RESTART is
    // the exception: the proxy's port is baked into the preferences the
    // new browser reads at startup, so it has to stay up.
    if (!opts.keepEgress) {
      try {
        await this.egressProxy.stop()
      } catch {
        /* best effort */
      }
    }
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
        await bidi.sessionEnd(this.client, 2000)
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
    // The recorded context belonged to the session that just ended. Keeping
    // it means the next call without an explicit contextId aims at a tab
    // that no longer exists — and reports `no_context` instead of doing
    // the obvious thing, which is to use the tab that IS there.
    this._lastContextId = null
    this._contextsStale = true
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
  },
  /**
   * Terminate a Firefox process we started.
   *
   * The process was spawned detached (its own process group), so it must be
   * signalled as a group — otherwise the content-process children survive.
   *
   * This is the SYNCHRONOUS variant: it busy-waits for the process to go
   * away, which blocks the event loop. It is only for the `exit` handler,
   * where there is no time left to await anything. Every other caller uses
   * `_killProcessAndWait`, which waits without blocking.
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
  },
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
  },
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
  },
}
