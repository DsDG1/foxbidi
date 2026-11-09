// test/integration/browser-firefox.test.js
// End-to-end test of the Firefox provider against a REAL browser.
//
// This suite is OPTIONAL: it is skipped when Firefox is not installed, so
// CI on a machine without Firefox still passes. When Firefox IS present it
// exercises the full chain — launch → BiDi session → navigate → click →
// type → screenshot — against a headless instance.
//
// It uses a THROWAWAY profile copy in a temp directory; the user's own
// Firefox profile is never opened or modified.
//
// Run with:  node --test test/integration/browser-firefox.test.js

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = resolve(HERE, '..', '..')
const absPath = (rel) => pathToFileURL(resolve(SERVER_DIR, rel)).href

const { detectFirefoxBin } = await import(absPath('lib/firefox/launcher.js'))
const { FirefoxProvider } = await import(absPath('lib/firefox/provider.js'))

const firefoxBin = detectFirefoxBin()
const skip = firefoxBin
  ? false
  : 'firefox is not installed — skipping the live-browser integration test'

describe('firefox provider (live browser)', { skip }, () => {
  let provider
  let tmpRoot

  before(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ffbrowser-int-'))
    provider = new FirefoxProvider({
      bin: firefoxBin,
      headless: true,
      // A dedicated base port: the test runner runs files in parallel, and
      // every live-browser file would otherwise race for the same port.
      port: 9610,
      // A throwaway copy directory — never the user's profile.
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

  test('starts Firefox and opens a BiDi session', async () => {
    const res = await provider.start()
    assert.equal(res.ok, true, `start failed: ${res.error}`)
    assert.ok(res.port > 0)
    assert.ok(res.sessionId)
    assert.equal(provider.state, 'ready')
  })

  test('navigates a tab to a data URL', async () => {
    const html =
      '<button id="go">Click Me</button>' +
      '<input id="q">' +
      '<div id="out">idle</div>' +
      '<script>document.getElementById("go").onclick=()=>{' +
      'document.getElementById("out").textContent="CLICKED_OK"}</script>'
    const res = await provider.newTab('data:text/html,' + encodeURIComponent(html))
    assert.equal(res.ok, true, `newTab failed: ${res.error}`)
    assert.ok(res.contextId)
  })

  test('clicks an element with real pointer events', async () => {
    const res = await provider.click('#go')
    assert.equal(res.ok, true, `click failed: ${res.error}`)
    // The page's own handler must have run — a synthetic element.click()
    // would not have updated the DOM.
    const text = await provider.text()
    assert.equal(text.ok, true)
    assert.match(String(text.value), /CLICKED_OK/)
  })

  test('types text into an input', async () => {
    const res = await provider.type('#q', 'hello')
    assert.equal(res.ok, true, `type failed: ${res.error}`)
    const value = await provider.evaluate('document.getElementById("q").value')
    assert.equal(value.ok, true)
    assert.equal(value.value, 'hello')
  })

  test('captures a screenshot', async () => {
    const res = await provider.screenshot()
    assert.equal(res.ok, true, `screenshot failed: ${res.error}`)
    assert.equal(res.encoding, 'base64')
    assert.ok(res.data.length > 1000, 'screenshot should carry real image data')
    // A PNG starts with the 8-byte signature, base64-encoded.
    assert.match(res.data.slice(0, 16), /^iVBORw0KGgo/)
  })

  test('evaluates JavaScript in the page', async () => {
    const res = await provider.evaluate('1 + 41')
    assert.equal(res.ok, true)
    assert.equal(res.value, 42)
  })

  test('lists open tabs', async () => {
    const tabs = await provider.listTabs()
    assert.ok(Array.isArray(tabs))
    assert.ok(tabs.length > 0)
    assert.ok(tabs.some((t) => t.contextId))
  })

  test('reports a missing selector instead of throwing', async () => {
    const res = await provider.click('#definitely-not-here')
    assert.equal(res.ok, false)
    assert.match(res.error, /not found/)
  })
})

// A port can look free and still belong to another Firefox: the free-port
// check and the launch are not atomic. The loser of that race would connect
// to the winner's BiDi endpoint and silently drive the WRONG browser — so the
// provider must detect the conflict and move to the next port.
describe('firefox provider (port conflict)', { skip }, () => {
  let first = null
  let second = null
  let tmpRoot

  before(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ffbrowser-conflict-'))
  })

  after(async () => {
    for (const p of [first, second]) {
      if (p) {
        try {
          await p.stop()
        } catch {}
      }
    }
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('moves to another port instead of driving the browser that owns it', async () => {
    const port = 9600
    // Two live Firefox instances need two profile copies — a profile can
    // only be opened by one browser at a time.
    const mk = (name) =>
      new FirefoxProvider({
        bin: firefoxBin,
        headless: true,
        port,
        copyBaseDir: join(tmpRoot, name),
        timeoutMs: 20000,
        readyTimeoutMs: 45000,
      })

    first = mk('copies-a')
    const a = await first.start()
    assert.equal(a.ok, true, `first start failed: ${a.error}`)
    assert.equal(a.port, port)
    assert.ok(a.sessionId, 'the first browser must have a session')

    // A second provider aimed at the SAME port must not end up controlling
    // the first browser's session.
    second = mk('copies-b')
    const b = await second.start()
    assert.equal(b.ok, true, `second start failed: ${b.error}`)
    assert.notEqual(b.port, port, 'the second provider must not reuse the busy port')
    assert.ok(b.port > port, 'the second provider must move forward to a free port')
    assert.ok(b.sessionId, 'the second provider must own its own session')
    assert.equal(b.sessionReused, false, 'the second provider must not reuse a session')

    // And the second browser must actually work.
    const tab = await second.newTab('data:text/html,<p id="x">conflict-ok</p>')
    assert.equal(tab.ok, true, `newTab failed: ${tab.error}`)
    const text = await second.text()
    assert.match(String(text.value), /conflict-ok/)

    // The first browser must be untouched.
    const aStatus = first.status()
    assert.equal(aStatus.state, 'ready')
    assert.equal(aStatus.port, port)
    assert.equal(aStatus.sessionId, a.sessionId)
  })
})
