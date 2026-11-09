// lib/firefox/captcha/turnstile.js
// Solve a Cloudflare Turnstile checkbox.
//
// The hard part is not the click, it is REACHING the checkbox. Turnstile
// renders it inside a CLOSED shadow root inside a cross-origin frame, so:
//   - the page's own `document.querySelectorAll` finds nothing;
//   - the plugin's snapshot (which pierces OPEN shadow roots) finds nothing.
//
// The way in is the preload script, which parks closed roots on their host
// element before the page's scripts run. See ./detect.js for that script.
//
// The click itself is dispatched to the CHALLENGE FRAME's own browsing
// context using frame-local coordinates, so no cross-frame coordinate
// conversion is needed. Dispatching to the top-level context instead lands
// the pointer in the wrong place: the frame sits at an offset inside a
// closed shadow root, which the top-level page cannot even query.

import { evaluate } from '../../bidi/protocol.js'
import { pointerClick } from '../inputs.js'
import { readTokenLength } from './detect.js'
import { rootsSource } from './roots.js'

/**
 * Look for the Turnstile checkbox inside the frame's closed shadow root.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} closedRootProp
 * @returns {Promise<{x: number, y: number, found: boolean}>}
 */
export async function findCheckbox(client, contextId, closedRootProp) {
  const expression = `(() => {
  const PROP = ${JSON.stringify(closedRootProp)};
  ${rootsSource('PROP')}
  const SELECTORS = [
    'input[type=checkbox]',
    '[role=checkbox]',
    '#challenge-stage input[type=checkbox]',
    '.cb-lb',
    '.cb-lb-checkbox',
    'label',
  ];
  for (const root of roots) {
    for (const sel of SELECTORS) {
      let el = null;
      try { el = root.querySelector(sel); } catch (e) { el = null; }
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      return { found: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
               width: Math.round(r.width), height: Math.round(r.height) };
    }
  }
  return { found: false };
})()`
  try {
    const remote = await evaluate(client, expression, contextId)
    const value = remote && remote.type === 'object' ? remote.value : remote
    const unwrapped = unwrapObject(value)
    if (unwrapped && unwrapped.found) return unwrapped
    return { found: false }
  } catch {
    return { found: false }
  }
}

/**
 * Unwrap a BiDi object RemoteValue into a plain object.
 *
 * @param {any} raw
 * @returns {object|null}
 */
function unwrapObject(raw) {
  if (!raw) return null
  if (typeof raw !== 'object') return null
  if (Array.isArray(raw)) {
    const out = {}
    for (const pair of raw) {
      if (!Array.isArray(pair) || pair.length !== 2) continue
      out[pair[0]] = unwrapScalar(pair[1])
    }
    return out
  }
  return raw
}

/**
 * Unwrap a scalar RemoteValue.
 *
 * @param {any} remote
 * @returns {any}
 */
function unwrapScalar(remote) {
  if (!remote || typeof remote !== 'object') return remote
  if (remote.type === 'object') return unwrapObject(remote.value)
  return remote.value
}

/**
 * Solve a Turnstile challenge.
 *
 * @param {object} deps
 * @param {import('../../bidi/client.js').BidiClient} deps.client
 * @param {string} deps.contextId   the challenge frame's context
 * @param {string} deps.topContextId the top-level context (token lives here)
 * @param {object} deps.challenge   the CHALLENGES entry
 * @param {string} deps.closedRootProp
 * @param {number} [deps.timeoutMs]
 * @returns {Promise<object>} a result describing what happened
 */
export async function solveTurnstile(deps) {
  const { client, contextId, topContextId, challenge, closedRootProp } = deps
  const timeoutMs = deps.timeoutMs || 30000
  const deadline = Date.now() + timeoutMs

  const checkbox = await findCheckbox(client, contextId, closedRootProp)
  if (!checkbox.found) {
    return {
      ok: false,
      status: 'checkbox_not_found',
      message:
        'The Turnstile checkbox was not reachable. The page may not have finished ' +
        'loading the challenge, or the widget may be refusing to render (a headless ' +
        'or automated browser is often refused outright).',
    }
  }

  // Click it inside its own frame, with frame-local coordinates.
  try {
    await pointerClick(client, { context: contextId, x: checkbox.x, y: checkbox.y })
  } catch (err) {
    return {
      ok: false,
      status: 'click_failed',
      message: `Could not dispatch the click: ${err && err.message ? err.message : err}`,
    }
  }

  // The token lands in the TOP-LEVEL page, not in the frame.
  const tokenSelector = challenge.tokenSelector
  const tokenLength = await waitForToken(client, topContextId, tokenSelector, deadline)
  if (tokenLength > 0) {
    return {
      ok: true,
      status: 'solved',
      tokenLength,
      clicked: { x: checkbox.x, y: checkbox.y },
    }
  }

  return {
    ok: false,
    status: 'no_token',
    message:
      'The checkbox was clicked but no token was issued. The challenge may need a ' +
      'human to interact with it, or the site may have rejected the attempt.',
    clicked: { x: checkbox.x, y: checkbox.y },
  }
}

/**
 * Poll for a token to appear.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} selector
 * @param {number} deadline
 * @returns {Promise<number>}
 */
export async function waitForToken(client, contextId, selector, deadline) {
  for (;;) {
    const length = await readTokenLength(client, contextId, selector)
    if (length > 0) return length
    if (Date.now() >= deadline) return 0
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
}
