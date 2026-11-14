// lib/firefox/selector.js
// Tri-mode element addressing: snapshot `ref` (preferred), semantic `match`
// (`{role, name, nameContains, nth}` for dynamic multi-step batches), or CSS `selector`.

import { refExists, refSelector } from './snapshot.js'
import { ensureRegistry, splitRef } from './registry.js'
import { ERROR_CODES, fail } from './errors.js'
import { unwrapRemoteValue } from '../bidi/protocol.js'
import {
  INSPECT_ACTIVE_SCRIPT,
  INSPECT_ELEMENT_SCRIPT,
  RESOLVE_SHARED_ID_SCRIPT,
} from './page/inputs-page.js'
import { MATCH_ELEMENT_SCRIPT } from './page/snapshot-page.js'

/**
 * @typedef {Record<string, any>} SemanticMatchSpec
 * @property {string} [role]
 * @property {string} [name]
 * @property {string} [nameContains]
 * @property {number} [nth]
 */

/**
 * Resolve a target (`ref`, semantic `match`, or CSS `selector`) into an actionable descriptor.
 *
 * Precedence: `ref` > `match` > `selector`.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {{ref?: string, match?: SemanticMatchSpec, selector?: string, contextId: string, key?: string, legacy?: boolean, frameMap?: Map<string, string>}} opts
 * @returns {Promise<Record<string, any>>}
 */
export async function resolveTarget(client, opts) {
  const { ref, match, selector } = opts

  if (ref) {
    const { frameLabel, localRef } = splitRef(ref)
    let actionContext = opts.contextId
    if (frameLabel) {
      const frameContext = opts.frameMap ? opts.frameMap.get(frameLabel) : null
      if (!frameContext) {
        return fail(
          ERROR_CODES.FRAME_GONE,
          `frame "${frameLabel}" of ref "${ref}" is no longer available`,
          {
            hint: 'The frame was removed or reloaded. Call browser_snapshot again.',
            requiresResnapshot: true,
          },
        )
      }
      actionContext = frameContext
    }

    const alive = await refExists(client, actionContext, localRef, {
      key: opts.key,
      legacy: opts.legacy,
    })
    if (!alive) {
      return fail(ERROR_CODES.REF_STALE, `ref "${ref}" no longer exists in the page`, {
        hint: 'The page re-rendered and dropped the snapshot markers. Call browser_snapshot again to get fresh refs.',
        requiresResnapshot: true,
      })
    }
    /** @type {Record<string, any>} */
    const result = {
      ok: true,
      via: 'ref',
      ref: localRef,
      contextId: actionContext,
      ...(opts.legacy ? { selector: refSelector(localRef) } : {}),
    }
    if (selector) result.ignoredSelector = selector
    return result
  }

  if (match && typeof match === 'object' && (match.role || match.name || match.nameContains)) {
    const key = opts.key || ''
    if (!key || !(await ensureRegistry(client, opts.contextId, key))) {
      return fail(
        ERROR_CODES.ELEMENT_NOT_FOUND,
        'semantic match requires an active page ref registry',
        { contextId: opts.contextId },
      )
    }
    const raw = await client.send('script.callFunction', {
      functionDeclaration: MATCH_ELEMENT_SCRIPT,
      arguments: [
        { type: 'string', value: key },
        { type: 'string', value: match.role || '' },
        { type: 'string', value: match.name || '' },
        { type: 'string', value: match.nameContains || '' },
        { type: 'number', value: Number.isFinite(match.nth) ? Number(match.nth) : 0 },
      ],
      target: { context: opts.contextId },
      awaitPromise: true,
      resultOwnership: 'none',
    })
    const verdict = /** @type {Record<string, any>|null} */ (unwrapRemoteValue(raw.result || {}))
    if (!verdict || verdict.ok !== true) {
      return fail(
        (verdict && verdict.code) || ERROR_CODES.ELEMENT_NOT_FOUND,
        (verdict && verdict.error) || 'no visible element matched the semantic query',
        {
          contextId: opts.contextId,
          match,
        },
      )
    }
    return {
      ok: true,
      via: 'match',
      ref: verdict.ref,
      matchedRole: verdict.role,
      matchedName: verdict.name,
      matchCount: verdict.matchCount,
      contextId: opts.contextId,
    }
  }

  if (selector) {
    return { ok: true, via: 'selector', selector, contextId: opts.contextId }
  }

  return fail(ERROR_CODES.INVALID_ARGUMENT, 'no target given', {
    hint: 'Pass ref (from browser_snapshot), match ({role, nameContains}), or selector (a CSS selector).',
  })
}

/**
 * Look up the FOCUSED element's form context in the page.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {{contextId: string}} opts
 * @returns {Promise<Record<string, any>|null>}
 */
export async function inspectActiveElement(client, opts) {
  const result = await client.send('script.callFunction', {
    functionDeclaration: INSPECT_ACTIVE_SCRIPT,
    arguments: [],
    target: { context: opts.contextId },
    awaitPromise: true,
    resultOwnership: 'none',
  })

  const raw = result.result || {}
  if (raw.type === 'null' || raw.value === null) return null
  const value = unwrapRemoteValue(raw)
  if (!value || typeof value !== 'object') return null
  return /** @type {Record<string, any>} */ (value)
}

/**
 * Look up an element's geometry and identity in the page.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {{contextId: string, selector?: string, ref?: string, key?: string}} opts
 * @returns {Promise<Record<string, any>|null>}
 */
export async function inspectElement(client, opts) {
  const result = await client.send('script.callFunction', {
    functionDeclaration: INSPECT_ELEMENT_SCRIPT,
    arguments: [
      { type: 'string', value: opts.key || '' },
      { type: 'string', value: opts.ref || '' },
      { type: 'string', value: opts.selector || '' },
    ],
    target: { context: opts.contextId },
    awaitPromise: true,
    resultOwnership: 'none',
  })

  const raw = result.result || {}
  if (raw.type === 'null' || raw.value === null) return null
  const value = unwrapRemoteValue(raw)
  if (!value || typeof value !== 'object') return null
  return /** @type {Record<string, any>} */ (value)
}

/**
 * Resolve an element to a BiDi shared id.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {{contextId: string, selector?: string, ref?: string, key?: string}} opts
 * @returns {Promise<string|null>}
 */
export async function resolveSharedId(client, opts) {
  const result = await client.send('script.callFunction', {
    functionDeclaration: RESOLVE_SHARED_ID_SCRIPT,
    arguments: [
      { type: 'string', value: opts.key || '' },
      { type: 'string', value: opts.ref || '' },
      { type: 'string', value: opts.selector || '' },
    ],
    target: { context: opts.contextId },
    awaitPromise: true,
    resultOwnership: 'none',
  })
  const value = result.result || {}
  return value.sharedId || null
}
