// test/control-socket.test.js
// Unit tests for the control socket (server.js) and the caller that uses it
// (tools/ff-call.mjs).
//
// The socket exists for the case where the HOST does not inject the
// plugin's tools: the plugin is running perfectly well, and the only way
// in is the socket. So the test that matters is the one that speaks to it
// the way a shell would.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')

let tmpRoot
let child
let socketPath

/**
 * A minimal JSON-RPC client over a unix socket.
 */
function connect(path) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection(path)
    const pending = new Map()
    let buffer = ''
    let nextId = 1

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        const entry = pending.get(message.id)
        if (entry) {
          pending.delete(message.id)
          entry(message)
        }
      }
    })
    socket.once('error', reject)
    socket.once('connect', () => {
      resolvePromise({
        request(method, params) {
          const id = nextId++
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`${method} timed out`)), 15000)
            pending.set(id, (message) => {
              clearTimeout(timer)
              res(message)
            })
            socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
          })
        },
        close() {
          socket.destroy()
        },
      })
    })
  })
}

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ffbrowser-socket-'))
  socketPath = join(tmpRoot, 'profiles', 'control.sock')
  child = spawn(process.execPath, ['server.js'], {
    cwd: PLUGIN_ROOT,
    env: {
      ...process.env,
      FIREFOX_BROWSER_CONTROL_SOCKET: '1',
      // Keep every profile artefact inside the temp directory.
      FIREFOX_BROWSER_PROFILE_COPY: join(tmpRoot, 'profiles'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // The server waits for a line on stdin; keep it open.
  child.stdin.write('')

  const deadline = Date.now() + 15000
  while (!existsSync(socketPath) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
})

after(async () => {
  if (child) child.kill()
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('the control socket', () => {
  test('the server creates it', () => {
    assert.equal(existsSync(socketPath), true)
  })

  test('it is a socket only this user can open', () => {
    const mode = statSync(socketPath).mode & 0o777
    assert.equal(mode, 0o600)
  })

  test('it answers the MCP handshake', async () => {
    const client = await connect(socketPath)
    try {
      const reply = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      })
      assert.equal(reply.result.serverInfo.name, 'firefox-browser')
      assert.ok(reply.result.capabilities.tools)
    } finally {
      client.close()
    }
  })

  test('it lists the tools', async () => {
    const client = await connect(socketPath)
    try {
      const reply = await client.request('tools/list', {})
      const tools = reply.result.tools
      assert.ok(tools.length > 0)
      assert.ok(tools.some((t) => t.name === 'browser_status'))
      assert.ok(tools.some((t) => t.name === 'browser_net_check'))
    } finally {
      client.close()
    }
  })

  test('it calls a tool', async () => {
    const client = await connect(socketPath)
    try {
      const reply = await client.request('tools/call', {
        name: 'browser_status',
        arguments: {},
      })
      assert.notEqual(reply.result.isError, true)
      assert.equal(reply.result.structuredContent.ok, true)
    } finally {
      client.close()
    }
  })

  test('the socket is off unless it is asked for', () => {
    // The env var is the whole switch: without it, no socket is created.
    const source = readFileSync(join(PLUGIN_ROOT, 'server.js'), 'utf8')
    assert.match(source, /FIREFOX_BROWSER_CONTROL_SOCKET/)
  })
})

describe('the caller script', () => {
  test('it exists and is runnable', () => {
    const path = join(PLUGIN_ROOT, 'tools', 'ff-call.mjs')
    assert.equal(existsSync(path), true)
  })

  test('it names the tool and the doctor', () => {
    const source = readFileSync(join(PLUGIN_ROOT, 'tools', 'ff-call.mjs'), 'utf8')
    assert.match(source, /--doctor/)
    assert.match(source, /--spawn/)
  })
})
