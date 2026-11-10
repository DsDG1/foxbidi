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

  test('an expired image is a 404, exactly like an unknown token', async () => {
    // A screenshot URL travels through the model's reply, so it ends up in
    // the conversation log. The TTL bounds how long it is worth.
    //
    // The response must be indistinguishable from an unknown token — a
    // different answer would tell the caller "this existed but expired",
    // which is itself a signal about what was on the screen.
    const dir = tmp()
    const server = new ImageServer({ dir, ttlMs: 60 * 60 * 1000 })
    try {
      const { url, token } = await server.publish(PNG)
      const res = await fetch(url)
      assert.equal(res.status, 200)

      // Age the entry past its TTL.
      const entry = server._files.get(token)
      entry.expiresAt = Date.now() - 1000

      const expired = await fetch(url)
      assert.equal(expired.status, 404)
      const body = await expired.text()
      assert.equal(body, 'not found')

      const unknown = await fetch(`http://127.0.0.1:${server._port}/i/not-a-real-token.png`)
      assert.equal(unknown.status, 404)
      assert.equal(await unknown.text(), body)
    } finally {
      await server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a zero TTL means the images never expire', async () => {
    const dir = tmp()
    const server = new ImageServer({ dir, ttlMs: 0 })
    try {
      const { url, token } = await server.publish(PNG)
      // With no TTL there is no expiry to record, so the entry can never
      // expire — not even if the clock moves.
      assert.equal(server._files.get(token).expiresAt, null)
      const res = await fetch(url)
      assert.equal(res.status, 200)
    } finally {
      await server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the expired images are swept when a new one is published', async () => {
    const dir = tmp()
    const server = new ImageServer({ dir, ttlMs: 1000 })
    try {
      const first = await server.publish(PNG)
      server._files.get(first.token).expiresAt = Date.now() - 1000
      await server.publish(PNG)
      assert.equal(server._files.has(first.token), false)
    } finally {
      await server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
