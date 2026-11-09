// test/bidi-client.test.js
// Unit tests for the BiDi client (lib/bidi/client.js).
//
// The client talks to a real TCP socket, so these tests run a FAKE BiDi
// server: a local TCP listener that performs the WebSocket handshake and
// then replies with scripted frames. That exercises the real framing,
// the id→response matching, the event/response separation and the
// timeout path — without needing Firefox.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const absPath = (rel) => pathToFileURL(resolve(HERE, '..', rel)).href

const { BidiClient, BidiError, BidiTimeoutError } = await import(
  absPath('lib/bidi/client.js')
)
const { encodeTextFrame, FrameDecoder } = await import(
  absPath('lib/bidi/frame.js')
)

// ---------------------------------------------------------------------------
// Fake BiDi server
// ---------------------------------------------------------------------------

/**
 * A minimal BiDi server over TCP.
 *
 * `handler(msg, socket)` receives each decoded envelope and may reply.
 * `emitEvent(method, params)` pushes an unsolicited event frame.
 */
class FakeBiDiServer {
  constructor(handler) {
    this.handler = handler
    this.server = net.createServer((socket) => this._onConnection(socket))
    this.port = 0
    this.sockets = []
  }

  listen() {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port
        resolve(this.port)
      })
    })
  }

  close() {
    for (const s of this.sockets) {
      try {
        s.destroy()
      } catch {}
    }
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  _onConnection(socket) {
    this.sockets.push(socket)
    const decoder = new FrameDecoder()
    let handshakeDone = false
    let buffered = Buffer.alloc(0)

    socket.on('data', (chunk) => {
      if (!handshakeDone) {
        buffered = Buffer.concat([buffered, chunk])
        const idx = buffered.indexOf('\r\n\r\n')
        if (idx === -1) return
        const head = buffered.subarray(0, idx).toString('latin1')
        const keyMatch = head.match(/sec-websocket-key:\s*(\S+)/i)
        const accept = createHash('sha1')
          .update(keyMatch[1] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64')
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        )
        handshakeDone = true
        const rest = buffered.subarray(idx + 4)
        if (rest.length > 0) this._onFrames(decoder, socket, rest)
        return
      }
      this._onFrames(decoder, socket, chunk)
    })
    socket.on('error', () => {})
  }

  _onFrames(decoder, socket, chunk) {
    let messages
    try {
      messages = decoder.push(chunk)
    } catch {
      return
    }
    for (const msg of messages) {
      if (msg.type !== 'text') continue
      let parsed
      try {
        parsed = JSON.parse(msg.payload.toString('utf8'))
      } catch {
        continue
      }
      const reply = this.handler(parsed, socket)
      if (reply) this.reply(socket, reply)
    }
  }

  reply(socket, obj) {
    socket.write(encodeTextFrame(JSON.stringify(obj)))
  }

  emitEvent(socket, method, params) {
    socket.write(
      encodeTextFrame(JSON.stringify({ type: 'event', method, params })),
    )
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bidi client', () => {
  // Every test opens its own server + client. They are tracked here and torn
  // down after EACH test — a single after() hook would leave earlier servers
  // listening and the event loop alive, which hangs the whole file.
  const openServers = new Set()
  const openClients = new Set()

  /**
   * Start a fake server and register it for cleanup.
   */
  async function startServer(handler) {
    const s = new FakeBiDiServer(handler)
    openServers.add(s)
    await s.listen()
    return s
  }

  /**
   * Connect a client and register it for cleanup.
   */
  async function connectClient(port, opts = {}) {
    const c = new BidiClient({ port, timeoutMs: 5000, ...opts })
    openClients.add(c)
    await c.connect()
    return c
  }

  after(async () => {
    for (const c of openClients) {
      try {
        c.close()
      } catch {}
    }
    for (const s of openServers) {
      try {
        await s.close()
      } catch {}
    }
    openClients.clear()
    openServers.clear()
  })

  test('connects and completes the WebSocket handshake', async () => {
    const server = await startServer((msg) => {
      if (msg.method === 'session.new') {
        return { type: 'success', id: msg.id, result: { sessionId: 'sess-1' } }
      }
      return null
    })

    const client = await connectClient(server.port)
    assert.equal(client.connected, true)

    const result = await client.send('session.new', { capabilities: {} })
    assert.equal(result.sessionId, 'sess-1')
  })

  test('matches responses to commands by id', async () => {
    // The server answers out of order — the client must not mix them up.
    const server = await startServer((msg) => {
      if (msg.method === 'slow') {
        setTimeout(() => server.reply(server.sockets[0], {
          type: 'success', id: msg.id, result: { which: 'slow' },
        }), 60)
        return null
      }
      if (msg.method === 'fast') {
        return { type: 'success', id: msg.id, result: { which: 'fast' } }
      }
      return null
    })

    const c = await connectClient(server.port)
    const [slow, fast] = await Promise.all([
      c.send('slow'),
      c.send('fast'),
    ])
    assert.equal(slow.which, 'slow')
    assert.equal(fast.which, 'fast')
  })

  test('rejects with BidiError on an error envelope', async () => {
    const server = await startServer((msg) => ({
      type: 'error',
      id: msg.id,
      error: 'no such element',
      message: 'Could not find the element',
    }))

    const c = await connectClient(server.port)
    await assert.rejects(
      () => c.send('script.evaluate', {}),
      (err) => {
        assert.ok(err instanceof BidiError)
        assert.equal(err.code, 'no such element')
        assert.equal(err.message, 'Could not find the element')
        return true
      },
    )
  })

  test('routes events to subscribers and does NOT treat them as responses', async () => {
    const server = await startServer((msg, socket) => {
      if (msg.method === 'trigger') {
        // An event arrives BEFORE the response for the same command.
        server.emitEvent(socket, 'log.entryAdded', { level: 'warn', text: 'boom' })
        setTimeout(() => server.reply(socket, {
          type: 'success', id: msg.id, result: { done: true },
        }), 20)
        return null
      }
      return null
    })

    const c = await connectClient(server.port)
    const events = []
    c.on('event', (method, params) => events.push({ method, params }))

    const result = await c.send('trigger')
    assert.equal(result.done, true, 'the command still resolves')
    assert.equal(events.length, 1, 'the event was delivered')
    assert.equal(events[0].method, 'log.entryAdded')
    assert.equal(events[0].params.text, 'boom')
  })

  test('times out a command that never gets a response', async () => {
    const server = await startServer(() => null) // never replies

    const c = await connectClient(server.port, { timeoutMs: 300 })
    await assert.rejects(
      () => c.send('never.answered'),
      (err) => {
        assert.ok(err instanceof BidiTimeoutError)
        assert.equal(err.method, 'never.answered')
        assert.equal(err.timeoutMs, 300)
        return true
      },
    )
    // The socket stays usable after a timeout.
    assert.equal(c.connected, true)
  })

  test('rejects commands sent before connecting', async () => {
    const c = new BidiClient({ port: 1, timeoutMs: 1000 })
    openClients.add(c)
    await assert.rejects(() => c.send('anything'), /not connected/)
  })

  test('rejects pending commands when the connection drops', async () => {
    const server = await startServer(() => null)

    const c = await connectClient(server.port)
    const pending = c.send('pending.command')
    server.sockets[0].destroy()
    await assert.rejects(() => pending, (err) => {
      assert.ok(err instanceof BidiError)
      assert.equal(err.code, 'connection_closed')
      return true
    })
  })

  test('serializes commands so a later one cannot overtake an earlier one', async () => {
    const order = []
    const server = await startServer((msg) => {
      order.push(`start:${msg.method}`)
      const delay = msg.method === 'first' ? 80 : 5
      setTimeout(() => {
        order.push(`end:${msg.method}`)
        server.reply(server.sockets[0], {
          type: 'success', id: msg.id, result: {},
        })
      }, delay)
      return null
    })

    const c = await connectClient(server.port)
    await Promise.all([c.send('first'), c.send('second')])
    // 'first' must fully complete before 'second' starts.
    assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second'])
  })
})
