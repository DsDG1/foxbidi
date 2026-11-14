// lib/firefox/provider/net.js
// The provider side of the network check.
//
// WHY THIS LIVES HERE AND NOT IN net-check.js
//
// net-check.js holds the pure logic (target normalisation, the host sample,
// the diagnosis table) so it can be tested without a browser. Taking the
// BROWSER sample needs a live BiDi session, so it lives with the other
// provider methods.
//
// THE BROWSER SAMPLE
//
// A probe tab is opened, navigated with `wait: "none"`, and polled until the
// page commits — or until Firefox replaces it with its own error page.
// Firefox shows a failed load as `about:neterror?e=<code>`, so the URL
// carries the reason and no error text has to be scraped.
//
// The probe tab is closed in a `finally`, on every path. A check that leaves
// a tab behind is worse than no check: the agent would not know which tab it
// is looking at afterwards.

import * as bidi from '../../bidi/protocol.js'
import { ERROR_CODES, fail } from '../errors.js'
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_TARGET,
  diagnose,
  errorFromNetError,
  isErrorPage,
  normalizeTarget,
  probeHost,
} from '../net-check.js'
/**
 * How long to wait between polls of the probe tab.
 */
const POLL_INTERVAL_MS = 200

/**
 * The network methods.
 *
 * @satisfies {Record<string, Function> & ThisType<import("../provider.js").FirefoxProviderBase>}
 */
