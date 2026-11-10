// test/net-check.test.js
// Unit tests for the network check (lib/firefox/net-check.js).
//
// The host sample is real (it resolves and connects), so the tests point it
// at names that are certain to exist — "localhost" and the loopback — and
// at names that certainly do not.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  DIAGNOSIS,
  DEFAULT_TARGET,
  diagnose,
  errorFromNetError,
  isErrorPage,
  normalizeTarget,
  probeHost,
} from '../lib/firefox/net-check.js'

describe('normalizeTarget', () => {
  test('a bare hostname becomes an https URL', () => {
    const result = normalizeTarget('example.com')
    assert.equal(result.host, 'example.com')
    assert.match(result.url, /^https:\/\/example\.com/)
  })

  test('a URL keeps its scheme and its host', () => {
    const result = normalizeTarget('http://example.com/path?q=1')
    assert.equal(result.host, 'example.com')
    assert.match(result.url, /^http:\/\/example\.com\/path\?q=1/)
  })

  test('no target falls back to the default', () => {
    const result = normalizeTarget('')
    assert.equal(result.host, new URL(DEFAULT_TARGET).hostname)
  })

  test('a target that is not a URL still reports a host', () => {
    const result = normalizeTarget('not a url at all')
    assert.ok(result.host)
    assert.ok(result.url)
  })
})

describe('probeHost', () => {
  test('localhost resolves and connects', async () => {
    const result = await probeHost('localhost', { timeoutMs: 2000 })
    assert.equal(result.resolved, true)
    assert.ok(result.addresses.length > 0)
  })

  test('a name nobody knows does not resolve', async () => {
    const result = await probeHost('this-name-does-not-exist.invalid', { timeoutMs: 2000 })
    assert.equal(result.resolved, false)
    assert.ok(result.error)
    assert.equal(result.tcp.connected, false)
  })
})

describe('diagnose', () => {
  const hostOk = { resolved: true, addresses: ['1.2.3.4'], tcp: { connected: true } }
  const hostNoDns = {
    resolved: false,
    addresses: [],
    error: 'ENOTFOUND',
    tcp: { connected: false },
  }
  const hostNoRoute = { resolved: true, addresses: ['1.2.3.4'], tcp: { connected: false } }

  test('a browser that loaded the page is fine, whatever the host says', () => {
    const verdict = diagnose({ host: hostNoDns, browser: { loaded: true }, target: 'x.test' })
    assert.equal(verdict.diagnosis, DIAGNOSIS.OK)
    assert.equal(verdict.suggestEgress, false)
  })

  test('a name the machine cannot resolve is a DNS problem', () => {
    const verdict = diagnose({ host: hostNoDns, browser: { loaded: false }, target: 'x.test' })
    assert.equal(verdict.diagnosis, DIAGNOSIS.DNS_BROKEN)
    assert.equal(verdict.suggestEgress, true)
    assert.match(verdict.hint, /DNS|resolve/i)
  })

  test('a machine that can reach it and a browser that cannot is a browser problem', () => {
    const verdict = diagnose({ host: hostOk, browser: { loaded: false }, target: 'x.test' })
    assert.equal(verdict.diagnosis, DIAGNOSIS.FIREFOX_EGRESS_BLOCKED)
    assert.equal(verdict.suggestEgress, true)
    assert.match(verdict.hint, /browser_egress/)
  })

  test('a machine that cannot reach it either is a routing problem', () => {
    const verdict = diagnose({ host: hostNoRoute, browser: { loaded: false }, target: 'x.test' })
    assert.equal(verdict.diagnosis, DIAGNOSIS.HOST_EGRESS_BLOCKED)
    assert.equal(verdict.suggestEgress, false)
  })

  test('a browser whose own resolver failed is a DNS problem, not an egress one', () => {
    // The machine resolves the name and can reach it, but Firefox's internal
    // resolver cannot. That is still DNS, and the egress proxy fixes it
    // because it resolves through DoH.
    const verdict = diagnose({
      host: hostOk,
      browser: { loaded: false, error: 'dnsNotFound' },
      target: 'x.test',
    })
    assert.equal(verdict.diagnosis, DIAGNOSIS.DNS_BROKEN)
    assert.equal(verdict.suggestEgress, true)
    assert.match(verdict.hint, /DNS|resolve/i)
  })

  test('a browser DNS failure on a name the machine cannot resolve either', () => {
    const verdict = diagnose({
      host: hostNoDns,
      browser: { loaded: false, error: 'dnsNotFound' },
      target: 'x.test',
    })
    assert.equal(verdict.diagnosis, DIAGNOSIS.DNS_BROKEN)
    assert.equal(verdict.suggestEgress, true)
  })

  test('a browser timeout is not mistaken for a DNS failure', () => {
    const verdict = diagnose({
      host: hostOk,
      browser: { loaded: false, error: 'timeout' },
      target: 'x.test',
    })
    assert.equal(verdict.diagnosis, DIAGNOSIS.FIREFOX_EGRESS_BLOCKED)
  })

  test('nothing to go on is inconclusive', () => {
    const verdict = diagnose({ host: null, browser: null, target: 'x.test' })
    assert.equal(verdict.diagnosis, DIAGNOSIS.INCONCLUSIVE)
    assert.equal(verdict.suggestEgress, false)
  })

  test('every diagnosis carries a hint', () => {
    for (const host of [hostOk, hostNoDns, hostNoRoute, null]) {
      for (const loaded of [true, false]) {
        const verdict = diagnose({ host, browser: { loaded }, target: 'x.test' })
        assert.ok(verdict.hint && verdict.hint.length > 10)
      }
    }
  })
})

