// lib/firefox/captcha/audio.js
// Solve reCAPTCHA v2 and hCaptcha.
//
// Both challenges are the same shape:
//   1. A checkbox the user clicks.
//   2. If the checkbox does not clear the challenge immediately, an image or
//      audio challenge appears.
//   3. The AUDIO challenge is the one worth automating: it is a short
//      spoken phrase, transcribed by a speech-to-text service and typed
//      into the answer field.
//
// The image grid is NOT solved here — it needs a vision model, which this
// plugin deliberately does not bundle. When an image challenge shows up the
// solver says so plainly instead of failing quietly.

import { evaluate } from '../../bidi/protocol.js'
import { pointerClick } from '../inputs.js'
import { transcribe } from './stt.js'
import { rootsSource } from './roots.js'

/**
 * Find a clickable checkbox inside a challenge frame.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} closedRootProp
 * @param {string[]} selectors
 * @returns {Promise<{found: boolean, x?: number, y?: number}>}
 */
export async function findInChallenge(client, contextId, closedRootProp, selectors) {
  const expression = `(() => {
  const PROP = ${JSON.stringify(closedRootProp)};
  ${rootsSource('PROP')}
  const SELECTORS = ${JSON.stringify(selectors)};
  for (const root of roots) {
    for (const sel of SELECTORS) {
      let el = null;
      try { el = root.querySelector(sel); } catch (e) { el = null; }
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      return { found: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }
  }
  return { found: false };
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
    return out.found ? out : { found: false }
  } catch {
    return { found: false }
  }
}

/**
 * Read the state of a challenge frame: is there an audio button, an image
 * grid, an answer field?
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} closedRootProp
 * @returns {Promise<object>}
 */
export async function readChallengeState(client, contextId, closedRootProp) {
  const expression = `(() => {
  const PROP = ${JSON.stringify(closedRootProp)};
  ${rootsSource('PROP')}
  const q = (sels) => {
    for (const root of roots) {
      for (const sel of sels) {
        let el = null;
        try { el = root.querySelector(sel); } catch (e) { el = null; }
        if (el) {
          const r = el.getBoundingClientRect();
          return { found: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
                   value: 'value' in el ? String(el.value || '') : null };
        }
      }
    }
    return { found: false };
  };
  const audio = q(['#audio-src', '.audio-button', '[id*=audio]', 'a[href*="mp3"]']);
  const answer = q(['#audio-response', '.audio-response', 'input[type=text]', 'textarea']);
  const grid = q(['.rc-imageselect', '.challenge-image', '.task-image', '.image-grid']);
  return {
    audio: audio.found,
    audioUrl: audio.found ? (audio.value || null) : null,
    audioRect: audio.found ? { x: audio.x, y: audio.y } : null,
    answerField: answer.found,
    answerRect: answer.found ? { x: answer.x, y: answer.y } : null,
    imageGrid: grid.found,
  };
})()`
  try {
    const remote = await evaluate(client, expression, contextId)
    const value = remote && remote.type === 'object' ? remote.value : value
    const out = {}
    for (const pair of Array.isArray(value) ? value : []) {
      if (!Array.isArray(pair) || pair.length !== 2) continue
      const raw = pair[1]
      out[pair[0]] = raw && typeof raw === 'object' ? unwrap(raw) : raw
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Unwrap a nested RemoteValue.
 *
 * @param {any} remote
 * @returns {any}
 */
function unwrap(remote) {
  if (!remote || typeof remote !== 'object') return remote
  if (remote.type === 'object') {
    const out = {}
    for (const pair of Array.isArray(remote.value) ? remote.value : []) {
      if (!Array.isArray(pair) || pair.length !== 2) continue
      out[pair[0]] = unwrap(pair[1])
    }
    return out
  }
  return remote.value
}

/**
 * Fetch the challenge audio as base64 from inside the frame's realm.
 *
 * The audio lives on the challenge vendor's origin, so it is fetched from
 * within that frame — which has the right origin and the right cookies.
 * `network.getData` would need Firefox >= 144; this works everywhere.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} audioUrl
 * @returns {Promise<{ok: boolean, base64?: string, message?: string}>}
 */
export async function fetchAudioBase64(client, contextId, audioUrl) {
  const expression = `(async () => {
  try {
    const res = await fetch(${JSON.stringify(audioUrl)});
    if (!res.ok) return { ok: false, message: 'HTTP ' + res.status };
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    }
    return { ok: true, base64: btoa(bin), bytes: buf.length };
  } catch (e) {
    return { ok: false, message: String(e && e.message ? e.message : e) };
  }
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
  } catch (err) {
    return { ok: false, message: `Could not read the challenge audio: ${err && err.message ? err.message : err}` }
  }
}

/**
 * Type an answer into the challenge's answer field.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} closedRootProp
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function typeAnswer(client, contextId, closedRootProp, text) {
  const expression = `(() => {
  const PROP = ${JSON.stringify(closedRootProp)};
  ${rootsSource('PROP')}
  const SELECTORS = ['#audio-response', '.audio-response', '#response', 'input[type=text]', 'textarea'];
  for (const root of roots) {
    for (const sel of SELECTORS) {
      let el = null;
      try { el = root.querySelector(sel); } catch (e) { el = null; }
      if (!el) continue;
      el.focus();
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
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
 * The shared solve routine for reCAPTCHA and hCaptcha.
 *
 * @param {object} opts
 * @param {import('../../bidi/client.js').BidiClient} opts.client
 * @param {string} opts.contextId
 * @param {string} opts.topContextId
 * @param {object} opts.challenge
 * @param {string} opts.closedRootProp
 * @param {string[]} opts.checkboxSelectors
 * @param {string} [opts.sttUrl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<object>}
 */
