// lib/firefox/captcha/detect.js
// Challenge detection across the top-level page and its frames.
//
// A CAPTCHA challenge is rarely in the page you asked about. Turnstile puts
// its checkbox in a `challenges.cloudflare.com` iframe, reCAPTCHA in a
// `google.com/recaptcha` iframe, GeeTest in its own frame. So detection walks
// the whole browsing-context tree and asks each frame what it is.
//
// Detection is deliberately READ-ONLY: it never clicks, types, or moves the
// pointer. That keeps `solver: 'auto'` safe to call as a probe.

import { getTree, evaluate } from '../../bidi/protocol.js'

/**
 * The property the preload script parks closed shadow roots on.
 *
 * It must NOT collide with the plugin's own `__ffb_` registry keys — the
 * registry relies on being able to find its own handles, and a solver that
 * squatted on the same prefix would confuse `browser_detectability`.
 */
export const CLOSED_ROOT_PROP = '__captcha_closed_root'

/**
 * The preload script that keeps closed shadow roots reachable.
 *
 * Without it, a Turnstile checkbox is genuinely unreachable: the widget
 * renders inside a CLOSED shadow root, so `document.body.children` is empty
 * and no selector — open or closed — can find the checkbox. The script runs
 * before the page's own scripts, so it sees every `attachShadow` call.
 *
 * The patch is observable by the page (a page could notice that
 * `attachShadow` is not native), which is a deliberate trade: not being able
 * to see the checkbox is strictly worse than being detected.
 *
 * @returns {string} a function expression suitable for addPreloadScript
 */
export function preloadSource() {
  return `() => {
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = orig.call(this, init);
    try {
      Object.defineProperty(this, ${JSON.stringify(CLOSED_ROOT_PROP)}, {
        value: root,
        configurable: true,
      });
    } catch (e) {}
    return root;
  };
}`
}

/**
 * Per-challenge detection rules.
 *
 * Each rule lists the frame URLs that identify the challenge and the page
 * level markers that identify an embedded (non-iframed) widget.
 *
 * `tokenSelector` is where the solved token lands — its value length is how
 * we tell "solved" from "still showing a challenge".
 */
export const CHALLENGES = {
  turnstile: {
    id: 'turnstile',
    label: 'Cloudflare Turnstile',
    frameUrls: ['challenges.cloudflare.com', 'cdn-cgi/challenge-platform'],
    pageMarkers: ['.cf-turnstile', '#cf-turnstile', 'iframe[src*="challenges.cloudflare.com"]'],
    tokenSelector: 'input[name="cf-turnstile-response"]',
    tokenField: 'cf-turnstile-response',
  },
  recaptcha: {
    id: 'recaptcha',
    label: 'reCAPTCHA v2',
    frameUrls: ['google.com/recaptcha', 'recaptcha/api2', 'recaptcha/api.js'],
    pageMarkers: ['.g-recaptcha', '#g-recaptcha', 'iframe[src*="recaptcha"]'],
    tokenSelector: 'textarea[name="g-recaptcha-response"], input[name="g-recaptcha-response"]',
    tokenField: 'g-recaptcha-response',
  },
  hcaptcha: {
    id: 'hcaptcha',
    label: 'hCaptcha',
    frameUrls: ['hcaptcha.com', 'js.hcaptcha.com'],
    pageMarkers: ['.h-captcha', '#h-captcha', 'iframe[src*="hcaptcha"]'],
    tokenSelector: 'textarea[name="h-captcha-response"], input[name="h-captcha-response"]',
    tokenField: 'h-captcha-response',
  },
  geetest: {
    id: 'geetest',
    label: 'GeeTest slider',
    frameUrls: ['geetest.com', 'gcaptcha'],
    pageMarkers: ['.geetest_captcha', '.geetest_holder', '.gt_slider', '.geetest_slider'],
    tokenSelector: 'input[name="geetest_validate"], input[name="geetest_token"]',
    tokenField: 'geetest_validate',
  },
  pow: {
    id: 'pow',
    label: 'Proof-of-work CAPTCHA',
    frameUrls: ['altcha.org', 'cap.js', 'anubis', 'friendlycaptcha'],
    pageMarkers: ['.altcha', '#altcha', '.cap', '.anubis', '.frc-captcha'],
    tokenSelector: '[name="altcha"], [name="pow"], input[name="payload"]',
    tokenField: 'altcha',
  },
  spin: {
    id: 'spin',
    label: 'Spin (rotate-to-upright)',
    frameUrls: ['wappass.baidu.com/static/captcha', 'passport.baidu.com/cap'],
    pageMarkers: ['.passMod_spin-wrapper', '.passMod_spin-background', '.passMod_slide-control'],
    // The spin captcha issues no token: it answers by accepting the drag.
    // The success signal is the server's verdict on POST /cap/log, and the
    // widget itself disappears once the site lets the session through.
    tokenless: true,
    solvedSelector: '.passMod_spin-wrapper',
    tokenSelector: '',
    tokenField: '',
  },
}

/**
 * The order `solver: 'auto'` tries. Turnstile first because it is the most
 * common and the cheapest to solve (one click, no model, no network).
 */
export const AUTO_ORDER = ['turnstile', 'recaptcha', 'hcaptcha', 'geetest', 'pow', 'spin']

/**
 * Flatten the browsing-context tree into a list of frames.
 *
 * @param {Array} tree  the result of bidi.getTree()
 * @returns {Array<{contextId: string, url: string, depth: number}>}
 */
export function flattenTree(tree) {
  const out = []
  const walk = (nodes, depth) => {
    for (const node of nodes || []) {
      out.push({
        contextId: node.contextId,
        url: node.url || '',
        depth,
        children: node.children || [],
      })
      if (node.children && node.children.length) walk(node.children, depth + 1)
    }
  }
  walk(tree, 0)
  return out
}

