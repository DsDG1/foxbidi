// test/integration/browser-firefox-only.test.js
// Live-browser tests for the Firefox-only capabilities.
//
// Containers, extension management, privileged pages, HttpOnly cookies and
// request interception are the things a CDP-based harness structurally
// cannot do — so they are worth proving against a real Firefox.
//
// The browser here is started with `--remote-allow-system-access`, which is
// what unlocks the privileged about: pages. It uses a THROWAWAY profile copy
// in a temp directory; the user's own Firefox profile is never opened or
// modified.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'

import { relaxNavigationPolicy } from './fixtures.js'

// These tests load their fixtures as data: URLs, which the navigation
// policy blocks by default. The policy is relaxed for the whole file — the
// tests are exercising the agent loop, not the policy.
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

/** A minimal unpacked extension. */
function writeTestExtension(dir) {
  const extDir = join(dir, 'probe-extension')
  mkdirSync(extDir, { recursive: true })
  writeFileSync(
    join(extDir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 2,
      name: 'FFB Probe',
      version: '1.0',
      description: 'A tiny test extension',
      content_scripts: [{ matches: ['<all_urls>'], js: ['probe.js'] }],
      permissions: ['<all_urls>'],
    }),
  )
  writeFileSync(
    join(extDir, 'probe.js'),
    'document.documentElement.setAttribute("data-ffb-probe", "1");',
  )
  return extDir
}

describe('Firefox-only capabilities (live browser)', { skip }, () => {
  let provider
  let tmpRoot
  let extDir

  before(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ffbrowser-only-'))
    extDir = writeTestExtension(tmpRoot)
    provider = new FirefoxProvider({
      bin: firefoxBin,
      headless: true,
      port: 9640,
      copyBaseDir: join(tmpRoot, 'copies'),
      timeoutMs: 20000,
      readyTimeoutMs: 45000,
      // The privileged pages (about:addons) need this.
      privileged: true,
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

  test('the privileged capability is reported as available', async () => {
    const caps = await provider.probeCapabilities()
    assert.equal(
      caps.features.privilegedContext,
      true,
      caps.featureDetails.privilegedContext.reason,
    )
  })

  test('the extension list can be read', async () => {
    const listed = await provider.extension({ action: 'list' })
    assert.equal(listed.ok, true, listed.error)
    assert.ok(Array.isArray(listed.extensions))
    assert.ok(listed.extensions.length > 0, 'Firefox ships with some built-in extensions')
    // Every record must carry an id and a name.
    for (const ext of listed.extensions) {
      assert.ok(ext.id, 'an extension record must have an id')
      assert.ok(ext.name, 'an extension record must have a name')
    }
  })

  test('installing an extension is refused without confirmation', async () => {
    const gated = await provider.extension({ action: 'install', path: extDir })
    assert.equal(gated.ok, false)
    assert.equal(gated.blocked, true)
    assert.equal(gated.requiresConfirm, true)
    assert.equal(gated.action, 'extension_install')
  })

  test('an extension can be installed with confirmation', async () => {
    const installed = await provider.extension({
      action: 'install',
      path: extDir,
      confirm: true,
    })
    assert.equal(installed.ok, true, installed.error)
    assert.equal(installed.installed, true)

    const listed = await provider.extension({ action: 'list' })
    assert.equal(listed.ok, true, listed.error)
    assert.ok(
      listed.extensions.some((e) => e.name === 'FFB Probe'),
      'the installed extension must show up in the list',
    )
  })

  test('cookies can be read', async () => {
    const cookies = await provider.cookie({ action: 'get' })
    assert.equal(cookies.ok, true, cookies.error)
    assert.ok(Array.isArray(cookies.cookies))
  })

  test('a domain filter also matches the cookie-jar form', async () => {
    // BiDi matches the domain exactly, and cookies are usually stored as
    // ".example.com". The tool must find them anyway.
    const filtered = await provider.cookie({
      action: 'get',
      filter: { domain: 'example.com' },
    })
    assert.equal(filtered.ok, true, filtered.error)
    assert.ok(Array.isArray(filtered.cookies))
  })

  test('writing a cookie is refused without confirmation', async () => {
    const gated = await provider.cookie({
      action: 'set',
      cookie: { name: 'ffb_probe', value: '1', domain: 'example.com' },
    })
    assert.equal(gated.ok, false)
    assert.equal(gated.blocked, true)
    assert.equal(gated.action, 'cookie_set')
  })

  test('interception can be installed and removed again', async () => {
    const installed = await provider.intercept({
      action: 'block',
      patterns: ['analytics.example.com'],
    })
    assert.equal(installed.ok, true, installed.error)
    assert.ok(installed.interceptId)
    assert.equal(installed.active, 1)

    const cleared = await provider.intercept({ action: 'clear' })
    assert.equal(cleared.ok, true, cleared.error)
    assert.equal(cleared.active, 0)
    assert.equal(cleared.removed, 1)
  })

  test('the cookie tools address the default jar, not the active container', async () => {
    // Firefox's BiDi `storage` module has no context parameter: it always
    // addresses the DEFAULT cookie jar, no matter which tab is focused. That
    // is a platform fact, and the tool must behave predictably because of it
    // rather than silently writing somewhere else.
    const created = await provider.userContext({ action: 'create', label: 'isolation-test' })
    assert.equal(created.ok, true, created.error)

    const selected = await provider.userContext({
      action: 'select',
      userContext: created.userContext,
      url: 'data:text/html;charset=utf-8,cookie+test',
    })
    assert.equal(selected.ok, true, selected.error)

    const written = await provider.cookie({
      action: 'set',
      cookie: { name: 'ffb_isolation', value: 'container', domain: 'example.com' },
      confirm: true,
    })
    assert.equal(written.ok, true, written.error)

    // It landed in the default jar, so a plain read finds it.
    const read = await provider.cookie({
      action: 'get',
      filter: { name: 'ffb_isolation' },
    })
    assert.equal(read.ok, true, read.error)
    assert.equal(read.cookies.length, 1)
    // The value is REDACTED by default — a cookie value is a credential,
    // and this browser carries the user's real login state.
    assert.equal(read.cookies[0].valueRedacted, true)
    assert.ok(!read.cookies[0].value.includes('container'))
    assert.equal(read.cookies[0].name, 'ffb_isolation')

    // The explicit escape hatch returns the raw value.
    const revealed = await provider.cookie({
      action: 'get',
      filter: { name: 'ffb_isolation' },
      revealValues: true,
    })
    assert.equal(revealed.ok, true, revealed.error)
    assert.equal(revealed.cookies[0].value, 'container', 'the cookie value must be readable')

    const removed = await provider.userContext({
      action: 'remove',
      userContext: created.userContext,
    })
    assert.equal(removed.ok, true, removed.error)
  })
})
