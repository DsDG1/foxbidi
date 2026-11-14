// lib/firefox/provider/inspect.js
// Inspection: snapshots, text, evaluation and screenshots.
//
// The methods below were moved here verbatim from the single FirefoxProvider
// class. They stay prototype methods, so `this` means exactly what it meant
// before: the provider instance, with its client, registry key, log buffer
// and dialog manager.

/**
 * The inspect methods.
 *
 * @satisfies {Record<string, Function> & ThisType<import("../provider.js").FirefoxProviderBase>}
 */
import * as bidi from '../../bidi/protocol.js'
import { ERROR_CODES, classifyError, fail } from '../errors.js'
import { capabilityError } from '../capabilities.js'
import { evaluateGate, ACTION_KINDS } from '../confirm.js'
import { ensureRegistry, frameLabel, REF_MODE } from '../registry.js'
import { redactObject, redactText } from '../redact.js'
import { resolveSharedId } from '../selector.js'
import {
  takeSnapshot,
  diffSnapshots,
  formatCompactSnapshot,
  prioritizeInlineElements,
  DEFAULT_MAX_ELEMENTS,
  MAX_ELEMENTS_LIMIT,
} from '../snapshot.js'
import { VISIBILITY_SCRIPT } from '../visibility.js'
import { buildProvenance, originOf } from '../provenance.js'
import { hasHighSeverityWarning } from '../injection-gate.js'
import { DEFAULT_MAX_TEXT_CHARS, DEFAULT_MAX_EVALUATE_CHARS } from './constants.js'
import { safeSerializable } from './helpers.js'

/**
 * How many warnings one page may contribute.
 */
const MAX_PAGE_WARNINGS = 20

/**
 * How many elements an INLINE snapshot carries.
 */
const INLINE_MAX_ELEMENTS = 60

/**
 * Candidate scan window for inline snapshots so newly opened dialogs,
 * delta-added controls, and elements near the acted point are captured
 * even when global navigation menus occupy the first 60 DOM nodes.
 */
const INLINE_SCAN_WINDOW = 240

/**
 * How long an element's name may be in an inline snapshot.
 */
const INLINE_NAME_LIMIT = 60

