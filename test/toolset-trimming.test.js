// test/toolset-trimming.test.js
// The tool catalogue is trimmed to the active preset.
//
// WHY THIS MATTERS: every tool definition is injected into the model's
// context on every turn. The full catalogue costs about 33KB of prompt
// before the agent has read a single page. Trimming it is the single
// biggest saving available.
//
// TWO THINGS MUST HOLD
//
//   1. `browser_config` is always reachable. It is the only way back to a
//      wider preset, so a preset that dropped it would strand the agent.
//   2. The order of the retained tools never changes. The host injects the
//      catalogue as a prompt-cache prefix, so a reorder would invalidate
//      the cache for everything after the first move.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { presetTools } from '../lib/firefox/provider/workflow.js'
import { TOOL_ORDER } from '../lib/mcp/tools/index.js'

describe('toolset trimming', () => {
  test('browser_config is always reachable', () => {
    for (const preset of ['slim', 'basic', 'developer', 'all']) {
      assert.ok(
        presetTools(preset).includes('browser_config'),
        `browser_config must survive the ${preset} preset`,
      )
    }
  })

  test('the all preset keeps every tool', () => {
    assert.equal(presetTools('all').length, 38)
  })

  test('the slim preset is smaller than the basic one', () => {
    assert.ok(presetTools('slim').length < presetTools('basic').length)
  })

  test('the basic preset is smaller than the all one', () => {
    assert.ok(presetTools('basic').length < presetTools('all').length)
  })

  test('the order of the retained tools is preserved', () => {
    const all = presetTools('all')
    const basic = presetTools('basic')
    const filtered = all.filter((n) => basic.includes(n))
    assert.deepEqual(basic, filtered, 'the basic preset must preserve the original order')
  })
})

describe('the preset catalogue stays in step with the real one', () => {
  // This list drifted once already: the "all" preset silently dropped six
  // tools, so an agent that asked for everything got a subset and never
  // found out. The guard is cheaper than a second copy nobody checks.
  test('the all preset is exactly the tool order', () => {
    assert.deepEqual(presetTools('all'), TOOL_ORDER)
  })

  test('no preset invents a tool that does not exist', () => {
    const known = new Set(TOOL_ORDER)
    for (const preset of ['slim', 'basic', 'developer', 'all']) {
      for (const name of presetTools(preset)) {
        assert.ok(known.has(name), `the ${preset} preset lists an unknown tool: ${name}`)
      }
    }
  })

  test('every preset keeps the tools an ordinary task needs', () => {
    for (const preset of ['slim', 'basic', 'developer', 'all']) {
      const names = presetTools(preset)
      for (const needed of [
        'browser_start',
        'browser_navigate',
        'browser_snapshot',
        'browser_click',
      ]) {
        assert.ok(names.includes(needed), `the ${preset} preset must keep ${needed}`)
      }
    }
  })
})

describe('the server tool list', () => {
  /** Start the real server over stdio and collect its replies. */
  const startServer = async () => {
    const { spawn } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const { dirname, resolve } = await import('node:path')
    const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

    const child = spawn(process.execPath, ['server.js'], {
      cwd: pluginRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const replies = new Map()
    const waitFor = (id, timeoutMs = 10000) =>
      new Promise((resolvePromise, reject) => {
        const deadline = Date.now() + timeoutMs
        const poll = () => {
          if (replies.has(id)) {
            resolvePromise(replies.get(id))
            return
          }
          if (Date.now() > deadline) {
            reject(new Error(`timeout waiting for ${id}`))
            return
          }
          setTimeout(poll, 25)
        }
        poll()
      })

    let buf = ''
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id !== undefined) replies.set(msg.id, msg)
      }
    })

    const send = (id, method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    }

    send(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    send(2, 'tools/list')

    return { child, waitFor }
  }

  test('the server exposes a filtered list per preset', async () => {
    const { child, waitFor } = await startServer()
    try {
      const reply = await waitFor(2)
      const tools = reply.result.tools
      assert.ok(tools.length > 0)
      assert.ok(tools.length < 38, 'the list must be trimmed')
      assert.ok(
        tools.some((t) => t.name === 'browser_config'),
        'browser_config must always be reachable',
      )
      // The default preset is `basic`, so the diagnostic tools are gone.
      assert.ok(
        !tools.some((t) => t.name === 'browser_captcha'),
        'the default preset must not expose the captcha tools',
      )
    } finally {
      child.kill()
    }
  })

  test('the server says it can change its tool list', async () => {
    const { child, waitFor } = await startServer()
    try {
      const reply = await waitFor(1)
      assert.equal(reply.result.capabilities.tools.listChanged, true)
    } finally {
      child.kill()
    }
  })

  test('switching the preset notifies the host and changes the list', async () => {
    const { spawn } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const { dirname, resolve } = await import('node:path')
    const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

    const child = spawn(process.execPath, ['server.js'], {
      cwd: pluginRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const notifications = []
    const replies = new Map()
    let buf = ''
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id !== undefined) replies.set(msg.id, msg)
        else if (msg.method) notifications.push(msg)
      }
    })

    const waitFor = (predicate, timeoutMs = 10000) =>
      new Promise((resolvePromise, reject) => {
        const deadline = Date.now() + timeoutMs
        const poll = () => {
          if (predicate()) {
            resolvePromise()
            return
          }
          if (Date.now() > deadline) {
            reject(new Error('timeout waiting for the server'))
            return
          }
          setTimeout(poll, 25)
        }
        poll()
      })

    const send = (id, method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    }

    try {
      send(1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      })
      send(2, 'tools/list')
      await waitFor(() => replies.has(2))
      const before = replies.get(2).result.tools.length

      // Widen the catalogue.
      send(3, 'tools/call', {
        name: 'browser_config',
        arguments: { preset: 'all' },
      })
      await waitFor(() =>
        notifications.some((n) => n.method === 'notifications/tools/list_changed'),
      )
      assert.ok(
        notifications.some((n) => n.method === 'notifications/tools/list_changed'),
        'the host must be told the list changed',
      )

      send(4, 'tools/list')
      await waitFor(() => replies.has(4))
      const after = replies.get(4).result.tools.length
      assert.ok(after > before, `the list should grow: ${before} -> ${after}`)
      assert.equal(after, 38)
    } finally {
      child.kill()
    }
  })
})
