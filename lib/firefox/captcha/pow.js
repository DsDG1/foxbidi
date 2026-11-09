// lib/firefox/captcha/pow.js
// Solve proof-of-work CAPTCHAs: ALTCHA, Cap, Anubis, Friendly Captcha.
//
// These challenges are not puzzles a human solves visually — the page runs a
// hash search in the browser and only then hands over a token. The work
// happens in the page's own JavaScript, so all the solver has to do is wait
// for the widget to finish and read the token it produced.
//
// That makes this the cheapest solver in the set: no model, no network, no
// pointer events. It is also the most robust to layout changes, because it
// never touches the DOM structure — only the token.

import { evaluate } from '../../bidi/protocol.js'
import { readTokenLength } from './detect.js'
import { rootsSource } from './roots.js'

/**
 * Read the token a proof-of-work widget produced.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} closedRootProp
 * @returns {Promise<{ok: boolean, token?: string, source?: string}>}
 */
async function readPowToken(client, contextId, closedRootProp) {
  const expression = `(() => {
  const PROP = ${JSON.stringify(closedRootProp)};
  ${rootsSource('PROP')}
  const SELECTORS = [
    'input[name=altcha]', 'textarea[name=altcha]', '[name=altcha]',
    'input[name=pow]', 'textarea[name=pow]', '[name=pow]',
    'input[name=payload]', 'textarea[name=payload]',
    'input[name=frc-token]', 'input[name=token]',
    'input[type=hidden][name]',
  ];
  for (const root of roots) {
    for (const sel of SELECTORS) {
      let el = null;
      try { el = root.querySelector(sel); } catch (e) { el = null; }
      if (!el) continue;
      const value = String(el.value || '').trim();
      if (value) return { ok: true, token: value, source: sel };
    }
  }
  return { ok: false };
})()`
  try {
    const remote = await evaluate(client, expression, contextId)
    const value = remote && remote.type === 'object' ? remote.value : remote
    const out = {}
    for (const pair of Array.isArray(value) ? value : []) {
      if (!Array.isArray(pair) || pair.length !== 2) continue
      const raw = pair[1]
      out[pair[0]] = raw && typeof raw === 'object' ? raw.value : raw
    }
    return out
  } catch {
    return { ok: false }
  }
}

/**
 * Ask the widget to start, if it has not already.
 *
 * ALTCHA and Cap both render a checkbox the user clicks to trigger the
 * hash search. Friendly Captcha runs automatically.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} closedRootProp
 * @returns {Promise<boolean>} true when a widget was clicked
 */
async function startWidget(client, contextId, closedRootProp) {
  const expression = `(() => {
  const PROP = ${JSON.stringify(closedRootProp)};
  ${rootsSource('PROP')}
  const SELECTORS = [
    '.altcha-checkbox', '.altcha-checkbox input', 'input[name=altcha]',
    '.cap-button', '.cap-checkbox', 'button.cap-button',
    '.anubis-checkbox', '.frc-checkbox', '.frc-button',
    'button[type=submit]',
  ];
  for (const root of roots) {
    for (const sel of SELECTORS) {
      let el = null;
      try { el = root.querySelector(sel); } catch (e) { el = null; }
      if (!el) continue;
      el.click();
      return true;
    }
  }
  return false;
})()`
  try {
    const remote = await evaluate(client, expression, contextId)
    return remote && remote.value === true
  } catch {
    return false
  }
}

/**
 * Solve a proof-of-work challenge.
 *
 * @param {object} opts
 * @param {import('../../bidi/client.js').BidiClient} opts.client
 * @param {string} opts.contextId
 * @param {string} opts.topContextId
 * @param {object} opts.challenge
 * @param {string} opts.closedRootProp
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<object>}
 */
export async function solvePow(opts) {
  const { client, contextId, topContextId, challenge, closedRootProp } = opts
  const deadline = Date.now() + (opts.timeoutMs || 30000)

  // Some widgets need a click to begin the search; others already run.
  await startWidget(client, contextId, closedRootProp)

  for (;;) {
    const token = await readPowToken(client, contextId, closedRootProp)
    if (token.ok) {
      return {
        ok: true,
        status: 'solved',
        tokenLength: token.token.length,
        via: 'proof-of-work',
        source: token.source,
      }
    }

    // The token may also land in the top-level page as a hidden input.
    const topToken = await readTokenLength(client, topContextId, challenge.tokenSelector)
    if (topToken > 0) {
      return { ok: true, status: 'solved', tokenLength: topToken, via: 'proof-of-work' }
    }

    if (Date.now() >= deadline) {
      return {
        ok: false,
        status: 'pow_timeout',
        message:
          'The proof-of-work challenge did not produce a token in time. The widget ' +
          'may be idle until it receives a click, or it may be running a search ' +
          'that takes longer than the timeout.',
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
