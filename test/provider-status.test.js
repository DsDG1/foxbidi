// test/provider-status.test.js
// Unit tests for the status report.
//
// `browser_status` is a READ-only tool: it must not start a browser just to
// answer a question. That means the status has to be useful while the browser
// is idle — it reports what the Firefox BINARY can do (a version-based
// expectation) and says so, instead of pretending it probed something.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { FirefoxProvider, STATE } from '../lib/firefox/provider.js'

/**
 * A provider that is not running.
 *
 * @param {string} [version]
 * @returns {FirefoxProvider}
 */
function idleProvider(version = '140.11.0esr') {
  const provider = new FirefoxProvider({ copyBaseDir: '/tmp/ffb-test' })
  provider.binaryVersion = () => version
  return provider
}

describe('status', () => {
  test('an idle browser reports an expectation, not a probe', () => {
    const status = idleProvider().status()
    assert.equal(status.ok, true)
    assert.equal(status.state, STATE.IDLE)
    assert.equal(status.capabilities.probed, false)
    assert.equal(status.capabilities.browserVersion, '140.11.0esr')
    assert.equal(status.capabilities.features.userPrompt, true)
    assert.equal(status.capabilities.features.networkBodies, false)
  })

  test('the expectation says it was not probed', () => {
    const status = idleProvider().status()
    assert.ok(
      status.capabilities.knownRisks.some((r) => /not running/i.test(r)),
      'the agent must be able to tell an expectation from a probe',
    )
  })

  test('a probed matrix is labelled as probed', () => {
    const provider = idleProvider()
    provider.capabilities.result = {
      browserVersion: '140.11.0esr',
      features: { userPrompt: true },
      featureDetails: { userPrompt: { available: true, source: 'probe', reason: 'ok' } },
      knownRisks: [],
      probed: true,
    }
    const status = provider.status()
    assert.equal(status.capabilities.probed, true)
    assert.equal(status.capabilities.features.userPrompt, true)
  })

  test('the default payload carries no per-feature provenance', () => {
    // The full matrix has a `featureDetails` entry for EVERY feature, and
    // only the unavailable ones are actionable. The default keeps the
    // boolean table and the reasons for what is missing.
    const provider = idleProvider()
    provider.capabilities.result = {
      browserVersion: '140.11.0esr',
      features: { userPrompt: true, networkBodies: false },
      featureDetails: {
        userPrompt: { available: true, source: 'probe', reason: 'ok' },
        networkBodies: { available: false, source: 'version', reason: 'Firefox 140 < 144' },
      },
      knownRisks: [],
      probed: true,
    }
    const status = provider.status()
    assert.equal(status.capabilities.featureDetails, undefined)
    assert.deepEqual(status.capabilities.features, { userPrompt: true, networkBodies: false })
    assert.equal(status.capabilities.unavailable.length, 1)
    assert.equal(status.capabilities.unavailable[0].feature, 'networkBodies')
    assert.equal(status.capabilities.unavailable[0].reason, 'Firefox 140 < 144')
    assert.equal(status.capabilities.unavailable[0].source, 'version')
  })

  test('an available feature is not listed as unavailable', () => {
    const status = idleProvider().status()
    const names = status.capabilities.unavailable.map((u) => u.feature)
    assert.ok(!names.includes('userPrompt'), 'an available feature needs no reason')
    assert.ok(names.includes('networkBodies'), 'a missing feature must be explained')
    for (const entry of status.capabilities.unavailable) {
      assert.ok(entry.reason, `${entry.feature} needs a reason`)
      assert.ok(entry.source, `${entry.feature} needs a source`)
    }
  })

  test('the full payload keeps the provenance of every feature', () => {
    const provider = idleProvider()
    provider.capabilities.result = {
      browserVersion: '140.11.0esr',
      features: { userPrompt: true },
      featureDetails: { userPrompt: { available: true, source: 'probe', reason: 'ok' } },
      knownRisks: [],
      probed: true,
    }
    const status = provider.status('full')
    assert.ok(status.capabilities.featureDetails, 'the full matrix keeps featureDetails')
    assert.equal(status.capabilities.featureDetails.userPrompt.source, 'probe')
  })

  test('the trust markers survive the trimming', () => {
    // `probed` says whether the matrix was measured or predicted, and
    // `knownRisks` carries the caveats. Neither may be trimmed away.
    const status = idleProvider().status()
    assert.equal(status.capabilities.probed, false)
    assert.ok(Array.isArray(status.capabilities.knownRisks))
    assert.ok(status.capabilities.knownRisks.length > 0)
  })

  test('the binary version is read once and cached', () => {
    const provider = new FirefoxProvider({ copyBaseDir: '/tmp/ffb-test' })
    provider._binaryVersionCache = '140.11.0esr'
    assert.equal(provider.binaryVersion(), '140.11.0esr')
  })
})
