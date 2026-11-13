// lib/bidi/protocol.js
// BiDi command wrappers — the "what" layer above the transport in ./client.js.
//
// Every function here maps 1:1 to a WebDriver BiDi command. Keeping them
// separate from the socket handling means the protocol shapes can be unit
// tested without a live Firefox, and the provider layer stays readable.
//
// Reference: https://w3c.github.io/webdriver-bidi/

/**
 * Create a BiDi session.
 *
 * Firefox's remote agent allows only ONE active session per endpoint. A
 * second `session.new` fails with "Maximum number of active sessions" — the
 * caller should treat that as "a session already exists, reuse it".
 *
 * @param {import('./client.js').BidiClient} client
 * @returns {Promise<{sessionId: string, reused: boolean}>}
 */
export async function sessionNew(client) {
  try {
    const result = await client.send('session.new', { capabilities: {} })
    return { sessionId: result.sessionId, reused: false }
  } catch (err) {
    if (isMaxSessionsError(err)) {
      // A session is already open on this endpoint. Probe it to confirm and
      // report the id; commands issued on this socket are bound to that
      // session implicitly.
      const status = await client.send('session.status', {})
      return { sessionId: status.sessionId || null, reused: true }
    }
    throw err
  }
}

/**
 * Report the endpoint's session state.
 *
 * A freshly launched Firefox has NO active session, so `sessionId === null`
 * is the signal that this endpoint belongs to the browser we just started.
 * A non-null id means some OTHER Firefox instance already owns the port —
 * connecting to it would silently drive the wrong browser.
 *
 * @param {import('./client.js').BidiClient} client
 * @returns {Promise<{sessionId: string|null, ready: boolean}>}
 */
export async function sessionStatus(client) {
  const status = await client.send('session.status', {})
  return { sessionId: status.sessionId || null, ready: !!status.ready }
}

/**
 * True when the error is Firefox's "one session per endpoint" refusal.
 *
 * @param {Error} err
 * @returns {boolean}
 */
export function isMaxSessionsError(err) {
  if (!err) return false
  const code = String(err.code || '')
  const msg = String(err.message || '')
  return code === 'session not created' || /maximum number of active sessions/i.test(msg)
}

/**
 * Send a BiDi command bypassing the serialized queue when supported.
 *
 * Used for commands that unblock or tear down an in-flight command
 * (`session.end`, `browsingContext.handleUserPrompt`, and network
 * interception replies).
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} method
 * @param {object} params
 * @param {number} [timeoutMs]
 */
function sendOutOfBand(client, method, params, timeoutMs) {
  const fn = typeof client.sendUnqueued === 'function' ? client.sendUnqueued : client.send
  return timeoutMs !== undefined
    ? fn.call(client, method, params, timeoutMs)
    : fn.call(client, method, params)
}

/**
 * End the session (leaves the browser running).
 *
 * Sent out-of-band so a stuck command holding `client._chain` cannot block
 * `browser_restart {scope:"session"}`.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {number} [timeoutMs]
 */
export async function sessionEnd(client, timeoutMs) {
  return sendOutOfBand(client, 'session.end', {}, timeoutMs)
}

/**
 * Recursively normalize a BiDi browsingContext tree node.
 */
function mapTreeNode(node, parentId, isTop) {
  const contextId = node.context
  return {
    contextId,
    url: node.url || '',
    type: isTop ? (node.children ? 'tab' : 'unknown') : 'iframe',
    title: '',
    parent: parentId,
    children: (node.children || []).map((ch) => mapTreeNode(ch, contextId, false)),
  }
}

/**
 * List all browsing contexts (tabs and frames).
 *
 * NOTE: Firefox's `browsingContext.getTree` does NOT return a title field,
 * so `title` is always empty here. The real title must be read from the page
 * itself (`document.title`) — see `getTitle`.
 *
 * @param {import('./client.js').BidiClient} client
 * @returns {Promise<Array<{contextId: string, url: string, type: string, title: string, parent: string|null, children: Array}>>}
 */
export async function getTree(client, opts = {}) {
  const params = {}
  // `root` narrows the tree to one context. It is a context ID (a string) —
  // Firefox rejects a boolean here, and the specification says the same.
  if (opts.root) params.root = String(opts.root)
  const result = await client.send('browsingContext.getTree', params)
  const contexts = result.contexts || []
  return contexts.map((c) => mapTreeNode(c, c.parent || null, true))
}

