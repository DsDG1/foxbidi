// test/evaluate-limits.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MAX_EVALUATE_CHARS } from '../lib/firefox/provider/constants.js'

describe('evaluate output limits', () => {
  test('the default cap is 8KB', () => {
    assert.equal(DEFAULT_MAX_EVALUATE_CHARS, 8192)
  })

  test('the cap is large enough for a typical page text', () => {
    assert.ok(DEFAULT_MAX_EVALUATE_CHARS >= 4096)
  })
})
