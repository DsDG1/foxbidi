// test/bidi-frame.test.js
// Unit tests for the WebSocket frame codec (lib/bidi/frame.js).
//
// The codec is the lowest layer of the BiDi transport, so its edge cases
// (masking, length extension, fragmentation, control frames) get direct
// coverage rather than being exercised only through a live Firefox.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const absPath = (rel) => pathToFileURL(resolve(HERE, '..', rel)).href

const { encodeTextFrame, encodeCloseFrame, encodePongFrame, FrameDecoder, decodeAll, OPCODE } =
  await import(absPath('lib/bidi/frame.js'))

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

describe('frame.encodeTextFrame', () => {
  test('sets FIN + text opcode and the MASK bit', () => {
    const buf = encodeTextFrame('hello')
    assert.equal(buf[0] & 0x80, 0x80, 'FIN bit must be set')
    assert.equal(buf[0] & 0x0f, OPCODE.TEXT)
    assert.equal(buf[1] & 0x80, 0x80, 'MASK bit must be set for client→server')
  })

  test('encodes a short payload with a 7-bit length', () => {
    const buf = encodeTextFrame('hello')
    assert.equal(buf[1] & 0x7f, 5)
    // 2 header bytes + 4 mask bytes + 5 payload bytes
    assert.equal(buf.length, 11)
  })

  test('uses a 16-bit length for payloads >= 126', () => {
    const text = 'x'.repeat(200)
    const buf = encodeTextFrame(text)
    assert.equal(buf[1] & 0x7f, 126)
    assert.equal(buf.readUInt16BE(2), 200)
    assert.equal(buf.length, 4 + 4 + 200)
  })

  test('uses a 64-bit length for payloads >= 65536', () => {
    const text = 'y'.repeat(70000)
    const buf = encodeTextFrame(text)
    assert.equal(buf[1] & 0x7f, 127)
    assert.equal(buf.readUInt32BE(2), 0, 'high 32 bits must be zero')
    assert.equal(buf.readUInt32BE(6), 70000)
  })

  test('masks the payload so the wire bytes differ from the plaintext', () => {
    const text = 'secret-payload'
    const buf = encodeTextFrame(text)
    const wire = buf.subarray(6).toString('utf8')
    assert.notEqual(wire, text, 'payload must not appear verbatim on the wire')
  })

  test('round-trips through the decoder', () => {
    const text = JSON.stringify({ id: 1, method: 'session.new', params: {} })
    const decoded = decodeAll(encodeTextFrame(text))
    assert.equal(decoded.length, 1)
    assert.equal(decoded[0].type, 'text')
    assert.equal(decoded[0].payload.toString('utf8'), text)
  })

  test('round-trips a multi-byte UTF-8 payload', () => {
    const text = '点击 Firefox 🚀'
    const decoded = decodeAll(encodeTextFrame(text))
    assert.equal(decoded[0].payload.toString('utf8'), text)
  })
})

describe('frame control frames', () => {
  test('encodeCloseFrame carries the status code and reason', () => {
    const buf = encodeCloseFrame(1000, 'bye')
    assert.equal(buf[0] & 0x0f, OPCODE.CLOSE)
    assert.equal(buf[1] & 0x80, 0x80, 'control frames from the client are masked too')
    const decoded = decodeAll(buf)
    assert.equal(decoded[0].type, 'close')
    assert.equal(decoded[0].code, 1000)
    assert.equal(decoded[0].reason, 'bye')
  })

  test('encodePongFrame echoes the ping payload', () => {
    const decoded = decodeAll(encodePongFrame(Buffer.from('ping-payload')))
    assert.equal(decoded[0].type, 'pong')
    assert.equal(decoded[0].payload.toString('utf8'), 'ping-payload')
  })

  test('a close frame reason is truncated to the control-frame limit', () => {
    const decoded = decodeAll(encodeCloseFrame(1000, 'x'.repeat(500)))
    assert.equal(decoded[0].type, 'close')
    assert.ok(decoded[0].reason.length <= 123, 'reason must fit the 125-byte control limit')
  })

  test('encodeCloseFrame does not split multi-byte UTF-8 into U+FFFD past 125 bytes', () => {
    for (const pad of [119, 120, 121, 122]) {
      const reason = 'a'.repeat(pad) + '点击🚀测试'
      const buf = encodeCloseFrame(1000, reason)
      // Header must stay 2 bytes (7-bit payload length <= 125), never 126/127.
      const wireLen = buf[1] & 0x7f
      assert.ok(wireLen <= 125, `wire length ${wireLen} exceeded 125 for pad=${pad}`)
      const decoded = decodeAll(buf)
      assert.equal(decoded.length, 1)
      assert.equal(decoded[0].type, 'close')
      assert.equal(decoded[0].code, 1000)
      assert.equal(decoded[0].reason.includes('\ufffd'), false, 'must not contain U+FFFD')
    }
  })

  test('encodePongFrame clamps oversized payloads to the 125-byte control limit', () => {
    const buf = encodePongFrame(Buffer.alloc(300, 0x61))
    assert.equal(buf[1] & 0x7f, 125)
    const decoded = decodeAll(buf)
    assert.equal(decoded[0].type, 'pong')
    assert.equal(decoded[0].payload.length, 125)
  })
})

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