/**
 * Read a context's document title.
 *
 * `browsingContext.getTree` carries no title in Firefox, so the title has to
 * come from the page. A title is metadata, never a failure reason — an
 * unreadable context yields an empty string rather than an error.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} contextId
 * @returns {Promise<string>}
 */
export async function getTitle(client, contextId) {
  try {
    const result = await client.send('script.evaluate', {
      expression: 'document.title || ""',
      target: { context: contextId },
      awaitPromise: false,
      resultOwnership: 'none',
    })
    const value = result.result || {}
    return typeof value.value === 'string' ? value.value : ''
  } catch {
    return ''
  }
}

/**
 * Create a new tab.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} [url]
 * @returns {Promise<string>} the new context id
 */
export async function createTab(client, url) {
  const result = await client.send('browsingContext.create', { type: 'tab' })
  const contextId = result.context
  if (url) {
    await navigate(client, url, contextId)
  }
  return contextId
}

/**
 * The wait strategies Firefox's `browsingContext.navigate` accepts.
 *
 * Firefox rejects anything else with: Expected "wait" to be one of
 * none,interactive,complete.
 */
export const NAV_WAIT_STRATEGIES = ['none', 'interactive', 'complete']

/**
 * Normalize a wait strategy onto one Firefox actually accepts.
 *
 * "load" is not a Firefox value — it was accepted by the tool schema but
 * rejected at runtime by the browser. It is mapped onto "interactive", the
 * closest real strategy ("the DOM is parsed, subresources may still load"),
 * so a caller passing the legacy value keeps working.
 *
 * @param {string} [wait]
 * @returns {'none'|'interactive'|'complete'}
 */
export function normalizeWaitStrategy(wait) {
  const value = typeof wait === 'string' ? wait.trim().toLowerCase() : ''
  if (value === 'load') return 'interactive'
  if (NAV_WAIT_STRATEGIES.includes(value)) return value
  return 'complete'
}

/**
 * Navigate a context to a URL.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} url
 * @param {string} [contextId]
 * @param {string} [wait]  'none' | 'interactive' | 'complete' — default 'complete'
 */
export async function navigate(client, url, contextId, wait = 'complete') {
  // BiDi spec: browsingContext.navigate takes `context` directly (NOT the
  // `target: {context}` shape used by script.* commands).
  const params = { url, wait: normalizeWaitStrategy(wait) }
  if (contextId) params.context = contextId
  return client.send('browsingContext.navigate', params)
}

/**
 * Close a tab.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} contextId
 */
export async function closeTab(client, contextId) {
  return client.send('browsingContext.close', { context: contextId })
}

/**
 * Activate (focus) a tab.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} contextId
 */
export async function activateTab(client, contextId) {
  return client.send('browsingContext.activate', { context: contextId })
}

/**
 * Capture a screenshot (base64 PNG).
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} [contextId]
 * @param {object} [opts]
 * @param {boolean} [opts.fullPage]  capture the whole document, not the viewport
 * @param {string} [opts.elementSharedId]  capture only this element
 * @returns {Promise<string>} base64 PNG
 */
export async function screenshot(client, contextId, opts = {}) {
  const params = {}
  if (contextId) params.context = contextId
  if (opts.fullPage) params.origin = 'document'
  if (opts.elementSharedId) params.element = { sharedId: opts.elementSharedId }
  const result = await client.send('browsingContext.captureScreenshot', params)
  return result.data || ''
}

/**
 * Set the viewport size of a context.
 *
 * Verified on Firefox 140 ESR: this genuinely resizes the viewport
 * (`window.innerWidth` / `innerHeight` follow the requested values).
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} contextId
 * @param {number} width
 * @param {number} height
 */
export async function setViewport(client, contextId, width, height, devicePixelRatio = 1) {
  return client.send('browsingContext.setViewport', {
    context: contextId,
    viewport: { width, height },
    devicePixelRatio:
      Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1,
  })
}

/**
 * Attach files to a file input.
 *
 * `element` MUST be a SharedReference — a CSS selector or a plain string is
 * rejected by Firefox ("Expected \"element\" to be a SharedReference").
 *
 * @param {import('./client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.context
 * @param {string} opts.sharedId
 * @param {string[]} opts.files  absolute paths
 */
