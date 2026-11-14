// lib/mcp/ff-daemon.js
// Start, find and stop the plugin's long-lived server.
//
// WHY THIS EXISTS
//
// The plugin's tools normally reach the agent through the host, which injects
// them as MCP tools. When that injection does not happen — a host-side
// problem, or a client that does not speak MCP — the plugin is running
// perfectly well and still unreachable.
//
// The way out is a control socket: a unix socket in the plugin's data
// directory that speaks the same JSON-RPC to the SAME provider, so the caller
// drives the very same Firefox and the very same tabs.
//
// But a socket needs a server on the other end, and that server needs to
// SURVIVE the shell that started it. Three things break that in practice,
// and all three were hit for real:
//
//   1. `VAR=1 cmd | node cmd` — the variable applies to the LEFT side of the
//      pipe only, so the server never sees it.
//   2. A task runner that signals the whole PROCESS GROUP kills the server
//      the moment the foreground command returns.
//   3. A server whose stdin is /dev/null (or a closed pipe) shuts itself
//      down — the stdio transport treats EOF as "the client is gone".
//
// So the daemon has to be spawned DETACHED, with no stdin at all, and with
// the environment set on the child rather than on a shell pipeline. That is
// this module's whole job. The caller should never have to know any of it.

import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { defaultCopyBase } from '../firefox/provider/helpers.js'

/** How long a lock file may live before it is considered abandoned. */
const LOCK_STALE_MS = 60000

/**
 * Where the daemon's files live.
 *
 * `defaultCopyBase()` resolves the plugin data directory from the same
 * environment the server reads (`FIREFOX_BROWSER_PROFILE_COPY`, then
 * `PLUGIN_DATA`), so both sides land on the same path.
 *
 * @returns {{base: string, socket: string, pid: string, lock: string, log: string}}
 */
export function daemonPaths() {
  const base = defaultCopyBase()
  const socket = join(base, 'control.sock')
  return {
    base,
    socket,
    pid: `${socket}.pid`,
    lock: `${socket}.lock`,
    log: join(base, 'server.log'),
  }
}

/**
 * Read the pid the last daemon wrote.
 *
 * The pidfile is a FALLBACK: it can name a process that has already died, or
 * a pid that the operating system has handed to something else. Callers must
 * treat it as a hint, never as proof.
 *
 * @param {string} path
 * @returns {number|null}
 */
export function readPid(path) {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * Is a process alive?
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM means the process exists but belongs to someone else.
    return e && e.code === 'EPERM'
  }
}

/**
 * Send one JSON-RPC request over a unix socket.
 *
 * @param {string} path
 * @param {string} method
 * @param {Record<string, any>} [params]
 * @param {number} [timeoutMs]
 * @returns {Promise<Record<string, any>|null>} the reply, or null if nobody answered
 */
