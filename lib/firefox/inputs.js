// lib/firefox/inputs.js
// Low-level input primitives: pointer events, key presses, select, check,
// hover, scroll, upload.
//
// KEY ENCODING
//
// WebDriver encodes special keys as Unicode private-use characters. Verified
// on Firefox 140 ESR:
//   - '\\uE007' (ENTER)  → the page sees key "Enter"
//   - '\\uE009' (CONTROL) → the page sees ctrlKey === true
//   - a literal "\\n"     → the page sees key "\\n" (a literal newline), NOT Enter
//
// So "press Enter" and "type a newline" are genuinely different operations,
// and the key map below is what separates them.

import { unwrapRemoteValue } from '../bidi/protocol.js'
import {
  FOCUS_ELEMENT_SCRIPT,
  CLEAR_ELEMENT_SCRIPT,
  SELECT_OPTION_SCRIPT,
  CHECK_ELEMENT_SCRIPT,
  SCROLL_SCRIPT,
} from './page/inputs-page.js'

/** WebDriver special-key code points. */
export const KEY_CODES = {
  NULL: '',
  CANCEL: '',
  HELP: '',
  BACKSPACE: '',
  TAB: '',
  CLEAR: '',
  RETURN: '',
  ENTER: '',
  SHIFT: '',
  CONTROL: '',
  ALT: '',
  PAUSE: '',
  ESCAPE: '',
  SPACE: '',
  PAGEUP: '',
  PAGEDOWN: '',
  END: '',
  HOME: '',
  ARROWLEFT: '',
  ARROWUP: '',
  ARROWRIGHT: '',
  ARROWDOWN: '',
  DELETE: '',
  SEMICOLON: '',
  EQUALS: '',
  META: '',
}

/** Aliases an agent is likely to use. */
const KEY_ALIASES = {
  enter: 'ENTER',
  return: 'RETURN',
  esc: 'ESCAPE',
  escape: 'ESCAPE',
  space: 'SPACE',
  spacebar: 'SPACE',
  tab: 'TAB',
  backspace: 'BACKSPACE',
  delete: 'DELETE',
  del: 'DELETE',
  up: 'ARROWUP',
  arrowup: 'ARROWUP',
  down: 'ARROWDOWN',
  arrowdown: 'ARROWDOWN',
  left: 'ARROWLEFT',
  arrowleft: 'ARROWLEFT',
  right: 'ARROWRIGHT',
  arrowright: 'ARROWRIGHT',
  home: 'HOME',
  end: 'END',
  pageup: 'PAGEUP',
  pagedown: 'PAGEDOWN',
  shift: 'SHIFT',
  ctrl: 'CONTROL',
  control: 'CONTROL',
  alt: 'ALT',
  meta: 'META',
  cmd: 'META',
  command: 'META',
}

/**
 * Resolve a key name to its WebDriver encoding.
 *
 * A single character is returned as-is (so "a" types "a"). A multi-character
 * name is looked up in the code table. `Ctrl+Enter` style combinations are
 * supported via `combo`.
 *
 * @param {string} key
 * @returns {string} the encoded key, or '' when unknown
 */
export function encodeKey(key) {
  if (typeof key !== 'string' || key.length === 0) return ''
  if (key.length === 1) return key
  const upper = key.toUpperCase()
  if (KEY_CODES[upper]) return KEY_CODES[upper]
  const alias = KEY_ALIASES[key.toLowerCase()]
  if (alias && KEY_CODES[alias]) return KEY_CODES[alias]
  return ''
}

/**
 * Resolve a key combination such as "Ctrl+Enter" into a list of encoded keys.
 *
 * Modifiers are pressed first and released last, which is what a user does.
 *
 * @param {string} combo  e.g. "Ctrl+Shift+Enter"
 * @returns {{keys: string[], error?: string}}
 */
export function encodeCombo(combo) {
  const parts = String(combo)
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return { keys: [], error: 'no key given' }
  const encoded = []
  for (const part of parts) {
    const value = encodeKey(part)
    if (!value) return { keys: [], error: `unknown key name: "${part}"` }
    encoded.push(value)
  }
  return { keys: encoded }
}

/**
 * Send an `input.performActions` command.
 *
 * The caller may take the send over through `opts.perform`. The provider
 * does that when the command has to be abandoned the moment a modal dialog
 * opens — a dialog blocks the page, so the command that opened it never
 * comes back.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {Record<string, any>} opts
 * @param {Record<string, any>} params  the BiDi parameters
 * @returns {Promise<Record<string, any>>}
 */
