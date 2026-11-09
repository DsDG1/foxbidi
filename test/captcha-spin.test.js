// test/captcha-spin.test.js
// The Baidu "spin" captcha solver.
//
// Two things can be tested without a browser:
//   - the orientation maths, which is pure arithmetic over RGBA arrays;
//   - the angle-to-distance mapping the slider expects.
//
// The orientation test builds a SYNTHETIC picture with a known upright
// angle — sky-like flat area on top, buildings in the middle, rough ground
// below — rotates it, and asserts the solver finds the angle that puts it
// back upright. That is what replaces downloaded sample images.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { angleToDrag } from '../lib/firefox/captcha/spin.js'
import {
  bandStats,
  findUprightAngle,
  horizontalEdgeScore,
  lumaScore,
  rotateMasked,
  uprightScore,
} from '../lib/firefox/captcha/spin-orient.js'

/**
 * Deterministic noise, so a failing test always fails the same way.
 */
function hash2(x, y) {
  let h = x * 374761393 + y * 668265263
  h = (h ^ (h >> 13)) * 1274126177
  return ((h ^ (h >> 16)) >>> 0) / 4294967295
}

/**
 * Build a synthetic picture that looks upright.
 *
 * The layout mirrors what the solver expects from a photograph:
 *   - the top band is a flat bright gradient (sky, almost no edges)
 *   - the middle band has blocks with windows and ledges (the subject)
 *   - the bottom band is rough, darker texture (the ground)
 *
 * @param {number} size
 * @returns {{width: number, height: number, data: Uint8ClampedArray}}
 */
function makeScene(size = 160) {
  const data = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4
      let value
      if (y < size * 0.34) {
        value = 232 - (y / (size * 0.34)) * 30
      } else if (y < size * 0.7) {
        const block = Math.floor(x / (size / 7))
        const seed = hash2(block, 3)
        const roof = size * 0.34 + seed * size * 0.18
        if (y <= roof) {
          value = 150 + seed * 40
        } else {
          const win = (Math.floor((x % (size / 7)) / 4) + Math.floor((y - roof) / 6)) % 2
          value = win ? 60 + seed * 30 : 140 + seed * 40
        }
        if (y % 9 === 0) value = 250 - seed * 60
      } else {
        value = 70 + hash2(x, y) * 60
      }
      data[i] = value
      data[i + 1] = value
      data[i + 2] = value
      data[i + 3] = 255
    }
  }
  return { width: size, height: size, data }
}

/**
 * Rotate a picture, sampling bilinearly.
 *
 * @param {object} img
 * @param {number} deg
 * @returns {object}
 */
function rotate(img, deg) {
  const { width, height } = img
  const out = new Uint8ClampedArray(width * height * 4)
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const cx = width / 2
  const cy = height / 2
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const sx = cx + dx * cos + dy * sin - 0.5
      const sy = cy - dx * sin + dy * cos - 0.5
      const di = (y * width + x) * 4
      if (sx < 0 || sx > width - 1 || sy < 0 || sy > height - 1) continue
      const x0 = sx | 0
      const y0 = sy | 0
      const x1 = x0 + 1 < width ? x0 + 1 : x0
      const y1 = y0 + 1 < height ? y0 + 1 : y0
      const tx = sx - x0
      const ty = sy - y0
      for (let k = 0; k < 4; k++) {
        const top = img.data[(y0 * width + x0) * 4 + k] * (1 - tx) + img.data[(y0 * width + x1) * 4 + k] * tx
        const bottom = img.data[(y1 * width + x0) * 4 + k] * (1 - tx) + img.data[(y1 * width + x1) * 4 + k] * tx
        out[di + k] = top * (1 - ty) + bottom * ty
      }
    }
  }
  return { width, height, data: out }
}

/** Shortest distance between two angles, in degrees. */
function angleError(a, b) {
  const d = Math.abs(((a - b) % 360) + 360) % 360
  return d > 180 ? 360 - d : d
}

