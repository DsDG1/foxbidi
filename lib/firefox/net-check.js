// lib/firefox/net-check.js
// Deciding WHY a page will not load.
//
// WHY THIS MODULE EXISTS
//
// "The page did not load" has at least four different causes, and from the
// outside they look identical:
//
//   1. the resolver does not know the name          (dns_broken)
//   2. the machine has no route to the host         (host_egress_blocked)
//   3. the BROWSER PROCESS cannot open sockets      (firefox_egress_blocked)
//   4. the site is genuinely down or refusing us    (site_unreachable)
//
// An agent that cannot tell them apart retries blindly — and a blind retry
// loop against a browser that cannot reach the network never succeeds, it
// just burns the session. The fix is to take TWO independent samples:
//
//   - the HOST sample: can this machine resolve the name and open a socket?
//   - the BROWSER sample: can THIS Firefox load the page?
//
// The difference between the two samples IS the diagnosis. The host sample
// is taken here, in the plugin process, with the ordinary system resolver.
// The browser sample is taken inside Firefox by the provider.
//
// Everything in this module is pure logic plus two network probes, so it can
// be tested without a browser.

import dns from 'node:dns/promises'
import net from 'node:net'

/**
 * The diagnoses this module can reach.
 *
 * These strings are part of the plugin's contract with the agent: branch on
 * them, do not parse the English in `hint`.
 */
export const DIAGNOSIS = {
  OK: 'ok',
  DNS_BROKEN: 'dns_broken',
  HOST_EGRESS_BLOCKED: 'host_egress_blocked',
  FIREFOX_EGRESS_BLOCKED: 'firefox_egress_blocked',
  INCONCLUSIVE: 'inconclusive',
}

/** The target used when the caller does not name one. */
export const DEFAULT_TARGET = 'https://example.com'

/** How long the browser probe waits for the page to commit. */
export const DEFAULT_PROBE_TIMEOUT_MS = 8000

/** The ports the host probe tries, in order. */
const DEFAULT_PROBE_PORTS = [443, 80]

/**
 * Turn whatever the caller passed into a URL and a bare host.
 *
 * Agents pass a hostname, a URL, or nothing at all. A missing scheme is
 * assumed to be https, and a missing target falls back to a host that is
 * almost always reachable.
 *
 * @param {string} [target]
 * @returns {{url: string, host: string}}
 */
export function normalizeTarget(target) {
  const raw = String(target || '').trim()
  const withScheme = /^https?:\/\//i.test(raw)
    ? raw
    : `https://${raw || DEFAULT_TARGET.replace(/^https?:\/\//, '')}`
  let url = withScheme
  let host
  try {
    const parsed = new URL(withScheme)
    url = parsed.toString()
    host = parsed.hostname
  } catch {
    // A target that is not a URL at all still gets reported, so the agent
    // sees what was tried rather than an exception.
    host = raw
  }
  return { url, host }
}

/**
 * Try to open one TCP connection.
 *
 * @param {string} ip
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<{connected: boolean, ms: number, ip: string, port: number, error?: string}>}
 */
function tryConnect(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = new net.Socket()
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* best effort */
      }
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done({ connected: true, ms: Date.now() - started, ip, port }))
    socket.once('timeout', () =>
      done({ connected: false, ms: Date.now() - started, ip, port, error: 'timeout' }),
    )
    socket.once('error', (e) =>
      done({
        connected: false,
        ms: Date.now() - started,
        ip,
        port,
        error: (e && e.code) || e.message || 'connection failed',
      }),
    )
    socket.connect(port, ip)
  })
}

/**
 * Can THIS MACHINE resolve the name and reach the host?
 *
 * @param {string} host
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {number[]} [opts.ports]
 * @returns {Promise<{resolved: boolean, addresses: string[], error?: string, tcp: {connected: boolean, ms?: number, error?: string}}>}
 */
export async function probeHost(host, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS
  const ports = opts.ports || DEFAULT_PROBE_PORTS

  let addresses
  try {
    const results = await dns.lookup(host, { all: true })
    addresses = results.map((r) => r.address)
  } catch (e) {
    return {
      resolved: false,
      addresses: [],
      error: (e && (e.code || e.message)) || 'lookup failed',
      tcp: { connected: false, error: 'not attempted' },
    }
  }

  // IPv4 first: in the environments where this check earns its keep, IPv6
  // egress is often blackholed while IPv4 works.
  const ordered = [...addresses].sort((a, b) => Number(b.includes(':')) - Number(a.includes(':')))
  let last = { connected: false, error: 'no address' }
  for (const ip of ordered) {
    for (const port of ports) {
      const attempt = await tryConnect(ip, port, timeoutMs)
      if (attempt.connected) {
        return {
          resolved: true,
          addresses,
          tcp: { connected: true, ms: attempt.ms },
        }
      }
      last = attempt
    }
  }
  return {
    resolved: true,
    addresses,
    tcp: { connected: false, ms: last.ms, error: last.error },
  }
}

