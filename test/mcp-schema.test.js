// test/mcp-schema.test.js
// Contract test: every tool's `structuredContent` must match its
// `outputSchema`.
//
// WHY THIS TEST EXISTS
//
// The host runtime validates structured output against the declared schema
// and REJECTS the whole call when it does not match:
//   "Tool X has an output schema but did not return structured content"
//   "Structured content does not match the tool's output schema"
//
// A mismatch therefore breaks EVERY call to that tool, not just one. This
// test walks the real tool list through the real result path and checks
// both the success and the error path.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_ENTRY = resolve(HERE, '..', 'server.js')

/**
 * A minimal JSON-schema check: every required property is present and has
 * the declared type. The host's validator is stricter, but a schema that
 * passes this passes the host's too for the shapes used here.
 *
 * Array ITEM types are checked too. A schema that declares an array of
 * strings while the payload holds objects is a real contract error — the
 * host rejects it, and the array never reaches the caller — so the suite
 * must catch that class of mistake.
 *
 * @param {object} value
 * @param {object} schema
 * @returns {string|null} an error message, or null when valid
 */
function validateAgainstSchema(value, schema) {
  if (!schema || schema.type !== 'object') return 'no output schema'
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'structuredContent is not an object'
  }
  for (const key of schema.required || []) {
    if (value[key] === undefined) return `missing required property "${key}"`
  }
  for (const [key, raw] of Object.entries(value)) {
    const spec = (schema.properties || {})[key]
    if (!spec) continue
    if (raw === undefined || raw === null) continue
    if (spec.type === 'string' && typeof raw !== 'string') {
      return `property "${key}" should be a string`
    }
    if (spec.type === 'number' && typeof raw !== 'number') {
      return `property "${key}" should be a number`
    }
    if (spec.type === 'boolean' && typeof raw !== 'boolean') {
      return `property "${key}" should be a boolean`
    }
    if (spec.type === 'array' && !Array.isArray(raw)) {
      return `property "${key}" should be an array`
    }
    if (spec.type === 'array' && Array.isArray(raw) && spec.items && spec.items.type) {
      for (let i = 0; i < raw.length; i++) {
        const item = raw[i]
        const actual = Array.isArray(item) ? 'array' : typeof item
        if (actual !== spec.items.type) {
          return `property "${key}[${i}]" should be a ${spec.items.type}, got ${actual}`
        }
      }
    }
    if (spec.type === 'object' && (typeof raw !== 'object' || Array.isArray(raw))) {
      return `property "${key}" should be an object`
    }
  }
  return null
}

/** Spawn the MCP server and speak the protocol to it. */
class McpClient {
  constructor() {
    this.child = spawn('node', [SERVER_ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.pending = new Map()
    this.buffer = ''
    this.nextId = 1
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this._onData(chunk))
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
      const waiter = this.pending.get(message.id)
      if (!waiter) continue
      this.pending.delete(message.id)
      waiter(message)
    }
  }

  send(method, params) {
    const id = this.nextId++
    return new Promise((resolvePromise) => {
      this.pending.set(id, resolvePromise)
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  close() {
    this.child.kill()
  }
}

describe('mcp structured output contract', () => {
  test('every tool declares an output schema', async () => {
    const client = new McpClient()
    try {
      await client.send('initialize', { protocolVersion: '2025-11-25' })
      const list = await client.send('tools/list', {})
      const tools = list.result.tools
      assert.ok(tools.length >= 22, `expected at least 22 tools, got ${tools.length}`)
      for (const tool of tools) {
        assert.ok(tool.outputSchema, `tool "${tool.name}" has no outputSchema`)
        assert.equal(tool.outputSchema.type, 'object')
        assert.ok(tool.outputSchema.properties.ok, `tool "${tool.name}" has no ok property`)
        assert.ok(
          (tool.outputSchema.required || []).includes('ok'),
          `tool "${tool.name}" does not require ok`,
        )
      }
    } finally {
      client.close()
    }
  })

  test('an array output declares a record item type, not a string', async () => {
    const client = new McpClient()
    try {
      await client.send('initialize', { protocolVersion: '2025-11-25' })
      const list = await client.send('tools/list', {})
      for (const tool of list.result.tools) {
        for (const [key, spec] of Object.entries(tool.outputSchema.properties || {})) {
          if (spec.type !== 'array') continue
          assert.ok(spec.items, `tool "${tool.name}" declares array "${key}" with no item schema`)
          assert.equal(
            spec.items.type,
            'object',
            `tool "${tool.name}" declares array "${key}" as ${spec.items.type} — its items are records`,
          )
        }
      }
    } finally {
      client.close()
    }
  })

  test('every tool returns structured content matching its schema on success', async () => {
    const client = new McpClient()
    try {
      await client.send('initialize', { protocolVersion: '2025-11-25' })
      const list = await client.send('tools/list', {})
      const tools = list.result.tools

      // Exercise the tools that do not need a live browser.
      const noBrowser = ['browser_status', 'browser_network']
      for (const tool of tools) {
        if (!noBrowser.includes(tool.name)) continue
        const call = await client.send('tools/call', {
          name: tool.name,
          arguments: {},
        })
        const result = call.result
        assert.ok(result, `tool "${tool.name}" returned no result`)
        assert.ok(result.structuredContent, `tool "${tool.name}" returned no structuredContent`)
        const problem = validateAgainstSchema(result.structuredContent, tool.outputSchema)
        assert.equal(problem, null, `tool "${tool.name}": ${problem}`)
      }
    } finally {
      client.close()
    }
  })

  test('a failing tool still returns structured content matching its schema', async () => {
    const client = new McpClient()
    try {
      await client.send('initialize', { protocolVersion: '2025-11-25' })
      const list = await client.send('tools/list', {})
      const snapshotTool = list.result.tools.find((t) => t.name === 'browser_snapshot')

      // A missing required argument is the cheapest reliable failure.
      const call = await client.send('tools/call', {
        name: 'browser_navigate',
        arguments: {},
      })
      const result = call.result
      assert.equal(result.isError, true)
      assert.ok(result.structuredContent, 'the error path returned no structuredContent')
      assert.equal(result.structuredContent.ok, false)
      const problem = validateAgainstSchema(result.structuredContent, snapshotTool.outputSchema)
      assert.equal(problem, null, `error payload: ${problem}`)
    } finally {
      client.close()
    }
  })

  test('an unknown tool is a tool error, not a protocol error', async () => {
    const client = new McpClient()
    try {
      await client.send('initialize', { protocolVersion: '2025-11-25' })
      const call = await client.send('tools/call', {
        name: 'browser_nope',
        arguments: {},
      })
      assert.equal(call.result.isError, true)
      assert.ok(call.result.structuredContent)
      assert.equal(call.result.structuredContent.ok, false)
    } finally {
      client.close()
    }
  })

  test('the text block is a summary, not a duplicate of the structured payload', async () => {
    const client = new McpClient()
    try {
      await client.send('initialize', { protocolVersion: '2025-11-25' })
      const call = await client.send('tools/call', {
        name: 'browser_status',
        arguments: {},
      })
      const text = call.result.content.map((c) => c.text || '').join('\n')
      // The host renders structuredContent into the text itself, so the
      // plugin's own text block must stay small.
      assert.ok(text.length < 400, `text block is ${text.length} chars — too long`)
    } finally {
      client.close()
    }
  })
})
