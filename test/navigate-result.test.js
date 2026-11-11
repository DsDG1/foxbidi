// test/navigate-result.test.js
// Unit tests for the honest navigation result.
//
// WHY THIS EXISTS
//
// `browser_navigate` used to report `ok: true` as soon as the command was
// accepted. The command says the navigation was DISPATCHED — not that the
// page arrived. An agent that trusted it would snapshot a page that was
// still the old one, or read a document that was never fetched.
//
// The result now carries the truth: where the tab actually IS (`landedUrl`),
// whether it MOVED (`navigated`), and — when the command returned before
// the page did — that it is still on its way (`pending`).
//
// The `url` field keeps its old meaning (the URL that was requested), so
// every existing caller still works.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { FirefoxProvider } from '../lib/firefox/provider.js'
import { ERROR_CODES } from '../lib/firefox/errors.js'

/**
 * A provider whose browser is a fake client.
 *
 * @param {object} [opts]
 * @param {string} [opts.url]       the URL the tab is on
 * @param {string} [opts.contextId]
 * @param {Function} [opts.onSend]  called for every command
 */
function makeProvider(opts = {}) {
  const provider = new FirefoxProvider()
  const state = {
    url: opts.url === undefined ? 'about:blank' : opts.url,
    contextId: opts.contextId || 'ctx-1',
  }
  provider.client = {
    connected: true,
    send: async (method, params) => {
      if (opts.onSend) {
        const handled = await opts.onSend(method, params, state)
        if (handled !== undefined) return handled
      }
      if (method === 'browsingContext.getTree') {
        return {
          contexts: [{ context: state.contextId, url: state.url, children: [] }],
        }
      }
      return {}
    },
    sendUnqueued: async () => ({}),
  }
  provider._lastContextId = state.contextId
  // No dialog settle window: the tests are about the navigation result.
  provider._dialogSettleMs = 0
  return provider
}

describe('navigate reports the truth', () => {
  test('the landing URL is reported next to the requested one', async () => {
    const provider = makeProvider({
      onSend: (method, params, state) => {
        if (method === 'browsingContext.navigate') state.url = 'https://example.com/'
        return undefined
      },
    })
    const result = await provider.navigate('https://example.com')
    assert.equal(result.ok, true)
    assert.equal(result.url, 'https://example.com', 'the requested URL keeps its meaning')
    assert.equal(result.landedUrl, 'https://example.com/')
    assert.equal(result.navigated, true)
  })

  test('a tab that did not move says so', async () => {
    // The tab is still on the old page — the navigation did not take.
    const provider = makeProvider({ url: 'https://old.example/' })
    const result = await provider.navigate('https://example.com')
    assert.equal(result.ok, true)
    assert.equal(result.landedUrl, 'https://old.example/')
    assert.equal(result.navigated, false)
    assert.equal(result.pending, undefined, 'a settled navigation is not pending')
  })

  test('a reload of the page the tab is already on counts as landed', async () => {
    // The URL does not change — but the page was fetched again, and the
    // tab IS standing on the page that was asked for.
    const provider = makeProvider({ url: 'https://example.com/' })
    const result = await provider.navigate('https://example.com')
    assert.equal(result.landedUrl, 'https://example.com/')
    assert.equal(result.navigated, true)
  })

  test('wait:none on a page that has not arrived yet says pending', async () => {
    const provider = makeProvider({ url: 'https://old.example/' })
    // The real polling logic, with a budget that keeps the test quick.
    const real = provider._awaitLanding.bind(provider)
    provider._awaitLanding = (contextId, before, budgetMs) => real(contextId, before, 60)
    const result = await provider.navigate('https://example.com', undefined, 'none')
    assert.equal(result.ok, true)
    assert.equal(result.navigated, false)
    assert.equal(result.pending, true)
    assert.match(result.hint, /browser_wait_for/)
  })

  test('wait:none on a page that did arrive does not say pending', async () => {
    const provider = makeProvider({
      onSend: (method, params, state) => {
        if (method === 'browsingContext.navigate') state.url = 'https://example.com/'
        return undefined
      },
    })
    const result = await provider.navigate('https://example.com', undefined, 'none')
    assert.equal(result.navigated, true)
    assert.equal(result.pending, undefined)
  })
})

describe('a failed navigation', () => {
  test('a stuck session is reported as session_stuck', async () => {
    const provider = makeProvider({
      onSend: (method) => {
        if (method === 'browsingContext.navigate') {
          throw new Error('browsingContext.navigate timed out after 30000ms')
        }
        return undefined
      },
    })
    // The probe fails too — that is what makes it "stuck" rather than "slow".
    provider.client.sendUnqueued = async () => {
      throw new Error('probe failed')
    }
    const result = await provider.navigate('https://example.com')
    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.SESSION_STUCK)
    assert.match(result.hint, /scope:"session"/)
  })

  test('a slow page on a healthy session stays a timeout', async () => {
    const provider = makeProvider({
      onSend: (method) => {
        if (method === 'browsingContext.navigate') {
          throw new Error('browsingContext.navigate timed out after 30000ms')
        }
        return undefined
      },
    })
    provider.client.sendUnqueued = async () => ({ contexts: [] })
    const result = await provider.navigate('https://example.com')
    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.TIMEOUT)
  })

  test('a pending request explains a slow page instead of blaming the session', async () => {
    const provider = makeProvider({
      onSend: (method) => {
        if (method === 'browsingContext.navigate') {
          throw new Error('browsingContext.navigate timed out after 30000ms')
        }
        return undefined
      },
    })
    provider.client.sendUnqueued = async () => ({ contexts: [] })
    provider.networkLog.record({ url: 'https://example.com/app.js', status: null })
    const result = await provider.navigate('https://example.com')
    assert.equal(result.code, ERROR_CODES.TIMEOUT)
    assert.match(result.hint, /still loading/)
    assert.match(result.hint, /browser_wait_for/)
  })

  test('a request pending longer than the timeout is called stuck, not slow', async () => {
    // The old wording promised "it will finish when the load does". That
    // promise cannot be kept for a request that has been pending for longer
    // than the command timeout — so the hint names the repair instead.
    const provider = makeProvider({
      onSend: (method) => {
        if (method === 'browsingContext.navigate') {
          throw new Error('browsingContext.navigate timed out after 30000ms')
        }
        return undefined
      },
    })
    provider.client.sendUnqueued = async () => ({ contexts: [] })
    provider.client.timeoutMs = 30000
    provider.networkLog.record({ url: 'https://example.com/app.js', status: null })
    // Backdate the request: it has been hanging for a minute.
    const entry = provider.networkLog.entries[provider.networkLog.entries.length - 1]
    entry.at = Date.now() - 60000
    const result = await provider.navigate('https://example.com')
    assert.equal(result.code, ERROR_CODES.TIMEOUT)
    assert.match(result.hint, /stuck behind a request/)
    assert.match(result.hint, /scope:"session"/)
    assert.doesNotMatch(result.hint, /will finish when the load does/)
  })
})
