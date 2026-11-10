// test/integration/browser-firefox-snapshot-delta.test.js
// Snapshot deltas, end to end against a REAL browser.
//
// The unit test proves the diff logic. This proves it is WIRED: that a
// snapshot taken with `since` really carries a delta, that the delta
// reflects what changed on the page, and — the important half — that the
// full element list is STILL there, so an agent that ignores the delta
// still sees the whole page.
//
// It uses a THROWAWAY profile copy; the user's own Firefox profile is never
// opened or modified.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { relaxNavigationPolicy } from './fixtures.js'

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
<html><head><title>Delta</title></head>
<body>
  <button id="one">One</button>
  <button id="two">Two</button>
</body></html>`

describe('snapshot deltas (live browser)', { skip }, () => {
  let provider
  let tmpRoot
  let pageUrl

  before(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ffbrowser-delta-'))
    const file = join(tmpRoot, 'page.html')
    writeFileSync(file, PAGE, 'utf8')
    pageUrl = pathToFileURL(file).href

    provider = new FirefoxProvider({
      bin: firefoxBin,
      headless: true,
      port: 9656,
      copyBaseDir: join(tmpRoot, 'copies'),
    })
    const started = await provider.start()
    assert.equal(started.ok, true, started.error)
    await provider.navigate(pageUrl)
  })

  after(async () => {
    if (provider) await provider.stop()
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('a snapshot without since carries no delta', async () => {
    const snap = await provider.snapshot()
    assert.equal(snap.ok, true, snap.error)
    assert.equal(snap.delta, undefined)
  })

  test('a snapshot with since carries a delta', async () => {
    const first = await provider.snapshot()
    assert.equal(first.ok, true, first.error)

    const second = await provider.snapshot(undefined, { since: first.snapshotId })
    assert.equal(second.ok, true, second.error)
    assert.ok(second.delta, 'the snapshot must carry a delta')
    assert.equal(second.delta.since, first.snapshotId)
  })

  test('the delta is empty when nothing changed', async () => {
    const first = await provider.snapshot()
    const second = await provider.snapshot(undefined, { since: first.snapshotId })
    assert.deepEqual(second.delta.added, [])
    assert.deepEqual(second.delta.changed, [])
    assert.deepEqual(second.delta.removed, [])
  })

  test('the delta reports an added element', async () => {
    const first = await provider.snapshot()
    await provider.evaluate(
      "document.body.insertAdjacentHTML('beforeend', '<button>Three</button>')",
    )
    const second = await provider.snapshot(undefined, { since: first.snapshotId })
    assert.equal(second.delta.added.length, 1)
    assert.equal(second.delta.added[0].name, 'Three')
  })

  test('the delta reports a changed element', async () => {
    const first = await provider.snapshot()
    await provider.evaluate("document.getElementById('one').textContent = 'One renamed'")
    const second = await provider.snapshot(undefined, { since: first.snapshotId })
    assert.equal(second.delta.changed.length, 1)
    assert.equal(second.delta.changed[0].name, 'One renamed')
  })

  test('the delta reports a removed element', async () => {
    const first = await provider.snapshot()
    await provider.evaluate("document.getElementById('two').remove()")
    const second = await provider.snapshot(undefined, { since: first.snapshotId })
    assert.equal(second.delta.removed.length, 1)
  })

  test('the full element list is still returned alongside the delta', async () => {
    // The delta is an ADDITION, not a replacement. An agent that ignores
    // it must still see the whole page.
    const first = await provider.snapshot()
    const second = await provider.snapshot(undefined, { since: first.snapshotId })
    assert.ok(Array.isArray(second.elements))
    assert.ok(second.elements.length > 0, 'the full list must still be there')
    assert.ok(second.count > 0)
  })
})
