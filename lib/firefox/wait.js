// lib/firefox/wait.js
// Waiting primitives: wait for an element, for text, for the load event, or
// for the network to go quiet.
//
// WHY THIS MATTERS FOR AN AGENT
//
// Without a wait primitive the only way to know a page is ready is to sleep
// and hope — which is either slow (fixed sleeps) or flaky (too short). A
// wait primitive turns "did my action take effect?" into a single call that
// either succeeds or reports a precise timeout.
//
// The polling here is deliberately JS-based: Firefox 140 has no
// `browsingContext.waitForNavigation`, and the load event is only observable
// via a subscription that must be set up before the navigation starts.

/** Default wait timeout. */
export const DEFAULT_TIMEOUT_MS = 10000

/** Poll interval. */
export const POLL_INTERVAL_MS = 150

/**
 * Wait until a condition holds, polling the page.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.context
 * @param {string} opts.expression  a JS expression returning a truthy value
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.intervalMs]
 * @returns {Promise<{ok: boolean, matched: boolean, elapsedMs: number, timeoutMs: number}>}
 */
export async function waitFor(client, opts) {
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs
  const intervalMs = opts.intervalMs || POLL_INTERVAL_MS
  const started = Date.now()

  for (;;) {
    let matched = false
    try {
      const result = await client.send('script.evaluate', {
        expression: opts.expression,
        target: { context: opts.context },
        awaitPromise: false,
        resultOwnership: 'none',
      })
      const value = result.result || {}
      matched = value.value === true || (value.value !== undefined && value.value !== false && !!value.value)
    } catch {
      // A navigation in flight can make evaluation fail — keep polling
      // until the deadline instead of giving up early.
      matched = false
    }
    if (matched) {
      return { ok: true, matched: true, elapsedMs: Date.now() - started, timeoutMs }
    }
    if (Date.now() - started >= timeoutMs) {
      return { ok: false, matched: false, elapsedMs: Date.now() - started, timeoutMs }
    }
    await delay(intervalMs)
  }
}

/**
 * Wait for the page to reach a ready state.
 *
 * `document.readyState` is the only reliable cross-page signal available
 * without a pre-registered load listener.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.context
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok: boolean, matched: boolean, elapsedMs: number, timeoutMs: number}>}
 */
export async function waitForLoad(client, opts) {
  return waitFor(client, {
    ...opts,
    expression: 'document.readyState === "complete" || document.readyState === "interactive"',
  })
}

/**
 * Wait for the network to fall quiet.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.context
 * @param {import('./network.js').NetworkLog} opts.log
 * @param {number} [opts.quietMs]    silence required (default 500)
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok: boolean, matched: boolean, elapsedMs: number, timeoutMs: number}>}
 */
export async function waitForNetworkIdle(client, opts) {
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs
  const quietMs = opts.quietMs === undefined ? 500 : opts.quietMs
  const started = Date.now()
  let lastSeq = opts.log.sequence
  let lastChange = Date.now()

  for (;;) {
    if (opts.log.sequence !== lastSeq) {
      lastSeq = opts.log.sequence
      lastChange = Date.now()
    }
    if (Date.now() - lastChange >= quietMs) {
      return { ok: true, matched: true, elapsedMs: Date.now() - started, timeoutMs }
    }
    if (Date.now() - started >= timeoutMs) {
      return { ok: false, matched: false, elapsedMs: Date.now() - started, timeoutMs }
    }
    await delay(POLL_INTERVAL_MS)
  }
}

/**
 * Build the JS expression for "an element matching this selector exists".
 *
 * @param {string} selector
 * @returns {string}
 */
export function selectorExpression(selector) {
  const json = JSON.stringify(selector)
  return `!!document.querySelector(${json})`
}

/**
 * Build the JS expression for "this text appears on the page".
 *
 * @param {string} text
 * @returns {string}
 */
export function textExpression(text) {
  const json = JSON.stringify(text)
  return `(document.body && (document.body.innerText || "").includes(${json}))`
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
