// lib/firefox/dialogs.js
// JavaScript dialogs: alert(), confirm(), prompt() and beforeunload.
//
// WHY THIS MODULE EXISTS
//
// A JavaScript dialog BLOCKS the page. While one is open, Firefox will not
// evaluate scripts and will not accept input actions — every subsequent
// `script.evaluate` and `input.performActions` queues up behind it and the
// agent sees a timeout with no explanation.
//
// The previous version of this plugin had no handling at all, and the code
// even carried a comment saying the event name `browsingContext.userPrompt`
// was rejected by Firefox. That was the wrong NAME, not a missing feature:
// the BiDi events are `browsingContext.userPromptOpened` and
// `browsingContext.userPromptClosed`, and the command that closes one is
// `browsingContext.handleUserPrompt`. Both exist in Firefox 118/119 and
// later.
//
// WHAT THIS MODULE GUARANTEES
//
// A dialog never leaves the agent hanging. The default policy dismisses the
// dialog as soon as it opens, and the fact that a dialog appeared is
// reported back to the agent in the `effect` block of the next action — so
// the agent learns that something popped up instead of just seeing the page
// change unexpectedly.

import { ERROR_CODES, fail } from './errors.js'
/** Dialog handling policies. */
export const DIALOG_POLICY = {
  /** Close every dialog automatically without accepting it. The default. */
  AUTO_DISMISS: 'autoDismiss',
  /** Accept every dialog automatically. */
  AUTO_ACCEPT: 'autoAccept',
  /** Record the dialog but leave it open — the page stays blocked. */
  MANUAL: 'manual',
}

/** The prompt types Firefox reports. */
export const DIALOG_TYPES = ['alert', 'confirm', 'prompt', 'beforeunload']

/**
 * Tracks open dialogs and the ones that were handled.
 */
export class DialogManager {
  /**
   * @param {object} [opts]
   * @param {string} [opts.policy]  one of DIALOG_POLICY
   */
  constructor(opts = {}) {
    this.policy = opts.policy || DIALOG_POLICY.AUTO_DISMISS
    /** @type {Map<string, object>} context id → open dialog */
    this.pending = new Map()
    /** @type {object[]} dialogs handled since the last drain */
    this.recent = []
    /** @type {object[]} every dialog seen, for diagnostics */
    this.history = []
    /**
     * The contexts whose dialog the policy wanted to close, but could not.
     *
     * A dialog that is still open after the automatic handling blocks the
     * page — so it has to be told apart from a dialog that the policy is
     * about to close on its own.
     *
     * @type {Set<string>}
     */
    this.stuck = new Set()
  }

  /**
   * A dialog opened.
   *
   * @param {object} params  the BiDi `browsingContext.userPromptOpened` payload
   * @returns {object} the recorded dialog
   */
  onPromptOpened(params = {}) {
    const context = params.context || ''
    const dialog = {
      type: DIALOG_TYPES.includes(params.type) ? params.type : 'alert',
      message: params.message || '',
      defaultValue: params.defaultValue === undefined ? '' : params.defaultValue,
      context,
      openedAt: Date.now(),
    }
    this.pending.set(context, dialog)
    this.stuck.delete(context)
    this.history.push({ ...dialog, state: 'opened' })
    if (this.history.length > 50) this.history.shift()
    return dialog
  }

  /**
   * A dialog was closed (by us, by the page, or by the user).
   *
   * @param {object} params  the BiDi `browsingContext.userPromptClosed` payload
   * @returns {object|null} the dialog that was open
   */
  onPromptClosed(params = {}) {
    const context = params.context || ''
    const dialog = this.pending.get(context) || null
    this.pending.delete(context)
    this.stuck.delete(context)
    if (dialog) {
      this.history.push({ ...dialog, state: 'closed' })
      if (this.history.length > 50) this.history.shift()
    }
    return dialog
  }

  /**
   * The action to take for a dialog under the current policy.
   *
   * @param {object} dialog
   * @returns {'accept'|'dismiss'|null}
   */
  actionFor(dialog) {
    if (!dialog) return null
    if (this.policy === DIALOG_POLICY.MANUAL) return null
    if (this.policy === DIALOG_POLICY.AUTO_ACCEPT) return 'accept'
    return 'dismiss'
  }