export function requestOverSocket(path, method, params = {}, timeoutMs = 3000) {
  return new Promise((resolvePromise) => {
    let settled = false
    let buffer = ''
    const finish = (value) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* already gone */
      }
      resolvePromise(value)
    }
    const socket = net.createConnection(path)
    const timer = setTimeout(() => finish(null), timeoutMs)
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      clearTimeout(timer)
      try {
        finish(JSON.parse(buffer.slice(0, index).trim()))
      } catch {
        finish(null)
      }
    })
    socket.on('error', () => {
      clearTimeout(timer)
      finish(null)
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`)
    })
  })
}

/**
 * Is a server listening on that socket RIGHT NOW?
 *
 * A socket file can outlive the process that made it — a crashed server
 * leaves the file behind — so the file's existence proves nothing. This asks
 * the socket itself.
 *
 * @param {string} path
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function isSocketLive(path, timeoutMs = 2000) {
  if (!existsSync(path)) return false
  const reply = await requestOverSocket(path, 'initialize', {}, timeoutMs)
  return !!(reply && reply.result)
}

/**
 * Wait until the socket answers, or give up.
 *
 * @param {string} path
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export async function waitForSocket(path, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isSocketLive(path, 1000)) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

/**
 * Take the start lock, or report that someone else is starting a daemon.
 *
 * The lock is a file created with O_EXCL. It is released as soon as the
 * daemon is up — the server's own liveness probe is the real guard, the
 * lock only narrows the window where two processes both spawn.
 *
 * @param {string} path
 * @returns {{held: boolean, reason: string}}
 */
function takeLock(path) {
  let fd = null
  try {
    fd = openSync(path, 'wx')
    writeFileSync(fd, `${process.pid}\n`)
    return { held: true, reason: 'ok' }
  } catch (e) {
    if (!e || e.code !== 'EEXIST') return { held: false, reason: 'lock failed' }
    // A lock older than a minute belongs to a process that died.
    try {
      const age = Date.now() - statSync(path).mtimeMs
      if (age > LOCK_STALE_MS) {
        rmSync(path, { force: true })
        return takeLock(path)
      }
    } catch {
      /* the lock vanished under us — try again */
    }
    return { held: false, reason: 'another process is starting the daemon' }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Release the start lock.
 *
 * @param {string} path
 */
function releaseLock(path) {
  try {
    rmSync(path, { force: true })
  } catch {
    /* best effort */
  }
}

/**
 * Start the daemon.
 *
 * The child is detached and has NO stdin: the stdio transport must not be
 * in the picture, because EOF on stdin means "shut down" to the server. Its
 * stdout and stderr go to a log file in the plugin data directory, so a
 * failed start can still be read.
 *
 * @param {object} [opts]
 * @param {string} [opts.pluginRoot] the plugin directory (holds server.js)
 * @param {Record<string, any>} [opts.env] the environment for the child
 * @param {number} [opts.timeoutMs] how long to wait for the socket
 * @returns {Promise<Record<string, any>>} a report: {ok, socket, pid, log, alreadyRunning}
 */
export async function startDaemon(opts = {}) {
  const paths = daemonPaths()
  const env = opts.env || process.env
  const timeoutMs = opts.timeoutMs || 20000

  if (await isSocketLive(paths.socket)) {
    return {
      ok: true,
      alreadyRunning: true,
      socket: paths.socket,
      pid: readPid(paths.pid),
      log: paths.log,
    }
  }

  try {
    mkdirSync(paths.base, { recursive: true, mode: 0o700 })
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }

  const lock = takeLock(paths.lock)
  if (!lock.held) {
    // Someone else is starting it. Wait for their daemon to show up rather
    // than racing them.
    const live = await waitForSocket(paths.socket, timeoutMs)
    return live
      ? {
          ok: true,
          alreadyRunning: true,
          socket: paths.socket,
          pid: readPid(paths.pid),
          log: paths.log,
        }
      : { ok: false, error: lock.reason }
  }

  let child
  let logFd = null
  try {
    logFd = openSync(paths.log, 'a')
    child = spawn(process.execPath, [join(opts.pluginRoot, 'server.js')], {
      cwd: opts.pluginRoot,
      env: {
        ...env,
        // The daemon has no stdin, so the control socket is its only
        // transport — it is implied, not optional.
        FIREFOX_BROWSER_DAEMON: '1',
        FIREFOX_BROWSER_CONTROL_SOCKET: '1',
      },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
    child.unref()
  } catch (e) {
    releaseLock(paths.lock)
    return { ok: false, error: e && e.message ? e.message : String(e) }
  } finally {
    if (logFd !== null) {
      try {
        closeSync(logFd)
      } catch {
        /* ignore */
      }
    }
  }

  const live = await waitForSocket(paths.socket, timeoutMs)
  releaseLock(paths.lock)

  if (!live) {
    try {
      process.kill(child.pid, 'SIGTERM')
    } catch {
      /* it may already be gone */
    }
    return {
      ok: false,
      error: `the daemon did not open its socket within ${timeoutMs}ms — see ${paths.log}`,
      log: paths.log,
    }
  }

  // The pid file is a hint for `--stop`, written atomically so a reader
  // never sees half a pid.
  try {
    const tmp = `${paths.pid}.tmp`
    writeFileSync(tmp, `${child.pid}\n`)
    renameSync(tmp, paths.pid)
  } catch {
    /* the socket is the real handle; the pid file is a convenience */
  }

  return { ok: true, socket: paths.socket, pid: child.pid, log: paths.log }
}

/**
 * Stop the daemon.
 *
 * The socket is asked first: a `shutdown` request runs the server's own
 * cleanup (close the socket, stop the browser, remove the socket file). The
 * pid file is only a fallback, because a pid can be stale.
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<Record<string, any>>} a report: {ok, stopped, pid}
 */
export async function stopDaemon(opts = {}) {
  const paths = daemonPaths()
  const timeoutMs = opts.timeoutMs || 5000

  if (await isSocketLive(paths.socket)) {
    // Fire the request; the server may close the socket before replying.
    requestOverSocket(paths.socket, 'shutdown', {}, 1500).catch(() => null)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!existsSync(paths.socket)) {
        rmSync(paths.pid, { force: true })
        return { ok: true, stopped: true }
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  const pid = readPid(paths.pid)
  if (pid && isAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch (e) {
      return { ok: false, stopped: false, pid, error: e && e.message ? e.message : String(e) }
    }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!isAlive(pid)) {
        rmSync(paths.pid, { force: true })
        rmSync(paths.socket, { force: true })
        return { ok: true, stopped: true, pid }
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    return {
      ok: false,
      stopped: false,
      pid,
      error: `the daemon (pid ${pid}) did not exit — kill it yourself if it must go`,
    }
  }

  // Nothing alive is holding it. Clean up what the crash left behind.
  rmSync(paths.pid, { force: true })
  rmSync(paths.socket, { force: true })
  rmSync(paths.lock, { force: true })
  return { ok: true, stopped: false, error: 'no daemon was running' }
}

/**
 * Remove a socket file left behind by a crashed server.
 *
 * @param {string} path
 */
export function cleanupStaleSocket(path) {
  try {
    unlinkSync(path)
  } catch {
    /* there was none */
  }
}