export const inspectMethods = {
  /**
   * Resolve the known origin for a browsing context without leaking query strings.
   *
   * @param {string} [contextId]
   * @returns {string}
   */
  _originForContext(contextId) {
    const url = (this._tabUrls && contextId && this._tabUrls.get(contextId)) || this._lastUrl || ''
    return originOf(url)
  },
  /**
   * Scan the page for content that is hidden from a human but present in
   * the DOM, and for instruction-shaped text.
   *
   * @param {string} contextId
   * @returns {Promise<{ok: boolean, warnings: Array<Record<string, any>>, signals: Array<Record<string, any>>, hidden: Array<Record<string, any>>}>}
   */
  async _visibilityScan(contextId) {
    const empty = { ok: false, warnings: [], signals: [], hidden: [] }
    let raw
    try {
      const remote = await bidi.evaluate(this.client, `(${VISIBILITY_SCRIPT})()`, contextId)
      raw = /** @type {Record<string, any>} */ (bidi.unwrapRemoteValue(remote))
    } catch {
      return empty
    }
    if (!raw || typeof raw !== 'object') return empty
    if (raw.error) return empty

    const hidden = Array.isArray(raw.hidden) ? raw.hidden : []
    const ariaHidden = Array.isArray(raw.ariaHidden) ? raw.ariaHidden : []
    const named = Array.isArray(raw.named) ? raw.named : []
    const origin = this._originForContext(contextId)

    const warnings = []
    const signals = []
    const seenSignal = new Set()

    /**
     * @param {string} text
     * @param {string[]} reasons
     */
    const judge = (text, reasons) => {
      const prov = buildProvenance({ origin, hiddenReasons: reasons, text })
      for (const w of prov.warnings) warnings.push(w)
      for (const s of prov.signals) {
        const key = `${s.kind}::${s.excerpt}`
        if (seenSignal.has(key)) continue
        seenSignal.add(key)
        signals.push(s)
      }
    }

    for (const node of hidden) {
      judge(String(node.text || ''), Array.isArray(node.reasons) ? node.reasons : [])
    }
    for (const node of ariaHidden) {
      judge(String(node.text || ''), Array.isArray(node.reasons) ? node.reasons : [])
    }
    for (const el of named) {
      judge(String(el.name || ''), Array.isArray(el.reasons) ? el.reasons : [])
    }

    return {
      ok: true,
      warnings: warnings.slice(0, MAX_PAGE_WARNINGS),
      signals,
      hidden,
    }
  },
  /**
   * Publish a scan result on the provider.
   *
   * @param {{ok: boolean, warnings: Array<Record<string, any>>, signals: Array<Record<string, any>>}} scan
   */
  _applyScan(scan) {
    if (this._state) {
      this._state.applyScan(scan)
      return
    }
    if (!scan || !scan.ok) return
    this._pageWarnings = scan.warnings
    this._pageSignals = scan.signals
  },
  /**
   * Does the current page carry a high-severity warning?
   *
   * @returns {boolean}
   */
  _hasHighSeverityWarning() {
    return hasHighSeverityWarning(this._pageWarnings || [])
  },
  /**
   * Take a LIGHT snapshot of the page, to ride along with an action.
   *
   * Prioritizes newly added/changed controls, dialog landmarks, and viewport
   * elements near the just-acted target while keeping each record strictly
   * `{ref, role, name}` and never disturbing `_snapshotSeq` or delta baselines.
   *
   * @param {string} contextId
   * @param {Record<string, any>} [opts]
   * @returns {Promise<{elements: Array<Record<string, any>>, truncated: boolean, error?: string}>}
   */
  async _inlineSnapshot(contextId, opts = {}) {
    const empty = { elements: [], truncated: false }
    try {
      const maxElements = Math.min(
        INLINE_MAX_ELEMENTS,
        Math.max(1, opts.maxElements || INLINE_MAX_ELEMENTS),
      )
      const scanCap = Math.min(INLINE_SCAN_WINDOW, Math.max(maxElements, maxElements * 4))
      const legacy = !(await ensureRegistry(this.client, contextId, this._registryKey))
      const result = await takeSnapshot(this.client, {
        contextId,
        key: this._registryKey,
        maxElements: scanCap,
        legacy,
      })
      const baseline = this._state
        ? this._state.contextBaseline(contextId)
        : (this._snapshotByContext && this._snapshotByContext.get(contextId)) ||
          this._lastSnapshotElements
      const anchorRect = this._state ? this._state.getActedPoint(contextId) : null
      const elements = prioritizeInlineElements(result.elements, {
        limit: maxElements,
        nameLimit: INLINE_NAME_LIMIT,
        baseline,
        anchorRect,
      })
      return {
        elements,
        truncated: !!result.hasMore || result.elements.length > maxElements,
      }
    } catch (e) {
      return { ...empty, error: e && e.message ? e.message : String(e) }
    }
  },
  /**
   * Take an ARIA-style snapshot of the page.
   *
   * Supports:
   *   - `format: 'compact' | 'records'` — `'compact'` attaches `tree`, a
   *     landmark-grouped DSL (`[main]\n  e0 button "Submit"`) that cuts
   *     observation tokens by ~70%.
   *   - `deltaOnly: true` (with `since`) — omits the full `elements` array
   *     and returns only `delta` + `unchanged`, ideal for polling/re-observation.
   *
   * @param {string} [contextId]
   * @param {Record<string, any>} [opts]
   */
  async snapshot(contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    if (!target) return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')
    const since = typeof opts.since === 'number' && Number.isFinite(opts.since) ? opts.since : null
    const format =
      opts.format === 'compact' || opts.format === 'records'
        ? opts.format
        : (this.config_ && this.config_.snapshotFormat) || 'records'
    const deltaOnly = opts.deltaOnly === true && since !== null
    try {
      const maxElements = Math.min(
        MAX_ELEMENTS_LIMIT,
        Math.max(
          1,
          opts.maxElements ||
            (this.config_ && this.config_.maxSnapshotElements) ||
            DEFAULT_MAX_ELEMENTS,
        ),
      )
      const legacy = !(await ensureRegistry(this.client, target, this._registryKey))
      this._refMode = legacy ? REF_MODE.ATTRIBUTE : REF_MODE.REGISTRY

      const result = await takeSnapshot(this.client, {
        contextId: target,
        key: this._registryKey,
        maxElements,
        offset: opts.offset,
        roleFilter: opts.roleFilter,
        nameContains: opts.nameContains,
        includeText: opts.includeText,
        legacy,
      })

      // Resolve any `since` baseline BEFORE recording the new snapshot baseline.
      const prevBaseline =
        since !== null
          ? this._state
            ? this._state.resolveBaseline(target, since)
            : (this._snapshotBaselines && this._snapshotBaselines.get(since)) ||
              (this._snapshotByContext && this._snapshotByContext.get(target)) ||
              this._lastSnapshotElements
          : null

      const snapshotId = this._state
        ? this._state.recordBaseline(target, result.elements)
        : ((this._snapshotSeq += 1),
          (this._lastSnapshotElements = result.elements),
          this._snapshotSeq)
      this._lastContextId = target

      /** @type {Record<string, any>} */
      const payload = {
        ok: true,
        contextId: target,
        snapshotId,
        count: result.elements.length,
        total: result.total,
        truncated: result.truncated,
        hasMore: result.hasMore,
        nextOffset: result.nextOffset,
        refMode: this._refMode,
      }
      if (!deltaOnly) {
        if (format === 'compact') {
          payload.tree = formatCompactSnapshot(result.elements)
          payload.format = 'compact'
        } else {
          payload.elements = result.elements
        }
      }
      if (result.texts) {
        payload.texts = result.texts.map((t) => redactText(t))
      }

      if (opts.frames && opts.frames !== 'none') {
        const frames = await this._snapshotFrames(target, maxElements, legacy)
        payload.frames = frames
        payload.count += frames.reduce((sum, f) => sum + (f.elementCount || 0), 0)
      }

      const scan = await this._visibilityScan(target)
      this._applyScan(scan)
      payload.source = {
        origin: this._originForContext(target),
        kind: 'page_content',
        trusted: false,
      }
      payload.signals = scan.signals
      payload.warnings = scan.warnings

      if (since !== null && prevBaseline && prevBaseline.length) {
        const diff = diffSnapshots(prevBaseline, result.elements)
        const unchanged =
          diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0
        payload.delta = {
          since,
          added: format === 'compact' ? undefined : diff.added,
          changed: format === 'compact' ? undefined : diff.changed,
          addedTree:
            format === 'compact' && diff.added.length
              ? formatCompactSnapshot(diff.added)
              : undefined,
          changedTree:
            format === 'compact' && diff.changed.length
              ? formatCompactSnapshot(diff.changed)
              : undefined,
          removed: diff.removed,
        }
        if (format !== 'compact') {
          delete payload.delta.addedTree
          delete payload.delta.changedTree
        } else {
          payload.delta.added = diff.added
          payload.delta.changed = diff.changed
        }
        if (deltaOnly) {
          payload.unchanged = unchanged
        }
      } else if (deltaOnly) {
        payload.unchanged = false
        if (format === 'compact') {
          payload.tree = formatCompactSnapshot(result.elements)
        } else {
          payload.elements = result.elements
        }
      }

      return payload
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: target })
    }
  },
  /**
   * Snapshot the child frames of a context.
   *
   * Each frame is a separate browsing context with its own realm, so it needs
   * its own registry instance — the same key works, because each realm has
   * its own `window`. Refs from a frame carry the frame's label so an action
   * can be routed back to it.
   *
   * @param {string} parentContextId
   * @param {number} maxElements
   * @param {boolean} legacy
   * @returns {Promise<Array<{frameId: string, url: string, elementCount: number}>>}
   */
  async _snapshotFrames(parentContextId, maxElements, legacy) {
    const frames = []
    let tree
    try {
      tree = await bidi.getTree(this.client)
    } catch {
      return frames
    }

    const children = []
    const collectDescendants = (nodes) => {
      for (const child of nodes || []) {
        children.push(child)
        if (child.children && child.children.length) {
          collectDescendants(child.children)
        }
      }
    }
    const collect = (nodes) => {
      for (const node of nodes || []) {
        if (node.contextId === parentContextId) {
          collectDescendants(node.children || [])
          return
        }
        if (node.children) collect(node.children)
      }
    }
    collect(tree)

    for (const child of children) {
      if (!child || !child.contextId) continue
      const label = frameLabel(child.contextId)
      this._frameMap.set(label, child.contextId)
      try {
        if (!legacy) await ensureRegistry(this.client, child.contextId, this._registryKey)
        const frameSnap = await takeSnapshot(this.client, {
          contextId: child.contextId,
          key: this._registryKey,
          maxElements,
          legacy,
        })
        // Prefix the frame's refs so the agent can tell them apart and the
        // action can be routed to the right context.
        for (const element of frameSnap.elements) {
          element.ref = `${label}:${element.ref}`
          element.frameId = label
        }
        frames.push({
          frameId: label,
          contextId: child.contextId,
          url: child.url || '',
          elementCount: frameSnap.elements.length,
          elements: frameSnap.elements,
        })
      } catch {
        // A frame we cannot reach is skipped, not fatal.
      }
    }
    return frames
  },
  /**
   * Capture a screenshot (base64 PNG).
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {boolean} [opts.fullPage]
   * @param {string} [opts.elementRef]
   */
  async screenshot(contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    try {
      let elementSharedId = null
      if (opts.elementRef) {
        const resolution = await this._resolveActionTarget(null, target, {
          ref: opts.elementRef,
        })
        if (!resolution.ok) {
          return { ...resolution, contextId: target }
        }
        const resolved = resolution.resolved
        elementSharedId = await resolveSharedId(this.client, {
          contextId: resolved.contextId,
          selector: resolved.selector,
          ref: resolved.ref,
          key: this._registryKey,
        })
        if (!elementSharedId) {
          return fail(
            ERROR_CODES.INVALID_ARGUMENT,
            `could not resolve an element for ref "${opts.elementRef}"`,
            { contextId: target },
          )
        }
      }
      const data = await bidi.screenshot(this.client, target, {
        fullPage: opts.fullPage,
        elementSharedId,
      })
      const result = {
        ok: true,
        contextId: target,
        data,
        encoding: 'base64',
        mimeType: 'image/png',
        fullPage: !!opts.fullPage,
      }
      // Publish the PNG behind a loopback URL so a chat client can render it.
      // The image bytes stay out of the model's context — the model only ever
      // sees the short URL, which it can hand to the user.
      try {
        const published = await this.images.publish(data)
        result.imageUrl = published.url
        result.imageBytes = published.bytes
      } catch (e) {
        // The screenshot itself succeeded; only the URL is missing.
        result.imageUrlError = e.message
      }
      return result
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: target })
    }
  },
  /**
   * Evaluate JavaScript in the page.
   *
   * The result is bounded: a page can return an arbitrarily large value,
   * and everything it returns enters the model's context verbatim.
   *
   * @param {string} expression
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {number} [opts.maxChars]  cap on the returned value
   * @param {boolean} [opts.confirm]
   */
  async evaluate(expression, contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    const maxChars = opts.maxChars === undefined ? DEFAULT_MAX_EVALUATE_CHARS : opts.maxChars

    // browser_evaluate can run anything in the page, including a fetch
    // that exfiltrates what it just read. On a page with a high-severity
    // warning it needs an explicit confirmation.
    //
    // This is the FIRST level, not the hard block: evaluate is also the
    // normal diagnostic tool, and blocking it outright would leave the
    // agent with no way to investigate the page it was blocked on.
    if (this._hasHighSeverityWarning() && opts.confirm !== true) {
      return fail(
        ERROR_CODES.CONFIRM_REQUIRED,
        'this page carries a hidden instruction, so evaluating arbitrary expressions needs explicit confirmation',
        {
          hint: 'Pass confirm: true to run this expression on a page that contains a hidden instruction.',
          blocked: true,
          action: 'evaluate',
          requiresConfirm: true,
          contextId: target,
          warnings: this._pageWarnings || [],
        },
      )
    }

    try {
      const remote = await bidi.evaluate(this.client, expression, target)
      const value = bidi.unwrapRemoteValue(remote)

      // A page-side exception arrives as `type:"exception"`; unwrap turns
      // it into a marker object. Report it as a failure instead of
      // returning `ok:true` with a missing value.
      if (value && typeof value === 'object' && value.__exception === true) {
        return fail(
          ERROR_CODES.EVALUATE_FAILED,
          value.text || 'the page script raised an exception',
          {
            contextId: target,
            hint: 'The expression threw inside the page. Fix the expression and try again.',
          },
        )
      }

      // A string result is page content too — redact it like browser_text,
      // then bound it. A structured value is returned as-is: truncating
      // JSON would produce something the agent cannot parse.
      let out = value
      let redacted = false
      let truncated = false
      let length
      if (typeof value === 'string') {
        const safe = redactText(value)
        redacted = safe !== value
        length = value.length
        if (safe.length > maxChars) {
          out = safe.slice(0, maxChars)
          truncated = true
        } else {
          out = safe
        }
      } else if (value && typeof value === 'object') {
        const serializable = safeSerializable(value)
        out = redactObject(serializable)
        redacted = JSON.stringify(out) !== JSON.stringify(serializable)
      }

      const scan = await this._visibilityScan(target)
      this._applyScan(scan)

      return {
        ok: true,
        contextId: target,
        value: out,
        length,
        redacted,
        truncated,
        source: {
          origin: this._originForContext(target),
          kind: 'page_content',
          trusted: false,
        },
        signals: scan.signals,
        warnings: scan.warnings,
      }
    } catch (e) {
      if (e && e.code === ERROR_CODES.EVALUATE_FAILED) {
        return fail(ERROR_CODES.EVALUATE_FAILED, e.message, {
          contextId: target,
          hint: 'The expression threw inside the page. Fix the expression and try again.',
        })
      }
      return fail(classifyError(e), e.message, { contextId: target })
    }
  },

  /**
   * Override the tab's viewport.
   *
   * This is how you test a responsive layout without resizing the window:
   * the page sees a viewport of exactly the given size, whatever the real
   * window is.
   *
   * Changing the viewport changes how the page renders and can lose form
   * state, so it sits behind the confirmation gate like the other actions
   * that alter what the user sees.
   *
   * @param {object} [opts]
   * @param {number} [opts.width]
   * @param {number} [opts.height]
   * @param {number} [opts.devicePixelRatio]
   * @param {string} [contextId]
   * @param {boolean} [confirm]
   * @returns {Promise<Record<string, any>>}
   */
  async setViewport(opts = {}, contextId, confirm) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    if (!target) return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')

    const width = Number(opts.width)
    const height = Number(opts.height)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return fail(
        ERROR_CODES.INVALID_ARGUMENT,
        'viewport width and height must be positive numbers',
        {
          contextId: target,
          hint: 'Pass width and height in CSS pixels, for example {"width": 390, "height": 844}.',
        },
      )
    }

    const caps = await this._ensureCapabilities()
    if (!caps.features.setViewport) {
      return capabilityError('setViewport', caps.browserVersion)
    }

    const gate = evaluateGate({
      action: ACTION_KINDS.VIEWPORT_SET,
      confirm: confirm === true,
      hint: `this resizes the viewport to ${width}x${height}, which re-lays-out the page`,
    })
    if (!gate.allowed) {
      return fail(ERROR_CODES.CONFIRM_REQUIRED, gate.error, {
        blocked: true,
        requiresConfirm: true,
        action: gate.action,
        hint: gate.hint,
        contextId: target,
      })
    }

    try {
      const dpr = opts.devicePixelRatio || 1
      await bidi.setViewport(this.client, target, width, height, dpr)
      return {
        ok: true,
        contextId: target,
        width,
        height,
        devicePixelRatio: dpr,
      }
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: target })
    }
  },
  /**
   * Read the visible text of a page.
   *
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {number} [opts.maxChars]
   * @param {number} [opts.offset]
   * @param {string} [opts.selector]  read a subtree instead of the whole body
   */
  async text(contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    const maxChars = opts.maxChars === undefined ? DEFAULT_MAX_TEXT_CHARS : opts.maxChars
    const offset = Math.max(0, opts.offset || 0)

    const expression = opts.selector
      ? `(document.querySelector(${JSON.stringify(opts.selector)})||{}).innerText||""`
      : 'document.body ? document.body.innerText : ""'

    try {
      const remote = await bidi.evaluate(this.client, expression, target)
      const full = String(bidi.unwrapRemoteValue(remote) ?? '')
      // Page text is a raw-content channel: it can carry a token the page
      // printed into a paragraph. Redact before it reaches the model.
      const safe = redactText(full)
      const slice = safe.slice(offset, offset + maxChars)
      const nextOffset = offset + slice.length
      const truncated = nextOffset < safe.length

      const scan = await this._visibilityScan(target)
      this._applyScan(scan)

      return {
        ok: true,
        contextId: target,
        value: slice,
        length: safe.length,
        truncated,
        nextOffset: truncated ? nextOffset : undefined,
        redacted: safe !== full,
        source: {
          origin: this._originForContext(target),
          kind: 'page_content',
          trusted: false,
        },
        signals: scan.signals,
        warnings: scan.warnings,
      }
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: target })
    }
  },
}
