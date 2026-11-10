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
import { CAPABILITY_TOOLS, PRESET_CAPABILITIES, capabilityOf } from '../tool-capabilities.js'
import * as waiter from '../wait.js'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { safeSerializable } from './helpers.js'
import { resolveNavigation } from './helpers.js'
import { applyPrefsScript, validatePrefs } from '../prefs.js'
import { setProfilePrefs } from '../profile.js'

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
 * Resolve a script path against the allow-list, following symbolic links.
 *
 * WHY THIS EXISTS
 *
 * The obvious check — `resolve(path)` plus a string prefix comparison — is
 * NOT a boundary. `resolve()` only normalises the string; it never touches the
 * filesystem, so a symlink inside an allowed root still "looks" like it is
 * inside that root. A file at `~/.mavis/ff-workspace/evil.js` pointing at
 * `/etc/passwd` passes the prefix check, and the subsequent `readFileSync`
 * follows the link and reads the target.
 *
 * So the comparison is done on REAL paths: both the candidate and every
 * allowed root are passed through `realpathSync`, which resolves every link
 * in the chain. A root that is itself a symlink is fine — realpath'ing the
 * root handles that — but a FILE inside the root that points outside it is
 * caught, because its real path no longer starts with the root's real path.
 *
 * The rejected path is deliberately NOT echoed back in the error: telling the
 * caller where the link pointed would hand the attacker a probe oracle.
 *
 * @param {string} path        the requested path
 * @param {string[]} allowed   the allow-list roots
 * @returns {{ok: true, path: string} | {ok: false, reason: 'not_allowed'|'unresolvable', error?: string}}
 */
export function resolveScriptPath(path, allowed) {
  const requested = resolve(String(path || ''))

  // The STRING check comes first, exactly as it always did. It is cheap, it
  // touches no filesystem, and it keeps the error semantics stable: a path
  // that is plainly outside the roots is "path_not_allowed" whether or not
  // the file happens to exist.
  const literalAllowed = allowed.some(
    (root) => requested === root || requested.startsWith(root + '/'),
  )
  if (!literalAllowed) {
    return { ok: false, reason: 'not_allowed' }
  }

  // The path LOOKS like it is inside a root. Now resolve every symbolic
  // link in it — and in the roots — and check again. A file inside the
  // workspace that points outside it fails here.
  let realRequested
  try {
    realRequested = realpathSync(requested)
  } catch (e) {
    // A missing file, a broken link, or a permission problem. None of these
    // can be read, so there is nothing to allow.
    return { ok: false, reason: 'unresolvable', error: e.message }
  }

  for (const root of allowed) {
    let realRoot
    try {
      realRoot = realpathSync(root)
    } catch {
      // The root does not exist (yet). It cannot contain a readable script,
      // so it contributes nothing to the allow-list.
      continue
    }
    if (realRequested === realRoot || realRequested.startsWith(realRoot + '/')) {
      return { ok: true, path: realRequested }
    }
  }

  return { ok: false, reason: 'not_allowed' }
}
/**
 * The tools a preset exposes.
 *
 * The list is a SUBSET of the full catalogue, in the catalogue's own order.
 * Three rules govern it:
 *
 *   1. `browser_config` is always present. It is the only way to switch
 *      back to a wider preset, so a preset that dropped it would strand
 *      the agent without the tools it needs. It lives in the `core`
 *      capability, which every preset includes.
 *   2. The relative order of the retained tools never changes. The host
 *      injects the catalogue as a prompt-cache prefix, so reordering
 *      would invalidate the cache for everything after the first move.
 *   3. Membership is decided by CAPABILITY, not by a list of names. A
 *      hand-written list had to be kept in step with the catalogue by a
 *      test — it drifted once already, silently dropping six tools from
 *      the "all" preset — and a second copy of the catalogue is a
 *      liability. Now a tool's capability is declared next to the tool
 *      itself, and adding a tool cannot leave it out of a preset.
 *
 * The catalogue order is passed in, because this module does not know it:
 * the order lives with the tool definitions, and the MCP layer owns them.
 *
 * @param {string} preset
 * @param {string[]} [catalogue] the tool names, in catalogue order
 * @returns {string[]}
 */
