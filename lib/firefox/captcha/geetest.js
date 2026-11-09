// lib/firefox/captcha/geetest.js
// Solve a GeeTest slider.
//
// A GeeTest slider shows a background image with a notch cut out of it, plus
// a puzzle piece that must be dragged into that notch. Two things are needed:
//
//   1. WHERE the notch is. The background and the piece are drawn on
//      canvases; the gap is found by correlating the piece's pixels against
//      the background's. That correlation is plain arithmetic on RGBA arrays
//      — no model, no image library, a few dozen lines.
//
//   2. A DRAG. The drag is dispatched as press -> many moves -> release, so
//      the page sees the same event sequence a human produces. A single
//      jump is the giveaway.
//
// The correlation runs IN THE PAGE (the canvas pixels are read there and
// matched there), because Firefox's BiDi `captureScreenshot` has no clip
// parameter — there is no way to grab just the notch region and analyse it
// outside the browser.

import { evaluate } from '../../bidi/protocol.js'
import { pointerDrag } from '../inputs.js'
import { readTokenLength } from './detect.js'
import { rootsSource } from './roots.js'

/**
 * The in-page routine that finds the notch.
 *
 * It returns raw pixel data for the background and the piece, plus the
 * rectangle each occupies, so the matching can be done outside — but the
 * pixel extraction has to happen in the page.
 *
 * @param {string} closedRootProp
 * @returns {string} an expression
 */
function pixelsExpression(closedRootProp) {
  return `(() => {
  const PROP = ${JSON.stringify(closedRootProp)};
  ${rootsSource('PROP')}
  const find = (sels) => {
    for (const root of roots) {
      for (const sel of sels) {
        let el = null;
        try { el = root.querySelector(sel); } catch (e) { el = null; }
        if (el) return el;
      }
    }
    return null;
  };
  const canvasPixels = (canvas) => {
    if (!canvas) return null;
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return { width: canvas.width, height: canvas.height, data: Array.from(data.data) };
    } catch (e) { return null; }
  };
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const bgCanvas = find(['.geetest_bg canvas', '.geetest_slice_bg canvas', 'canvas.geetest_bg']);
  const pieceCanvas = find(['.geetest_slice canvas', '.geetest_slice_bg canvas.geetest_slice', 'canvas.geetest_slice']);
  const bgImg = find(['.geetest_bg img', '.geetest_bg']);
  const pieceImg = find(['.geetest_slice img', '.geetest_slice']);
  const knob = find(['.geetest_slider_button', '.gt_slider_knob', '.geetest_btn', '.geetest_slider .geetest_btn']);
  const track = find(['.geetest_slider', '.geetest_slider_track', '.gt_slider']);
  return {
    bg: canvasPixels(bgCanvas),
    piece: canvasPixels(pieceCanvas),
    bgImg: bgImg ? { src: (bgImg.src || '').slice(0, 120), rect: rectOf(bgImg) } : null,
    pieceImg: pieceImg ? { src: (pieceImg.src || '').slice(0, 120), rect: rectOf(pieceImg) } : null,
    knob: rectOf(knob),
    track: rectOf(track),
    canvases: Array.from(document.querySelectorAll('canvas')).map((c) => ({
      cls: String(c.className || '').slice(0, 60), width: c.width, height: c.height,
    })),
  };
})()`
}

/**
 * Find the notch by correlating the piece against the background.
 *
 * The piece is the "hole" shape that was cut out of the background, so the
 * piece's own pixels are the notch's outline. Scoring each candidate
 * offset by how much the piece's edge pixels differ from the background at
 * that position puts the notch where the two images disagree.
 *
 * Only the piece's BORDER is used: the interior of the piece is transparent
 * and carries no signal, while the border is exactly the cut line.
 *
 * @param {object} bg  {width, height, data}
 * @param {object} piece  {width, height, data}
 * @returns {{x: number, score: number}|null}
 */
