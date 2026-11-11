// test/integration/browser-firefox-no-profile.test.js
// End-to-end test for a machine that has NO Firefox user profile.
//
// WHY THIS EXISTS
//
// The provider used to REFUSE to start when it could not find a user
// profile: "no Firefox profile found — set FIREFOX_BROWSER_PROFILE to a
// profile path". That is a perfectly reasonable machine — Firefox installed
// but never launched, so there is no `profiles.ini` and no profile
// directory — and the browser itself would happily create one on its first
// run. The refusal meant the plugin could not run on a freshly provisioned
// machine at all: a CI runner, a container, a new laptop.
//
// The fix is to fall back to a FRESH, EMPTY profile. This test pins that
// behaviour down: the profile directory is pointed at an empty one, so the
// detection finds nothing, and the browser still has to come up and serve a
// page.
//
// The `firefoxDir` option is what makes this testable without touching the
// developer's real `~/.mozilla` tree.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { relaxNavigationPolicy } from './fixtures.js'

relaxNavigationPolicy()

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = resolve(HERE, '..', '..')
const absPath = (rel) => pathToFileURL(resolve(SERVER_DIR, rel)).href

const { detectFirefoxBin } = await import(absPath('lib/firefox/launcher.js'))
const { FirefoxProvider } = await import(absPath('lib/firefox/provider.js'))

const firefoxBin = detectFirefoxBin()
const skip = firefoxBin
  ? false
  : 'firefox is not installed — skipping the live-browser integration test'

describe('a machine without a user profile (live browser)', { skip }, () => {
  let provider
  let tmpRoot
  let emptyFirefoxDir

  before(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ffbrowser-noprofile-'))
    // A Firefox data directory with NOTHING in it: no `profiles.ini`, no
    // profile. This is what a machine with Firefox installed but never
    // launched looks like.
    emptyFirefoxDir = join(tmpRoot, 'firefox-home')
    mkdirSync(emptyFirefoxDir, { recursive: true })

    provider = new FirefoxProvider({
      bin: firefoxBin,
      headless: true,
      // A dedicated base port: the test runner runs files in parallel, and
      // every live-browser file would otherwise race for the same port.
      port: 9660,
      // Look for a user profile HERE — and find nothing.
      firefoxDir: emptyFirefoxDir,
      copyBaseDir: join(tmpRoot, 'copies'),
      timeoutMs: 20000,
      readyTimeoutMs: 45000,
    })
  })

  after(async () => {
    if (provider) {
      try {
        await provider.stop()
      } catch {}
    }
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('the browser starts without a user profile', async () => {
    const res = await provider.start()
    assert.equal(res.ok, true, `start failed: ${res.error}`)
    assert.equal(provider.state, 'ready')
  })

  test('the session reports that it runs on a fresh profile', async () => {
    assert.ok(provider.profileInfo, 'the session must describe its profile')
    assert.equal(provider.profileInfo.fresh, true, 'the profile must be the fresh fallback')
    assert.ok(existsSync(provider.profileInfo.source), 'the fresh profile must exist on disk')
  })

  test('the browser really works on that profile', async () => {
    const nav = await provider.navigate('data:text/html,<h1>No profile</h1>')
    assert.equal(nav.ok, true, nav.error)
    const text = await provider.text(undefined, { maxChars: 200 })
    assert.equal(text.ok, true, text.error)
    assert.match(String(text.value), /No profile/)
  })
})
