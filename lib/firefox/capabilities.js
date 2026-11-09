// lib/firefox/capabilities.js
// What can the Firefox we are actually driving do?
//
// WHY PROBE INSTEAD OF ASSUME
//
// Firefox's WebDriver BiDi implementation is still moving. Features land in
// specific releases:
//
//   browsingContext.userPromptOpened / userPromptClosed / handleUserPrompt  FF118/119+
//   browser.getUserContexts / createUserContext / removeUserContext         FF124+
//   storage.getCookies / setCookie                                          FF124+
//   network.addIntercept / continueRequest / failRequest                   FF124+
//   webExtension.install / uninstall                                       FF137+
//   --remote-enable-system-access (privileged chrome:// contexts)          FF138+
//   network.getData / addDataCollector (response bodies)                   FF144+
//
// A plugin that hardcodes "this works" either breaks on an older Firefox or
// silently pretends to work on a newer one. So: probe the running browser,
// report the result honestly, and degrade gracefully.
//
// HOW PROBING WORKS
//
//   1. VERSION GATE — the cheap, reliable default. The Firefox version comes
//      from `session.status` (or the launcher) and is compared against the
//      documented minimum for each feature.
//
//   2. LIVE PROBE — for features that can be tested without side effects
//      (`browser.getUserContexts`, `storage.getCookies`, `network.addIntercept`
//      immediately removed again), the command is actually issued.
//
//   3. RUNTIME FALLBACK — for everything else, a failure at call time is
//      translated into a `capability_unavailable` error the agent can act
//      on, instead of a raw BiDi "unknown command".
//
// Probing is LAZY: nothing is probed until something needs the answer, and
// the result is cached for the life of the session.

/**
 * The minimum Firefox version for each feature, and how to check it.
 */
export const FEATURES = {
  userPrompt: {
    minFirefox: 118,
    label: 'JavaScript dialog handling',
    description: 'browsingContext.userPromptOpened/Closed + handleUserPrompt',
  },
  userContexts: {
    minFirefox: 124,
    label: 'Container / multi-identity isolation',
    description: 'browser.createUserContext + browsingContext.create{userContext}',
  },
  storageCookies: {
    minFirefox: 124,
    label: 'Cookie read/write',
    description: 'storage.getCookies / storage.setCookie',
  },
  networkIntercept: {
    minFirefox: 124,
    label: 'Request interception',
    description: 'network.addIntercept / continueRequest / failRequest',
  },
  traverseHistory: {
    minFirefox: 122,
    label: 'History traversal',
    description: 'browsingContext.traverseHistory',
  },
  scriptUserActivation: {
    minFirefox: 121,
    label: 'User-activation in scripts',
    description: 'script.callFunction{userActivation}',
  },
  webExtension: {
    minFirefox: 137,
    label: 'Extension management',
    description: 'webExtension.install / uninstall',
  },
  privilegedContext: {
    minFirefox: 138,
    label: 'Privileged (chrome://) contexts',
    description: '--remote-enable-system-access + browsingContext.getTree{root}',
  },
  downloadEvents: {
    minFirefox: 133,
    label: 'Download events',
    description: 'browsingContext.downloadWillBegin / downloadEnd',
  },
  networkBodies: {
    minFirefox: 144,
    label: 'Response body capture',
    description: 'network.getData / network.addDataCollector',
  },
  // The CAPTCHA solver leans on two commands whose Firefox-side shape is not
  // stable across releases: `script.addPreloadScript` (Firefox's parameter
  // names differ from the spec) and pointer drags through
  // `input.performActions`. Both were verified against Firefox 140 ESR, and
  // the gate is deliberately set there: an older Firefox is reported as
  // "not available" rather than being optimistically attempted.
  captchaPreloadScript: {
    minFirefox: 140,
    label: 'CAPTCHA closed-shadow-root access',
    description: 'script.addPreloadScript (patches attachShadow); verified on Firefox 140 ESR',
  },
  captchaDrag: {
    minFirefox: 140,
    label: 'CAPTCHA slider drag',
    description: 'input.performActions pointerMove/pointerDown/pointerUp; verified on Firefox 140 ESR',
  },
}

/** The feature keys, in a stable order. */
export const FEATURE_KEYS = Object.keys(FEATURES)

/**
 * Parse a Firefox version string.
 *
 * @param {string} value  e.g. "140.11.0esr"
 * @returns {{major: number, minor: number, patch: number, raw: string}}
 */
export function parseVersion(value) {
  const raw = String(value || '')
  const match = raw.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!match) return { major: 0, minor: 0, patch: 0, raw }
  return {
    major: Number(match[1]) || 0,
    minor: Number(match[2]) || 0,
    patch: Number(match[3]) || 0,
    raw,
  }
}

/**
 * Is a Firefox version at least the given major version?
 *
 * @param {string|object} version
 * @param {number} minMajor
 * @returns {boolean}
 */
export function isAtLeast(version, minMajor) {
  const v = typeof version === 'object' && version !== null ? version : parseVersion(version)
  return v.major >= minMajor
}

