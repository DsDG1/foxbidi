// lib/firefox/provider/action.js
// Actions: pointer and keyboard input on the page.
//
// The methods below were moved here verbatim from the single FirefoxProvider
// class. They stay prototype methods, so `this` means exactly what it meant
// before: the provider instance, with its client, registry key, log buffer
// and dialog manager.

/**
 * The action methods.
 *
 * @type an object of methods
 */
import * as bidi from '../../bidi/protocol.js'
import { evaluateGate, actionKindFor } from '../confirm.js'
import { evaluateInjectionGate, injectionGateMode, INJECTION_GATE_MODE } from '../injection-gate.js'
import { ERROR_CODES, classifyError, classifyPageError, fail } from '../errors.js'

import * as inputs from '../inputs.js'
import { LOOKUP_ELEMENT } from '../registry.js'
import { inspectActiveElement, inspectElement, resolveSharedId } from '../selector.js'

/**
 * Does this key combination include Enter?
 *
 * Enter is the key that submits a form implicitly, so it is the one key the
 * confirmation gate has to reason about. "Return" is the same key under its
 * other name.
 *
 * @param {string} key
 * @returns {boolean}
 */
function isEnterKey(key) {
  const parts = String(key || '')
    .split('+')
    .map((p) => p.trim().toLowerCase())
  return parts.includes('enter') || parts.includes('return')
}

