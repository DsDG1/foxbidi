// test/integration/mcp-browser.test.js
// End-to-end test of the MCP tool surface against a REAL browser.
//
// Where test/integration/browser-firefox.test.js drives the provider API
// directly, this suite goes through the actual MCP protocol — spawn
// server.js, speak JSON-RPC over stdio, and call the tools the agent calls.
//
// It is skipped when Firefox is not installed.
//
// It uses a THROWAWAY profile copy in a temp directory; the user's own
// Firefox profile is never opened or modified.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { relaxNavigationPolicy } from './fixtures.js'

// These tests load their fixtures as data: URLs, which the navigation
// policy blocks by default. The policy is relaxed for the whole file — the
// tests are exercising the agent loop, not the policy.
relaxNavigationPolicy()

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

const PAGE_HTML =
  '<button id="go">Click Me</button>' +
  '<input id="q">' +
  '<div id="out">idle</div>' +
  '<script>document.getElementById("go").onclick=()=>{' +
  'document.getElementById("out").textContent="CLICKED_OK"}</script>'

describe('mcp tools (live browser)', { skip }, () => {
  let child = null
  let tmpRoot = null
  let pending = new Map()
  let nextId = 1
  let buffer = ''

  function send(method, params) {
    const id = nextId++
    const payload = { jsonrpc: '2.0', id, method }
    if (params !== undefined) payload.params = params
    const promise = new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rej(new Error(`timed out waiting for "${method}"`))
      }, 120000)
      pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer)
          res(m)
        },
      })
    })
    child.stdin.write(`${JSON.stringify(payload)}\n`)
    return promise
  }

  /**
   * Call an MCP tool and return its payload.
   *
   * `structuredContent` is preferred: it is the machine-readable payload and
   * it is present for every tool. The text block is a human/agent summary,
   * and since 2.0 it is not necessarily JSON (browser_status renders a
   * one-screen summary rather than a dump).
   */
  async function callTool(name, args = {}) {
    const res = await send('tools/call', { name, arguments: args })
    assert.ok(res.result, `tool ${name} must return a result envelope`)
    assert.equal(res.result.isError, false, `tool ${name} failed: ${res.result.content?.[0]?.text}`)
    if (res.result.structuredContent) return res.result.structuredContent
    const text = res.result.content.find((c) => c.type === 'text')
    return text ? JSON.parse(text.text) : null
  }

  before(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ffbrowser-mcp-'))
    child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: PLUGIN_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FIREFOX_BROWSER_BIN: firefoxBin,
        FIREFOX_BROWSER_HEADLESS: '1',
        // A dedicated base port: the test runner runs files in parallel, and
        // every live-browser file would otherwise race for the same port.
        FIREFOX_BROWSER_PORT: '9640',
        // A throwaway copy directory — never the user's profile.
        FIREFOX_BROWSER_PROFILE_COPY: join(tmpRoot, 'copies'),
        FIREFOX_BROWSER_READY_TIMEOUT_MS: '45000',
        FIREFOX_BROWSER_TIMEOUT_MS: '20000',
      },
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
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
        const waiter = pending.get(message.id)
        if (!waiter) continue
        pending.delete(message.id)
        waiter.resolve(message)
      }
    })

    await send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '1.0.0' },
    })
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    )
  })

  after(async () => {
    if (child) {
      const exited = new Promise((res) => child.once('exit', res))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000)
      await exited
      clearTimeout(timer)
    }
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('browser_start brings Firefox up and reports a live session', async () => {
    const payload = await callTool('browser_start')
    assert.equal(payload.ok, true)
    assert.equal(payload.reused, false)
    assert.ok(payload.port > 0, 'a BiDi port must be assigned')
    assert.ok(payload.pid > 0, 'a Firefox pid must be reported')
    assert.ok(payload.sessionId, 'a BiDi session id must be reported')
    assert.ok(payload.profile.copy, 'the profile copy location must be reported')
  })

  test('the profile copy is created with owner-only permissions', async () => {
    const payload = await callTool('browser_status')
    const copyDir = payload.profile.copy
    const { statSync } = await import('node:fs')
    const mode = statSync(copyDir).mode & 0o777
    assert.equal(mode, 0o700, `expected 0700 on the profile copy, got ${mode.toString(8)}`)
  })

  test('browser_new_tab opens a page', async () => {
    const url = 'data:text/html,' + encodeURIComponent(PAGE_HTML)
    const payload = await callTool('browser_new_tab', { url })
    assert.equal(payload.ok, true)
    assert.ok(payload.contextId)
  })

  test('browser_type types into an input', async () => {
    const payload = await callTool('browser_type', { selector: '#q', text: 'hello' })
    assert.equal(payload.ok, true)
    assert.equal(payload.typed, 5)

    const value = await callTool('browser_evaluate', {
      expression: 'document.getElementById("q").value',
    })
    assert.equal(value.value, 'hello')
  })

  test('browser_click delivers a trusted click', async () => {
    const payload = await callTool('browser_click', { selector: '#go' })
    assert.equal(payload.ok, true)

    // The page's own handler must have run — a synthetic element.click()
    // would not have updated the DOM.
    const text = await callTool('browser_text')
    assert.match(String(text.value), /CLICKED_OK/)
  })

  test('browser_screenshot returns a real PNG image block', async () => {
    const res = await send('tools/call', { name: 'browser_screenshot', arguments: {} })
    assert.equal(res.result.isError, false)

    const image = res.result.content.find((c) => c.type === 'image')
    assert.ok(image, 'screenshot must return an image content block')
    assert.equal(image.mimeType, 'image/png')
    assert.ok(image.data.length > 1000, 'screenshot should carry real image data')
    // A PNG starts with the 8-byte signature, base64-encoded.
    assert.match(image.data.slice(0, 16), /^iVBORw0KGgo/)

    // The accompanying text block must not repeat the whole blob.
    const text = res.result.content.find((c) => c.type === 'text')
    assert.ok(text, 'screenshot must also return a text summary')
    assert.ok(!text.text.includes(image.data), 'the text summary must not inline the image data')
    assert.match(text.text, /"ok": true/)
  })

  test('the screenshot result exposes an image url in its text and structured output', async () => {
    const res = await send('tools/call', { name: 'browser_screenshot', arguments: {} })
    assert.equal(res.result.isError, false)
    const text = res.result.content.find((c) => c.type === 'text')
    const payload = JSON.parse(text.text)
    assert.ok(payload.imageUrl, 'the text block must carry the image url')
    assert.equal(res.result.structuredContent.imageUrl, payload.imageUrl)
    // 图片本体走 MCP image 块，文本块里绝不能出现 base64。
    assert.ok(!text.text.includes('data:image'))
    assert.ok(res.result.content.some((c) => c.type === 'image'))

    // The URL must actually serve the picture.
    const img = await fetch(payload.imageUrl)
    assert.equal(img.status, 200)
    assert.equal(img.headers.get('content-type'), 'image/png')
    const body = Buffer.from(await img.arrayBuffer())
    assert.equal(body.subarray(0, 4).toString('hex'), '89504e47')
  })

  test('browser_logs returns the buffered console output', async () => {
    const payload = await callTool('browser_logs', { limit: 10 })
    assert.equal(payload.ok, true)
    assert.equal(typeof payload.count, 'number')
  })

  test('browser_navigate advertises the wait strategies Firefox accepts', async () => {
    const list = await send('tools/list', {})
    const tool = list.result.tools.find((t) => t.name === 'browser_navigate')
    assert.ok(tool, 'browser_navigate must be listed')
    const wait = tool.inputSchema.properties.wait
    assert.deepEqual(
      [...wait.enum].sort(),
      ['complete', 'interactive', 'none'],
      'the wait enum must name the values Firefox actually accepts',
    )
    assert.ok(!wait.enum.includes('load'), 'Firefox rejects "load"')
  })

  test('browser_navigate accepts the interactive wait strategy', async () => {
    const url = 'data:text/html,' + encodeURIComponent(PAGE_HTML)
    const res = await send('tools/call', {
      name: 'browser_navigate',
      arguments: { url, wait: 'interactive' },
    })
    assert.equal(res.result.isError, false, res.result.content?.[0]?.text)
  })

  test('browser_snapshot surfaces the element list the agent acts on', async () => {
    const res = await send('tools/call', { name: 'browser_snapshot', arguments: {} })
    assert.equal(res.result.isError, false)
    const text = res.result.content.find((c) => c.type === 'text')?.text || ''

    // The text block must carry the elements, not just a count: an agent
    // cannot act on a number.
    assert.match(text, /e\d+\s+button/, 'the text block must show the element refs')
    assert.match(text, /Click Me/, 'the text block must show the element names')

    // And the structured payload must hold the full records.
    const structured = res.result.structuredContent
    assert.ok(structured, 'no structuredContent')
    assert.ok(Array.isArray(structured.elements))
    assert.ok(structured.elements.length > 0, 'the element list is empty')
    const button = structured.elements.find((e) => e.role === 'button')
    assert.ok(button, 'no button in the element list')
    assert.match(button.ref, /^e\d+$/)
    assert.equal(button.name, 'Click Me')
  })

  test('the declared schema matches the snapshot payload it describes', async () => {
    const list = await send('tools/list', {})
    const tool = list.result.tools.find((t) => t.name === 'browser_snapshot')
    assert.ok(tool, 'browser_snapshot must be listed')
    const items = tool.outputSchema.properties.elements.items
    assert.equal(items.type, 'object', 'the element list is a list of records')

    const res = await send('tools/call', { name: 'browser_snapshot', arguments: {} })
    for (const el of res.result.structuredContent.elements) {
      assert.equal(typeof el, 'object')
    }
  })

  test('browser_network surfaces the captured requests', async () => {
    const res = await send('tools/call', { name: 'browser_network', arguments: { limit: 10 } })
    assert.equal(res.result.isError, false)
    const text = res.result.content.find((c) => c.type === 'text')?.text || ''

    const structured = res.result.structuredContent
    assert.ok(Array.isArray(structured.requests), 'the request list must be an array')
    assert.ok(structured.requests.length > 0, 'no requests were surfaced')
    for (const req of structured.requests) {
      assert.equal(typeof req, 'object')
      assert.ok(req.url, 'a request must carry a url')
      assert.ok(!req.url.includes('?'), `the url must carry no query string: ${req.url}`)
    }

    // The text block must show the requests too, not just a count.
    assert.match(text, /\b(GET|POST)\b/, 'the text block must show the requests')
  })

  test('browser_tabs lists the open tab', async () => {
    const payload = await callTool('browser_tabs')
    assert.equal(payload.ok, true)
    assert.ok(payload.count >= 1)
    assert.ok(payload.tabs.some((t) => t.contextId))
  })

  test('browser_stop terminates the Firefox process', async () => {
    const before = await callTool('browser_status')
    const pid = before.pid
    assert.ok(pid > 0)

    const payload = await callTool('browser_stop')
    assert.equal(payload.ok, true)
    assert.equal(payload.killed, true, 'the Firefox process must be terminated')

    // The process must really be gone.
    await new Promise((r) => setTimeout(r, 500))
    assert.throws(
      () => process.kill(pid, 0),
      /ESRCH|EPERM/,
      `firefox pid ${pid} must no longer exist`,
    )
  })

  test('the session restarts on demand after a stop', async () => {
    const payload = await callTool('browser_status')
    assert.equal(payload.state, 'idle')

    // The status must not start a browser just to answer a question, so the
    // matrix it reports is a version-based expectation, not a live probe.
    assert.equal(payload.capabilities.probed, false)
    assert.ok(payload.capabilities.features.userPrompt !== undefined)

    // A tool call must transparently bring the browser back up.
    const tabs = await callTool('browser_tabs')
    assert.equal(tabs.ok, true)

    const restarted = await callTool('browser_status')
    assert.equal(restarted.state, 'ready')
    assert.ok(restarted.pid > 0)
  })
})
