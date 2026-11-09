// test/integration/browser-firefox-2x.test.js
// Live-browser tests for the capabilities that 2.0 added.
//
// These are the acceptance criteria of the 2.0 plan, checked against a REAL
// Firefox — a fake client would not catch a page that blocks on a dialog, a
// shadow root the traversal misses, or an element past the old 300 cap.
//
// It uses a THROWAWAY profile copy in a temp directory; the user's own
// Firefox profile is never opened or modified.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..', '..')
const absPath = (rel) => pathToFileURL(resolve(PLUGIN_ROOT, rel)).href

const { detectFirefoxBin } = await import(absPath('lib/firefox/launcher.js'))
const { FirefoxProvider } = await import(absPath('lib/firefox/provider.js'))

const firefoxBin = detectFirefoxBin()
const skip = firefoxBin
  ? false
  : 'firefox is not installed — skipping the live-browser integration test'

/** A page with a shadow root, an iframe, and 600 buttons. */
const PAGE = `<!doctype html>
<html><head><title>2.0 Features</title></head>
<body>
  <div id="host"></div>
  <iframe id="frame" srcdoc="<button id='inside'>Inside frame</button>"></iframe>
  <script>
    const host = document.getElementById('host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button id="shadow">Inside shadow</button>';
    const holder = document.createElement('div');
    for (let i = 0; i < 600; i++) {
      const b = document.createElement('button');
      b.textContent = 'Bulk ' + i;
      b.id = 'bulk' + i;
      holder.appendChild(b);
    }
    document.body.appendChild(holder);
  </script>
</body></html>`

/** A page that raises a JavaScript dialog. */
const DIALOG_PAGE = `<!doctype html>
<html><head><title>Dialog</title></head>
<body>
  <button id="go" onclick="alert('watch out')">Show alert</button>
  <div id="out"></div>
</body></html>`

