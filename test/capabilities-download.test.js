// test/capabilities-download.test.js
// The download-event capability gate.
//
// The docs used to claim Firefox 133. That was wrong: Firefox rejects the
// event NAME outright before 144. Measured on FF 140.11.0esr:
//
//   browsingContext.downloadWillBegin is not a valid event name
//
// The release notes put downloadWillBegin in FF 144 and downloadEnd in FF
// 145. This test pins those gates so they cannot drift back.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { FEATURES, expectedFeatures, isAtLeast } from '../lib/firefox/capabilities.js'

describe('download event gates', () => {
  test('downloadWillBegin requires Firefox 144', () => {
    assert.equal(FEATURES.downloadWillBegin.minFirefox, 144)
    assert.equal(isAtLeast('140.11.0esr', FEATURES.downloadWillBegin.minFirefox), false)
    assert.equal(isAtLeast('144.0', FEATURES.downloadWillBegin.minFirefox), true)
  })

  test('downloadEnd requires Firefox 145', () => {
    assert.equal(FEATURES.downloadEnd.minFirefox, 145)
    assert.equal(isAtLeast('144.0', FEATURES.downloadEnd.minFirefox), false)
    assert.equal(isAtLeast('145.0', FEATURES.downloadEnd.minFirefox), true)
  })

  test('Firefox 140 reports both as unavailable', () => {
    const expected = expectedFeatures('140.11.0esr')
    assert.equal(expected.features.downloadWillBegin, false)
    assert.equal(expected.features.downloadEnd, false)
  })

  test('Firefox 144 reports downloadWillBegin but not downloadEnd', () => {
    const expected = expectedFeatures('144.0')
    assert.equal(expected.features.downloadWillBegin, true)
    assert.equal(expected.features.downloadEnd, false)
  })

  test('the old, wrong 133 gate is gone', () => {
    assert.equal(FEATURES.downloadEvents, undefined)
    for (const [name, spec] of Object.entries(FEATURES)) {
      assert.notEqual(spec.minFirefox, 133, `${name} still claims Firefox 133`)
    }
  })
})
