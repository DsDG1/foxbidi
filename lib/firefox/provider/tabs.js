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
 * @satisfies {Record<string, Function> & ThisType<import("../provider.js").FirefoxProviderBase>}
 */
import * as bidi from '../../bidi/protocol.js'
import { prepareContext } from '#captcha-core'
import { ERROR_CODES, SESSION_STUCK_HINT, classifyError, fail, networkHint } from '../errors.js'
import { capabilityError } from '../capabilities.js'
import { STATE } from './constants.js'
import { resolveNavigation, sameTarget } from './helpers.js'

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
    return tree.map((n) => {
      if (this._tabUrls && n.contextId && n.url) {
        this._tabUrls.set(n.contextId, n.url)
      }
      return {
        contextId: n.contextId,
        url: n.url,
        type: 'tab',
        parent: null,
      }
    })
  },
  /**
   * Flatten every browsing context (top-level tabs and nested iframes).
   *
   * @returns {Promise<Array<{contextId: string, url: string, type: string, parent: string|null}>>}
   */
  async _allContexts() {
    if (!(await this._ensureReady())) {
      throw new Error(this.error || 'firefox provider is not running')
    }
    const tree = await bidi.getTree(this.client)
    const flat = []
    const walk = (nodes, parent, isTop) => {
      for (const n of nodes || []) {
        if (this._tabUrls && n.contextId && n.url) {
          this._tabUrls.set(n.contextId, n.url)
        }
        flat.push({
          contextId: n.contextId,
          url: n.url,
          type: isTop ? 'tab' : 'iframe',
          parent: parent || null,
        })
        if (Array.isArray(n.children) && n.children.length) {
          walk(n.children, n.contextId, false)
        }
      }
    }
    walk(tree, null, true)
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
    // A new tab that opens a URL is a navigation, so the policy applies.
    let target = url
    if (url) {
      const nav = resolveNavigation(url)
      if (!nav.allowed) {
        return fail(ERROR_CODES.NAVIGATION_BLOCKED, nav.error, {
          hint: nav.hint,
          blocked: true,
          reason: nav.reason,
        })
      }
      target = nav.url
    }
    try {
      const contextId = await bidi.createTab(this.client, target)
      this._lastContextId = contextId
      const effectiveUrl = target || 'about:blank'
      if (this._state) {
        this._state.recordUrl(contextId, effectiveUrl, { clearScan: true })
        this._state.lastUrl = target || ''
      } else {
        this._lastUrl = target || ''
        if (this._tabUrls) this._tabUrls.set(contextId, effectiveUrl)
        this._pageWarnings = []
        this._pageSignals = []
      }
      return { ok: true, contextId, url: target }
    } catch (e) {
      return fail(classifyError(e), e.message)
    }
  },
  /**
   * Navigate a tab.
   * @param {string} url
   * @param {string} [contextId]
   * @param {string} [wait]  'none' | 'load' | 'complete'
   * @param {Record<string, any>} [opts]
   */
  async navigate(url, contextId, wait = 'complete', opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    if (!target) return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')

    // The navigation policy is checked BEFORE anything is dispatched. This
    // browser carries the user's real login state, so where it is allowed
    // to go matters as much as what it is allowed to do.
    const nav = resolveNavigation(url)
    if (!nav.allowed) {
      return fail(ERROR_CODES.NAVIGATION_BLOCKED, nav.error || 'navigation blocked', {
        hint: nav.hint,
        blocked: true,
        reason: nav.reason,
        contextId: target,
      })
    }

    const dialogEpoch = this._dialogEpoch
    const before = await this._contextUrl(target)
    try {
      await prepareContext(this.client, this._captchaPreloads, target)
      await bidi.navigate(this.client, nav.url, target, wait)
      this._lastContextId = target
      if (this._state) {
        this._state.recordUrl(target, nav.url, { clearScan: true })
      } else {
        this._lastUrl = nav.url
        if (this._tabUrls) this._tabUrls.set(target, nav.url)
        this._pageWarnings = []
        this._pageSignals = []
      }
      const dialogs = await this._settleDialogs(dialogEpoch)

      const landedUrl =
        wait === 'none'
          ? await this._awaitLanding(target, before, 2000, nav.url)
          : await this._contextUrl(target)
      if (landedUrl) {
        if (this._state) {
          this._state.recordUrl(target, landedUrl)
        } else {
          this._lastUrl = landedUrl
          if (this._tabUrls) this._tabUrls.set(target, landedUrl)
        }
      }
      const navigated =
        landedUrl !== null && (landedUrl !== before || sameTarget(landedUrl, nav.url))
      /** @type {Record<string, any>} */
      const result = {
        ok: true,
        contextId: target,
        url: nav.url,
        landedUrl,
        navigated,
      }
      if (wait === 'none' && !navigated) {
        result.pending = true
        result.hint =
          'The navigation was dispatched but the tab has not moved yet — the page is still ' +
          'loading. Use browser_wait_for to confirm it landed.'
      }
      if (dialogs.length) result.dialog = dialogs[0]
      if (opts && opts.includeSnapshot === true && navigated && !result.pending) {
        return await this._withInlineSnapshot(result, target, { includeSnapshot: true })
      }
      return result
    } catch (e) {
      // A `beforeunload` dialog can block the navigation itself. The
      // auto-handler closes it, but the command may already have timed out.
      const dialogs = await this._settleDialogs(dialogEpoch)
      const code = await this._classifyCommandFailure(e)
      const result = fail(code, e.message, { contextId: target })
      if (dialogs.length) {
        result.dialog = dialogs[0]
        result.hint = 'the page raised a beforeunload dialog while navigating'
      } else if (code === ERROR_CODES.SESSION_STUCK) {
        // The most specific verdict comes first: the session is stuck, and
        // no amount of network checking will tell the agent that.
        result.hint = SESSION_STUCK_HINT
      } else if (code === ERROR_CODES.TIMEOUT) {
        // A timeout is ambiguous — the page may be slow, or the session may
        // be blocked. The network log tells them apart.
        result.hint = await this._navigationTimeoutHint(nav.url)
      } else {
        // Any other network-shaped failure gets a hint that says what to do
        // next: the error text names the symptom, not the cause.
        const hint = networkHint(e.message)
        if (hint) result.hint = hint
      }
      return result
    }
  },

  /**
   * The URL a browsing context is on right now.
   *
   * @param {string} contextId
   * @returns {Promise<string|null>}
   */
  async _contextUrl(contextId) {
    try {
      const contexts = await this._allContexts()
      const found = contexts.find((t) => t.contextId === contextId)
      return found ? found.url : null
    } catch {
      return null
    }
  },

  /**
   * Wait, briefly, for a navigation to land.
   *
   * A navigation dispatched with `wait:'none'` is still in flight when the
   * command returns. The agent needs to know whether it landed, so the tab
   * is polled for a short budget — long enough for a local page, short
   * enough not to punish a slow one.
   *
   * @param {string} contextId
   * @param {string|null} before the URL the tab was on
   * @param {number} [budgetMs]
   * @param {string|null} [requested]  the URL that was asked for
   * @returns {Promise<string|null>} the URL the tab is on
   */
  async _awaitLanding(contextId, before, budgetMs = 2000, requested = null) {
    const deadline = Date.now() + budgetMs
    let url = await this._contextUrl(contextId)
    while (Date.now() < deadline) {
      // The tab moved, or it is standing on the page that was asked for —
      // a reload does not change the URL, but it is still a landing.
      if (url !== null && (url !== before || (requested && sameTarget(url, requested)))) {
        return url
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
      url = await this._contextUrl(contextId)
    }
    return url
  },

  /**
   * What to tell the agent when a navigation timed out.
   *
   * Two very different things look the same from the outside: a page that
   * takes forever, and a navigation that is stuck behind a request which
   * never completes. The network log tells them apart — and the AGE of the
   * pending request says which one it is.
   *
   * WHY THE AGE MATTERS
   *
   * The old wording was "the page is still loading … it will finish when
   * the load does". That is a promise the plugin cannot keep: a request that
   * has been pending for longer than the command timeout is not going to
   * clear by itself, and an agent that believes the promise waits forever.
   *
   * So the hint now states the fact (how long the request has been pending)
   * and names the repair that works — resetting the session, which keeps
   * Firefox, the tabs and the login state.
   *
   * @param {string} url the URL that was being navigated to
   * @returns {Promise<string>}
   */
  async _navigationTimeoutHint(url) {
    const pending = this._pendingRequestFor(url)
    if (pending) {
      const ageMs = Math.max(0, Date.now() - (pending.at || Date.now()))
      const seconds = Math.round(ageMs / 1000)
      const budgetMs = (this.client && this.client.timeoutMs) || 30000
      if (ageMs >= budgetMs) {
        return (
          `The navigation is stuck behind a request to ${pending.url} that has been pending ` +
          `for ${seconds}s — longer than the ${Math.round(budgetMs / 1000)}s command timeout, so ` +
          'waiting will not clear it. Reset the session with browser_restart {scope:"session"} ' +
          '(Firefox, the tabs and the login state are kept), then navigate again.'
        )
      }
      return (
        `The page is still loading — a request to ${pending.url} has not completed yet ` +
        `(pending for ${seconds}s). Wait for it with browser_wait_for.`
      )
    }
    return (
      'The navigation did not complete. A previous command may still be holding the BiDi ' +
      'session: run browser_restart {scope:"session"} to reset the session (this keeps ' +
      'Firefox and the tabs), or browser_restart to restart the browser.'
    )
  },

  /**
   * A still-running request for this URL, if there is one.
   *
   * @param {string} url
   * @returns {Record<string, any>|null} the network-log entry (it carries the URL and the
   *   moment the request started, which is what the hint needs)
   */
  _pendingRequestFor(url) {
    let target
    try {
      target = new URL(url)
    } catch {
      return null
    }
    const entries = (this.networkLog && this.networkLog.entries) || []
    // The OLDEST pending request wins: it is the one the navigation is
    // actually queued behind.
    let oldest = null
    for (const entry of entries) {
      if (!entry || entry.bucket !== 'pending') continue
      try {
        const parsed = new URL(entry.url)
        if (parsed.origin !== target.origin) continue
      } catch {
        /* not a URL — skip it */
        continue
      }
      if (!oldest || (entry.at || 0) < (oldest.at || 0)) oldest = entry
    }
    return oldest
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
      if (this._tabUrls) this._tabUrls.delete(target)
      if (this._snapshotByContext) this._snapshotByContext.delete(target)
      if (this._lastContextId === target) {
        this._lastContextId = null
        this._lastUrl = ''
      }
      return { ok: true, contextId: target }
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: target })
    }
  },

  /**
   * Go back in the tab's history.
   *
   * @param {string} [contextId]
   * @returns {Promise<Record<string, any>>}
   */
  async back(contextId) {
    return this._traverseHistory(-1, contextId)
  },

  /**
   * Go forward in the tab's history.
   *
   * @param {string} [contextId]
   * @returns {Promise<Record<string, any>>}
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
   * @returns {Promise<Record<string, any>>}
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
      this._pageWarnings = []
      this._pageSignals = []
      const landedUrl = await this._contextUrl(target)
      if (landedUrl) {
        this._lastUrl = landedUrl
        if (this._tabUrls) this._tabUrls.set(target, landedUrl)
      }
      return { ok: true, contextId: target, delta, ...(landedUrl ? { url: landedUrl } : {}) }
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
   * @returns {Promise<Record<string, any>>}
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
      this._pageWarnings = []
      this._pageSignals = []
      const landedUrl = await this._contextUrl(target)
      if (landedUrl) {
        this._lastUrl = landedUrl
        if (this._tabUrls) this._tabUrls.set(target, landedUrl)
      }
      return {
        ok: true,
        contextId: target,
        reloaded: true,
        ...(landedUrl ? { url: landedUrl } : {}),
      }
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: target })
    }
  },
}
