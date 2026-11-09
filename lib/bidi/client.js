// lib/bidi/client.js
// Minimal WebDriver BiDi client over a raw TCP socket.
//
// Why not the `ws` package: this plugin is zero-npm-dep. We implement RFC
// 6455 framing ourselves in ./frame.js and speak the BiDi JSON envelope
// directly.
//
// BiDi envelope (both directions):
//   command  → {"id": N, "method": "browsingContext.navigate", "params": {...}}
//   response → {"type":"success", "id": N, "result": {...}}
//            | {"type":"error", "id": N, "error":"...", "message":"..."}
//   event    → {"type":"event", "method":"log.entryAdded", "params": {...}}
//
// CRITICAL: events and responses share the socket. A response is matched by
// `id`; anything with `type === "event"` (or no `id`) is dispatched to
// subscribers instead. Mixing these up is the classic BiDi client bug — this
// module keeps the two paths strictly separated.
//
// Serialization: Firefox's remote agent handles concurrent commands poorly
// and stateful commands (input.performActions) must not interleave. All
// commands go through a single promise chain (see `_enqueue`).

import net from 'node:net'
import { EventEmitter } from 'node:events'
import { randomBytes, createHash } from 'node:crypto'
import { FrameDecoder, encodeTextFrame, encodeCloseFrame, encodePongFrame } from './frame.js'

/** Thrown when a BiDi command returns an error envelope. */
export class BidiError extends Error {
  constructor(code, message, stacktrace) {
    super(message || code || 'bidi error')
    this.name = 'BidiError'
    this.code = code || 'unknown_error'
    this.stacktrace = stacktrace || ''
  }
}

/** Thrown when a command exceeds its timeout. */
export class BidiTimeoutError extends Error {
  constructor(method, ms) {
    super(`bidi command timed out after ${ms}ms: ${method}`)
    this.name = 'BidiTimeoutError'
    this.method = method
    this.timeoutMs = ms
  }
}

/**
 * A connected BiDi session.
 *
 * Emits:
 *   'event'   (method, params) — every BiDi event
 *   'close'   ({code, reason})  — socket closed
 */
