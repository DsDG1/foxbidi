// test/visibility.test.js
// The L0 fact layer: render facts about content a human cannot see.
//
// This layer does not judge content — it reports what the page PAINTED.
// The tests here lock the classification vocabulary, because the verdict
// (whether a fact is worth a warning) belongs to a different layer and
// depends on these reason codes being exactly right.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  HIDDEN_REASON_CODES,
  classifyHiddenReasons,
  VISIBILITY_SCRIPT,
} from '../lib/firefox/visibility.js'

describe('hidden reason classification', () => {
  test('every reason code is known', () => {
    for (const code of [
      'display_visibility',
      'opacity_zero',
      'offscreen',
      'tiny_font',
      'clip_rect',
      'clip_path',
      'color_transparent',
      'color_equals_background',
    ]) {
      assert.ok(HIDDEN_REASON_CODES.has(code), `unknown reason code: ${code}`)
    }
  })

  test('an offscreen reason means hidden', () => {
    const out = classifyHiddenReasons(['offscreen'])
    assert.equal(out.hidden, true)
    assert.equal(out.ariaHidden, false)
  })

  test('aria-hidden alone does not mean hidden', () => {
    const out = classifyHiddenReasons(['aria_hidden'])
    assert.equal(out.hidden, false)
    assert.equal(out.ariaHidden, true)
  })

  test('an empty reason list means neither', () => {
    const out = classifyHiddenReasons([])
    assert.equal(out.hidden, false)
    assert.equal(out.ariaHidden, false)
  })

  test('several reasons still classify as hidden', () => {
    const out = classifyHiddenReasons(['opacity_zero', 'clip_rect'])
    assert.equal(out.hidden, true)
  })
})

describe('the page-side visibility script', () => {
  test('the script survives as raw text with its regex escapes intact', () => {
    // A normal template literal would turn `\s` into `s` and break every
    // regex in the script. `String.raw` is what keeps them.
    assert.ok(VISIBILITY_SCRIPT.includes('\\s'), 'the raw backslash-escapes must survive')
    assert.ok(VISIBILITY_SCRIPT.length > 1000, 'the script must not be truncated')
  })

  test('the script is a self-invoking function expression', () => {
    assert.match(VISIBILITY_SCRIPT, /^\s*\(/)
    assert.match(VISIBILITY_SCRIPT, /return out\b/)
  })

  test('the script reports the three buckets L2 expects', () => {
    assert.ok(VISIBILITY_SCRIPT.includes('hidden: []'))
    assert.ok(VISIBILITY_SCRIPT.includes('ariaHidden: []'))
    assert.ok(VISIBILITY_SCRIPT.includes('named: []'))
  })

  test('the script never removes content from the page', () => {
    // The fact layer only observes. A script that deleted what it found
    // would break real sites, which is why deletion is explicitly absent.
    for (const forbidden of ['remove()', 'removeChild', 'innerHTML =', 'textContent =']) {
      assert.ok(!VISIBILITY_SCRIPT.includes(forbidden), `the script must not contain ${forbidden}`)
    }
  })

  test('content below the fold is not treated as hidden', () => {
    // A human scrolls to it; calling that "hidden" would flag every long
    // page on the web. The rule is "outside the window in a direction a
    // human cannot scroll to" — above, left or right.
    assert.ok(!VISIBILITY_SCRIPT.includes('belowFold'))
    assert.ok(VISIBILITY_SCRIPT.includes('rect.bottom <= 0'))
    assert.ok(VISIBILITY_SCRIPT.includes('rect.left >= vw'))
  })

  test('the script computes one style lookup per element', () => {
    // The colour is read from the style object the caller already has.
    // A second lookup for the same element doubled the cost of the scan.
    assert.ok(VISIBILITY_SCRIPT.includes('const effectiveColor = (s)'))
    assert.ok(!VISIBILITY_SCRIPT.includes('effectiveColor(el)'))
  })

  test('the script caches the effective background', () => {
    // A flat page made the old script walk the whole ancestor chain for
    // every element. The cache makes it one lookup.
    assert.ok(VISIBILITY_SCRIPT.includes('bgCache'))
  })
})