export async function solveAudioChallenge(opts) {
  const {
    client,
    contextId,
    topContextId,
    challenge,
    closedRootProp,
    checkboxSelectors,
    sttUrl = '',
    timeoutMs = 30000,
  } = opts

  const deadline = Date.now() + timeoutMs

  const checkbox = await findInChallenge(client, contextId, closedRootProp, checkboxSelectors)
  if (!checkbox.found) {
    return {
      ok: false,
      status: 'checkbox_not_found',
      message:
        `No ${challenge.label} checkbox was reachable. The widget may not have ` +
        'finished loading, or it may refuse to render in an automated browser.',
    }
  }

  try {
    await pointerClick(client, { context: contextId, x: checkbox.x, y: checkbox.y })
  } catch (err) {
    return {
      ok: false,
      status: 'click_failed',
      message: `Could not dispatch the click: ${err && err.message ? err.message : err}`,
    }
  }

  // Give the widget a moment: many challenges clear the checkbox outright,
  // in which case a token appears and there is nothing more to do.
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const tokenNow = await readToken(client, topContextId, challenge.tokenSelector)
  if (tokenNow > 0) {
    return { ok: true, status: 'solved', tokenLength: tokenNow, via: 'checkbox' }
  }

  // Otherwise a challenge appeared. Audio is solvable; images are not.
  const state = await readChallengeState(client, contextId, closedRootProp)
  if (state.imageGrid) {
    return {
      ok: false,
      status: 'vision_unavailable',
      message:
        `${challenge.label} presented an IMAGE challenge. Solving image grids needs a ` +
        'vision model, which this plugin does not bundle. Point `visionUrl` at a ' +
        'compatible service, or solve the challenge manually.',
    }
  }

  if (!state.audio) {
    return {
      ok: false,
      status: 'no_audio_challenge',
      message:
        `The ${challenge.label} checkbox was clicked but no solvable challenge ` +
        'appeared. The site may need a different interaction.',
    }
  }

  const audioUrl = state.audioUrl
  if (!audioUrl) {
    return {
      ok: false,
      status: 'audio_unavailable',
      message: 'The audio challenge was present but its source could not be determined.',
    }
  }

  const audio = await fetchAudioBase64(client, contextId, audioUrl)
  if (!audio.ok) {
    return {
      ok: false,
      status: 'audio_fetch_failed',
      message: `Could not download the audio challenge: ${audio.message || 'unknown error'}`,
    }
  }

  const buffer = Buffer.from(audio.base64, 'base64')
  const result = await transcribe({ sttUrl, audio: buffer, filename: 'audio.mp3' })
  if (!result.ok) {
    return { ok: false, status: result.status, message: result.message }
  }

  // reCAPTCHA audio answers are case-insensitive words; normalise the way the
  // challenge itself expects (lowercase, single spaces).
  const answer = result.transcript.toLowerCase().trim().replace(/\s+/g, ' ')
  const typed = await typeAnswer(client, contextId, closedRootProp, answer)
  if (!typed) {
    return {
      ok: false,
      status: 'answer_not_typed',
      message: 'The transcript was produced but the answer field was not reachable.',
    }
  }

  // Submit the answer.
  const submitted = await clickSubmit(client, contextId, closedRootProp)
  if (!submitted) {
    return {
      ok: false,
      status: 'not_submitted',
      message: 'The answer was typed but the submit button was not reachable.',
      transcript: answer,
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 2000))
  const token = await waitForToken(client, topContextId, challenge.tokenSelector, deadline)
  if (token > 0) {
    return { ok: true, status: 'solved', tokenLength: token, via: 'audio', transcript: answer }
  }

  return {
    ok: false,
    status: 'wrong_answer',
    message:
      'The audio answer was submitted but no token was issued — the transcript was ' +
      'probably wrong. A different speech-to-text model may do better.',
    transcript: answer,
  }
}

/**
 * Click the challenge's submit/verify button.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} closedRootProp
 * @returns {Promise<boolean>}
 */
async function clickSubmit(client, contextId, closedRootProp) {
  const expression = `(() => {
  const PROP = ${JSON.stringify(closedRootProp)};
  ${rootsSource('PROP')}
  const SELECTORS = ['#audio-submit', 'button[type=submit]', '.verify-button', '#verify'];
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
 * Read a token input's length.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} selector
 * @returns {Promise<number>}
 */
async function readToken(client, contextId, selector) {
  const expression = `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  return el ? String(el.value || '').length : 0;
})()`
  try {
    const remote = await evaluate(client, expression, contextId)
    return typeof remote.value === 'number' ? remote.value : 0
  } catch {
    return 0
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
async function waitForToken(client, contextId, selector, deadline) {
  for (;;) {
    const length = await readToken(client, contextId, selector)
    if (length > 0) return length
    if (Date.now() >= deadline) return 0
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
}

/**
 * Solve a reCAPTCHA v2 challenge.
 *
 * @param {object} opts
 * @returns {Promise<object>}
 */
export async function solveRecaptcha(opts) {
  return solveAudioChallenge({
    ...opts,
    checkboxSelectors: [
      '#recaptcha-anchor',
      '.recaptcha-checkbox',
      '#recaptcha-anchor .recaptcha-checkbox-border',
      'input[type=checkbox]',
    ],
  })
}

/**
 * Solve an hCaptcha challenge.
 *
 * @param {object} opts
 * @returns {Promise<object>}
 */
export async function solveHcaptcha(opts) {
  return solveAudioChallenge({
    ...opts,
    checkboxSelectors: [
      '.h-captcha-checkbox',
      '#checkbox',
      '.check',
      'input[type=checkbox]',
    ],
  })
}
