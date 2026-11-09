// test/images.test.js
// Unit tests for the local image server.
//
// WHY THIS EXISTS
//
// A screenshot reaches the user in two ways:
//   - the model gets the PNG as an MCP image block (free, native);
//   - the user gets a URL the plugin serves from 127.0.0.1, so a chat client
//     that renders markdown (the webui does) can show the picture.
//
// The URL path must not leak: unknown tokens 404, the listener is loopback
// only, and stopping the server removes the files.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImageServer } from '../lib/firefox/images.js'

// 一张 1x1 的真实 PNG
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function tmp() {
  return mkdtempSync(join(tmpdir(), 'ffimg-'))
}

describe('image server', () => {
  test('publish returns a fetchable url with a real png', async () => {
    const dir = tmp()
    const server = new ImageServer({ dir })
    const { url } = await server.publish(PNG)
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/i\/[A-Za-z0-9_-]+\.png$/)
    const res = await fetch(url)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
    const body = Buffer.from(await res.arrayBuffer())
    assert.equal(body.subarray(0, 4).toString('hex'), '89504e47') // PNG magic
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  test('an unknown token is a 404 and leaks nothing', async () => {
    const dir = tmp()
    const server = new ImageServer({ dir })
    const { baseUrl } = await server.ensureStarted()
    const res = await fetch(`${baseUrl}/i/deadbeefdeadbeefdeadbeef.png`)
    assert.equal(res.status, 404)
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  test('concurrent ensureStarted starts the server only once', async () => {
    const dir = tmp()
    const server = new ImageServer({ dir })
    const [a, b, c] = await Promise.all([
      server.ensureStarted(),
      server.ensureStarted(),
      server.ensureStarted(),
    ])
    assert.equal(a.port, b.port)
    assert.equal(b.port, c.port)
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  test('an oversized image is rejected without breaking the server', async () => {
    const dir = tmp()
    const server = new ImageServer({ dir, maxBytes: 16 })
    await assert.rejects(() => server.publish(PNG))
    // 服务仍然可用
    const { url } = await server.publish(PNG.slice(0, 8))
    assert.ok(url)
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  test('stop closes the port and removes the directory', async () => {
    const dir = tmp()
    const server = new ImageServer({ dir })
    const { url } = await server.publish(PNG)
    await server.stop()
    await assert.rejects(() => fetch(url))
    assert.equal(existsSync(dir), false)
    rmSync(dir, { recursive: true, force: true })
  })
})
