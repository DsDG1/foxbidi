// test/mcp-schema-output.test.js
// Unit tests for the declared output-schema contract and the text-block
// summary.
//
// The point of these tests is the CONTRACT between what a tool declares and
// what it actually returns. An output schema DESCRIBES a payload; it must
// never reject it. Constraining an array to `items: {type:'object'}` when
// the payload carries strings made the host refuse the whole call with
// `-32602`, so the default is now "no item constraint" and a tool that
// wants precision declares the item type itself.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { outputSchema, summarize, summarizeCaptcha } from '../lib/mcp/schema.js'

describe('outputSchema', () => {
  test('an array property constrains nothing by default', () => {
    const schema = outputSchema({ properties: { elements: { type: 'array' } } })
    assert.equal(schema.properties.elements.type, 'array')
    // No `items`: JSON Schema reads a missing item schema as "any element
    // type", so the payload is never rejected for being the wrong shape.
    assert.equal(schema.properties.elements.items, undefined)
  })

  test('an explicit item type is honoured', () => {
    const schema = outputSchema({
      properties: { names: { type: 'array', items: { type: 'string' } } },
    })
    assert.equal(schema.properties.names.items.type, 'string')
  })

  test('ok is always declared and always required', () => {
    const schema = outputSchema()
    assert.equal(schema.properties.ok.type, 'boolean')
    assert.deepEqual(schema.required, ['ok'])
  })

  test('a non-array property declares no item schema', () => {
    const schema = outputSchema({ properties: { count: { type: 'number' } } })
    assert.equal(schema.properties.count.items, undefined)
  })

  test('an object property stays permissive', () => {
    const schema = outputSchema({ properties: { effect: { type: 'object' } } })
    assert.equal(schema.properties.effect.additionalProperties, true)
  })
})

describe('summarize', () => {
  test('an element list is rendered inline with its refs', () => {
    const text = summarize({
      ok: true,
      count: 2,
      elements: [
        { ref: 'e0', role: 'button', name: 'Submit' },
        { ref: 'e1', role: 'textbox', name: 'Email' },
      ],
    })
    assert.match(text, /e0 button "Submit"/)
    assert.match(text, /e1 textbox "Email"/)
  })

  test('a long element list is truncated and says so', () => {
    const elements = Array.from({ length: 40 }, (_, i) => ({
      ref: `e${i}`,
      role: 'link',
      name: `Item ${i}`,
    }))
    const text = summarize({ ok: true, count: 40, elements })
    assert.match(text, /\+28 more/)
    assert.ok(text.length < 1200, `summary is ${text.length} chars — too long`)
  })

  test('a request list is rendered inline with method, url and status', () => {
    const text = summarize({
      ok: true,
      count: 1,
      requests: [{ seq: 1, method: 'GET', url: 'https://example.com/', status: 200 }],
    })
    assert.match(text, /GET https:\/\/example\.com\/ 200/)
  })

  test('an empty payload adds nothing', () => {
    const text = summarize({ ok: true, count: 0, elements: [], requests: [] })
    assert.equal(text, 'count 0')
  })

  test('a failure keeps its actionable error and hint', () => {
    const text = summarize({
      ok: false,
      error: 'this action is irreversible (form_submit) and needs explicit confirmation',
      hint: 'this submits a form to https://example.com/pay (POST)',
      requiresConfirm: true,
    })
    assert.match(text, /form_submit/)
    assert.match(text, /confirm: true/)
  })

  test('an explicit summary overrides the default rendering', () => {
    assert.equal(summarize({ ok: true, count: 5 }, { summary: 'custom' }), 'custom')
  })

  test('the text block stays small for a payload with no arrays', () => {
    const text = summarize({ ok: true, contextId: 'abcdef1234567890', count: 12, total: 12 })
    assert.ok(text.length < 400, `text block is ${text.length} chars — too long`)
  })

  test('a failure that reports a message instead of an error keeps the message', () => {
    // The CAPTCHA solvers report an OUTCOME, not an exception. Falling back to
    // the generic sentence would tell the agent "the browser operation
    // failed" for a page that simply has no challenge.
    const text = summarize({
      ok: false,
      status: 'not_detected',
      message: 'No supported CAPTCHA challenge found on this page.',
    })
    assert.match(text, /No supported CAPTCHA challenge found on this page\./)
    assert.doesNotMatch(text, /the browser operation failed/)
  })

  test('a failure leads with its status', () => {
    const text = summarize({
      ok: false,
      status: 'stt_unavailable',
      message: 'This challenge needs speech-to-text.',
    })
    assert.match(text, /^stt_unavailable/)
    assert.match(text, /needs speech-to-text/)
  })

  test('a success carries its status', () => {
    const text = summarize({ ok: true, status: 'solved', tokenLength: 42 })
    assert.match(text, /solved/)
  })

  test('the existing payload shapes render exactly as before', () => {
    // The guard for every other tool: the shared summarizer may only grow in
    // fields nobody else uses.
    assert.equal(summarize({ ok: true, count: 0, elements: [], requests: [] }), 'count 0')
    const failure = summarize({
      ok: false,
      error: 'this action is irreversible (form_submit) and needs explicit confirmation',
      hint: 'this submits a form to https://example.com/pay (POST)',
      requiresConfirm: true,
    })
    assert.match(failure, /^this action is irreversible/)
    assert.match(failure, /hint|POST/)
    assert.match(failure, /confirm: true/)
  })
})