export const netMethods = {
  /**
   * Find out whether the browser can reach a target, and if not, WHY.
   *
   * @param {object} [opts]
   * @param {string} [opts.target]   a hostname or URL; defaults to the current page
   * @param {number} [opts.timeoutMs]
   */
  async netCheck(opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running', {
        hint: 'Start Firefox with browser_start, then run browser_net_check again.',
      })
    }

    const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || DEFAULT_PROBE_TIMEOUT_MS)
    const target = await this._netCheckTarget(opts.target)
    const { url, host, port } = normalizeTarget(target)

    // The host sample and the browser sample run together: the host sample
    // is a couple of round trips and the browser sample is a page load, so
    // running them in parallel halves the wall clock of the check.
    const [hostSample, browserSample] = await Promise.all([
      probeHost(host, { timeoutMs, port }).catch((e) => ({
        resolved: false,
        addresses: [],
        error: (e && e.message) || 'host probe failed',
        tcp: { connected: false, error: 'probe failed' },
        ports: [],
      })),
      this._probeBrowser(url, timeoutMs),
    ])

    const verdict = diagnose({ host: hostSample, browser: browserSample, target: host })

    const result = {
      ok: true,
      diagnosis: verdict.diagnosis,
      target: host,
      url,
      host: hostSample,
      browser: browserSample,
      hint: verdict.hint,
      suggestEgress: verdict.suggestEgress,
    }

    // Remember the verdict so `browser_status` can report it without the
    // agent having to run the check twice.
    this._lastNetCheck = {
      diagnosis: verdict.diagnosis,
      target: host,
      at: Date.now(),
      suggestEgress: verdict.suggestEgress,
    }
    this._log(
      'plugin',
      'info',
      `net check ${host}: ${verdict.diagnosis} (browser ${browserSample.loaded ? 'loaded' : 'failed'})`,
    )
    return result
  },
  /**
   * The target the check should use when the caller did not name one.
   *
   * The current page is the interesting default: it is the page that just
   * failed to load.
   *
   * @param {string} [target]
   * @returns {Promise<string>}
   */
  async _netCheckTarget(target) {
    if (target) return String(target)
    if (this._lastUrl) return this._lastUrl
    try {
      const tabs = await this.listTabs()
      const first = tabs.find((t) => t.url && t.url !== 'about:blank')
      if (first && first.url) return first.url
    } catch {
      /* the tab list is a convenience, not a requirement */
    }
    return DEFAULT_TARGET
  },
  /**
   * Load a URL in a throwaway tab and report whether it committed.
   *
   * @param {string} url
   * @param {number} timeoutMs
   * @returns {Promise<{loaded: boolean, ms: number, href?: string, error?: string}>}
   */
  async _probeBrowser(url, timeoutMs) {
    const started = Date.now()
    let contextId = null
    try {
      contextId = await bidi.createTab(this.client)
      await bidi.navigate(this.client, url, contextId, 'none')
      const deadline = Date.now() + timeoutMs
      let lastHref = ''
      while (Date.now() < deadline) {
        let href = ''
        let docUri = ''
        let ready = ''
        let neterror = false
        try {
          const result = await bidi.evaluate(
            this.client,
            '(() => ({ href: location.href, docUri: document.documentURI, ready: document.readyState, neterror: !!(document.body && document.body.classList && document.body.classList.contains("neterror")) }))()',
            contextId,
          )
          const value = bidi.unwrapRemoteValue(result) || {}
          href = String(value.href || '')
          docUri = String(value.docUri || '')
          ready = String(value.ready || '')
          neterror = value.neterror === true
        } catch {
          // A context that cannot be read yet is not a verdict — keep polling.
        }
        lastHref = href
        // Firefox commits its own error page when a load fails. It keeps the
        // requested URL in `location.href`, so the URL alone does not say the
        // load failed — `document.documentURI` and the body's `neterror`
        // class do.
        if (isErrorPage({ href, docUri, neterror })) {
          return {
            loaded: false,
            ms: Date.now() - started,
            href: href || docUri,
            error: errorFromNetError(docUri) || errorFromNetError(href) || 'neterror',
          }
        }
        if (href && href !== 'about:blank' && ready && ready !== 'loading') {
          return { loaded: true, ms: Date.now() - started, href }
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      }
      return {
        loaded: false,
        ms: Date.now() - started,
        href: lastHref,
        error: 'timeout',
      }
    } catch (e) {
      return {
        loaded: false,
        ms: Date.now() - started,
        error: (e && e.message) || 'probe failed',
      }
    } finally {
      // The probe tab is a window onto the network, nothing more. It goes
      // away on every path, including the failure paths.
      if (contextId) {
        try {
          await bidi.closeTab(this.client, contextId)
        } catch {
          /* best effort */
        }
      }
    }
  },
  /**
   * Start, stop or inspect the local egress proxy.
   *
   * The proxy is the way out for a browser that cannot open outbound
   * sockets: it listens on the loopback interface, which is reachable, and
   * it does the outside world's connecting itself.
   *
   * Starting it writes the proxy preferences into the profile copy. The
   * browser has to be restarted for them to take effect — the port is
   * chosen when the proxy starts, and Firefox reads the preferences at
   * startup.
   *
   * @param {string} action 'start' | 'stop' | 'status'
   */
  async egress(action) {
    const act = String(action || 'status').toLowerCase()

    if (act === 'status') {
      return { ok: true, ...this.egressProxy.status() }
    }

    if (act === 'stop') {
      const stopped = await this.egressProxy.stop()
      // Take the proxy preferences back out, so a browser that restarts
      // later does not try to use a port nobody is listening on.
      const cleared = await this.applyPrefs({
        'network.proxy.type': 0,
        'network.proxy.http': '',
        'network.proxy.http_port': 0,
        'network.proxy.ssl': '',
        'network.proxy.ssl_port': 0,
      })
      return {
        ok: true,
        running: false,
        stopped: stopped.stopped,
        prefs: cleared.ok ? cleared.prefs : {},
        hint: 'The proxy is stopped. Run browser_restart to let the browser drop the proxy settings.',
      }
    }

    if (act === 'start') {
      const started = await this.egressProxy.start()
      if (!started.ok) {
        return fail(ERROR_CODES.EGRESS_START_FAILED, started.error || 'could not start the proxy')
      }
      const port = started.port
      const applied = await this.applyPrefs({
        'network.proxy.type': 1,
        'network.proxy.http': '127.0.0.1',
        'network.proxy.http_port': port,
        'network.proxy.ssl': '127.0.0.1',
        'network.proxy.ssl_port': port,
        'network.proxy.no_proxies_on': '',
        // The proxy is the resolver now: Firefox's own DNS-over-HTTPS
        // would have to go through the proxy and would need a bootstrap of
        // its own, which is exactly what is missing in these environments.
        'network.trr.mode': 0,
      })
      return {
        ok: true,
        running: true,
        port,
        prefs: applied.ok ? applied.prefs : {},
        failed: applied.failed || [],
        hint:
          `The proxy is listening on 127.0.0.1:${port}. Run browser_restart so the browser picks ` +
          'the settings up, then navigate again.',
      }
    }

    return fail(ERROR_CODES.INVALID_ARGUMENT, `unknown egress action: ${act}`)
  },
  /**
   * Record a proxy connection in the audit trail.
   *
   * The host and the byte count are facts about the traffic; the request
   * and the response are not recorded at all.
   *
   * @param {Record<string, any>} event
   */
  _recordEgress(event) {
    const kind = event && event.kind
    if (kind === 'refused') {
      this.recordAudit('browser_egress', {
        ok: false,
        code: 'egress_target_refused',
        url: `http://${event.host}:${event.port}/`,
      })
      return
    }
    this.recordAudit('browser_egress', {
      ok: true,
      url: event.url || `http://${event.host}:${event.port}/`,
      egress: { host: event.host, port: event.port, kind },
    })
  },
}
