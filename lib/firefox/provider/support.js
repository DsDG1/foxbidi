// lib/firefox/provider/support.js
// Shared helpers used by more than one group.
//
// The methods below were moved here verbatim from the single FirefoxProvider
// class. They stay prototype methods, so `this` means exactly what it meant
// before: the provider instance, with its client, registry key, log buffer
// and dialog manager.

/**
 * The support methods.
 *
 * @satisfies {Record<string, Function> & ThisType<import("../provider.js").FirefoxProviderBase>}
 */
import * as bidi from '../../bidi/protocol.js'
import { capabilityError } from '../capabilities.js'
import { ERROR_CODES, classifyError, fail } from '../errors.js'
import { resolveNavigation, defaultCopyBase } from './helpers.js'

export const supportMethods = {
  /**
   * Record a tool call in the action audit trail.
   *
   * The audit lives beside the profile copy, under the plugin's own data
   * directory. A failure to write it is swallowed: an audit that breaks
   * the browser is worse than no audit, and the failure shows up in
   * `browser_status`.
   *
   * @param {string} tool
   * @param {Record<string, any>} result
   */
  recordAudit(tool, result) {
    try {
      this.audit.record(this.opts.copyBaseDir || defaultCopyBase(), {
        tool,
        result,
      })
    } catch {
      /* the audit must never break a tool call */
    }
  },
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
  },
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
  },
  /**
   * Read the installed extensions.
   *
   * BiDi has no "list extensions" command, so the list is read from
   * `about:addons` — which needs a browser started with
   * `--remote-allow-system-access`.
   *
   * The page exposes Firefox's own extension APIs, which are far more
   * reliable than scraping the rendered list: the cards are built lazily and
   * are not in the DOM until the list is opened.
   *
   * Two generations are in play. Up to Firefox 152 that is the
   * `AddonManager` class with its static `getAllAddons()`; Firefox 153
   * dropped the static API from the page and moved the list into the parent
   * process, where a privileged page reaches it through
   * `ChromeUtils.importESModule('…/ExtensionParent.sys.mjs')`. Both are
   * tried, and both produce the same record shape.
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
      // The plugin's own privileged navigation. It goes through the policy
      // with `exempt` so the exemption is EXPLICIT: if a future change
      // routed every navigation through the policy, this one would still
      // be allowed, and the reason would still be written down.
      const nav = resolveNavigation('about:addons', { exempt: true })
      await bidi.navigate(this.client, nav.url, contextId, 'complete')

      const result = await bidi.evaluate(
        this.client,
        `(async () => {
          // TWO GENERATIONS OF THE SAME API LIVE HERE.
          //
          // Up to Firefox 152 the about:addons page exposes the AddonManager
          // class with its static list method. Firefox 153 dropped that
          // static API from the page, and the extension list now lives in the
          // parent process — ExtensionParent.GlobalManager — which a
          // privileged page can still reach through ChromeUtils.
          //
          // Both paths return the SAME shape, so the caller does not have to
          // know which Firefox it is talking to.
          const shape = (id, name, type, version, active, userDisabled) => ({
            id: id,
            name: name,
            type: type,
            version: version,
            active: active === true,
            userDisabled: userDisabled === true,
          });

          if (window.AddonManager && typeof window.AddonManager.getAllAddons === 'function') {
            const list = await window.AddonManager.getAllAddons();
            return list.map((a) => shape(
              a.id,
              a.name,
              a.type,
              a.version,
              a.isActive === true,
              a.userDisabled === true,
            ));
          }

          if (!window.ChromeUtils || typeof window.ChromeUtils.importESModule !== 'function') {
            return { __ffbError: 'no extension API is available on this page' };
          }

          const { ExtensionParent } = ChromeUtils.importESModule(
            'resource://gre/modules/ExtensionParent.sys.mjs',
          );
          const policy = ExtensionParent.WebExtensionPolicy;
          const list = [];
          for (const ext of ExtensionParent.GlobalManager.extensionMap.values()) {
            // The policy service is what knows whether the extension is
            // enabled. A built-in extension has no entry there, and an
            // extension that is not in the policy is an active one.
            let active = true;
            try {
              const p = policy && policy.getByID ? policy.getByID(ext.id) : null;
              if (p) active = p.active === true;
            } catch {}
            const rawName = ext.manifest && ext.manifest.name;
            list.push(shape(
              ext.id,
              typeof rawName === 'string' ? rawName : ext.id,
              ext.type,
              (ext.manifest && ext.manifest.version) || '',
              active,
              !active,
            ));
          }
          return list;
        })()`,
        contextId,
        { awaitPromise: true },
      )
      const value = bidi.unwrapRemoteValue(result)
      if (value && typeof value === 'object' && value.__ffbError) {
        return fail(ERROR_CODES.PATH_NOT_ALLOWED, value.__ffbError)
      }
      return { ok: true, extensions: Array.isArray(value) ? value : [] }
    } catch (e) {
      return fail(classifyError(e), e.message)
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
  },
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
  },
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
  },
  /**
   * Probe (and cache) what this Firefox supports.
   *
   * @returns {Promise<Record<string, any>>}
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
  },
  /**
   * Run the capability probe and report the result.
   *
   * `browser_status` calls this so the status can answer "what can this
   * Firefox do?" in one go.
   *
   * @returns {Promise<Record<string, any>|null>}
   */
  async probeCapabilities() {
    if (!this.client || !this.client.connected) return null
    await this._ensureCapabilities()
    return this.capabilities.result
  },
}
