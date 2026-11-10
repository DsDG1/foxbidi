// test/bidi-protocol.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { unwrapRemoteValue, BidiEvaluateError } from '../lib/bidi/protocol.js'

describe('bidi evaluate exception handling', () => {
  test('an exception response is recognised, not silently dropped', () => {
    const remote = {
      type: 'exception',
      exceptionDetails: { text: 'Error: boom', lineNumber: 0, columnNumber: 13 },
    }
    const out = unwrapRemoteValue(remote)
    assert.equal(out.__exception, true)
    assert.match(out.text, /boom/)
  })

  test('a successful number keeps its value', () => {
    assert.equal(unwrapRemoteValue({ type: 'number', value: 2 }), 2)
  })

  test('a successful string keeps its value', () => {
    assert.equal(unwrapRemoteValue({ type: 'string', value: 'hi' }), 'hi')
  })

  test('the error class carries the page-side text', () => {
    const err = new BidiEvaluateError('Error: boom')
    assert.match(err.message, /boom/)
    assert.equal(err.code, 'evaluate_failed')
  })
})