describe('summarizeCaptcha', () => {
  test('a solved challenge reports the solver and the token', () => {
    const text = summarizeCaptcha({
      ok: true,
      status: 'solved',
      solver: 'turnstile',
      tokenLength: 42,
      contextId: '988fe195-264b-4d52-a385-7b0cacb6a74c',
    })
    assert.match(text, /solved/)
    assert.match(text, /turnstile/)
    assert.match(text, /token 42 chars/)
    assert.match(text, /context 988fe195/)
  })

  test('a page without a challenge says so, and keeps the guidance', () => {
    const text = summarizeCaptcha({
      ok: false,
      status: 'not_detected',
      detected: [],
      message: 'No supported CAPTCHA challenge found on this page.',
      contextId: '988fe195-264b-4d52-a385-7b0cacb6a74c',
    })
    assert.match(text, /not_detected/)
    assert.match(text, /No supported CAPTCHA challenge found on this page\./)
    assert.doesNotMatch(text, /the browser operation failed/)
  })

  test('an auto run that failed lists every attempt', () => {
    const text = summarizeCaptcha({
      ok: false,
      status: 'solve_failed',
      detected: ['turnstile', 'geetest'],
      attempts: [
        { solver: 'turnstile', status: 'checkbox_not_found', ok: false },
        { solver: 'geetest', status: 'drag_rejected', ok: false },
      ],
      message: 'A challenge was found but could not be solved.',
    })
    assert.match(text, /solve_failed/)
    assert.match(text, /detected turnstile, geetest/)
    assert.match(text, /turnstile: checkbox_not_found/)
    assert.match(text, /geetest: drag_rejected/)
    assert.match(text, /could not be solved/)
  })

  test('an attempt without a status falls back to solved or failed', () => {
    const text = summarizeCaptcha({
      ok: false,
      status: 'solve_failed',
      attempts: [
        { solver: 'turnstile', ok: true },
        { solver: 'pow', ok: false },
      ],
    })
    assert.match(text, /turnstile: solved/)
    assert.match(text, /pow: failed/)
  })

  test('the status tool says whether the challenge is solved', () => {
    const notSolved = summarizeCaptcha({
      ok: true,
      solved: false,
      tokenLength: 0,
      contextId: '988fe195-264b-4d52-a385-7b0cacb6a74c',
    })
    assert.match(notSolved, /not solved/)
    assert.match(notSolved, /token 0 chars/)

    const solved = summarizeCaptcha({ ok: true, solved: true, tokenLength: 42 })
    assert.match(solved, /^solved/)
    assert.match(solved, /token 42 chars/)
  })

  test('a payload without fields still renders something', () => {
    assert.equal(summarizeCaptcha({ ok: true }), 'ok')
    assert.equal(summarizeCaptcha({ ok: false }), 'failed')
  })

  test('a missing payload does not throw', () => {
    // The text block is part of the tool result: throwing here would fail
    // the whole call.
    assert.equal(typeof summarizeCaptcha(null), 'string')
    assert.equal(typeof summarizeCaptcha(undefined), 'string')
    assert.equal(typeof summarizeCaptcha('nope'), 'string')
  })

  test('the text block stays small', () => {
    const text = summarizeCaptcha({
      ok: false,
      status: 'solve_failed',
      detected: ['turnstile'],
      attempts: [{ solver: 'turnstile', status: 'checkbox_not_found', ok: false }],
      message: 'A challenge was found but could not be solved.',
    })
    assert.ok(text.length < 200, `text block is ${text.length} chars — too long`)
  })
})
