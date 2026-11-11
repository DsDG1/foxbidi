// test/integration/browser-firefox-session-recovery.test.js
// End-to-end tests of the stuck-session and blocked-dialog repairs against
// a REAL browser.
//
// WHAT THIS COVERS
//
//   1. `browser_navigate` reports where the tab actually landed.
//   2. A modal dialog under the `manual` policy blocks the page — the action
//      says so instead of hanging until the command timeout, and the dialog
//      can be handled afterwards.
//   3. `browser_restart {scope:"session"}` clears a wedged session WITHOUT
//      killing Firefox: the same pid, the same tabs, the same login state.
//
// The suite is OPTIONAL — it skips when Firefox is not installed.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

import { relaxNavigationPolicy } from './fixtures.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = resolve(HERE, '..', '..')
const absPath = (rel) => pathToFileURL(resolve(SERVER_DIR, rel)).href

const { detectFirefoxBin } = await import(absPath('lib/firefox/launcher.js'))
const { FirefoxProvider } = await import(absPath('lib/firefox/provider.js'))
const { ERROR_CODES } = await import(absPath('lib/firefox/errors.js'))

relaxNavigationPolicy()

const firefoxBin = detectFirefoxBin()
const skip = firefoxBin
  ? false
  : 'firefox is not installed — skipping the live-browser recovery test'

const PAGE = `<!doctype html>
<html><body>
<button id="go" onclick="window.__alerted = true; alert('blocked here')">go</button>
<p id="after">done</p>
<script>window.__alerted = false;</script>
</body></html>`

describe('session recovery (live browser)', { skip }, () => {
  let tmpRoot
  let provider

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ffbrowser-recov-'))
  })

  after(async () => {
    if (provider) {
      try {
        await provider.stop()
      } catch {}
    }
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  /**
   * A provider on a dedicated port (the runner executes files in parallel).
   */
  function makeProvider() {
    return new FirefoxProvider({
      bin: firefoxBin,
      headless: true,
      port: 9665,
      copyBaseDir: join(tmpRoot, `copies-${Math.random().toString(36).slice(2)}`),
      timeoutMs: 15000,
      readyTimeoutMs: 45000,
    })
  }

  test('a navigation reports where the tab landed', async () => {
    provider = makeProvider()
    try {
      const started = await provider.start()
      assert.equal(started.ok, true, started.error)

      const result = await provider.navigate(
        'data:text/html;charset=utf-8,' + encodeURIComponent(PAGE),
      )
      assert.equal(result.ok, true, result.error)
      assert.ok(result.landedUrl, 'the landing URL must be reported')
      assert.equal(result.navigated, true, 'the tab moved, so navigated must be true')
      assert.match(result.landedUrl, /^data:text\/html/)
    } finally {
      await provider.stop()
      provider = null
    }
  })

  test('a manual dialog blocks the action and can be handled', async () => {
    provider = makeProvider()
    try {
      const started = await provider.start()
      assert.equal(started.ok, true, started.error)

      await provider.navigate('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))

      // The manual policy leaves the dialog open — the page stays blocked.
      const configured = await provider.config({ dialogPolicy: 'manual' })
      assert.equal(configured.ok, true, configured.error)

      const snapshot = await provider.snapshot()
      assert.equal(snapshot.ok, true, snapshot.error)
      const button = snapshot.elements.find((e) => e.name === 'go')
      assert.ok(button, 'the fixture button must be in the snapshot')

      const started2 = Date.now()
      const clicked = await provider.click(undefined, undefined, { ref: button.ref })
      const elapsed = Date.now() - started2

      assert.equal(clicked.ok, false, 'the action must report the blocked page')
      assert.equal(clicked.code, ERROR_CODES.DIALOG_OPEN)
      assert.match(clicked.hint, /browser_handle_dialog/)
      assert.ok(
        elapsed < 12000,
        `the action took ${elapsed}ms — it waited for the command timeout instead of returning`,
      )

      // The dialog can be handled, and the page comes back.
      const handled = await provider.handleDialog({ action: 'dismiss' })
      assert.equal(handled.ok, true, handled.error)

      const after = await provider.snapshot()
      assert.equal(after.ok, true, after.error)
    } finally {
      await provider.stop()
      provider = null
    }
  })

  test('a session reset keeps Firefox and the tabs', async () => {
    provider = makeProvider()
    try {
      const started = await provider.start()
      assert.equal(started.ok, true, started.error)

      const nav = await provider.navigate(
        'data:text/html;charset=utf-8,' + encodeURIComponent(PAGE),
      )
      assert.equal(nav.ok, true, nav.error)

      const pidBefore = provider.pid
      const contextBefore = provider._lastContextId
      assert.ok(contextBefore, 'the tab must be known before the reset')

      const restarted = await provider.restart({ scope: 'session' })
      assert.equal(restarted.ok, true, restarted.error)
      assert.equal(restarted.scope, 'session')
      assert.equal(restarted.browserKept, true)
      assert.equal(provider.pid, pidBefore, 'the browser must NOT be killed by a session reset')

      // The tab survived, and the session still works.
      const tabs = await provider.listTabs()
      assert.ok(tabs.length > 0, 'the tabs must survive a session reset')
      assert.ok(
        tabs.some((t) => t.contextId === contextBefore),
        'the tab must keep its context id across a session reset',
      )

      const after = await provider.navigate(
        'data:text/html;charset=utf-8,' + encodeURIComponent(PAGE),
      )
      assert.equal(after.ok, true, after.error)
      assert.equal(after.navigated, true)
    } finally {
      await provider.stop()
      provider = null
    }
  })
})