function performInput(client, opts, params) {
  if (typeof opts.perform === 'function') return opts.perform(params)
  return client.send('input.performActions', params)
}

/**
 * Perform pointer actions at absolute viewport coordinates.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.context
 * @param {number} opts.x
 * @param {number} opts.y
 * @param {number} [opts.clickCount]  2 for a double click
 * @param {number} [opts.button]      0 left, 1 middle, 2 right
 * @param {(params: Record<string, any>) => Promise<Record<string, any>>} [opts.perform]  take over the send
 */
export async function pointerClick(client, opts) {
  const button = opts.button === undefined ? 0 : opts.button
  const clickCount = opts.clickCount || 1
  const actions = [
    {
      type: 'pointer',
      id: 'firefox-browser-pointer',
      parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', x: Math.round(opts.x), y: Math.round(opts.y) },
        { type: 'pointerDown', button },
        { type: 'pointerUp', button },
        ...(clickCount > 1
          ? Array.from({ length: clickCount - 1 }, () => [
              { type: 'pointerDown', button },
              { type: 'pointerUp', button },
            ]).flat()
          : []),
      ],
    },
  ]
  return performInput(client, opts, { actions, context: opts.context })
}

/**
 * Drag the pointer along a path: press at (x, y), move to (x+dx, y+dy) in
 * `steps` increments, release.
 *
 * Slider CAPTCHAs watch the motion, not just the end position: a single
 * pointerMove straight to the target reads as synthetic. The multi-step path
 * below produces the same pointermove/pointerup sequence a human drag does.
 *
 * Verified on Firefox 140 ESR: a 12-step drag of 200px moved a page slider
 * handle to exactly `left: 200px`, with pointerdown/pointermove/pointerup all
 * delivered to the page.
 *
 * OPTIONAL HUMAN-LIKE MOTION
 *
 * `stepDelayMs`, `easing` and `jitter` make the gesture look less machine
 * made, which some risk engines check:
 *
 *   - stepDelayMs  pause after every step (the whole drag then takes
 *                  stepDelayMs * steps milliseconds, like a real hand)
 *   - easing       'easeInOut' starts slowly, speeds up, then settles
 *   - jitter       +/- pixels of vertical wobble
 *
 * The defaults keep the original behaviour exactly (no delay, linear, no
 * wobble), so nothing changes for existing callers.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.context  browsing context that receives the events
 * @param {number} opts.x        start x
 * @param {number} opts.y        start y
 * @param {number} opts.dx       horizontal distance (may be negative)
 * @param {number} opts.dy       vertical distance (may be negative)
 * @param {number} [opts.steps]  number of intermediate moves (default 12)
 * @param {number} [opts.button]  mouse button (default 0)
 * @param {number} [opts.stepDelayMs]  pause after each step, in milliseconds
 * @param {'linear'|'easeInOut'} [opts.easing]  motion profile
 * @param {number} [opts.jitter]  vertical wobble in pixels
 * @param {() => number} [opts.random]  source of randomness (defaults to Math.random)
 * @returns {Promise<Record<string, any>>}
 */
export async function pointerDrag(client, opts) {
  const button = opts.button === undefined ? 0 : opts.button
  // An explicit 0 still has to produce one real step, so the clamp happens
  // here rather than relying on `|| 12` (which would treat 0 as "unset").
  const steps = Math.max(1, Number.isFinite(opts.steps) ? Math.round(opts.steps) : 12)
  const startX = Math.round(opts.x)
  const startY = Math.round(opts.y)
  const stepDelayMs = Number.isFinite(opts.stepDelayMs)
    ? Math.max(0, Math.round(opts.stepDelayMs))
    : 0
  const easing = opts.easing === 'easeInOut' ? 'easeInOut' : 'linear'
  const jitter = Number.isFinite(opts.jitter) ? Math.max(0, opts.jitter) : 0
  const random = typeof opts.random === 'function' ? opts.random : Math.random
  /** @type {Array<Record<string, any>>} */
  const actions = [
    { type: 'pointerMove', x: startX, y: startY },
    { type: 'pointerDown', button },
  ]
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    const eased =
      easing === 'easeInOut' ? (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2) : t
    const wobble = jitter > 0 ? (random() * 2 - 1) * jitter : 0
    actions.push({
      type: 'pointerMove',
      x: Math.round(startX + opts.dx * eased),
      y: Math.round(startY + opts.dy * eased + wobble),
    })
    if (stepDelayMs > 0) {
      actions.push({ type: 'pause', duration: stepDelayMs })
    }
  }
  actions.push({ type: 'pointerUp', button })
  return performInput(client, opts, {
    context: opts.context,
    actions: [
      {
        type: 'pointer',
        id: 'firefox-browser-drag',
        parameters: { pointerType: 'mouse' },
        actions,
      },
    ],
  })
}

