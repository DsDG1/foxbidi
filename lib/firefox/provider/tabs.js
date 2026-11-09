// lib/firefox/provider/tabs.js
// Tabs: listing, opening, navigating and closing browsing contexts.
//
// The methods below were moved here verbatim from the single FirefoxProvider
// class. They stay prototype methods, so `this` means exactly what it meant
// before: the provider instance, with its client, registry key, log buffer
// and dialog manager.

/**
 * The tabs methods.
 *
 * @type an object of methods
 */
import * as bidi from '../../bidi/protocol.js'
import { prepareContext } from '../captcha.js'
import { ERROR_CODES, classifyError, fail } from '../errors.js'
import { capabilityError } from '../capabilities.js'
import { STATE } from './constants.js'
import { normalizeUrl } from './helpers.js'

export const tabsMethods = {
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
  },
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
      return fail(classifyError(e), e.message)
    }
  },
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
  },
  /**
   * Open a new tab (and optionally navigate it).
   * @param {string} url
   */
  async newTab(url) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    try {
      const contextId = await bidi.createTab(this.client, url ? normalizeUrl(url) : undefined)
      this._lastContextId = contextId
      return { ok: true, contextId, url }
    } catch (e) {
      return fail(classifyError(e), e.message)
    }
  },
  /**
   * Navigate a tab.
   * @param {string} url
   * @param {string} [contextId]
   * @param {string} [wait]  'none' | 'load' | 'complete'
   */
  async navigate(url, contextId, wait = 'complete') {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    if (!target) return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')
    // The dialog epoch is captured before the navigation: if the page raises
    // a dialog on the way, the epoch moves and the result can say so without
    // waiting for an event that may never come. It is declared OUTSIDE the
    // try, because the catch block settles dialogs too.
    const dialogEpoch = this._dialogEpoch
    try {
      // Install the CAPTCHA preload patch BEFORE navigating: it has to run
      // before the page's own scripts, otherwise a closed shadow root that
      // is created during load is already unreachable by the time we look.
      await prepareContext(this.client, this._captchaPreloads, target)
      await bidi.navigate(this.client, normalizeUrl(url), target, wait)
      this._lastContextId = target
      const dialogs = await this._settleDialogs(dialogEpoch)
      const result = { ok: true, contextId: target, url: normalizeUrl(url) }
      if (dialogs.length) result.dialog = dialogs[0]
      return result
    } catch (e) {
      // A `beforeunload` dialog can block the navigation itself. The
      // auto-handler closes it, but the command may already have timed out.
      const dialogs = await this._settleDialogs(dialogEpoch)
      const result = fail(classifyError(e), e.message, { contextId: target })
      if (dialogs.length) {
        result.dialog = dialogs[0]
        result.hint = 'the page raised a beforeunload dialog while navigating'
      }
      return result
    }
  },
  /**
   * Close a tab.
   * @param {string} [contextId]
   */
  async closeTab(contextId) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    if (!target) return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')
    try {
      await bidi.closeTab(this.client, target)
      if (this._lastContextId === target) this._lastContextId = null
      return { ok: true, contextId: target }
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: target })
    }
  },

  /**
   * Go back in the tab's history.
   *
   * @param {string} [contextId]
   * @returns {Promise<object>}
   */
  async back(contextId) {
    return this._traverseHistory(-1, contextId)
  },

  /**
   * Go forward in the tab's history.
   *
   * @param {string} [contextId]
   * @returns {Promise<object>}
   */
  async forward(contextId) {
    return this._traverseHistory(1, contextId)
  },

  /**
   * Move through the tab's history.
   *
   * `browsingContext.traverseHistory` reports "History entry with delta N not
   * found" when there is nothing to go to — that is not a broken browser, it
   * is the end of the history, so it gets its own code and a hint.
   *
   * @param {number} delta   -1 for back, +1 for forward
   * @param {string} [contextId]
   * @returns {Promise<object>}
   */
  async _traverseHistory(delta, contextId) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    if (!target) return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')
    const caps = await this._ensureCapabilities()
    if (!caps.features.traverseHistory) {
      return capabilityError('traverseHistory', caps.browserVersion)
    }
    try {
      await bidi.traverseHistory(this.client, { context: target, delta })
      this._lastContextId = target
      return { ok: true, contextId: target, delta }
    } catch (e) {
      const atEnd = /History entry with delta/i.test(e.message)
      return fail(atEnd ? ERROR_CODES.INVALID_ARGUMENT : classifyError(e), e.message, {
        contextId: target,
        delta,
        hint: atEnd
          ? delta < 0
            ? 'There is no earlier page in this tab history.'
            : 'There is no later page in this tab history.'
          : undefined,
      })
    }
  },

  /**
   * Reload the tab.
   *
   * @param {string} [contextId]
   * @returns {Promise<object>}
   */
  async reload(contextId) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    if (!target) return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')
    const caps = await this._ensureCapabilities()
    if (!caps.features.contextReload) {
      return capabilityError('contextReload', caps.browserVersion)
    }
    try {
      await bidi.reload(this.client, target)
      this._lastContextId = target
      return { ok: true, contextId: target, reloaded: true }
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: target })
    }
  },
}
