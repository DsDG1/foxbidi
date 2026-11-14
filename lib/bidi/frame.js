// lib/bidi/frame.js
// WebSocket frame codec for the BiDi (WebDriver BiDi) transport.
//
// Why hand-rolled instead of `ws`: this plugin is deliberately zero-npm-dep.
// Node 22+ ships a WHATWG `WebSocket` global, but that API does not expose
// the raw frame layer — and the BiDi remote agent speaks standard RFC 6455
// frames over a plain `ws://` URL. This module implements the subset we need
// on top of a raw TCP socket.
//
// Scope (what we implement, and what we deliberately do not):
//   - text frames only (BiDi payloads are JSON text)
//   - client→server frames MUST be masked (RFC 6455 §5.3)
//   - server→client frames are never masked
//   - payload length: 7-bit / 16-bit (126) / 64-bit (127)
//   - continuation frames (opcode 0) — BiDi messages can exceed one frame
//   - control frames: ping (9) / pong (10) / close (8)
//
// Not implemented (not needed by BiDi): permessage-deflate negotiation,
// binary frames, client→server ping (only the server pings us).

import { randomBytes } from 'node:crypto'

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
}

const MAX_CONTROL_PAYLOAD = 125

// ---------------------------------------------------------------------------
// Encoding (client → server). Always masked.
// ---------------------------------------------------------------------------

/**
 * Encode a single text frame.
 *
 * @param {string} text  UTF-8 payload
 * @param {Buffer} [maskKey]  4-byte mask; random when omitted (RFC requires
 *                             unpredictable masks — a fixed key would leak
 *                             payload entropy to a hostile peer)
 * @returns {Buffer} the full frame (header + masked payload)
 */
export function encodeTextFrame(text, maskKey) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  const key = maskKey || randomBytes(4)

  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[0] = 0x80 | OPCODE.TEXT // FIN + opcode
    header[1] = 0x80 | len // MASK bit + 7-bit length
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | OPCODE.TEXT
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | OPCODE.TEXT
    header[1] = 0x80 | 127
    header.writeUInt32BE(0, 2) // high 32 bits — BiDi payloads never exceed 4 GB
    header.writeUInt32BE(len, 6)
  }

  const masked = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ key[i & 3]
  return Buffer.concat([header, key, masked])
}

/**
 * Truncate a UTF-8 string to at most `maxBytes` without splitting a
 * multi-byte code point (which `.toString('utf8')` would expand into a
 * 3-byte U+FFFD replacement character, overflowing the byte budget).
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {Buffer}
 */
function truncateUtf8Buffer(text, maxBytes) {
  const buf = Buffer.from(String(text || ''), 'utf8')
  if (buf.length <= maxBytes) return buf
  let end = maxBytes
  // Step back over UTF-8 continuation bytes (10xxxxxx).
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--
  }
  // `end` now points at the lead byte of the split character; drop it too.
  return buf.subarray(0, end)
}

/**
 * Encode a close frame with a status code and reason.
 *
 * @param {number} code  WebSocket status code (1000 = normal)
 * @param {string} [reason]
 * @returns {Buffer}
 */
export function encodeCloseFrame(code = 1000, reason = '') {
  // Control frames are capped at 125 bytes of payload (RFC 6455 §5.5).
  const reasonBytes = truncateUtf8Buffer(reason, MAX_CONTROL_PAYLOAD - 2)
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length)
  payload.writeUInt16BE(code, 0)
  reasonBytes.copy(payload, 2)

  const header = Buffer.alloc(2)
  header[0] = 0x80 | OPCODE.CLOSE
  header[1] = 0x80 | payload.length // MASK bit set (client→server)
  const key = randomBytes(4)
  const masked = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ key[i & 3]
  return Buffer.concat([header, key, masked])
}

/**
 * Encode a pong frame (reply to a server ping).
 *
 * @param {Buffer} payload  the ping's payload, echoed back verbatim
 * @returns {Buffer}
 */
export function encodePongFrame(payload) {
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.alloc(0)
  const body = raw.length > MAX_CONTROL_PAYLOAD ? raw.subarray(0, MAX_CONTROL_PAYLOAD) : raw
  const header = Buffer.alloc(2)
  header[0] = 0x80 | OPCODE.PONG
  header[1] = 0x80 | body.length
  const key = randomBytes(4)
  const masked = Buffer.allocUnsafe(body.length)
  for (let i = 0; i < body.length; i++) masked[i] = body[i] ^ key[i & 3]
  return Buffer.concat([header, key, masked])
}

// ---------------------------------------------------------------------------
// Decoding (server → client). Never masked.
// ---------------------------------------------------------------------------

/**
 * A streaming frame decoder. Feed it socket chunks; it yields complete
 * messages (already reassembled across continuation frames) plus control
 * frames.
 *
 * Usage:
 *   const dec = new FrameDecoder()
 *   socket.on('data', (chunk) => {
 *     for (const msg of dec.push(chunk)) { ... }
 *   })
 */
export class FrameDecoder {
  constructor() {
    /** @type {Buffer[]} */
    this._chunks = []
    this._length = 0
    // Reassembly state for fragmented messages.
    this._fragments = []
    this._fragmentOpcode = null
  }

  /**
   * Feed a chunk and return the messages it completed.
   *
   * @param {Buffer} chunk
   * @returns {Array<{type: 'text'|'close'|'ping'|'pong', payload?: Buffer, code?: number, reason?: string}>}
   */
  push(chunk) {
    if (!chunk || chunk.length === 0) return []
    this._chunks.push(chunk)
    this._length += chunk.length

    const out = []
    // Loop: decode as many complete frames as the buffer holds.
    for (;;) {
      const frame = this._readFrame()
      if (!frame) break
      const msg = this._handleFrame(frame)
      if (msg) out.push(msg)
    }
    return out
  }