/**
 * Move the pointer without clicking (for hover-triggered menus).
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.context
 * @param {number} opts.x
 * @param {number} opts.y
 * @param {(params: Record<string, any>) => Promise<any>} [opts.perform]
 */
export async function pointerMove(client, opts) {
  return performInput(client, opts, {
    context: opts.context,
    actions: [
      {
        type: 'pointer',
        id: 'firefox-browser-pointer',
        parameters: { pointerType: 'mouse' },
        actions: [{ type: 'pointerMove', x: Math.round(opts.x), y: Math.round(opts.y) }],
      },
    ],
  })
}

/**
 * The key codes that act as modifiers.
 *
 * A modifier must stay HELD DOWN while the target key goes down — that is
 * what makes the page see `ctrlKey === true` on the target's keydown. These
 * are the WebDriver code points, matched by value against KEY_CODES so the
 * table above stays the single source of truth.
 */
export const MODIFIER_KEYS = new Set([
  KEY_CODES.CONTROL,
  KEY_CODES.SHIFT,
  KEY_CODES.ALT,
  KEY_CODES.META,
])

/**
 * Build the key action sequence for a set of encoded keys.
 *
 * Modifiers are pressed first and released last, so a combination like
 * "Ctrl+Enter" reaches the page as a real chord: the page observes
 * `ctrlKey === true` on the Enter keydown.
 *
 * Pressing and releasing each key independently — which is what this used to
 * do — breaks every chord: the modifier is released before the target key
 * goes down, so "Ctrl+A" arrives at the page as a bare "a" and silently
 * types a literal character into the field.
 *
 * A sequence with no modifier keeps the original one-keydown/one-keyup
 * shape, so a lone "Enter" is still a single clean press.
 *
 * @param {string[]} keys  encoded keys
 * @returns {Array<{type: 'keyDown'|'keyUp', value: string}>}
 */
export function buildKeyActions(keys) {
  const list = Array.isArray(keys) ? keys.filter(Boolean) : []
  if (!list.length) return []

  const modifiers = list.filter((k) => MODIFIER_KEYS.has(k))
  const targets = list.filter((k) => !MODIFIER_KEYS.has(k))

  const actions = []
  // Modifiers go down first and are held for the whole gesture.
  for (const mod of modifiers) actions.push({ type: 'keyDown', value: mod })
  // The target keys are pressed and released while the modifiers are down.
  for (const key of targets) {
    actions.push({ type: 'keyDown', value: key })
    actions.push({ type: 'keyUp', value: key })
  }
  // Modifiers are released last, in reverse order. When the sequence contains
  // only modifiers, this is also their keyUp — a lone modifier is pressed and
  // released exactly once.
  for (const mod of [...modifiers].reverse()) actions.push({ type: 'keyUp', value: mod })

  return actions
}

/**
 * Send key presses.
 *
 * All keys go into ONE action source so the whole sequence is delivered as
 * a single gesture — verified equivalent to the per-character form, but
 * fewer round trips.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.context
 * @param {string[]} opts.keys  encoded keys
 * @param {(params: Record<string, any>) => Promise<any>} [opts.perform]
 */
export async function pressKeys(client, opts) {
  const actions = buildKeyActions(opts.keys)
  if (!actions.length) return {}
  return performInput(client, opts, {
    context: opts.context,
    actions: [{ type: 'key', id: 'firefox-browser-key', actions }],
  })
}

/**
 * Type text into the focused element, one key action per character.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.context
 * @param {string} opts.text
 * @param {(params: Record<string, any>) => Promise<any>} [opts.perform]
 */
export async function typeText(client, opts) {
  const text = String(opts.text).replace(/\r\n?/g, '\n')
  if (!text.length) return {}
  const actions = []
  for (const ch of text) {
    const value = ch === '\n' ? KEY_CODES.ENTER : ch === '\t' ? KEY_CODES.TAB : ch
    actions.push({ type: 'keyDown', value })
    actions.push({ type: 'keyUp', value })
  }
  return performInput(client, opts, {
    context: opts.context,
    actions: [{ type: 'key', id: 'firefox-browser-key', actions }],
  })
}

