// lib/firefox/captcha/spin-orient.js
// Find the rotation that makes a tilted photo upright.
//
// WHY A DEDICATED MODULE
//
// The "spin" captcha serves a photo that is ALREADY rotated off-axis. The
// task is to drag a slider until the picture looks right; the server checks
// the angle that was dragged. So the solver needs one number: the CSS
// rotation that puts the picture back the way it was shot.
//
// The measurement is pure image analysis on an RGBA buffer, with no image
// library involved — the plugin ships zero npm dependencies, and the pixels
// arrive already decoded (the browser decodes them; see spin.js).
//
// THE ALGORITHM
//
// A photo of a real place has two properties when it is upright:
//
//   1. Its dominant structures — building edges, poles, the horizon, rail
//      lines — run parallel to the frame axes. This is measured with a
//      weighted histogram of gradient orientations, scored with cos(4θ)
//      (so both horizontal and vertical count as "aligned").
//
//   2. The sky, if there is one, is at the TOP. This is what breaks the
//      90-degree ambiguity of property 1: cos(4θ) cannot tell "rotated 0°"
//      from "rotated 90°", so the four candidates that share a cos(4θ) peak
//      are separated by where the blue pixels ended up.
//
// Property 1 narrows 360° down to four candidates 90° apart; property 2
// picks the right one; then property 1 refines within ±8° of that pick.
//
// The result is an ANGLE, not a distance: the caller converts it, because
// the slider quantises the angle into steps (into 3.6° steps).

/**
 * A decoded image, ready for analysis.
 *
 * @typedef {object} ImageBuffer
 * @property {number} width
 * @property {number} height
 * @property {Uint8ClampedArray|number[]} data  RGBA, row-major
 */

/**
 * Convert an RGBA buffer to a Float64Array of luma.
 *
 * @param {ImageBuffer} img
 * @returns {Float64Array}
 */
export function toLuma(img) {
  const { width, height, data } = img
  const out = new Float64Array(width * height)
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    out[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }
  return out
}

/**
 * Build the circular mask that covers the captcha's disc.
 *
 * The photo is served as a square JPEG with the corners already cropped to a
 * circle by CSS, so the white corners carry no scene information and would
 * pollute the orientation statistics.
 *
 * @param {ImageBuffer} img
 * @param {number} [inset] fraction of the radius kept
 * @returns {Uint8Array} 1 inside the disc, 0 outside
 */
export function discMask(img, inset = 0.95) {
  const { width, height } = img
  const mask = new Uint8Array(width * height)
  const cx = width / 2
  const cy = height / 2
  const r = Math.min(cx, cy) * inset
  const r2 = r * r
  for (let y = 0; y < height; y += 1) {
    const dy = y - cy
    for (let x = 0; x < width; x += 1) {
      const dx = x - cx
      if (dx * dx + dy * dy <= r2) mask[y * width + x] = 1
    }
  }
  return mask
}

/**
 * Score every angle by how axis-aligned the scene's structures are.
 *
 * The score is cos(4θ)-based, which is why it repeats every 90°: that is
 * intentional and is what property 2 later resolves.
 *
 * @param {ImageBuffer} img
 * @param {object} [opts]
 * @param {Uint8Array} [opts.mask]
 * @param {number} [opts.bins] histogram resolution
 * @returns {Float64Array} one score per degree
 */
export function alignmentScores(img, opts = {}) {
  const { width, height } = img
  const mask = opts.mask || discMask(img)
  const bins = opts.bins || 720
  const luma = toLuma(img)

  // Weighted histogram of gradient orientation (mod π).
  const hist = new Float64Array(bins)
  const binAngle = Math.PI / bins
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * width + x
      if (!mask[p]) continue
      const gx = luma[p + 1] - luma[p - 1]
      const gy = luma[p + width] - luma[p - width]
      const mag = Math.hypot(gx, gy)
      if (mag < 12) continue
      let a = Math.atan2(gy, gx)
      if (a < 0) a += Math.PI
      const b = Math.floor(a / binAngle) % bins
      hist[b] += mag
    }
  }
  let total = 0
  for (let i = 0; i < bins; i += 1) total += hist[i]
  if (total > 0) {
    for (let i = 0; i < bins; i += 1) hist[i] /= total
  }

  const scores = new Float64Array(360)
  for (let c = 0; c < 360; c += 1) {
    // The histogram is shifted by +c: the score is the correlation of the
    // edge directions with the axis-aligned axes, and the answer (the angle
    // that makes the picture upright) is the negative of the direction the
    // edges currently have. Both sides use the same convention.
    const shift = (c * Math.PI) / 180
    let s = 0
    for (let b = 0; b < bins; b += 1) {
      let na = (b + 0.5) * binAngle + shift
      na %= Math.PI
      if (na < 0) na += Math.PI
      s += hist[b] * Math.cos(4 * na)
    }
    scores[c] = s
  }
  return scores
}

