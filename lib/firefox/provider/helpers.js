// lib/firefox/provider/helpers.js
// Small helpers shared by more than one provider module.
//
// They used to live at the bottom of provider.js. When the class body was
// split into one module per concern, they moved here so no module has to
// import the facade back (which would be a cycle).

import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_NAME } from './constants.js'
import { evaluateNavigation, navigationPolicyFromEnvironment } from '../navigation-policy.js'

/**
 * Do two URLs point at the same page?
 *
 * "The same page" is not "the same string": `https://example.com` and
 * `https://example.com/` are the same page, and a browser reports the one
 * with the slash. So the comparison is on the scheme, the origin and the
 * path — with the trailing slash ignored.
 *
 * This exists because a navigation to the URL a tab is ALREADY on changes
 * nothing about the URL, and a plain string comparison would say "the tab
 * did not move" even though the page was reloaded.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameTarget(a, b) {
  const left = String(a || '')
  const right = String(b || '')
  if (!left || !right) return false
  if (left === right) return true
  try {
    const ua = new URL(left)
    const ub = new URL(right)
    if (ua.protocol !== ub.protocol) return false
    if (ua.origin !== ub.origin) return false
    return ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, '')
  } catch {
    return false
  }
}

/**
 * Normalize a URL for navigation.
 *
 * Firefox rejects a scheme-less URL outright (NS_ERROR_MALFORMED_URI), and
 * agents routinely pass bare hostnames. Local addresses keep their scheme.
 *
 * @param {string} url
 * @returns {string}
 */
export function normalizeUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) return raw
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(raw)) {
    return `http://${raw}`
  }
  return `https://${raw}`
}

/**
 * Normalize a URL and check it against the navigation policy.
 *
 * Every navigation goes through here, so the policy cannot be bypassed by
 * forgetting to apply it at one call site.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {boolean} [opts.exempt]  skip the policy (the plugin's own
 *   privileged navigation, e.g. about:addons)
 * @returns {{url: string, allowed: boolean, reason?: string, code?: string, hint?: string}}
 */
export function resolveNavigation(url, opts = {}) {
  const normalized = normalizeUrl(url)
  const policy = navigationPolicyFromEnvironment()
  const verdict = evaluateNavigation(normalized, {
    strict: policy.strict,
    allowPrivateHosts: policy.allowPrivateHosts,
    exempt: opts.exempt === true,
  })
  return { url: normalized, ...verdict }
}

/**
 * Busy-wait synchronously.
 *
 * Only used on the shutdown path, where an await is not possible.
 *
 * @param {number} ms
 */
export function sleepSync(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* spin */
  }
}

/**
 * Pause asynchronously.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Where the profile copy lives when nothing else says.
 *
 * The copy must never land inside the plugin package — the plugin directory
 * is read-only in some installs and shipping a profile in the package would
 * be a mess. So it goes under the user's home by default.
 *
 * @returns {string} an absolute directory path
 */
export function defaultCopyBase() {
  const explicit = (process.env.FIREFOX_BROWSER_PROFILE_COPY || '').trim()
  if (explicit) return explicit

  const pluginData = (process.env.PLUGIN_DATA || '').trim()
  if (pluginData) return pluginData

  // Derived from import.meta.url — works no matter how the plugin was started.
  try {
    const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    return resolve(pluginRoot, '..', '.plugin-data', PLUGIN_NAME)
  } catch {
    const home = homedir()
    if (home) {
      return join(home, '.minimax', 'v2', 'plugin-data', 'agent-plugins', PLUGIN_NAME)
    }
    return resolve('.cache', PLUGIN_NAME, 'profile')
  }
}

/**
 * Reduce a value to something JSON can carry.
 *
 * A page can hand back anything, including cycles and functions. The tool
 * result has to survive `JSON.stringify`, so anything exotic is dropped.
 *
 * @param {*} value
 * @returns {*} a JSON-safe value
 */
export function safeSerializable(value) {
  const seen = new WeakSet()
  const walk = (val) => {
    if (val === null || val === undefined) return val
    const type = typeof val
    if (type === 'number' || type === 'string' || type === 'boolean') return val
    if (type === 'bigint') return String(val)
    if (type === 'function' || type === 'symbol') return undefined
    if (type === 'object') {
      if (seen.has(val)) return undefined
      seen.add(val)
      try {
        if (Array.isArray(val)) {
          return val.map((item) => {
            const converted = walk(item)
            return converted === undefined ? null : converted
          })
        }
        const safe = {}
        for (const [key, v] of Object.entries(val)) {
          const converted = walk(v)
          if (converted !== undefined) safe[key] = converted
        }
        return safe
      } finally {
        seen.delete(val)
      }
    }
    return String(val)
  }
  return walk(value)
}

/**
 * Resolve a path against the plugin root, refusing anything that escapes it.
 *
 * @param {string} base the directory to resolve within
 * @param {string} target the relative path
 * @returns {string} an absolute path
 */
export function resolveWithin(base, target) {
  const resolvedBase = resolve(String(base || ''))
  const resolvedTarget = resolve(resolvedBase, String(target || ''))
  const rel = relative(resolvedBase, resolvedTarget)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path escapes base directory: ${target}`)
  }
  return resolvedTarget
}
