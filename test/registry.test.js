// test/registry.test.js
// Unit tests for the page-side ref registry.
//
// The registry is what keeps the plugin's bookkeeping out of the page's DOM.
// The invariants that matter: the key is random per session, the property is
// non-enumerable, and nothing in the injected scripts writes an attribute.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  createRegistryKey,
  ensureRegistry,
  clearRegistry,
  frameLabel,
  splitRef,
  isRefShape,
  LOOKUP_ELEMENT,
  ENSURE_REGISTRY_SCRIPT,
  REF_MODE,
} from '../lib/firefox/registry.js'
import { SNAPSHOT_SCRIPT, LEGACY_SNAPSHOT_SCRIPT } from '../lib/firefox/snapshot.js'

describe('registry key', () => {
  test('each session gets its own key', () => {
    const a = createRegistryKey()
    const b = createRegistryKey()
    assert.notEqual(a, b)
  })

  test('the key is prefixed so it is recognisable in a diagnostic', () => {
    assert.ok(createRegistryKey().startsWith('__ffb_'))
  })

  test('the registry property is NOT enumerable', () => {
    // A page that does Object.keys(window) must not see it.
    assert.match(ENSURE_REGISTRY_SCRIPT, /enumerable:\s*false/)
  })

  test('the registry is created with Object.defineProperty', () => {
    assert.match(ENSURE_REGISTRY_SCRIPT, /Object\.defineProperty/)
  })
})

describe('registry lookup', () => {
  test('a ref is looked up in the registry first', () => {
    assert.match(LOOKUP_ELEMENT, /reg\.get\(ref\)/)
  })

  test('a selector is the fallback', () => {
    assert.match(LOOKUP_ELEMENT, /document\.querySelector\(selector\)/)
  })
})

describe('no DOM traces', () => {
  test('the registry snapshot script writes no attribute', () => {
    assert.ok(!SNAPSHOT_SCRIPT.includes('setAttribute'))
    assert.ok(!SNAPSHOT_SCRIPT.includes('data-mavis-ff-ref'))
  })

  test('the registry script reads no marker attribute either', () => {
    assert.ok(!SNAPSHOT_SCRIPT.includes('removeAttribute'))
  })

  test('the attribute fallback still marks elements — that is its only job', () => {
    assert.ok(LEGACY_SNAPSHOT_SCRIPT.includes('setAttribute'))
    assert.ok(LEGACY_SNAPSHOT_SCRIPT.includes('data-mavis-ff-ref') === false)
    assert.match(LEGACY_SNAPSHOT_SCRIPT, /attr/)
  })
})

describe('frame labels', () => {
  test('a frame label is derived from the context id', () => {
    const label = frameLabel('abc12345-6789-0000-1111-222233334444')
    assert.ok(label.startsWith('f'))
    assert.ok(label.length > 1)
    // The same context always gets the same label.
    assert.equal(label, frameLabel('abc12345-6789-0000-1111-222233334444'))
  })

  test('a frame ref splits into its label and its local ref', () => {
    const split = splitRef('f1a2b3c4:e7')
    assert.equal(split.frameLabel, 'f1a2b3c4')
    assert.equal(split.localRef, 'e7')
  })

  test('a top-level ref has no frame label', () => {
    const split = splitRef('e7')
    assert.equal(split.frameLabel, null)
    assert.equal(split.localRef, 'e7')
  })

  test('the ref shape allows a frame prefix but nothing else', () => {
    assert.equal(isRefShape('e7'), true)
    assert.equal(isRefShape('f1a2b3c4:e7'), true)
    assert.equal(isRefShape('div'), false)
    assert.equal(isRefShape('f1a2b3c4:'), false)
  })
})

describe('ensureRegistry', () => {
  test('it reports success when the page accepted the script', async () => {
    const client = { async send() { return {} } }
    assert.equal(await ensureRegistry(client, 'ctx-1', 'k'), true)
  })

  test('it reports failure when the page refuses the script', async () => {
    const client = {
      async send() {
        throw new Error('no such context')
      },
    }
    assert.equal(await ensureRegistry(client, 'ctx-1', 'k'), false)
  })

  test('clearing the registry never throws', async () => {
    const client = {
      async send() {
        throw new Error('gone')
      },
    }
    await clearRegistry(client, 'ctx-1', 'k')
  })
})

describe('ref modes', () => {
  test('the two ref modes are named the way the status reports them', () => {
    assert.equal(REF_MODE.REGISTRY, 'registry')
    assert.equal(REF_MODE.ATTRIBUTE, 'attribute')
  })
})
