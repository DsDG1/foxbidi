// test/captcha-pow.test.js
// The proof-of-work solver (ALTCHA / Cap / Anubis / Friendly Captcha).
//
// Proof-of-work challenges are the easiest kind to automate honestly: the
// page itself runs the hash search, and all the solver has to do is nudge the
// widget and wait for the token. So these tests drive a fake BiDi client and
// assert the solver never invents a token it did not read from the page.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { solvePow } from '../lib/firefox/captcha/pow.js'

/**
 * A fake BiDi client that models a proof-of-work widget.
 *
 * @param {object} opts
 * @returns {object}
 */
function fakeClient(opts = {}) {
  const calls = []
  let clicked = false
  return {
    calls,
    async send(method, params) {
      calls.push({ method, params })
      if (method !== 'script.evaluate') return { result: { type: 'null', value: null } }

      const expression = params.expression
      if (expression.includes('.altcha-checkbox')) {
        // The widget start button.
        clicked = true
        return { result: { type: 'boolean', value: true } }
      }
      if (expression.includes('SELECTORS')) {
        // The token read. The widget only produces one after it was clicked.
        if (clicked || opts.autoStart) {
          return {
            result: {
              type: 'object',
              value: [
                ['ok', { type: 'boolean', value: true }],
                ['token', { type: 'string', value: 'pow-token-1234' }],
                ['source', { type: 'string', value: 'input[name=altcha]' }],
              ],
            },
          }
        }
        return { result: { type: 'object', value: [['ok', { type: 'boolean', value: false }]] } }
      }
      return { result: { type: 'null', value: null } }
    },
  }
}

const CHALLENGE = { tokenSelector: '[name="altcha"], [name="pow"], input[name="payload"]' }

describe('solvePow', () => {
  test('clicks the widget and returns the token the page produced', async () => {
    const client = fakeClient()
    const result = await solvePow({
      client,
      contextId: 'ctx-1',
      topContextId: 'ctx-0',
      challenge: CHALLENGE,
      closedRootProp: '__captcha_closed_root',
      timeoutMs: 5000,
    })

    assert.equal(result.ok, true, `the challenge should have been solved: ${result.message}`)
    assert.equal(result.status, 'solved')
    assert.equal(result.via, 'proof-of-work')
    assert.equal(result.tokenLength, 'pow-token-1234'.length)
  })

  test('solves a widget that starts on its own', async () => {
    const client = fakeClient({ autoStart: true })
    const result = await solvePow({
      client,
      contextId: 'ctx-1',
      topContextId: 'ctx-0',
      challenge: CHALLENGE,
      closedRootProp: '__captcha_closed_root',
      timeoutMs: 5000,
    })
    assert.equal(result.ok, true)
  })

  test('times out instead of pretending to have solved it', async () => {
    const client = {
      calls: [],
      async send(method, params) {
        this.calls.push({ method, params })
        return { result: { type: 'boolean', value: false } }
      },
    }

    const result = await solvePow({
      client,
      contextId: 'ctx-1',
      topContextId: 'ctx-0',
      challenge: CHALLENGE,
      closedRootProp: '__captcha_closed_root',
      timeoutMs: 50,
    })

    assert.equal(result.ok, false, 'a timeout must never be reported as success')
    assert.equal(result.status, 'pow_timeout')
    assert.match(result.message, /token/)
  })
})
