#!/usr/bin/env node
// tools/ff-call.mjs
// Call the plugin's tools without the host.
//
// WHY THIS EXISTS
//
// The plugin's tools normally reach the agent through the host, which
// injects them as MCP tools. When that injection does not happen — a
// host-side problem, or a client that does not speak MCP — the plugin is
// running perfectly well and still unreachable.
//
// This script is the way out. It speaks the same JSON-RPC the host speaks,
// to the same server, over the same provider:
//
//   ff-call.mjs browser_status '{}'          talk to the server (starting one
//                                            if none is running)
//   ff-call.mjs --serve                      start the long-lived server
//   ff-call.mjs --stop                       stop it
//   ff-call.mjs --doctor                     say what is and is not working
//
// OUTPUT
//
// By default this prints the tool's STRUCTURED payload and nothing else.
// The old format printed the reply's text block and the structured payload
// side by side, which for the legacy tools meant the same payload twice —
// a 3.7 KB page text shipped as 15 KB of output. The modes are now
// mutually exclusive: `--text` for the summary line, `--raw` for the whole
// protocol reply, `--pretty` to indent.
//
// THE SERVER
//
// A call needs a server on the other end of the socket. One is started
// automatically when none is running, DETACHED, so it survives the shell
// that started it and keeps ONE Firefox alive across calls. `--no-autostart`
// turns that off; `--serve` / `--stop` drive it by hand.

import net from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultCopyBase } from '../lib/firefox/provider/helpers.js'
import { TOOL_ORDER } from '../lib/mcp/tools/index.js'
import { formatToolResult } from '../lib/mcp/ff-output.js'
import { daemonPaths, isSocketLive, startDaemon, stopDaemon } from '../lib/mcp/ff-daemon.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')

/** Where the control socket lives, if the server was started with one. */
export function controlSocketPath() {
  return join(defaultCopyBase(), 'control.sock')
}

/**
 * A tiny JSON-RPC client over a socket or a child's stdio.
 *
 * Both transports carry newline-delimited JSON, so one client serves both.
 */
class Client {
  constructor(write, read, close) {
    this._write = write
    this._read = read
    this._close = close || (() => read.destroy())
    this._nextId = 1
    this._pending = new Map()
    this._buffer = ''

    read.on('data', (chunk) => {
      this._buffer += chunk.toString('utf8')
      let index
      while ((index = this._buffer.indexOf('\n')) !== -1) {
        const line = this._buffer.slice(0, index).trim()
        this._buffer = this._buffer.slice(index + 1)
        if (!line) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        const entry = this._pending.get(message.id)
        if (entry) {
          this._pending.delete(message.id)
          entry.resolve(message)
        }
      }
    })
  }

  /**
   * Close the transport.
   *
   * Without this the open socket keeps Node's event loop alive, so the
   * script would print its answer and then hang forever instead of exiting.
   * That is the difference between a CLI and a hang.
   */
  close() {
    for (const [id, entry] of this._pending) {
      this._pending.delete(id)
      entry.reject(new Error('connection closed'))
    }
    try {
      this._close()
    } catch {
      /* already gone */
    }
  }

  async request(method, params) {
    const id = this._nextId++
    const payload = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, 120000)
      this._pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer)
          resolve(message)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this._write(payload)
    })
  }

  notify(method, params) {
    this._write({ jsonrpc: '2.0', method, params })
  }
}

/**
 * Connect to the running server's control socket.
 *
 * @returns {Promise<Client>}
 */
function connectSocket(path) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection(path)
    socket.once('connect', () => {
      resolvePromise(new Client((payload) => socket.write(`${JSON.stringify(payload)}\n`), socket))
    })
    socket.once('error', reject)
  })
}

/**
 * Start a server and talk to it over stdio.
 *
 * This is the ONE-SHOT path: the server speaks MCP over the pipe this
 * script holds, and dies with it. It deliberately does NOT open the shared
 * control socket — that socket belongs to the long-lived server, and two
 * servers would mean two Firefoxes, which the BiDi session does not allow.
 *
 * @returns {Promise<{client: Client, child: import('node:child_process').ChildProcess}>}
 */
