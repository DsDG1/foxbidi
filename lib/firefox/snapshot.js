// lib/firefox/snapshot.js
// ARIA-style element snapshots, compact formatting, delta computation, and
// focus/delta-prioritized inline view selection for AI agents.

import { isRefShape, LOOKUP_ELEMENT } from './registry.js'
import { SNAPSHOT_SCRIPT, LEGACY_SNAPSHOT_SCRIPT } from './page/snapshot-page.js'
import { unwrapRemoteValue } from '../bidi/protocol.js'

/**
 * The attribute used to mark elements with their snapshot ref in fallback mode.
 */
export const REF_ATTRIBUTE = 'data-mavis-ff-ref'

/** Maximum number of elements one snapshot returns by default. */
export const DEFAULT_MAX_ELEMENTS = 300

/** Hard ceiling on elements returned by one snapshot. */
export const MAX_ELEMENTS_LIMIT = 5000

export { SNAPSHOT_SCRIPT, LEGACY_SNAPSHOT_SCRIPT }

/**
 * Strip noisy default fields from an element record while preserving full semantics.
 *
 * @param {Record<string, any>} el
 * @returns {Record<string, any>}
 */
export function trimElementRecord(el) {
  if (!el || typeof el !== 'object') return el
  /** @type {Record<string, any>} */
  const out = {
    ref: el.ref,
    role: el.role,
    name: el.name ?? '',
  }
  if (el.landmark && el.landmark !== 'body') out.landmark = el.landmark
  if (el.rect) out.rect = el.rect
  if (el.inViewport !== undefined) out.inViewport = el.inViewport
  if (el.value !== undefined && el.value !== '') out.value = el.value
  if (el.valueRedacted === true) out.valueRedacted = true
  if (typeof el.checked === 'boolean') out.checked = el.checked
  if (el.disabled === true) out.disabled = true
  return out
}

/**
 * Render snapshot elements as a token-dense ARIA tree grouped by consecutive landmarks.
 *
 * Format per line:
 *   `e0 button "Submit" [disabled,offscreen]`
 *   `e1 textbox "Email" val="a@b.com"`
 *   `e2 checkbox "Agree" [checked]`
 *
 * @param {Array<Record<string, any>>} elements
 * @returns {string}
 */
export function formatCompactSnapshot(elements) {
  if (!Array.isArray(elements) || !elements.length) return ''
  /** @type {string[]} */
  const lines = []
  let currentLandmark = ''

  for (const el of elements) {
    if (!el) continue
    const lm = el.landmark && el.landmark !== 'body' ? String(el.landmark) : ''
    if (lm !== currentLandmark) {
      currentLandmark = lm
      if (lm) lines.push(`[${lm}]`)
    }
    const indent = currentLandmark ? '  ' : ''
    const ref = el.ref || '?'
    const role = el.role || 'element'
    const cleanName = el.name ? ` ${JSON.stringify(String(el.name).slice(0, 80))}` : ''
    let valPart = ''
    if (el.valueRedacted) {
      valPart = ' val=<redacted>'
    } else if (typeof el.value === 'string' && el.value.length > 0) {
      valPart = ` val=${JSON.stringify(el.value.slice(0, 60))}`
    }
    /** @type {string[]} */
    const flags = []
    if (typeof el.checked === 'boolean') flags.push(el.checked ? 'checked' : 'unchecked')
    if (el.disabled === true) flags.push('disabled')
    if (el.inViewport === false) flags.push('offscreen')
    const flagPart = flags.length ? ` [${flags.join(',')}]` : ''
    lines.push(`${indent}${ref} ${role}${cleanName}${valPart}${flagPart}`)
  }

  return lines.join('\n')
}

/**
 * Select up to `limit` light `{ref, role, name}` records for an action's inline snapshot,
 * prioritizing:
 *   1. Elements newly added or changed compared to `baseline` (dialogs, menus, alerts)
 *   2. Elements inside `dialog` landmarks
 *   3. Viewport-visible elements closest to `anchorRect` (the just-acted target)
 *   4. Remaining viewport elements, then offscreen elements in document order
 *
 * Returned items are restored to document order and stripped to `{ref, role, name}`.
 *
 * @param {Array<Record<string, any>>} elements
 * @param {{limit?: number, nameLimit?: number, baseline?: Array<Record<string, any>>, anchorRect?: {x: number, y: number}|null}} [opts]
 * @returns {Array<{ref: string, role: string, name: string}>}
 */