  /**
   * Close every open dialog according to the policy.
   *
   * The `handleUserPrompt` command is sent WITHOUT going through the client's
   * command queue: a `beforeunload` dialog blocks the very navigation command
   * that triggered it, and a queued reply would never be sent — the agent
   * would hang until the command timeout.
   *
   * @param {import('../bidi/client.js').BidiClient} client
   * @returns {Promise<object[]>} the dialogs that were handled
   */
  async autoHandle(client) {
    if (!this.pending.size) return []
    const handled = []
    for (const [context, dialog] of Array.from(this.pending.entries())) {
      const action = this.actionFor(dialog)
      if (!action) continue
      const ok = await this.close(client, context, action)
      if (ok) {
        this.pending.delete(context)
        this.stuck.delete(context)
        const record = { ...dialog, handled: action }
        this.recent.push(record)
        this.history.push({ ...record, state: 'handled' })
        handled.push(record)
      } else {
        // The policy wanted this dialog closed and it stayed open — the
        // page is blocked by it, and the agent has to be told.
        this.stuck.add(context)
      }
    }
    return handled
  }

  /**
   * Send `browsingContext.handleUserPrompt` for one dialog.
   *
   * @param {import('../bidi/client.js').BidiClient} client
   * @param {string} context
   * @param {'accept'|'dismiss'|'acceptAndSetPromptText'} action
   * @param {string} [promptText]
   * @returns {Promise<boolean>}
   */
  async close(client, context, action, promptText) {
    if (!context) return false
    const params = { context, action }
    if (action === 'acceptAndSetPromptText') {
      params.promptText = promptText === undefined ? '' : String(promptText)
    }
    try {
      const send = typeof client.sendUnqueued === 'function' ? client.sendUnqueued : client.send
      await send.call(client, 'browsingContext.handleUserPrompt', params)
      return true
    } catch {
      // The dialog may have been closed already (race with the page).
      return false
    }
  }

  /**
   * Handle a dialog on demand.
   *
   * @param {import('../bidi/client.js').BidiClient} client
   * @param {object} opts
   * @param {'accept'|'dismiss'|'acceptWithText'} opts.action
   * @param {string} [opts.text]
   * @param {string} [opts.contextId]  which dialog to act on
   * @returns {Promise<{ok: boolean, handled?: string, message?: string, type?: string,
   *                    error?: string}>}
   */
  async handle(client, opts) {
    const action = opts.action
    let target
    if (opts.contextId) {
      target = this.pending.get(opts.contextId) || null
      if (!target) {
        return fail(ERROR_CODES.INVALID_ARGUMENT, 'no_pending_dialog', {
          hint: 'No dialog is open in that context.',
        })
      }
    } else {
      // Most recently opened dialog wins.
      const entries = Array.from(this.pending.entries())
      if (!entries.length) {
        return fail(ERROR_CODES.INVALID_ARGUMENT, 'no_pending_dialog', {
          hint: 'No dialog is currently open.',
        })
      }
      target = entries[entries.length - 1][1]
    }

    const bidiAction =
      action === 'acceptWithText'
        ? 'acceptAndSetPromptText'
        : action === 'accept'
          ? 'accept'
          : 'dismiss'

    const ok = await this.close(client, target.context, bidiAction, opts.text)
    if (!ok) {
      this.pending.delete(target.context)
      this.stuck.delete(target.context)
      return fail(ERROR_CODES.INVALID_ARGUMENT, 'no_pending_dialog', {
        hint: 'The dialog was already closed.',
      })
    }
    this.pending.delete(target.context)
    this.stuck.delete(target.context)
    const record = { ...target, handled: bidiAction }
    this.recent.push(record)
    this.history.push({ ...record, state: 'handled' })
    return {
      ok: true,
      handled: action,
      message: target.message,
      type: target.type,
      contextId: target.context,
    }
  }

  /**
   * Take the dialogs handled since the last drain.
   *
   * Actions call this so the agent learns that a dialog appeared.
   *
   * @returns {object[]}
   */
  drain() {
    const list = this.recent
    this.recent = []
    return list
  }

  /**
   * The dialogs still open.
   *
   * @returns {object[]}
   */
  open() {
    return Array.from(this.pending.values())
  }

  /**
   * The open dialogs that actually block the page.
   *
   * A dialog under an automatic policy is closed a moment after it opens, so
   * it blocks the page only for that moment — an action may proceed. A
   * dialog under the `manual` policy stays open until somebody handles it,
   * and so does one the automatic handling failed to close. Those two are
   * what the agent has to hear about.
   *
   * @returns {object[]}
   */
  blocking() {
    return Array.from(this.pending.values()).filter(
      (dialog) => !this.actionFor(dialog) || this.stuck.has(dialog.context),
    )
  }

  /**
   * Change the policy.
   *
   * @param {string} policy
   * @returns {boolean} whether the policy is known
   */
  setPolicy(policy) {
    if (!Object.values(DIALOG_POLICY).includes(policy)) return false
    this.policy = policy
    return true
  }
}