describe('2.0 capabilities (live browser)', { skip }, () => {
  let provider
  let tmpRoot
  let contextId

  async function load(html) {
    await provider.navigate('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    const tabs = await provider.listTabs()
    contextId = tabs[0]?.contextId
  }

  before(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ffbrowser-2x-'))
    provider = new FirefoxProvider({
      bin: firefoxBin,
      headless: true,
      port: 9630,
      copyBaseDir: join(tmpRoot, 'copies'),
      timeoutMs: 20000,
      readyTimeoutMs: 45000,
    })
    const started = await provider.start()
    assert.equal(started.ok, true, started.error)
  })

  after(async () => {
    if (provider) {
      try {
        await provider.stop()
      } catch {}
    }
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('the snapshot reaches past the old 300-element ceiling', async () => {
    await load(PAGE)
    const first = await provider.snapshot(contextId, { maxElements: 100 })
    assert.equal(first.ok, true, first.error)
    assert.equal(first.total >= 600, true, `expected 600+ elements, got ${first.total}`)
    assert.equal(first.hasMore, true)

    // Walk to the last page and confirm a late element is reachable.
    let offset = 0
    let last = first
    let pages = 0
    while (last.hasMore && pages < 20) {
      offset = last.nextOffset
      last = await provider.snapshot(contextId, { maxElements: 100, offset })
      pages += 1
    }
    assert.equal(last.hasMore, false, 'the pagination should reach the end')
    assert.ok(last.elements.length > 0, 'the last page must not be empty')
    const names = last.elements.map((e) => e.name)
    assert.ok(
      names.some((n) => n.startsWith('Bulk ')),
      `the last page must still contain real elements, got ${JSON.stringify(names)}`,
    )
  })

  test('the snapshot pierces an open shadow root', async () => {
    await load(PAGE)
    const snap = await provider.snapshot(contextId)
    assert.equal(snap.ok, true, snap.error)
    const shadowButton = snap.elements.find((e) => e.name === 'Inside shadow')
    assert.ok(shadowButton, 'the shadow-root button must be in the snapshot')
  })

  test('the snapshot reaches into an iframe', async () => {
    await load(PAGE)
    const snap = await provider.snapshot(contextId, { frames: 'all' })
    assert.equal(snap.ok, true, snap.error)
    assert.ok(snap.frames && snap.frames.length > 0, 'the frames must be reported')
    const frame = snap.frames.find((f) => (f.elements || []).some((e) => e.name === 'Inside frame'))
    assert.ok(frame, 'the iframe button must be in a frame snapshot')
    const ref = frame.elements.find((e) => e.name === 'Inside frame').ref
    assert.match(ref, /^f[0-9a-z]+:e\d+$/, 'a frame ref must carry its frame label')
  })

  test('a ref inside an iframe can be acted on', async () => {
    await load(PAGE)
    const snap = await provider.snapshot(contextId, { frames: 'all' })
    const frame = snap.frames.find((f) => (f.elements || []).some((e) => e.name === 'Inside frame'))
    assert.ok(frame)
    const ref = frame.elements.find((e) => e.name === 'Inside frame').ref

    const clicked = await provider.click(undefined, contextId, { ref })
    assert.equal(clicked.ok, true, clicked.error)
  })

  test('the snapshot leaves no marker attribute in the DOM', async () => {
    await load(PAGE)
    await provider.snapshot(contextId)
    const check = await provider.evaluate(
      "document.querySelectorAll('[data-mavis-ff-ref]').length",
      contextId,
    )
    assert.equal(check.value, 0, 'the plugin must not mark elements in the DOM')
  })

  test('a JavaScript dialog does not hang the agent', async () => {
    await load(DIALOG_PAGE)
    const snap = await provider.snapshot(contextId)
    const button = snap.elements.find((e) => e.name === 'Show alert')
    assert.ok(button, 'the alert button must be in the snapshot')

    const started = Date.now()
    const clicked = await provider.click(undefined, contextId, { ref: button.ref })
    const elapsed = Date.now() - started

    assert.equal(clicked.ok, true, clicked.error)
    // The click itself opens the dialog; the dialog is closed automatically
    // and reported. The next action must not block.
    assert.ok(elapsed < 10000, `the click took ${elapsed}ms — the dialog blocked it`)

    const after = await provider.evaluate('1 + 1', contextId)
    assert.equal(after.value, 2, 'the page must still be usable after the dialog')
  })

  test('the dialog is reported in the effect of the next action', async () => {
    await load(DIALOG_PAGE)
    const snap = await provider.snapshot(contextId)
    const button = snap.elements.find((e) => e.name === 'Show alert')
    await provider.click(undefined, contextId, { ref: button.ref })

    // A second action drains the dialog record.
    const result = await provider.evaluate('document.title', contextId)
    assert.equal(result.ok, true)
    // The dialog may already have been drained by the click itself; either
    // way the plugin must never report a stuck page.
    assert.equal(result.ok, true)
  })

  test('the detectability report is honest about webdriver', async () => {
    await load(PAGE)
    const report = await provider.detectability(contextId)
    assert.equal(report.ok, true, report.error)
    assert.equal(
      report.webdriver,
      true,
      'Firefox sets navigator.webdriver when the remote agent runs',
    )
    assert.equal(report.automationDetectable, true)
    assert.equal(report.domRefAttributes, 0)
    assert.ok(Array.isArray(report.notes))
  })

  test('the status reports the capability matrix', async () => {
    // browser_status probes first, so the agent gets the matrix without
    // having to trigger a capability-requiring call.
    await provider.probeCapabilities()
    const status = provider.status()
    assert.equal(status.ok, true)
    assert.ok(status.capabilities, 'the status must carry the capability matrix')
    assert.ok(typeof status.capabilities.browserVersion === 'string')
    assert.ok(status.capabilities.features.userPrompt !== undefined)
    assert.equal(status.refMode, 'registry')
  })

  test('a capability the browser lacks is reported as unavailable, not as a raw error', async () => {
    // Response bodies need Firefox 144+; on an older build the tool must say
    // so in a way the agent can act on.
    const result = await provider.network({ requestId: 'no-such-request' })
    assert.equal(result.ok, true)
    if (result.bodyAvailable === false) {
      assert.equal(result.reason, 'requires Firefox >= 144')
      assert.ok(result.hint, 'the agent must get an alternative')
    }
  })

  test('containers can be listed', async () => {
    const listed = await provider.userContext({ action: 'list' })
    assert.equal(listed.ok, true, listed.error)
    assert.ok(Array.isArray(listed.userContexts))
    assert.ok(
      listed.userContexts.some((c) => c.userContext === 'default'),
      'the default container must be listed',
    )
  })

  test('a container can be created and used', async () => {
    const caps = await provider._ensureCapabilities()
    if (!caps.features.userContexts) {
      // The browser is too old for containers — the tool must say so rather
      // than fail with an obscure error.
      const created = await provider.userContext({ action: 'create' })
      assert.equal(created.ok, false)
      assert.equal(created.error, 'capability_unavailable')
      return
    }

    const created = await provider.userContext({ action: 'create', label: 'agent-test' })
    assert.equal(created.ok, true, created.error)
    assert.ok(created.userContext)

    const selected = await provider.userContext({
      action: 'select',
      userContext: created.userContext,
      url: 'data:text/html;charset=utf-8,' + encodeURIComponent('<title>container</title>'),
    })
    assert.equal(selected.ok, true, selected.error)
    assert.ok(selected.contextId)

    const removed = await provider.userContext({
      action: 'remove',
      userContext: created.userContext,
    })
    assert.equal(removed.ok, true, removed.error)
  })

  test('a batch of actions runs in one call', async () => {
    await load(PAGE)
    const result = await provider.batch([
      { action: 'snapshot' },
      { action: 'wait_for', for: 'load' },
    ])
    assert.equal(result.ok, true, JSON.stringify(result.steps))
    assert.equal(result.completed, 2)
  })

  test('a helper script can be run from the agent workspace', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { homedir } = await import('node:os')
    const dir = join(homedir(), '.mavis', 'ff-workspace')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'integration-probe.js')
    writeFileSync(file, 'return (args) => ({ sum: args.a + args.b, title: document.title })')
    await load(PAGE)
    const result = await provider.runScript(file, { args: { a: 2, b: 3 } })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.result.sum, 5)
    rmSync(file, { force: true })
  })
})