export function prioritizeInlineElements(elements, opts = {}) {
  const list = Array.isArray(elements) ? elements : []
  const limit = Math.max(1, opts.limit || 60)
  const nameLimit = Math.max(1, opts.nameLimit || 60)

  /** @param {Record<string, any>} el */
  const toLight = (el) => ({
    ref: el.ref,
    role: el.role,
    name: el.name ? String(el.name).slice(0, nameLimit) : el.name,
  })

  if (list.length <= limit) {
    return list.map(toLight)
  }

  const baselineMap = new Map(
    Array.isArray(opts.baseline) ? opts.baseline.map((b) => [b.ref, b]) : [],
  )
  const hasBaseline = baselineMap.size > 0
  const anchor =
    opts.anchorRect && Number.isFinite(opts.anchorRect.x) && Number.isFinite(opts.anchorRect.y)
      ? opts.anchorRect
      : null

  const scored = list.map((el, idx) => {
    let tier
    let dist = idx

    const prev = hasBaseline ? baselineMap.get(el.ref) : undefined
    const isChangedOrNew =
      hasBaseline &&
      (!prev ||
        prev.name !== el.name ||
        prev.value !== el.value ||
        prev.checked !== el.checked ||
        prev.disabled !== el.disabled)

    if (isChangedOrNew || el.landmark === 'dialog') {
      tier = 0
    } else if (el.inViewport !== false) {
      tier = 1
      if (anchor && el.rect && Number.isFinite(el.rect.x) && Number.isFinite(el.rect.y)) {
        const cx = el.rect.x + (el.rect.w || 0) / 2
        const cy = el.rect.y + (el.rect.h || 0) / 2
        dist = Math.hypot(cx - anchor.x, cy - anchor.y)
      }
    } else {
      tier = 2
    }

    return { el, idx, tier, dist }
  })

  scored.sort((a, b) => a.tier - b.tier || a.dist - b.dist || a.idx - b.idx)
  const chosen = scored.slice(0, limit).sort((a, b) => a.idx - b.idx)
  return chosen.map((item) => toLight(item.el))
}

/**
 * Remove the plugin's ref markers from a page.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} [key]  registry key (registry mode)
 * @returns {Promise<void>}
 */
export async function clearRefs(client, contextId, key) {
  const tasks = [
    client.send('script.callFunction', {
      functionDeclaration:
        '(attr) => { const n = document.querySelectorAll("[" + attr + "]"); for (let i = 0; i < n.length; i++) n[i].removeAttribute(attr); }',
      arguments: [{ type: 'string', value: REF_ATTRIBUTE }],
      target: { context: contextId },
      awaitPromise: true,
      resultOwnership: 'none',
    }),
  ]
  if (key) {
    tasks.push(
      client.send('script.callFunction', {
        functionDeclaration: `(key) => { const reg = window[key]; if (reg && reg.map) { reg.map.clear(); reg.byElement.clear(); } }`,
        arguments: [{ type: 'string', value: key }],
        target: { context: contextId },
        awaitPromise: true,
        resultOwnership: 'none',
      }),
    )
  }
  try {
    await Promise.all(tasks)
  } catch {
    // Best-effort cleanup — a failure here must not break the snapshot.
  }
}

/**
 * Compare two snapshots and report what changed.
 *
 * @param {Array<Record<string, any>>} before
 * @param {Array<Record<string, any>>} after
 * @returns {{added: Array<Record<string, any>>, changed: Array<Record<string, any>>, removed: string[]}}
 */
export function diffSnapshots(before, after) {
  const beforeByRef = new Map((before || []).map((e) => [e.ref, e]))
  const afterByRef = new Map((after || []).map((e) => [e.ref, e]))

  const added = []
  const changed = []
  const removed = []

  for (const [ref, el] of afterByRef) {
    const prev = beforeByRef.get(ref)
    if (!prev) {
      added.push(el)
      continue
    }
    if (
      prev.name !== el.name ||
      prev.value !== el.value ||
      prev.checked !== el.checked ||
      prev.disabled !== el.disabled
    ) {
      changed.push(el)
    }
  }

  for (const [ref] of beforeByRef) {
    if (!afterByRef.has(ref)) removed.push(ref)
  }

  return { added, changed, removed }
}