export function findNotch(bg, piece) {
  if (!bg || !piece || !bg.data || !piece.data) return null
  const { width: bw, height: bh, data: bdata } = bg
  const { width: pw, height: ph, data: pdata } = piece
  if (!bw || !bh || !pw || !ph) return null

  // Collect the piece's opaque border pixels.
  const edge = []
  for (let y = 0; y < ph; y += 1) {
    for (let x = 0; x < pw; x += 1) {
      const i = (y * pw + x) * 4
      const alpha = pdata[i + 3]
      if (alpha < 128) continue
      const onEdge = x === 0 || y === 0 || x === pw - 1 || y === ph - 1
      if (!onEdge) continue
      edge.push([x, y, pdata[i], pdata[i + 1], pdata[i + 2]])
    }
  }
  if (edge.length === 0) return null

  let best = null
  const maxX = bw - pw
  const maxY = bh - ph
  for (let ox = 0; ox <= maxX; ox += 1) {
    for (let oy = 0; oy <= maxY; oy += 1) {
      let diff = 0
      for (const [x, y, r, g, b] of edge) {
        const bi = ((oy + y) * bw + (ox + x)) * 4
        const dr = bdata[bi] - r
        const dg = bdata[bi + 1] - g
        const db = bdata[bi + 2] - b
        diff += dr * dr + dg * dg + db * db
      }
      const score = diff / edge.length
      if (!best || score > best.score) best = { x: ox, y: oy, score }
    }
  }
  return best ? { x: best.x, y: best.y, score: best.score } : null
}

/**
 * Convert a notch position in background pixels into a drag distance in
 * screen pixels.
 *
 * The background image is usually rendered at a different size than its
 * natural size, so the ratio has to be applied.
 *
 * @param {object} params
 * @param {number} params.notchX  notch x in background pixels
 * @param {number} params.bgWidth  background width in natural pixels
 * @param {object} params.bgRect  the background's screen rectangle
 * @param {object} params.knobRect  the drag handle's screen rectangle
 * @param {object} params.trackRect  the track's screen rectangle
 * @returns {number} the distance to drag, in screen pixels
 */
export function computeDragDistance(params) {
  const { notchX, bgWidth, bgRect, knobRect, trackRect } = params
  if (!bgRect || !knobRect) return 0

  // Where the piece sits on screen when the handle is at the track's start.
  const pieceLeft = bgRect.x
  // The notch's screen position.
  const scale = bgRect.width / (bgWidth || bgRect.width)
  const notchScreenX = bgRect.x + notchX * scale

  // The handle's centre is where the piece is grabbed.
  const knobCentre = knobRect.x + knobRect.width / 2
  let distance = notchScreenX - pieceLeft - knobCentre + knobRect.width / 2

  if (trackRect) {
    const maxTravel = trackRect.width - knobRect.width
    distance = Math.max(0, Math.min(distance, maxTravel))
  }
  return Math.round(distance)
}

/**
 * Solve a GeeTest slider challenge.
 *
 * @param {object} opts
 * @param {import('../../bidi/client.js').BidiClient} opts.client
 * @param {string} opts.contextId
 * @param {string} opts.topContextId
 * @param {object} opts.challenge
 * @param {string} opts.closedRootProp
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<object>}
 */
