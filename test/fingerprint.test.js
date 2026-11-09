// test/fingerprint.test.js
// Unit tests for the page fingerprint expression.
//
// The expression is what the browser actually evaluates, so it is tested
// against a fake DOM rather than a mock of the function around it. The
// behaviours that matter:
//
//   - typing into a field CHANGES the fingerprint (this is what makes a
//     typing action report that it had an effect)
//   - an unchanged page keeps the same fingerprint
//   - a password field's value NEVER enters the fingerprint

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { FINGERPRINT_EXPRESSION } from '../lib/firefox/fingerprint.js'

/**
 * A minimal element stand-in.
 *
 * @param {object} opts
 * @returns {object}
 */
function fakeElement(opts = {}) {
  return {
    tagName: opts.tagName || 'INPUT',
    value: opts.value === undefined ? '' : opts.value,
    id: opts.id || '',
    name: opts.name || '',
    getAttribute: (attr) => (attr === 'type' ? opts.type || '' : null),
  }
}

/**
 * Evaluate the fingerprint expression against a fake page.
 *
 * @param {object} opts
 * @returns {{url: string, title: string, fingerprint: string}}
 */
function fingerprintOf(opts = {}) {
  const body = {
    children: opts.children === undefined ? [] : new Array(opts.children).fill({}),
    innerText: opts.innerText || '',
  }
  const document = {
    body,
    title: opts.title || '',
    activeElement: opts.activeElement === undefined ? null : opts.activeElement,
  }
  const location = { href: opts.url || 'https://example.com/' }
  const fn = new Function('document', 'location', `return ${FINGERPRINT_EXPRESSION}`)
  return fn(document, location)
}

describe('page fingerprint', () => {
  test('a page with no focus has a stable fingerprint', () => {
    const a = fingerprintOf({ children: 3, innerText: 'hello' })
    const b = fingerprintOf({ children: 3, innerText: 'hello' })
    assert.equal(a.fingerprint, b.fingerprint)
  })

  test('the body child count is part of the fingerprint', () => {
    const a = fingerprintOf({ children: 3, innerText: 'hello' })
    const b = fingerprintOf({ children: 4, innerText: 'hello' })
    assert.notEqual(a.fingerprint, b.fingerprint)
  })

  test('the visible text length is part of the fingerprint', () => {
    const a = fingerprintOf({ children: 3, innerText: 'hello' })
    const b = fingerprintOf({ children: 3, innerText: 'hello world' })
    assert.notEqual(a.fingerprint, b.fingerprint)
  })

  test('typing into a focused field CHANGES the fingerprint', () => {
    const before = fingerprintOf({
      children: 3,
      innerText: 'hello',
      activeElement: fakeElement({ value: '', id: 'custname' }),
    })
    const after = fingerprintOf({
      children: 3,
      innerText: 'hello',
      activeElement: fakeElement({ value: 'Test User', id: 'custname' }),
    })
    assert.notEqual(
      before.fingerprint,
      after.fingerprint,
      'typing must be observable, otherwise every typing action reports no effect',
    )
  })

  test('focusing a field without typing it also changes the fingerprint', () => {
    const before = fingerprintOf({ children: 3, innerText: 'hello' })
    const after = fingerprintOf({
      children: 3,
      innerText: 'hello',
      activeElement: fakeElement({ value: '', id: 'custname' }),
    })
    assert.notEqual(before.fingerprint, after.fingerprint)
  })

  test('a PASSWORD field value never enters the fingerprint', () => {
    const withPassword = fingerprintOf({
      children: 3,
      innerText: 'hello',
      activeElement: fakeElement({ type: 'password', value: 'hunter2', id: 'pw' }),
    })
    const withoutFocus = fingerprintOf({ children: 3, innerText: 'hello' })
    assert.equal(
      withPassword.fingerprint,
      withoutFocus.fingerprint,
      'a password value must not be folded into the fingerprint',
    )
    assert.ok(!withPassword.fingerprint.includes('hunter2'))
  })

  test('a focused element with no value property contributes nothing', () => {
    // A BUTTON has no `value` property in the DOM, so there is nothing to
    // observe — the fingerprint must stay the same as an unfocused page.
    const button = fakeElement({ tagName: 'BUTTON' })
    delete button.value
    const withButton = fingerprintOf({
      children: 3,
      innerText: 'hello',
      activeElement: button,
    })
    const withoutFocus = fingerprintOf({ children: 3, innerText: 'hello' })
    assert.equal(withButton.fingerprint, withoutFocus.fingerprint)
  })

  test('the url and title travel with the fingerprint', () => {
    const state = fingerprintOf({ url: 'https://example.com/x', title: 'Example' })
    assert.equal(state.url, 'https://example.com/x')
    assert.equal(state.title, 'Example')
  })

  test('a page without a body still produces a fingerprint', () => {
    const document = { body: null, title: '', activeElement: null }
    const location = { href: 'https://example.com/' }
    const fn = new Function('document', 'location', `return ${FINGERPRINT_EXPRESSION}`)
    const state = fn(document, location)
    assert.equal(typeof state.fingerprint, 'string')
    assert.ok(state.fingerprint.length > 0)
  })
})
