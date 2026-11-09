// test/provider-snapshot.test.js
// Unit tests for the provider's snapshot pipeline.
//
// The point of these tests is the WIRING: that the registry is created before
// the snapshot runs, that the offset and the filters reach the page script,
// that frame contents are merged with a frame-prefixed ref, and that the
// result says which ref mode is in use.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { FirefoxProvider } from '../lib/firefox/provider.js'
import { REF_MODE } from '../lib/firefox/registry.js'

/**
 * Serialize a plain value the way Firefox serializes a RemoteValue.
 *
 * Firefox sends an object as an array of [key, RemoteValue] pairs — NOT as a
 * plain JSON object. Reproducing that here is what makes the unwrapping code
 * under test actually run.
 */
function toRemoteValue(value) {
  if (value === null || value === undefined) return { type: 'null' }
  if (typeof value === 'boolean') return { type: 'boolean', value }
  if (typeof value === 'number') return { type: 'number', value }
  if (typeof value === 'string') return { type: 'string', value }
  if (Array.isArray(value)) {
    return { type: 'array', value: value.map(toRemoteValue) }
  }
  return {
    type: 'object',
    value: Object.entries(value).map(([k, v]) => [k, toRemoteValue(v)]),
  }
}

/**
 * A fake BiDi client that answers the calls the snapshot pipeline makes.
 *
 * @param {object} opts
 * @param {object} [opts.payload]      what the snapshot script returns
 * @param {Array}  [opts.tree]         the context tree
 * @param {boolean} [opts.registryFails] make the registry script fail
 */
function fakeClient(opts = {}) {
  const calls = []
  return {
    calls,
    async send(method, params) {
      calls.push({ method, params })
      if (method === 'browsingContext.getTree') {
        return { contexts: opts.tree || [] }
      }
      if (method === 'script.callFunction') {
        const declaration = params.functionDeclaration || ''
        if (declaration.includes('Object.defineProperty(window, key')) {
          if (opts.registryFails) throw new Error('blocked')
          return { result: { type: 'boolean', value: true } }
        }
        if (declaration.includes('const total = matched.length')) {
          return { result: toRemoteValue(opts.payload || {}) }
        }
        return { result: { type: 'boolean', value: true } }
      }
      return {}
    },
  }
}

/**
 * A provider wired to a fake client.
 */
function providerWith(client) {
  const provider = new FirefoxProvider({ copyBaseDir: '/tmp/ffb-test' })
  provider.client = client
  provider.state = 'ready'
  provider._ensureReady = async () => true
  provider._resolveContext = async (id) => id || 'ctx-1'
  return provider
}

/**
 * The snapshot script call, if it happened.
 */
function snapshotCall(client) {
  return client.calls.find(
    (c) =>
      c.method === 'script.callFunction' &&
      (c.params.functionDeclaration || '').includes('const total = matched.length'),
  )
}

describe('provider.snapshot', () => {
  test('the registry is created before the snapshot runs', async () => {
    const client = fakeClient({ payload: { elements: [], total: 0 } })
    const provider = providerWith(client)
    await provider.snapshot('ctx-1')

    const registryIndex = client.calls.findIndex((c) =>
      (c.params.functionDeclaration || '').includes('Object.defineProperty(window, key'),
    )
    const snapshotIndex = client.calls.findIndex((c) =>
      (c.params.functionDeclaration || '').includes('const total = matched.length'),
    )
    assert.ok(registryIndex >= 0, 'the registry must be created')
    assert.ok(snapshotIndex > registryIndex, 'the snapshot must run after the registry')
  })

  test('the snapshot reports the registry ref mode', async () => {
    const client = fakeClient({ payload: { elements: [], total: 0 } })
    const provider = providerWith(client)
    const result = await provider.snapshot('ctx-1')
    assert.equal(result.ok, true)
    assert.equal(result.refMode, REF_MODE.REGISTRY)
  })

  test('a page that refuses the registry falls back to the attribute mode', async () => {
    const client = fakeClient({ payload: { elements: [], total: 0 }, registryFails: true })
    const provider = providerWith(client)
    const result = await provider.snapshot('ctx-1')
    assert.equal(result.ok, true)
    assert.equal(result.refMode, REF_MODE.ATTRIBUTE)
  })

  test('the offset and the limit reach the page script', async () => {
    const client = fakeClient({ payload: { elements: [], total: 100 } })
    const provider = providerWith(client)
    await provider.snapshot('ctx-1', { offset: 300, maxElements: 50 })

    const call = snapshotCall(client)
    const args = call.params.arguments
    assert.equal(args[1].value, 300, 'the offset must be passed to the page')
    assert.equal(args[2].value, 50, 'the limit must be passed to the page')
  })

  test('the role filter reaches the page script', async () => {
    const client = fakeClient({ payload: { elements: [], total: 0 } })
    const provider = providerWith(client)
    await provider.snapshot('ctx-1', { roleFilter: ['button', 'link'] })

    const call = snapshotCall(client)
    const args = call.params.arguments
    assert.deepEqual(JSON.parse(args[3].value), ['button', 'link'])
  })

  test('the pagination fields come back from the page', async () => {
    const client = fakeClient({
      payload: {
        elements: [{ ref: 'e300', role: 'button', name: 'Later' }],
        total: 600,
        hasMore: true,
      },
    })
    const provider = providerWith(client)
    const result = await provider.snapshot('ctx-1', { offset: 300 })
    assert.equal(result.total, 600)
    assert.equal(result.hasMore, true)
    assert.equal(result.nextOffset, 301)
    assert.equal(result.elements[0].ref, 'e300')
  })

  test('frame contents are merged with a frame-prefixed ref', async () => {
    const client = fakeClient({
      payload: { elements: [{ ref: 'e0', role: 'button', name: 'Top' }], total: 1 },
      tree: [
        {
          context: 'ctx-1',
          url: 'https://example.com',
          children: [{ context: 'frame-abc12345-6789', url: 'https://frame.example' }],
        },
      ],
    })
    const provider = providerWith(client)
    const result = await provider.snapshot('ctx-1', { frames: 'all' })

    assert.ok(result.frames, 'the frames must be reported')
    assert.equal(result.frames.length, 1)
    assert.ok(result.frames[0].frameId.startsWith('f'))
    assert.ok(
      result.frames[0].elements[0].ref.startsWith(`${result.frames[0].frameId}:`),
      'a frame ref must carry its frame label',
    )
    // The provider must remember which context each frame label means.
    assert.equal(provider._frameMap.get(result.frames[0].frameId), 'frame-abc12345-6789')
  })

  test('the includeText flag reaches the page script', async () => {
    const client = fakeClient({ payload: { elements: [], total: 0, texts: ['hello'] } })
    const provider = providerWith(client)
    const result = await provider.snapshot('ctx-1', { includeText: true })
    assert.deepEqual(result.texts, ['hello'])
    const call = snapshotCall(client)
    assert.equal(call.params.arguments[5].value, true)
  })
})