  /**
   * Copy `count` bytes starting from the front of `_chunks` without
   * consuming them (used to inspect the small 2–14 byte frame header).
   *
   * @param {number} count
   * @returns {Buffer}
   */
  _peek(count) {
    const first = this._chunks[0]
    if (first.length >= count) return first.subarray(0, count)
    const out = Buffer.allocUnsafe(count)
    let copied = 0
    for (let i = 0; i < this._chunks.length && copied < count; i++) {
      const c = this._chunks[i]
      const take = Math.min(c.length, count - copied)
      c.copy(out, copied, 0, take)
      copied += take
    }
    return out
  }

  /**
   * Advance past `count` bytes at the front of `_chunks`, optionally
   * returning a freshly copied Buffer of `sliceLen` bytes starting at
   * `sliceOffset` within the consumed region.
   *
   * @param {number} totalConsume
   * @param {number} sliceOffset
   * @param {number} sliceLen
   * @returns {Buffer}
   */
  _consumePayload(totalConsume, sliceOffset, sliceLen) {
    const first = this._chunks[0]
    if (first && first.length >= totalConsume) {
      const payload = Buffer.from(first.subarray(sliceOffset, sliceOffset + sliceLen))
      if (first.length === totalConsume) {
        this._chunks.shift()
      } else {
        this._chunks[0] = first.subarray(totalConsume)
      }
      this._length -= totalConsume
      return payload
    }

    const payload = Buffer.allocUnsafe(sliceLen)
    let remainingSkip = sliceOffset
    let remainingCopy = sliceLen
    let writePos = 0
    let remainingDrop = totalConsume

    while (remainingDrop > 0 && this._chunks.length > 0) {
      const c = this._chunks[0]
      const chunkTake = Math.min(c.length, remainingDrop)
      let readPos = 0

      if (remainingSkip > 0) {
        const skipHere = Math.min(chunkTake, remainingSkip)
        readPos += skipHere
        remainingSkip -= skipHere
      }

      if (remainingSkip === 0 && remainingCopy > 0 && readPos < chunkTake) {
        const copyHere = Math.min(chunkTake - readPos, remainingCopy)
        c.copy(payload, writePos, readPos, readPos + copyHere)
        writePos += copyHere
        remainingCopy -= copyHere
      }

      if (chunkTake === c.length) {
        this._chunks.shift()
      } else {
        this._chunks[0] = c.subarray(chunkTake)
      }
      remainingDrop -= chunkTake
    }

    this._length -= totalConsume
    return payload
  }

  /**
   * Try to read one complete frame from the buffer.
   * @returns {null|{fin: boolean, opcode: number, payload: Buffer}}
   */
  _readFrame() {
    if (this._length < 2) return null

    // Maximum WebSocket frame header size is 14 bytes (2 + 8 length + 4 mask).
    const headerPeek = this._peek(Math.min(this._length, 14))
    const b0 = headerPeek[0]
    const b1 = headerPeek[1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let offset = 2

    if (len === 126) {
      if (headerPeek.length < offset + 2) return null
      len = headerPeek.readUInt16BE(offset)
      offset += 2
    } else if (len === 127) {
      if (headerPeek.length < offset + 8) return null
      const high = headerPeek.readUInt32BE(offset)
      const low = headerPeek.readUInt32BE(offset + 4)
      if (high !== 0) {
        // A >4 GB frame is not something BiDi will ever send; refuse it
        // rather than trying to allocate.
        throw new Error(`frame too large: high=${high}`)
      }
      len = low
      offset += 8
    }

    let maskKey = null
    if (masked) {
      if (headerPeek.length < offset + 4) return null
      maskKey = Buffer.from(headerPeek.subarray(offset, offset + 4))
      offset += 4
    }

    if (this._length < offset + len) return null // incomplete payload

    const payload = this._consumePayload(offset + len, offset, len)
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3]
    }

    return { fin, opcode, payload }
  }

  /**
   * Fold one frame into the output message list.
   * @returns {null|Record<string, any>}
   */
  _handleFrame(frame) {
    const { fin, opcode, payload } = frame

    // Control frames may be interleaved with a fragmented message and are
    // never fragmented themselves (RFC 6455 §5.4).
    if (opcode === OPCODE.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
      return { type: 'close', code, reason }
    }
    if (opcode === OPCODE.PING) return { type: 'ping', payload }
    if (opcode === OPCODE.PONG) return { type: 'pong', payload }

    if (opcode === OPCODE.CONTINUATION) {
      if (this._fragmentOpcode === null) {
        throw new Error('continuation frame without an initial frame')
      }
      this._fragments.push(payload)
      if (!fin) return null
      const full = Buffer.concat(this._fragments)
      const op = this._fragmentOpcode
      this._fragments = []
      this._fragmentOpcode = null
      return op === OPCODE.BINARY
        ? { type: 'binary', payload: full }
        : { type: 'text', payload: full }
    }

    // Text / binary data frame.
    if (!fin) {
      this._fragmentOpcode = opcode
      this._fragments = [payload]
      return null
    }
    return opcode === OPCODE.BINARY ? { type: 'binary', payload } : { type: 'text', payload }
  }
}

/**
 * Convenience: decode a complete frame buffer in one shot.
 * Used by tests and by callers that already have a full frame.
 *
 * @param {Buffer} buf
 * @returns {Array<Record<string, any>>} messages
 */
export function decodeAll(buf) {
  const dec = new FrameDecoder()
  return dec.push(buf)
}