export const actionMethods = {
  /**
   * Attach an inline snapshot to an action's result.
   *
   * WHY AN INLINE SNAPSHOT
   *
   * An action changes the page, and the agent's next question is almost
   * always "what does the page look like now?". Without an answer in the
   * same response, that costs a second round trip — and the agent has to
   * remember to ask. The inline snapshot closes the loop: the action's
   * response carries both what happened (`effect.verified`) and what the
   * page looks like afterwards.
   *
   * It is deliberately LIGHT: only `ref`, `role` and `name`, capped at
   * 60 elements. The full picture is still one `browser_snapshot` away,
   * and the ref the agent gets here is the CURRENT one — but a page that
   * re-renders later still invalidates it, exactly as before.
   *
   * A failure here never fails the action. The action already happened;
   * the look is a bonus. So the error is reported alongside the result
   * rather than thrown.
   *
   * @param {object} result        the action's result
   * @param {string} contextId     the browsing context to look at
   * @param {object} [opts]
   * @param {boolean} [opts.includeSnapshot]  false to skip the look
   * @returns {Promise<object>} the result, with `effect.snapshot` attached
   */
  async _withInlineSnapshot(result, contextId, opts = {}) {
    if (opts.includeSnapshot === false) return result
    if (this.config_ && this.config_.inlineSnapshot === false) return result
    if (!contextId || !result || result.ok !== true) return result
    try {
      const inline = await this._inlineSnapshot(contextId)
      const effect = result.effect && typeof result.effect === 'object' ? result.effect : {}
      if (inline.elements.length) {
        effect.snapshot = inline.elements
        if (inline.truncated) effect.snapshotTruncated = true
      }
      if (inline.error) effect.snapshotError = inline.error
      result.effect = effect
    } catch {
      // The look failed; the action did not. Say nothing and keep the result.
    }
    return result
  },
  /**
   * Apply the injection gate to an action.
   *
   * Called BEFORE the irreversibility gate, so a blocked action never
   * reaches the point where a confirmation could release it. That order is
   * the whole point: the irreversibility gate asks for a flag the AGENT
   * supplies, and a hijacked agent supplies it happily.
   *
   * The page is re-scanned here, so the gate always judges the page the
   * agent is acting on RIGHT NOW. An agent that navigates and submits
   * without reading first would otherwise be judged on the page it was
   * on before — and the warnings of the previous page are cleared on
   * navigation, so it would be judged on nothing at all.
   *
   * @param {string|null} action the action kind, or null when the action
   *   is not one that carries data out
   * @param {string} [contextId] the browsing context the action targets
   * @returns {Promise<{allowed: boolean, code?: string, error?: string, hint?: string, action?: string}>}
   */
  async _injectionGate(action, contextId) {
    // An action that carries no data out needs no scan and no verdict.
    if (!action) return { allowed: true }

    const mode = injectionGateMode()
    if (mode === INJECTION_GATE_MODE.OFF) return { allowed: true }

    const target = contextId || this._lastContextId
    if (target) {
      const scan = await this._visibilityScan(target)
      this._applyScan(scan)
    }

    return evaluateInjectionGate({
      warnings: this._pageWarnings || [],
      action,
      mode,
    })
  },
  /**
   * Build the failure result for a blocked action.
   *
   * @param {object} gate   the gate verdict
   * @param {object} [extra] additional fields for the result
   * @returns {object}
   */
  _injectionBlocked(gate, extra = {}) {
    return fail(ERROR_CODES.INJECTION_BLOCKED, gate.error, {
      hint: gate.hint,
      blocked: true,
      action: gate.action,
      warnings: this._pageWarnings || [],
      ...extra,
    })
  },
  /**
   * Click an element.
   *
   * Uses real pointer input (pointerMove → pointerDown → pointerUp) rather
   * than `element.click()`. A synthetic DOM click does not produce the
   * trusted events many sites require, and it skips hit-testing.
   *
   * @param {string} [selector]  CSS selector (legacy path)
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} [opts.ref]        snapshot ref (preferred)
   * @param {boolean} [opts.confirm]   explicit confirmation for irreversible actions
   * @param {number} [opts.button]     0 left, 1 middle, 2 right
   * @param {number} [opts.clickCount] 2 for a double click
   */
  async click(selector, contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const resolution = await this._resolveActionTarget(selector, contextId, opts)
    if (!resolution.ok) {
      return { ...resolution, contextId: contextId || this._lastContextId }
    }
    const { target, resolved } = resolution
    const actionContext = resolved.contextId

    const info = await inspectElement(this.client, {
      contextId: actionContext,
      selector: resolved.selector,
      ref: resolved.ref,
      key: this._registryKey,
    })
    if (!info) {
      return fail(
        ERROR_CODES.ELEMENT_NOT_FOUND,
        `element not found: ${this._describeTarget(resolved)}`,
        { contextId: actionContext },
      )
    }
    if (info.w === 0 || info.h === 0) {
      return fail(
        ERROR_CODES.ELEMENT_NOT_ACTIONABLE,
        `element has zero size (hidden or not laid out): ${this._describeTarget(resolved)}`,
        { contextId: actionContext },
      )
    }

    // The injection gate runs FIRST. A click that submits a form is a
    // data-egress action, and on a page carrying a hidden instruction it
    // is exactly what the page wants. The gate is checked before the
    // irreversibility gate, so `confirm: true` cannot release it.
    const egress = actionKindFor(info)
    const injection = await this._injectionGate(egress, actionContext)
    if (!injection.allowed) {
      return this._injectionBlocked(injection, { contextId: actionContext })
    }

    // The irreversibility gate. A click that submits a form, downloads a
    // file or posts account data must be confirmed explicitly.
    const gate = evaluateGate({ info, confirm: opts.confirm })
    if (!gate.allowed) {
      return fail(ERROR_CODES.CONFIRM_REQUIRED, gate.error, {
        hint: gate.hint,
        blocked: true,
        action: gate.action,
        requiresConfirm: true,
        contextId: actionContext,
      })
    }

    try {
      // Scroll the element into view first — a pointer click at
      // off-screen coordinates hits nothing.
      await bidi.callFunction(
        this.client,
        `(key, ref, selector) => {
          const el = (${LOOKUP_ELEMENT})(key, ref, selector);
          if (el) el.scrollIntoView({block: 'center', inline: 'center'});
          return !!el;
        }`,
        [
          { type: 'string', value: this._registryKey },
          { type: 'string', value: resolved.ref || '' },
          { type: 'string', value: resolved.selector || '' },
        ],
        actionContext,
      )
      const before = await this._pageState(actionContext)
      // The dialog epoch is captured just before the input command: if a
      // dialog opens because of THIS action, the epoch moves and the result
      // can say so without waiting for an event that may never come.
      const dialogEpoch = this._dialogEpoch

      await inputs.pointerClick(this.client, {
        context: actionContext,
        x: info.x,
        y: info.y,
        button: opts.button,
        clickCount: opts.clickCount,
      })

      this._lastContextId = target
      const effect = await this._effect(actionContext, before)
      const dialogs = await this._settleDialogs(dialogEpoch)
      if (dialogs.length) effect.dialog = dialogs[0]
      const result = {
        ok: true,
        contextId: actionContext,
        ref: resolved.ref,
        selector: resolved.selector,
        via: resolved.via,
        x: info.x,
        y: info.y,
        effect,
      }
      if (resolved.ignoredSelector) {
        result.hint = `ref "${opts.ref}" took precedence; the selector argument was ignored`
      }
      return await this._withInlineSnapshot(result, actionContext, opts)
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: actionContext })
    }
  },
  /**
   * Type text into an element.
   *
   * Focuses the element, then sends one key action per character so the page
   * receives genuine keyboard events (needed by search boxes, editors and
   * anything with keydown handlers).
   *
   * @param {string} [selector]  CSS selector (legacy path)
   * @param {string} text
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} [opts.ref]       snapshot ref (preferred)
   * @param {boolean} [opts.clear]    clear the field first
   * @param {boolean} [opts.submit]   press Enter afterwards
   * @param {boolean} [opts.confirm]  explicit confirmation if submitting
   */
  async type(selector, text, contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const resolution = await this._resolveActionTarget(selector, contextId, opts)
    if (!resolution.ok) {
      return { ...resolution, contextId: contextId || this._lastContextId }
    }
    const { target, resolved } = resolution
    const actionContext = resolved.contextId

    const info = await inspectElement(this.client, {
      contextId: actionContext,
      selector: resolved.selector,
      ref: resolved.ref,
      key: this._registryKey,
    })
    if (!info) {
      return fail(
        ERROR_CODES.ELEMENT_NOT_FOUND,
        `element not found: ${this._describeTarget(resolved)}`,
        { contextId: actionContext },
      )
    }

    try {
      const args = this._elementArgs(resolved)
      if (opts.clear) {
        await inputs.clearElement(this.client, args)
      }
      const focused = await inputs.focusElement(this.client, args)
      if (!focused) {
        return fail(
          ERROR_CODES.ELEMENT_NOT_FOUND,
          `element not found: ${this._describeTarget(resolved)}`,
          { contextId: actionContext },
        )
      }

      const before = await this._pageState(actionContext)
      const dialogEpoch = this._dialogEpoch
      await inputs.typeText(this.client, { context: actionContext, text: String(text ?? '') })

      // Typing that ends with Enter submits a form — that is irreversible,
      // so it goes through the same gate as a click.
      let submitted = false
      if (opts.submit) {
        // Typing that ends with Enter submits a form — that is data
        // egress, so the injection gate comes first.
        const injection = await this._injectionGate('form_submit', actionContext)
        if (!injection.allowed) {
          return this._injectionBlocked(injection, { contextId: actionContext })
        }
        const gate = evaluateGate({ info, confirm: opts.confirm })
        if (!gate.allowed) {
          return fail(ERROR_CODES.CONFIRM_REQUIRED, gate.error, {
            hint: gate.hint,
            blocked: true,
            action: gate.action,
            requiresConfirm: true,
            contextId: actionContext,
          })
        }
        await inputs.pressKeys(this.client, {
          context: actionContext,
          keys: [inputs.encodeKey('Enter')],
        })
        submitted = true
      }

      this._lastContextId = target
      const effect = await this._effect(actionContext, before)
      const dialogs = await this._settleDialogs(dialogEpoch)
      if (dialogs.length) effect.dialog = dialogs[0]
      const result = {
        ok: true,
        contextId: actionContext,
        ref: resolved.ref,
        selector: resolved.selector,
        via: resolved.via,
        typed: String(text ?? '').length,
        submitted,
        effect,
      }
      if (resolved.ignoredSelector) {
        result.hint = `ref "${opts.ref}" took precedence; the selector argument was ignored`
      }
      return await this._withInlineSnapshot(result, actionContext, opts)
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: actionContext })
    }
  },
  /**
   * Press a key or a key combination.
   *
   * @param {string} key  e.g. "Enter", "Escape", "Ctrl+Enter"
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {boolean} [opts.confirm]  explicit confirmation if the key can submit a form
   */
  async pressKey(key, contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    if (!target) return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')

    const combo = inputs.encodeCombo(key)
    if (combo.error) {
      return fail(ERROR_CODES.INVALID_ARGUMENT, combo.error, { contextId: target })
    }

    // Enter submits the form the focused field belongs to. That is the same
    // irreversibleity a click on a submit button has, so it goes through the
    // same gate — otherwise the gate would be bypassable by pressing a key
    // instead of clicking.
    if (isEnterKey(key)) {
      const active = await this._focusedFormContext(target)
      if (active.probeFailed) {
        // The page would not tell us what has focus. We cannot prove the
        // Enter is harmless, so we require an explicit confirmation rather
        // than let it through on faith.
        return fail(
          ERROR_CODES.CONFIRM_REQUIRED,
          'this action is irreversible (form_submit) and needs explicit confirmation',
          {
            hint: 'could not determine what has focus, so this Enter may submit a form — pass confirm: true if that is intended',
            blocked: true,
            action: 'form_submit',
            requiresConfirm: true,
            contextId: target,
          },
        )
      }
      if (active.info && active.info.inForm) {
        // Enter in a text field submits the form — data egress, so the
        // injection gate is checked before the irreversibility gate.
        const injection = await this._injectionGate('form_submit', target)
        if (!injection.allowed) {
          return this._injectionBlocked(injection, { contextId: target })
        }
        const gate = evaluateGate({
          info: active.info,
          confirm: opts.confirm,
          implicit: true,
        })
        if (!gate.allowed) {
          return fail(ERROR_CODES.CONFIRM_REQUIRED, gate.error, {
            hint: gate.hint,
            blocked: true,
            action: gate.action,
            requiresConfirm: true,
            contextId: target,
          })
        }
      }
    }

    try {
      const before = await this._pageState(target)
      const dialogEpoch = this._dialogEpoch
      await inputs.pressKeys(this.client, { context: target, keys: combo.keys })
      this._lastContextId = target
      const effect = await this._effect(target, before)
      const dialogs = await this._settleDialogs(dialogEpoch)
      if (dialogs.length) effect.dialog = dialogs[0]
      return await this._withInlineSnapshot(
        { ok: true, contextId: target, key, pressed: combo.keys.length, effect },
        target,
        opts,
      )
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: target })
    }
  },
  /**
   * Gate an action whose irreversibility comes from HTML behaviour rather
   * than from the control itself — changing a <select>, toggling a radio.
   *
   * The target's form context is inspected, and if the change could submit
   * a form the caller must confirm. Returns null when the action may
   * proceed, and the failure result when it may not.
   *
   * @param {object} resolved     the resolved target
   * @param {string} contextId    the browsing context
   * @param {boolean} [confirm]
   * @returns {Promise<object|null>}
   */
  async _gateImplicitTarget(resolved, contextId, confirm) {
    let info
    try {
      info = await inspectElement(this.client, {
        contextId,
        selector: resolved.selector,
        ref: resolved.ref,
        key: this._registryKey,
      })
    } catch {
      // We could not read the element. We cannot prove the change is
      // harmless, so we require an explicit confirmation.
      return fail(
        ERROR_CODES.CONFIRM_REQUIRED,
        'this action is irreversible (form_submit) and needs explicit confirmation',
        {
          hint: 'could not inspect the element, so this change may submit a form — pass confirm: true if that is intended',
          blocked: true,
          action: 'form_submit',
          requiresConfirm: true,
        },
      )
    }
    if (!info) return null

    // A change event can submit the form — data egress, so the injection
    // gate is checked before the irreversibility gate.
    const injection = await this._injectionGate('form_submit', contextId)
    if (!injection.allowed) {
      return this._injectionBlocked(injection)
    }

    const gate = evaluateGate({ info, confirm, implicit: true })
    if (gate.allowed) return null
    return fail(ERROR_CODES.CONFIRM_REQUIRED, gate.error, {
      hint: gate.hint,
      blocked: true,
      action: gate.action,
      requiresConfirm: true,
    })
  },
  /**
   * Find out what has focus, and whether it lives in a form.
   *
   * @param {string} contextId
   * @returns {Promise<{info: object|null, probeFailed: boolean}>}
   */
  async _focusedFormContext(contextId) {
    try {
      const info = await inspectActiveElement(this.client, { contextId })
      return { info, probeFailed: false }
    } catch {
      // The page refused the probe (a cross-origin frame, a document that is
      // not ready). "I do not know" is not "it is safe".
      return { info: null, probeFailed: true }
    }
  },
  /**
   * Choose an option in a `<select>`.
   *
   * @param {string} [selector]
   * @param {string} value
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} [opts.ref]
   * @param {boolean} [opts.byText]  match the visible text, not the value
   * @param {boolean} [opts.confirm] explicit confirmation if the change can submit a form
   */
  async selectOption(selector, value, contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const resolution = await this._resolveActionTarget(selector, contextId, opts)
    if (!resolution.ok) {
      return { ...resolution, contextId: contextId || this._lastContextId }
    }
    const { target, resolved } = resolution
    const actionContext = resolved.contextId

    // Changing a <select> fires a change event, and a page may submit the
    // form in response. That is the same irreversibleity a submit click
    // has, so it goes through the same gate.
    const gate = await this._gateImplicitTarget(resolved, actionContext, opts.confirm)
    if (gate) return { ...gate, contextId: actionContext }

    try {
      const result = await inputs.selectOption(this.client, {
        ...this._elementArgs(resolved),
        value,
        byText: opts.byText,
      })
      if (!result.ok) {
        return fail(classifyPageError(result.error), result.error || 'select failed', {
          contextId: actionContext,
          options: result.options,
        })
      }
      this._lastContextId = target
      return await this._withInlineSnapshot(
        {
          ok: true,
          contextId: actionContext,
          ref: resolved.ref,
          selector: resolved.selector,
          selected: result.selected,
          options: result.options,
        },
        actionContext,
        opts,
      )
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: actionContext })
    }
  },
  /**
   * Check or uncheck a checkbox / radio button.
   *
   * @param {string} [selector]
   * @param {boolean} checked
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} [opts.ref]
   * @param {boolean} [opts.confirm] explicit confirmation if the change can submit a form
   */
  async check(selector, checked, contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const resolution = await this._resolveActionTarget(selector, contextId, opts)
    if (!resolution.ok) {
      return { ...resolution, contextId: contextId || this._lastContextId }
    }
    const { target, resolved } = resolution
    const actionContext = resolved.contextId

    // Toggling a radio can fire a change event that submits the form —
    // "pick a plan, go to payment" is a real pattern. Same gate as a click.
    const gate = await this._gateImplicitTarget(resolved, actionContext, opts.confirm)
    if (gate) return { ...gate, contextId: actionContext }

    try {
      const result = await inputs.checkElement(this.client, {
        ...this._elementArgs(resolved),
        checked,
      })
      if (!result.ok) {
        return fail(classifyPageError(result.error), result.error || 'check failed', {
          contextId: actionContext,
        })
      }
      this._lastContextId = target
      return await this._withInlineSnapshot(
        {
          ok: true,
          contextId: actionContext,
          ref: resolved.ref,
          selector: resolved.selector,
          checked: result.checked,
        },
        actionContext,
        opts,
      )
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: actionContext })
    }
  },
  /**
   * Hover over an element.
   *
   * @param {string} [selector]
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} [opts.ref]
   */
  async hover(selector, contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const resolution = await this._resolveActionTarget(selector, contextId, opts)
    if (!resolution.ok) {
      return { ...resolution, contextId: contextId || this._lastContextId }
    }
    const { target, resolved } = resolution
    const actionContext = resolved.contextId

    const info = await inspectElement(this.client, {
      contextId: actionContext,
      selector: resolved.selector,
      ref: resolved.ref,
      key: this._registryKey,
    })
    if (!info) {
      return fail(
        ERROR_CODES.ELEMENT_NOT_FOUND,
        `element not found: ${this._describeTarget(resolved)}`,
        { contextId: actionContext },
      )
    }
    if (info.w === 0 || info.h === 0) {
      return fail(
        ERROR_CODES.ELEMENT_NOT_ACTIONABLE,
        `element has zero size (hidden or not laid out): ${this._describeTarget(resolved)}`,
        { contextId: actionContext },
      )
    }
    try {
      await bidi.callFunction(
        this.client,
        `(key, ref, selector) => {
          const el = (${LOOKUP_ELEMENT})(key, ref, selector);
          if (el) el.scrollIntoView({block: 'center', inline: 'center'});
          return !!el;
        }`,
        [
          { type: 'string', value: this._registryKey },
          { type: 'string', value: resolved.ref || '' },
          { type: 'string', value: resolved.selector || '' },
        ],
        actionContext,
      )
      await inputs.pointerMove(this.client, { context: actionContext, x: info.x, y: info.y })
      this._lastContextId = target
      return await this._withInlineSnapshot(
        {
          ok: true,
          contextId: actionContext,
          ref: resolved.ref,
          selector: resolved.selector,
          x: info.x,
          y: info.y,
        },
        actionContext,
        opts,
      )
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: actionContext })
    }
  },
  /**
   * Scroll the page or bring an element into view.
   *
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} [opts.ref]
   * @param {string} [opts.selector]
   * @param {string} [opts.direction]  up | down | top | bottom
   * @param {number} [opts.amount]
   */
  async scroll(contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    if (!target) return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')

    let selector = opts.selector
    let ref = ''
    let actionContext = target
    if (opts.ref) {
      const resolution = await this._resolveActionTarget(opts.selector, target, {
        ref: opts.ref,
      })
      if (!resolution.ok) {
        return { ...resolution, contextId: target }
      }
      selector = resolution.resolved.selector
      ref = resolution.resolved.ref || ''
      actionContext = resolution.resolved.contextId
    }
    try {
      const result = await inputs.scroll(this.client, {
        context: actionContext,
        key: this._registryKey,
        ref,
        selector,
        direction: opts.direction,
        amount: opts.amount,
      })
      if (!result.ok) {
        return fail(ERROR_CODES.INVALID_ARGUMENT, result.error || 'scroll failed', {
          contextId: actionContext,
        })
      }
      this._lastContextId = target
      return await this._withInlineSnapshot(
        {
          ok: true,
          contextId: actionContext,
          scrollY: result.scrollY,
          moved: result.moved,
        },
        actionContext,
        opts,
      )
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: actionContext })
    }
  },
  /**
   * Upload a file to a file input.
   *
   * Uploading sends local data to a remote site — that is irreversible from
   * the user's point of view, so it goes through the confirmation gate.
   *
   * @param {string} [selector]
   * @param {string[]} paths  absolute file paths
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} [opts.ref]
   * @param {boolean} [opts.confirm]
   */
  async upload(selector, paths, contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const resolution = await this._resolveActionTarget(selector, contextId, opts)
    if (!resolution.ok) {
      return { ...resolution, contextId: contextId || this._lastContextId }
    }
    const { target, resolved } = resolution
    const actionContext = resolved.contextId

    const info = await inspectElement(this.client, {
      contextId: actionContext,
      selector: resolved.selector,
      ref: resolved.ref,
      key: this._registryKey,
    })
    if (!info) {
      return fail(
        ERROR_CODES.ELEMENT_NOT_FOUND,
        `element not found: ${this._describeTarget(resolved)}`,
        { contextId: actionContext },
      )
    }

    // Uploading a local file hands it to the site — the clearest data
    // egress there is.
    const injection = await this._injectionGate('upload', actionContext)
    if (!injection.allowed) {
      return this._injectionBlocked(injection, { contextId: actionContext })
    }

    const gate = evaluateGate({ info, confirm: opts.confirm })
    if (!gate.allowed) {
      return fail(ERROR_CODES.CONFIRM_REQUIRED, gate.error, {
        hint: gate.hint,
        blocked: true,
        action: gate.action,
        requiresConfirm: true,
        contextId: actionContext,
      })
    }

    try {
      const sharedId = await resolveSharedId(this.client, {
        contextId: actionContext,
        selector: resolved.selector,
        ref: resolved.ref,
        key: this._registryKey,
      })
      if (!sharedId) {
        return fail(
          ERROR_CODES.INVALID_ARGUMENT,
          `could not resolve a file input at ${resolved.selector}`,
          { contextId: target },
        )
      }
      await bidi.setFiles(this.client, {
        context: target,
        sharedId,
        files: paths,
      })
      this._lastContextId = target
      return await this._withInlineSnapshot(
        {
          ok: true,
          contextId: target,
          selector: resolved.selector,
          uploaded: paths.length,
          files: paths,
        },
        actionContext,
        opts,
      )
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: target })
    }
  },
}
