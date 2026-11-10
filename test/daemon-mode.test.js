// test/daemon-mode.test.js
// The daemon: a server that outlives the shell that started it.
//
// WHY THIS TEST EXISTS
//
// Three real things broke the fallback path, and all three came from the
// same place — the server's lifetime was tied to the caller's:
//
//   1. the server read stdin, and EOF on stdin meant "shut down";
//   2. it was started in the foreground, so the caller's exit took it down;
//   3. two servers would mean two Firefoxes, which BiDi does not allow.
//
// So the daemon has to survive a closed stdin, has to survive its parent,
// and has to refuse to take over a socket another server already owns.
// Those are the three things this file checks.
//
// The tests use a TEMPORARY data directory (FIREFOX_BROWSER_PROFILE_COPY),
// so they never touch the real plugin data — and no browser is launched:
// `browser_status` is read-only and reports on an idle Firefox.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSocketLive, requestOverSocket } from '../lib/mcp/ff-daemon.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const SERVER_ENTRY = resolve(PLUGIN_ROOT, 'server.js')
const FF_CALL = resolve(PLUGIN_ROOT, 'tools', 'ff-call.mjs')

/**
 * Wait for a condition, polling.
 *
 * @param {Function} condition
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitFor(condition, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

/**
 * Sleep.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

let dataDir
let env
let socketPath

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ffb-daemon-'))
  env = {
    ...process.env,
    FIREFOX_BROWSER_DAEMON: '1',
    FIREFOX_BROWSER_CONTROL_SOCKET: '1',
    FIREFOX_BROWSER_PROFILE_COPY: dataDir,
  }
  socketPath = join(dataDir, 'control.sock')
})

after(() => {
  try {
    execFileSync(process.execPath, [FF_CALL, '--stop'], { env, encoding: 'utf8' })
  } catch {
    /* it may already be gone */
  }
  rmSync(dataDir, { recursive: true, force: true })
})

describe('daemon mode', () => {
  test('the server survives its stdin closing', async () => {
    // THE regression. A server that reads stdin treats EOF as "the client is
    // gone" and shuts itself down — which is right for stdio and fatal for
    // a daemon, because a daemon has no client on stdin at all.
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: PLUGIN_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      const up = await waitFor(async () => existsSync(socketPath) && isSocketLive(socketPath))
      assert.ok(up, 'the daemon must open its socket')

      child.stdin.end()
      await sleep(600)

      assert.equal(child.exitCode, null, 'the daemon must survive stdin closing')
      assert.ok(await isSocketLive(socketPath), 'the socket must still answer')
    } finally {
      child.kill('SIGKILL')
    }
  })

  test('a shutdown request stops the server and removes the socket', async () => {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: PLUGIN_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      assert.ok(
        await waitFor(async () => existsSync(socketPath) && isSocketLive(socketPath)),
        'the daemon must open its socket',
      )

      await requestOverSocket(socketPath, 'shutdown', {}, 2000)

      const gone = await waitFor(() => child.exitCode !== null, 8000)
      assert.ok(gone, 'the daemon must exit after a shutdown request')
      assert.equal(existsSync(socketPath), false, 'the socket file must be removed')
    } finally {
      child.kill('SIGKILL')
    }
  })

  test('a second server does not take over a live socket', async () => {
    // Two servers would mean two Firefoxes, and the BiDi session allows
    // only one. The second server has to notice and step aside.
    const first = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: PLUGIN_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let second = null
    try {
      assert.ok(
        await waitFor(async () => existsSync(socketPath) && isSocketLive(socketPath)),
        'the first daemon must open its socket',
      )

      second = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: PLUGIN_ROOT,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const code = await new Promise((resolvePromise) => {
        second.once('exit', (value) => resolvePromise(value))
      })

      assert.equal(code, 3, 'the second server must step aside')
      assert.ok(await isSocketLive(socketPath), 'the first server keeps the socket')
      assert.equal(first.exitCode, null, 'the first server keeps running')
    } finally {
      first.kill('SIGKILL')
      if (second) second.kill('SIGKILL')
    }
  })
})

describe('ff-call --serve / --stop', () => {
  test('--serve starts a daemon and is idempotent', () => {
    const first = JSON.parse(
      execFileSync(process.execPath, [FF_CALL, '--serve'], { env, encoding: 'utf8' }),
    )
    assert.equal(first.ok, true)
    assert.ok(first.socket, 'the report names the socket')
    assert.ok(first.pid, 'the report names the pid')

    const second = JSON.parse(
      execFileSync(process.execPath, [FF_CALL, '--serve'], { env, encoding: 'utf8' }),
    )
    assert.equal(second.ok, true)
    assert.equal(second.alreadyRunning, true, 'the second --serve must not start a second daemon')
    assert.equal(second.pid, first.pid, 'it must be the same daemon')
  })

  test('--stop ends the daemon and leaves nothing behind', () => {
    const report = JSON.parse(
      execFileSync(process.execPath, [FF_CALL, '--stop'], { env, encoding: 'utf8' }),
    )
    assert.equal(report.ok, true)
    assert.equal(report.stopped, true)
    assert.equal(existsSync(socketPath), false, 'the socket file must be gone')
  })
})

describe('ff-call without a server', () => {
  test('a call starts the daemon on its own', () => {
    // The zero-setup path: no --serve, no --spawn, no environment. The
    // call must work anyway, and the daemon must outlive the call.
    const out = execFileSync(process.execPath, [FF_CALL, 'browser_status', '{}'], {
      env: { ...env, FIREFOX_BROWSER_DAEMON: '', FIREFOX_BROWSER_CONTROL_SOCKET: '' },
      encoding: 'utf8',
    })
    const payload = JSON.parse(out)
    assert.equal(payload.ok, true)
    assert.equal(payload.state, 'idle', 'the status must not start a browser')
    assert.ok(existsSync(socketPath), 'the daemon must be running afterwards')
  })

  test('two calls share one server', () => {
    const call = () =>
      JSON.parse(
        execFileSync(process.execPath, [FF_CALL, 'browser_status', '{}'], {
          env: { ...env, FIREFOX_BROWSER_DAEMON: '', FIREFOX_BROWSER_CONTROL_SOCKET: '' },
          encoding: 'utf8',
        }),
      )
    const first = call()
    const second = call()
    assert.ok(
      second.uptimeMs >= first.uptimeMs,
      `the second call must reach the same server (${first.uptimeMs} -> ${second.uptimeMs})`,
    )
  })

  test('--no-autostart refuses instead of starting anything', () => {
    // Stop the daemon the previous test started, so there is genuinely
    // nothing to talk to.
    execFileSync(process.execPath, [FF_CALL, '--stop'], { env, encoding: 'utf8' })
    assert.equal(existsSync(socketPath), false, 'there must be no server to talk to')

    let failed = false
    try {
      execFileSync(process.execPath, [FF_CALL, '--no-autostart', 'browser_status', '{}'], {
        env: { ...env, FIREFOX_BROWSER_DAEMON: '', FIREFOX_BROWSER_CONTROL_SOCKET: '' },
        encoding: 'utf8',
        stdio: 'pipe',
      })
    } catch (e) {
      failed = true
      assert.equal(e.status, 1, `expected exit code 1, got ${e.status}`)
      assert.match(String(e.stderr), /--serve|no server is running/i)
    }
    assert.ok(failed, 'the call must fail without a server')
    assert.equal(existsSync(socketPath), false, 'the refused call must not start anything')
  })
})