export function presetTools(preset, catalogue = Object.values(CAPABILITY_TOOLS).flat()) {
  const allowed = new Set(PRESET_CAPABILITIES[preset] || PRESET_CAPABILITIES.slim)
  return catalogue.filter((name) => allowed.has(capabilityOf(name)))
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
      'The slim preset exposes only the tools a normal browsing task needs.',
      'Use browser_config to widen it to basic or developer if the task turns out to need more.',
      'Prefer browser_batch over several single-action calls.',
    ]
  }
  if (preset === 'basic') {
    return [
      'The basic preset hides the diagnostic and automation tools.',
      'Use browser_config to widen it to developer if the task turns out to need more.',
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
        return this.pressKey(step.key, ctx, { confirm: step.confirm })
      case 'select_option':
        return this.selectOption(step.selector, step.value, ctx, {
          ref: step.ref,
          byText: step.byText,
          confirm: step.confirm,
        })
      case 'check':
        return this.check(step.selector, step.checked, ctx, {
          ref: step.ref,
          confirm: step.confirm,
        })
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
    const resolved = resolveScriptPath(path, allowed)
    if (!resolved.ok) {
      if (resolved.reason === 'not_allowed') {
        return fail(ERROR_CODES.PATH_NOT_ALLOWED, 'path_not_allowed', {
          hint: `Scripts may only be read from: ${allowed.join(', ')}`,
        })
      }
      return fail(ERROR_CODES.INVALID_ARGUMENT, `cannot read script: ${resolved.error}`)
    }
    const resolvedPath = resolved.path
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
    if (typeof opts.inlineSnapshot === 'boolean') {
      this.config_.inlineSnapshot = opts.inlineSnapshot
      changed.inlineSnapshot = opts.inlineSnapshot
    }
    if (opts.timeoutMs !== undefined) {
      const value = Number(opts.timeoutMs)
      if (!Number.isFinite(value) || value < 1000 || value > 600000) {
        return fail(
          ERROR_CODES.INVALID_ARGUMENT,
          'timeoutMs must be a number between 1000 and 600000',
        )
      }
      // The live client captured the timeout when it was built, so both
      // places have to move — otherwise the new value would only take
      // effect after the next start.
      this.opts.timeoutMs = value
      if (this.client) this.client.timeoutMs = value
      changed.timeoutMs = value
    }
    return {
      ok: true,
      ...this.config_,
      timeoutMs: this.opts.timeoutMs,
      changed,
      effectiveTools: presetTools(this.config_.preset, this._toolCatalogue),
      notes: presetNotes(this.config_.preset),
    }
  },
  /**
   * Set Firefox preferences while the plugin runs.
   *
   * Two things happen here, and they are not the same thing:
   *
   *   - The values are written into the PROFILE COPY's `user.js`. Firefox
   *     reads that file at startup, so they apply to the NEXT start. This
   *     always works.
   *   - With `applyNow`, they are also set in the RUNNING browser through a
   *     privileged context, so they take effect immediately. That needs
   *     Firefox to have been started with `--remote-enable-system-access`;
   *     without it the values are still written, and the result says so.
   *
   * Only the copy is written. The user's real profile is never touched.
   *
   * @param {object} prefs
   * @param {object} [opts]
   * @param {boolean} [opts.applyNow]
   */
  async applyPrefs(prefs, opts = {}) {
    const { valid, invalid } = validatePrefs(prefs)
    if (invalid.length && !Object.keys(valid).length) {
      return fail(ERROR_CODES.INVALID_ARGUMENT, invalid[0].error, { failed: invalid })
    }

    // Remember them: the profile copy's user.js is overwritten from the
    // source profile on every start, so the values have to be re-applied
    // after each copy.
    Object.assign(this._runtimePrefs, valid)

    const applied = []
    const pendingRestart = []
    const failed = [...invalid]

    // Write them into the copy, if there is one.
    if (this.copyDir) {
      const written = setProfilePrefs(this.copyDir, this._runtimePrefs)
      if (written.ok) {
        applied.push(...written.applied)
      } else {
        failed.push({ name: '*', error: written.error })
      }
    } else {
      // No copy yet — the values are remembered and will be written when
      // the browser next starts.
      pendingRestart.push(...Object.keys(valid))
    }

    let appliedNow = []
    if (opts.applyNow && Object.keys(valid).length) {
      const immediate = await this._applyPrefsNow(valid)
      if (immediate.ok) {
        appliedNow = immediate.applied
      } else {
        // The values are NOT lost: they are already in the copy and in
        // `_runtimePrefs`, so a restart still applies them.
        failed.push({ name: '*', error: immediate.error })
        return {
          ...immediate,
          applied,
          appliedNow,
          pendingRestart,
          failed,
          hint:
            immediate.hint ||
            'The preferences were written to the profile copy and will apply on the next browser_restart.',
        }
      }
    }

    return {
      ok: true,
      applied,
      appliedNow,
      pendingRestart,
      failed,
      prefs: { ...this._runtimePrefs },
      timeoutMs: this.opts.timeoutMs,
      // The hint has to be exact here. Firefox reads user.js at startup, so a
      // preference written into the copy is NOT in effect until the browser
      // restarts — saying otherwise would send the agent off believing the
      // change already took.
      hint: appliedNow.length
        ? 'The preferences were applied to the running browser and written to the profile copy, so they survive a restart.'
        : pendingRestart.length
          ? 'The preferences are remembered and will be written when the browser next starts. Run browser_restart to make them take effect now.'
          : 'The preferences were written to the profile copy. Firefox reads them at startup — run browser_restart to make them take effect.',
    }
  },
  /**
   * Set preferences in the RUNNING browser.
   *
   * A privileged context is needed, which means Firefox must have been
   * started with `--remote-enable-system-access` (FIREFOX_BROWSER_PRIVILEGED=1).
   *
   * @param {object} prefs
   */
  async _applyPrefsNow(prefs) {
    const caps = await this._ensureCapabilities()
    if (!caps.features.privilegedContext) {
      return fail(
        ERROR_CODES.PRIVILEGED_UNAVAILABLE,
        'this Firefox was not started with system access, so preferences cannot be set in the running browser',
        {
          hint:
            'Start Firefox with FIREFOX_BROWSER_PRIVILEGED=1 to enable immediate preference changes. ' +
            'Without it the values are written to the profile copy and apply on the next browser_restart.',
        },
      )
    }
    let contextId = null
    try {
      contextId = await bidi.createTab(this.client)
      const nav = resolveNavigation('about:config', { exempt: true })
      await bidi.navigate(this.client, nav.url, contextId, 'complete')
      const result = await bidi.evaluate(this.client, applyPrefsScript(prefs), contextId, {
        awaitPromise: true,
      })
      const value = bidi.unwrapRemoteValue(result) || {}
      return {
        ok: true,
        applied: Array.isArray(value.applied) ? value.applied : [],
        failed: Array.isArray(value.failed) ? value.failed : [],
      }
    } catch (e) {
      return fail(classifyError(e), e.message)
    } finally {
      if (contextId) {
        try {
          await bidi.closeTab(this.client, contextId)
        } catch {
          /* best effort */
        }
      }
    }
  },
  /**
   * Restart the browser.
   *
   * This is what makes a written preference take effect: the profile copy's
   * `user.js` is read at startup, so the browser has to come back up. It
   * saves the agent from having to restart the whole plugin process.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.keepProfile] keep the profile copy (default true)
   */
  async restart(opts = {}) {
    const wasRunning = this.ready || !!this.pid
    if (wasRunning) {
      // A restart has to be a REAL restart: a kept-alive instance would come
      // back with the preferences it already read. The proxy stays up —
      // its port is in those preferences.
      await this.stop({ kill: true, keepEgress: true })
    }
    const started = await this.start()
    return {
      ok: started.ok !== false,
      restarted: true,
      wasRunning,
      pid: this.pid,
      port: this.port,
      sessionId: this.sessionId,
      profile: this.profileInfo,
      ...(started.ok === false ? { code: started.code, error: started.error } : {}),
    }
  },
}
