// lib/firefox/selector.js
// Dual addressing: an agent may target an element by snapshot `ref` OR by
// CSS `selector`.
//
// WHY DUAL ADDRESSING
//
// The ref path is the good one: it is semantic, stable against class-name
// churn, and it removes the guesswork that makes CSS-selector automation
// brittle. But the plugin's existing tools are documented in terms of
// `selector`, and breaking that would invalidate every existing workflow.
// So both are supported, with `ref` taking precedence.
//
// The precedence rule matters for the error message: when both are given,
// the selector is IGNORED — and the agent is told so, rather than having it
// silently do nothing.
//
// REFS IN FRAMES
//
// A ref that came from inside an iframe carries a frame label
// (`f1a2b3c4:e7`). Such a ref must be resolved against the FRAME's browsing
// context, not the top-level one — so `resolveTarget` also reports which
// context the action should run in.

import { refExists, refSelector } from './snapshot.js'
import { LOOKUP_ELEMENT, splitRef } from './registry.js'
import { ERROR_CODES, fail } from './errors.js'

/**
 * Resolve a target into something the page scripts can act on.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {object} opts
 * @param {string} [opts.ref]
 * @param {string} [opts.selector]
 * @param {string} opts.contextId     the context the caller wants to act in
 * @param {string} [opts.key]         registry key
 * @param {boolean} [opts.legacy]     use the attribute-based ref lookup
 * @param {Map<string,string>} [opts.frameMap]  frame label → context id
 * @returns {Promise<{ok: true, via: 'ref'|'selector', ref?: string, selector?: string,
 *                    contextId: string, ignoredSelector?: string}
 *          | {ok: false, error: string, hint?: string, requiresResnapshot?: boolean}>}
 */
export async function resolveTarget(client, opts) {
  const { ref, selector } = opts

  if (ref) {
    // A frame-scoped ref must be resolved inside that frame.
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
    const result = {
      ok: true,
      via: 'ref',
      ref: localRef,
      contextId: actionContext,
      // In attribute mode the selector is the only way to reach the element.
      ...(opts.legacy ? { selector: refSelector(localRef) } : {}),
    }
    if (selector) result.ignoredSelector = selector
    return result
  }

  if (selector) {
    return { ok: true, via: 'selector', selector, contextId: opts.contextId }
  }

  return fail(ERROR_CODES.INVALID_ARGUMENT, 'no target given', {
    hint: 'Pass ref (from browser_snapshot) or selector (a CSS selector).',
  })
}

/**
 * Look up an element's geometry and identity in the page.
 *
 * Returns null when the element is missing. The rect is what the pointer
 * action needs, and it is also how we detect a zero-size (hidden) element
 * before clicking it.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.contextId
 * @param {string} [opts.selector]
 * @param {string} [opts.ref]
 * @param {string} [opts.key]
 * @returns {Promise<{x: number, y: number, w: number, h: number, tag: string, role: string, name: string,
 *                    value: string, checked: boolean, disabled: boolean,
 *                    formAction: string|null, formMethod: string|null, isSubmit: boolean,
 *                    hasDownload: boolean, isFileInput: boolean}|null>}
 */
export async function inspectElement(client, opts) {
  const result = await client.send('script.callFunction', {
    functionDeclaration: `(key, ref, selector) => {
      const el = (${LOOKUP_ELEMENT})(key, ref, selector);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      const form = el.form || (el.closest ? el.closest('form') : null);
      const isSubmit = (tag === 'button' && (type === 'submit' || (type === '' && !!form))) ||
                       (tag === 'input' && (type === 'submit' || type === 'image'));
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        w: rect.width,
        h: rect.height,
        tag: tag,
        type: type,
        role: el.getAttribute('role') || '',
        name: (el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || '').trim(),
        value: type === 'password' ? '' : (typeof el.value === 'string' ? el.value : ''),
        checked: !!el.checked,
        disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        formAction: form && form.action ? form.action : null,
        formMethod: form && form.method ? String(form.method).toLowerCase() : null,
        isSubmit: isSubmit,
        hasDownload: el.hasAttribute('download'),
        isFileInput: tag === 'input' && type === 'file',
      };
    }`,
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
  const { unwrapRemoteValue } = await import('../bidi/protocol.js')
  const value = unwrapRemoteValue(raw)
  if (!value || typeof value !== 'object') return null
  return value
}

/**
 * Resolve an element to a BiDi shared id.
 *
 * Needed by the commands that demand a node handle rather than a selector
 * (`input.setFiles`, element screenshots).
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.contextId
 * @param {string} [opts.selector]
 * @param {string} [opts.ref]
 * @param {string} [opts.key]
 * @returns {Promise<string|null>}
 */
export async function resolveSharedId(client, opts) {
  const result = await client.send('script.callFunction', {
    functionDeclaration: `(key, ref, selector) => {
      const el = (${LOOKUP_ELEMENT})(key, ref, selector);
      return el || null;
    }`,
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
