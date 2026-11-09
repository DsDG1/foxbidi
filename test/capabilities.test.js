// test/capabilities.test.js
// Unit tests for the capability probe.
//
// The plugin must not guess: a feature that is missing has to be reported as
// missing, with the requirement and the detected version attached, so the
// agent can act on it instead of staring at "unknown command".

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  FEATURES,
  FEATURE_KEYS,
  parseVersion,
  isAtLeast,
  versionFromStatus,
  capabilityError,
  probeCapabilities,
  expectedFeatures,
  CapabilitySet,
} from '../lib/firefox/capabilities.js'

/**
 * A fake BiDi client.
 *
 * @param {object} opts
 * @param {string} [opts.version]        the Firefox version to report
 * @param {string[]} [opts.unsupported]  methods that should fail as unknown
 */
function fakeClient(opts = {}) {
  const unsupported = new Set(opts.unsupported || [])
  return {
    async send(method) {
      if (unsupported.has(method)) {
        const error = new Error(`${method} is not a valid command`)
        error.code = 'unknown_command'
        throw error
      }
      if (method === 'session.status') {
        return {
          capabilities: {
            browserName: 'firefox',
            browserVersion: opts.version || '140.11.0esr',
          },
        }
      }
      if (method === 'network.addIntercept') {
        return { interceptId: 'int-1' }
      }
      return {}
    },
  }
}

describe('version handling', () => {
  test('a version string is parsed into its parts', () => {
    const v = parseVersion('140.11.0esr')
    assert.equal(v.major, 140)
    assert.equal(v.minor, 11)
    assert.equal(v.patch, 0)
  })

  test('a missing version parses to zero rather than NaN', () => {
    assert.equal(parseVersion(undefined).major, 0)
    assert.equal(parseVersion('not a version').major, 0)
  })

  test('the minimum version is compared on the major number', () => {
    assert.equal(isAtLeast('140.11.0esr', 124), true)
    assert.equal(isAtLeast('123.0', 124), false)
    assert.equal(isAtLeast('124.0', 124), true)
  })

  test('the Firefox version is read out of session.status', () => {
    assert.equal(versionFromStatus({ capabilities: { browserVersion: '141.0' } }), '141.0')
    assert.equal(versionFromStatus({}), '')
    assert.equal(versionFromStatus(null), '')
  })
})

describe('capability probe', () => {
  test('every feature is reported', async () => {
    const caps = await probeCapabilities(fakeClient({ version: '140.11.0esr' }))
    for (const key of FEATURE_KEYS) {
      assert.equal(typeof caps.features[key], 'boolean', `${key} must be a boolean`)
      assert.ok(caps.featureDetails[key], `${key} must carry a reason`)
    }
  })

  test('a feature the version supports is available', async () => {
    const caps = await probeCapabilities(fakeClient({ version: '140.11.0esr' }))
    assert.equal(caps.features.userPrompt, true)
    assert.equal(caps.features.userContexts, true)
    assert.equal(caps.features.webExtension, true)
    assert.equal(caps.features.storageCookies, true)
  })

  test('a feature the version does not support is unavailable, with the requirement', async () => {
    const caps = await probeCapabilities(fakeClient({ version: '118.0' }))
    assert.equal(caps.features.networkBodies, false)
    assert.equal(caps.features.webExtension, false)
    assert.equal(caps.featureDetails.networkBodies.source, 'version')
    assert.match(caps.featureDetails.networkBodies.reason, /144/)
  })

  test('an accepted subscription is the strongest evidence for dialog support', async () => {
    const caps = await probeCapabilities(fakeClient({ version: '118.0' }), {
      subscriptions: { subscribed: ['browsingContext.userPromptOpened'] },
    })
    assert.equal(caps.features.userPrompt, true)
    assert.equal(caps.featureDetails.userPrompt.source, 'probe')
  })

  test('a live probe overrides the version verdict when the command is unknown', async () => {
    const caps = await probeCapabilities(
      fakeClient({ version: '140.11.0esr', unsupported: ['browser.getUserContexts'] }),
    )
    assert.equal(caps.features.userContexts, false)
    assert.equal(caps.featureDetails.userContexts.source, 'probe')
  })

  test('the privileged context is unavailable without the launch flag', async () => {
    const caps = await probeCapabilities(fakeClient({ version: '140.11.0esr' }), {
      privileged: false,
    })
    assert.equal(caps.features.privilegedContext, false)
    assert.match(caps.featureDetails.privilegedContext.reason, /system-access/)
  })

  test('the privileged context is available with the launch flag', async () => {
    const caps = await probeCapabilities(fakeClient({ version: '140.11.0esr' }), {
      privileged: true,
    })
    assert.equal(caps.features.privilegedContext, true)
  })

  test('the known risks name the features that are missing', async () => {
    const caps = await probeCapabilities(fakeClient({ version: '117.0' }))
    assert.ok(caps.knownRisks.some((r) => /dialog/i.test(r)))
    assert.ok(caps.knownRisks.some((r) => /response bod/i.test(r)))
  })
})