/**
 * Rotate an RGBA buffer by a CSS angle (clockwise degrees).
 *
 * @param {ImageBuffer} img
 * @param {number} deg
 * @returns {ImageBuffer}
 */
export function rotateImage(img, deg) {
  const { width, height, data } = img
  const out = new Uint8ClampedArray(width * height * 4)
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const cx = width / 2
  const cy = height / 2
  // Inverse map: destination pixel -> source pixel.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - cx + 0.5
      const dy = y - cy + 0.5
      const sx = cx + dx * cos - dy * sin
      const sy = cy + dx * sin + dy * cos
      const di = (y * width + x) * 4
      const fx = Math.floor(sx)
      const fy = Math.floor(sy)
      if (fx < 0 || fy < 0 || fx >= width - 1 || fy >= height - 1) {
        out[di] = 255
        out[di + 1] = 255
        out[di + 2] = 255
        out[di + 3] = 255
        continue
      }
      const tx = sx - fx
      const ty = sy - fy
      const i00 = (fy * width + fx) * 4
      const i10 = i00 + 4
      const i01 = i00 + width * 4
      const i11 = i01 + 4
      for (let k = 0; k < 4; k += 1) {
        const top = data[i00 + k] * (1 - tx) + data[i10 + k] * tx
        const bottom = data[i01 + k] * (1 - tx) + data[i11 + k] * tx
        out[di + k] = top * (1 - ty) + bottom * ty
      }
    }
  }
  return { width, height, data: out }
}

/**
 * Edge density as a function of vertical position in a rotated image.
 *
 * Six bands from top to bottom. The disc mask keeps the white corners out.
 *
 * @param {ImageBuffer} img  already rotated
 * @param {number} [bands]
 * @returns {number[]}
 */
export function edgeProfile(img, bands = 6) {
  const { width, height } = img
  const luma = toLuma(img)
  const mask = discMask(img)
  const out = []
  for (let b = 0; b < bands; b += 1) {
    const y0 = Math.floor((b * height) / bands)
    const y1 = Math.floor(((b + 1) * height) / bands)
    let sum = 0
    let count = 0
    for (let y = y0; y < y1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const p = y * width + x
        if (!mask[p]) continue
        const gx = luma[p + 1] - luma[p - 1]
        const gy = luma[p + width] - luma[p - width]
        sum += Math.sqrt(gx * gx + gy * gy)
        count += 1
      }
    }
    out.push(count ? sum / count : 0)
  }
  return out
}

/**
 * Score how "upright" a rotated image looks, from its vertical detail
 * distribution.
 *
 * THIS IS THE CRUX of telling four 90-degree-apart candidates apart.
 *
 * An upright photograph of a place has a characteristic shape to its detail
 * distribution: the top of the frame is distant scenery (sky, far buildings,
 * a plain wall) and carries almost NO edges, the middle carries the subject,
 * and the bottom tapers again (foreground pavement, or the frame's own edge).
 * So the vertical edge-density profile is roughly MOUNTAIN shaped — sparse,
 * dense, tapering.
 *
 * Rotate that picture 180 degrees and the mountain becomes a valley. Rotate it
 * 90 degrees and the profile flattens out. That asymmetry is what breaks the
 * 90-degree ambiguity of the axis-alignment score, and unlike a "blue sky at
 * the top" test it does not care whether the sky is blue, grey, or absent —
 * an overcast sky still has far less detail than the street below it.
 *
 * @param {number[]} profile  output of edgeProfile()
 * @returns {number} higher is more upright
 */
