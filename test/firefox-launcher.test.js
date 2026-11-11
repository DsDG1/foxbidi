// test/firefox-launcher.test.js
// Unit tests for Firefox discovery / launching (lib/firefox/launcher.js).
//
// Nothing here spawns a real browser: the binary probe and the port scan are
// injectable, so the tests exercise the decision logic only.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const absPath = (rel) => pathToFileURL(resolve(HERE, '..', rel)).href

const {
  firefoxBinCandidates,
  detectFirefoxBin,
  buildFirefoxArgs,
  findFreePort,
  isPortFree,
  probeBinary,
} = await import(absPath('lib/firefox/launcher.js'))

// ---------------------------------------------------------------------------
// firefoxBinCandidates
// ---------------------------------------------------------------------------

describe('launcher.firefoxBinCandidates', () => {
  test('returns linux candidates', () => {
    const list = firefoxBinCandidates('linux', '/home/u')
    assert.ok(list.includes('/usr/bin/firefox'))
    assert.ok(list.includes('/usr/bin/firefox-esr'))
    assert.ok(list.includes('/snap/bin/firefox'))
  })

  test('returns macOS candidates', () => {
    const list = firefoxBinCandidates('darwin', '/Users/u')
    assert.ok(list.some((p) => p.includes('Firefox.app')))
  })

  test('returns Windows candidates', () => {
    const list = firefoxBinCandidates('win32', 'C:\\Users\\u')
    assert.ok(list.some((p) => p.endsWith('firefox.exe')))
  })
})

// ---------------------------------------------------------------------------
// detectFirefoxBin
// ---------------------------------------------------------------------------

describe('launcher.detectFirefoxBin', () => {
  test('returns null when the probe finds nothing', () => {
    const bin = detectFirefoxBin({ platform: 'linux', envBin: '', probe: () => false })
    assert.equal(bin, null)
  })

  test('honours an explicit env override', () => {
    const bin = detectFirefoxBin({
      envBin: '/custom/firefox',
      probe: (cmd) => cmd === '/custom/firefox',
    })
    assert.equal(bin, '/custom/firefox')
  })

  test('returns null when an explicit override does not work', () => {
    // An operator-specified binary that cannot run is a hard failure, not a
    // reason to silently use a different browser.
    const bin = detectFirefoxBin({
      envBin: '/broken/firefox',
      probe: () => false,
    })
    assert.equal(bin, null)
  })

  test('finds a real binary on this machine when one exists', () => {
    // Not asserting a binary MUST exist — only that the probe is honest.
    const bin = detectFirefoxBin({ platform: process.platform, envBin: '' })
    if (bin) assert.equal(typeof bin, 'string')
    else assert.equal(bin, null)
  })
})

// ---------------------------------------------------------------------------
// probeBinary
// ---------------------------------------------------------------------------

describe('launcher.probeBinary', () => {
  test('reports false for a non-existent binary', () => {
    assert.equal(probeBinary('/definitely/not/a/binary'), false)
  })

  test('reports true for node', () => {
    assert.equal(probeBinary(process.execPath), true)
  })
})

// ---------------------------------------------------------------------------
// buildFirefoxArgs
// ---------------------------------------------------------------------------

describe('launcher.buildFirefoxArgs', () => {
  test('includes --headless by default', () => {
    const args = buildFirefoxArgs({ port: 9333, profileDir: '/tmp/p' })
    assert.ok(args.includes('--headless'))
  })

  test('omits --headless when headless is false', () => {
    const args = buildFirefoxArgs({ port: 9333, profileDir: '/tmp/p', headless: false })
    assert.equal(args.includes('--headless'), false)
  })

  test('passes the remote debugging port', () => {
    const args = buildFirefoxArgs({ port: 9444, profileDir: '/tmp/p' })
    const i = args.indexOf('--remote-debugging-port')
    assert.ok(i >= 0)
    assert.equal(args[i + 1], '9444')
  })

  test('passes the profile directory', () => {
    const args = buildFirefoxArgs({ port: 9333, profileDir: '/tmp/prof' })
    const i = args.indexOf('--profile')
    assert.ok(i >= 0)
    assert.equal(args[i + 1], '/tmp/prof')
  })

  test('opens about:blank so the remote agent starts', () => {
    const args = buildFirefoxArgs({ port: 9333, profileDir: '/tmp/p' })
    assert.ok(args.includes('about:blank'))
  })

  test('asks for system access with the flag Firefox actually reads', () => {
    // Firefox 138 shipped `--remote-enable-system-access`; the name the
    // browser has documented since — and the only one Firefox 153 honours —
    // is `--remote-allow-system-access`. Firefox 153 also made an `about:`
    // navigation REQUIRE system access, so a stale flag name is not a
    // cosmetic difference: every privileged navigation fails with "not
    // allowed in this context".
    const args = buildFirefoxArgs({ port: 9333, profileDir: '/tmp/p', privileged: true })
    assert.ok(
      args.includes('--remote-allow-system-access'),
      `expected --remote-allow-system-access, got ${args.join(' ')}`,
    )
    assert.equal(
      args.includes('--remote-enable-system-access'),
      false,
      'the pre-rename flag name must not be passed',
    )
  })

  test('does not ask for system access unless it was requested', () => {
    const args = buildFirefoxArgs({ port: 9333, profileDir: '/tmp/p' })
    assert.equal(args.includes('--remote-allow-system-access'), false)
  })
})

// ---------------------------------------------------------------------------
// port scanning
// ---------------------------------------------------------------------------

describe('launcher port helpers', () => {
  test('isPortFree reports a bound port as busy', async () => {
    const srv = net.createServer()
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const port = srv.address().port
    assert.equal(await isPortFree(port), false)
    await new Promise((r) => srv.close(r))
  })

  test('isPortFree reports a released port as free', async () => {
    const srv = net.createServer()
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const port = srv.address().port
    await new Promise((r) => srv.close(r))
    assert.equal(await isPortFree(port), true)
  })

  test('findFreePort returns the starting port when it is free', async () => {
    const port = await findFreePort(19333, 3)
    assert.ok(port >= 19333 && port < 19336)
  })

  test('findFreePort skips over an occupied port', async () => {
    const srv = net.createServer()
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const busy = srv.address().port
    const found = await findFreePort(busy, 5)
    await new Promise((r) => srv.close(r))
    assert.notEqual(found, busy, 'must not return the occupied port')
    assert.ok(found > busy)
  })

  test('findFreePort returns null when every candidate is busy', async () => {
    const srv = net.createServer()
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const busy = srv.address().port
    const found = await findFreePort(busy, 1)
    await new Promise((r) => srv.close(r))
    assert.equal(found, null)
  })
})
