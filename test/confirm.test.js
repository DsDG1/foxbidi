// test/confirm.test.js
// Unit tests for the irreversibility gate.
//
// The gate is the plugin's safety boundary, so both directions matter:
// an irreversible action must be blocked WITHOUT confirmation, and must be
// allowed WITH it. A false negative commits an irreversible action; a false
// positive costs one extra flag.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyAction,
  classifyAccountChange,
  classifyImplicitSubmit,
  evaluateGate,
  ACTION_KINDS,
} from '../lib/firefox/confirm.js'

/**
 * Build an element record like the one `inspectElement` returns.
 *
 * @param {object} [overrides]
 */
function info(overrides = {}) {
  return {
    tag: 'button',
    type: '',
    role: '',
    name: '',
    value: '',
    checked: false,
    disabled: false,
    formAction: null,
    formMethod: null,
    isSubmit: false,
    hasDownload: false,
    isFileInput: false,
    ...overrides,
  }
}

describe('classifyAction', () => {
  test('a submit button in a form is a form submit', () => {
    const verdict = classifyAction(
      info({ isSubmit: true, formAction: 'https://example.com/submit', formMethod: 'get' }),
    )
    assert.equal(verdict.irreversible, true)
    assert.equal(verdict.action, ACTION_KINDS.FORM_SUBMIT)
    assert.match(verdict.hint, /submits a form/)
  })

  test('a POST form is a form submit even without an explicit submit control', () => {
    const verdict = classifyAction(
      info({ formAction: 'https://example.com/api', formMethod: 'post' }),
    )
    assert.equal(verdict.irreversible, true)
    assert.equal(verdict.action, ACTION_KINDS.FORM_SUBMIT)
    assert.match(verdict.hint, /POST/)
  })

  test('a download link is a download', () => {
    const verdict = classifyAction(info({ tag: 'a', hasDownload: true }))
    assert.equal(verdict.irreversible, true)
    assert.equal(verdict.action, ACTION_KINDS.DOWNLOAD)
  })

  test('a file input is an upload', () => {
    const verdict = classifyAction(info({ tag: 'input', type: 'file', isFileInput: true }))
    assert.equal(verdict.irreversible, true)
    assert.equal(verdict.action, ACTION_KINDS.UPLOAD)
  })

  test('an ordinary button is NOT irreversible', () => {
    const verdict = classifyAction(info({ name: 'Search' }))
    assert.equal(verdict.irreversible, false)
    assert.equal(verdict.action, null)
  })

  test('a button that merely LOOKS like a purchase is not irreversible', () => {
    // The gate reads DOM facts, never labels — a Chinese site labels a
    // harmless search button 搜索, and a keyword heuristic would break it.
    const verdict = classifyAction(info({ name: 'Buy now', role: 'button' }))
    assert.equal(verdict.irreversible, false)
  })

  test('a submit control with no form is not treated as a submit', () => {
    const verdict = classifyAction(info({ isSubmit: true, formAction: null }))
    assert.equal(verdict.irreversible, false)
  })

  test('a missing element record is not irreversible', () => {
    assert.equal(classifyAction(null).irreversible, false)
    assert.equal(classifyAction(undefined).irreversible, false)
  })
})

describe('classifyAccountChange', () => {
  test('a POST form with credential-ish fields is an account change', () => {
    const verdict = classifyAccountChange(
      info({ formAction: 'https://other.example/login', formMethod: 'post', name: 'password' }),
    )
    assert.equal(verdict.irreversible, true)
    assert.equal(verdict.action, ACTION_KINDS.ACCOUNT_CHANGE)
  })

  test('a same-origin POST form with an innocuous field name is allowed', () => {
    const verdict = classifyAccountChange(
      info({ formAction: 'https://example.com/search', formMethod: 'post', name: 'query' }),
    )
    assert.equal(verdict.irreversible, false)
  })

  test('a GET form is never an account change', () => {
    const verdict = classifyAccountChange(
      info({ formAction: 'https://example.com/x', formMethod: 'get', name: 'password' }),
    )
    assert.equal(verdict.irreversible, false)
  })
})

