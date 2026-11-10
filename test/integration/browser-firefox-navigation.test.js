// test/integration/browser-firefox-navigation.test.js
// End-to-end tests of the navigation policy against a REAL browser.
//
// The policy decides where a browser carrying the user's REAL login state
// may go. This file proves it is actually enforced on the wire — not just
// that the classifier returns the right verdict in a unit test.
//
// It uses a THROWAWAY profile copy; the user's own Firefox profile is never
// opened or modified.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..', '..')
const absPath = (rel) => pathToFileURL(resolve(PLUGIN_ROOT, rel)).href

const { detectFirefoxBin } = await import(absPath('lib/firefox/launcher.js'))
const { FirefoxProvider } = await import(absPath('lib/firefox/provider.js'))

const firefoxBin = detectFirefoxBin()
const skip = firefoxBin
  ? false
  : 'firefox is not installed — skipping the live-browser integration test'

describe('the navigation policy (live browser)', { skip }, () => {
  let provider
  let tmpRoot

  before(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ffbrowser-nav-'))
    provider = new FirefoxProvider({
      bin: firefoxBin,
      headless: true,
      port: 9651,
      copyBaseDir: join(tmpRoot, 'copies'),
    })
    const started = await provider.start()
    assert.equal(started.ok, true, started.error)
  })

  after(async () => {
    if (provider) await provider.stop()
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('a loopback address is refused', async () => {
    const result = await provider.navigate('http://127.0.0.1:9999/')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'navigation_blocked')
    assert.equal(result.reason, 'private_host')
    assert.ok(result.hint)
  })

  test('a localhost name is refused', async () => {
    const result = await provider.navigate('http://localhost:9999/')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'navigation_blocked')
  })

  test('a file: URL is refused', async () => {
    const result = await provider.navigate('file:///etc/passwd')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'navigation_blocked')
    assert.equal(result.reason, 'blocked_scheme')
  })

  test('a new tab with a private address is refused', async () => {
    const result = await provider.newTab('http://127.0.0.1:9999/')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'navigation_blocked')
  })

  test('an ordinary web URL is allowed', async () => {
    // about:blank is a normal, harmless target and is not on the blocked
    // list — it proves the policy does not block everything.
    const result = await provider.navigate('about:blank')
    assert.equal(result.ok, true, result.error)
  })
})
