// test/integration/captcha-text-block.test.js
// End-to-end test of the CAPTCHA text block through the real MCP server.
//
// The unit tests cover the renderer; this covers the WIRING — that the MCP
// server routes the captcha tools to that renderer instead of the generic
// summary. A regression there is silent: the payload stays correct, so the
// structured content still looks fine, and only the human-readable line
// degrades.
//
// The page under test needs no network: a blank page has no challenge, which
// is exactly the case that used to render as "the browser operation failed".

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..', '..')
const SERVER_ENTRY = resolve(PLUGIN_ROOT, 'server.js')

const { detectFirefoxBin } = await import(
  pathToFileURL(resolve(PLUGIN_ROOT, 'lib/firefox/launcher.js')).href
)

const firefoxBin = detectFirefoxBin()
const skip = firefoxBin
  ? false
  : 'firefox is not installed — skipping the live-browser MCP integration test'

/** A tiny MCP client over the server's stdio. */
class McpStdioClient {
  constructor(child) {
    this.child = child
    this.pending = new Map()
    this.buffer = ''
    this.nextId = 1
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this._onData(chunk))
  }

  _onData(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id === undefined || message.id === null) continue
      const waiter = this.pending.get(message.id)
      if (!waiter) continue
      this.pending.delete(message.id)
      waiter(message)
    }
  }

  send(method, params) {
    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method }
    if (params !== undefined) payload.params = params
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timed out waiting for "${method}"`))
      }, 60000)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      this.child.stdin.write(JSON.stringify(payload) + '\n')
    })
  }

  close() {
    this.child.kill('SIGTERM')
  }
}

describe('captcha text block (live MCP server)', { skip }, () => {
  let child
  let client

  before(async () => {
    child = spawn('node', [SERVER_ENTRY], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, FIREFOX_BROWSER_PORT: '9653' },
    })
    client = new McpStdioClient(child)
    await client.send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'captcha-text-test', version: '1.0.0' },
    })
  })

  after(() => {
    if (client) client.close()
  })

  test('a missing challenge is named, not swallowed', async () => {
    const res = await client.send('tools/call', {
      name: 'browser_captcha',
      arguments: { solver: 'auto', timeoutMs: 5000 },
    })

    assert.ok(res.result, 'the tool must answer with a result envelope')
    const text = res.result.content[0].text

    // The bug: the text block collapsed into the generic failure sentence.
    assert.doesNotMatch(text, /the browser operation failed/)
    assert.match(text, /not_detected/)

    // The payload itself is unchanged — only the text block was broken.
    const payload = res.result.structuredContent
    assert.equal(payload.ok, false)
    assert.equal(payload.status, 'not_detected')
    assert.match(payload.message, /No supported CAPTCHA challenge/)

    assert.ok(text.length < 200, `text block is ${text.length} chars — too long`)
  })

  test('the status tool says whether the challenge is solved', async () => {
    const res = await client.send('tools/call', {
      name: 'browser_captcha_status',
      arguments: { kind: 'turnstile' },
    })

    assert.ok(res.result, 'the tool must answer with a result envelope')
    const text = res.result.content[0].text
    assert.match(text, /not solved/)
    assert.match(text, /token 0 chars/)

    const payload = res.result.structuredContent
    assert.equal(payload.ok, true)
    assert.equal(payload.solved, false)
  })
})