export function uprightScore(profile) {
  const p = profile
  if (!p || p.length < 4) return 0
  const top = p[0]
  const bottom = p[p.length - 1]
  const middle = p.slice(1, -1).reduce((a, b) => a + b, 0) / (p.length - 2)
  const min = Math.min(...p)

  // The top band must be the sparsest region of the frame.
  const topIsMin = top <= min + 1e-9 ? 1 : 0
  // ...and the bottom band must NOT be, otherwise the picture is upside down.
  const bottomNotMin = bottom > min + 1e-9 ? 1 : 0
  // How much more detail the middle carries than the top.
  const topMargin = (middle - top) / (middle + 1e-6)
  // How much more detail the middle carries than both ends.
  const midDominant = (middle - 0.5 * (top + bottom)) / (middle + 1e-6)

  return 3 * topIsMin + 3 * bottomNotMin + topMargin + midDominant
}

/**
 * Score how much a rotated image looks like "sky at the top".
 *
 * The sky is the bluish, bright part of the frame. For the upright
 * orientation that region sits high in the picture, so the score is higher
 * when the bluish pixels cluster near the top edge.
 *
 * This is a WEAK signal on purpose: it only fires on a clear blue sky, so it
 * is used as a tie-breaker, never as the primary decider.
 *
 * @param {ImageBuffer} img  already rotated
 * @returns {number} higher is more sky-like
 */
export function skyScore(img) {
  const { width, height, data } = img
  const band = Math.max(4, Math.round(height / 12))
  let skyCount = 0
  let skyTop = 0
  let sumY = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const lum = (r + g + b) / 3
      const blueness = b - (r + g) / 2
      if (blueness > 8 && lum > 110) {
        skyCount += 1
        sumY += y
        if (y < band) skyTop += 1
      }
    }
  }
  if (skyCount < (width * height) / 400) return -100
  const centroid = sumY / skyCount / height
  const topRatio = skyTop / (skyCount + 1e-9)
  return -centroid + topRatio
}

/**
 * Standardise a score array so two different metrics can be added.
 *
 * @param {Float64Array|number[]} values
 * @returns {Float64Array}
 */
function zscore(values) {
  const out = new Float64Array(values.length)
  let mean = 0
  for (const v of values) mean += v
  mean /= values.length || 1
  let variance = 0
  for (const v of values) variance += (v - mean) * (v - mean)
  const sd = Math.sqrt(variance / (values.length || 1)) || 1e-9
  for (let i = 0; i < values.length; i += 1) out[i] = (values[i] - mean) / sd
  return out
}

/**
 * Rotate a picture by a CSS angle and report which pixels are real.
 *
 * Rotating a square photo leaves wedges of filler outside the circle. Those
 * wedges have hard edges which would dominate every band statistic, so a
 * pixel is only "valid" when it maps back INSIDE the source photo.
 *
 * The rotation convention matches the page side: positive angles turn the
 * picture clockwise, and the mapping is the inverse of the canvas transform
 * (destination pixel -> source pixel).
 *
 * @param {ImageBuffer} img
 * @param {number} deg
 * @returns {{luma: Float64Array, valid: Uint8Array}}
 */
export function rotateMasked(img, deg) {
  const { width, height } = img
  const luma = toLuma(img)
  const out = new Float64Array(width * height)
  const valid = new Uint8Array(width * height)
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const cx = width / 2
  const cy = height / 2
  // Bilinear sampling, not nearest neighbour. Nearest neighbour turns every
  // edge into a staircase, and those staircases carry their own edge
  // directions: the gradient histogram of a rotated picture then describes
  // the sampling grid instead of the scene, which throws the angle estimate
  // off by many degrees.
  for (let y = 0; y < height; y += 1) {
    const dy = y + 0.5 - cy
    for (let x = 0; x < width; x += 1) {
      const dx = x + 0.5 - cx
      const sx = dx * cos + dy * sin + cx - 0.5
      const sy = -dx * sin + dy * cos + cy - 0.5
      if (sx < 0 || sx > width - 1 || sy < 0 || sy > height - 1) continue
      const x0 = sx | 0
      const y0 = sy | 0
      const x1 = x0 + 1 < width ? x0 + 1 : x0
      const y1 = y0 + 1 < height ? y0 + 1 : y0
      const tx = sx - x0
      const ty = sy - y0
      const top = luma[y0 * width + x0] * (1 - tx) + luma[y0 * width + x1] * tx
      const bottom = luma[y1 * width + x0] * (1 - tx) + luma[y1 * width + x1] * tx
      const p = y * width + x
      out[p] = top * (1 - ty) + bottom * ty
      valid[p] = 1
    }
  }
  return { luma: out, valid }
}

