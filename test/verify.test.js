// test/verify.test.js
// The assertion tool.
//
// browser_verify answers "is the page in the state I expect?" and returns a
// verdict, so the agent does not have to pull a whole snapshot and do the
// comparison itself.
//
// The rules this file guards:
//   - `ok` (could the assertion run) and `verified` (did it hold) are two
//     different things;
//   - a credential field is REFUSED rather than compared, and the refusal
//     never leaks the value;
//   - the argument a kind needs is checked where the kind is known.

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
 * A fake BiDi client.
 *
 * `client.send` resolves with `{result: <RemoteValue>}` — the BiDi layer
 * hands back the command's own result payload, and every script.callFunction
 * caller unwraps it the same way.
 *
 * @param {object} opts
 * @param {object} [opts.elements]   the snapshot elements
 * @param {string[]} [opts.texts]     the visible text blocks
 * @param {object} [opts.inspect]     what inspectElement returns
 * @param {string} [opts.elementText] the text inside the target element
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
          return {
            result: toRemoteValue({
              elements: opts.elements || [],
              total: (opts.elements || []).length,
              texts: opts.texts || [],
            }),
          }
        }
        if (declaration.includes('el.innerText || el.textContent')) {
          return { result: toRemoteValue(opts.elementText || '') }
        }
        if (declaration.includes('el.getBoundingClientRect()')) {
          return { result: toRemoteValue(opts.inspect || null) }
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

const BUTTONS = [
  { ref: 'e0', role: 'button', name: 'Submit' },
  { ref: 'e1', role: 'button', name: 'Cancel order' },
  { ref: 'e2', role: 'link', name: 'Sign in' },
]

describe('browser_verify: element', () => {
  test('a matching element is found', async () => {
    const client = fakeClient({ elements: BUTTONS })
    const provider = providerWith(client)
    const result = await provider.verify('ctx-1', {
      kind: 'element',
      role: 'button',
      name: 'Submit',
    })
    assert.equal(result.ok, true)
    assert.equal(result.verified, true)
    assert.equal(result.ref, 'e0')
  })

  test('a missing element fails the assertion but not the tool', async () => {
    const client = fakeClient({ elements: BUTTONS })
    const provider = providerWith(client)
    const result = await provider.verify('ctx-1', {
      kind: 'element',
      role: 'button',
      name: 'Nonexistent',
    })
    assert.equal(result.ok, true, 'the assertion ran; the tool did not fail')
    assert.equal(result.verified, false)
    assert.ok(result.candidates, 'the near misses are reported')
  })

  test('a partial name still matches', async () => {
    const client = fakeClient({ elements: BUTTONS })
    const provider = providerWith(client)
    const result = await provider.verify('ctx-1', { kind: 'element', name: 'Cancel' })
    assert.equal(result.verified, true)
  })

  test('the role alone is enough', async () => {
    const client = fakeClient({ elements: BUTTONS })
    const provider = providerWith(client)
    const result = await provider.verify('ctx-1', { kind: 'element', role: 'link' })
    assert.equal(result.verified, true)
    assert.equal(result.ref, 'e2')
  })

  test('a kind with no arguments is rejected', async () => {
    const client = fakeClient({ elements: BUTTONS })
    const provider = providerWith(client)
    const result = await provider.verify('ctx-1', { kind: 'element' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid_argument')
  })
})

describe('browser_verify: text', () => {
  test('visible text is found', async () => {
    const client = fakeClient({ texts: ['Welcome back', 'Your orders'] })
    const provider = providerWith(client)
    const result = await provider.verify('ctx-1', { kind: 'text', text: 'welcome back' })
    assert.equal(result.verified, true)
  })

  test('missing text fails the assertion', async () => {
    const client = fakeClient({ texts: ['Welcome back'] })
    const provider = providerWith(client)
    const result = await provider.verify('ctx-1', { kind: 'text', text: 'Goodbye' })
    assert.equal(result.ok, true)
    assert.equal(result.verified, false)
  })

  test('an accessible name counts as visible text', async () => {
    const client = fakeClient({ elements: BUTTONS })
    const provider = providerWith(client)
    const result = await provider.verify('ctx-1', { kind: 'text', text: 'sign in' })
    assert.equal(result.verified, true)
  })

  test('text the snapshot blocks miss is found in the whole page', async () => {
    // The snapshot's text blocks cover BLOCK-level elements only (p, li,
    // headings, table cells…). A page that keeps its content in a <div>
    // produces no block, so the whole visible text is consulted.
    const client = fakeClient({ elements: BUTTONS })
    const provider = providerWith(client)
    provider.text = async () => ({ ok: true, value: 'Welcome back, Ada' })
    const result = await provider.verify('ctx-1', { kind: 'text', text: 'welcome back' })
    assert.equal(result.verified, true)
  })

  test('text that is nowhere on the page fails', async () => {
    const client = fakeClient({ elements: BUTTONS })
    const provider = providerWith(client)
    provider.text = async () => ({ ok: true, value: 'Welcome back, Ada' })
    const result = await provider.verify('ctx-1', { kind: 'text', text: 'Goodbye' })
    assert.equal(result.ok, true)
    assert.equal(result.verified, false)
  })

  test('an empty text is rejected', async () => {
    const client = fakeClient({ texts: ['x'] })
    const provider = providerWith(client)
    const result = await provider.verify('ctx-1', { kind: 'text', text: '' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid_argument')
  })
})

describe('browser_verify: value', () => {
  test('a matching value is verified', async () => {
    const client = fakeClient({ inspect: { type: 'text', name: 'City', value: 'Berlin' } })
    const provider = providerWith(client)
    const result = await provider.verify('ctx-1', {
      kind: 'value',
      ref: 'e0',
      value: 'Berlin',
    })
    assert.equal(result.ok, true)
    assert.equal(result.verified, true)
    assert.equal(result.actual, 'Berlin')
  })

  test('a different value fails the assertion and reports both sides', async () => {
    const client = fakeClient({ inspect: { type: 'text', name: 'City', value: 'Berlin' } })
    const provider = providerWith(client)
    const result = await provider.verify('ctx-1', { kind: 'value', ref: 'e0', value: 'Paris' })
    assert.equal(result.ok, true)
    assert.equal(result.verified, false)
    assert.equal(result.expected, 'Paris')
    assert.equal(result.actual, 'Berlin')
  })

  test('a credential field is refused, not compared', async () => {
    // The page-side guard never lets a credential's value out: the element
    // comes back with an EMPTY value. The plugin must say so plainly rather
    // than report a misleading "expected X, got ''".
    const client = fakeClient({
      inspect: { type: 'password', name: 'Password', value: '', role: '' },
    })
    const provider = providerWith(client)
    const result = await provider.verify('ctx-1', {
      kind: 'value',
      ref: 'e0',
      value: 'hunter2',
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'redacted_value')
  })

  test('a one-time-code field is refused too', async () => {
    const client = fakeClient({
      inspect: { type: 'text', name: '验证码', value: '', role: '' },
    })
    const provider = providerWith(client)
    const result = await provider.verify('ctx-1', { kind: 'value', ref: 'e0', value: '1234' })
    assert.equal(result.code, 'redacted_value')
  })

  test('a missing target is reported', async () => {
    const client = fakeClient({ inspect: null })
    const provider = providerWith(client)
    const result = await provider.verify('ctx-1', { kind: 'value', ref: 'e0', value: 'x' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'element_not_found')
  })

  test('the arguments a kind needs are checked', async () => {
    const client = fakeClient({ inspect: { type: 'text', name: 'City', value: 'Berlin' } })
    const provider = providerWith(client)
    const noTarget = await provider.verify('ctx-1', { kind: 'value', value: 'Berlin' })
    assert.equal(noTarget.code, 'invalid_argument')
    const noExpected = await provider.verify('ctx-1', { kind: 'value', ref: 'e0' })
    assert.equal(noExpected.code, 'invalid_argument')
  })
})

describe('browser_verify: list', () => {
  test('all items present verifies', async () => {
    const client = fakeClient({
      inspect: { type: 'list', name: 'Items', value: '' },
      elementText: 'Apples Bananas Cherries',
    })
    const provider = providerWith(client)
    const result = await provider.verify('ctx-1', {
      kind: 'list',
      ref: 'e0',
      items: ['Apples', 'Cherries'],
    })
    assert.equal(result.verified, true)
    assert.deepEqual(result.matched, ['Apples', 'Cherries'])
    assert.deepEqual(result.missing, [])
  })

  test('a partial match reports what was missing', async () => {
    const client = fakeClient({
      inspect: { type: 'list', name: 'Items', value: '' },
      elementText: 'Apples Bananas',
    })
    const provider = providerWith(client)
    const result = await provider.verify('ctx-1', {
      kind: 'list',
      ref: 'e0',
      items: ['Apples', 'Cherries'],
    })
    assert.equal(result.ok, true)
    assert.equal(result.verified, false)
    assert.deepEqual(result.matched, ['Apples'])
    assert.deepEqual(result.missing, ['Cherries'])
  })

  test('an empty items array is rejected', async () => {
    const client = fakeClient({ elementText: 'x' })
    const provider = providerWith(client)
    const result = await provider.verify('ctx-1', { kind: 'list', ref: 'e0', items: [] })
    assert.equal(result.code, 'invalid_argument')
  })
})

describe('browser_verify: the tool contract', () => {
  test('an unknown kind is rejected', async () => {
    const client = fakeClient({})
    const provider = providerWith(client)
    const result = await provider.verify('ctx-1', { kind: 'colour' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid_argument')
  })

  test('the tool is registered and read-only', async () => {
    const { createTools } = await import('../lib/mcp/tools/index.js')
    const tools = createTools({ provider: {} })
    const tool = tools.find((t) => t.name === 'browser_verify')
    assert.ok(tool, 'browser_verify must be in the catalogue')
    assert.equal(tool.annotations.readOnlyHint, true)
    assert.deepEqual(tool.inputSchema.required, ['kind'])
    assert.deepEqual(tool.inputSchema.properties.kind.enum, ['element', 'text', 'value', 'list'])
    assert.equal(tool.inputSchema.additionalProperties, false)
  })
})