describe('isErrorPage', () => {
  // The shape Firefox 140 ESR actually produces when a load fails. The URL
  // in `location.href` is the one that was asked for — it says nothing.
  const failedLoad = {
    href: 'https://this-name-does-not-exist.invalid/',
    docUri:
      'about:neterror?e=dnsNotFound&u=https%3A%2F%2Fthis-name-does-not-exist.invalid%2F&c=UTF-8',
    neterror: true,
  }

  test('a failed load is recognised', () => {
    assert.equal(isErrorPage(failedLoad), true)
  })

  test('the document URI alone is enough', () => {
    assert.equal(isErrorPage({ href: failedLoad.href, docUri: failedLoad.docUri }), true)
  })

  test('the body class alone is enough', () => {
    assert.equal(isErrorPage({ href: failedLoad.href, neterror: true }), true)
  })

  test('a page that loaded is not an error page', () => {
    assert.equal(
      isErrorPage({
        href: 'https://example.com/',
        docUri: 'https://example.com/',
        neterror: false,
      }),
      false,
    )
  })

  test('a blank tab is not an error page', () => {
    assert.equal(isErrorPage({ href: 'about:blank' }), false)
  })
})

describe('errorFromNetError', () => {
  test("Firefox's error page carries the reason in the URL", () => {
    assert.equal(
      errorFromNetError('about:neterror?e=NS_ERROR_UNKNOWN_HOST&u=http://x.test/'),
      'NS_ERROR_UNKNOWN_HOST',
    )
  })

  test('the symbolic error names Firefox 140 uses are read too', () => {
    assert.equal(
      errorFromNetError(
        'about:neterror?e=dnsNotFound&u=https%3A%2F%2Fx.invalid%2F&c=UTF-8&d=We+can%27t+connect',
      ),
      'dnsNotFound',
    )
  })

  test('a normal URL is not an error', () => {
    assert.equal(errorFromNetError('https://example.com/'), '')
  })

  test('the URL a failed load keeps is not an error on its own', () => {
    // Firefox keeps the requested URL in `location.href` when it commits its
    // error page, so this string alone says nothing about the failure.
    assert.equal(errorFromNetError('https://this-name-does-not-exist.invalid/'), '')
  })
})
