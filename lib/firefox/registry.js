// lib/firefox/registry.js
// The page-side ref registry.
//
// WHY A REGISTRY INSTEAD OF A DOM ATTRIBUTE
//
// The previous implementation wrote `data-mavis-ff-ref="eN"` onto every
// snapshot element and looked elements up with `[data-mavis-ff-ref="eN"]`.
//
// That works, but it leaves a trace a page can see: a MutationObserver sees
// the attribute mutations, `outerHTML` contains it, and
// `document.querySelectorAll('[data-mavis-ff-ref]')` finds every marked
// element. Anti-automation checks look for exactly that kind of thing.
//
// The registry keeps the same mapping (element → ref) but stores it in a
// `Map` held on `window` under a random, non-enumerable key. Nothing is
// written to the DOM, so there is no attribute for a page to find.
//
// RESIDUAL RISK (stated plainly)
//
// The key still exists on `window`. A page that enumerates
// `Object.getOwnPropertyNames(window)` can find it. The key is random per
// session and the property is non-enumerable, so it does not show up in
// `Object.keys(window)` — but this is "less detectable", NOT "invisible".
// `browser_detectability` reports the real state rather than claiming
// otherwise.
//
// FALLBACK
//
// If the registry cannot be created (an exotic page that blocks script
// evaluation), the provider falls back to the attribute mode. `browser_status`
// reports which mode is active via `refMode`.

import { randomBytes } from 'node:crypto'

/** Prefix for the registry key. Deliberately unremarkable. */
export const REGISTRY_KEY_PREFIX = '__ffb_'

/** How the registry is currently storing refs. */
export const REF_MODE = {
  REGISTRY: 'registry',
  ATTRIBUTE: 'attribute',
}

/**
 * Create a random registry key for this session.
 *
 * @returns {string}
 */
export function createRegistryKey() {
  return REGISTRY_KEY_PREFIX + randomBytes(9).toString('hex')
}

/**
 * The script that creates the registry in a page.
 *
 * `Object.defineProperty` with `enumerable: false` keeps the key out of
 * `Object.keys(window)` and out of `for...in`. It is still reachable through
 * `Object.getOwnPropertyNames` — see the residual-risk note above.
 *
 * The registry is created only when missing, so calling this repeatedly for
 * the same realm is harmless and keeps the existing entries.
 */
export const ENSURE_REGISTRY_SCRIPT = `(key) => {
  if (!Object.prototype.hasOwnProperty.call(window, key)) {
    const map = new Map();
    const byElement = new Map();
    Object.defineProperty(window, key, {
      value: {
        map: map,
        byElement: byElement,
        counter: 0,
        get: function (ref) { return map.get(ref) || null; },
      },
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return true;
}`

/**
 * Make sure the page (or frame) holds a registry under `key`.
 *
 * Idempotent: calling it again for the same realm keeps the existing entries,
 * so refs stay valid across repeated snapshots.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} key
 * @returns {Promise<boolean>} true when the registry is in place
 */
export async function ensureRegistry(client, contextId, key) {
  try {
    await client.send('script.callFunction', {
      functionDeclaration: ENSURE_REGISTRY_SCRIPT,
      arguments: [{ type: 'string', value: key }],
      target: { context: contextId },
      awaitPromise: true,
      resultOwnership: 'none',
    })
    return true
  } catch {
    return false
  }
}

/**
 * Drop every registry entry whose element has left the document.
 *
 * Called when a page navigates: the realm (and with it the registry) is gone
 * anyway, but a soft navigation can keep the window alive.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function clearRegistry(client, contextId, key) {
  try {
    await client.send('script.callFunction', {
      functionDeclaration: `(key) => {
        const reg = window[key];
        if (reg && reg.map) { reg.map.clear(); reg.byElement.clear(); }
      }`,
      arguments: [{ type: 'string', value: key }],
      target: { context: contextId },
      awaitPromise: true,
      resultOwnership: 'none',
    })
  } catch {
    // Best-effort cleanup — must never break a snapshot.
  }
}

import { LOOKUP_ELEMENT_SCRIPT } from './page/dom.js'

/**
 * The in-page element lookup used by every action, generated from pure JS in `./page/dom.js`.
 */
export const LOOKUP_ELEMENT = LOOKUP_ELEMENT_SCRIPT

/**
 * The frame label used to prefix refs that live inside an iframe.
 *
 * @param {string} contextId  a BiDi browsing context id
 * @returns {string} e.g. "f1a2b3c4"
 */
export function frameLabel(contextId) {
  return (
    'f' +
    String(contextId || '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 8)
  )
}

/**
 * Split a ref into its frame label and its in-frame ref.
 *
 * @param {string} ref
 * @returns {{frameLabel: string|null, localRef: string}}
 */
export function splitRef(ref) {
  const value = String(ref || '')
  const idx = value.indexOf(':')
  if (idx === -1) return { frameLabel: null, localRef: value }
  return { frameLabel: value.slice(0, idx), localRef: value.slice(idx + 1) }
}

/**
 * Is this string shaped like a ref this plugin issued?
 *
 * Refs are `e` followed by digits, optionally prefixed with a frame label
 * (`f1a2b3c4:e7`).
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isRefShape(value) {
  return typeof value === 'string' && /^(?:[A-Za-z0-9_]+:)?e\d+$/.test(value)
}
