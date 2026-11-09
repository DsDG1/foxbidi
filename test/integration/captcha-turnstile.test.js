// test/integration/captcha-turnstile.test.js
// End-to-end test of CAPTCHA solving against a REAL browser.
//
// The point of this test is not "a token appeared" — it is that the token
// appeared BECAUSE THE SOLVER CLICKED. Turnstile on the test site hands out
// a placeholder token ("XXXX.DUMMY.TOKEN.XXXX") once the challenge is
// satisfied, and hands out nothing at all while it is still pending.
//
// So the suite runs the same page twice:
//   - with the solver running  -> a token must appear
//   - with the solver NOT run   -> NO token may appear
//
// Without the control, the test would also pass on a build where the
// challenge auto-solves, which would prove nothing about the solver.
//
// The suite is OPTIONAL — it skips when Firefox is not installed, and it
// skips when the test host cannot reach the challenge provider.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = resolve(HERE, '..', '..')
const absPath = (rel) => pathToFileURL(resolve(SERVER_DIR, rel)).href

const { detectFirefoxBin } = await import(absPath('lib/firefox/launcher.js'))
const { FirefoxProvider } = await import(absPath('lib/firefox/provider.js'))

const firefoxBin = detectFirefoxBin()
const skip = firefoxBin
  ? false
  : 'firefox is not installed — skipping the live-browser CAPTCHA test'

const CHALLENGE_URL = 'https://nowsecure.nl'

describe('turnstile solving (live browser)', { skip }, () => {
  let tmpRoot
  let provider

  before(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ffbrowser-captcha-'))
    provider = new FirefoxProvider({
      bin: firefoxBin,
      headless: true,
      port: 9631,
      copyBaseDir: join(tmpRoot, 'copies'),
      timeoutMs: 20000,
      readyTimeoutMs: 45000,
    })
    const started = await provider.start()
    if (!started.ok) throw new Error(`could not start firefox: ${started.error}`)
  })

  after(async () => {
    if (provider) await provider.stop()
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  /**
   * Read the Turnstile token length on the current page.
   *
   * @returns {Promise<number>}
   */
  async function tokenLength() {
    const result = await provider.evaluate(
      `(() => {
        const el = document.querySelector('[name="cf-turnstile-response"]');
        return el ? String(el.value || '').length : 0;
      })()`,
    )
    if (!result.ok) return 0
    return typeof result.value === 'number' ? result.value : 0
  }

  test('the challenge is pending before the solver runs (control)', async (t) => {
    const navigated = await provider.navigate(CHALLENGE_URL)
    if (!navigated.ok) {
      t.skip(`could not reach ${CHALLENGE_URL}: ${navigated.error}`)
      return
    }
    // Give the widget time to mount.
    await new Promise((resolve) => setTimeout(resolve, 6000))

    const length = await tokenLength()
    // The control: while the challenge is unsolved there is NO token.
    assert.equal(length, 0, 'the control must see no token before the solver runs')
  })

  test('the solver produces a token the site issued', async (t) => {
    const navigated = await provider.navigate(CHALLENGE_URL)
    if (!navigated.ok) {
      t.skip(`could not reach ${CHALLENGE_URL}: ${navigated.error}`)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 6000))

    const result = await provider.captcha(undefined, { solver: 'turnstile', timeoutMs: 30000 })

    assert.equal(result.ok, true, `the solver should have solved the challenge: ${result.message}`)
    assert.equal(result.status, 'solved')
    assert.ok(result.tokenLength > 10, 'the site should have issued a non-trivial token')

    // The token must be visible in the page, not just in the solver's report.
    const length = await tokenLength()
    assert.ok(length > 10, 'the token should be readable from the page')
  })
})