describe('spin: angle to drag distance', () => {
  test('a zero angle means no movement at all', () => {
    const drag = angleToDrag(0, 290)
    assert.equal(drag.distance, 0)
    assert.equal(drag.percent, 0)
  })

  test('half the track is half a turn', () => {
    const drag = angleToDrag(180, 290)
    assert.equal(drag.percent, 0.5)
    // 0.5 * (290 - 52) = 119, but the smallest distance that already rounds
    // to a half turn is 118.
    assert.ok(drag.distance === 118 || drag.distance === 119)
    assert.equal(drag.rotation, 180)
  })

  test('the reachable angles are multiples of 3.6 degrees', () => {
    // percent is rounded to two decimals, so 360 * percent can only be a
    // multiple of 3.6 degrees.
    for (const angle of [17, 91, 200, 271, 359]) {
      const drag = angleToDrag(angle, 290)
      const remainder = Math.abs((drag.rotation / 3.6) % 1)
      assert.ok(
        remainder < 1e-9 || remainder > 1 - 1e-9,
        `rotation ${drag.rotation} is not a multiple of 3.6`,
      )
    }
  })

  test('the chosen distance lands close to the requested angle', () => {
    for (const angle of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const drag = angleToDrag(angle, 290)
      assert.ok(
        angleError(drag.rotation, angle) <= 1.8 + 1e-9,
        `angle ${angle} mapped to ${drag.rotation}`,
      )
    }
  })

  test('the distance never exceeds the usable track', () => {
    const drag = angleToDrag(359.9, 290)
    assert.ok(drag.distance <= 290 - 52)
  })
})

describe('spin: upright scoring', () => {
  test('a mountain shaped detail profile scores high', () => {
    const mountain = [1, 6, 9, 9, 6, 3]
    assert.ok(uprightScore(mountain) > 5)
  })

  test('the same profile upside down scores far lower', () => {
    const mountain = [1, 6, 9, 9, 6, 3]
    const valley = mountain.slice().reverse()
    assert.ok(uprightScore(valley) < uprightScore(mountain) - 4)
  })

  test('a flat profile scores in the middle', () => {
    const flat = [5, 5, 5, 5, 5, 5]
    assert.ok(uprightScore(flat) > 0)
    assert.ok(uprightScore(flat) < uprightScore([1, 6, 9, 9, 6, 3]))
  })

  test('a brighter top is a positive signal', () => {
    assert.ok(lumaScore([230, 180, 140, 120, 90, 60]) > 0)
    assert.ok(lumaScore([60, 90, 120, 140, 180, 230]) < 0)
    assert.equal(lumaScore([100, 100]), 0)
  })
})

describe('spin: masked rotation', () => {
  test('pixels that fall outside the source are marked invalid', () => {
    const img = makeScene(80)
    const { luma, valid } = rotateMasked(img, 30)
    let invalid = 0
    for (let i = 0; i < valid.length; i += 1) if (!valid[i]) invalid += 1
    // A 30 degree turn leaves real wedges of filler behind.
    assert.ok(invalid > 0, 'expected some filler pixels')
    const centre = Math.floor(40) * 80 + Math.floor(40)
    assert.equal(valid[centre], 1, 'the centre must stay valid')
    assert.ok(luma[centre] > 0)
  })

  test('bands are read from the top of the picture downwards', () => {
    const img = makeScene(160)
    const { det, lum } = bandStats(img, 0)
    assert.equal(det.length, 6)
    assert.ok(lum[0] > lum[lum.length - 1], 'the top must be brighter')
    assert.ok(det[0] < det[2], 'the flat top band must carry less detail')
  })

  test('the horizontal edge score peaks on a level picture', () => {
    const img = makeScene(160)
    const level = horizontalEdgeScore(img, 0)
    const tilted = horizontalEdgeScore(img, 40)
    assert.ok(level > tilted, `level ${level} should beat tilted ${tilted}`)
  })
})

describe('spin: finding the upright angle', () => {
  // The scene is turned by `turned` degrees, so it has to be turned back by
  // 360 - turned degrees to become upright again.
  for (const turned of [0, 12, 23, 37, 47, 58, 90, 135, 180, 225, 270, 315]) {
    test(`finds the angle that un-rotates a picture turned by ${turned}`, () => {
      const rotated = rotate(makeScene(160), turned)
      const result = findUprightAngle(rotated)
      const expected = (360 - turned) % 360
      assert.ok(
        angleError(result.angle, expected) <= 8,
        `expected ~${expected}, got ${result.angle}`,
      )
    })
  }

  test('reports how far the winner stands out from the runner-up', () => {
    const rotated = rotate(makeScene(160), 60)
    const result = findUprightAngle(rotated)
    assert.ok(result.familyMargin > 1)
    assert.equal(result.candidates.length, 4)
  })
})