function spawnServer() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(PLUGIN_ROOT, 'server.js')], {
      cwd: PLUGIN_ROOT,
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    const client = new Client(
      (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`),
      child.stdout,
      () => {
        child.stdin.destroy()
        child.stdout.destroy()
      },
    )
    child.once('error', reject)
    resolvePromise({ client, child })
  })
}

/**
 * Run the MCP handshake.
 *
 * @param {Client} client
 */
async function handshake(client) {
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'ff-call', version: '1.0.0' },
  })
  client.notify('notifications/initialized', {})
}

/**
 * What the host knows about this plugin.
 *
 * The host keeps a registry of plugin MCP servers and their tool names.
 * When that registry is older than the plugin, the host injects a tool list
 * that no longer matches the code — the tools are missing or stale. This
 * is the check that finds it.
 *
 * @returns {object}
 */
function hostRegistry() {
  const candidates = [
    join(process.env.HOME || '', '.minimax', 'mcp-runtime-names.json'),
    join(defaultCopyBase(), '..', '..', 'mcp-runtime-names.json'),
  ]
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue
      const data = JSON.parse(readFileSync(path, 'utf8'))
      const servers = data.servers || []
      const entry = servers.find((s) => s.raw === 'firefox-browser')
      if (!entry) return { path, found: true, registered: false }
      const registered = (entry.tools || []).map((t) => t.raw)
      const missing = TOOL_ORDER.filter((name) => !registered.includes(name))
      const unknown = registered.filter((name) => !TOOL_ORDER.includes(name))
      return {
        path,
        found: true,
        registered: true,
        tools: registered.length,
        codeTools: TOOL_ORDER.length,
        stale: missing.length > 0 || unknown.length > 0,
        missing,
        unknown,
        hasBrowserFind: registered.includes('browser_find'),
      }
    } catch {
      /* try the next candidate */
    }
  }
  return { found: false }
}

/**
 * The doctor: say what is and is not working.
 *
 * @returns {Promise<object>}
 */
async function doctor() {
  const report = { plugin: {}, host: {}, socket: {}, browser: {}, network: {} }

  const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))
  report.plugin = { version: pkg.version, root: PLUGIN_ROOT }

  report.host = hostRegistry()

  const paths = daemonPaths()
  const path = controlSocketPath()
  report.socket = { path, exists: existsSync(path), pidFile: paths.pid, log: paths.log }
  if (report.socket.exists) {
    let client = null
    try {
      client = await connectSocket(path)
      await handshake(client)
      const listed = await client.request('tools/list', {})
      report.socket.live = true
      report.socket.tools = (listed.result && listed.result.tools ? listed.result.tools : []).length
      const status = await client.request('tools/call', {
        name: 'browser_status',
        arguments: {},
      })
      const structured = status.result && status.result.structuredContent
      if (structured) {
        report.browser = {
          state: structured.state,
          pid: structured.pid,
          port: structured.port,
          browserVersion: structured.browserVersion,
        }
      }
    } catch (e) {
      report.socket.live = false
      report.socket.error = e.message
    } finally {
      if (client) client.close()
    }
  }

  // The two network facts that matter most: can the machine resolve a
  // public name, and can it open a socket to one?
  try {
    const dns = await import('node:dns/promises')
    const net = await import('node:net')
    const addresses = await dns.lookup('example.com', { all: true })
    report.network.resolved = true
    report.network.addresses = addresses.map((a) => a.address).slice(0, 3)
    const reachable = await new Promise((resolvePromise) => {
      const socket = net.connect({ host: addresses[0].address, port: 443 })
      const done = (value) => {
        socket.destroy()
        resolvePromise(value)
      }
      socket.setTimeout(5000)
      socket.once('connect', () => done(true))
      socket.once('timeout', () => done(false))
      socket.once('error', () => done(false))
    })
    report.network.tcp443 = reachable
  } catch (e) {
    report.network.resolved = false
    report.network.error = e.message
  }

  report.advice = advice(report)
  return report
}

/**
 * Turn the report into the next thing to do.
 *
 * @param {object} report
 * @returns {string}
 */
function advice(report) {
  if (!report.socket.exists) {
    return (
      'No control socket — no server is running. A call will start one for you ' +
      "(`node tools/ff-call.mjs <tool> '{}'`), or start it yourself with " +
      '`node tools/ff-call.mjs --serve`.'
    )
  }
  if (!report.socket.live) {
    return `The control socket exists but does not answer: ${report.socket.error || 'unknown error'}.`
  }
  if (report.host.stale) {
    const missing = report.host.missing.length
      ? ` The host does not know: ${report.host.missing.join(', ')}.`
      : ''
    const unknown = report.host.unknown.length
      ? ` The host knows tools this build does not: ${report.host.unknown.join(', ')}.`
      : ''
    return (
      `The host registry is STALE — it lists ${report.host.tools} tools, ` +
      `this build has ${report.host.codeTools}. The plugin is fine; the host ` +
      `is injecting an outdated tool list.${missing}${unknown} ` +
      'Restart the host (or reload the plugin) to pick up the new tools; ' +
      'until then, call them through this script.'
    )
  }
  if (report.host.found && report.host.registered) {
    return `The host registry lists ${report.host.tools} tools for this plugin, and it is current.`
  }
  return "The control socket is live. Call a tool with: ff-call.mjs <tool> '{}'"
}

/**
 * Connect to a server: the long-lived one if it is running, a fresh daemon
 * if it is not.
 *
 * The order matters. A running daemon owns the shared socket and the
 * Firefox behind it, so it is always preferred; starting a second server
 * would mean a second Firefox, and the BiDi session allows only one.
 *
 * @param {Set<string>} flags
 * @returns {Promise<{client: Client, child: object|null}>}
 */
async function connect(flags) {
  const socket = controlSocketPath()

  if (await isSocketLive(socket)) {
    return { client: await connectSocket(socket), child: null }
  }

  if (!flags.has('--no-autostart')) {
    const report = await startDaemon({ pluginRoot: PLUGIN_ROOT })
    if (!report.ok) {
      throw new Error(report.error || 'the daemon did not start')
    }
    return { client: await connectSocket(socket), child: null }
  }

  if (flags.has('--spawn')) {
    const spawned = await spawnServer()
    return { client: spawned.client, child: spawned.child }
  }

  throw new Error(
    'no server is running and autostart is off — start one with ' +
      '`node tools/ff-call.mjs --serve`, or drop --no-autostart',
  )
}

async function main() {
  const args = process.argv.slice(2)
  const flags = new Set(args.filter((a) => a.startsWith('--')))
  const rest = args.filter((a) => !a.startsWith('--'))

  if (flags.has('--doctor')) {
    console.log(JSON.stringify(await doctor(), null, 1))
    return
  }

  if (flags.has('--serve')) {
    const report = await startDaemon({ pluginRoot: PLUGIN_ROOT })
    console.log(JSON.stringify(report, null, 1))
    if (!report.ok) process.exit(1)
    return
  }

  if (flags.has('--stop')) {
    const report = await stopDaemon()
    console.log(JSON.stringify(report, null, 1))
    if (!report.ok) process.exit(1)
    return
  }

  const tool = rest[0]
  if (!tool) {
    console.error(
      'usage: ff-call.mjs [--serve] [--stop] [--doctor] [--text] [--raw] [--pretty] ' +
        '[--no-autostart] [--spawn] <tool> [json-arguments]',
    )
    process.exit(2)
  }
  const parsed = rest[1] ? JSON.parse(rest[1]) : {}

  let client
  let child = null
  try {
    const connection = await connect(flags)
    client = connection.client
    child = connection.child
  } catch (e) {
    console.error(
      `could not reach the plugin server: ${e.message}\n` +
        'Start one with `node tools/ff-call.mjs --serve`, or let a call start it for you.',
    )
    process.exit(1)
  }

  await handshake(client)
  try {
    const reply = await client.request('tools/call', { name: tool, arguments: parsed })
    const { stdout, exitCode } = formatToolResult(reply, {
      text: flags.has('--text'),
      raw: flags.has('--raw'),
      pretty: flags.has('--pretty'),
    })
    console.log(stdout)
    if (exitCode) process.exit(exitCode)
  } finally {
    client.close()
    if (child) {
      child.kill()
    }
  }
}

main().catch((e) => {
  console.error(`ff-call failed: ${e && e.message ? e.message : e}`)
  process.exit(1)
})
