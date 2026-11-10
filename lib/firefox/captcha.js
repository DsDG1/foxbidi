// lib/firefox/captcha.js
// Orchestration for CAPTCHA solving.
//
// The flow is: detect -> pick a solver -> solve -> verify. Two rules shape
// the code:
//
//   - VERIFY, DON'T ASSUME. A successful click is not a solved challenge.
//     The only evidence that counts is a token the site itself issued, read
//     back out of the page. Every solver returns `ok: true` only after that.
//
//   - DEGRADE LOUDLY. When a solver needs a service that is not configured
//     (a speech-to-text endpoint for audio challenges, a vision endpoint for
//     image grids), it returns a structured error naming the missing piece.
//     It never pretends to have solved the challenge, and it never hangs
//     waiting for something that will not arrive.

import { getTree, evaluate, addPreloadScript, unwrapRemoteValue } from '../bidi/protocol.js'
import {
  AUTO_ORDER,
  CHALLENGES,
  CLOSED_ROOT_PROP,
  detectChallenges,
  preloadSource,
  readTokenLength,
} from './captcha/detect.js'
import { solveTurnstile } from './captcha/turnstile.js'
import { solveRecaptcha, solveHcaptcha } from './captcha/audio.js'
import { solveGeetest } from './captcha/geetest.js'
import { solvePow } from './captcha/pow.js'
import { solveSpin } from './captcha/spin.js'

export { CHALLENGES, CLOSED_ROOT_PROP, AUTO_ORDER }

/** Solvers this build ships. */
const SOLVERS = {
  turnstile: solveTurnstile,
  recaptcha: solveRecaptcha,
  hcaptcha: solveHcaptcha,
  geetest: solveGeetest,
  pow: solvePow,
  spin: solveSpin,
}

/**
 * Track which contexts already carry the preload script.
 *
 * Installing the patch twice would wrap `attachShadow` twice: the second
 * wrapper would store the root the first wrapper already stored, and the
 * original would be called twice per shadow root.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {Set<string>} installed
 * @param {string} contextId
 * @returns {Promise<boolean>} true when the patch is in place
 */
export async function ensurePreload(client, installed, contextId) {
  if (!contextId) return false
  if (installed.has(contextId)) return true
  try {
    await addPreloadScript(client, preloadSource(), contextId)
    installed.add(contextId)
    return true
  } catch {
    // Firefox without preload support (or a context that refuses scripts)
    // still allows open-shadow-root solving, so this is not fatal.
    return false
  }
}

/**
 * Install the preload patch on the top-level context AND every frame.
 *
 * The patch has to be in place before the challenge mounts, so this is
 * called before navigating. Frames created later inherit the patch from
 * their parent context in Firefox; the explicit per-frame install is a
 * belt-and-braces fallback for frames that are opened by script.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {Set<string>} installed
 * @param {string} topContextId
 * @returns {Promise<number>} how many contexts were patched
 */
export async function prepareContext(client, installed, topContextId) {
  let count = 0
  if (await ensurePreload(client, installed, topContextId)) count += 1
  let tree = []
  try {
    tree = await getTree(client)
  } catch {
    return count
  }
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.contextId && node.contextId !== topContextId) {
        ensurePreload(client, installed, node.contextId).then((ok) => {
          if (ok) count += 1
        })
      }
      if (node.children) walk(node.children)
    }
  }
  walk(tree)
  return count
}

/**
 * Solve a CAPTCHA on the current page.
 *
 * @param {object} opts
 * @param {import('../bidi/client.js').BidiClient} opts.client
 * @param {string} opts.topContextId
 * @param {Set<string>} opts.preloadInstalled
 * @param {string} [opts.solver]  'auto' (default) or a specific challenge id
 * @param {string} [opts.sttUrl]  speech-to-text endpoint for audio challenges
 * @param {string} [opts.visionUrl]  image-recognition endpoint (optional)
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<object>} the outcome
 */
