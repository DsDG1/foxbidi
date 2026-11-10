// test/captcha-detect.test.js
// Unit tests for challenge detection.
//
// Detection is read-only: it never clicks, types, or moves the pointer.
// That property is what makes `solver: "auto"` safe as a probe, so the
// classification logic is tested here without a browser.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTO_ORDER,
  CHALLENGES,
  challengeForUrl,
  flattenTree,
  urlMatchesChallenge,
  preloadSource,
  CLOSED_ROOT_PROP,
} from '../lib/firefox/captcha/detect.js'

describe('challenge classification', () => {
  test('recognises a Turnstile challenge frame by URL', () => {
    const url =
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/xgl8i'
    const challenge = challengeForUrl(url)
    assert.equal(challenge.id, 'turnstile')
  })

  test('recognises a reCAPTCHA challenge frame by URL', () => {
    const url = 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=sitekey'
    assert.equal(challengeForUrl(url).id, 'recaptcha')
  })

  test('recognises an hCaptcha challenge frame by URL', () => {
    const url = 'https://newassets.hcaptcha.com/captcha/v1/xxx/static/hcaptcha-challenge.html'
    assert.equal(challengeForUrl(url).id, 'hcaptcha')
  })

  test('recognises a GeeTest challenge frame by URL', () => {
    const url = 'https://gcaptcha4.geetest.com/load?challenge=abc'
    assert.equal(challengeForUrl(url).id, 'geetest')
  })

  test('returns null for an unrelated frame', () => {
    assert.equal(challengeForUrl('https://example.com/page'), null)
  })

  test('matches case-insensitively', () => {
    assert.equal(
      urlMatchesChallenge('https://CHALLENGES.CLOUDFLARE.COM/x', CHALLENGES.turnstile),
      true,
    )
  })

  test('every challenge declares a token selector', () => {
    for (const id of AUTO_ORDER) {
      const challenge = CHALLENGES[id]
      assert.ok(challenge, `${id} should exist`)
      if (challenge.tokenless) {
        // A tokenless challenge (a rotate-to-upright slider) is judged
        // by its widget disappearing instead of by a token appearing.
        assert.ok(challenge.solvedSelector, `${id} needs a solved selector`)
        continue
      }
      assert.equal(typeof challenge.tokenSelector, 'string')
      assert.ok(challenge.tokenSelector.length > 0, `${id} needs a token selector`)
    }
  })
})

describe('flattenTree', () => {
  test('flattens nested frames with their depth', () => {
    const tree = [
      {
        contextId: 'top',
        url: 'https://example.com',
        children: [
          {
            contextId: 'f1',
            url: 'https://a.example',
            children: [{ contextId: 'f2', url: 'https://b.example' }],
          },
        ],
      },
    ]
    const flat = flattenTree(tree)
    assert.deepEqual(
      flat.map((f) => [f.contextId, f.depth]),
      [
        ['top', 0],
        ['f1', 1],
        ['f2', 2],
      ],
    )
  })

  test('tolerates a tree with no children', () => {
    const flat = flattenTree([{ contextId: 'top', url: 'https://example.com' }])
    assert.equal(flat.length, 1)
    assert.equal(flat[0].contextId, 'top')
  })

  test('tolerates an empty tree', () => {
    assert.deepEqual(flattenTree([]), [])
  })
})

describe('preloadSource', () => {
  test('produces a function expression', () => {
    const source = preloadSource()
    assert.match(source, /^\s*\(\)\s*=>\s*\{/)
  })

  test('patches attachShadow', () => {
    assert.match(preloadSource(), /attachShadow/)
  })

  test('parks the root on a property that does not collide with the ref registry', () => {
    // The plugin's own registry uses a `__ffb_` prefix; the solver must not
    // squat on it, or `browser_detectability` would report the solver's
    // handles as registry entries.
    assert.equal(CLOSED_ROOT_PROP.startsWith('__ffb_'), false)
    assert.match(preloadSource(), new RegExp(CLOSED_ROOT_PROP))
  })
})
