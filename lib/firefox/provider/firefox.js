// lib/firefox/provider/firefox.js
// Firefox-only capabilities: containers, extensions, cookies, intercepts, dialogs.
//
// The methods below were moved here verbatim from the single FirefoxProvider
// class. They stay prototype methods, so `this` means exactly what it meant
// before: the provider instance, with its client, registry key, log buffer
// and dialog manager.

/**
 * The firefox methods.
 *
 * @satisfies {Record<string, Function> & ThisType<import("../provider.js").FirefoxProviderBase>}
 */
import * as bidi from '../../bidi/protocol.js'
import { capabilityError } from '../capabilities.js'
import { evaluateGate, ACTION_KINDS } from '../confirm.js'
import * as contexts from '../contexts.js'
import { ERROR_CODES, classifyError, fail } from '../errors.js'
import { redactCookies } from '../redact.js'
import { resolveNavigation } from './helpers.js'

export const firefoxMethods = {
  /**
   * Handle an open JavaScript dialog.
   *
   * @param {object} [opts]
   * @param {'accept'|'dismiss'|'acceptWithText'} [opts.action]
   * @param {string} [opts.text]
   * @param {string} [opts.contextId]
   */
  async handleDialog(opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const action = opts.action || 'dismiss'
    if (!['accept', 'dismiss', 'acceptWithText'].includes(action)) {
      return fail(ERROR_CODES.INVALID_ARGUMENT, `unknown dialog action: ${action}`, {
        hint: 'Use "accept", "dismiss" or "acceptWithText".',
      })
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
      return fail(classifyError(e), e.message)
    }
  },
  /**
   * Manage Firefox containers.
   *
   * @param {object} [opts]
   * @param {'list'|'create'|'select'|'remove'} [opts.action]
   * @param {string} [opts.userContext]
   * @param {string} [opts.label]
   * @param {string} [opts.url]
   */
  async userContext(opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const caps = await this._ensureCapabilities()
    if (!caps.features.userContexts) {
      return capabilityError('userContexts', caps.browserVersion)
    }

    const action = opts.action || 'list'
    try {
      if (action === 'list') {
        const listed = await contexts.listUserContexts(this.client)
        if (!listed.ok) return fail(ERROR_CODES.INVALID_ARGUMENT, listed.error)
        return { ok: true, userContexts: listed.userContexts, count: listed.userContexts.length }
      }

      if (action === 'create') {
        const created = await contexts.createUserContext(this.client, { label: opts.label })
        if (!created.ok) return fail(ERROR_CODES.INVALID_ARGUMENT, created.error)
        return { ok: true, userContext: created.userContext, label: opts.label }
      }

      if (action === 'select') {
        if (!opts.userContext) {
          return fail(ERROR_CODES.INVALID_ARGUMENT, 'select needs a userContext id')
        }
        // Opening a tab with a URL is a navigation, so the policy applies.
        let openUrl
        if (opts.url) {
          const nav = resolveNavigation(opts.url)
          if (!nav.allowed) {
            return fail(ERROR_CODES.NAVIGATION_BLOCKED, nav.error, {
              hint: nav.hint,
              blocked: true,
              reason: nav.reason,
            })
          }
          openUrl = nav.url
        }
        const opened = await contexts.openTabInUserContext(this.client, opts.userContext, openUrl)
        if (!opened.ok) return fail(ERROR_CODES.INVALID_ARGUMENT, opened.error)
        this._lastContextId = opened.contextId
        this._contextTabs.set(opts.userContext, [
          ...(this._contextTabs.get(opts.userContext) || []),
          opened.contextId,
        ])
        return { ok: true, userContext: opts.userContext, contextId: opened.contextId }
      }

      if (action === 'remove') {
        if (!opts.userContext) {
          return fail(ERROR_CODES.INVALID_ARGUMENT, 'remove needs a userContext id')
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
          return fail(ERROR_CODES.INVALID_ARGUMENT, removed.error, {
            hint: 'Firefox refuses to remove a container that still has open tabs. Close them first.',
            closed,
          })
        }
        return { ok: true, userContext: opts.userContext, closed }
      }

      return fail(ERROR_CODES.INVALID_ARGUMENT, `unknown container action: ${action}`)
    } catch (e) {
      return fail(classifyError(e), e.message)
    }
  },
  /**
   * Manage WebExtensions.
   *
   * @param {object} [opts]
   * @param {'install'|'uninstall'|'list'} [opts.action]
   * @param {string} [opts.path]
   * @param {string} [opts.extensionId]
   * @param {boolean} [opts.permanent]
   * @param {boolean} [opts.confirm]
   */
  async extension(opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
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
        if (!opts.path)
          return fail(
            ERROR_CODES.INVALID_ARGUMENT,
            'install needs a path to an unpacked extension or an XPI',
          )
        // Installing an extension changes what the browser can do on every
        // page — it is not something to do silently.
        //
        // The injection gate comes first: on a page carrying a hidden
        // instruction, installing an extension is exactly the payload the
        // page wanted, and `confirm: true` must not release it.
        const injection = await this._injectionGate('extension_install')
        if (!injection.allowed) {
          return fail(ERROR_CODES.INJECTION_BLOCKED, injection.error, {
            hint: injection.hint,
            blocked: true,
            action: injection.action,
            warnings: this._pageWarnings || [],
          })
        }
        const gate = evaluateGate({
          action: ACTION_KINDS.EXTENSION_INSTALL,
          hint: `this installs an extension into the browser (${opts.path})`,
          confirm: opts.confirm,
        })
        if (!gate.allowed) {
          return fail(ERROR_CODES.CONFIRM_REQUIRED, gate.error, {
            hint: gate.hint,
            blocked: true,
            action: gate.action,
            requiresConfirm: true,
          })
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
        if (!opts.extensionId)
          return fail(ERROR_CODES.INVALID_ARGUMENT, 'uninstall needs an extensionId')
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

      return fail(ERROR_CODES.INVALID_ARGUMENT, `unknown extension action: ${action}`)
    } catch (e) {
      return fail(classifyError(e), e.message)
    }
  },
  /**
   * Read or write cookies.
   *
   * @param {object} [opts]
   * @param {'get'|'set'} [opts.action]
   * @param {Record<string, any>} [opts.filter]
   * @param {Record<string, any>} [opts.cookie]
   * @param {boolean} [opts.confirm]
   * @param {boolean} [opts.revealValues]
   */
  async cookie(opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const caps = await this._ensureCapabilities()
    if (!caps.features.storageCookies) {
      return capabilityError('storageCookies', caps.browserVersion)
    }
    try {
      if ((opts.action || 'get') === 'set') {
        if (!opts.cookie || !opts.cookie.name) {
          return fail(ERROR_CODES.INVALID_ARGUMENT, 'set needs a cookie with at least a name')
        }
        // Writing a cookie can change who the site thinks you are — and a
        // cookie written for an attacker's domain is data egress.
        //
        // The injection gate comes first: `confirm: true` must not
        // release it.
        const injection = await this._injectionGate('cookie_set')
        if (!injection.allowed) {
          return fail(ERROR_CODES.INJECTION_BLOCKED, injection.error, {
            hint: injection.hint,
            blocked: true,
            action: injection.action,
            warnings: this._pageWarnings || [],
          })
        }
        const gate = evaluateGate({
          action: ACTION_KINDS.COOKIE_SET,
          hint: `this writes the cookie "${opts.cookie.name}" for ${opts.cookie.domain || 'the current site'}`,
          confirm: opts.confirm,
        })
        if (!gate.allowed) {
          return fail(ERROR_CODES.CONFIRM_REQUIRED, gate.error, {
            hint: gate.hint,
            blocked: true,
            action: gate.action,
            requiresConfirm: true,
          })
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
        value:
          entry && entry.value !== undefined ? bidi.unwrapRemoteValue(entry.value) : entry.value,
      }))
      // The cookie's identity is what an agent needs; its value is the
      // credential. HttpOnly session cookies are readable here, which is
      // exactly why the default is to hand back a placeholder instead of the
      // token. `revealValues` is the explicit escape hatch.
      const visible = opts.revealValues === true ? plain : redactCookies(plain)
      return {
        ok: true,
        cookies: visible,
        count: visible.length,
        valuesRedacted: opts.revealValues !== true,
      }
    } catch (e) {
      return fail(classifyError(e), e.message)
    }
  },
  /**
   * Install or remove request interception.
   *
   * The URL matching happens in THIS PLUGIN, not in Firefox: Firefox pauses
   * every request while an intercept is active, and the plugin decides what
   * to do with each one. That keeps the feature working regardless of which
   * subset of Firefox's `urlPatterns` support is available.
   *
   * @param {object} [opts]
   * @param {'block'|'allow'|'clear'} [opts.action]
   * @param {string[]} [opts.patterns]  substrings; a request is blocked when
   *   its URL contains any of them
   */
  async intercept(opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
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
        return fail(ERROR_CODES.INVALID_ARGUMENT, `unknown intercept action: ${action}`)
      }
      const patterns = Array.isArray(opts.patterns) ? opts.patterns.filter(Boolean) : []
      if (!patterns.length) {
        return fail(ERROR_CODES.INVALID_ARGUMENT, 'block needs at least one URL pattern to match')
      }
      const added = await bidi.addIntercept(this.client, { phases: ['beforeRequestSent'] })
      // Firefox 140 returns the id as "intercept"; the spec calls it
      // "interceptId". Accept both rather than depending on the build.
      const interceptId = added && (added.interceptId || added.intercept)
      if (!interceptId) {
        return fail(ERROR_CODES.INVALID_ARGUMENT, 'Firefox did not return an intercept id')
      }
      this._interceptors.set(interceptId, { patterns, createdAt: Date.now() })
      this._log('plugin', 'info', `intercept installed (${patterns.length} pattern(s))`)
      return { ok: true, interceptId, active: this._interceptors.size, patterns }
    } catch (e) {
      return fail(classifyError(e), e.message)
    }
  },
}
