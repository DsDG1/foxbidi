// test/integration/browser-firefox-gate.test.js
// End-to-end tests of the confirmation gate against a REAL browser.
//
// The gate is the plugin's safety boundary. Before this work, three paths
// reached a form submission WITHOUT passing it: pressing Enter in a field,
// changing a <select>, and toggling a radio. An agent blocked on `click`
// could simply pick a different tool.
//
// So this file proves the three paths are now gated, that the refusal has
// the SAME shape as every other refusal, and that `confirm: true` releases
// them.
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
import { relaxNavigationPolicy } from './fixtures.js'

// The fixture is loaded as a data: URL, which the navigation policy blocks
// by default. This file exercises the GATE, not the policy.
relaxNavigationPolicy()

const firefoxBin = detectFirefoxBin()
const skip = firefoxBin
  ? false
  : 'firefox is not installed — skipping the live-browser integration test'

const PAGE = `<!doctype html>
<html><head><title>Gate</title></head>
<body>
  <form id="f" action="https://example.com/pay" method="post">
    <input id="field" name="note" value="">
    <button id="go" type="submit">Pay</button>
  </form>
  <form id="g" action="https://example.com/pay" method="post">
    <select id="plan"><option value="1">Basic</option><option value="2">Pro</option></select>
    <button type="submit">Buy</button>
  </form>
  <form id="h" action="https://example.com/pay" method="post">
    <input id="radio" type="radio" name="tier" value="a">
    <input id="radio2" type="radio" name="tier" value="b">
    <button type="submit">Buy</button>
  </form>
  <input id="loose" type="checkbox">
  <select id="loose_select"><option value="1">One</option><option value="2">Two</option></select>
</body></html>`

describe('the confirmation gate (live browser)', { skip }, () => {
  let provider
  let tmpRoot

  before(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ffbrowser-gate-'))
    provider = new FirefoxProvider({
      bin: firefoxBin,
      headless: true,
      port: 9652,
      copyBaseDir: join(tmpRoot, 'copies'),
    })
    const started = await provider.start()
    assert.equal(started.ok, true, started.error)
  })

  after(async () => {
    if (provider) await provider.stop()
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  async function load() {
    await provider.navigate('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
  }

  test('pressing Enter in a form field is gated', async () => {
    await load()
    // Focus the field so the Enter key has a form to submit. The click
    // itself needs a confirmation — a text field inside a POST form is
    // already classified as irreversible by the pre-existing rule, which
    // this test does not change.
    const focused = await provider.click('#field', undefined, { confirm: true })
    assert.equal(focused.ok, true, focused.error)

    const pressed = await provider.pressKey('Enter')
    assert.equal(pressed.ok, false, 'Enter in a form must be gated')
    assert.equal(pressed.code, 'confirm_required')
    assert.equal(pressed.action, 'form_submit')
    assert.equal(pressed.requiresConfirm, true)
    assert.ok(pressed.hint)
  })

  test('confirm: true releases the Enter key', async () => {
    await load()
    await provider.click('#field', undefined, { confirm: true })
    const pressed = await provider.pressKey('Enter', undefined, { confirm: true })
    assert.equal(pressed.ok, true, pressed.error)
  })

  test('changing a select in a form is gated', async () => {
    await load()
    const selected = await provider.selectOption('#plan', '2')
    assert.equal(selected.ok, false, 'changing a select in a form must be gated')
    assert.equal(selected.code, 'confirm_required')
    assert.equal(selected.action, 'form_submit')
  })

  test('confirm: true releases the select', async () => {
    await load()
    const selected = await provider.selectOption('#plan', '2', undefined, { confirm: true })
    assert.equal(selected.ok, true, selected.error)
  })

  test('toggling a radio in a form is gated', async () => {
    await load()
    const checked = await provider.check('#radio', true)
    assert.equal(checked.ok, false, 'toggling a radio in a form must be gated')
    assert.equal(checked.code, 'confirm_required')
    assert.equal(checked.action, 'form_submit')
  })

  test('a control outside any form is not gated', async () => {
    // The common case on the web, and the reason this rule produces almost
    // no false positives.
    await load()
    const checked = await provider.check('#loose', true)
    assert.equal(checked.ok, true, checked.error)

    const selected = await provider.selectOption('#loose_select', '2')
    assert.equal(selected.ok, true, selected.error)
  })
})
