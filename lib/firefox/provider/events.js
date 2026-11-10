// lib/firefox/provider/events.js
// Split out of session.js to keep every module within a
// readable size.
//
// The methods below were moved verbatim; they stay prototype methods, so
// `this` is the provider instance exactly as before.

import * as bidi from '../../bidi/protocol.js'

import { redactText } from '../redact.js'
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
      // The page's own output is redacted BEFORE it enters the buffer. Pages
      // log tokens, session ids and API keys as a matter of course, and the
      // buffer is what `browser_logs` hands to the agent.
      const text = redactText(params?.text || '')
      const source = params?.source?.context || ''
      this.logs.push({ channel: 'console', level, text, source, at: Date.now() })
      // Keep the buffer bounded — the agent rarely needs more than the tail.
      if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500)
      return
    }

    if (method === 'browsingContext.userPromptOpened') {
      const dialog = this.dialogs.onPromptOpened(params || {})
      // The epoch moves BEFORE the auto-handler is queued: an action that
      // captured the epoch before it ran can now tell that a dialog opened
      // during that action, without waiting for one to arrive.
      this._dialogEpoch += 1
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
   * WHY THIS IS EVENT-DRIVEN
   *
   * The old implementation waited a fixed 250ms for an event that might
   * never arrive, on EVERY action — the single largest source of latency in
   * the plugin. But the `browsingContext.userPromptOpened` event arrives
   * BEFORE the action's own command returns, so by the time this runs the
   * epoch already tells us whether a dialog opened.
   *
   * So: if the epoch moved, the dialog is known and we only wait for the
   * auto-handler to close it. If it did not move, the event is either still
   * in flight or will never come, and we wait only a short grace window.
   *
   * @param {number} [before] the epoch captured before the action ran
   * @returns {Promise<object[]>} the dialogs that were handled
   */
  async _settleDialogs(before = this._dialogEpoch) {
    // The event may still be in flight when the action returns. Give it a
    // short window — but only that long, and only when nothing has arrived
    // yet.
    if (this._dialogEpoch === before) {
      const deadline = Date.now() + this._dialogSettleMs
      while (Date.now() < deadline) {
        if (this._dialogEpoch !== before) break
        await delay(2)
      }
    }

    // A dialog opened: wait for the auto-handler to close it, so the agent
    // gets the outcome and not just the fact.
    if (this._dialogChain) {
      try {
        await this._dialogChain
      } catch {
        /* best effort */
      }
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
    // The plugin's own lines are redacted too. They should not contain
    // secrets, but the cost is zero and it keeps ONE rule for every channel.
    this.logs.push({ channel, level, text: redactText(text), at: Date.now() })
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500)
  },
}
