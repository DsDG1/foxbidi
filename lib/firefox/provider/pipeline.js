// lib/firefox/provider/pipeline.js
// Unified action pipeline for FirefoxProvider.
//
// Every action on the page shares the same structural lifecycle:
//   1. Ensure provider ready
//   2. Check modal dialog block (`dialog_open`)
//   3. Resolve browsing context & element target (`ref` > `match` > `selector`)
//   4. Optional pre-flight DOM inspection + zero-size check
//   5. Security gates in strict order (`injection_blocked` BEFORE `confirm_required`)
//   6. Execute action inside BiDi error boundary (`classifyError`)
//   7. Record last-acted coordinates + active context + attach inline snapshot

import { evaluateGate, actionKindFor } from '../confirm.js'
import { ERROR_CODES, classifyError, fail } from '../errors.js'
import { inspectElement } from '../selector.js'

/**
 * Run a context-level action (e.g. `pressKey`, `scroll`) through the unified
 * readiness, dialog-block, context-resolution, error-classification, and
 * inline-snapshot pipeline.
 *
 * @param {any} provider
 * @param {string|undefined} contextId
 * @param {Record<string, any>} opts
 * @param {(ctx: {target: string, setActionContext: (ctxId: string) => void}) => Promise<Record<string, any>>} execute
 * @returns {Promise<Record<string, any>>}
 */
export async function runContextAction(provider, contextId, opts, execute) {
  if (!(await provider._ensureReady())) {
    return fail(ERROR_CODES.NOT_RUNNING, provider.error || 'firefox provider is not running')
  }
  const blocked = provider._dialogBlocked(contextId)
  if (blocked) return blocked
  const target = await provider._resolveContext(contextId)
  if (!target) {
    return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')
  }

  let effectiveContext = target
  try {
    const outcome = await execute({
      target,
      setActionContext(ctxId) {
        if (ctxId) effectiveContext = ctxId
      },
    })
    if (!outcome || outcome.ok === false) return outcome
    provider._lastContextId = target
    const snapContext = outcome.contextId || effectiveContext
    return await provider._withInlineSnapshot(outcome, snapContext, opts)
  } catch (e) {
    return fail(classifyError(e), e.message, { contextId: effectiveContext })
  }
}

/**
 * Run an element-targeted action (`click`, `type`, `selectOption`, `check`,
 * `hover`, `upload`) through the unified target-resolution, inspection,
 * security-gate, execution, coordinate-memory, and inline-snapshot pipeline.
 *
 * @param {any} provider
 * @param {{
 *   selector?: string,
 *   contextId?: string,
 *   opts?: Record<string, any>,
 *   inspect?: boolean,
 *   requireNonZeroSize?: boolean,
 *   gate?: 'explicit' | 'implicit' | 'none',
 *   egressKind?: string,
 *   execute: (ctx: {
 *     target: string,
 *     actionContext: string,
 *     resolved: Record<string, any>,
 *     info: Record<string, any> | null,
 *   }) => Promise<Record<string, any>>,
 * }} spec
 * @returns {Promise<Record<string, any>>}
 */
export async function runElementAction(provider, spec) {
  const opts = spec.opts || {}
  const contextId = spec.contextId

  if (!(await provider._ensureReady())) {
    return fail(ERROR_CODES.NOT_RUNNING, provider.error || 'firefox provider is not running')
  }
  const blocked = provider._dialogBlocked(contextId)
  if (blocked) return blocked

  const resolution = await provider._resolveActionTarget(spec.selector, contextId, opts)
  if (!resolution.ok) {
    return { ...resolution, contextId: contextId || provider._lastContextId }
  }
  const { target, resolved } = resolution
  const actionContext = resolved.contextId

  let info = null
  if (spec.inspect) {
    info = await inspectElement(provider.client, {
      contextId: actionContext,
      selector: resolved.selector,
      ref: resolved.ref,
      key: provider._registryKey,
    })
    if (!info) {
      return fail(
        ERROR_CODES.ELEMENT_NOT_FOUND,
        `element not found: ${provider._describeTarget(resolved)}`,
        { contextId: actionContext },
      )
    }
    if (spec.requireNonZeroSize && (info.w === 0 || info.h === 0)) {
      return fail(
        ERROR_CODES.ELEMENT_NOT_ACTIONABLE,
        `element has zero size (hidden or not laid out): ${provider._describeTarget(resolved)}`,
        { contextId: actionContext },
      )
    }
  }

  if (spec.gate === 'explicit') {
    // Strict security invariant: injection gate MUST run before confirm gate so
    // `confirm: true` from a hijacked agent cannot bypass data-egress protection.
    const egress = spec.egressKind || (info ? actionKindFor(info) : null)
    const injection = await provider._injectionGate(egress, actionContext)
    if (!injection.allowed) {
      return provider._injectionBlocked(injection, { contextId: actionContext })
    }
    const gate = evaluateGate({ info: info || {}, confirm: opts.confirm })
    if (!gate.allowed) {
      return fail(ERROR_CODES.CONFIRM_REQUIRED, gate.error, {
        hint: gate.hint,
        blocked: true,
        action: gate.action,
        requiresConfirm: true,
        contextId: actionContext,
      })
    }
  } else if (spec.gate === 'implicit') {
    const gateErr = await provider._gateImplicitTarget(resolved, actionContext, opts.confirm)
    if (gateErr) return { ...gateErr, contextId: actionContext }
  }

  try {
    const outcome = await spec.execute({ target, actionContext, resolved, info })
    if (!outcome || outcome.ok === false) return outcome

    provider._lastContextId = target
    const actedX = Number.isFinite(outcome.x) ? outcome.x : info ? info.x : NaN
    const actedY = Number.isFinite(outcome.y) ? outcome.y : info ? info.y : NaN
    if (provider._state && Number.isFinite(actedX) && Number.isFinite(actedY)) {
      provider._state.recordActedPoint(actionContext, actedX, actedY)
    }
    if (resolved.ignoredSelector && opts.ref && !outcome.hint) {
      outcome.hint = `ref "${opts.ref}" took precedence; the selector argument was ignored`
    }
    return await provider._withInlineSnapshot(outcome, actionContext, opts)
  } catch (e) {
    return fail(classifyError(e), e.message, { contextId: actionContext })
  }
}
