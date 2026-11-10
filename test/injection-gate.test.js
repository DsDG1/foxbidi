// test/injection-gate.test.js
// The L3 hard block.
//
// THE TEST THIS FILE EXISTS FOR: a hijacked agent must not be able to
// release the block by adding `confirm: true`. The existing irreversibility
// gate asks for a flag the AGENT supplies, so it stops mistakes but not a
// hijacked agent. This gate is the one that stops a hijacked agent, and it
// works precisely because it ignores that flag.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateInjectionGate,
  injectionGateMode,
  hasHighSeverityWarning,
  INJECTION_GATE_MODE,
  EGRESS_ACTIONS,
} from '../lib/firefox/injection-gate.js'

const HIGH_WARNING = {
  code: 'hidden_injection',
  severity: 'high',
  hiddenReasons: ['offscreen'],
  injectionSignals: ['instruction_reset'],
  excerpt: 'ignore all previous instructions',
}

describe('the injection gate', () => {
  test('the default mode is strict', () => {
    assert.equal(injectionGateMode({}), INJECTION_GATE_MODE.STRICT)
  })

  test('an explicit off mode is honoured', () => {
    assert.equal(
      injectionGateMode({ FIREFOX_BROWSER_INJECTION_GATE: 'off' }),
      INJECTION_GATE_MODE.OFF,
    )
  })

  test('a form submit on a warned page is blocked', () => {
    const out = evaluateInjectionGate({ warnings: [HIGH_WARNING], action: 'form_submit' })
    assert.equal(out.allowed, false)
    assert.equal(out.code, 'injection_blocked')
  })

  test('CONFIRM DOES NOT UNBLOCK — the core invariant', () => {
    const out = evaluateInjectionGate({
      warnings: [HIGH_WARNING],
      action: 'form_submit',
      confirm: true,
    })
    assert.equal(out.allowed, false, 'confirm:true must not release a hard block')
    assert.equal(out.code, 'injection_blocked')
  })

  test('every data-egress action is blocked', () => {
    for (const action of [
      'form_submit',
      'account_change',
      'upload',
      'download',
      'cookie_set',
      'extension_install',
    ]) {
      const out = evaluateInjectionGate({ warnings: [HIGH_WARNING], action })
      assert.equal(out.allowed, false, `${action} must be blocked`)
      assert.equal(out.code, 'injection_blocked')
    }
  })

  test('reading is never blocked', () => {
    for (const action of ['snapshot', 'text', 'logs', 'network']) {
      const out = evaluateInjectionGate({ warnings: [HIGH_WARNING], action })
      assert.equal(out.allowed, true, `${action} must not be blocked`)
    }
  })

  test('a non-egress action is not blocked', () => {
    const out = evaluateInjectionGate({ warnings: [HIGH_WARNING], action: 'click' })
    assert.equal(out.allowed, true)
  })

  test('a medium warning does not block', () => {
    const out = evaluateInjectionGate({
      warnings: [{ code: 'aria_hidden_injection', severity: 'medium' }],
      action: 'form_submit',
    })
    assert.equal(out.allowed, true)
  })

  test('no warnings means no block', () => {
    const out = evaluateInjectionGate({ warnings: [], action: 'form_submit' })
    assert.equal(out.allowed, true)
  })

  test('mode off disables the block', () => {
    const out = evaluateInjectionGate({
      warnings: [HIGH_WARNING],
      action: 'form_submit',
      mode: INJECTION_GATE_MODE.OFF,
    })
    assert.equal(out.allowed, true)
  })

  test('the block error tells the agent to read the page and report', () => {
    const out = evaluateInjectionGate({ warnings: [HIGH_WARNING], action: 'form_submit' })
    assert.match(out.error, /hidden instruction/i)
    assert.match(out.hint, /browser_text/i)
  })
})

describe('the injection gate, in detail', () => {
  test('every egress action is a known action kind', () => {
    // The gate and the action layer must speak the same vocabulary: an
    // action kind nobody produces would be a hole.
    for (const action of EGRESS_ACTIONS) {
      assert.match(action, /^[a-z][a-z_]*$/)
    }
    assert.ok(EGRESS_ACTIONS.has('form_submit'))
    assert.ok(EGRESS_ACTIONS.has('upload'))
  })

  test('an unknown action is never blocked', () => {
    const out = evaluateInjectionGate({ warnings: [HIGH_WARNING], action: 'something_new' })
    assert.equal(out.allowed, true)
  })

  test('a missing action is never blocked', () => {
    const out = evaluateInjectionGate({ warnings: [HIGH_WARNING] })
    assert.equal(out.allowed, true)
  })

  test('the mode is case-insensitive and whitespace-tolerant', () => {
    assert.equal(
      injectionGateMode({ FIREFOX_BROWSER_INJECTION_GATE: '  OFF ' }),
      INJECTION_GATE_MODE.OFF,
    )
    assert.equal(
      injectionGateMode({ FIREFOX_BROWSER_INJECTION_GATE: 'on' }),
      INJECTION_GATE_MODE.STRICT,
    )
    assert.equal(
      injectionGateMode({ FIREFOX_BROWSER_INJECTION_GATE: 'nonsense' }),
      INJECTION_GATE_MODE.STRICT,
    )
  })

  test('the off mode is the only escape, and it is not an argument', () => {
    // There is deliberately no `bypass` parameter anywhere in the gate's
    // input: the only way out is the environment variable, which the agent
    // cannot reach.
    const out = evaluateInjectionGate({
      warnings: [HIGH_WARNING],
      action: 'form_submit',
      bypass: true,
      force: true,
      override: true,
    })
    assert.equal(out.allowed, false)
  })

  test('a high-severity warning is recognised among the warnings', () => {
    assert.equal(hasHighSeverityWarning([HIGH_WARNING]), true)
    assert.equal(hasHighSeverityWarning([{ code: 'encoded_injection', severity: 'medium' }]), false)
    assert.equal(hasHighSeverityWarning([]), false)
    assert.equal(hasHighSeverityWarning(null), false)
  })

  test('the blocked result names the action that was blocked', () => {
    const out = evaluateInjectionGate({ warnings: [HIGH_WARNING], action: 'upload' })
    assert.equal(out.action, 'upload')
  })
})