describe('evaluateGate', () => {
  const irreversible = info({
    isSubmit: true,
    formAction: 'https://example.com/submit',
    formMethod: 'post',
  })

  test('an irreversible action is blocked without confirmation', () => {
    const verdict = evaluateGate({ info: irreversible })
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.requiresConfirm, true)
    assert.equal(verdict.action, ACTION_KINDS.FORM_SUBMIT)
    assert.match(verdict.error, /irreversible/)
  })

  test('an irreversible action is allowed with confirm: true', () => {
    const verdict = evaluateGate({ info: irreversible, confirm: true })
    assert.equal(verdict.allowed, true)
  })

  test('confirm: false is not a confirmation', () => {
    const verdict = evaluateGate({ info: irreversible, confirm: false })
    assert.equal(verdict.allowed, false)
  })

  test('a harmless action is allowed without confirmation', () => {
    const verdict = evaluateGate({ info: info({ name: 'Search' }) })
    assert.equal(verdict.allowed, true)
  })

  test('the blocked verdict carries an actionable hint', () => {
    const verdict = evaluateGate({ info: irreversible })
    assert.ok(verdict.hint)
    assert.match(verdict.hint, /example\.com/)
  })
})

describe('implicit form submits', () => {
  // Enter in a field, a <select> change and a radio toggle can all submit
  // a form. Before this classifier existed, those three paths walked past
  // the gate entirely — the agent could be blocked on `click` and then
  // simply press Enter instead.

  test('a control in no form is never irreversible', () => {
    // The common case on the web, and the reason this rule produces
    // almost no false positives.
    const verdict = classifyImplicitSubmit(info({ formAction: null }))
    assert.equal(verdict.irreversible, false)
  })

  test('a control in a form with a submit control is irreversible', () => {
    // Enter activates the form's submit button in standard HTML.
    const verdict = classifyImplicitSubmit(
      info({
        formAction: 'https://example.com/submit',
        formMethod: 'get',
        formHasSubmitControl: true,
      }),
    )
    assert.equal(verdict.irreversible, true)
    assert.equal(verdict.action, ACTION_KINDS.FORM_SUBMIT)
  })

  test('a control in a POST form is irreversible even without a submit control', () => {
    const verdict = classifyImplicitSubmit(
      info({
        formAction: 'https://example.com/submit',
        formMethod: 'post',
        formHasSubmitControl: false,
      }),
    )
    assert.equal(verdict.irreversible, true)
    assert.equal(verdict.action, ACTION_KINDS.FORM_SUBMIT)
  })

  test('a submit control itself is irreversible', () => {
    const verdict = classifyImplicitSubmit(
      info({
        formAction: 'https://example.com/submit',
        formMethod: 'get',
        isSubmit: true,
      }),
    )
    assert.equal(verdict.irreversible, true)
  })

  test('a control in a form with NO submit control is not irreversible', () => {
    // A GET form with no submit control: pressing Enter does nothing
    // irreversible.
    const verdict = classifyImplicitSubmit(
      info({
        formAction: 'https://example.com/search',
        formMethod: 'get',
        formHasSubmitControl: false,
      }),
    )
    assert.equal(verdict.irreversible, false)
  })

  test('the implicit check does not fire unless it is asked for', () => {
    const target = info({
      formAction: 'https://example.com/submit',
      formMethod: 'get',
      formHasSubmitControl: true,
    })
    // Without `implicit`, the ordinary classification stands.
    assert.equal(evaluateGate({ info: target }).allowed, true)
    // With it, the implicit submit is caught.
    assert.equal(evaluateGate({ info: target, implicit: true }).allowed, false)
  })

  test('the implicit check is bypassed by confirm: true', () => {
    const target = info({
      formAction: 'https://example.com/submit',
      formMethod: 'get',
      formHasSubmitControl: true,
    })
    const verdict = evaluateGate({ info: target, implicit: true, confirm: true })
    assert.equal(verdict.allowed, true)
  })

  test('the refusal has the same shape as every other refusal', () => {
    // The agent branches on this, so the shape must not vary by which
    // action tripped the gate.
    const target = info({
      formAction: 'https://example.com/submit',
      formMethod: 'get',
      formHasSubmitControl: true,
    })
    const verdict = evaluateGate({ info: target, implicit: true })
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.action, 'form_submit')
    assert.equal(verdict.requiresConfirm, true)
    assert.equal(verdict.code, 'confirm_required')
    assert.ok(verdict.hint)
  })
})
