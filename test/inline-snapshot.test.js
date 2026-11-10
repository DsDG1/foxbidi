// test/inline-snapshot.test.js
// The inline snapshot that rides along with an action.
//
// An action changes the page, and the agent's next question is almost always
// "what does it look like now?". Answering that in the action's own response
// saves a round trip.
//
// The rules this file guards:
//   - the inline view is LIGHT — only ref, role and name;
//   - it does NOT disturb the formal snapshot machinery — the sequence counter
//     and the delta baseline must survive it, or the next `since` diff would
//     be wrong;
//   - it never fails an action — the action already happened;
//   - the session switch turns it off.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { FirefoxProvider } from '../lib/firefox/provider.js'

/**
 * Serialize a plain value the way Firefox serializes a RemoteValue.
 */
function toRemoteValue(value) {
  if (value === null || value === undefined) return { type: 'null' }
  if (typeof value === 'boolean') return { type: 'boolean', value }
  if (typeof value === 'number') return { type: 'number', value }
  if (typeof value === 'string') return { type: 'string', value }
  if (Array.isArray(value)) return { type: 'array', value: value.map(toRemoteValue) }
  return {
    type: 'object',
    value: Object.entries(value).map(([k, v]) => [k, toRemoteValue(v)]),
  }
}

/**
 * A fake BiDi client that answers the calls the snapshot pipeline makes.
 *
 * @param {object} opts
 * @param {object} [opts.payload]   what the snapshot script returns
 * @param {boolean} [opts.snapshotFails] make the snapshot script throw
 */
