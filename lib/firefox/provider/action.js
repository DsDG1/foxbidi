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
import { ERROR_CODES, DIALOG_OPEN_HINT, classifyError, classifyPageError, fail } from '../errors.js'

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
   * The failure result for an action that cannot run because a modal dialog
   * is open.
   *
   * WHY THIS EXISTS
   *
   * A modal dialog blocks the page. While it is open, Firefox refuses to
   * evaluate scripts and to accept input, so every command aimed at the page
   * waits — and under the `manual` dialog policy nothing closes it, so the
   * wait is permanent. The agent used to get a plain timeout for that, which
   * reads like "the page is slow" and sends it into the wrong repair.
   *
   * So the action says what is actually true: a dialog is open, here it is,
   * and this is the command that unblocks the page.
   *
   * @param {string} [contextId] the context the action was aimed at
   * @param {object} [dialog]     a dialog the caller already knows about
   * @returns {object|null} the failure result, or null when no dialog is open
   */
  _dialogBlocked(contextId, dialog) {
    const blocking = this.dialogs.blocking()
    const target = dialog || (blocking.length ? blocking[blocking.length - 1] : null)
    if (!target) return null
    return fail(
      ERROR_CODES.DIALOG_OPEN,
      `a modal ${target.type} dialog is open, so the page is blocked`,
      {
        hint: DIALOG_OPEN_HINT,
        blocked: true,
        requiresDialogHandling: true,
        dialog: {
          type: target.type,
          message: target.message,
          contextId: target.context,
        },
        contextId: contextId || target.context,
      },
    )
  },
  /**
   * Send an input command, and give up the moment a modal dialog opens.
   *
   * WHY THE COMMAND HAS TO BE ABANDONABLE
   *
   * The command that opens a modal dialog never comes back: the page is
   * blocked inside the dialog, so the acknowledgement cannot be sent. The
   * command timeout eventually releases the CALLER, but the command itself is
   * still running inside Firefox — and the serialized queue keeps waiting for
   * it, so everything behind it is stuck too.
   *
   * Abandoning says "stop waiting for this one, and let the next command
   * go". The command stays pending inside Firefox; when it finally answers,
   * the response is discarded.
   *
   * @param {object} params  the BiDi `input.performActions` parameters
   * @returns {Promise<{ok: boolean, value?: object, dialog?: object}>}
   */
  async _performInput(params) {
    const waiter = this._waitForDialogOpen()
    const handle = this.client.sendAbandonable('input.performActions', params)
    try {
      const raced = await Promise.race([
        handle.promise.then((value) => ({ value })),
        waiter.promise.then((dialog) => ({ dialog })),
      ])
      if (raced.dialog) {
        handle.abandon()
        return { ok: false, dialog: raced.dialog }
      }
      return { ok: true, value: raced.value }
    } finally {
      waiter.cancel()
    }
  },
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
   * Compute the cumulative top-level viewport offset for a child frame context.
   *
   * `el.getBoundingClientRect()` inside an `<iframe>` returns coordinates
   * relative to that frame's own viewport, whereas WebDriver BiDi pointer
   * actions operate in the top-level browsing context's viewport. Walking the
   * ancestor chain from `topContext` to `frameContext` bridges the two.
   *
   * @param {string} topContext
   * @param {string} frameContext
   * @returns {Promise<{dx: number, dy: number, matched: boolean}>}
   */
  async _frameViewportOffset(topContext, frameContext) {
    if (!topContext || !frameContext || topContext === frameContext) {
      return { dx: 0, dy: 0, matched: false }
    }
    let tree
    try {
      tree = await bidi.getTree(this.client)
    } catch {
      return { dx: 0, dy: 0, matched: false }
    }
    if (!Array.isArray(tree) || !tree.length) {
      return { dx: 0, dy: 0, matched: false }
    }

    const findChain = (nodes, targetId, chain = []) => {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]
        const next = [...chain, { node, index: i }]
        if (node.contextId === targetId) return next
        if (Array.isArray(node.children) && node.children.length) {
          const found = findChain(node.children, targetId, next)
          if (found) return found
        }
      }
      return null
    }

    const chain = findChain(tree, frameContext)
    if (!chain || chain.length < 2) {
      return { dx: 0, dy: 0, matched: false }
    }

    let startIdx = chain.findIndex((step) => step.node.contextId === topContext)
    if (startIdx < 0) startIdx = 0
    const rootContext = chain[startIdx].node.contextId

    let dx = 0
    let dy = 0
    let matched = false
    for (let i = startIdx; i < chain.length - 1; i++) {
      const parentCtx = chain[i].node.contextId
      const childStep = chain[i + 1]
      const childUrl = childStep.node.url || ''
      const childIndex = childStep.index
      try {
        const raw = await bidi.callFunction(
          this.client,
          `(childIndex, childUrl) => {
            const frames = Array.from(document.querySelectorAll('iframe, frame'));
            let frameEl = null;
            try {
              const win = window.frames[childIndex];
              if (win) frameEl = frames.find((f) => f.contentWindow === win) || null;
            } catch {}
            if (!frameEl && childUrl) {
              frameEl = frames.find((f) => {
                const rawSrc = f.getAttribute('src') || f.src || '';
                if (!rawSrc) return false;
                try {
                  return new URL(rawSrc, location.href).href === childUrl;
                } catch {
                  return rawSrc === childUrl;
                }
              }) || null;
            }
            if (!frameEl && frames[childIndex]) frameEl = frames[childIndex];
            if (!frameEl) return null;
            frameEl.scrollIntoView({ block: 'center', inline: 'center' });
            const r = frameEl.getBoundingClientRect();
            const cs = window.getComputedStyle ? window.getComputedStyle(frameEl) : null;
            const padLeft = cs ? parseFloat(cs.paddingLeft) || 0 : 0;
            const padTop = cs ? parseFloat(cs.paddingTop) || 0 : 0;
            return {
              dx: r.left + (frameEl.clientLeft || 0) + padLeft,
              dy: r.top + (frameEl.clientTop || 0) + padTop,
            };
          }`,
          [
            { type: 'number', value: childIndex },
            { type: 'string', value: childUrl },
          ],
          parentCtx,
        )
        const stepOffset = bidi.unwrapRemoteValue(raw)
        if (stepOffset && typeof stepOffset === 'object' && Number.isFinite(stepOffset.dx)) {
          dx += stepOffset.dx
          dy += stepOffset.dy
          matched = true
        }
      } catch {
        // Ignore cross-realm or mock errors and fall back to local coordinates.
      }
    }

    return { dx, dy, matched, rootContext }
  },
  /**
   * Scroll the target element into view and re-read its post-scroll center
   * coordinates in the pointer input viewport.
   *
   * @param {string} actionContext
   * @param {string} targetContext
   * @param {object} resolved
   * @param {{x: number, y: number}} fallbackInfo
   * @returns {Promise<{x: number, y: number, pointerContext: string}>}
   */
  async _scrollAndMeasure(actionContext, targetContext, resolved, fallbackInfo) {
    const frameOffset =
      actionContext !== targetContext
        ? await this._frameViewportOffset(targetContext, actionContext)
        : { dx: 0, dy: 0, matched: false }

    const raw = await bidi.callFunction(
      this.client,
      `(key, ref, selector) => {
        const el = (${LOOKUP_ELEMENT})(key, ref, selector);
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          w: rect.width,
          h: rect.height,
        };
      }`,
      [
        { type: 'string', value: this._registryKey },
        { type: 'string', value: resolved.ref || '' },
        { type: 'string', value: resolved.selector || '' },
      ],
      actionContext,
    )
    const measured = bidi.unwrapRemoteValue(raw)
    const localX =
      measured && typeof measured === 'object' && Number.isFinite(measured.x)
        ? measured.x
        : fallbackInfo.x
    const localY =
      measured && typeof measured === 'object' && Number.isFinite(measured.y)
        ? measured.y
        : fallbackInfo.y

    return {
      x: localX + frameOffset.dx,
      y: localY + frameOffset.dy,
      pointerContext: frameOffset.matched
        ? frameOffset.rootContext || targetContext
        : actionContext,
    }
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
    const blocked = this._dialogBlocked(contextId)
    if (blocked) return blocked
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
      // Scroll the element into view first and re-measure its coordinates —
      // using the pre-scroll bounding box misses off-screen elements.
      const coords = await this._scrollAndMeasure(actionContext, target, resolved, info)
      const before = await this._pageState(actionContext)
      // The dialog epoch is captured just before the input command: if a
      // dialog opens because of THIS action, the epoch moves and the result
      // can say so without waiting for an event that may never come.
      const dialogEpoch = this._dialogEpoch

      const sent = await inputs.pointerClick(this.client, {
        context: coords.pointerContext,
        x: coords.x,
        y: coords.y,
        button: opts.button,
        clickCount: opts.clickCount,
        perform: (params) => this._performInput(params),
      })
      if (sent && sent.ok === false) {
        // A modal dialog opened and was left open: the page is blocked, so
        // the command will never come back. Say so instead of hanging.
        return (
          this._dialogBlocked(actionContext, sent.dialog) ||
          fail(ERROR_CODES.DIALOG_OPEN, 'a modal dialog is open, so the page is blocked', {
            contextId: actionContext,
          })
        )
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
        x: coords.x,
        y: coords.y,
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
    const blocked = this._dialogBlocked(contextId)
    if (blocked) return blocked
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
      const sent = await inputs.typeText(this.client, {
        context: actionContext,
        text: String(text ?? ''),
        perform: (params) => this._performInput(params),
      })
      if (sent && sent.ok === false) {
        return (
          this._dialogBlocked(actionContext, sent.dialog) ||
          fail(ERROR_CODES.DIALOG_OPEN, 'a modal dialog is open, so the page is blocked', {
            contextId: actionContext,
          })
        )
      }

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
        const sent = await inputs.pressKeys(this.client, {
          context: actionContext,
          keys: [inputs.encodeKey('Enter')],
          perform: (params) => this._performInput(params),
        })
        if (sent && sent.ok === false) {
          return (
            this._dialogBlocked(actionContext, sent.dialog) ||
            fail(ERROR_CODES.DIALOG_OPEN, 'a modal dialog is open, so the page is blocked', {
              contextId: actionContext,
            })
          )
        }
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
    const blocked = this._dialogBlocked(contextId)
    if (blocked) return blocked
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
      const sent = await inputs.pressKeys(this.client, {
        context: target,
        keys: combo.keys,
        perform: (params) => this._performInput(params),
      })
      if (sent && sent.ok === false) {
        return (
          this._dialogBlocked(target, sent.dialog) ||
          fail(ERROR_CODES.DIALOG_OPEN, 'a modal dialog is open, so the page is blocked', {
            contextId: target,
          })
        )
      }
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
    const blocked = this._dialogBlocked(contextId)
    if (blocked) return blocked
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
          effect: { verified: true },
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
    const blocked = this._dialogBlocked(contextId)
    if (blocked) return blocked
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
          effect: { verified: result.checked === !!checked },
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
    const blocked = this._dialogBlocked(contextId)
    if (blocked) return blocked
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
      const coords = await this._scrollAndMeasure(actionContext, target, resolved, info)
      await inputs.pointerMove(this.client, {
        context: coords.pointerContext,
        x: coords.x,
        y: coords.y,
      })
      this._lastContextId = target
      return await this._withInlineSnapshot(
        {
          ok: true,
          contextId: actionContext,
          ref: resolved.ref,
          selector: resolved.selector,
          x: coords.x,
          y: coords.y,
          effect: { verified: true },
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
    const blocked = this._dialogBlocked(contextId)
    if (blocked) return blocked
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
          effect: { verified: !!result.moved },
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
    const blocked = this._dialogBlocked(contextId)
    if (blocked) return blocked
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
          `could not resolve a file input at ${this._describeTarget(resolved)}`,
          { contextId: actionContext },
        )
      }
      await bidi.setFiles(this.client, {
        context: actionContext,
        sharedId,
        files: paths,
      })
      this._lastContextId = target
      return await this._withInlineSnapshot(
        {
          ok: true,
          contextId: actionContext,
          ref: resolved.ref,
          selector: resolved.selector,
          uploaded: paths.length,
          files: paths,
          effect: { verified: paths.length > 0 },
        },
        actionContext,
        opts,
      )
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: actionContext })
    }
  },
}
