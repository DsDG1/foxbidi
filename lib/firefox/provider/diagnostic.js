// lib/firefox/provider/diagnostic.js
// Diagnostics: logs, network, status and detectability.
//
// The methods below were moved here verbatim from the single FirefoxProvider
// class. They stay prototype methods, so `this` means exactly what it meant
// before: the provider instance, with its client, registry key, log buffer
// and dialog manager.

/**
 * The diagnostic methods.
 *
 * @type an object of methods
 */
import * as bidi from '../../bidi/protocol.js'
import { expectedFeatures } from '../capabilities.js'
import { ERROR_CODES, classifyError, fail } from '../errors.js'
import { redactText } from '../redact.js'

export const diagnosticMethods = {
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
  },
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
        const raw = data && data.data !== undefined ? data.data : data
        // A response body is page content, and page content carries tokens.
        // Only the unambiguous secret SHAPES are replaced, so the body stays
        // readable for its actual purpose; `revealBody` skips even that.
        payload.body = opts.revealBody === true ? raw : redactText(String(raw ?? ''))
        payload.bodyAvailable = true
      } catch (e) {
        payload.bodyAvailable = false
        payload.bodyError = e.message
      }
    }
    return payload
  },
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
      audit: this.audit ? this.audit.summary() : { enabled: false },
      capabilities,
    }
  },
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
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    if (!target) return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')
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
        notes.push(
          'The user agent contains "Headless". Set FIREFOX_BROWSER_HEADLESS=0 for a visible window.',
        )
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
      return fail(classifyError(e), e.message)
    }
  },
}
