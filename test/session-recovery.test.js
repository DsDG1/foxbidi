// test/session-recovery.test.js
// Unit tests for the stuck-session detection and the session-scoped restart.
//
// WHY THIS EXISTS
//
// A command that never returns holds the BiDi session's serialized queue, and
// every command behind it waits. The agent used to see a plain `timeout`,
// which reads like "the page is slow" and sends it into the wrong repair —
// retry the navigation, wait longer — while the session needs a reset.
//
// These tests pin the two halves of the fix:
//   - a timeout whose probe ALSO fails is reported as `session_stuck`;
//   - `browser_restart {scope:"session"}` clears it WITHOUT killing Firefox,
//     so the tabs and the login state survive.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { FirefoxProvider } from '../lib/firefox/provider.js'
import { ERROR_CODES } from '../lib/firefox/errors.js'

/**
 * A provider with a fake client.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.connected]  whether the client looks connected
 * @param {Function} [opts.probe]  what the probe does
 */
function makeProvider(opts = {}) {
  const provider = new FirefoxProvider()
  provider.client = {
    connected: opts.connected !== false,
    send: async () => ({}),
    sendUnqueued:
      opts.probe ||
      (async () => {
        throw new Error('probe failed')
      }),
  }
  return provider
}

describe('_sessionResponsive', () => {
  test('a connected session that answers the probe is responsive', async () => {
    const provider = makeProvider({
      probe: async () => ({ contexts: [] }),
    })
    assert.equal(await provider._sessionResponsive(), true)
  })

  test('a session whose probe fails is not responsive', async () => {
    const provider = makeProvider()
    assert.equal(await provider._sessionResponsive(), false)
  })

  test('a disconnected client is not responsive', async () => {
    const provider = makeProvider({ connected: false })
    assert.equal(await provider._sessionResponsive(), false)
  })

  test('the probe goes AROUND the command queue', async () => {
    // The queue is exactly what stopped moving, so a queued probe would
    // time out for the same reason and would tell us nothing.
    const calls = []
    const provider = makeProvider({
      probe: async (method) => {
        calls.push(method)
        return {}
      },
    })
    await provider._sessionResponsive()
    assert.deepEqual(calls, ['browsingContext.getTree'])
  })
})

describe('_classifyCommandFailure', () => {
  test('a timeout on a responsive session stays a timeout', async () => {
    const provider = makeProvider({
      probe: async () => ({ contexts: [] }),
    })
    const code = await provider._classifyCommandFailure(
      new Error('browsingContext.navigate timed out after 30000ms'),
    )
    assert.equal(code, ERROR_CODES.TIMEOUT)
  })

  test('a timeout on an unresponsive session is a stuck session', async () => {
    const provider = makeProvider()
    const code = await provider._classifyCommandFailure(
      new Error('browsingContext.navigate timed out after 30000ms'),
    )
    assert.equal(code, ERROR_CODES.SESSION_STUCK)
  })

  test('a failure that is not a timeout keeps its own code', async () => {
    const provider = makeProvider()
    const code = await provider._classifyCommandFailure(new Error('no such element'))
    assert.equal(code, ERROR_CODES.NO_CONTEXT)
  })

  test('a timeout without a client cannot be classified as stuck', async () => {
    const provider = new FirefoxProvider()
    provider.client = null
    const code = await provider._classifyCommandFailure(new Error('timed out'))
    assert.equal(code, ERROR_CODES.TIMEOUT)
  })
})

describe('restart', () => {
  /**
   * A provider whose lifecycle calls are recorded.
   *
   * @param {boolean} [running]
   */
  function makeRestartable(running = true) {
    const provider = new FirefoxProvider()
    provider.state = running ? 'ready' : 'idle'
    provider.pid = running ? 4242 : null
    provider.calls = []
    provider.stop = async (opts) => {
      provider.calls.push(['stop', opts])
      provider.state = 'idle'
      return { ok: true }
    }
    provider.start = async () => {
      provider.calls.push(['start'])
      provider.state = 'ready'
      return { ok: true }
    }
    return provider
  }

  test('the default scope restarts the browser', async () => {
    const provider = makeRestartable()
    const result = await provider.restart()
    assert.equal(result.scope, 'browser')
    assert.equal(result.browserKept, false)
    assert.deepEqual(provider.calls[0], ['stop', { kill: true, keepEgress: true }])
  })

  test('the session scope keeps the browser', async () => {
    const provider = makeRestartable()
    const result = await provider.restart({ scope: 'session' })
    assert.equal(result.scope, 'session')
    assert.equal(result.browserKept, true)
    assert.deepEqual(
      provider.calls[0],
      ['stop', { kill: false, keepEgress: true }],
      'the browser must not be killed for a session reset',
    )
    assert.deepEqual(provider.calls[1], ['start'])
  })

  test('the session scope keeps the egress proxy up', async () => {
    // The proxy's port lives in the browser's preferences — killing the
    // proxy on a session reset would point the browser at a dead port.
    const provider = makeRestartable()
    await provider.restart({ scope: 'session' })
    assert.equal(provider.calls[0][1].keepEgress, true)
  })

  test('an unknown scope falls back to the browser', async () => {
    const provider = makeRestartable()
    const result = await provider.restart({ scope: 'nonsense' })
    assert.equal(result.scope, 'browser')
    assert.deepEqual(provider.calls[0], ['stop', { kill: true, keepEgress: true }])
  })

  test('a session reset on a stopped browser just starts it', async () => {
    const provider = makeRestartable(false)
    const result = await provider.restart({ scope: 'session' })
    assert.deepEqual(provider.calls, [['start']])
    assert.equal(result.browserKept, false)
    assert.equal(result.wasRunning, false)
  })

  test('the result reports the scope and the new session', async () => {
    const provider = makeRestartable()
    provider.sessionId = 'sess-2'
    const result = await provider.restart({ scope: 'session' })
    assert.equal(result.ok, true)
    assert.equal(result.restarted, true)
    assert.equal(result.sessionId, 'sess-2')
  })
})
