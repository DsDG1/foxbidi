// test/mcp-server.test.js
// End-to-end test of the MCP stdio server: spawn it as a real child process,
// speak the real protocol over stdin/stdout, and assert on the responses.
//
// The protocol is newline-delimited JSON — no `Content-Length` framing.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const SERVER_ENTRY = resolve(PLUGIN_ROOT, 'server.js')

/** A tiny MCP client over a child process' stdio. */
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
      waiter.resolve(message)
    }
  }

  send(method, params) {
    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method }
    if (params !== undefined) payload.params = params
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timed out waiting for "${method}"`))
      }, 15000)
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
      })
    })
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
    return promise
  }

  notify(method, params) {
    const payload = { jsonrpc: '2.0', method }
    if (params !== undefined) payload.params = params
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
  }
}

describe('mcp stdio server', () => {
  let child = null
  let client = null

  before(async () => {
    child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: PLUGIN_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    client = new McpStdioClient(child)

    const init = await client.send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    })
    assert.ok(init.result, 'initialize must return a result')
    client.notify('notifications/initialized')
  })

  after(async () => {
    if (!child) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(timer)
  })

  test('initialize reports a supported protocol version and server info', async () => {
    const init = await client.send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    })
    assert.equal(init.jsonrpc, '2.0')
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.equal(init.result.serverInfo.name, 'firefox-browser')
    assert.ok(init.result.capabilities.tools, 'must advertise tool capability')
  })

  test('the reported version matches the published package version', async () => {
    const pkg = JSON.parse(readFileSync(resolve(PLUGIN_ROOT, 'package.json'), 'utf8'))
    const manifest = JSON.parse(
      readFileSync(resolve(PLUGIN_ROOT, '.minimax-plugin', 'plugin.json'), 'utf8'),
    )
    const init = await client.send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    })
    assert.equal(init.result.serverInfo.version, pkg.version)
    assert.equal(manifest.version, pkg.version)
    // A `browser.use` binding here would collide with the browser-control
    // plugin and make the host's in-app browser disappear.
    assert.equal(manifest.hostBindings, undefined)
  })

  test('initialize falls back to the latest version for unknown ones', async () => {
    const init = await client.send('initialize', {
      protocolVersion: '1999-01-01',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    })
    assert.equal(init.result.protocolVersion, '2025-11-25')
  })

  test('tools/list exposes the full browser tool set', async () => {
    const res = await client.send('tools/list')
    assert.ok(res.result, 'tools/list must return a result')
    const names = res.result.tools.map((t) => t.name)
    assert.equal(new Set(names).size, names.length, 'tool names must be unique')

    // The original twelve tools must all survive — existing callers depend
    // on their names and their arguments.
    for (const original of [
      'browser_click',
      'browser_evaluate',
      'browser_logs',
      'browser_navigate',
      'browser_new_tab',
      'browser_screenshot',
      'browser_start',
      'browser_status',
      'browser_stop',
      'browser_tabs',
      'browser_text',
      'browser_type',
    ]) {
      assert.ok(names.includes(original), `the original tool ${original} disappeared`)
    }

    // The tools added in 1.1.0 for the agent-facing loop.
    for (const added of [
      'browser_check',
      'browser_close_tab',
      'browser_handoff',
      'browser_hover',
      'browser_network',
      'browser_press_key',
      'browser_scroll',
      'browser_select_option',
      'browser_snapshot',
      'browser_upload',
      'browser_wait_for',
    ]) {
      assert.ok(names.includes(added), `the tool ${added} is missing`)
    }
  })

  test('the handoff tool declares the surface it targets', async () => {
    const res = await client.send('tools/list')
    const byName = new Map(res.result.tools.map((t) => [t.name, t]))
    const handoff = byName.get('browser_handoff')
    assert.ok(handoff, 'browser_handoff must be exposed')
    assert.deepEqual(handoff.inputSchema.required, ['to'])
    assert.deepEqual(handoff.inputSchema.properties.to.enum, ['in-app', 'firefox'])
    assert.ok(handoff.inputSchema.properties.url, 'the handoff needs a url property')
  })

  test('every tool carries a description and a JSON Schema', async () => {
    const res = await client.send('tools/list')
    for (const tool of res.result.tools) {
      assert.ok(tool.description, `${tool.name} must have a description`)
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} schema`)
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} schema`)
      assert.ok(tool.inputSchema.properties, `${tool.name} schema properties`)
    }
  })

  test('required arguments are declared in the schema', async () => {
    const res = await client.send('tools/list')
    const byName = new Map(res.result.tools.map((t) => [t.name, t]))
    // `browser_click` targets an element by `ref` OR by `selector`, so
    // neither can appear in `required` — JSON Schema has no one-of in that
    // array. The one-of rule is enforced server-side and reported as a
    // missing argument (see the next test).
    assert.equal(byName.get('browser_click').inputSchema.required, undefined)
    // `browser_type` still requires the text to type; only its target
    // became optional.
    assert.deepEqual(byName.get('browser_type').inputSchema.required, ['text'])
    assert.deepEqual(byName.get('browser_navigate').inputSchema.required, ['url'])
    assert.deepEqual(byName.get('browser_evaluate').inputSchema.required, ['expression'])
    assert.equal(byName.get('browser_status').inputSchema.required, undefined)
  })

  test('tools/call returns a valid JSON-RPC result', async () => {
    const res = await client.send('tools/call', {
      name: 'browser_status',
      arguments: {},
    })
    assert.ok(res.result, 'tools/call must return a result')
    assert.equal(res.result.isError, false)
    assert.equal(res.result.content.length, 1)
    assert.equal(res.result.content[0].type, 'text')
    // Since 2.0 the status text is a one-screen summary and the payload
    // travels in structuredContent — the status grew a capability matrix,
    // and dumping it as text would cost tokens on every call.
    const payload = res.result.structuredContent
    assert.equal(payload.ok, true)
    assert.ok(payload.state, 'status must report a lifecycle state')
    assert.match(res.result.content[0].text, /state /)
  })

  test('an unknown tool is reported as a tool error, not a protocol error', async () => {
    const res = await client.send('tools/call', {
      name: 'browser_nonexistent',
      arguments: {},
    })
    assert.ok(res.result, 'must still answer with a result envelope')
    assert.equal(res.result.isError, true)
    assert.match(res.result.content[0].text, /unknown tool/i)
  })

  test('a failure that never reached the provider still carries a code', async () => {
    // The error contract says every failure has a machine-readable code.
    // The three paths that fail BEFORE the provider runs are part of that
    // contract, not an exception to it.
    const unknown = await client.send('tools/call', {
      name: 'browser_nonexistent',
      arguments: {},
    })
    assert.equal(unknown.result.structuredContent.code, 'unknown_tool')
    // The human-readable text is unchanged.
    assert.match(unknown.result.structuredContent.error, /unknown tool/i)

    const invalid = await client.send('tools/call', {
      name: 'browser_click',
      arguments: {},
    })
    assert.equal(invalid.result.structuredContent.code, 'invalid_argument')
    assert.match(invalid.result.structuredContent.error, /missing required argument/i)
  })

  test('missing required arguments are reported clearly', async () => {
    const res = await client.send('tools/call', {
      name: 'browser_click',
      arguments: {},
    })
    assert.equal(res.result.isError, true)
    assert.match(res.result.content[0].text, /missing required argument/i)
    // The one-of rule must name both accepted forms so the agent knows
    // exactly what to pass.
    assert.match(res.result.content[0].text, /ref/)
    assert.match(res.result.content[0].text, /selector/)
  })

  test('arguments of the wrong type are rejected', async () => {
    const res = await client.send('tools/call', {
      name: 'browser_type',
      arguments: { selector: '#a', text: 42 },
    })
    assert.equal(res.result.isError, true)
    assert.match(res.result.content[0].text, /must be a string/i)
  })

  test('unknown arguments are rejected rather than ignored', async () => {
    const res = await client.send('tools/call', {
      name: 'browser_navigate',
      arguments: { url: 'https://example.com', typo: 'x' },
    })
    assert.equal(res.result.isError, true)
    assert.match(res.result.content[0].text, /unknown argument/i)
  })

  test('an unknown method returns a JSON-RPC error', async () => {
    const res = await client.send('does/not/exist')
    assert.ok(res.error, 'must return a protocol error')
    assert.equal(res.error.code, -32601)
  })

  test('ping is answered', async () => {
    const res = await client.send('ping')
    assert.ok(res.result)
    assert.deepEqual(res.result, {})
  })

  test('the server survives a sequence of calls', async () => {
    await client.send('tools/call', { name: 'browser_status', arguments: {} })
    await client.send('tools/call', { name: 'browser_status', arguments: {} })
    const res = await client.send('tools/call', { name: 'browser_status', arguments: {} })
    assert.equal(res.result.isError, false)
  })

  test('the status is trimmed by default and full on request', async () => {
    const brief = await client.send('tools/call', { name: 'browser_status', arguments: {} })
    const briefCaps = brief.result.structuredContent.capabilities
    assert.ok(briefCaps.features, 'the boolean table is always there')
    assert.ok(briefCaps.unavailable, 'the unavailable features are explained')
    assert.equal(briefCaps.featureDetails, undefined, 'the default payload is trimmed')

    const full = await client.send('tools/call', {
      name: 'browser_status',
      arguments: { detail: 'full' },
    })
    const fullCaps = full.result.structuredContent.capabilities
    assert.ok(fullCaps.featureDetails, 'the full payload keeps the provenance')
  })

  test('accepts empty string for required string arguments like select value or clear text', async () => {
    // Without a running browser (and bogus bin), passing validation reaches the provider
    // and returns `not_running` instead of `invalid_argument: missing required argument`.
    const isolated = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: PLUGIN_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FIREFOX_BROWSER_BIN: '/nonexistent/firefox' },
    })
    const isoClient = new McpStdioClient(isolated)
    try {
      await isoClient.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
      const res = await isoClient.send('tools/call', {
        name: 'browser_select_option',
        arguments: { selector: '#country', value: '' },
      })
      assert.notEqual(res.result.structuredContent.code, 'invalid_argument')
    } finally {
      isolated.kill('SIGKILL')
    }
  })

  test('immediate stdin EOF during control-socket startup probe does not throw TDZ ReferenceError', async () => {
    const quick = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: PLUGIN_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    let stderr = ''
    quick.stderr.setEncoding('utf8')
    quick.stderr.on('data', (c) => {
      stderr += c
    })
    quick.stdin.end()
    const code = await new Promise((r) => quick.once('exit', r))
    assert.equal(code, 0)
    assert.doesNotMatch(stderr, /ReferenceError/)
  })
})
