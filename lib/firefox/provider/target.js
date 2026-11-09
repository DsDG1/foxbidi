// lib/firefox/provider/target.js
// Split out of action.js to keep every module within a
// readable size.
//
// The methods below were moved verbatim; they stay prototype methods, so
// `this` is the provider instance exactly as before.

import * as bidi from '../../bidi/protocol.js'

import { ERROR_CODES, fail } from '../errors.js'
import { FINGERPRINT_EXPRESSION } from '../fingerprint.js'
import * as inputs from '../inputs.js'
import { REF_MODE } from '../registry.js'
import { resolveTarget } from '../selector.js'

/**
 * The target methods.
 *
 * @type an object of methods
 */
export const targetMethods = {
  /**
   * Resolve which context to act on.
   *
   * The resolved context is returned to the caller and MUST be reused for
   * the whole action: concurrent calls each resolve their own target, so
   * one call can never land on another call's tab.
   *
   * @param {string} [contextId]
   * @returns {Promise<string|null>}
   */
  async _resolveContext(contextId) {
    if (contextId) return contextId
    if (this._lastContextId) return this._lastContextId
    const tabs = await this.listTabs()
    const first = tabs.find((t) => t.url && t.url !== 'about:blank') || tabs[0]
    return first ? first.contextId : null
  },
  /**
   * Resolve an action target (ref or selector) into something actionable.
   *
   * A ref that lives inside an iframe carries the frame's label; the resolved
   * `contextId` is then the FRAME's browsing context, so the action lands
   * where the agent pointed.
   *
   * @param {string} [selector]
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} [opts.ref]
   * @returns {Promise<{ok: true, target: string, resolved: object}
   *          | {ok: false, code: string, error: string, hint?: string, requiresResnapshot?: boolean}>}
   */
  async _resolveActionTarget(selector, contextId, opts = {}) {
    const target = await this._resolveContext(contextId)
    if (!target) {
      return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')
    }
    const resolved = await resolveTarget(this.client, {
      ref: opts.ref,
      selector,
      contextId: target,
      key: this._registryKey,
      legacy: this._refMode === REF_MODE.ATTRIBUTE,
      frameMap: this._frameMap,
    })
    if (!resolved.ok) {
      return fail(ERROR_CODES.REF_STALE, resolved.error, {
        hint: resolved.hint,
        requiresResnapshot: resolved.requiresResnapshot,
      })
    }
    return { ok: true, target, resolved }
  },
  /**
   * The element addressing arguments the input primitives expect.
   *
   * @param {object} resolved  the result of `resolveTarget`
   * @returns {{context: string, key: string, ref: string, selector: string}}
   */
  _elementArgs(resolved) {
    return {
      context: resolved.contextId,
      key: this._registryKey,
      ref: resolved.ref || '',
      selector: resolved.selector || '',
    }
  },
  /**
   * Describe the target for error messages.
   *
   * @param {object} resolved
   * @returns {string}
   */
  _describeTarget(resolved) {
    if (resolved.ref) return `ref "${resolved.ref}"`
    return `selector "${resolved.selector || ''}"`
  },
  /**
   * Capture a lightweight fingerprint of the current page.
   *
   * Used to tell whether an action actually changed anything. Deliberately
   * cheap: it must not cost more than the action it is verifying.
   *
   * The fingerprint covers the body shape, the visible text length, and the
   * focused field's value. The last part matters because an <input>'s value
   * is not part of innerText: without it, typing into a field leaves the
   * fingerprint untouched and the action is reported as having had no
   * effect — even though the characters really were sent.
   *
   * A password field's value is never read into the fingerprint.
   *
   * @param {string} contextId
   * @returns {Promise<{url: string, title: string, fingerprint: string}>}
   */
  async _pageState(contextId) {
    try {
      const result = await bidi.evaluate(this.client, FINGERPRINT_EXPRESSION, contextId)
      const value = bidi.unwrapRemoteValue(result)
      return {
        url: (value && value.url) || '',
        title: (value && value.title) || '',
        fingerprint: (value && value.fingerprint) || '',
      }
    } catch {
      return { url: '', title: '', fingerprint: '' }
    }
  },
  /**
   * Compare the page before and after an action.
   *
   * `verified` is honest: it is true only when there is observable evidence
   * that something changed. A command that returned successfully but left
   * the page untouched reports `verified: false`.
   *
   * @param {string} contextId
   * @param {object} before
   * @returns {Promise<object>}
   */
  async _effect(contextId, before) {
    const after = await this._pageState(contextId)
    const navigated = !!before.url && !!after.url && before.url !== after.url
    const domChanged = !!before.fingerprint && before.fingerprint !== after.fingerprint
    const verified = navigated || domChanged
    const effect = {
      url: after.url,
      title: after.title,
      navigated,
      domChanged,
      verified,
    }
    if (!verified) {
      effect.hint = 'no observable page change — the action may not have taken effect'
    }
    return effect
  },
}