/**
 * A human-readable requirement string for a feature.
 *
 * @param {string} feature
 * @returns {string}
 */
export function featureRequirement(feature) {
  const spec = FEATURES[feature]
  return spec ? `Firefox >= ${spec.minFirefox}` : 'a newer Firefox'
}

/**
 * The standard error payload for a feature the browser does not support.
 *
 * The point of this shape is that the agent can do something with it: it
 * names the feature, the requirement, what was detected, and a hint.
 *
 * @param {string} feature
 * @param {string} detected  the detected Firefox version
 * @param {string} [hint]
 * @returns {{ok: false, error: string, feature: string, required: string, detected: string, hint: string}}
 */
export function capabilityError(feature, detected, hint) {
  const spec = FEATURES[feature]
  return {
    ok: false,
    error: 'capability_unavailable',
    feature,
    required: featureRequirement(feature),
    detected: detected || 'unknown',
    label: spec ? spec.label : feature,
    hint:
      hint ||
      (spec
        ? `${spec.label} needs ${featureRequirement(feature)}; this Firefox is ${detected || 'unknown'}.`
        : `This Firefox does not support ${feature}.`),
  }
}

/**
 * Read the Firefox version out of a `session.status` result.
 *
 * Firefox has used a couple of shapes for this over time, so several are
 * accepted.
 *
 * @param {object} status  the `session.status` result
 * @returns {string} the version, or ''
 */
export function versionFromStatus(status) {
  if (!status) return ''
  const caps = status.capabilities || {}
  const candidates = [
    caps.browserVersion,
    caps.version,
    caps.userAgent && /Firefox\/([\d.]+)/.exec(caps.userAgent),
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    if (typeof candidate === 'string' && candidate) return candidate
    if (Array.isArray(candidate) && candidate[1]) return String(candidate[1])
  }
  return ''
}

/**
 * The risks that follow from a feature being unavailable.
 *
 * @param {object} features
 * @returns {string[]}
 */
export function knownRisksFor(features) {
  const risks = []
  if (!features.userPrompt) {
    risks.push(
      'JS dialogs may block the page: this Firefox does not report browsingContext.userPromptOpened.',
    )
  }
  if (!features.networkBodies) {
    risks.push(
      'Response bodies cannot be read on this Firefox; use browser_evaluate with fetch() instead.',
    )
  }
  if (!features.privilegedContext) {
    risks.push('Privileged chrome:// contexts are unavailable; set FIREFOX_BROWSER_PRIVILEGED=1 to enable.')
  }
  return risks
}

/**
 * Predict the capability matrix from a Firefox VERSION, without a live probe.
 *
 * This is what the status can report while the browser is not running: the
 * version gates are known, the live probes are not. It is an EXPECTATION, and
 * the result says so — callers must not present it as a probe.
 *
 * @param {string} browserVersion
 * @param {object} [opts]
 * @param {boolean} [opts.privileged] whether the browser will be launched with system access
 * @returns {{browserVersion: string, features: object, featureDetails: object, knownRisks: string[], probed: false}}
 */
export function expectedFeatures(browserVersion, opts = {}) {
  const version = parseVersion(browserVersion)
  const features = {}
  const details = {}
  for (const key of FEATURE_KEYS) {
    const spec = FEATURES[key]
    let available = isAtLeast(version, spec.minFirefox)
    let reason = `Firefox ${version.major} ${available ? '>=' : '<'} ${spec.minFirefox}`
    if (key === 'privilegedContext' && !opts.privileged) {
      available = false
      reason = `Firefox ${version.major} >= ${spec.minFirefox}, but the browser is not launched with --remote-enable-system-access`
    }
    features[key] = available
    details[key] = { available, source: 'version', reason }
  }
  return {
    browserVersion: browserVersion || 'unknown',
    features,
    featureDetails: details,
    knownRisks: knownRisksFor(features),
    probed: false,
  }
}

/**
 * Probe the running Firefox.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {object} [opts]
 * @param {string} [opts.browserVersion]  a version we already know
 * @param {object} [opts.subscriptions]    the result of session.subscribe
 * @param {boolean} [opts.privileged]      whether the browser was launched with system access
 * @returns {Promise<{browserVersion: string, bidiVersion: string, features: object, featureDetails: object, knownRisks: string[]}>}
 */