/**
 * Focus an element without typing.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.context
 * @param {string} [opts.selector]
 * @param {string} [opts.ref]
 * @param {string} [opts.key]
 * @returns {Promise<boolean>} true when the element received focus
 */
export async function focusElement(client, opts) {
  const result = await client.send('script.callFunction', {
    functionDeclaration: FOCUS_ELEMENT_SCRIPT,
    arguments: [
      { type: 'string', value: opts.key || '' },
      { type: 'string', value: opts.ref || '' },
      { type: 'string', value: opts.selector || '' },
    ],
    target: { context: opts.context },
    awaitPromise: true,
    resultOwnership: 'none',
  })
  return unwrapRemoteValue(result.result || {}) === true
}

/**
 * Clear an input's current value.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {Record<string, any>} opts
 * @returns {Promise<boolean>}
 */
export async function clearElement(client, opts) {
  const result = await client.send('script.callFunction', {
    functionDeclaration: CLEAR_ELEMENT_SCRIPT,
    arguments: [
      { type: 'string', value: opts.key || '' },
      { type: 'string', value: opts.ref || '' },
      { type: 'string', value: opts.selector || '' },
    ],
    target: { context: opts.context },
    awaitPromise: true,
    resultOwnership: 'none',
  })
  return unwrapRemoteValue(result.result || {}) === true
}

/**
 * Choose an option in a `<select>`.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {Record<string, any>} opts
 * @returns {Promise<Record<string, any>>}
 */
export async function selectOption(client, opts) {
  const result = await client.send('script.callFunction', {
    functionDeclaration: SELECT_OPTION_SCRIPT,
    arguments: [
      { type: 'string', value: opts.key || '' },
      { type: 'string', value: opts.ref || '' },
      { type: 'string', value: opts.selector || '' },
      { type: 'string', value: String(opts.value) },
      { type: 'boolean', value: !!opts.byText },
    ],
    target: { context: opts.context },
    awaitPromise: true,
    resultOwnership: 'none',
  })

  const value = unwrapRemoteValue(result.result || {})
  if (!value || typeof value !== 'object') {
    return {
      ok: false,
      code: 'internal',
      error: 'select failed: the page returned no usable result',
    }
  }
  return /** @type {Record<string, any>} */ (value)
}

/**
 * Check or uncheck a checkbox / radio button.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {Record<string, any>} opts
 * @returns {Promise<Record<string, any>>}
 */
export async function checkElement(client, opts) {
  const result = await client.send('script.callFunction', {
    functionDeclaration: CHECK_ELEMENT_SCRIPT,
    arguments: [
      { type: 'string', value: opts.key || '' },
      { type: 'string', value: opts.ref || '' },
      { type: 'string', value: opts.selector || '' },
      { type: 'boolean', value: !!opts.checked },
    ],
    target: { context: opts.context },
    awaitPromise: true,
    resultOwnership: 'none',
  })

  const value = unwrapRemoteValue(result.result || {})
  if (!value || typeof value !== 'object') {
    return {
      ok: false,
      code: 'internal',
      error: 'check failed: the page returned no usable result',
    }
  }
  return /** @type {Record<string, any>} */ (value)
}

/**
 * Scroll the page or an element container.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {Record<string, any>} opts
 * @returns {Promise<Record<string, any>>}
 */
export async function scroll(client, opts) {
  const hasExplicitDirection = opts.direction !== undefined || opts.amount !== undefined
  const result = await client.send('script.callFunction', {
    functionDeclaration: SCROLL_SCRIPT,
    arguments: [
      { type: 'string', value: opts.key || '' },
      { type: 'string', value: opts.ref || '' },
      { type: 'string', value: opts.selector || '' },
      { type: 'string', value: opts.direction || 'down' },
      { type: 'number', value: opts.amount === undefined ? 400 : opts.amount },
      { type: 'boolean', value: hasExplicitDirection },
    ],
    target: { context: opts.context },
    awaitPromise: true,
    resultOwnership: 'none',
  })

  const value = unwrapRemoteValue(result.result || {})
  if (!value || typeof value !== 'object') {
    return {
      ok: false,
      code: 'internal',
      error: 'scroll failed: the page returned no usable result',
    }
  }
  return /** @type {Record<string, any>} */ (value)
}