/**
 * Per-band detail and brightness of a rotated picture.
 *
 * Bands run from the top of the frame to the bottom. Only pixels inside the
 * disc AND backed by real image data are counted.
 *
 * @param {ImageBuffer} img
 * @param {number} deg
 * @param {number} [bands]
 * @returns {{det: number[], lum: number[]}}
 */
export function bandStats(img, deg, bands = 6) {
  const { width, height } = img
  const { luma: rot, valid } = rotateMasked(img, deg)
  const cx = width / 2
  const cy = height / 2
  const discR2 = Math.pow((Math.min(width, height) / 2) * 0.9, 2)
  const det = new Array(bands).fill(0)
  const lum = new Array(bands).fill(0)
  const cnt = new Array(bands).fill(0)
  for (let y = 1; y < height - 1; y += 1) {
    const dy = y - cy
    const b = Math.min(bands - 1, Math.floor((y * bands) / height))
    for (let x = 1; x < width - 1; x += 1) {
      const dx = x - cx
      if (dx * dx + dy * dy > discR2) continue
      const p = y * width + x
      if (!valid[p] || !valid[p - 1] || !valid[p + 1] || !valid[p - width] || !valid[p + width]) {
        continue
      }
      const gx = rot[p + 1] - rot[p - 1]
      const gy = rot[p + width] - rot[p - width]
      det[b] += Math.sqrt(gx * gx + gy * gy)
      lum[b] += rot[p]
      cnt[b] += 1
    }
  }
  for (let b = 0; b < bands; b += 1) {
    if (cnt[b] > 0) {
      det[b] /= cnt[b]
      lum[b] /= cnt[b]
    }
  }
  return { det, lum }
}

/**
 * How much of a picture's edge energy lies on HORIZONTAL edges.
 *
 * The alignment score treats horizontal and vertical edges alike and folds
 * them into a 90-degree period, so its peak can sit a few degrees away from
 * the true upright angle. A picture that is upright has its horizon, roof
 * lines and other horizontal structures level, and this score peaks there.
 *
 * @param {ImageBuffer} img
 * @param {number} deg
 * @returns {number}
 */
export function horizontalEdgeScore(img, deg) {
  const { width, height } = img
  const { luma: rot, valid } = rotateMasked(img, deg)
  const cx = width / 2
  const cy = height / 2
  const discR2 = Math.pow((Math.min(width, height) / 2) * 0.9, 2)
  let sum = 0
  for (let y = 1; y < height - 1; y += 1) {
    const dy = y - cy
    for (let x = 1; x < width - 1; x += 1) {
      const dx = x - cx
      if (dx * dx + dy * dy > discR2) continue
      const p = y * width + x
      if (!valid[p] || !valid[p - 1] || !valid[p + 1] || !valid[p - width] || !valid[p + width]) {
        continue
      }
      const gx = rot[p + 1] - rot[p - 1]
      const gy = rot[p + width] - rot[p - width]
      const mag = Math.hypot(gx, gy)
      if (mag < 8) continue
      let a = (Math.atan2(gy, gx) * 180) / Math.PI
      if (a < 0) a += 180
      let d = Math.abs(a - 90)
      if (d > 90) d = 180 - d
      sum += mag * Math.exp(-(d * d) / (2 * 25 * 25))
    }
  }
  return sum
}

/**
 * Score how much brighter the top of a picture is than its bottom.
 *
 * Sky is brighter than the ground, so an upright picture is brighter at the
 * top. This is a weak but independent signal; it only decides between
 * candidates the detail profile cannot separate.
 *
 * @param {number[]} bands  output of bandStats().lum
 * @returns {number}
 */
