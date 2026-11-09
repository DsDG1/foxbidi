// lib/firefox/provider/workflow.js
// Higher-level workflows: waiting, batching, helper scripts, handoff, config.
//
// The methods below were moved here verbatim from the single FirefoxProvider
// class. They stay prototype methods, so `this` means exactly what it meant
// before: the provider instance, with its client, registry key, log buffer
// and dialog manager.

/**
 * The workflow methods.
 *
 * @type an object of methods
 */
import * as bidi from '../../bidi/protocol.js'
import { ERROR_CODES, classifyError, fail } from '../errors.js'
import { MAX_ELEMENTS_LIMIT } from '../snapshot.js'
import * as waiter from '../wait.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { safeSerializable } from './helpers.js'

/**
 * The directories a page script may be read from.
 *
 * @returns {string[]}
 */
export function scriptRoots() {
  const roots = []
  const override = (process.env.FIREFOX_BROWSER_SCRIPT_ROOTS || '').trim()
  if (override) {
    for (const part of override.split(':')) {
      if (part.trim()) roots.push(resolve(part.trim()))
    }
  }
  const home = homedir()
  if (home) roots.push(join(home, '.mavis', 'ff-workspace'))
  return roots
}
/**
 * The tools a preset recommends.
 *
 * The plugin cannot reliably hide tools at runtime (the MCP tool list is sent
 * once, and the host may not support `tools/list_changed`), so a preset is
 * ADVICE: the SKILL tells the agent which tools a slim preset does not need.
 *
 * @param {string} preset
 * @returns {string[]}
 */
export function presetTools(preset) {
  const all = [
    'browser_start',
    'browser_stop',
    'browser_status',
    'browser_tabs',
    'browser_new_tab',
    'browser_navigate',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_press_key',
    'browser_select_option',
    'browser_check',
    'browser_hover',
    'browser_scroll',
    'browser_upload',
    'browser_wait_for',
    'browser_network',
    'browser_close_tab',
    'browser_handoff',
    'browser_text',
    'browser_evaluate',
    'browser_screenshot',
    'browser_logs',
    'browser_handle_dialog',
    'browser_context',
    'browser_extension',
    'browser_cookie',
    'browser_intercept',
    'browser_detectability',
    'browser_batch',
    'browser_run_script',
    'browser_config',
  ]
  if (preset === 'slim') {
    return all.filter(
      (name) =>
        ![
          'browser_press_key',
          'browser_check',
          'browser_hover',
          'browser_scroll',
          'browser_select_option',
          'browser_new_tab',
          'browser_close_tab',
          'browser_logs',
          'browser_upload',
        ].includes(name),
    )
  }
  if (preset === 'developer') {
    return all
  }
  return all
}
/**
 * A note about what a preset means.
 *
 * @param {string} preset
 * @returns {string[]}
 */
export function presetNotes(preset) {
  if (preset === 'slim') {
    return [
      'The slim preset does not remove any tool — it only marks the rarely needed ones as unnecessary.',
      'Prefer browser_batch over several single-action calls.',
    ]
  }
  return []
}

