// lib/firefox/provider/events.js
// Split out of session.js to keep every module within a
// readable size.
//
// The methods below were moved verbatim; they stay prototype methods, so
// `this` is the provider instance exactly as before.

import * as bidi from '../../bidi/protocol.js'

import {
  detectFirefoxBin,
  findFreePort,
  readBinaryVersion,
  spawnFirefox,
  waitForBiDi,
} from '../launcher.js'

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

import { resolve } from 'node:path'

import { delay } from './helpers.js'
/**
 * The events methods.
 *
 * @type an object of methods
 */
export const eventsMethods = {
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
      this._log(
        'plugin',
        'info',
        `dialog opened (${dialog.type}): ${dialog.message || '(no message)'}`,
      )
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
  },
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
  },
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
  },
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
  },
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
  },
}