describe('frame.FrameDecoder', () => {
  test('returns nothing for an incomplete frame', () => {
    const dec = new FrameDecoder()
    const full = encodeTextFrame('hello')
    // Feed everything but the last byte.
    assert.deepEqual(dec.push(full.subarray(0, full.length - 1)), [])
    const rest = dec.push(full.subarray(full.length - 1))
    assert.equal(rest.length, 1)
    assert.equal(rest[0].payload.toString('utf8'), 'hello')
  })

  test('returns nothing for a partial header', () => {
    const dec = new FrameDecoder()
    assert.deepEqual(dec.push(Buffer.from([0x81])), [])
  })

  test('decodes several frames arriving in one chunk', () => {
    const a = encodeTextFrame('one')
    const b = encodeTextFrame('two')
    const decoded = decodeAll(Buffer.concat([a, b]))
    assert.equal(decoded.length, 2)
    assert.equal(decoded[0].payload.toString('utf8'), 'one')
    assert.equal(decoded[1].payload.toString('utf8'), 'two')
  })

  test('decodes a large 64-bit length frame streamed in tiny uneven chunks', () => {
    const text = '截图数据-'.repeat(12000) // > 65536 bytes UTF-8
    const wire = encodeTextFrame(text)
    const dec = new FrameDecoder()
    const out = []
    for (let i = 0; i < wire.length; i += 17) {
      out.push(...dec.push(wire.subarray(i, i + 17)))
    }
    assert.equal(out.length, 1)
    assert.equal(out[0].payload.toString('utf8'), text)
  })

  test('reassembles a fragmented text message', () => {
    // Build a fragmented frame by hand: first frame FIN=0 text, then a
    // continuation frame FIN=1. Server→client frames are NOT masked.
    const head = Buffer.from('hello ')
    const tail = Buffer.from('world')
    const first = Buffer.concat([
      Buffer.from([0x01, head.length]), // FIN=0, opcode=text, 7-bit length
      head,
    ])
    const second = Buffer.concat([
      Buffer.from([0x80, tail.length]), // FIN=1, opcode=continuation
      tail,
    ])

    const dec = new FrameDecoder()
    assert.deepEqual(dec.push(first), [], 'incomplete fragment must not emit')
    const out = dec.push(second)
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'text')
    assert.equal(out[0].payload.toString('utf8'), 'hello world')
  })

  test('surfaces ping frames for the caller to answer', () => {
    const dec = new FrameDecoder()
    const out = dec.push(Buffer.from([0x89, 0x04, 0x70, 0x69, 0x6e, 0x67]))
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'ping')
    assert.equal(out[0].payload.toString('utf8'), 'ping')
  })

  test('ignores the pong opcode', () => {
    const dec = new FrameDecoder()
    const out = dec.push(Buffer.from([0x8a, 0x00]))
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'pong')
  })

  test('decodes a masked server frame (tolerated even though servers do not mask)', () => {
    const buf = encodeTextFrame('masked')
    const dec = new FrameDecoder()
    const out = dec.push(buf)
    assert.equal(out[0].payload.toString('utf8'), 'masked')
  })

  test('throws on a continuation frame with no initial frame', () => {
    const dec = new FrameDecoder()
    assert.throws(() => dec.push(Buffer.from([0x80, 0x02, 0x68, 0x69])))
  })
})
