// test/snapshot.test.js
// Unit tests for the ARIA-style snapshot helpers.
//
// The role/name computation itself lives inside the injected script, so the
// DOM-facing behaviour is covered by the integration tests. What is unit
// tested here is everything that runs in Node: the ref helpers, the
// attribute naming, and the invariants the script relies on.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  REF_ATTRIBUTE,
  DEFAULT_MAX_ELEMENTS,
  MAX_ELEMENTS_LIMIT,
  SNAPSHOT_SCRIPT,
  LEGACY_SNAPSHOT_SCRIPT,
  refSelector,
  isRefShape,
} from '../lib/firefox/snapshot.js'

describe('snapshot helpers', () => {
  test('the ref attribute is plugin-prefixed to avoid colliding with page attributes', () => {
    assert.match(REF_ATTRIBUTE, /^data-/)
    assert.ok(REF_ATTRIBUTE.includes('ff-ref'))
    assert.notEqual(REF_ATTRIBUTE, 'data-ffb-ref')
  })

  test('refSelector builds an attribute selector', () => {
    assert.equal(refSelector('e7'), `[${REF_ATTRIBUTE}="e7"]`)
  })

  test('refSelector escapes quotes so a hostile ref cannot break out', () => {
    const selector = refSelector('e7" onload="alert(1)')
    assert.ok(!selector.includes('" onload="'))
    assert.ok(selector.includes('\\"'))
  })

  test('isRefShape accepts only the ref format this plugin issues', () => {
    assert.equal(isRefShape('e0'), true)
    assert.equal(isRefShape('e42'), true)
    assert.equal(isRefShape('e'), false)
    assert.equal(isRefShape('e1x'), false)
    assert.equal(isRefShape('.button'), false)
    assert.equal(isRefShape('#id'), false)
    assert.equal(isRefShape(42), false)
    assert.equal(isRefShape(null), false)
    assert.equal(isRefShape(undefined), false)
  })

  test('isRefShape accepts a frame-scoped ref', () => {
    assert.equal(isRefShape('f1a2b3c4:e7'), true)
    assert.equal(isRefShape('f1a2b3c4:'), false)
  })

  test('the injected script is a self-contained function expression', () => {
    assert.ok(SNAPSHOT_SCRIPT.trim().startsWith('(key, offset, limit'))
  })

  test('the injected script never reads a password field value', () => {
    // The value read must be guarded by the password role — a leaked
    // password would be a serious defect, so the guard is asserted
    // explicitly rather than left to inspection.
    assert.ok(
      SNAPSHOT_SCRIPT.includes("role !== 'password'"),
      'the value read is not guarded by the password role',
    )
    // The guard only means something if password inputs really do get that
    // role — otherwise it would be vacuously true.
    assert.ok(
      SNAPSHOT_SCRIPT.includes("return 'password'"),
      'password inputs are not assigned the password role',
    )
  })

  test('the registry script writes NOTHING into the DOM', () => {
    // This is the whole point of the registry: a page must not be able to
    // find the plugin's bookkeeping by looking at the markup.
    assert.ok(
      !SNAPSHOT_SCRIPT.includes('setAttribute'),
      'the registry snapshot script must not set attributes',
    )
    assert.ok(
      !SNAPSHOT_SCRIPT.includes(REF_ATTRIBUTE),
      'the registry snapshot script must not mention the marker attribute',
    )
  })

  test('the registry script pierces open shadow roots', () => {
    assert.ok(SNAPSHOT_SCRIPT.includes('shadowRoot'), 'shadow roots are not walked')
  })

  test('the registry script applies the offset in the page', () => {
    // The old script stopped after 300 candidates, so everything past the
    // 300th element was unreachable no matter what offset was asked for.
    assert.ok(SNAPSHOT_SCRIPT.includes('matched.slice(start, start + cap)'))
    assert.ok(SNAPSHOT_SCRIPT.includes('const total = matched.length'))
  })

  test('the attribute fallback still clears stale markers', () => {
    assert.ok(LEGACY_SNAPSHOT_SCRIPT.includes('removeAttribute'))
    assert.ok(LEGACY_SNAPSHOT_SCRIPT.includes('stale'))
  })

  test('the default element cap is a positive number', () => {
    assert.ok(DEFAULT_MAX_ELEMENTS > 0)
    assert.equal(typeof DEFAULT_MAX_ELEMENTS, 'number')
  })

  test('the element cap has a ceiling', () => {
    assert.ok(MAX_ELEMENTS_LIMIT > DEFAULT_MAX_ELEMENTS)
  })
})
