// test/captcha-geetest.test.js
// The GeeTest slider solver.
//
// Two things can be tested without a browser:
//   - the notch matcher, which is pure arithmetic over RGBA arrays;
//   - the solver's wiring, driven through a fake BiDi client that records
//     the pointer actions it dispatches.
//
// The matcher test is the important one: it builds a synthetic puzzle where
// the gap is at a known position and asserts the solver finds it. That is
// what replaces a downloaded model.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { findNotch, computeDragDistance, solveGeetest } from '../lib/firefox/captcha/geetest.js'

/**
 * Build a synthetic GeeTest puzzle.
 *
 * The background is a smooth gradient with a puzzle-shaped gap drawn as a
 * dark outline — that is how GeeTest renders the notch. The piece canvas
 * carries the ORIGINAL (undimmed) pixels of the gap on its border, with a
 * transparent interior.
 *
 * @param {object} opts
 * @returns {{bg: object, piece: object, notch: {x: number, y: number}}}
 */
function makePuzzle(opts = {}) {
  const bw = opts.bw || 64
  const bh = opts.bh || 48
  const pw = opts.pw || 20
  const ph = opts.ph || 20
  const nx = opts.nx ?? 28
  const ny = opts.ny ?? 10
  const dim = opts.dim ?? 0.3

  // A photograph is a LOW-frequency image: neighbouring pixels are similar.
  // The gradient here is deliberately gentle for that reason — if the
  // background had steep ramps, the difference between two distant pieces of
  // the picture would drown out the notch's own signal, and the test would
  // be measuring the wrong thing.
  const original = (x, y) => [100 + (x % 9), 100 + (y % 7), 120]
  const inGap = (x, y) => x >= nx && x < nx + pw && y >= ny && y < ny + ph
  const onGapEdge = (x, y) =>
    inGap(x, y) && (x === nx || x === nx + pw - 1 || y === ny || y === ny + ph - 1)

  const bgData = []
  for (let y = 0; y < bh; y += 1) {
    for (let x = 0; x < bw; x += 1) {
      const [r, g, b] = original(x, y)
      const scale = onGapEdge(x, y) ? dim : 1
      bgData.push(Math.round(r * scale), Math.round(g * scale), Math.round(b * scale), 255)
    }
  }

  const pieceData = []
  for (let y = 0; y < ph; y += 1) {
    for (let x = 0; x < pw; x += 1) {
      const onEdge = x === 0 || y === 0 || x === pw - 1 || y === ph - 1
      if (!onEdge) {
        pieceData.push(0, 0, 0, 0)
        continue
      }
      const [r, g, b] = original(nx + x, ny + y)
      pieceData.push(r, g, b, 255)
    }
  }

  return {
    bg: { width: bw, height: bh, data: bgData },
    piece: { width: pw, height: ph, data: pieceData },
    notch: { x: nx, y: ny },
  }
}

describe('findNotch', () => {
  test('locates the gap within two pixels', () => {
    const { bg, piece, notch } = makePuzzle()
    const found = findNotch(bg, piece)
    assert.ok(found, 'the gap should have been found')
    assert.ok(
      Math.abs(found.x - notch.x) <= 2,
      `x should be near ${notch.x}, got ${found.x}`,
    )
    assert.ok(
      Math.abs(found.y - notch.y) <= 2,
      `y should be near ${notch.y}, got ${found.y}`,
    )
  })

  test('scores the correct gap far above the alternatives', () => {
    const { bg, piece } = makePuzzle()
    const found = findNotch(bg, piece)
    // A wrong offset puts the piece border on undimmed pixels, where the
    // squared difference collapses. So the winner must be far clear of the
    // runner-up for the match to be meaningful.
    assert.ok(found.score > 1000, `expected a decisive score, got ${found.score}`)
  })

  test('finds the gap at other positions too', () => {
    for (const [nx, ny] of [
      [5, 3],
      [30, 20],
      [41, 25],
    ]) {
      const { bg, piece, notch } = makePuzzle({ nx, ny })
      const found = findNotch(bg, piece)
      assert.ok(found, `no gap found at ${nx},${ny}`)
      assert.ok(
        Math.abs(found.x - notch.x) <= 2 && Math.abs(found.y - notch.y) <= 2,
        `gap at ${nx},${ny} was reported as ${found.x},${found.y}`,
      )
    }
  })

  test('returns null when there is nothing to match', () => {
    assert.equal(findNotch(null, null), null)
    assert.equal(findNotch({ width: 4, height: 4, data: [] }, null), null)
  })
})

