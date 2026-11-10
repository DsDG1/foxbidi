// test/find.test.js
// Searching the page.
//
// browser_find answers "where is the thing that says X?" and reports the
// two kinds of hit SEPARATELY: an element hit carries a ref the agent can
// act on, a text hit is prose. Reporting them together would blur that,
// and the agent would try to click a paragraph.
//
// The other thing this file guards is the NEIGHBOURHOOD: a flat element
// list has no tree path, so the neighbours are what tells the agent what
// the match sits near.

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

const PAGE = [
  { ref: 'e0', role: 'heading', name: 'Account' },
  { ref: 'e1', role: 'textbox', name: 'Email' },
  { ref: 'e2', role: 'button', name: 'Sign in' },
  { ref: 'e3', role: 'link', name: 'Forgot password' },
  { ref: 'e4', role: 'button', name: 'Cancel' },
]

/**
 * A fake BiDi client.
 *
 * @param {object} opts
 * @param {object[]} [opts.elements] the snapshot elements
 * @param {string} [opts.pageText]    the visible text of the page
 */
function fakeClient(opts = {}) {
  return {
    async send(method, params) {
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
            }),
          }
        }
        return { result: { type: 'boolean', value: true } }
      }
      return {}
    },
  }
}

/**
 * A provider wired to a fake client.
 *
 * @param {object} client
 * @param {string} [pageText] the visible text the page reports
 */
function providerWith(client, pageText = '') {
  const provider = new FirefoxProvider({ copyBaseDir: '/tmp/ffb-test' })
  provider.client = client
  provider.state = 'ready'
  provider._ensureReady = async () => true
  provider._resolveContext = async (id) => id || 'ctx-1'
  provider.text = async () => ({ ok: true, value: pageText })
  return provider
}

describe('browser_find', () => {
  test('a matching element is found, case-insensitively', async () => {
    const provider = providerWith(fakeClient({ elements: PAGE }), '')
    const result = await provider.find('ctx-1', { text: 'sign in' })
    assert.equal(result.ok, true)
    assert.equal(result.elementCount, 1)
    assert.equal(result.elements[0].ref, 'e2')
    assert.equal(result.elements[0].role, 'button')
    assert.equal(result.elements[0].name, 'Sign in')
  })

  test('a match carries its neighbours', async () => {
    const provider = providerWith(fakeClient({ elements: PAGE }), '')
    const result = await provider.find('ctx-1', { text: 'sign in', context: 1 })
    assert.deepEqual(
      result.elements[0].before.map((e) => e.ref),
      ['e1'],
    )
    assert.deepEqual(
      result.elements[0].after.map((e) => e.ref),
      ['e3'],
    )
  })

  test('the neighbourhood is capped', async () => {
    const provider = providerWith(fakeClient({ elements: PAGE }), '')
    const result = await provider.find('ctx-1', { text: 'sign in', context: 99 })
    assert.ok(result.elements[0].before.length <= 10)
    assert.ok(result.elements[0].after.length <= 10)
  })

  test('a neighbour carries only ref, role and name', async () => {
    const provider = providerWith(fakeClient({ elements: PAGE }), '')
    const result = await provider.find('ctx-1', { text: 'sign in' })
    for (const el of result.elements[0].before.concat(result.elements[0].after)) {
      assert.deepEqual(Object.keys(el).sort(), ['name', 'ref', 'role'])
    }
  })

  test('element hits and text hits are reported apart', async () => {
    const provider = providerWith(
      fakeClient({ elements: PAGE }),
      'Please sign in to continue\nWelcome back',
    )
    const result = await provider.find('ctx-1', { text: 'sign in' })
    assert.equal(result.elementCount, 1)
    assert.equal(result.textCount, 1, 'only the line that matches counts')
    assert.equal(result.elements[0].ref, 'e2')
    assert.ok(result.texts.every((t) => typeof t === 'string'))
    assert.ok(!result.texts.some((t) => t.includes('e2')))
  })

  test('prose that is not an element still matches', async () => {
    const provider = providerWith(fakeClient({ elements: PAGE }), 'Only prose here')
    const result = await provider.find('ctx-1', { text: 'prose' })
    assert.equal(result.elementCount, 0)
    assert.equal(result.textCount, 1)
    assert.equal(result.verified, undefined)
    assert.equal(result.ok, true)
  })

  test('nothing found is a successful search', async () => {
    const provider = providerWith(fakeClient({ elements: PAGE }), 'nothing here')
    const result = await provider.find('ctx-1', { text: 'absent' })
    assert.equal(result.ok, true)
    assert.equal(result.total, 0)
    assert.deepEqual(result.elements, [])
    assert.deepEqual(result.texts, [])
  })

  test('maxResults caps the hits', async () => {
    const provider = providerWith(fakeClient({ elements: PAGE }), '')
    const result = await provider.find('ctx-1', { text: 'o', maxResults: 1 })
    assert.ok(result.elements.length <= 1)
  })

  test('an empty query is rejected', async () => {
    const provider = providerWith(fakeClient({ elements: PAGE }), '')
    const result = await provider.find('ctx-1', { text: '  ' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid_argument')
  })

  test('the tool is registered and read-only', async () => {
    const { createTools } = await import('../lib/mcp/tools/index.js')
    const tools = createTools({ provider: {} })
    const tool = tools.find((t) => t.name === 'browser_find')
    assert.ok(tool, 'browser_find must be in the catalogue')
    assert.equal(tool.annotations.readOnlyHint, true)
    assert.deepEqual(tool.inputSchema.required, ['text'])
    assert.equal(tool.inputSchema.additionalProperties, false)
  })
})