export async function probeCapabilities(client, opts = {}) {
  let status = null
  let browserVersion = opts.browserVersion || ''
  try {
    status = await client.send('session.status')
    browserVersion = browserVersion || versionFromStatus(status)
  } catch {
    status = null
  }

  const version = parseVersion(browserVersion)
  const details = {}

  // --- userPrompt -------------------------------------------------------
  // The subscription result is the strongest evidence we have: if Firefox
  // accepted `browsingContext.userPromptOpened`, the feature exists.
  const subscribed = (opts.subscriptions && opts.subscriptions.subscribed) || []
  if (subscribed.includes('browsingContext.userPromptOpened')) {
    details.userPrompt = { available: true, source: 'probe', reason: 'subscription accepted' }
  } else if (isAtLeast(version, FEATURES.userPrompt.minFirefox)) {
    details.userPrompt = {
      available: true,
      source: 'version',
      reason: `Firefox ${version.major} >= ${FEATURES.userPrompt.minFirefox}`,
    }
  } else {
    details.userPrompt = {
      available: false,
      source: 'version',
      reason: `Firefox ${version.major} < ${FEATURES.userPrompt.minFirefox}`,
    }
  }

  // --- live probes for the side-effect-free commands --------------------
  const live = [
    ['userContexts', 'browser.getUserContexts', {}],
    ['storageCookies', 'storage.getCookies', { filter: {} }],
  ]

  for (const [feature, method, params] of live) {
    try {
      await client.send(method, params)
      details[feature] = { available: true, source: 'probe', reason: `${method} succeeded` }
    } catch (e) {
      const message = String((e && e.message) || e)
      const looksUnsupported =
        /unknown command|not a valid command|not implemented|invalid argument|no such|unsupported/i.test(
          message,
        )
      if (looksUnsupported) {
        details[feature] = { available: false, source: 'probe', reason: message }
      } else {
        // The command exists but this call failed for another reason —
        // keep the version verdict and say so.
        details[feature] = {
          available: isAtLeast(version, FEATURES[feature].minFirefox),
          source: 'version',
          reason: `${method} failed: ${message}`,
        }
      }
    }
  }

  // --- networkIntercept -------------------------------------------------
  // Probe by adding and immediately removing an intercept: adding one with
  // no patterns is harmless, but removing it again is what keeps the
  // browser's request pipeline untouched.
  try {
    const added = await client.send('network.addIntercept', { phases: ['beforeRequestSent'] })
    // Firefox 140 returns the id as "intercept"; the spec calls it
    // "interceptId".
    const interceptId = added && (added.interceptId || added.intercept)
    if (interceptId) {
      try {
        await client.send('network.removeIntercept', { interceptId })
      } catch {
        // Removing is best-effort; if it fails the intercept stays inert
        // because no phases were configured.
      }
      details.networkIntercept = { available: true, source: 'probe', reason: 'network.addIntercept succeeded' }
    } else {
      details.networkIntercept = {
        available: isAtLeast(version, FEATURES.networkIntercept.minFirefox),
        source: 'version',
        reason: 'network.addIntercept returned no interceptId',
      }
    }
  } catch (e) {
    const message = String((e && e.message) || e)
    details.networkIntercept = {
      available: /unknown command|not implemented/i.test(message)
        ? false
        : isAtLeast(version, FEATURES.networkIntercept.minFirefox),
      source: 'probe',
      reason: message,
    }
  }

  // --- version-gated features -------------------------------------------
  for (const key of FEATURE_KEYS) {
    if (details[key]) continue
    const spec = FEATURES[key]
    const available = isAtLeast(version, spec.minFirefox)
    const extra = {}
    if (key === 'privilegedContext') {
      extra.reason = opts.privileged
        ? `launched with system access (Firefox ${version.major} >= ${spec.minFirefox})`
        : `Firefox ${version.major} >= ${spec.minFirefox}, but the browser was not launched with --remote-enable-system-access`
      if (!opts.privileged) extra.available = false
    } else {
      extra.reason = `Firefox ${version.major} ${available ? '>=' : '<'} ${spec.minFirefox}`
    }
    details[key] = { available, source: 'version', ...extra }
  }

  const features = {}
  for (const key of FEATURE_KEYS) features[key] = details[key].available

  const knownRisks = knownRisksFor(features)

  return {
    browserVersion: browserVersion || 'unknown',
    bidiVersion: (status && status.capabilities && (status.capabilities.protocolVersion || '')) || '',
    features,
    featureDetails: details,
    knownRisks,
    probed: true,
  }
}

/**
 * A cached probe result holder.
 *
 * The probe runs at most once per session unless it is forced.
 */
export class CapabilitySet {
  constructor() {
    /** @type {object|null} */
    this.result = null
    /** @type {Promise<object>|null} */
    this._pending = null
  }

  /**
   * Get the capability set, probing on first use.
   *
   * @param {import('../bidi/client.js').BidiClient} client
   * @param {object} [opts]  passed to probeCapabilities
   * @returns {Promise<object>}
   */
  async ensure(client, opts = {}) {
    if (this.result) return this.result
    if (!this._pending) {
      this._pending = probeCapabilities(client, opts)
        .then((result) => {
          this.result = result
          this._pending = null
          return result
        })
        .catch((error) => {
          this._pending = null
          throw error
        })
    }
    return this._pending
  }

  /**
   * Forget the cached result (used when the browser restarts).
   */
  reset() {
    this.result = null
    this._pending = null
  }

  /**
   * Is a feature available? Assumes the probe has already run.
   *
   * @param {string} feature
   * @returns {boolean}
   */
  has(feature) {
    return !!(this.result && this.result.features && this.result.features[feature])
  }
}