/**
 * Take an ARIA-style snapshot of a browsing context.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {{contextId: string, key: string, maxElements?: number, offset?: number, roleFilter?: string[], nameContains?: string, includeText?: boolean, legacy?: boolean}} opts
 * @returns {Promise<{elements: Array<Record<string, any>>, total: number, truncated: boolean, hasMore: boolean, nextOffset: number|undefined, texts?: string[]}>}
 */
export async function takeSnapshot(client, opts) {
  const offset = Math.max(0, opts.offset || 0)
  const limit = Math.min(MAX_ELEMENTS_LIMIT, Math.max(1, opts.maxElements || DEFAULT_MAX_ELEMENTS))

  if (opts.legacy) {
    const result = await client.send('script.callFunction', {
      functionDeclaration: LEGACY_SNAPSHOT_SCRIPT,
      arguments: [
        { type: 'string', value: REF_ATTRIBUTE },
        { type: 'number', value: limit },
      ],
      target: { context: opts.contextId },
      awaitPromise: true,
      resultOwnership: 'none',
    })
    const raw = result.result || {}
    let all = unwrapRemoteValue(raw)
    if (!Array.isArray(all)) all = []
    const total = all.length
    const page = all.slice(offset, offset + limit).map(trimElementRecord)
    const hasMore = offset + page.length < total
    return {
      elements: page,
      total,
      truncated: hasMore,
      hasMore,
      nextOffset: hasMore ? offset + page.length : undefined,
    }
  }

  const result = await client.send('script.callFunction', {
    functionDeclaration: SNAPSHOT_SCRIPT,
    arguments: [
      { type: 'string', value: opts.key },
      { type: 'number', value: offset },
      { type: 'number', value: limit },
      { type: 'string', value: JSON.stringify(opts.roleFilter || []) },
      { type: 'string', value: opts.nameContains || '' },
      { type: 'boolean', value: !!opts.includeText },
    ],
    target: { context: opts.contextId },
    awaitPromise: true,
    resultOwnership: 'none',
  })

  const payload = /** @type {Record<string, any>} */ (unwrapRemoteValue(result.result || {}) || {})
  const rawElements = Array.isArray(payload.elements) ? payload.elements : []
  const elements = rawElements.map(trimElementRecord)
  const total = typeof payload.total === 'number' ? payload.total : elements.length
  const hasMore = !!payload.hasMore

  return {
    elements,
    total,
    truncated: hasMore,
    hasMore,
    nextOffset: hasMore ? offset + elements.length : undefined,
    texts: Array.isArray(payload.texts) ? payload.texts : undefined,
  }
}

/**
 * Check whether a ref still exists in the page.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} ref
 * @param {{key?: string, legacy?: boolean}} [opts]
 * @returns {Promise<boolean>}
 */
export async function refExists(client, contextId, ref, opts = {}) {
  try {
    if (!opts.legacy && opts.key) {
      const result = await client.send('script.callFunction', {
        functionDeclaration: `(key, ref) => {
          const reg = window[key];
          if (!reg) return false;
          const el = reg.get(ref);
          return !!(el && el.isConnected !== false);
        }`,
        arguments: [
          { type: 'string', value: opts.key },
          { type: 'string', value: ref },
        ],
        target: { context: contextId },
        awaitPromise: true,
        resultOwnership: 'none',
      })
      const value = result.result || {}
      return value.value === true
    }
    const result = await client.send('script.callFunction', {
      functionDeclaration:
        '(attr, ref) => !!document.querySelector("[" + attr + "=\\"" + ref + "\\"]")',
      arguments: [
        { type: 'string', value: REF_ATTRIBUTE },
        { type: 'string', value: ref },
      ],
      target: { context: contextId },
      awaitPromise: true,
      resultOwnership: 'none',
    })
    const value = result.result || {}
    return value.value === true
  } catch {
    return false
  }
}

/**
 * Build the CSS selector that resolves a ref back to its element (attribute fallback mode).
 *
 * @param {string} ref
 * @returns {string}
 */
export function refSelector(ref) {
  return `[${REF_ATTRIBUTE}="${String(ref).replace(/"/g, '\\"')}"]`
}

export { LOOKUP_ELEMENT, isRefShape }