export async function setFiles(client, opts) {
  return client.send('input.setFiles', {
    context: opts.context,
    element: { sharedId: opts.sharedId },
    files: opts.files,
  })
}

/**
 * Resolve a DOM node to a SharedReference usable by `input.setFiles` and
 * `browsingContext.captureScreenshot`.
 *
 * The reference lives only for the current realm, so it must be obtained and
 * consumed inside a single action — it cannot be cached across calls.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.context
 * @param {string} opts.selector
 * @returns {Promise<string|null>} the sharedId, or null when not found
 */
export async function resolveSharedId(client, opts) {
  const result = await client.send('script.callFunction', {
    functionDeclaration:
      '(selector) => { const el = document.querySelector(selector); return el || null; }',
    arguments: [{ type: 'string', value: opts.selector }],
    target: { context: opts.context },
    awaitPromise: true,
    resultOwnership: 'none',
  })
  const value = result.result || {}
  return value.sharedId || null
}

/**
 * Thrown when a page-side expression raised an exception.
 *
 * The BiDi response for a throwing expression is a NORMAL response with
 * `type: "exception"` — not an error envelope — so the client resolves it
 * rather than rejecting. This class turns that into a thrown error so the
 * provider can report `evaluate_failed` instead of a silent `undefined`.
 */
export class BidiEvaluateError extends Error {
  constructor(message, details = {}) {
    super(message || 'the page script raised an exception')
    this.name = 'BidiEvaluateError'
    this.code = 'evaluate_failed'
    this.details = details
  }
}

/**
 * Evaluate an expression in a context and return the raw result.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} expression
 * @param {string} [contextId]
 * @param {object} [opts]  { awaitPromise, resultOwnership }
 * @returns {Promise<object>} the BiDi RemoteValue
 */
export async function evaluate(client, expression, contextId, opts = {}) {
  const params = {
    expression,
    awaitPromise: opts.awaitPromise !== false,
    resultOwnership: opts.resultOwnership || 'none',
  }
  if (contextId) params.target = { context: contextId }
  const result = await client.send('script.evaluate', params)

  // `result.result` is absent on an exception response, so the old
  // `result.result || {}` silently turned a throwing expression into an
  // empty object. Check the envelope type first.
  if (result && result.type === 'exception') {
    const details = result.exceptionDetails || {}
    throw new BidiEvaluateError(details.text || 'the page script raised an exception', details)
  }
  return result.result || {}
}

/**
 * Install a preload script that runs before page scripts in a context.
 *
 * Firefox 140 ESR accepts this command, but its parameter shape DIFFERS from
 * the WebDriver BiDi spec in two ways that are easy to get wrong:
 *
 *   - The script is a plain STRING under the key `functionDeclaration`.
 *     The spec calls the parameter `script` and expects a TextSource object
 *     (`{type:'text', source:'...'}`). Firefox rejects the spec shape with
 *     `Expected "functionDeclaration" to be a string, got [object Undefined]`.
 *   - The target is `context` as a STRING id. Firefox does not implement the
 *     spec's `contexts` array form and answers `invalid argument` for it.
 *
 * The script runs for every document loaded into the context AFTER it is
 * installed, so it must be added BEFORE navigating.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} functionDeclaration  a JS function expression, e.g. `() => {...}`
 * @param {string} [contextId]
 * @returns {Promise<string|null>} the script id, usable for removal
 */
export async function addPreloadScript(client, functionDeclaration, contextId) {
  const params = { functionDeclaration }
  if (contextId) params.context = contextId
  const result = await client.send('script.addPreloadScript', params)
  return result.script || null
}

/**
 * Remove a preload script previously added with `addPreloadScript`.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} scriptId
 * @returns {Promise<boolean>}
 */
export async function removePreloadScript(client, scriptId) {
  if (!scriptId) return false
  await client.send('script.removePreloadScript', { script: scriptId })
  return true
}

/**
 * Call a function in a context with an argument.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} functionDeclaration
 * @param {Array} [args]
 * @param {string} [contextId]
 * @param {object} [opts]
 * @returns {Promise<object>} the BiDi RemoteValue
 */
