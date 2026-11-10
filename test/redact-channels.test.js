// test/redact-channels.test.js
// Baseline for the free-text redaction rules that the text channels use.
//
// `browser_text` and the snapshot's visible-text blocks are raw page
// content: anything the page chose to print reaches the model verbatim.
// A page that prints a session token into a paragraph should not be able to
// put that token in the model's context, and `redactText` is the rule set
// that decides which shapes are unambiguous enough to replace.
//
// These tests lock the pure rules. The proof that the channels are actually
// WIRED lives in test/integration/browser-firefox-redaction.test.js.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { redactText, REDACTED_PLACEHOLDER } from '../lib/firefox/redact.js'

describe('redaction on the text channels', () => {
  test('a JWT in page text is redacted', () => {
    const out = redactText('token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijk')
    assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'))
    assert.ok(out.includes(REDACTED_PLACEHOLDER))
  })

  test('a Bearer header in page text is redacted', () => {
    const out = redactText('Authorization: Bearer abcdef1234567890')
    assert.ok(!out.includes('abcdef1234567890'))
  })

  test('ordinary page text survives untouched', () => {
    const text = 'The quick brown fox jumps over the lazy dog.'
    assert.equal(redactText(text), text)
  })

  test('a URL in prose keeps its shape', () => {
    const text = 'See https://example.com/docs for details.'
    assert.equal(redactText(text), text)
  })
})
