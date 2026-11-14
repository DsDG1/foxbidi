// test/recovery-contract.test.js
// Unit tests for machine-executable error recovery plans and wire compaction in toStructured().

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ERROR_CODES, buildRecovery, fail } from '../lib/firefox/errors.js'
import { summarize, toStructured } from '../lib/mcp/schema.js'

describe('structured recovery contract', () => {
  test('every ERROR_CODES member produces a valid recovery plan via fail()', () => {
    for (const code of Object.values(ERROR_CODES)) {
      const res = fail(code, `simulated ${code}`, { contextId: 'tab-9' })
      assert.equal(res.ok, false)
      assert.equal(res.code, code)
      assert.ok(res.recovery && typeof res.recovery === 'object', `${code} must include recovery`)
      assert.equal(typeof res.recovery.retrySameCall, 'boolean')
      assert.ok(
        res.recovery.sideEffectState === 'none' ||
          res.recovery.sideEffectState === 'unknown_must_observe',
        `unexpected sideEffectState for ${code}: ${res.recovery.sideEffectState}`,
      )
      if (res.recovery.nextCall) {
        assert.equal(typeof res.recovery.nextCall.tool, 'string')
        assert.equal(typeof res.recovery.nextCall.args, 'object')
      }
    }
  })

  test('sideEffectState marks ambiguous-outcome failures as unknown_must_observe', () => {
    for (const code of [
      ERROR_CODES.SESSION_STUCK,
      ERROR_CODES.TIMEOUT,
      ERROR_CODES.EVALUATE_FAILED,
      ERROR_CODES.INTERNAL,
    ]) {
      const plan = buildRecovery(code, { contextId: 'ctx-1' })
      assert.equal(plan.sideEffectState, 'unknown_must_observe')
      assert.equal(plan.retrySameCall, false)
    }
    assert.deepEqual(buildRecovery(ERROR_CODES.SESSION_STUCK).nextCall, {
      tool: 'browser_restart',
      args: { scope: 'session' },
    })
  })

  test('confirm_required allows retryWith confirm:true whereas injection_blocked forbids it', () => {
    const confirmPlan = buildRecovery(ERROR_CODES.CONFIRM_REQUIRED)
    assert.equal(confirmPlan.retrySameCall, true)
    assert.equal(confirmPlan.askUser, true)
    assert.deepEqual(confirmPlan.retryWith, { confirm: true })

    const injectionPlan = buildRecovery(ERROR_CODES.INJECTION_BLOCKED)
    assert.equal(injectionPlan.retrySameCall, false)
    assert.equal(injectionPlan.askUser, true)
    assert.equal(injectionPlan.retryWith, undefined)
  })

  test('ref_stale and dialog_open emit concrete nextCall tool invocations', () => {
    const stale = fail(ERROR_CODES.REF_STALE, 'ref e4 is gone', { contextId: 'tab-2' })
    assert.deepEqual(stale.recovery.nextCall, {
      tool: 'browser_snapshot',
      args: { contextId: 'tab-2', format: 'compact' },
    })
    assert.match(summarize(stale), /next: browser_snapshot/)

    const dlg = fail(ERROR_CODES.DIALOG_OPEN, 'alert open', { contextId: 'tab-2' })
    assert.deepEqual(dlg.recovery.nextCall, {
      tool: 'browser_handle_dialog',
      args: { contextId: 'tab-2', action: 'dismiss' },
    })
  })
})

describe('wire payload compaction in toStructured()', () => {
  test('strips zero-signal default fields while keeping active signals and warnings', () => {
    const clean = toStructured({
      ok: true,
      contextId: 'ctx-1',
      count: 2,
      total: 2,
      hasMore: false,
      truncated: false,
      refMode: 'registry',
      warnings: [],
      signals: [],
    })
    assert.equal(clean.hasMore, undefined)
    assert.equal(clean.truncated, undefined)
    assert.equal(clean.refMode, undefined)
    assert.equal(clean.warnings, undefined)
    assert.equal(clean.signals, undefined)

    const flagged = toStructured({
      ok: true,
      hasMore: true,
      truncated: true,
      refMode: 'attribute',
      warnings: [{ code: 'hidden_injection', severity: 'high' }],
      signals: [{ kind: 'instruction_reset' }],
    })
    assert.equal(flagged.hasMore, true)
    assert.equal(flagged.truncated, true)
    assert.equal(flagged.refMode, 'attribute')
    assert.equal(flagged.warnings.length, 1)
    assert.equal(flagged.signals.length, 1)
  })
})