export const workflowMethods = {
  /**
   * Wait for a condition.
   *
   * @param {string} [contextId]
   * @param {object} opts
   * @param {string} [opts.for]       selector | text | load | networkIdle
   * @param {string} [opts.selector]
   * @param {string} [opts.text]
   * @param {number} [opts.timeoutMs]
   */
  async waitFor(contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    if (!target) return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')

    const kind = opts.for || 'load'
    let result
    try {
      if (kind === 'selector') {
        if (!opts.selector) {
          return fail(ERROR_CODES.INVALID_ARGUMENT, 'wait_for "selector" needs a selector argument')
        }
        result = await waiter.waitFor(this.client, {
          context: target,
          expression: waiter.selectorExpression(opts.selector),
          timeoutMs: opts.timeoutMs,
        })
      } else if (kind === 'text') {
        if (!opts.text) {
          return fail(ERROR_CODES.INVALID_ARGUMENT, 'wait_for "text" needs a text argument')
        }
        result = await waiter.waitFor(this.client, {
          context: target,
          expression: waiter.textExpression(opts.text),
          timeoutMs: opts.timeoutMs,
        })
      } else if (kind === 'networkIdle') {
        result = await waiter.waitForNetworkIdle(this.client, {
          context: target,
          log: this.networkLog,
          timeoutMs: opts.timeoutMs,
        })
      } else {
        result = await waiter.waitForLoad(this.client, {
          context: target,
          timeoutMs: opts.timeoutMs,
        })
      }
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: target })
    }

    if (!result.matched) {
      return fail(
        ERROR_CODES.INVALID_ARGUMENT,
        `timed out after ${result.elapsedMs}ms waiting for ${kind}`,
        {
          hint: 'The condition did not become true in time. Inspect the page or check the network log.',
          contextId: target,
          elapsedMs: result.elapsedMs,
          timeoutMs: result.timeoutMs,
        },
      )
    }
    return {
      ok: true,
      contextId: target,
      for: kind,
      elapsedMs: result.elapsedMs,
      timeoutMs: result.timeoutMs,
    }
  },
  /**
   * Hand the current page over to the other browser surface.
   *
   * There are two surfaces in play: this plugin's Firefox and the host's
   * in-app browser (`mcp_browser`). The in-app browser is owned by the host —
   * the plugin cannot drive it — so a handoff *to* it only produces the data
   * the agent needs to perform the step. A handoff *to* Firefox is something
   * this plugin can do itself.
   *
   * Neither direction carries session state: logins, cookies and tabs stay
   * on the surface they came from, and the guidance says so.
   *
   * @param {'in-app'|'firefox'} to
   * @param {object} [opts]
   * @param {string} [opts.url]        target URL (required for 'firefox')
   * @param {string} [opts.contextId]
   * @param {'url'|'url+summary'|'none'} [opts.carry]
   */
  async handoff(to, opts = {}) {
    if (to !== 'firefox' && to !== 'in-app') {
      return fail(ERROR_CODES.INVALID_ARGUMENT, `unknown handoff target: ${to}`)
    }
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(opts.contextId)
    if (!target) return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')

    if (to === 'firefox') {
      if (!opts.url) {
        return fail(ERROR_CODES.INVALID_ARGUMENT, 'a handoff to firefox needs a url', {
          hint: 'read the current url from the other surface first',
        })
      }
      const before = await this._pageState(target)
      const nav = await this.navigate(opts.url, target)
      if (!nav.ok) return fail(ERROR_CODES.INVALID_ARGUMENT, nav.error, { hint: nav.hint })
      const effect = await this._effect(target, before)
      return {
        ok: true,
        from: 'in-app',
        to: 'firefox',
        url: effect.url,
        title: effect.title,
        contextId: target,
        effect,
      }
    }

    const state = await this._pageState(target)
    const out = {
      ok: true,
      from: 'firefox',
      to: 'in-app',
      url: opts.url || state.url,
      title: state.title,
      contextId: target,
      guidance:
        'Navigate the in-app browser to this URL and continue there. ' +
        'Firefox session state (logins, cookies, tabs) does not travel with it.',
    }
    if (opts.carry === 'url+summary') {
      const snap = await this.snapshot(target, { maxElements: 20 })
      if (snap.ok) {
        out.summary = snap.elements.map((e) => `${e.role}:${e.name}`).join(' | ')
      }
    }
    return out
  },
  /**
   * Run a sequence of actions in one call.
   *
   * The point is fewer round trips: "click, type, snapshot" is three MCP
   * calls and three model turns when done one at a time, and one here.
   *
   * @param {Array<object>} steps
   * @param {object} [opts]
   */
  async batch(steps, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    if (!Array.isArray(steps) || !steps.length) {
      return fail(ERROR_CODES.INVALID_ARGUMENT, 'batch needs a non-empty steps array')
    }
    const stopOnError = opts.stopOnError !== false
    const results = []
    let failedAt = undefined

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] || {}
      const action = step.action
      let outcome
      try {
        outcome = await this._runBatchStep(action, step, opts.contextId)
      } catch (e) {
        outcome = fail(classifyError(e), e.message)
      }
      const entry = { index: i, action, ok: !!outcome.ok }
      if (outcome.ok) {
        if (outcome.effect) entry.effect = outcome.effect
        if (outcome.snapshot) entry.snapshot = outcome.snapshot
        for (const key of ['selected', 'checked', 'typed', 'scrollY', 'moved', 'url', 'title']) {
          if (outcome[key] !== undefined) entry[key] = outcome[key]
        }
      } else {
        entry.error = outcome.error
        if (outcome.hint) entry.hint = outcome.hint
        if (outcome.blocked) entry.blocked = true
        if (outcome.requiresConfirm) entry.requiresConfirm = true
        if (outcome.action) entry.action = outcome.action
        if (outcome.requiresResnapshot) entry.requiresResnapshot = true
      }
      results.push(entry)
      if (!outcome.ok && stopOnError) {
        failedAt = i
        break
      }
    }

    return {
      ok: failedAt === undefined,
      steps: results,
      completed: results.filter((r) => r.ok).length,
      failedAt,
      note:
        failedAt === undefined
          ? undefined
          : `stopped at step ${failedAt}; the steps before it already ran and were not rolled back`,
    }
  },
  /**
   * Run one step of a batch.
   *
   * @param {string} action
   * @param {object} step
   * @param {string} [contextId]
   */
  async _runBatchStep(action, step, contextId) {
    const ctx = step.contextId || contextId
    switch (action) {
      case 'click':
        return this.click(step.selector, ctx, {
          ref: step.ref,
          confirm: step.confirm,
          button: step.button,
          clickCount: step.clickCount,
        })
      case 'type':
        return this.type(step.selector, step.text, ctx, {
          ref: step.ref,
          clear: step.clear,
          submit: step.submit,
          confirm: step.confirm,
        })
      case 'press_key':
        return this.pressKey(step.key, ctx)
      case 'select_option':
        return this.selectOption(step.selector, step.value, ctx, {
          ref: step.ref,
          byText: step.byText,
        })
      case 'check':
        return this.check(step.selector, step.checked, ctx, { ref: step.ref })
      case 'hover':
        return this.hover(step.selector, ctx, { ref: step.ref })
      case 'scroll':
        return this.scroll(ctx, {
          ref: step.ref,
          selector: step.selector,
          direction: step.direction,
          amount: step.amount,
        })
      case 'wait_for':
        return this.waitFor(ctx, {
          for: step.for,
          selector: step.selector,
          text: step.text,
          timeoutMs: step.timeoutMs,
        })
      case 'navigate':
        return this.navigate(step.url, ctx, step.wait || 'complete')
      case 'snapshot': {
        const snap = await this.snapshot(ctx, {
          maxElements: step.maxElements,
          offset: step.offset,
          roleFilter: step.roleFilter,
          nameContains: step.nameContains,
          includeText: step.includeText,
          frames: step.frames,
        })
        if (!snap.ok) return snap
        return {
          ok: true,
          snapshot: {
            elements: snap.elements,
            count: snap.count,
            total: snap.total,
            nextOffset: snap.nextOffset,
            frames: snap.frames,
            texts: snap.texts,
          },
        }
      }
      default:
        return fail(ERROR_CODES.INVALID_ARGUMENT, `unknown batch action: ${action}`, {
          hint: 'Supported: click, type, press_key, select_option, check, hover, scroll, wait_for, navigate, snapshot.',
        })
    }
  },
  /**
   * Run a JavaScript file in the page.
   *
   * This is the browser-harness pattern: the agent writes a small helper for
   * something it keeps doing, and the helper stays on disk for the next task.
   *
   * @param {string} path
   * @param {object} [opts]
   */
  async runScript(path, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const allowed = scriptRoots()
    const resolvedPath = resolve(String(path || ''))
    if (!allowed.some((root) => resolvedPath === root || resolvedPath.startsWith(root + '/'))) {
      return fail(ERROR_CODES.INVALID_ARGUMENT, 'path_not_allowed', {
        hint: `Scripts may only be read from: ${allowed.join(', ')}`,
      })
    }
    let source
    try {
      const { readFileSync } = await import('node:fs')
      source = readFileSync(resolvedPath, 'utf8')
    } catch (e) {
      return fail(ERROR_CODES.INVALID_ARGUMENT, `cannot read script: ${e.message}`)
    }

    const target = await this._resolveContext(opts.contextId)
    if (!target) return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')
    try {
      // The file holds a function expression (a leading "return" is
      // tolerated). It is called with the arguments and its return value
      // comes back. `new Function` keeps the plugin from having to trust
      // the file with anything but a string.
      const result = await bidi.callFunction(
        this.client,
        `(body, argsJson) => {
          const source = String(body || '').trim().replace(/^return\\s+/, '');
          const args = argsJson ? JSON.parse(argsJson) : {};
          const factory = new Function('return (' + source + ')');
          const fn = factory();
          if (typeof fn !== 'function') {
            return { __ffbError: 'the script must evaluate to a function' };
          }
          return fn(args);
        }`,
        [
          { type: 'string', value: source },
          { type: 'string', value: JSON.stringify(opts.args || {}) },
        ],
        target,
        { awaitPromise: true },
      )
      const value = bidi.unwrapRemoteValue(result)
      if (value && typeof value === 'object' && value.__ffbError) {
        return fail(ERROR_CODES.PATH_NOT_ALLOWED, value.__ffbError, { path: resolvedPath })
      }
      return {
        ok: true,
        contextId: target,
        path: resolvedPath,
        result: safeSerializable(value),
      }
    } catch (e) {
      return fail(classifyError(e), e.message, { path: resolvedPath })
    }
  },
  /**
   * Read or change the plugin's runtime configuration.
   *
   * @param {object} opts
   */
  async config(opts = {}) {
    const changed = {}
    if (opts.preset && !['slim', 'basic', 'developer', 'all'].includes(opts.preset)) {
      return fail(ERROR_CODES.INVALID_ARGUMENT, `unknown preset: ${opts.preset}`)
    }
    if (opts.preset) {
      this.config_.preset = opts.preset
      changed.preset = opts.preset
    }
    if (opts.dialogPolicy) {
      if (!this.dialogs.setPolicy(opts.dialogPolicy)) {
        return fail(ERROR_CODES.INVALID_ARGUMENT, `unknown dialog policy: ${opts.dialogPolicy}`)
      }
      this.config_.dialogPolicy = opts.dialogPolicy
      changed.dialogPolicy = opts.dialogPolicy
    }
    if (opts.maxSnapshotElements) {
      const value = Math.min(MAX_ELEMENTS_LIMIT, Math.max(1, opts.maxSnapshotElements))
      this.config_.maxSnapshotElements = value
      changed.maxSnapshotElements = value
    }
    return {
      ok: true,
      ...this.config_,
      changed,
      effectiveTools: presetTools(this.config_.preset),
      notes: presetNotes(this.config_.preset),
    }
  },
}
