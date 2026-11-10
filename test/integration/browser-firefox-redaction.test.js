// test/integration/browser-firefox-redaction.test.js
// End-to-end tests of the redaction layer against a REAL browser.
//
// The redaction layer is the boundary between "raw page content" and "what
// the model sees". A unit test proves the pure functions work; this proves
// the layers are actually WIRED — that a cookie written into a real browser
// comes back redacted, and that the escape hatch still returns the value.
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
import { relaxNavigationPolicy } from './fixtures.js'

// The fixtures are loaded as data: URLs, which the navigation policy blocks
// by default. The policy is relaxed for this file — the tests are
// exercising the redaction layer, not the policy.
relaxNavigationPolicy()

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..', '..')
const absPath = (rel) => pathToFileURL(resolve(PLUGIN_ROOT, rel)).href

const { detectFirefoxBin } = await import(absPath('lib/firefox/launcher.js'))
const { FirefoxProvider } = await import(absPath('lib/firefox/provider.js'))

const firefoxBin = detectFirefoxBin()
const skip = firefoxBin
  ? false
  : 'firefox is not installed — skipping the live-browser integration test'

const PAGE = `<!doctype html>
<html><head><title>Redaction</title></head>
<body>
  <label for="otp">Verification code</label>
  <input id="otp" name="otp_code" autocomplete="one-time-code" value="123456">
  <label for="plain">Search</label>
  <input id="plain" name="q" value="hello world">
  <button id="log" onclick="console.log('token=abc123def456')">Log</button>
  <p>token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk</p>
</body></html>`

describe('redaction (live browser)', { skip }, () => {
  let provider
  let tmpRoot

  before(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ffbrowser-redaction-'))
    provider = new FirefoxProvider({
      bin: firefoxBin,
      headless: true,
      port: 9650,
      copyBaseDir: join(tmpRoot, 'copies'),
    })
    const started = await provider.start()
    assert.equal(started.ok, true, started.error)
  })

  after(async () => {
    if (provider) await provider.stop()
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('a cookie value comes back redacted, and the escape hatch returns it', async () => {
    const written = await provider.cookie({
      action: 'set',
      cookie: { name: 'ffb_secret', value: 'super-secret-value', domain: 'example.com' },
      confirm: true,
    })
    assert.equal(written.ok, true, written.error)

    const read = await provider.cookie({
      action: 'get',
      filter: { name: 'ffb_secret' },
    })
    assert.equal(read.ok, true, read.error)
    const cookie = read.cookies.find((c) => c.name === 'ffb_secret')
    assert.ok(cookie, 'the cookie must be found')
    assert.ok(!String(cookie.value).includes('super-secret-value'))
    assert.equal(cookie.valueRedacted, true)

    const revealed = await provider.cookie({
      action: 'get',
      filter: { name: 'ffb_secret' },
      revealValues: true,
    })
    const raw = revealed.cookies.find((c) => c.name === 'ffb_secret')
    assert.equal(raw.value, 'super-secret-value')
  })

  test('a one-time-code field is redacted in a snapshot', async () => {
    await provider.navigate('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
    const snap = await provider.snapshot()
    assert.equal(snap.ok, true, snap.error)

    const otp = snap.elements.find((e) => e.name && e.name.includes('Verification code'))
    assert.ok(otp, 'the OTP field must be in the snapshot')
    assert.ok(!String(otp.value).includes('123456'), 'the OTP must not be exposed')
    assert.equal(otp.valueRedacted, true)

    // An ordinary field keeps its value — a redactor that hides everything
    // is as useless as one that hides nothing.
    const plain = snap.elements.find((e) => e.name && e.name.includes('Search'))
    assert.ok(plain, 'the plain field must be in the snapshot')
    assert.equal(plain.value, 'hello world')
  })

  test('a token in the console output does not reach the log buffer', async () => {
    await provider.navigate('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
    const clicked = await provider.click('#log')
    assert.equal(clicked.ok, true, clicked.error)

    // The console event arrives asynchronously; give it a moment.
    await new Promise((r) => setTimeout(r, 300))

    const logs = await provider.consoleLogs()
    const text = JSON.stringify(logs.logs || logs)
    assert.ok(!text.includes('abc123def456'), 'the token must not reach the log buffer')
    assert.ok(text.includes('token='), 'the message around it must survive')
  })

  test('page text is redacted on the text channel', async () => {
    await provider.navigate('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
    const text = await provider.text(undefined, { maxChars: 4000 })
    assert.equal(text.ok, true, text.error)
    assert.ok(!text.value.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'))
    assert.ok(text.value.includes('<redacted>'))
    assert.equal(text.redacted, true)
  })

  test('the snapshot text blocks are redacted too', async () => {
    await provider.navigate('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
    const snap = await provider.snapshot(undefined, { includeText: true })
    assert.equal(snap.ok, true, snap.error)
    const joined = (snap.texts || []).join('\n')
    assert.ok(!joined.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'))
  })
})