/**
 * Turn the two samples into one diagnosis.
 *
 * @param {object} samples
 * @param {object} [samples.host]   the host sample
 * @param {object} [samples.browser] the browser sample
 * @param {string} [samples.target]
 * @returns {{diagnosis: string, hint: string, suggestEgress: boolean}}
 */
export function diagnose(samples = {}) {
  const host = samples.host || null
  const browser = samples.browser || null
  const target = samples.target || ''

  // The browser reached it. Nothing else matters.
  if (browser && browser.loaded) {
    return {
      diagnosis: DIAGNOSIS.OK,
      hint: 'The browser loaded the target. The network is fine.',
      suggestEgress: false,
    }
  }

  // Firefox reports a failed lookup in its own error page. When the browser
  // says the name did not resolve, that is a resolver problem inside the
  // browser, whether or not this machine can resolve it.
  const browserError = browser && browser.error ? String(browser.error) : ''
  if (/dns|unknown_?host/i.test(browserError)) {
    const machineResolves = Boolean(host && host.resolved === true)
    return {
      diagnosis: DIAGNOSIS.DNS_BROKEN,
      hint: machineResolves
        ? `This machine resolves ${target}, but Firefox's own resolver does not (${browserError}) — ` +
          'the browser is using a resolver this network cannot reach. browser_egress resolves through ' +
          'DoH over the loopback proxy, which usually fixes it.'
        : `Neither this machine nor Firefox can resolve ${target} (${browserError}) — the resolver does ` +
          'not know the name, so this is a DNS problem and not a browser problem. Check the system ' +
          'resolver, or start browser_egress so the browser resolves through DoH instead.',
      suggestEgress: true,
    }
  }

  if (host && host.resolved === false) {
    return {
      diagnosis: DIAGNOSIS.DNS_BROKEN,
      hint:
        `This machine cannot resolve ${target} either — the resolver does not know the name, ` +
        'so this is a DNS problem and not a browser problem. Check the system resolver, or start ' +
        'browser_egress so the browser resolves through DoH instead.',
      suggestEgress: true,
    }
  }

  if (host && host.tcp && host.tcp.connected) {
    return {
      diagnosis: DIAGNOSIS.FIREFOX_EGRESS_BLOCKED,
      hint:
        `This machine reaches ${target}, but this Firefox does not — the browser process cannot ` +
        'open outbound sockets. browser_egress routes the browser through a proxy on the loopback ' +
        'interface, which is reachable.',
      suggestEgress: true,
    }
  }

  if (host && host.resolved === true) {
    return {
      diagnosis: DIAGNOSIS.HOST_EGRESS_BLOCKED,
      hint:
        `Neither this machine nor the browser can reach ${target} — the name resolves but nothing ` +
        'answers on the network. The site may be down, or this network cannot route to it.',
      suggestEgress: false,
    }
  }

  return {
    diagnosis: DIAGNOSIS.INCONCLUSIVE,
    hint:
      'Could not tell whether the network is reachable. Read browser_logs for the Firefox error, ' +
      'and try browser_net_check with a different target.',
    suggestEgress: false,
  }
}

/**
 * Tell whether a page is Firefox's own network error page.
 *
 * Firefox commits its error page in place of the requested one, and it keeps
 * the requested URL in `location.href` — so the visible URL says nothing
 * about the failure. Two other signals do: `document.documentURI` becomes
 * `about:neterror?...`, and the body carries the `neterror` class.
 *
 * @param {object} sample
 * @param {string} [sample.href]
 * @param {string} [sample.docUri]
 * @param {boolean} [sample.neterror]
 * @returns {boolean}
 */
export function isErrorPage(sample = {}) {
  const href = String(sample.href || '')
  const docUri = String(sample.docUri || '')
  if (href.startsWith('about:neterror') || docUri.startsWith('about:neterror')) return true
  return sample.neterror === true
}

/**
 * The error code Firefox put on its network error page.
 *
 * When a load fails, Firefox shows `about:neterror?e=NS_ERROR_UNKNOWN_HOST`
 * — the URL keeps the error, so the URL alone says what went wrong.
 *
 * @param {string} href
 * @returns {string}
 */
export function errorFromNetError(href) {
  const text = String(href || '')
  if (!text.startsWith('about:neterror')) return ''
  try {
    const parsed = new URL(text)
    return parsed.searchParams.get('e') || 'neterror'
  } catch {
    return 'neterror'
  }
}
