// test/provider-viewport.test.js
// The four tools added in v2.3.0: history traversal, reload and the
// viewport override.
//
// They are exercised against a FAKE client, so the tests run without a
// browser and assert the contract: which capability gates each call, what
// the failure shape is, and that the viewport change asks for confirmation.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { FirefoxProvider } from '../lib/firefox/provider.js'
import { ERROR_CODES } from '../lib/firefox/errors.js'
import { ACTION_KINDS } from '../lib/firefox/confirm.js'

/** A BiDi client that records what it was asked to do. */
function fakeClient(features = {}) {
  const sent = []
  return {
    sent,
    connected: true,
    async send(method, params) {
      sent.push({ method, params })
      if (method === 'browsingContext.getTree') {
        return { contexts: [{ context: 'ctx-1', url: 'https://example.com/' }] }
      }
      if (method === 'session.status') {
        return { ready: true, message: 'Firefox' }
      }
      return {}
    },
    on() {},
    close() {},
  }
}

function makeProvider(client, featureSet = {}) {
  const provider = new FirefoxProvider({})
  provider.client = client
  provider.state = 'ready'
  provider._lastContextId = 'ctx-1'
  provider._capabilities = {
    features: {
      traverseHistory: true,
      contextReload: true,
      setViewport: true,
      ...featureSet,
    },
    browserVersion: '140.11.0esr',
    probed: true,
  }
  provider._ensureCapabilities = async () => provider._capabilities
  return provider
}

describe('browser_back / browser_forward', () => {
  test('back traverses with delta -1', async () => {
    const client = fakeClient()
    const provider = makeProvider(client)
    const result = await provider.back()
    assert.equal(result.ok, true)
    const call = client.sent.find((c) => c.method === 'browsingContext.traverseHistory')
    assert.ok(call, 'traverseHistory must be called')
    assert.equal(call.params.delta, -1)
    assert.equal(call.params.context, 'ctx-1')
  })

  test('forward traverses with delta +1', async () => {
    const client = fakeClient()
    const provider = makeProvider(client)
    const result = await provider.forward()
    assert.equal(result.ok, true)
    const call = client.sent.find((c) => c.method === 'browsingContext.traverseHistory')
    assert.equal(call.params.delta, 1)
  })

  test('an empty history is reported as an invalid argument, not a crash', async () => {
    const client = fakeClient()
    client.send = async (method, params) => {
      if (method === 'browsingContext.traverseHistory') {
        throw new Error('History entry with delta -1 not found')
      }
      return {}
    }
    const provider = makeProvider(client)
    const result = await provider.back()
    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.INVALID_ARGUMENT)
    assert.match(result.hint, /no earlier page/)
  })

  test('a Firefox without history support says so', async () => {
    const client = fakeClient()
    const provider = makeProvider(client, { traverseHistory: false })
    const result = await provider.back()
    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.CAPABILITY_UNAVAILABLE)
    assert.equal(result.feature, 'traverseHistory')
  })
})

describe('browser_reload', () => {
  test('reload reloads the resolved context', async () => {
    const client = fakeClient()
    const provider = makeProvider(client)
    const result = await provider.reload()
    assert.equal(result.ok, true)
    assert.equal(result.reloaded, true)
    const call = client.sent.find((c) => c.method === 'browsingContext.reload')
    assert.ok(call)
    assert.equal(call.params.context, 'ctx-1')
  })

  test('a Firefox without reload says so', async () => {
    const client = fakeClient()
    const provider = makeProvider(client, { contextReload: false })
    const result = await provider.reload()
    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.CAPABILITY_UNAVAILABLE)
  })
})

describe('browser_set_viewport', () => {
  test('it asks for confirmation before changing the viewport', async () => {
    const client = fakeClient()
    const provider = makeProvider(client)
    const result = await provider.setViewport({ width: 390, height: 844 })
    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.CONFIRM_REQUIRED)
    assert.equal(result.blocked, true)
    assert.equal(result.requiresConfirm, true)
    assert.equal(result.action, ACTION_KINDS.VIEWPORT_SET)
    assert.ok(
      !client.sent.some((c) => c.method === 'browsingContext.setViewport'),
      'the viewport must not change before confirmation',
    )
  })

  test('a confirmed change sets the viewport', async () => {
    const client = fakeClient()
    const provider = makeProvider(client)
    const result = await provider.setViewport({ width: 390, height: 844 }, undefined, true)
    assert.equal(result.ok, true)
    assert.equal(result.width, 390)
    assert.equal(result.height, 844)
    const call = client.sent.find((c) => c.method === 'browsingContext.setViewport')
    assert.ok(call)
    assert.equal(call.params.viewport.width, 390)
    assert.equal(call.params.viewport.height, 844)
  })

  test('a non-positive size is rejected before the browser is touched', async () => {
    const client = fakeClient()
    const provider = makeProvider(client)
    for (const size of [
      { width: 0, height: 100 },
      { width: 100, height: -1 },
      { width: 'wide', height: 100 },
    ]) {
      const result = await provider.setViewport(size, undefined, true)
      assert.equal(result.ok, false, `${JSON.stringify(size)} must be rejected`)
      assert.equal(result.code, ERROR_CODES.INVALID_ARGUMENT)
    }
    assert.ok(!client.sent.some((c) => c.method === 'browsingContext.setViewport'))
  })

  test('a Firefox without viewport support says so', async () => {
    const client = fakeClient()
    const provider = makeProvider(client, { setViewport: false })
    const result = await provider.setViewport({ width: 390, height: 844 }, undefined, true)
    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.CAPABILITY_UNAVAILABLE)
    assert.equal(result.feature, 'setViewport')
  })
})
