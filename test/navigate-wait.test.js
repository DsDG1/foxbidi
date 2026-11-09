// test/navigate-wait.test.js
// Unit tests for the navigation wait strategy.
//
// Firefox's `browsingContext.navigate` accepts exactly three wait values:
// none, interactive and complete. Anything else is rejected by the browser
// itself with "Expected \"wait\" to be one of none,interactive,complete" —
// so the plugin must normalize before the value reaches the wire.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  navigate,
  normalizeWaitStrategy,
  NAV_WAIT_STRATEGIES,
} from '../lib/bidi/protocol.js'

/**
 * A fake BiDi client that records the params it was asked to send.
 *
 * @returns {{client: object, sent: Array}}
 */
function recordingClient() {
  const sent = []
  return {
    sent,
    client: {
      send: async (method, params) => {
        sent.push({ method, params })
        return {}
      },
    },
  }
}

describe('normalizeWaitStrategy', () => {
  test('the three Firefox strategies pass through unchanged', () => {
    for (const strategy of NAV_WAIT_STRATEGIES) {
      assert.equal(normalizeWaitStrategy(strategy), strategy)
    }
  })

  test('the legacy "load" value maps onto "interactive"', () => {
    assert.equal(normalizeWaitStrategy('load'), 'interactive')
  })

  test('the strategy is matched case-insensitively', () => {
    assert.equal(normalizeWaitStrategy('INTERACTIVE'), 'interactive')
    assert.equal(normalizeWaitStrategy(' none '), 'none')
  })

  test('an unknown value falls back to "complete"', () => {
    assert.equal(normalizeWaitStrategy('domcontentloaded'), 'complete')
    assert.equal(normalizeWaitStrategy(undefined), 'complete')
    assert.equal(normalizeWaitStrategy(null), 'complete')
  })

  test('"load" is never forwarded to Firefox', () => {
    assert.notEqual(normalizeWaitStrategy('load'), 'load')
  })
})

describe('navigate', () => {
  test('the wait value sent to Firefox is always a real strategy', async () => {
    for (const requested of ['none', 'interactive', 'complete', 'load', 'bogus']) {
      const { client, sent } = recordingClient()
      await navigate(client, 'https://example.com', 'ctx', requested)
      assert.ok(
        NAV_WAIT_STRATEGIES.includes(sent[0].params.wait),
        `"${requested}" was forwarded as "${sent[0].params.wait}"`,
      )
    }
  })

  test('the legacy "load" value is sent as "interactive"', async () => {
    const { client, sent } = recordingClient()
    await navigate(client, 'https://example.com', 'ctx', 'load')
    assert.equal(sent[0].params.wait, 'interactive')
  })

  test('the context is passed in the shape BiDi expects', async () => {
    const { client, sent } = recordingClient()
    await navigate(client, 'https://example.com', 'ctx', 'none')
    assert.equal(sent[0].method, 'browsingContext.navigate')
    assert.equal(sent[0].params.url, 'https://example.com')
    assert.equal(sent[0].params.context, 'ctx')
  })

  test('the default is "complete"', async () => {
    const { client, sent } = recordingClient()
    await navigate(client, 'https://example.com', 'ctx')
    assert.equal(sent[0].params.wait, 'complete')
  })
})
