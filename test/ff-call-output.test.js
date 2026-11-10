// test/ff-call-output.test.js
// Unit tests for the shell-facing output format.
//
// WHY THIS MATTERS
//
// The fallback path (`tools/ff-call.mjs`) is where an agent talks to this
// plugin when the host does not inject its tools. It already pays a process
// spawn and a JSON-RPC round trip per call — it should not ALSO pay for
// saying the same thing twice.
//
// It used to. The reply's text block and its structured payload were printed
// side by side, and for the twelve legacy tools the text block IS the
// pretty-printed structured payload. A 3.7 KB page text shipped as 15 KB.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { formatToolResult } from '../lib/mcp/ff-output.js'

/**
 * A reply shaped like a LEGACY tool's: the text block carries the same
 * payload as the structured content.
 *
 * @param {object} payload
 * @returns {object} the JSON-RPC reply
 */
function legacyReply(payload) {
  return {
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: false,
    },
  }
}

describe('ff-call output', () => {
  test('the default prints the structured payload', () => {
    const { stdout } = formatToolResult(legacyReply({ ok: true, count: 2, value: 'hello' }))
    const parsed = JSON.parse(stdout)
    assert.deepEqual(parsed, { ok: true, count: 2, value: 'hello' })
  })

  test('a legacy payload is printed ONCE, not twice', () => {
    const marker = 'UNIQUE-PAYLOAD-MARKER'
    const { stdout } = formatToolResult(legacyReply({ ok: true, value: marker }))
    const occurrences = stdout.split(marker).length - 1
    assert.equal(occurrences, 1, `the payload appeared ${occurrences} times — it is duplicated`)
  })

  test('the default output is compact', () => {
    const { stdout } = formatToolResult(legacyReply({ ok: true, value: 'x'.repeat(500) }))
    assert.ok(!stdout.includes('\n'), 'the compact form is one line')
    assert.ok(stdout.length < 600, `the compact form is ${stdout.length} chars`)
  })

  test('--pretty indents the same payload', () => {
    const { stdout } = formatToolResult(legacyReply({ ok: true, value: 'x' }), { pretty: true })
    assert.ok(stdout.includes('\n'), 'the pretty form is indented')
    assert.deepEqual(JSON.parse(stdout), { ok: true, value: 'x' })
  })

  test('--text prints the text block and nothing else', () => {
    const reply = legacyReply({ ok: true, value: 'hello' })
    const { stdout } = formatToolResult(reply, { text: true })
    assert.equal(stdout, reply.result.content[0].text)
    assert.ok(!stdout.includes('"value":"hello"'), 'the summary must not carry the payload')
  })

  test('--raw prints the whole MCP result', () => {
    const reply = legacyReply({ ok: true, value: 'hello' })
    const { stdout } = formatToolResult(reply, { raw: true })
    const parsed = JSON.parse(stdout)
    assert.ok(parsed.content, 'the content blocks are there')
    assert.ok(parsed.structuredContent, 'the structured payload is there')
    assert.equal(parsed.isError, false)
  })

  test('a protocol error is reported as an error', () => {
    const { stdout, exitCode } = formatToolResult({ error: { message: 'method not found' } })
    assert.equal(exitCode, 1)
    assert.deepEqual(JSON.parse(stdout), { ok: false, error: 'method not found' })
  })

  test('a missing reply is reported as an error', () => {
    const { stdout, exitCode } = formatToolResult(null)
    assert.equal(exitCode, 1)
    assert.equal(JSON.parse(stdout).ok, false)
  })

  test('a reply without a structured payload falls back to the text', () => {
    const { stdout } = formatToolResult({
      result: { content: [{ type: 'text', text: 'the summary' }] },
    })
    assert.equal(stdout, 'the summary')
  })

  test('the modes are exclusive', () => {
    const reply = legacyReply({ ok: true, value: 'hello' })
    const text = formatToolResult(reply, { text: true }).stdout
    const raw = formatToolResult(reply, { raw: true }).stdout
    const full = formatToolResult(reply).stdout
    assert.ok(!text.includes('"value":"hello"'), 'the text mode carries no payload')
    assert.ok(raw.includes('"value":"hello"'), 'the raw mode carries the whole result')
    assert.ok(!full.includes('"content"'), 'the default mode is the payload alone')
  })
})