export async function solveGeetest(opts) {
  const { client, contextId, topContextId, challenge, closedRootProp } = opts
  const deadline = Date.now() + (opts.timeoutMs || 30000)

  const raw = await readGeometry(client, contextId, closedRootProp)
  if (!raw) {
    return {
      ok: false,
      status: 'geometry_unavailable',
      message:
        'The GeeTest slider could not be measured. The challenge may not have ' +
        'rendered, or this GeeTest version lays the puzzle out differently.',
    }
  }

  const { bg, piece, bgRect, knobRect, trackRect } = raw

  if (!bg || !piece) {
    return {
      ok: false,
      status: 'no_puzzle_canvas',
      message:
        'The GeeTest puzzle canvases were not found. This build locates the gap ' +
        'by reading the puzzle canvas; a variant that draws the images as plain ' +
        '<img> elements is not supported yet.',
      canvases: raw.canvases || [],
    }
  }

  const notch = findNotch(bg, piece)
  if (!notch) {
    return {
      ok: false,
      status: 'notch_not_found',
      message: 'The puzzle piece could not be matched against the background image.',
    }
  }

  const distance = computeDragDistance({
    notchX: notch.x,
    bgWidth: bg.width,
    bgRect,
    knobRect,
    trackRect,
  })

  if (distance <= 0) {
    return {
      ok: false,
      status: 'no_drag_distance',
      message: 'The gap was located but produced a drag distance of zero.',
      notch,
    }
  }

  const startX = knobRect.x + knobRect.width / 2
  const startY = knobRect.y + knobRect.height / 2

  try {
    await pointerDrag(client, {
      context: contextId,
      x: startX,
      y: startY,
      dx: distance,
      dy: 0,
      steps: 14,
    })
  } catch (err) {
    return {
      ok: false,
      status: 'drag_failed',
      message: `Could not dispatch the drag: ${err && err.message ? err.message : err}`,
      notch,
      distance,
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 2000))
  const tokenLength = await waitForToken(client, topContextId, challenge.tokenSelector, deadline)
  if (tokenLength > 0) {
    return { ok: true, status: 'solved', tokenLength, distance, notch }
  }

  // A GeeTest slider sometimes just marks itself solved without a token
  // field. Look for the widget's own "verified" marker before giving up.
  const verified = await readVerified(client, contextId, closedRootProp)
  if (verified) {
    return { ok: true, status: 'solved', tokenLength: 0, distance, notch, via: 'widget-state' }
  }

  return {
    ok: false,
    status: 'drag_rejected',
    message:
      'The slider was dragged to the detected gap but the challenge was not ' +
      'accepted. The gap estimate was probably off by a few pixels.',
    notch,
    distance,
  }
}

/**
 * Read the puzzle geometry out of the page.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} closedRootProp
 * @returns {Promise<object|null>}
 */
async function readGeometry(client, contextId, closedRootProp) {
  try {
    const remote = await evaluate(client, pixelsExpression(closedRootProp), contextId)
    const value = remote && remote.type === 'object' ? remote.value : remote
    return decodeGeometry(value)
  } catch {
    return null
  }
}

/**
 * Decode a geometry payload from its BiDi serialisation.
 *
 * @param {any} raw
 * @returns {object|null}
 */
function decodeGeometry(raw) {
  if (!raw) return null
  // BiDi serialises an object as an array of [key, value] pairs. Anything
  // else means the page did not return a geometry payload at all — treating
  // that as an empty object would report "no puzzle canvas" when the truth
  // is "the geometry could not be read".
  if (!Array.isArray(raw)) return null
  const out = {}
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length !== 2) continue
    const key = pair[0]
    const value = pair[1]
    if (value && typeof value === 'object' && value.type === 'object') {
      out[key] = decodeGeometry(value.value)
    } else if (value && typeof value === 'object' && value.type === 'array') {
      out[key] = (value.value || []).map((v) =>
        v && typeof v === 'object' && v.type === 'number' ? v.value : v,
      )
    } else if (value && typeof value === 'object') {
      out[key] = value.value
    } else {
      out[key] = value
    }
  }
  if (out.bg && typeof out.bg === 'object' && !Array.isArray(out.bg.data)) {
    out.bg.data = []
  }
  return out
}

/**
 * Look for the widget's own "solved" marker.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} closedRootProp
 * @returns {Promise<boolean>}
 */
async function readVerified(client, contextId, closedRootProp) {
  const expression = `(() => {
  const PROP = ${JSON.stringify(closedRootProp)};
  ${rootsSource('PROP')}
  for (const root of roots) {
    const hit = root.querySelector('.geetest_btn_right, .geetest_success, .geetest_box_right');
    if (hit) return true;
    for (const el of root.querySelectorAll('*')) {
      const cls = String(el.className || '');
      if (/(geetest_btn_right|geetest_success|verified|success)/.test(cls)) return true;
    }
  }
  return false;
})()`
  try {
    const remote = await evaluate(client, expression, contextId)
    return remote && remote.value === true
  } catch {
    return false
  }
}

/**
 * Poll for a token to appear.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} selector
 * @param {number} deadline
 * @returns {Promise<number>}
 */
async function waitForToken(client, contextId, selector, deadline) {
  for (;;) {
    const length = await readTokenLength(client, contextId, selector)
    if (length > 0) return length
    if (Date.now() >= deadline) return 0
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
}