describe('capability errors', () => {
  test('the error names the feature, the requirement and what was detected', () => {
    const err = capabilityError('networkBodies', '140.11.0esr')
    assert.equal(err.ok, false)
    assert.equal(err.error, 'capability_unavailable')
    assert.equal(err.feature, 'networkBodies')
    assert.equal(err.required, 'Firefox >= 144')
    assert.equal(err.detected, '140.11.0esr')
    assert.ok(err.hint.length > 0)
  })

  test('every feature has a documented minimum version', () => {
    for (const key of FEATURE_KEYS) {
      assert.ok(FEATURES[key].minFirefox > 0, `${key} needs a minimum version`)
      assert.ok(FEATURES[key].label, `${key} needs a label`)
    }
  })
})

describe('version-based expectations', () => {
  test('the expectation is labelled as not probed', () => {
    const expected = expectedFeatures('140.11.0esr')
    assert.equal(expected.probed, false)
    assert.equal(expected.browserVersion, '140.11.0esr')
    for (const key of FEATURE_KEYS) {
      assert.equal(typeof expected.features[key], 'boolean', `${key} needs a verdict`)
      assert.equal(expected.featureDetails[key].source, 'version')
    }
  })

  test('the expectation follows the same version gates as the probe', () => {
    const expected = expectedFeatures('140.11.0esr')
    assert.equal(expected.features.userPrompt, true)
    assert.equal(expected.features.networkIntercept, true)
    assert.equal(expected.features.webExtension, true)
    assert.equal(expected.features.networkBodies, false, 'response bodies need Firefox 144')
  })

  test('the expectation respects the privileged launch flag', () => {
    assert.equal(expectedFeatures('140.11.0esr').features.privilegedContext, false)
    assert.equal(expectedFeatures('140.11.0esr', { privileged: true }).features.privilegedContext, true)
  })

  test('the expectation names the risks it implies', () => {
    const expected = expectedFeatures('117.0')
    assert.ok(expected.knownRisks.some((r) => /dialog/i.test(r)))
    assert.ok(expected.knownRisks.some((r) => /response bod/i.test(r)))
  })
})

describe('CapabilitySet', () => {
  test('the probe runs once and is then cached', async () => {
    let calls = 0
    const client = {
      async send(method) {
        if (method === 'session.status') {
          calls += 1
          return { capabilities: { browserVersion: '140.11.0esr' } }
        }
        return {}
      },
    }
    const set = new CapabilitySet()
    const first = await set.ensure(client)
    const second = await set.ensure(client)
    assert.equal(first, second)
    assert.equal(calls, 1)
    assert.equal(set.has('userPrompt'), true)
  })

  test('reset forgets the cached result', async () => {
    const set = new CapabilitySet()
    await set.ensure(fakeClient())
    assert.ok(set.result)
    set.reset()
    assert.equal(set.result, null)
  })
})