export async function solveCaptcha(opts) {
  const {
    client,
    topContextId,
    preloadInstalled,
    solver = 'auto',
    sttUrl = '',
    visionUrl = '',
    timeoutMs = 60000,
  } = opts

  if (!client || !topContextId) {
    return { ok: false, status: 'no_context', message: 'No browsing context to work in.' }
  }

  // The patch must be in place before the challenge renders. If the page is
  // already loaded, install now and let the caller reload if needed.
  await ensurePreload(client, preloadInstalled, topContextId)

  const detected = await detectChallenges(client, topContextId)

  if (solver && solver !== 'auto') {
    if (!SOLVERS[solver]) {
      return {
        ok: false,
        status: 'unknown_solver',
        message: `Unknown solver "${solver}". Known solvers: ${Object.keys(SOLVERS).join(', ')}.`,
      }
    }
    const entry = detected.find((d) => d.kind === solver)
    if (!entry) {
      return {
        ok: false,
        status: 'not_detected',
        solver,
        detected: detected.map((d) => d.kind),
        message: `No ${CHALLENGES[solver].label} challenge found on this page.`,
      }
    }
    return runSolver(SOLVERS[solver], {
      client,
      entry,
      topContextId,
      closedRootProp: CLOSED_ROOT_PROP,
      sttUrl,
      visionUrl,
      timeoutMs,
    })
  }

  if (detected.length === 0) {
    return {
      ok: false,
      status: 'not_detected',
      detected: [],
      message:
        'No supported CAPTCHA challenge found on this page. Checked for Turnstile, ' +
        'reCAPTCHA, hCaptcha, GeeTest and proof-of-work widgets.',
    }
  }

  // Auto: try each detected challenge in priority order, report the first
  // that succeeds. A failure on one kind does not stop the others.
  const ordered = detected.sort((a, b) => AUTO_ORDER.indexOf(a.kind) - AUTO_ORDER.indexOf(b.kind))
  const attempts = []
  for (const entry of ordered) {
    const solverFn = SOLVERS[entry.kind]
    if (!solverFn) continue
    const result = await runSolver(solverFn, {
      client,
      entry,
      topContextId,
      closedRootProp: CLOSED_ROOT_PROP,
      sttUrl,
      visionUrl,
      timeoutMs,
    })
    attempts.push({
      solver: entry.kind,
      status: result.status,
      ok: result.ok,
      // Keep the reason a solver gave. Without it a failure is just
      // "solve_failed" and there is no way to tell a detection bug from a
      // wrong answer.
      ...(result.message ? { message: result.message } : {}),
      // A solver that tried several times reports them here.
      ...(Array.isArray(result.attempts) ? { rounds: result.attempts } : {}),
    })
    if (result.ok) {
      return { ...result, solver: entry.kind, attempts }
    }
  }

  return {
    ok: false,
    status: 'solve_failed',
    attempts,
    detected: detected.map((d) => d.kind),
    message:
      'A challenge was found but could not be solved. See `attempts` for the ' +
      'per-challenge outcome.',
  }
}

/**
 * Run one solver and normalise its result.
 *
 * The detection entry is flattened into the solver's arguments: a solver
 * needs the CHALLENGE FRAME's context (that is where the widget and the
 * checkbox live) and the TOP-LEVEL context (that is where the token lands).
 * Those are different contexts, and mixing them up means clicking the wrong
 * frame and then looking for the token in the wrong place.
 *
 * @param {Function} solverFn
 * @param {object} args
 * @returns {Promise<object>}
 */
async function runSolver(solverFn, args) {
  const { entry } = args
  try {
    const result = await solverFn({
      ...args,
      contextId: entry.contextId,
      challenge: entry.challenge,
    })
    return result || { ok: false, status: 'no_result', message: 'The solver returned nothing.' }
  } catch (err) {
    return {
      ok: false,
      status: 'solver_error',
      message: `The solver failed: ${err && err.message ? err.message : err}`,
    }
  }
}

/**
 * Check whether a challenge is currently solved.
 *
 * Reads the token length the site would use, so the answer reflects the
 * SERVER's view of the challenge rather than the widget's appearance.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {string} topContextId
 * @param {string} kind
 * @returns {Promise<{solved: boolean, tokenLength: number}>}
 */
export async function checkSolved(client, topContextId, kind) {
  const challenge = CHALLENGES[kind]
  if (!challenge) return { solved: false, tokenLength: 0 }
  // A tokenless challenge (a rotate-to-upright slider) has no token to
  // read: the site accepts the gesture and the widget goes away.
  if (challenge.tokenless) {
    const present = await widgetOnPage(client, topContextId, challenge.solvedSelector)
    return { solved: !present, tokenLength: 0 }
  }
  const length = await readTokenLength(client, topContextId, challenge.tokenSelector)
  return { solved: length > 0, tokenLength: length }
}

/**
 * Is a selector still present on the page?
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} selector
 * @returns {Promise<boolean>}
 */
async function widgetOnPage(client, contextId, selector) {
  if (!selector) return false
  try {
    const remote = await evaluate(
      client,
      `(() => !!document.querySelector(${JSON.stringify(selector)}))()`,
      contextId,
    )
    return unwrapRemoteValue(remote) === true
  } catch {
    return false
  }
}
