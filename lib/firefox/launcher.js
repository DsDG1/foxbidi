// lib/firefox/launcher.js
// Locate a Firefox binary, pick a free BiDi port, and start the browser.
//
// The launcher owns the PROCESS; the provider owns the SESSION. Splitting
// them keeps the "can we find firefox / can we get a port" logic testable
// without spawning anything.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import net from 'node:net'

/**
 * Candidate Firefox binaries per platform, most-preferred first.
 * The list is probed in order; the first one that exists wins.
 */
export function firefoxBinCandidates(platform = process.platform, home = null) {
  const h = home || homedir()
  if (platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files'
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    const local = process.env['LOCALAPPDATA'] || join(h, 'AppData', 'Local')
    return [
      join(local, 'Mozilla', 'Firefox', 'firefox.exe'),
      join(pf, 'Mozilla Firefox', 'firefox.exe'),
      join(pf86, 'Mozilla Firefox', 'firefox.exe'),
    ]
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Firefox.app/Contents/MacOS/firefox',
      join(h, 'Applications', 'Firefox.app', 'Contents', 'MacOS', 'firefox'),
      '/opt/homebrew/bin/firefox',
      '/usr/local/bin/firefox',
    ]
  }
  return [
    '/usr/bin/firefox',
    '/usr/bin/firefox-esr',
    '/snap/bin/firefox',
    '/usr/local/bin/firefox',
    '/opt/firefox/firefox',
    '/usr/lib/firefox/firefox',
    '/usr/lib/firefox-esr/firefox-esr',
  ]
}

/**
 * Probe a candidate binary by running `--version`.
 * A binary that cannot report a version is not usable.
 *
 * @param {string} cmd
 * @returns {boolean}
 */
export function probeBinary(cmd) {
  return readBinaryVersion(cmd) !== null
}

/**
 * Read the version of a Firefox binary.
 *
 * This matters more than it looks. Firefox's `session.status` refuses to
 * report the browser version once a session is running ("Session already
 * started"), so the BiDi session cannot be asked what it is. The binary is
 * the reliable source.
 *
 * @param {string} cmd
 * @returns {string|null} e.g. "140.11.0esr", or null when it cannot be read
 */
