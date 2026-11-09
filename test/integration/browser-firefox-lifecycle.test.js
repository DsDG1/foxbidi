// test/integration/browser-firefox-lifecycle.test.js
// End-to-end tests of the provider's lifecycle semantics against a REAL
// browser — specifically the two defects this refactor fixed:
//
//   1. concurrent `start()` used to hard-fail the second caller with
//      "firefox provider is already starting";
//   2. `stop({keep:true})` followed by `start()` used to fail, and the
//      error blamed a port conflict when the real cause was the profile
//      copy still being locked by the retained instance.
//
// Both are AI-visible: a model firing two tools in parallel, or re-opening
// a browser it deliberately left running.
//
// The suite is OPTIONAL — it skips when Firefox is not installed.

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
  : 'firefox is not installed — skipping the live-browser lifecycle test'

describe('provider lifecycle (live browser)', { skip }, () => {
  let tmpRoot

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ffbrowser-life-'))
  })

  after(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  function makeProvider() {
    return new FirefoxProvider({
      bin: firefoxBin,
      headless: true,
      // A dedicated base port: the test runner runs files in parallel, and
      // every live-browser file would otherwise race for the same port.
      port: 9630,
      copyBaseDir: join(tmpRoot, `copies-${Math.random().toString(36).slice(2)}`),
      timeoutMs: 20000,
      readyTimeoutMs: 45000,
    })
  }

  test('concurrent start() calls share one instance', async () => {
    const provider = makeProvider()
    try {
      const [a, b] = await Promise.all([provider.start(), provider.start()])
      assert.equal(a.ok, true, a.error)
      assert.equal(b.ok, true, b.error)
      assert.equal(a.pid, b.pid, 'the two callers got different instances')
      assert.equal(provider.state, 'ready')
    } finally {
      await provider.stop()
    }
  })

  test('a concurrent start() does not report "already starting"', async () => {
    const provider = makeProvider()
    try {
      const results = await Promise.all([provider.start(), provider.start(), provider.start()])
      for (const result of results) {
        assert.equal(result.ok, true, result.error)
        assert.ok(
          !String(result.error || '').includes('already starting'),
          'a concurrent start reported a start conflict',
        )
      }
    } finally {
      await provider.stop()
    }
  })

  test('stop({keep:true}) then start() re-adopts the retained instance', async () => {
    const provider = makeProvider()
    try {
      const first = await provider.start()
      assert.equal(first.ok, true, first.error)

      const stopped = await provider.stop({ kill: false })
      assert.equal(stopped.ok, true)
      assert.equal(stopped.killed, false)

      // The old Firefox is still running and still owns the profile copy.
      let alive = true
      try {
        process.kill(first.pid, 0)
      } catch {
        alive = false
      }
      assert.equal(alive, true, 'the retained instance was killed')

      const second = await provider.start()
      assert.equal(second.ok, true, second.error)
      assert.equal(second.pid, first.pid, 'a NEW instance was started instead of re-adopting')
      assert.equal(second.port, first.port)
      assert.equal(second.adopted, true)

      // The re-adopted instance is fully usable.
      const tabs = await provider.listTabs()
      assert.ok(tabs.length > 0)

      await provider.stop()
    } finally {
      await provider.stop()
    }
  })

  test('a re-adopted instance keeps its profile copy (login state survives)', async () => {
    const provider = makeProvider()
    try {
      const first = await provider.start()
      const copyDir = provider.copyDir
      await provider.stop({ kill: false })
      const second = await provider.start()
      assert.equal(second.ok, true, second.error)
      assert.equal(provider.copyDir, copyDir, 'the profile copy was rebuilt')
      await provider.stop()
    } finally {
      await provider.stop()
    }
  })

  test('stop() without keep terminates the browser', async () => {
    const provider = makeProvider()
    const started = await provider.start()
    assert.equal(started.ok, true, started.error)

    const stopped = await provider.stop()
    assert.equal(stopped.ok, true)
    assert.equal(stopped.killed, true)

    let alive = true
    try {
      process.kill(started.pid, 0)
    } catch {
      alive = false
    }
    assert.equal(alive, false, 'the browser process survived stop()')
  })

  test('the browser restarts on demand after a stop', async () => {
    const provider = makeProvider()
    try {
      const first = await provider.start()
      await provider.stop()
      const second = await provider.start()
      assert.equal(second.ok, true, second.error)
      assert.notEqual(second.pid, first.pid, 'the same process was reported')
      await provider.stop()
    } finally {
      await provider.stop()
    }
  })

  test('a failed start reports an actionable error', async () => {
    const provider = new FirefoxProvider({
      bin: '/nonexistent/firefox-binary',
      headless: true,
      copyBaseDir: join(tmpRoot, 'copies-bad'),
      timeoutMs: 5000,
      readyTimeoutMs: 5000,
    })
    const result = await provider.start()
    assert.equal(result.ok, false)
    assert.ok(result.error)
  })

  test('status reports the instance state', async () => {
    const provider = makeProvider()
    try {
      await provider.start()
      const status = provider.status()
      assert.equal(status.ok, true)
      assert.equal(status.state, 'ready')
      assert.equal(status.connected, true)
      assert.ok(status.port)
      assert.ok(status.pid)
      assert.ok(status.snapshotSeq >= 0)
      await provider.stop()
    } finally {
      await provider.stop()
    }
  })
})