export async function callFunction(client, functionDeclaration, args = [], contextId, opts = {}) {
  const params = {
    functionDeclaration,
    arguments: args,
    awaitPromise: opts.awaitPromise !== false,
    resultOwnership: opts.resultOwnership || 'none',
  }
  if (contextId) params.target = { context: contextId }
  const result = await client.send('script.callFunction', params)
  if (result && result.type === 'exception') {
    const details = result.exceptionDetails || {}
    throw new BidiEvaluateError(details.text || 'the page script raised an exception', details)
  }
  return result.result || {}
}

/**
 * Perform input actions (pointer / key).
 *
 * @param {import('./client.js').BidiClient} client
 * @param {Array} actions  BiDi action sequences
 * @param {string} [contextId]
 */
export async function performActions(client, actions, contextId) {
  const params = { actions }
  if (contextId) params.context = contextId
  return client.send('input.performActions', params)
}

/**
 * Release all input actions (so a stuck mouse button cannot linger).
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} [contextId]
 */
export async function releaseActions(client, contextId) {
  const params = {}
  if (contextId) params.context = contextId
  return client.send('input.releaseActions', params)
}

/**
 * Subscribe to BiDi events.
 *
 * IMPORTANT: Firefox's `session.subscribe` is ALL-OR-NOTHING — passing one
 * invalid event name fails the WHOLE batch. Verified: subscribing to
 * `['log.entryAdded', 'browsingContext.userPrompt']` fails with
 * "browsingContext.userPrompt is not a valid event name", losing the valid
 * entry too.
 *
 * So each event is subscribed to individually; a failure is recorded and the
 * remaining events still get their subscription.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {Array<string>} events  e.g. ['log.entryAdded']
 * @returns {Promise<{subscribed: string[], failed: Array<{event: string, error: string}>}>}
 */
export async function subscribe(client, events) {
  const subscribed = []
  const failed = []
  for (const event of events) {
    try {
      await client.send('session.subscribe', { events: [event] })
      subscribed.push(event)
    } catch (e) {
      failed.push({ event, error: String(e.message || e) })
    }
  }
  return { subscribed, failed }
}

/**
 * Unsubscribe from BiDi events.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {Array<string>} events
 */
export async function unsubscribe(client, events) {
  return client.send('session.unsubscribe', { events })
}

// ---------------------------------------------------------------------------
// JavaScript dialogs
//
// The event names are `browsingContext.userPromptOpened` and
// `browsingContext.userPromptClosed` — NOT `browsingContext.userPrompt`,
// which was an earlier draft name that Firefox rejects. That rejection is
// what made the previous version of this plugin believe Firefox had no
// dialog support at all.
//
// Available from Firefox 118 (opened) / 119 (closed).
// ---------------------------------------------------------------------------

/** The events that report JavaScript dialogs. */
export const USER_PROMPT_EVENTS = [
  'browsingContext.userPromptOpened',
  'browsingContext.userPromptClosed',
]

/**
 * Subscribe to the JavaScript-dialog events.
 *
 * @param {import('./client.js').BidiClient} client
 * @returns {Promise<{subscribed: string[], failed: Array<{event: string, error: string}>}>}
 */
export async function subscribeUserPrompt(client) {
  return subscribe(client, USER_PROMPT_EVENTS)
}

/**
 * Close a JavaScript dialog.
 *
 * `action` is one of `accept`, `dismiss` or `acceptAndSetPromptText`.
 *
 * The command is sent WITHOUT the client's command queue: a `beforeunload`
 * dialog blocks the navigation that raised it, and a queued reply would sit
 * behind that navigation forever.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.context
 * @param {'accept'|'dismiss'|'acceptAndSetPromptText'} opts.action
 * @param {string} [opts.promptText]
 * @returns {Promise<object>}
 */
export async function handleUserPrompt(client, opts) {
  const accept = opts.accept !== undefined ? Boolean(opts.accept) : opts.action !== 'dismiss'
  const params = { context: opts.context, accept }
  if (opts.userText !== undefined) {
    params.userText = String(opts.userText)
  } else if (opts.action === 'acceptAndSetPromptText') {
    params.userText = opts.promptText === undefined ? '' : String(opts.promptText)
  }
  return sendOutOfBand(client, 'browsingContext.handleUserPrompt', params)
}

// ---------------------------------------------------------------------------
// User contexts (Firefox containers) — Firefox 124+
// ---------------------------------------------------------------------------