function fakeClient(opts = {}) {
  const calls = []
  return {
    calls,
    async send(method, params) {
      calls.push({ method, params })
      if (method === 'browsingContext.getTree') return { contexts: [] }
      if (method === 'script.callFunction') {
        const declaration = params.functionDeclaration || ''
        if (declaration.includes('Object.defineProperty(window, key')) {
          return { result: { type: 'boolean', value: true } }
        }
        if (declaration.includes('const total = matched.length')) {
          if (opts.snapshotFails) throw new Error('the page refused the script')
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
 * The elements the fake page reports.
 */
const PAGE_ELEMENTS = [
  { ref: 'e0', role: 'button', name: 'Submit', rect: { x: 0, y: 0, w: 10, h: 10 } },
  { ref: 'e1', role: 'link', name: 'Cancel', rect: { x: 0, y: 0, w: 10, h: 10 } },
  {
    ref: 'e2',
    role: 'textbox',
    name: 'Password',
    rect: { x: 0, y: 0, w: 10, h: 10 },
    value: '<redacted>',
    valueRedacted: true,
    checked: false,
  },
]

describe('the inline snapshot', () => {
  test('it carries only ref, role and name', async () => {
    const client = fakeClient({ payload: { elements: PAGE_ELEMENTS, total: 3 } })
    const provider = providerWith(client)
    const inline = await provider._inlineSnapshot('ctx-1')

    assert.equal(inline.elements.length, 3)
    for (const el of inline.elements) {
      assert.deepEqual(
        Object.keys(el).sort(),
        ['name', 'ref', 'role'],
        `an inline element must carry only ref, role and name — got ${Object.keys(el).join(', ')}`,
      )
    }
  })

  test('it never carries a field value, even a redacted one', async () => {
    const client = fakeClient({ payload: { elements: PAGE_ELEMENTS, total: 3 } })
    const provider = providerWith(client)
    const inline = await provider._inlineSnapshot('ctx-1')
    const serialized = JSON.stringify(inline)
    assert.ok(!serialized.includes('redacted'), 'no value may ride along, redacted or not')
    assert.ok(!serialized.includes('rect'), 'no geometry may ride along')
  })

  test('it does not bump the snapshot sequence counter', async () => {
    const client = fakeClient({ payload: { elements: PAGE_ELEMENTS, total: 3 } })
    const provider = providerWith(client)
    const before = provider._snapshotSeq
    await provider._inlineSnapshot('ctx-1')
    assert.equal(
      provider._snapshotSeq,
      before,
      'the inline snapshot is not a formal snapshot and must not consume a snapshot id',
    )
  })

  test('it does not overwrite the delta baseline', async () => {
    const client = fakeClient({ payload: { elements: PAGE_ELEMENTS, total: 3 } })
    const provider = providerWith(client)
    provider._lastSnapshotElements = [{ ref: 'e0', role: 'button', name: 'Baseline' }]
    await provider._inlineSnapshot('ctx-1')
    assert.deepEqual(
      provider._lastSnapshotElements,
      [{ ref: 'e0', role: 'button', name: 'Baseline' }],
      'the delta baseline must survive the inline snapshot, or the next `since` diff is wrong',
    )
  })

  test('it reports truncation when the page has more elements', async () => {
    const client = fakeClient({
      payload: { elements: PAGE_ELEMENTS, total: 3, hasMore: true },
    })
    const provider = providerWith(client)
    const inline = await provider._inlineSnapshot('ctx-1')
    assert.equal(inline.truncated, true)
  })

  test('a failing page does not throw', async () => {
    const client = fakeClient({ snapshotFails: true })
    const provider = providerWith(client)
    const inline = await provider._inlineSnapshot('ctx-1')
    assert.equal(inline.elements.length, 0)
    assert.ok(inline.error, 'the reason must be reported, not swallowed')
  })

  test('a long name is truncated', async () => {
    const long = 'x'.repeat(200)
    const client = fakeClient({
      payload: { elements: [{ ref: 'e0', role: 'button', name: long }], total: 1 },
    })
    const provider = providerWith(client)
    const inline = await provider._inlineSnapshot('ctx-1')
    assert.equal(inline.elements[0].name.length, 60)
  })
})

describe('the inline snapshot on an action', () => {
  /**
   * Run the action's inline-snapshot step against a fake page.
   */
  async function runInline(provider, opts = {}) {
    return provider._withInlineSnapshot({ ok: true, contextId: 'ctx-1' }, 'ctx-1', opts)
  }

  test('a successful action carries the inline elements', async () => {
    const client = fakeClient({ payload: { elements: PAGE_ELEMENTS, total: 3 } })
    const provider = providerWith(client)
    const result = await runInline(provider)
    assert.ok(result.effect.snapshot, 'the action response must carry the inline elements')
    assert.equal(result.effect.snapshot.length, 3)
  })

  test('the session switch turns it off', async () => {
    const client = fakeClient({ payload: { elements: PAGE_ELEMENTS, total: 3 } })
    const provider = providerWith(client)
    provider.config_.inlineSnapshot = false
    const result = await runInline(provider)
    assert.equal(result.effect, undefined, 'no effect is attached when the view is off')
  })

  test('a per-call opt-out wins over the session switch', async () => {
    const client = fakeClient({ payload: { elements: PAGE_ELEMENTS, total: 3 } })
    const provider = providerWith(client)
    provider.config_.inlineSnapshot = true
    const result = await runInline(provider, { includeSnapshot: false })
    assert.equal(result.effect, undefined, 'the per-call opt-out must win')
  })

  test('a failed action is not given an inline snapshot', async () => {
    const client = fakeClient({ payload: { elements: PAGE_ELEMENTS, total: 3 } })
    const provider = providerWith(client)
    const result = await provider._withInlineSnapshot(
      { ok: false, code: 'element_not_found', error: 'gone' },
      'ctx-1',
    )
    assert.equal(result.ok, false)
    assert.equal(result.effect, undefined)
  })

  test('a failing inline snapshot does not fail the action', async () => {
    const client = fakeClient({ snapshotFails: true })
    const provider = providerWith(client)
    const result = await runInline(provider)
    assert.equal(result.ok, true, 'the action already happened; the look must not undo it')
    assert.ok(result.effect.snapshotError, 'the reason must be reported')
    assert.equal(result.effect.snapshot, undefined)
  })

  test('truncation is reported to the agent', async () => {
    const client = fakeClient({
      payload: { elements: PAGE_ELEMENTS, total: 3, hasMore: true },
    })
    const provider = providerWith(client)
    const result = await runInline(provider)
    assert.equal(result.effect.snapshotTruncated, true)
  })
})
