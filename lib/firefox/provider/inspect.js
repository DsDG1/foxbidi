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
 * @type an object of methods
 */
import * as bidi from '../../bidi/protocol.js'
import { ERROR_CODES, classifyError, fail } from '../errors.js'
import { capabilityError } from '../capabilities.js'
import { evaluateGate, ACTION_KINDS } from '../confirm.js'
import { ensureRegistry, frameLabel, REF_MODE } from '../registry.js'
import { resolveSharedId } from '../selector.js'
import { takeSnapshot, DEFAULT_MAX_ELEMENTS, MAX_ELEMENTS_LIMIT } from '../snapshot.js'
import { resolve } from 'node:path'
import { DEFAULT_MAX_TEXT_CHARS } from './constants.js'

export const inspectMethods = {
  /**
   * Take an ARIA-style snapshot of the page.
   *
   * Refs are stored in a page-side registry, so the page cannot see the
   * plugin's bookkeeping. The registry is (re)created on demand: a
   * navigation wipes the page's realm, and the registry with it.
   *
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {number} [opts.maxElements]
   * @param {number} [opts.offset]
   * @param {string[]} [opts.roleFilter]
   * @param {string} [opts.nameContains]
   * @param {boolean} [opts.includeText]
   * @param {'none'|'all'} [opts.frames]  include iframe contents
   */
  async snapshot(contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    if (!target) return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')
    try {
      const maxElements = Math.min(
        MAX_ELEMENTS_LIMIT,
        Math.max(1, opts.maxElements || this.config_.maxSnapshotElements || DEFAULT_MAX_ELEMENTS),
      )
      const legacy = !(await ensureRegistry(this.client, target, this._registryKey))
      // A page that refuses script evaluation cannot hold a registry; fall
      // back to the attribute mode and say so in the result.
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
      this._snapshotSeq += 1
      this._lastContextId = target

      const payload = {
        ok: true,
        contextId: target,
        snapshotId: this._snapshotSeq,
        elements: result.elements,
        count: result.elements.length,
        total: result.total,
        truncated: result.truncated,
        hasMore: result.hasMore,
        nextOffset: result.nextOffset,
        refMode: this._refMode,
      }
      if (result.texts) payload.texts = result.texts

      if (opts.frames && opts.frames !== 'none') {
        const frames = await this._snapshotFrames(target, maxElements, legacy)
        payload.frames = frames
        payload.count += frames.reduce((sum, f) => sum + (f.elementCount || 0), 0)
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
    let tree = []
    try {
      tree = await bidi.getTree(this.client)
    } catch {
      return frames
    }

    const children = []
    const collect = (nodes, parent) => {
      for (const node of nodes) {
        if (node.contextId === parentContextId) {
          for (const child of node.children || []) children.push(child)
        }
        if (node.children) collect(node.children, parent)
      }
    }
    collect(tree, parentContextId)

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
   * @param {string} expression
   * @param {string} [contextId]
   */
  async evaluate(expression, contextId) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    try {
      const remote = await bidi.evaluate(this.client, expression, target)
      return { ok: true, contextId: target, value: bidi.unwrapRemoteValue(remote) }
    } catch (e) {
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
   * @param {object} opts
   * @param {number} opts.width
   * @param {number} opts.height
   * @param {number} [opts.devicePixelRatio]
   * @param {string} [contextId]
   * @param {boolean} [opts.confirm]
   * @returns {Promise<object>}
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
      await bidi.setViewport(this.client, target, width, height)
      return {
        ok: true,
        contextId: target,
        width,
        height,
        devicePixelRatio: opts.devicePixelRatio || 1,
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
      const slice = full.slice(offset, offset + maxChars)
      const nextOffset = offset + slice.length
      const truncated = nextOffset < full.length
      return {
        ok: true,
        contextId: target,
        value: slice,
        length: full.length,
        truncated,
        nextOffset: truncated ? nextOffset : undefined,
      }
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: target })
    }
  },
}