/**
 * List the browser's user contexts.
 *
 * @param {import('./client.js').BidiClient} client
 */
export async function getUserContexts(client) {
  return client.send('browser.getUserContexts', {})
}

/**
 * Create a user context (container).
 *
 * @param {import('./client.js').BidiClient} client
 * @param {object} [opts]
 * @param {string} [opts.label]
 */
export async function createUserContext(client, opts = {}) {
  const params = {}
  if (opts.label) params.label = opts.label
  return client.send('browser.createUserContext', params)
}

/**
 * Remove a user context (container).
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} userContext
 */
export async function removeUserContext(client, userContext) {
  return client.send('browser.removeUserContext', { userContext })
}

/**
 * Open a tab inside a user context.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.userContext
 * @param {string} [opts.url]
 */
export async function createTabInUserContext(client, opts) {
  const result = await client.send('browsingContext.create', {
    type: 'tab',
    userContext: opts.userContext,
  })
  if (opts.url && result.context) {
    try {
      await client.send('browsingContext.navigate', {
        context: result.context,
        url: opts.url,
        wait: 'complete',
      })
    } catch {
      // The tab exists even if the navigation failed.
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Extensions — Firefox 137+
// ---------------------------------------------------------------------------

/**
 * Install a WebExtension.
 *
 * Firefox 138 and later install extensions TEMPORARILY by default: they work
 * for the life of the session but are not written to the profile. Pass
 * `permanent: true` to request a regular install instead.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.path  a path to an unpacked extension or an XPI
 * @param {boolean} [opts.permanent]
 */
export async function installExtension(client, opts) {
  const extensionData = { type: 'path', path: opts.path }
  if (opts.permanent) extensionData.moz = 'permanent'
  return client.send('webExtension.install', { extensionData })
}

/**
 * Uninstall a WebExtension.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} extensionId
 */
export async function uninstallExtension(client, extensionId) {
  return client.send('webExtension.uninstall', { extensionId })
}

// ---------------------------------------------------------------------------
// Cookies — Firefox 124+
// ---------------------------------------------------------------------------

/**
 * Read cookies.
 *
 * Unlike `document.cookie` this reaches HttpOnly cookies and carries the
 * partition key.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {object} [filter]
 */
export async function getCookies(client, filter = {}) {
  return client.send('storage.getCookies', { filter })
}

/**
 * Write a cookie.
 *
 * Firefox expects the cookie VALUE as a serialized RemoteValue
 * (`{type:"string",value:"…"}`), while the specification describes it as a
 * plain string. Both encodings are tried, newest-first.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {object} cookie  {name, value, domain, path, ...}
 */
export async function setCookie(client, cookie) {
  const payload = { ...cookie }
  if (typeof payload.value === 'string') {
    payload.value = { type: 'string', value: payload.value }
  }
  try {
    return await client.send('storage.setCookie', { cookie: payload })
  } catch (e) {
    // Fall back to the plain-string encoding.
    const plain = { ...cookie }
    try {
      return await client.send('storage.setCookie', { cookie: plain })
    } catch {
      throw e
    }
  }
}

// ---------------------------------------------------------------------------
// Network interception — Firefox 124+
// ---------------------------------------------------------------------------

/**
 * Start intercepting requests.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {object} opts
 * @param {Array} [opts.phases]
 * @param {Array} [opts.contexts]
 */
export async function addIntercept(client, opts = {}) {
  const params = { phases: opts.phases || ['beforeRequestSent'] }
  if (opts.contexts && opts.contexts.length) params.contexts = opts.contexts
  return client.send('network.addIntercept', params)
}

/**
 * Stop intercepting requests.
 *
 * The parameter NAME differs between builds: Firefox 140 wants `intercept`,
 * the specification says `interceptId`. Both are sent, and the fallbacks
 * cover a build that rejects the extra field.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} interceptId
 */
export async function removeIntercept(client, interceptId) {
  try {
    return await client.send('network.removeIntercept', { interceptId, intercept: interceptId })
  } catch {
    try {
      return await client.send('network.removeIntercept', { intercept: interceptId })
    } catch {
      return client.send('network.removeIntercept', { interceptId })
    }
  }
}

/**
 * Let an intercepted request continue.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} request  the request id
 */
export async function continueRequest(client, request) {
  return sendOutOfBand(client, 'network.continueRequest', { request })
}

/**
 * Fail an intercepted request.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} request
 * @param {string} [errorText]
 */
export async function failRequest(client, request, errorText) {
  const params = { request }
  if (errorText) params.errorText = errorText
  return sendOutOfBand(client, 'network.failRequest', params)
}

/**
 * Provide a canned response for an intercepted request.
 *
 * Firefox supports a LIMITED parameter set here — the request id, and on
 * newer builds a response status/headers/body. The caller should only pass
 * what the running browser actually accepts.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.request
 */
export async function provideResponse(client, opts) {
  const params = { request: opts.request }
  if (opts.response) {
    params.response = opts.response
  }
  return sendOutOfBand(client, 'network.provideResponse', params)
}

/**
 * Answer an authentication challenge.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.request
 * @param {string} opts.action  'provideCredentials' | 'cancel' | 'default'
 * @param {string} [opts.username]
 * @param {string} [opts.password]
 */
export async function continueWithAuth(client, opts) {
  const params = { request: opts.request, action: opts.action }
  if (opts.action === 'provideCredentials') {
    params.credentials = {
      type: 'password',
      username: opts.username || '',
      password: opts.password || '',
    }
  }
  return sendOutOfBand(client, 'network.continueWithAuth', params)
}

/**
 * Read a response body.
 *
 * Only available from Firefox 144 (BiDi milestone 17). Callers must check
 * the capability first — see ./firefox/capabilities.js.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.request
 * @param {'text'|'base64'} [opts.dataType]
 */
export async function getResponseData(client, opts) {
  const params = { request: opts.request }
  if (opts.dataType) params.dataType = opts.dataType
  return client.send('network.getData', params)
}

// ---------------------------------------------------------------------------
// Navigation extras
// ---------------------------------------------------------------------------

/**
 * Traverse the session history.
 *
 * Firefox 122+.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {object} opts
 * @param {number} opts.delta
 * @param {string} [opts.context]
 */
export async function traverseHistory(client, opts) {
  const params = { delta: opts.delta }
  if (opts.context) params.context = opts.context
  return client.send('browsingContext.traverseHistory', params)
}

/**
 * Reload a context.
 *
 * Firefox 119+.
 *
 * @param {import('./client.js').BidiClient} client
 * @param {string} contextId
 */
export async function reload(client, contextId) {
  return client.send('browsingContext.reload', { context: contextId })
}

/**
 * Unwrap a BiDi RemoteValue into a plain JS value.
 *
 * RemoteValue shapes: {type:'string'|'number'|'boolean'|'null'|'array'|'object'}
 * plus `value` for primitives, `value` for arrays/objects too.
 *
 * IMPORTANT (Firefox): a serialized OBJECT comes back as an array of
 * [key, RemoteValue] pairs — `{type:'object', value:[["x", {...}], ...]}`
 * — NOT as a plain JS object. Both shapes are handled here.
 *
 * @param {object} remoteValue
 * @returns {*} the plain value
 */
export function unwrapRemoteValue(remoteValue) {
  if (!remoteValue || typeof remoteValue !== 'object') return remoteValue
  switch (remoteValue.type) {
    case 'array':
      return (remoteValue.value || []).map(unwrapRemoteValue)
    case 'object': {
      const raw = remoteValue.value
      if (Array.isArray(raw)) {
        // Firefox serializes objects as [key, RemoteValue] pairs.
        const out = {}
        for (const pair of raw) {
          if (!Array.isArray(pair) || pair.length !== 2) continue
          out[pair[0]] = unwrapRemoteValue(pair[1])
        }
        return out
      }
      // Already a plain object (some implementations hand back a map).
      const out = {}
      for (const [k, v] of Object.entries(raw || {})) {
        out[k] = unwrapRemoteValue(v)
      }
      return out
    }
    case 'null':
      return null
    case 'exception': {
      // Firefox reports a page-side exception as a NORMAL response with
      // type:"exception" — it does NOT use the error envelope, so the
      // client never rejects. Without this branch the value fell through
      // to the default case and came back as `undefined`, which made a
      // throwing expression indistinguishable from one that returned
      // undefined.
      const details = remoteValue.exceptionDetails || {}
      return {
        __exception: true,
        text: details.text || 'page script raised an exception',
        stack: details.stackTrace || null,
      }
    }
    default:
      return remoteValue.value
  }
}
