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

  test('nested iframes are collected recursively when frames="all"', async () => {
    const client = fakeClient({
      payload: { elements: [{ ref: 'e0', role: 'button', name: 'Btn' }], total: 1 },
      tree: [
        {
          context: 'ctx-1',
          url: 'https://example.com',
          children: [
            {
              context: 'frame-outer-1111',
              url: 'https://outer.example',
              children: [
                { context: 'frame-inner-2222', url: 'https://inner.example', children: [] },
              ],
            },
          ],
        },
      ],
    })
    const provider = providerWith(client)
    const result = await provider.snapshot('ctx-1', { frames: 'all' })
    assert.equal(result.frames.length, 2)
    assert.equal(result.frames[0].contextId, 'frame-outer-1111')
    assert.equal(result.frames[1].contextId, 'frame-inner-2222')
  })

  test('snapshot delta uses the requested snapshotId baseline across interleaved tabs', async () => {
    const payloads = {
      'tab-a': [{ ref: 'e0', role: 'button', name: 'Save' }],
      'tab-b': [
        { ref: 'e0', role: 'link', name: 'Other tab link 1' },
        { ref: 'e1', role: 'link', name: 'Other tab link 2' },
      ],
    }
    const client = {
      async send(method, params) {
        if (method === 'script.callFunction') {
          const fn = params.functionDeclaration || ''
          if (fn.includes('const total = matched.length')) {
            const els = payloads[params.target.context] || []
            return { result: toRemoteValue({ elements: els, total: els.length }) }
          }
          return { result: { type: 'boolean', value: true } }
        }
        return {}
      },
    }
    const provider = providerWith(client)
    provider._tabUrls.set('tab-a', 'https://alpha.example/settings?token=secret')
    provider._tabUrls.set('tab-b', 'https://beta.example/home')

    const snap1 = await provider.snapshot('tab-a')
    assert.equal(snap1.source.origin, 'https://alpha.example')

    const snap2 = await provider.snapshot('tab-b')
    assert.equal(snap2.source.origin, 'https://beta.example')

    // Mutate tab-a and diff against snap1.snapshotId — tab-b must not pollute the delta.
    payloads['tab-a'] = [
      { ref: 'e0', role: 'button', name: 'Saved!' },
      { ref: 'e1', role: 'button', name: 'Close' },
    ]
    const snap3 = await provider.snapshot('tab-a', { since: snap1.snapshotId })
    assert.ok(snap3.delta)
    assert.deepEqual(
      snap3.delta.changed.map((e) => e.ref),
      ['e0'],
    )
    assert.deepEqual(
      snap3.delta.added.map((e) => e.ref),
      ['e1'],
    )
    assert.deepEqual(snap3.delta.removed, [])
  })

  test('listTabs returns top-level tabs only while _contextUrl still resolves child frames', async () => {
    const client = fakeClient({
      tree: [
        {
          context: 'tab-1',
          url: 'https://example.com/',
          children: [{ context: 'iframe-1', url: 'https://ads.example.com/', children: [] }],
        },
        {
          context: 'tab-2',
          url: 'https://docs.example.com/',
          children: [],
        },
      ],
    })
    const provider = providerWith(client)
    const tabs = await provider.listTabs()
    assert.equal(tabs.length, 2)
    assert.deepEqual(
      tabs.map((t) => t.contextId),
      ['tab-1', 'tab-2'],
    )
    assert.equal(await provider._contextUrl('iframe-1'), 'https://ads.example.com/')
  })

  test('setViewport forwards devicePixelRatio to browsingContext.setViewport', async () => {
    const client = fakeClient({})
    const provider = providerWith(client)
    provider._ensureCapabilities = async () => ({
      browserVersion: '140.0',
      features: { setViewport: true },
    })

    const res = await provider.setViewport(
      { width: 390, height: 844, devicePixelRatio: 3 },
      'ctx-1',
      true,
    )
    assert.equal(res.ok, true)
    assert.equal(res.devicePixelRatio, 3)
    const vpCall = client.calls.find((c) => c.method === 'browsingContext.setViewport')
    assert.ok(vpCall)
    assert.equal(vpCall.params.devicePixelRatio, 3)
  })

  test('format="compact" emits landmark-grouped tree and omits full elements array', async () => {
    const client = fakeClient({
      payload: {
        elements: [
          { ref: 'e0', role: 'link', name: 'Home', landmark: 'navigation' },
          { ref: 'e1', role: 'textbox', name: 'Query', value: 'foxbidi', landmark: 'main' },
          { ref: 'e2', role: 'button', name: 'Search', disabled: true, landmark: 'main' },
        ],
        total: 3,
      },
    })
    const provider = providerWith(client)
    const res = await provider.snapshot('ctx-1', { format: 'compact' })
    assert.equal(res.ok, true)
    assert.equal(res.elements, undefined)
    assert.match(res.tree, /\[navigation\]\n {2}e0 link "Home"/)
    assert.match(
      res.tree,
      /\[main\]\n {2}e1 textbox "Query" val="foxbidi"\n {2}e2 button "Search" \[disabled\]/,
    )
  })

  test('deltaOnly=true omits full elements and reports unchanged when nothing changed', async () => {
    const elements = [{ ref: 'e0', role: 'button', name: 'Save' }]
    const client = fakeClient({ payload: { elements, total: 1 } })
    const provider = providerWith(client)
    const first = await provider.snapshot('ctx-1')
    const second = await provider.snapshot('ctx-1', { since: first.snapshotId, deltaOnly: true })
    assert.equal(second.ok, true)
    assert.equal(second.elements, undefined)
    assert.equal(second.unchanged, true)
    assert.deepEqual(second.delta.added, [])
    assert.deepEqual(second.delta.changed, [])
    assert.deepEqual(second.delta.removed, [])
  })

  test('navigate with includeSnapshot=true attaches effect.snapshot in one round trip', async () => {
    const client = fakeClient({
      payload: { elements: [{ ref: 'e0', role: 'button', name: 'Sign in' }], total: 1 },
      tree: [{ context: 'ctx-1', url: 'https://example.com/login', children: [] }],
    })
    const origSend = client.send.bind(client)
    client.send = async (method, params) => {
      if (method === 'browsingContext.navigate') {
        return { navigation: 'nav-1', url: 'https://example.com/login' }
      }
      return origSend(method, params)
    }
    const provider = providerWith(client)
    const res = await provider.navigate('https://example.com/login', 'ctx-1', 'complete', {
      includeSnapshot: true,
    })
    assert.equal(res.ok, true)
    assert.ok(Array.isArray(res.effect?.snapshot))
    assert.equal(res.effect.snapshot[0].name, 'Sign in')
  })
})