export function readBinaryVersion(cmd) {
  try {
    const r = spawnSync(cmd, ['--version'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000,
    })
    if (r.status !== 0 || r.error) return null
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim()
    const match = out.match(/(\d+\.\d+(?:\.\d+)?(?:[a-z0-9.+-]*)?)/i)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * Find a usable Firefox binary.
 *
 * @param {object} [opts]
 * @param {string} [opts.envBin]  explicit path (env override)
 * @param {string} [opts.platform]
 * @param {(cmd: string) => boolean} [opts.probe]  injectable probe
 * @returns {string|null} the binary path, or null when Firefox is absent
 */
export function detectFirefoxBin(opts = {}) {
  const probe = opts.probe || probeBinary
  const envBin = opts.envBin || process.env.FIREFOX_BROWSER_BIN
  if (envBin) {
    if (probe(envBin)) return envBin
    // An explicit override that does not work is a hard error, not a silent
    // fallback — the operator asked for a specific binary.
    return null
  }
  for (const cand of firefoxBinCandidates(opts.platform || process.platform)) {
    if (!existsSync(cand)) continue
    if (probe(cand)) return cand
  }
  return null
}

/**
 * Is a TCP port free on loopback?
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

/**
 * Find the first free port at or above `start`.
 *
 * @param {number} start
 * @param {number} [count]  how many ports to try
 * @returns {Promise<number|null>}
 */
export async function findFreePort(start, count = 10) {
  for (let i = 0; i < count; i++) {
    const port = start + i
    if (port > 65535) break
    if (await isPortFree(port)) return port
  }
  return null
}

/**
 * Build the Firefox argv for a BiDi-enabled launch.
 *
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.profileDir
 * @param {boolean} [opts.headless]
 * @param {boolean} [opts.privileged]  allow privileged (chrome://) contexts
 * @returns {string[]}
 */
export function buildFirefoxArgs(opts) {
  const args = []
  if (opts.headless !== false) args.push('--headless')
  args.push('--remote-debugging-port', String(opts.port))
  if (opts.profileDir) args.push('--profile', opts.profileDir)
  // Privileged access unlocks the chrome:// context — about:preferences,
  // about:addons, about:logins — which is how the plugin reads the real
  // effective preferences and the installed extension list. It is opt-in
  // because it widens what the browser exposes.
  if (opts.privileged) args.push('--remote-enable-system-access')
  // Keep the browser out of the way of automation: no first-run wizard, no
  // "restore session" prompt, no update nag.
  //
  // NOTE: `--no-remote` used to be passed here, but Firefox 140's `--help`
  // does not list it any more — it is a leftover from the pre-BiDi era and
  // buys nothing.
  args.push('about:blank')
  return args
}

/**
 * Does a profile directory still carry a Firefox lock?
 *
 * A locked profile cannot be opened by a second Firefox instance — it exits
 * with "Firefox is already running, but is not responding." This is the
 * real reason a restart fails when a previous instance was kept alive, so
 * the launcher checks it to attribute the failure correctly instead of
 * guessing "port already in use".
 *
 * @param {string} profileDir
 * @returns {boolean}
 */
export function isProfileLocked(profileDir) {
  if (!profileDir) return false
  for (const name of ['lock', '.parentlock', 'parent.lock']) {
    try {
      // lstat does NOT follow the symlink — a dangling `lock` symlink still
      // counts as a lock.
      lstatSync(join(profileDir, name))
      return true
    } catch {
      // not present
    }
  }
  return false
}

/**
 * Spawn Firefox in the background.
 *
 * The process is detached + unref'd so the plugin server can exit without
 * waiting for (or killing) the browser. The user may still be using it.
 *
 * IMPORTANT: `spawn()` reports a failure to EXECUTE (a missing binary, a
 * permission error) through the child's 'error' EVENT, not by throwing. An
 * unhandled 'error' event on a ChildProcess is an uncaught exception — it
 * would take down the whole MCP server. So the error is captured here and
 * returned to the caller instead.
 *
 * @param {object} opts
 * @param {string} opts.bin
 * @param {number} opts.port
 * @param {string} opts.profileDir
 * @param {boolean} [opts.headless]
 * @returns {Promise<{pid: number|undefined, spawnError: Error|null}>}
 */
export function spawnFirefox(opts) {
  const args = buildFirefoxArgs(opts)
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(opts.bin, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (e) {
      resolve({ pid: undefined, spawnError: e })
      return
    }

    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    child.once('error', (err) => {
      finish({ pid: child.pid, spawnError: err })
    })
    child.once('spawn', () => {
      child.unref()
      finish({ pid: child.pid, spawnError: null })
    })
  })
}

/**
 * Wait until the BiDi endpoint answers a WebSocket handshake.
 *
 * We do not use the global `WebSocket` for probing — it throws on a failed
 * handshake in ways that are awkward to await. A raw TCP connect + HTTP
 * upgrade request is enough: a 101 response means the remote agent is up.
 *
 * @param {object} opts
 * @param {number} opts.port
 * @param {number} [opts.timeoutMs]  default 30000
 * @param {number} [opts.intervalMs] default 250
 * @returns {Promise<boolean>} true when the endpoint is ready
 */
export async function waitForBiDi(opts) {
  const timeoutMs = opts.timeoutMs || 30000
  const intervalMs = opts.intervalMs || 250
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const ready = await probeBiDiPort(opts.port)
    if (ready) return true
    await delay(intervalMs)
  }
  return false
}

/**
 * Probe whether a port speaks the BiDi WebSocket handshake.
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function probeBiDiPort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {}
      resolve(v)
    }
    socket.setTimeout(2000)
    socket.on('connect', () => {
      socket.write(
        'GET /session HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    socket.on('data', (chunk) => {
      finish(/HTTP\/1\.1 101/i.test(chunk.toString('latin1')))
    })
    socket.on('error', () => finish(false))
    socket.on('timeout', () => finish(false))
    socket.on('close', () => finish(false))
  })
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