export class BidiClient extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.host]      default 127.0.0.1
   * @param {number} [opts.port]      BiDi remote-debugging port
   * @param {number} [opts.timeoutMs]  per-command timeout, default 30000
   */
  constructor(opts = {}) {
    super()
    this.host = opts.host || '127.0.0.1'
    this.port = opts.port || 9333
    this.timeoutMs = opts.timeoutMs || 30000
    this.path = opts.path || '/session'

    this._socket = null
    this._decoder = new FrameDecoder()
    this._nextId = 1
    this._pending = new Map() // id → { resolve, reject, timer, method }
    this._chain = Promise.resolve() // serializes command execution
    this._closed = false
    this._sessionId = null
  }

  /** True when the socket is open and usable. */
  get connected() {
    return !this._closed && this._socket !== null && !this._socket.destroyed
  }

  /** The BiDi session id, once `session.new` succeeded. */
  get sessionId() {
    return this._sessionId
  }

  /**
   * Open the TCP socket and complete the WebSocket handshake.
   *
   * @returns {Promise<void>}
   */
  connect() {
    if (this.connected) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port })
      socket.setNoDelay(true)

      const key = randomWebSocketKey()
      const expected = expectedAcceptValue(key)
      let handshakeDone = false

      const onHandshakeError = (err) => {
        socket.destroy()
        reject(err)
      }

      socket.once('error', onHandshakeError)

      socket.on('connect', () => {
        const req =
          `GET ${this.path} HTTP/1.1\r\n` +
          `Host: ${this.host}:${this.port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n'
        socket.write(req)
      })

      // Buffer until the HTTP response headers end; anything after is frame data.
      let handshakeBuf = Buffer.alloc(0)
      const onData = (chunk) => {
        if (handshakeDone) return
        handshakeBuf = Buffer.concat([handshakeBuf, chunk])
        const idx = handshakeBuf.indexOf('\r\n\r\n')
        if (idx === -1) {
          if (handshakeBuf.length > 16384) {
            onHandshakeError(new Error('bidi handshake: response too large'))
          }
          return
        }
        const head = handshakeBuf.subarray(0, idx).toString('latin1')
        const rest = handshakeBuf.subarray(idx + 4)

        if (!/^HTTP\/1\.1 101/i.test(head)) {
          onHandshakeError(new Error(`bidi handshake failed: ${head.split('\r\n')[0]}`))
          return
        }
        const acceptMatch = head.match(/sec-websocket-accept:\s*(\S+)/i)
        if (!acceptMatch || acceptMatch[1] !== expected) {
          onHandshakeError(new Error('bidi handshake failed: bad Sec-WebSocket-Accept'))
          return
        }

        handshakeDone = true
        socket.removeListener('data', onData)
        socket.removeListener('error', onHandshakeError)
        this._socket = socket
        socket.on('data', (c) => this._onData(c))
        socket.on('error', (e) => this._onError(e))
        socket.on('close', () => this._onClose())

        if (rest.length > 0) this._onData(rest)
        resolve()
      }

      socket.on('data', onData)
      socket.setTimeout(30000, () => {
        if (!handshakeDone) onHandshakeError(new Error('bidi handshake: timeout'))
      })
    })
  }

  /**
   * Send a BiDi command and await its response.
   *
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs]  overrides the client default
   * @returns {Promise<object>} the `result` payload
   */
  send(method, params = {}, timeoutMs) {
    return this._enqueue(() => this._sendNow(method, params, timeoutMs))
  }

  /**
   * Send a command WITHOUT going through the serialized queue.
   *
   * Some commands must not wait behind an in-flight command. The case that
   * matters here: a `beforeunload` dialog blocks the very navigation that
   * triggered it, so `browsingContext.handleUserPrompt` — queued behind that
   * navigation — would never be sent, and the agent would hang until the
   * command timeout.
   *
   * Only use this for commands that do not touch the input state machine
   * (pointer/key actions must stay serialized).
   *
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<object>} the `result` payload
   */
  sendUnqueued(method, params = {}, timeoutMs) {
    return this._sendNow(method, params, timeoutMs)
  }

  _sendNow(method, params, timeoutMs) {
    if (!this.connected) {
      return Promise.reject(new Error(`bidi: not connected (method=${method})`))
    }
    const id = this._nextId++
    const payload = JSON.stringify({ id, method, params })

    return new Promise((resolve, reject) => {
      const ms = timeoutMs || this.timeoutMs
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new BidiTimeoutError(method, ms))
      }, ms)
      // The timer must not keep the process alive on its own.
      if (typeof timer.unref === 'function') timer.unref()

      this._pending.set(id, { resolve, reject, timer, method })
      try {
        this._socket.write(encodeTextFrame(payload))
      } catch (e) {
        clearTimeout(timer)
        this._pending.delete(id)
        reject(e)
      }
    }).catch((error) => {
      // A failed command is worth reporting separately from the page's own
      // console output: "the plugin could not talk to Firefox" and "the page
      // logged an error" are different problems with different fixes.
      if (error && error.name === 'BidiError') {
        this.emit('commandError', method, error.message || error.code)
      }
      throw error
    })
  }

  /**
   * Serialize command execution. Firefox's remote agent does not tolerate
   * concurrent commands well, and stateful commands (input.performActions)
   * must not interleave with each other.
   */
  _enqueue(fn) {
    const run = this._chain.then(fn, fn)
    // Keep the chain alive even when a command rejects.
    this._chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  _onData(chunk) {
    let messages
    try {
      messages = this._decoder.push(chunk)
    } catch (e) {
      this._onError(e)
      return
    }
    for (const msg of messages) {
      if (msg.type === 'ping') {
        // Reply with the same payload (RFC 6455 §5.5.3).
        try {
          this._socket.write(encodePongFrame(msg.payload))
        } catch {}
        continue
      }
      if (msg.type === 'pong') continue
      if (msg.type === 'close') {
        this._onClose(msg.code, msg.reason)
        continue
      }
      if (msg.type === 'text') {
        let parsed
        try {
          parsed = JSON.parse(msg.payload.toString('utf8'))
        } catch {
          continue // ignore non-JSON frames (Firefox may send keep-alives)
        }
        this._dispatch(parsed)
      }
    }
  }

  /**
   * Route one parsed envelope: response → pending promise, event → emitter.
   */
  _dispatch(msg) {
    if (msg && msg.type === 'event') {
      this.emit('event', msg.method, msg.params || {})
      return
    }
    // Some BiDi events omit `type` but carry a `method` and no `id`.
    if (msg && typeof msg.method === 'string' && msg.id === undefined) {
      this.emit('event', msg.method, msg.params || {})
      return
    }
    if (!msg || msg.id === undefined) return

    const entry = this._pending.get(msg.id)
    if (!entry) return // late response for an already-timed-out command
    this._pending.delete(msg.id)
    clearTimeout(entry.timer)

    if (msg.type === 'error') {
      entry.reject(new BidiError(msg.error, msg.message, msg.stacktrace))
    } else {
      entry.resolve(msg.result || {})
    }
  }

  _onError(err) {
    this._failAll(err)
    // EventEmitter throws when an 'error' event has no listener. A socket
    // reset is an ordinary end-of-life event here (the peer went away), so
    // it must never become an uncaught exception.
    if (this.listenerCount('error') > 0) {
      this.emit('error', err)
    }
  }

  _onClose(code, reason) {
    if (this._closed) return
    this._closed = true
    this._failAll(new BidiError('connection_closed', reason || 'bidi connection closed'))
    this.emit('close', { code, reason })
  }

  _failAll(err) {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this._pending.clear()
  }

  /**
   * Close the socket. Pending commands reject with a connection_closed error.
   */
  close() {
    if (!this._socket) {
      this._closed = true
      return
    }
    try {
      this._socket.write(encodeCloseFrame(1000, 'bye'))
    } catch {}
    // Detach the error handler before tearing the socket down: once we
    // closed it deliberately, an ECONNRESET from the peer is expected
    // noise, not a condition anyone should react to.
    this._socket.removeAllListeners('error')
    this._socket.on('error', () => {})
    try {
      this._socket.end()
    } catch {}
    try {
      this._socket.destroy()
    } catch {}
    this._closed = true
  }
}

// ---------------------------------------------------------------------------
// Small crypto helpers kept local so frame.js / client.js stay dependency-free.
// ---------------------------------------------------------------------------

function randomWebSocketKey() {
  return randomBytes(16).toString('base64')
}

function expectedAcceptValue(key) {
  // RFC 6455 §4.2.2 — SHA-1 of the client key + the fixed GUID.
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
}
