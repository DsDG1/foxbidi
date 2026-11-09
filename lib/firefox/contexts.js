// lib/firefox/contexts.js
// Firefox containers — isolated identities inside one browser.
//
// WHAT A CONTAINER IS
//
// A user context is Firefox's container feature: a separate cookie jar,
// separate localStorage, separate cache. Two containers can be logged into
// two different accounts of the same site at the same time, and neither can
// see the other's state.
//
// WHY AN AGENT CARES
//
//   - Multi-account work: log into account A and account B side by side
//     without logging out.
//   - Isolation: a task that logs into a site cannot leak that session into
//     an unrelated later task.
//   - Cleanliness: a throwaway container for a one-off signup, deleted
//     afterwards with its cookies.
//
// This is one of the capabilities a CDP-based harness structurally cannot
// offer — Chrome has no equivalent of Firefox's container model.
//
// BiDi support: FF124+ (`browser.createUserContext`, `browser.getUserContexts`,
// `browser.removeUserContext`, and `browsingContext.create{userContext}`).

import { ERROR_CODES, classifyError, fail } from './errors.js'
/**
 * List the existing user contexts.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @returns {Promise<{ok: boolean, userContexts?: Array<{userContext: string, label?: string}>, error?: string}>}
 */
export async function listUserContexts(client) {
  try {
    const result = await client.send('browser.getUserContexts', {})
    const raw = result.userContexts || result.contexts || []
    const userContexts = raw
      .map((entry) => {
        if (!entry) return null
        const id = entry.userContext || entry.context || (typeof entry === 'string' ? entry : null)
        if (!id) return null
        return { userContext: id, label: entry.label || undefined }
      })
      .filter(Boolean)
    return { ok: true, userContexts }
  } catch (e) {
    return fail(classifyError(e), String((e && e.message) || e))
  }
}

/**
 * Create a new user context (container).
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {object} [opts]
 * @param {string} [opts.label]
 * @returns {Promise<{ok: boolean, userContext?: string, error?: string}>}
 */
export async function createUserContext(client, opts = {}) {
  try {
    const params = {}
    if (opts.label) params.label = opts.label
    const result = await client.send('browser.createUserContext', params)
    const userContext = result.userContext || result.context
    if (!userContext) {
      return fail(ERROR_CODES.INTERNAL, 'browser.createUserContext returned no userContext')
    }
    return { ok: true, userContext, label: opts.label }
  } catch (e) {
    return fail(classifyError(e), String((e && e.message) || e))
  }
}

/**
 * Remove a user context.
 *
 * The browser refuses to remove a context that still has open tabs, so the
 * caller has to close them first.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {string} userContext
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function removeUserContext(client, userContext) {
  try {
    await client.send('browser.removeUserContext', { userContext })
    return { ok: true }
  } catch (e) {
    return fail(classifyError(e), String((e && e.message) || e))
  }
}

/**
 * Open a tab inside a user context.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {string} userContext
 * @param {string} [url]
 * @returns {Promise<{ok: boolean, contextId?: string, error?: string}>}
 */
export async function openTabInUserContext(client, userContext, url) {
  try {
    const params = { type: 'tab', userContext }
    const result = await client.send('browsingContext.create', params)
    const contextId = result.context
    if (!contextId) {
      return fail(ERROR_CODES.INTERNAL, 'browsingContext.create returned no context')
    }
    if (url) {
      try {
        await client.send('browsingContext.navigate', { context: contextId, url, wait: 'complete' })
      } catch {
        // The tab exists even if the navigation failed — report the tab.
      }
    }
    return { ok: true, contextId, userContext }
  } catch (e) {
    return fail(classifyError(e), String((e && e.message) || e))
  }
}
