// lib/firefox/provider/action.js
// Actions: pointer and keyboard input on the page, built atop the unified
// ActionPipeline (`./pipeline.js`) and pure browser-realm scripts (`../page/*`).

import * as bidi from '../../bidi/protocol.js'
import { evaluateGate } from '../confirm.js'
import { evaluateInjectionGate, injectionGateMode, INJECTION_GATE_MODE } from '../injection-gate.js'
import { ERROR_CODES, DIALOG_OPEN_HINT, classifyPageError, fail } from '../errors.js'
import * as inputs from '../inputs.js'
import { SCROLL_AND_MEASURE_SCRIPT } from '../page/inputs-page.js'
import { inspectActiveElement, inspectElement, resolveSharedId } from '../selector.js'
import { runContextAction, runElementAction } from './pipeline.js'

/**
 * Does this key combination include Enter?
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

/** @satisfies {Record<string, Function> & ThisType<import("../provider.js").FirefoxProviderBase>} */
export const actionMethods = {
  /**
   * Build the failure result when a modal dialog blocks the page.
   *
   * @param {string} [contextId]
   * @param {Record<string, any>} [dialog]
   * @returns {Record<string, any>|null}
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
   * Send an input command and abandon it immediately if a blocking modal dialog opens.
   *
   * @param {Record<string, any>} params
   * @returns {Promise<{ok: boolean, value?: Record<string, any>, dialog?: Record<string, any>}>}
   */
  async _performInput(params) {
    const waiter = this._waitForDialogOpen()
    const handle = this.client.sendAbandonable('input.performActions', params)
    try {
      const raced = await Promise.race([
        handle.promise.then((value) => ({ value })),
        waiter.promise.then((dialog) => ({ dialog })),
      ])
      if ('dialog' in raced && raced.dialog) {
        handle.abandon()
        return { ok: false, dialog: raced.dialog }
      }
      return { ok: true, value: 'value' in raced ? raced.value : undefined }
    } finally {
      waiter.cancel()
    }
  },

  /**
   * Attach a light inline snapshot to an action's result without failing the action.
   *
   * @param {Record<string, any>} result
   * @param {string} contextId
   * @param {Record<string, any>} [opts]
   * @returns {Promise<Record<string, any>>}
   */
  async _withInlineSnapshot(result, contextId, opts = {}) {
    if (opts.includeSnapshot === false) return result
    if (this.config_ && this.config_.inlineSnapshot === false && opts.includeSnapshot !== true) {
      return result
    }
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
      // Inline look is best-effort; action outcome stands.
    }
    return result
  },

  /**
   * Apply the prompt-injection data-egress gate before confirmation gates.
   *
   * @param {string|null} action
   * @param {string} [contextId]
   * @returns {Promise<Record<string, any>>}
   */
  async _injectionGate(action, contextId) {
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
   * @param {Record<string, any>} gate
   * @param {Record<string, any>} [extra]
   * @returns {Record<string, any>}
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
   * Compute cumulative top-level viewport offset for a child iframe context.
   *
   * @param {string} topContext
   * @param {string} frameContext
   * @returns {Promise<{dx: number, dy: number, matched: boolean, rootContext?: string}>}
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

    /**
     * @param {Array<Record<string, any>>} nodes
     * @param {string} targetId
     * @param {Array<{node: Record<string, any>, index: number}>} [chain]
     * @returns {Array<{node: Record<string, any>, index: number}>|null}
     */
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
        const stepOffset = /** @type {Record<string, any>} */ (bidi.unwrapRemoteValue(raw))
        if (stepOffset && typeof stepOffset === 'object' && Number.isFinite(stepOffset.dx)) {
          dx += stepOffset.dx
          dy += stepOffset.dy
          matched = true
        }
      } catch {
        // Fall back to local coordinates if cross-realm lookup fails.
      }
    }

    return { dx, dy, matched, rootContext }
  },

  /**
   * Scroll the target element into view and re-read its center coordinates.
   *
   * @param {string} actionContext
   * @param {string} targetContext
   * @param {Record<string, any>} resolved
   * @param {Record<string, any>} fallbackInfo
   * @returns {Promise<{x: number, y: number, pointerContext: string}>}
   */
  async _scrollAndMeasure(actionContext, targetContext, resolved, fallbackInfo) {
    const frameOffset =
      actionContext !== targetContext
        ? await this._frameViewportOffset(targetContext, actionContext)
        : { dx: 0, dy: 0, matched: false }

    const raw = await bidi.callFunction(
      this.client,
      SCROLL_AND_MEASURE_SCRIPT,
      [
        { type: 'string', value: this._registryKey },
        { type: 'string', value: resolved.ref || '' },
        { type: 'string', value: resolved.selector || '' },
      ],
      actionContext,
    )
    const measured = /** @type {Record<string, any>} */ (bidi.unwrapRemoteValue(raw))
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
   * Helper for reporting a blocking modal dialog opened mid-input.
   *
   * @param {string} contextId
   * @param {Record<string, any>} [dialog]
   * @returns {Record<string, any>}
   */
  _abandonedByDialog(contextId, dialog) {
    return (
      this._dialogBlocked(contextId, dialog) ||
      fail(ERROR_CODES.DIALOG_OPEN, 'a modal dialog is open, so the page is blocked', {
        contextId,
      })
    )
  },

  /**
   * Click an element using trusted pointer input.
   *
   * @param {string} [selector]
   * @param {string} [contextId]
   * @param {Record<string, any>} [opts]
   */
  async click(selector, contextId, opts = {}) {
    return runElementAction(this, {
      selector,
      contextId,
      opts,
      inspect: true,
      requireNonZeroSize: true,
      gate: 'explicit',
      execute: async ({ target, actionContext, resolved, info }) => {
        const coords = await this._scrollAndMeasure(actionContext, target, resolved, info || {})
        const before = await this._pageState(actionContext)
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
          return this._abandonedByDialog(actionContext, sent.dialog)
        }

        const effect = await this._effect(actionContext, before)
        const dialogs = await this._settleDialogs(dialogEpoch)
        if (dialogs.length) effect.dialog = dialogs[0]
        return {
          ok: true,
          contextId: actionContext,
          ref: resolved.ref,
          selector: resolved.selector,
          via: resolved.via,
          x: coords.x,
          y: coords.y,
          effect,
        }
      },
    })
  },

  /**
   * Type text into an element using genuine keyboard events.
   *
   * @param {string|undefined} selector
   * @param {string} text
   * @param {string} [contextId]
   * @param {Record<string, any>} [opts]
   */
  async type(selector, text, contextId, opts = {}) {
    return runElementAction(this, {
      selector,
      contextId,
      opts,
      inspect: true,
      gate: 'none',
      execute: async ({ actionContext, resolved, info }) => {
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
          return this._abandonedByDialog(actionContext, sent.dialog)
        }

        let submitted = false
        if (opts.submit) {
          const injection = await this._injectionGate('form_submit', actionContext)
          if (!injection.allowed) {
            return this._injectionBlocked(injection, { contextId: actionContext })
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
          const enterSent = await inputs.pressKeys(this.client, {
            context: actionContext,
            keys: [inputs.encodeKey('Enter')],
            perform: (params) => this._performInput(params),
          })
          if (enterSent && enterSent.ok === false) {
            return this._abandonedByDialog(actionContext, enterSent.dialog)
          }
          submitted = true
        }

        const effect = await this._effect(actionContext, before)
        const dialogs = await this._settleDialogs(dialogEpoch)
        if (dialogs.length) effect.dialog = dialogs[0]
        return {
          ok: true,
          contextId: actionContext,
          ref: resolved.ref,
          selector: resolved.selector,
          via: resolved.via,
          typed: String(text ?? '').length,
          submitted,
          effect,
        }
      },
    })
  },

  /**
   * Press a key or key combination.
   *
   * @param {string} key
   * @param {string} [contextId]
   * @param {Record<string, any>} [opts]
   */
  async pressKey(key, contextId, opts = {}) {
    return runContextAction(this, contextId, opts, async ({ target }) => {
      const combo = inputs.encodeCombo(key)
      if (combo.error) {
        return fail(ERROR_CODES.INVALID_ARGUMENT, combo.error, { contextId: target })
      }

      if (isEnterKey(key)) {
        const active = await this._focusedFormContext(target)
        if (active.probeFailed) {
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

      const before = await this._pageState(target)
      const dialogEpoch = this._dialogEpoch
      const sent = await inputs.pressKeys(this.client, {
        context: target,
        keys: combo.keys,
        perform: (params) => this._performInput(params),
      })
      if (sent && sent.ok === false) {
        return this._abandonedByDialog(target, sent.dialog)
      }
      const effect = await this._effect(target, before)
      const dialogs = await this._settleDialogs(dialogEpoch)
      if (dialogs.length) effect.dialog = dialogs[0]
      return { ok: true, contextId: target, key, pressed: combo.keys.length, effect }
    })
  },

  /**
   * Gate an action whose irreversibility comes from implicit HTML form submission.
   *
   * @param {Record<string, any>} resolved
   * @param {string} contextId
   * @param {boolean} [confirm]
   * @returns {Promise<Record<string, any>|null>}
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
   * Inspect `document.activeElement` for implicit form submission checks.
   *
   * @param {string} contextId
   * @returns {Promise<{info: Record<string, any>|null, probeFailed: boolean}>}
   */
  async _focusedFormContext(contextId) {
    try {
      const info = await inspectActiveElement(this.client, { contextId })
      return { info, probeFailed: false }
    } catch {
      return { info: null, probeFailed: true }
    }
  },

  /**
   * Choose an option in a `<select>`.
   *
   * @param {string|undefined} selector
   * @param {string} value
   * @param {string} [contextId]
   * @param {Record<string, any>} [opts]
   */
  async selectOption(selector, value, contextId, opts = {}) {
    return runElementAction(this, {
      selector,
      contextId,
      opts,
      gate: 'implicit',
      execute: async ({ actionContext, resolved }) => {
        const result = await inputs.selectOption(this.client, {
          ...this._elementArgs(resolved),
          value,
          byText: opts.byText,
        })
        if (!result.ok) {
          return fail(classifyPageError(result), result.error || 'select failed', {
            contextId: actionContext,
            options: result.options,
          })
        }
        return {
          ok: true,
          contextId: actionContext,
          ref: resolved.ref,
          selector: resolved.selector,
          selected: result.selected,
          options: result.options,
          effect: { verified: true },
        }
      },
    })
  },

  /**
   * Check or uncheck a checkbox / radio button.
   *
   * @param {string|undefined} selector
   * @param {boolean} checked
   * @param {string} [contextId]
   * @param {Record<string, any>} [opts]
   */
  async check(selector, checked, contextId, opts = {}) {
    return runElementAction(this, {
      selector,
      contextId,
      opts,
      gate: 'implicit',
      execute: async ({ actionContext, resolved }) => {
        const result = await inputs.checkElement(this.client, {
          ...this._elementArgs(resolved),
          checked,
        })
        if (!result.ok) {
          return fail(classifyPageError(result), result.error || 'check failed', {
            contextId: actionContext,
          })
        }
        return {
          ok: true,
          contextId: actionContext,
          ref: resolved.ref,
          selector: resolved.selector,
          checked: result.checked,
          effect: { verified: result.checked === !!checked },
        }
      },
    })
  },

  /**
   * Hover over an element.
   *
   * @param {string} [selector]
   * @param {string} [contextId]
   * @param {Record<string, any>} [opts]
   */
  async hover(selector, contextId, opts = {}) {
    return runElementAction(this, {
      selector,
      contextId,
      opts,
      inspect: true,
      requireNonZeroSize: true,
      gate: 'none',
      execute: async ({ target, actionContext, resolved, info }) => {
        const coords = await this._scrollAndMeasure(actionContext, target, resolved, info || {})
        await inputs.pointerMove(this.client, {
          context: coords.pointerContext,
          x: coords.x,
          y: coords.y,
        })
        return {
          ok: true,
          contextId: actionContext,
          ref: resolved.ref,
          selector: resolved.selector,
          x: coords.x,
          y: coords.y,
          effect: { verified: true },
        }
      },
    })
  },

  /**
   * Scroll the page or bring an element into view.
   *
   * @param {string} [contextId]
   * @param {Record<string, any>} [opts]
   */
  async scroll(contextId, opts = {}) {
    return runContextAction(this, contextId, opts, async ({ target, setActionContext }) => {
      let selector = opts.selector
      let ref = ''
      let actionContext = target
      if (opts.ref || opts.match) {
        const resolution = await this._resolveActionTarget(opts.selector, target, {
          ref: opts.ref,
          match: opts.match,
        })
        if (!resolution.ok) {
          return { ...resolution, contextId: target }
        }
        selector = resolution.resolved.selector
        ref = resolution.resolved.ref || ''
        actionContext = resolution.resolved.contextId
        setActionContext(actionContext)
      }
      const result = await inputs.scroll(this.client, {
        context: actionContext,
        key: this._registryKey,
        ref,
        selector,
        direction: opts.direction,
        amount: opts.amount,
      })
      if (!result.ok) {
        return fail(classifyPageError(result), result.error || 'scroll failed', {
          contextId: actionContext,
        })
      }
      return {
        ok: true,
        contextId: actionContext,
        scrollY: result.scrollY,
        moved: result.moved,
        effect: { verified: !!result.moved },
      }
    })
  },

  /**
   * Upload a file to a file input.
   *
   * @param {string|undefined} selector
   * @param {string[]} paths
   * @param {string} [contextId]
   * @param {Record<string, any>} [opts]
   */
  async upload(selector, paths, contextId, opts = {}) {
    return runElementAction(this, {
      selector,
      contextId,
      opts,
      inspect: true,
      gate: 'explicit',
      egressKind: 'upload',
      execute: async ({ actionContext, resolved }) => {
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
        return {
          ok: true,
          contextId: actionContext,
          ref: resolved.ref,
          selector: resolved.selector,
          uploaded: paths.length,
          files: paths,
          effect: { verified: paths.length > 0 },
        }
      },
    })
  },
}
