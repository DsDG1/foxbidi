// lib/firefox/navigation-policy.js
// Where the plugin is allowed to navigate.
//
// WHY THIS EXISTS
//
// The browser this plugin drives carries the user's REAL login state. That
// makes it valuable to an attacker in a specific way: a page that can make
// the browser go somewhere can make it carry those credentials somewhere.
//
// The concrete threat is a page that redirects the browser to
// `http://127.0.0.1:<admin port>/` — a service on the machine itself that
// trusts "requests from localhost". A `file://` URL is the same idea: the
// local filesystem is not a web origin, and a page that can navigate there
// can try to read what it finds.
//
// WHAT IS CHECKED
//
//   - the SCHEME. `file:`, `data:`, `javascript:`, `view-source:` and
//     `blob:` are not web origins, and a top-level navigation to one is
//     almost never what the user meant.
//
//   - the HOST, when it is a LITERAL private address or `localhost`. The
//     browser can reach services that the model cannot, and the browser is
//     the one holding the cookies.
//
// WHAT IS DELIBERATELY NOT CHECKED
//
// No DNS resolution. Deciding "is this hostname private?" by resolving it
// would (a) cost a network round trip on every navigation, and (b) open a
// TOCTOU window — the answer could change between the check and the
// navigation, which is exactly the DNS-rebinding attack. So only LITERAL
// addresses and `localhost` are judged here.
//
// That leaves a real residual risk, which is stated plainly in the docs: a
// hostname that resolves to 127.0.0.1 is not caught by this layer. Blocking
// it properly means intercepting at the request layer, which is a different
// mechanism with a different cost.
//
// HOW TO RELAX IT
//
//   FIREFOX_BROWSER_NAVIGATION_POLICY=permissive  — no checks at all
//   FIREFOX_BROWSER_ALLOW_PRIVATE_HOSTS=1        — private hosts allowed,
//                                                  dangerous schemes still
//                                                  blocked

/** The schemes that are refused by default. */
export const BLOCKED_SCHEMES = new Set(['file:', 'data:', 'javascript:', 'view-source:', 'blob:'])

/**
 * Is this host a literal private, loopback or link-local address?
 *
 * Only literal addresses are judged. A hostname is not resolved — see the
 * module header for why.
 *
 * @param {string} host
 * @returns {boolean}
 */
export function isPrivateHost(host) {
  const h = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (!h) return false

  // localhost and its subdomains.
  if (h === 'localhost' || h.endsWith('.localhost')) return true

  // IPv4.
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 0) return true // 0.0.0.0
    if (a === 127) return true // 127.0.0.0/8
    if (a === 10) return true // 10.0.0.0/8
    if (a === 192 && b === 168) return true // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local
    return false
  }

  // IPv6.
  if (h === '::' || h === '::1') return true
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true // fe80::/10 link-local
  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mapped) return isPrivateHost(mapped[1])

  return false
}

/**
 * Read the policy configuration from the environment.
 *
 * @param {object} [env]
 * @returns {{strict: boolean, allowPrivateHosts: boolean}}
 */
export function navigationPolicyFromEnvironment(env = process.env) {
  const mode = String(env.FIREFOX_BROWSER_NAVIGATION_POLICY || 'strict')
    .trim()
    .toLowerCase()
  const allowPrivate = String(env.FIREFOX_BROWSER_ALLOW_PRIVATE_HOSTS || '0').trim() === '1'
  return {
    strict: mode !== 'permissive',
    allowPrivateHosts: allowPrivate,
  }
}

/**
 * Decide whether a navigation is allowed.
 *
 * The refusal carries BOTH an `error` (what happened) and a `hint` (what
 * to do about it), which is the shape the rest of the plugin uses.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {boolean} [opts.strict]           false = allow everything
 * @param {boolean} [opts.allowPrivateHosts] true = allow private/loopback hosts
 * @param {boolean} [opts.exempt]           true = allow (the plugin's own
 *   privileged navigation, e.g. about:addons)
 * @returns {{allowed: true} | {allowed: false, reason: string, code: string, error: string, hint: string}}
 */
export function evaluateNavigation(url, opts = {}) {
  const strict = opts.strict !== false
  const allowPrivate = opts.allowPrivateHosts === true

  if (!strict || opts.exempt === true) {
    return { allowed: true }
  }

  const raw = String(url || '').trim()
  if (!raw) {
    return {
      allowed: false,
      reason: 'empty_url',
      code: 'navigation_blocked',
      error: 'no URL was given',
      hint: 'Pass the URL to navigate to.',
    }
  }

  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    // Not a parseable absolute URL. `normalizeUrl` will add a scheme; the
    // result is a normal web URL, so there is nothing to block here.
    return { allowed: true }
  }

  const scheme = parsed.protocol.toLowerCase()
  if (BLOCKED_SCHEMES.has(scheme)) {
    return {
      allowed: false,
      reason: 'blocked_scheme',
      code: 'navigation_blocked',
      error: `a "${scheme}" URL is not a web origin`,
      hint:
        scheme === 'file:'
          ? 'Navigating to a local file is blocked. Set FIREFOX_BROWSER_NAVIGATION_POLICY=permissive to allow it.'
          : `Navigating to a "${scheme}" URL is blocked. Set FIREFOX_BROWSER_NAVIGATION_POLICY=permissive to allow it.`,
    }
  }

  if (!allowPrivate && isPrivateHost(parsed.hostname)) {
    return {
      allowed: false,
      reason: 'private_host',
      code: 'navigation_blocked',
      error: `"${parsed.hostname}" is a private address`,
      hint:
        "This browser carries the user's real login state, and a private address is " +
        'reachable from the machine but not from the network. ' +
        'Set FIREFOX_BROWSER_ALLOW_PRIVATE_HOSTS=1 to allow it.',
    }
  }

  return { allowed: true }
}
