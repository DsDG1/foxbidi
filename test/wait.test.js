// test/wait.test.js
// Unit tests for the waiting primitives.
//
// The wait functions talk to a BiDi client, so the client is faked. The
// point is the CONTROL FLOW: a condition that becomes true succeeds, a
// condition that never becomes true times out with the elapsed time
// reported, and a client that throws mid-poll does not abort the wait
// early (a navigation in flight makes evaluation fail).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  waitFor,
  waitForLoad,
  waitForNetworkIdle,
  selectorExpression,
  textExpression,
  DEFAULT_TIMEOUT_MS,
} from '../lib/firefox/wait.js'
import { NetworkLog } from '../lib/firefox/network.js'

/**
 * A fake client whose evaluation returns `values` in order, repeating the
 * last one forever.
 *
 * @param {Array<*>} values
 * @param {object} [opts]
 * @param {boolean} [opts.throwFirst]  throw on the first evaluation
 */
function fakeClient(values, opts = {}) {
  let call = 0
  return {
    send: async () => {
      if (opts.throwFirst && call === 0) {
        call += 1
        throw new Error('execution context was destroyed')
      }
      const value = values[Math.min(call, values.length - 1)]
      call += 1
      return { result: { type: 'boolean', value } }
    },
    calls: () => call,
  }
}

describe('waitFor', () => {
  test('succeeds as soon as the condition holds', async () => {
    const client = fakeClient([false, false, true])
    const result = await waitFor(client, {
      context: 'ctx',
      expression: 'true',
      timeoutMs: 2000,
      intervalMs: 5,
    })
    assert.equal(result.ok, true)
    assert.equal(result.matched, true)
    assert.ok(result.elapsedMs >= 0)
  })

  test('times out with the elapsed time reported', async () => {
    const client = fakeClient([false])
    const result = await waitFor(client, {
      context: 'ctx',
      expression: 'false',
      timeoutMs: 120,
      intervalMs: 10,
    })
    assert.equal(result.ok, false)
    assert.equal(result.matched, false)
    assert.ok(result.elapsedMs >= 100)
    assert.equal(result.timeoutMs, 120)
  })

  test('a throwing client does not abort the wait early', async () => {
    // A navigation in flight makes evaluation fail — the wait must keep
    // polling rather than reporting a spurious failure.
    const client = fakeClient([false, true], { throwFirst: true })
    const result = await waitFor(client, {
      context: 'ctx',
      expression: 'true',
      timeoutMs: 2000,
      intervalMs: 5,
    })
    assert.equal(result.ok, true)
    assert.equal(result.matched, true)
  })

  test('the default timeout is sane', () => {
    assert.ok(DEFAULT_TIMEOUT_MS > 0)
    assert.equal(typeof DEFAULT_TIMEOUT_MS, 'number')
  })
})

describe('waitForLoad', () => {
  test('uses a readyState expression', async () => {
    const client = fakeClient([true])
    const result = await waitForLoad(client, { context: 'ctx', timeoutMs: 1000 })
    assert.equal(result.ok, true)
  })
})

describe('waitForNetworkIdle', () => {
  test('returns once the network has been quiet long enough', async () => {
    const log = new NetworkLog()
    const result = await waitForNetworkIdle(
      { send: async () => ({}) },
      { context: 'ctx', log, quietMs: 20, timeoutMs: 2000 },
    )
    assert.equal(result.ok, true)
    assert.equal(result.matched, true)
  })

  test('a continuously busy network times out', async () => {
    const log = new NetworkLog()
    const client = {
      send: async () => {
        log.record({ method: 'GET', url: 'https://example.com/x' })
        return {}
      },
    }
    // The fake client is never called by waitForNetworkIdle (it polls the
    // log), so a timer keeps the log busy instead.
    const timer = setInterval(() => {
      log.record({ method: 'GET', url: 'https://example.com/x' })
    }, 5)
    const result = await waitForNetworkIdle(client, {
      context: 'ctx',
      log,
      quietMs: 40,
      timeoutMs: 150,
    })
    clearInterval(timer)
    assert.equal(result.ok, false)
    assert.equal(result.matched, false)
  })

  test('waits for an in-flight requestId to finish even after quietMs passes', async () => {
    const log = new NetworkLog()
    log.record({
      requestId: 'req-slow',
      contextId: 'ctx-1',
      phase: 'start',
      method: 'GET',
      url: 'https://example.com/slow',
      status: null,
    })

    let settled = false
    setTimeout(() => {
      settled = true
      log.record({
        requestId: 'req-slow',
        contextId: 'ctx-1',
        phase: 'complete',
        method: 'GET',
        url: 'https://example.com/slow',
        status: 200,
      })
    }, 60)

    const result = await waitForNetworkIdle(
      { send: async () => ({}) },
      { context: 'ctx-1', log, quietMs: 15, timeoutMs: 1000 },
    )
    assert.equal(result.ok, true)
    assert.equal(settled, true, 'must not resolve while req-slow is still pending')
  })

  test('ignores noisy background requests from a different contextId', async () => {
    const log = new NetworkLog()
    const timer = setInterval(() => {
      log.record({
        requestId: `bg-${Date.now()}`,
        contextId: 'ctx-background',
        phase: 'start',
        method: 'GET',
        url: 'https://ads.example.com/ping',
        status: null,
      })
    }, 5)

    try {
      const result = await waitForNetworkIdle(
        { send: async () => ({}) },
        { context: 'ctx-foreground', log, quietMs: 25, timeoutMs: 500 },
      )
      assert.equal(result.ok, true)
      assert.equal(result.matched, true)
    } finally {
      clearInterval(timer)
    }
  })
})

describe('wait expressions', () => {
  test('the selector expression embeds the selector safely', () => {
    const expr = selectorExpression('#a"b')
    assert.ok(expr.includes('querySelector'))
    assert.ok(expr.includes('\\"b'))
  })

  test('the text expression embeds the text safely', () => {
    const expr = textExpression('hello "world"')
    assert.ok(expr.includes('innerText'))
    assert.ok(expr.includes('includes'))
  })
})