export function lumaScore(bands) {
  if (!bands || bands.length < 2) return 0
  return (bands[0] - bands[bands.length - 1]) / 255
}

/**
 * Find the CSS rotation that makes the picture upright.
 *
 * @param {ImageBuffer} img
 * @param {object} [opts]
 * @param {number} [opts.refineSpan] degrees searched around the coarse pick
 * @returns {{angle: number, candidates: number[], confidence: number}}
 */
export function findUprightAngle(img, opts = {}) {
  const refineSpan = opts.refineSpan === undefined ? 12 : opts.refineSpan
  const align = alignmentScores(img)

  // Step 1: the global alignment peak.
  let peak = 0
  for (let c = 1; c < 360; c += 1) if (align[c] > align[peak]) peak = c

  // Step 2: the four angles 90° apart that share the peak.
  const candidates = []
  for (let k = 0; k < 4; k += 1) candidates.push((peak + k * 90) % 360)

  // Step 3: pick the family member that looks upright. The vertical
  //         detail-profile score is the primary decider; the top-versus-
  //         bottom brightness only breaks ties, because it is silent on
  //         pictures whose sky is as dark as the ground.
  const stats = candidates.map((c) => bandStats(img, c))
  const familyDetail = stats.map((s) => uprightScore(s.det))
  const familyLuma = stats.map((s) => lumaScore(s.lum))
  // The detail profile is the stronger signal, but it cannot tell a
  // picture from its upside-down twin on its own. The brightness term is
  // weighted up so it can break such ties.
  const familyScores = familyDetail.map((d, i) => d + 3 * familyLuma[i])
  let bestIdx = 0
  for (let i = 1; i < candidates.length; i += 1) {
    if (familyScores[i] > familyScores[bestIdx]) bestIdx = i
  }
  const best = candidates[bestIdx]

  // Step 4: refine within ±refineSpan. The alignment score is smooth and
  //         single-peaked around the winner, but it can sit a few degrees
  //         off, so it is combined with the horizontal-edge score, which
  //         peaks where the picture's horizon is level.
  const window = []
  for (let i = -refineSpan; i <= refineSpan; i += 1) window.push((best + i + 360) % 360)
  const alignPart = zscore(window.map((c) => align[c]))
  const edgePart = zscore(window.map((c) => horizontalEdgeScore(img, c)))
  let refineIdx = 0
  for (let i = 0; i < window.length; i += 1) {
    if (alignPart[i] + 0.5 * edgePart[i] > alignPart[refineIdx] + 0.5 * edgePart[refineIdx]) {
      refineIdx = i
    }
  }
  const angle = window[refineIdx]

  // Confidence: how far the winner stands out from the runner-up family member.
  const sorted = familyScores.slice().sort((a, b) => b - a)
  const margin = sorted[0] - sorted[1]

  return {
    angle,
    candidates,
    familyMargin: margin,
    alignmentPeak: peak,
    familyDetail,
    familyLuma,
    familyScores,
  }
}

/**
 * Convert an angle into the slider distance the spin widget expects.
 *
 * The widget computes `percent = round(distance / (trackWidth - 52), 2)` and
 * rotates the image by `360 * percent` degrees. Because percent is rounded to
 * two decimals, the reachable angles are multiples of 3.6° — so the distance
 * is chosen to land on the nearest reachable angle, not the nearest pixel.
 *
 * @param {number} angle      the desired CSS rotation in degrees
 * @param {number} trackWidth the slider track's width in CSS pixels
 * @returns {{distance: number, percent: number, rotation: number, error: number}}
 */
export function angleToDrag(angle, trackWidth) {
  const span = Math.max(1, trackWidth - 52)
  let best = null
  for (let d = 0; d <= span; d += 1) {
    const percent = Math.round((d / span) * 100) / 100
    const rotation = 360 * percent
    let error = Math.abs(((((rotation - angle + 180) % 360) + 360) % 360) - 180)
    if (!best || error < best.error) best = { distance: d, percent, rotation, error }
  }
  return best
}