/**
 * Match a frame URL against a challenge's URL patterns.
 *
 * @param {string} url
 * @param {object} challenge
 * @returns {boolean}
 */
export function urlMatchesChallenge(url, challenge) {
  if (!url) return false
  const haystack = url.toLowerCase()
  return challenge.frameUrls.some((needle) => haystack.includes(needle.toLowerCase()))
}

/**
 * Which challenge a frame URL belongs to.
 *
 * @param {string} url
 * @returns {object|null}
 */
export function challengeForUrl(url) {
  for (const id of AUTO_ORDER) {
    const challenge = CHALLENGES[id]
    if (urlMatchesChallenge(url, challenge)) return challenge
  }
  return null
}

/**
 * Ask one frame what challenge it hosts.
 *
 * The frame may host the widget directly (Geetest renders in place) or be a
 * bare challenge frame whose widget lives in a closed shadow root. Both are
 * covered: the probe walks open shadow roots itself and also looks for the
 * parked closed root.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @returns {Promise<object>} a probe result; `detected` is false when nothing
 *   matched
 */
export async function probeFrame(client, contextId) {
  const expression = `(() => {
  const PROP = ${JSON.stringify(CLOSED_ROOT_PROP)};
  const roots = [document];
  const closed = [];
  const collectClosed = (el) => {
    if (el[PROP]) closed.push(el[PROP]);
  };
  try { collectClosed(document.body); } catch (e) {}
  try { collectClosed(document.documentElement); } catch (e) {}
  for (const el of document.querySelectorAll('*')) {
    if (el[PROP]) closed.push(el[PROP]);
    if (el.shadowRoot) roots.push(el.shadowRoot);
  }
  const all = roots.concat(closed);
  const markers = {
    turnstile: ['input[type=checkbox]', '[role=checkbox]', '#challenge-stage', '.cb-lb', '.cb-lb-checkbox'],
    recaptcha: ['#recaptcha-anchor', '.recaptcha-checkbox', '#recaptcha-anchor .recaptcha-checkbox-border'],
    hcaptcha: ['.h-captcha-checkbox', '#checkbox', '.check'],
    geetest: ['.geetest_slider_button', '.gt_slider_knob', '.geetest_btn', '.geetest_slider'],
    pow: ['.altcha-checkbox', '.cap-button', 'button[type=submit]'],
    // The spin widget's handle is the drag target, so it doubles as the probe.
    spin: ['.passMod_slide-btn'],
  };
  for (const root of all) {
    for (const key of Object.keys(markers)) {
      for (const sel of markers[key]) {
        let el = null;
        try { el = root.querySelector(sel); } catch (e) { el = null; }
        if (!el) continue;
        const r = el.getBoundingClientRect();
        return {
          detected: true,
          kind: key,
          selector: sel,
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      }
    }
  }
  return { detected: false };
})()`
  try {
    const remote = await evaluate(client, expression, contextId)
    const value = unwrap(remote)
    return value && value.detected ? value : { detected: false }
  } catch {
    // A frame we cannot evaluate (cross-origin, detached, or CSP-locked) is
    // not an error — it just does not host a challenge we can work with.
    return { detected: false }
  }
}

/**
 * Read a token input's length from a context.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} selector
 * @returns {Promise<number>} the token length, 0 when there is no token
 */
export async function readTokenLength(client, contextId, selector) {
  const expression = `(() => {
  const sel = ${JSON.stringify(selector)};
  const el = document.querySelector(sel);
  return el ? String(el.value || '').length : 0;
})()`
  try {
    const remote = await evaluate(client, expression, contextId)
    const value = unwrap(remote)
    return typeof value === 'number' ? value : 0
  } catch {
    return 0
  }
}

/**
 * Unwrap a BiDi RemoteValue into a plain JS value.
 *
 * @param {object} remote
 * @returns {any}
 */
function unwrap(remote) {
  if (!remote || typeof remote !== 'object') return remote
  if (remote.type === 'array') {
    return (remote.value || []).map(unwrap)
  }
  if (remote.type === 'object') {
    const raw = remote.value
    if (Array.isArray(raw)) {
      const out = {}
      for (const pair of raw) {
        if (!Array.isArray(pair) || pair.length !== 2) continue
        out[pair[0]] = unwrap(pair[1])
      }
      return out
    }
  }
  if (remote.type === 'number' || remote.type === 'string' || remote.type === 'boolean') {
    return remote.value
  }
  if (remote.type === 'null' || remote.value === null) return null
  return remote.value
}

/**
 * Find every challenge currently on the page.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} topContextId
 * @returns {Promise<Array<object>>} one entry per detected challenge
 */
export async function detectChallenges(client, topContextId) {
  let tree
  try {
    tree = await getTree(client)
  } catch {
    return []
  }
  const frames = flattenTree(tree)
  const found = []

  for (const frame of frames) {
    const byUrl = challengeForUrl(frame.url)
    const probe = await probeFrame(client, frame.contextId)
    if (!probe.detected) continue
    const kind = probe.kind || (byUrl ? byUrl.id : null)
    if (!kind) continue
    const challenge = CHALLENGES[kind]
    if (!challenge) continue
    found.push({
      kind,
      challenge,
      contextId: frame.contextId,
      url: frame.url,
      depth: frame.depth,
      probe,
    })
  }

  // A challenge embedded directly in the top page (no dedicated frame) shows
  // up as a top-level probe. Keep the first sighting per kind.
  const seen = new Set()
  return found.filter((entry) => {
    if (seen.has(entry.kind)) return false
    seen.add(entry.kind)
    return true
  })
}
