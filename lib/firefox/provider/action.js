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
import { evaluateGate } from '../confirm.js'
import { ERROR_CODES, classifyError, classifyPageError, fail } from '../errors.js'

import * as inputs from '../inputs.js'
import { LOOKUP_ELEMENT } from '../registry.js'
import { inspectElement, resolveSharedId } from '../selector.js'

export const actionMethods = {
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
      return result
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
      return result
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: actionContext })
    }
  },
  /**
   * Press a key or a key combination.
   *
   * @param {string} key  e.g. "Enter", "Escape", "Ctrl+Enter"
   * @param {string} [contextId]
   */
  async pressKey(key, contextId) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    if (!target) return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')

    const combo = inputs.encodeCombo(key)
    if (combo.error) {
      return fail(ERROR_CODES.INVALID_ARGUMENT, combo.error, { contextId: target })
    }
    try {
      const before = await this._pageState(target)
      const dialogEpoch = this._dialogEpoch
      await inputs.pressKeys(this.client, { context: target, keys: combo.keys })
      this._lastContextId = target
      const effect = await this._effect(target, before)
      const dialogs = await this._settleDialogs(dialogEpoch)
      if (dialogs.length) effect.dialog = dialogs[0]
      return { ok: true, contextId: target, key, pressed: combo.keys.length, effect }
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: target })
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
      return {
        ok: true,
        contextId: actionContext,
        ref: resolved.ref,
        selector: resolved.selector,
        selected: result.selected,
        options: result.options,
      }
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
      return {
        ok: true,
        contextId: actionContext,
        ref: resolved.ref,
        selector: resolved.selector,
        checked: result.checked,
      }
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
      return {
        ok: true,
        contextId: actionContext,
        ref: resolved.ref,
        selector: resolved.selector,
        x: info.x,
        y: info.y,
      }
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
      return {
        ok: true,
        contextId: actionContext,
        scrollY: result.scrollY,
        moved: result.moved,
      }
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
      return {
        ok: true,
        contextId: target,
        selector: resolved.selector,
        uploaded: paths.length,
        files: paths,
      }
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: target })
    }
  },
}
