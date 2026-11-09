// test/selector.test.js
// Unit tests for the dual ref/selector addressing rules.
//
// `resolveTarget` talks to a BiDi client, so the client is faked here: the
// point of these tests is the addressing POLICY (ref wins, selector is the
// fallback, missing target is an error, a stale ref is reported clearly,
// a frame-scoped ref routes to the frame) — not the transport.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTarget } from '../lib/firefox/selector.js'
import { REF_ATTRIBUTE } from '../lib/firefox/snapshot.js'

/**
 * A fake BiDi client whose `refExists` probe reports the given live refs.
 *
 * @param {string[]} liveRefs
 */
function fakeClient(liveRefs) {
  const live = new Set(liveRefs)
  return {
    send: async (_method, params) => {
      // The probe asks for the element's presence: (key, ref) in registry
      // mode, (attr, ref) in attribute mode.
      const args = params.arguments || []
      const ref = args[1] ? args[1].value : null
      if (ref !== null) {
        return { result: { type: 'boolean', value: live.has(ref) } }
      }
      return { result: { type: 'boolean', value: false } }
    },
  }
}

describe('resolveTarget', () => {
  test('a ref resolves through the registry, not through an attribute', async () => {
    const client = fakeClient(['e3'])
    const result = await resolveTarget(client, {
      ref: 'e3',
      contextId: 'ctx-1',
      key: 'k',
    })
    assert.equal(result.ok, true)
    assert.equal(result.via, 'ref')
    assert.equal(result.ref, 'e3')
    // In registry mode no selector is produced — the element is reached
    // through the page-side map, so there is nothing to select.
    assert.equal(result.selector, undefined)
  })

  test('the attribute fallback still yields an attribute selector', async () => {
    const client = fakeClient(['e3'])
    const result = await resolveTarget(client, {
      ref: 'e3',
      contextId: 'ctx-1',
      legacy: true,
    })
    assert.equal(result.ok, true)
    assert.equal(result.selector, `[${REF_ATTRIBUTE}="e3"]`)
  })

  test('a selector is used as the fallback', async () => {
    const client = fakeClient([])
    const result = await resolveTarget(client, {
      selector: '#submit',
      contextId: 'ctx-1',
    })
    assert.equal(result.ok, true)
    assert.equal(result.via, 'selector')
    assert.equal(result.selector, '#submit')
    assert.equal(result.contextId, 'ctx-1')
  })

  test('the ref takes precedence over the selector and says so', async () => {
    const client = fakeClient(['e7'])
    const result = await resolveTarget(client, {
      ref: 'e7',
      selector: '#ignored',
      contextId: 'ctx-1',
      key: 'k',
    })
    assert.equal(result.ok, true)
    assert.equal(result.via, 'ref')
    assert.equal(result.ref, 'e7')
    assert.equal(result.ignoredSelector, '#ignored')
  })

  test('a stale ref is reported clearly and asks for a fresh snapshot', async () => {
    const client = fakeClient([])
    const result = await resolveTarget(client, {
      ref: 'e9',
      contextId: 'ctx-1',
      key: 'k',
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /no longer exists/)
    assert.equal(result.requiresResnapshot, true)
    assert.match(result.hint, /browser_snapshot/)
  })

  test('neither ref nor selector is an actionable error', async () => {
    const client = fakeClient([])
    const result = await resolveTarget(client, { contextId: 'ctx-1' })
    assert.equal(result.ok, false)
    assert.match(result.error, /no target/)
    assert.match(result.hint, /ref/)
    assert.match(result.hint, /selector/)
  })

  test('a frame-scoped ref routes the action to the frame context', async () => {
    const client = fakeClient(['e7'])
    const frameMap = new Map([['f1a2b3c4', 'frame-ctx-9']])
    const result = await resolveTarget(client, {
      ref: 'f1a2b3c4:e7',
      contextId: 'ctx-1',
      key: 'k',
      frameMap,
    })
    assert.equal(result.ok, true)
    assert.equal(result.ref, 'e7')
    assert.equal(result.contextId, 'frame-ctx-9')
  })

  test('a ref for a frame that is gone asks for a fresh snapshot', async () => {
    const client = fakeClient(['e7'])
    const result = await resolveTarget(client, {
      ref: 'fdeadbeef:e7',
      contextId: 'ctx-1',
      key: 'k',
      frameMap: new Map(),
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /no longer available/)
    assert.equal(result.requiresResnapshot, true)
  })
})