describe('computeDragDistance', () => {
  test('scales the gap position from background pixels to screen pixels', () => {
    // The background is 600 natural pixels wide but rendered at 300px, so
    // everything is half-size on screen.
    const distance = computeDragDistance({
      notchX: 200,
      bgWidth: 600,
      bgRect: { x: 0, y: 0, width: 300, height: 150 },
      knobRect: { x: 0, y: 100, width: 40, height: 40 },
      trackRect: { x: 0, y: 100, width: 300, height: 40 },
    })
    // notch at 200 natural px -> 100 screen px; the handle starts at 0.
    assert.equal(distance, 100)
  })

  test('never drags past the end of the track', () => {
    const distance = computeDragDistance({
      notchX: 590,
      bgWidth: 600,
      bgRect: { x: 0, y: 0, width: 300, height: 150 },
      knobRect: { x: 0, y: 100, width: 40, height: 40 },
      trackRect: { x: 0, y: 100, width: 300, height: 40 },
    })
    assert.equal(distance, 260, 'the drag must stop at the end of the track')
  })

  test('returns zero when the handle cannot be measured', () => {
    assert.equal(
      computeDragDistance({ notchX: 10, bgWidth: 100, bgRect: null, knobRect: null }),
      0,
    )
  })
})

/**
 * Encode a plain JS value the way BiDi serialises a RemoteValue.
 *
 * @param {any} value
 * @returns {object}
 */
function encode(value) {
  if (value === null) return { type: 'null', value: null }
  if (typeof value === 'number') return { type: 'number', value }
  if (typeof value === 'string') return { type: 'string', value }
  if (typeof value === 'boolean') return { type: 'boolean', value }
  if (Array.isArray(value)) return { type: 'array', value: value.map(encode) }
  return {
    type: 'object',
    value: Object.entries(value).map(([key, val]) => [key, encode(val)]),
  }
}

/**
 * A fake BiDi client for the slider solver.
 *
 * @param {object} opts
 * @returns {object}
 */
function fakeClient(opts = {}) {
  const calls = []
  let dragged = false
  return {
    calls,
    async send(method, params) {
      calls.push({ method, params })
      if (method === 'input.performActions') {
        dragged = true
        return {}
      }
      if (method === 'script.evaluate') {
        const expression = params.expression
        if (expression.includes('canvasPixels')) {
          return { result: encode(opts.geometry) }
        }
        if (expression.includes('geetest_btn_right')) {
          return { result: { type: 'boolean', value: !!opts.verified } }
        }
        if (expression.includes('geetest_validate')) {
          // The site issues its token only AFTER the drag happened.
          return { result: { type: 'number', value: dragged ? 42 : 0 } }
        }
      }
      return { result: { type: 'null', value: null } }
    },
  }
}

describe('solveGeetest', () => {
  test('drags the handle and reports success once the site issues a token', async () => {
    const { bg, piece } = makePuzzle()
    const client = fakeClient({
      geometry: {
        bg,
        piece,
        bgRect: { x: 0, y: 0, width: 320, height: 160 },
        knobRect: { x: 0, y: 100, width: 40, height: 40 },
        trackRect: { x: 0, y: 100, width: 320, height: 40 },
      },
    })

    const result = await solveGeetest({
      client,
      contextId: 'ctx-1',
      topContextId: 'ctx-0',
      challenge: { tokenSelector: 'input[name="geetest_validate"]' },
      closedRootProp: '__captcha_closed_root',
      timeoutMs: 5000,
    })

    assert.equal(result.ok, true, `the slider should have been solved: ${result.message}`)
    assert.equal(result.status, 'solved')
    assert.equal(result.tokenLength, 42)

    // The drag must have been dispatched as one press/moves/release sequence.
    const drag = client.calls.find((call) => call.method === 'input.performActions')
    assert.ok(drag, 'a drag should have been dispatched')
    const actions = drag.params.actions[0].actions
    assert.equal(actions[0].type, 'pointerMove')
    assert.equal(actions[1].type, 'pointerDown')
    assert.equal(actions[actions.length - 1].type, 'pointerUp')
    assert.ok(actions.length > 5, 'the drag should contain intermediate moves')
  })

  test('reports geometry_unavailable when the puzzle cannot be measured', async () => {
    const client = fakeClient({ geometry: null })
    const result = await solveGeetest({
      client,
      contextId: 'ctx-1',
      topContextId: 'ctx-0',
      challenge: { tokenSelector: 'input[name="geetest_validate"]' },
      closedRootProp: '__captcha_closed_root',
      timeoutMs: 1000,
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 'geometry_unavailable')
  })

  test('reports no_puzzle_canvas when the page has no puzzle canvases', async () => {
    const client = fakeClient({
      geometry: {
        bg: null,
        piece: null,
        bgRect: null,
        knobRect: null,
        trackRect: null,
        canvases: [],
      },
    })
    const result = await solveGeetest({
      client,
      contextId: 'ctx-1',
      topContextId: 'ctx-0',
      challenge: { tokenSelector: 'input[name="geetest_validate"]' },
      closedRootProp: '__captcha_closed_root',
      timeoutMs: 1000,
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 'no_puzzle_canvas')
  })
})
