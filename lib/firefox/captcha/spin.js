// lib/firefox/captcha/spin.js
// Solve the "spin" captcha — a photo that has to be dragged back upright.
//
// WHAT THE CHALLENGE IS
//
// The site serves a photo that has ALREADY been rotated off-axis, inside a
// circular frame, with a slider underneath. The instruction is "拖动左侧滑块
// 使图片为正" — drag the slider until the picture is straight. The server
// checks the ANGLE that was dragged, not the final pixels: the page reports
// `percent = round(distance / (trackWidth - 52), 2)` and rotates the picture
// by `360 * percent` degrees.
//
// So the whole problem reduces to ONE number: the rotation that makes the
// picture upright. Get it, convert it to a distance, drag.
//
// WHY THE ANGLE IS COMPUTED IN THE PAGE
//
// The photo is a cross-origin JPEG. Two consequences:
//
//   1. Drawing the page's own <img> onto a canvas TAINTS it, and
//      `getImageData` then throws SecurityError. So the bytes are fetched
//      separately (the endpoint sends permissive CORS headers) and decoded
//      with `createImageBitmap` — a bitmap decoded from those bytes is
//      untainted, and drawing THAT onto a canvas is safe.
//
//   2. The pixels never leave the browser. The orientation analysis runs
//      there too, and only the resulting angle comes back. That keeps a
//      350x350 RGBA buffer (490 KB) off the BiDi wire.
//
// WHY IT ALL HAPPENS IN ONE PAGE CALL
//
// The captcha page reloads itself when the picture is refreshed, and the
// BiDi command queue is serialised — a long-running evaluation blocks every
// later command. So the fetch, the decode, and the analysis are issued as a
// single expression, and nothing waits on a second round trip.

import { evaluate, unwrapRemoteValue } from '../../bidi/protocol.js'
import { pointerClick, pointerDrag } from '../inputs.js'
import { rootsSource } from './roots.js'

/**
 * The page-side routine that measures the picture and reports the angle.
 *
 * It is written as a string because it runs inside the page. The steps:
 *
 *   - fetch the image bytes (CORS-enabled endpoint)
 *   - decode with createImageBitmap, then read pixels from a clean canvas
 *   - histogram of gradient orientations -> axis-alignment score per angle
 *   - masked rotation -> per-band detail and brightness of each candidate
 *   - pick the candidate whose profile looks like an upright photo
 *
 * @param {string} closedRootProp
 * @returns {string} an expression
 */
function measureExpression(closedRootProp) {
  return `(() => {
  const PROP = ${JSON.stringify(closedRootProp)};
  ${rootsSource('PROP')}
  // rootsSource collects CLOSED shadow roots only. A spin widget lives in the
  // plain document, so the document itself has to be searched too.
  const searchRoots = [document].concat(roots);
  const find = (sels) => {
    for (const root of searchRoots) {
      for (const sel of sels) {
        let el = null;
        try { el = root.querySelector(sel); } catch (e) { el = null; }
        if (el) return el;
      }
    }
    return null;
  };
  const bg = find(['.passMod_spin-background']);
  if (!bg) return JSON.stringify({ ok: false, reason: 'no_background' });
  const knob = find(['.passMod_slide-btn']);
  const track = find(['.passMod_slide-control']);
  const image = find(['.passMod_spin-context']);
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const info = {
    ok: true,
    src: bg.src,
    knobRect: rectOf(knob),
    trackRect: rectOf(track),
    imageRect: rectOf(image) || rectOf(bg),
    naturalWidth: bg.naturalWidth,
    naturalHeight: bg.naturalHeight,
  };
  if (!knob || !track) return JSON.stringify({ ok: false, reason: 'no_slider', info: info });

  // --- fetch + decode -------------------------------------------------------
  const finish = (bmp) => {
    const W = bmp.width, H = bmp.height;
    const cxm = W / 2, cym = H / 2;

    // Source greyscale. The bitmap is untainted (it was decoded from fetched
    // bytes), so reading pixels back is safe.
    const srcCanvas = new OffscreenCanvas(W, H);
    const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
    srcCtx.drawImage(bmp, 0, 0);
    const sd = srcCtx.getImageData(0, 0, W, H).data;
    const gray = new Float64Array(W * H);
    for (let i = 0, p = 0; i < sd.length; i += 4, p += 1) {
      gray[p] = 0.299 * sd[i] + 0.587 * sd[i + 1] + 0.114 * sd[i + 2];
    }

    // --- axis alignment ------------------------------------------------------
    // Gradient directions are folded modulo 180 degrees, so a cos(4*theta)
    // score is maximal when the dominant edges are horizontal or vertical.
    // That fixes the orientation up to a multiple of 90 degrees.
    const alignR = Math.min(W, H) / 2 * 0.95;
    const alignR2 = alignR * alignR;
    const NB = 1440;
    const hist = new Float64Array(NB);
    for (let y = 1; y < H - 1; y += 1) {
      const dy = y - cym;
      for (let x = 1; x < W - 1; x += 1) {
        const dx = x - cxm;
        if (dx * dx + dy * dy > alignR2) continue;
        const p = y * W + x;
        const gx = gray[p + 1] - gray[p - 1];
        const gy = gray[p + W] - gray[p - W];
        const m2 = gx * gx + gy * gy;
        if (m2 < 144) continue;
        let a = Math.atan2(gy, gx);
        if (a < 0) a += Math.PI;
        let bi = (a / (Math.PI / NB)) | 0;
        if (bi >= NB) bi = NB - 1;
        hist[bi] += Math.sqrt(m2);
      }
    }
    let A = 0, B = 0;
    for (let b = 0; b < NB; b += 1) {
      const a = (b + 0.5) * Math.PI / NB;
      A += hist[b] * Math.cos(4 * a);
      B += hist[b] * Math.sin(4 * a);
    }
    const align = new Float64Array(360);
    for (let c = 0; c < 360; c += 1) {
      const t = 4 * c * Math.PI / 180;
      align[c] = A * Math.cos(t) - B * Math.sin(t);
    }
    let peak = 0;
    for (let c = 1; c < 360; c += 1) if (align[c] > align[peak]) peak = c;

    // --- masked rotation -----------------------------------------------------
    // Rotating a square photo leaves wedges of filler outside the circle.
    // Those wedges have hard edges and would dominate every band statistic,
    // so a pixel only counts when it maps back INSIDE the source photo.
    //
    // The sampling is bilinear. Nearest neighbour turns every edge into a
    // staircase, and the staircase has its own edge directions, which drags
    // the angle estimate off by several degrees.
    const discR2 = Math.pow(Math.min(W, H) / 2 * 0.9, 2);
    const BANDS = 6;

    const rotateGray = (deg) => {
      const rad = deg * Math.PI / 180;
      const cs = Math.cos(rad), sn = Math.sin(rad);
      const rot = new Float64Array(W * H);
      const okv = new Uint8Array(W * H);
      for (let y = 0; y < H; y += 1) {
        const dy = y + 0.5 - cym;
        for (let x = 0; x < W; x += 1) {
          const dx = x + 0.5 - cxm;
          const sx = dx * cs + dy * sn + cxm - 0.5;
          const sy = -dx * sn + dy * cs + cym - 0.5;
          if (sx < 0 || sx > W - 1 || sy < 0 || sy > H - 1) continue;
          const x0 = sx | 0, y0 = sy | 0;
          const x1 = x0 + 1 < W ? x0 + 1 : x0;
          const y1 = y0 + 1 < H ? y0 + 1 : y0;
          const tx = sx - x0, ty = sy - y0;
          const top = gray[y0 * W + x0] * (1 - tx) + gray[y0 * W + x1] * tx;
          const bottom = gray[y1 * W + x0] * (1 - tx) + gray[y1 * W + x1] * tx;
          const p = y * W + x;
          rot[p] = top * (1 - ty) + bottom * ty;
          okv[p] = 1;
        }
      }
      return { rot: rot, okv: okv };
    };

    // Per-band detail and brightness of a rotated picture.
    const bandStats = (rot, okv) => {
      const det = new Float64Array(BANDS);
      const lum = new Float64Array(BANDS);
      const cnt = new Float64Array(BANDS);
      for (let y = 1; y < H - 1; y += 1) {
        const dy = y - cym;
        const b = Math.min(BANDS - 1, Math.floor(y * BANDS / H));
        for (let x = 1; x < W - 1; x += 1) {
          const dx = x - cxm;
          if (dx * dx + dy * dy > discR2) continue;
          const p = y * W + x;
          if (!okv[p] || !okv[p - 1] || !okv[p + 1] || !okv[p - W] || !okv[p + W]) continue;
          const gx = rot[p + 1] - rot[p - 1];
          const gy = rot[p + W] - rot[p - W];
          det[b] += Math.sqrt(gx * gx + gy * gy);
          lum[b] += rot[p];
          cnt[b] += 1;
        }
      }
      for (let b = 0; b < BANDS; b += 1) {
        if (cnt[b] > 0) { det[b] /= cnt[b]; lum[b] /= cnt[b]; }
      }
      return { det: det, lum: lum };
    };

    // How much of the picture's edge energy lies on HORIZONTAL edges.
    //
    // The alignment score above treats horizontal and vertical edges alike
    // and folds them into a 90-degree period, so its peak can sit a few
    // degrees away from the true upright angle. A picture that is upright has
    // its horizon, roof lines and other horizontal structures level, and this
    // score peaks there. It is used next to the alignment score to pull the
    // final angle in.
    const hscore = (rot, okv) => {
      let sum = 0;
      for (let y = 1; y < H - 1; y += 1) {
        const dy = y - cym;
        for (let x = 1; x < W - 1; x += 1) {
          const dx = x - cxm;
          if (dx * dx + dy * dy > discR2) continue;
          const p = y * W + x;
          if (!okv[p] || !okv[p - 1] || !okv[p + 1] || !okv[p - W] || !okv[p + W]) continue;
          const gx = rot[p + 1] - rot[p - 1];
          const gy = rot[p + W] - rot[p - W];
          const mag = Math.sqrt(gx * gx + gy * gy);
          if (mag < 8) continue;
          let a = Math.atan2(gy, gx) * 180 / Math.PI;
          if (a < 0) a += 180;
          let d = Math.abs(a - 90);
          if (d > 90) d = 180 - d;
          sum += mag * Math.exp(-(d * d) / (2 * 25 * 25));
        }
      }
      return sum;
    };

    // An upright photo has a mountain-shaped detail profile: sparse at the top
    // (distant scenery), dense in the middle, tapering at the bottom. Upside
    // down it becomes a valley; sideways it flattens.
    const uprightScore = (profile) => {
      if (!profile || profile.length < 4) return 0;
      const top = profile[0];
      const bottom = profile[profile.length - 1];
      const middle = profile.slice(1, -1).reduce((a, b) => a + b, 0) / (profile.length - 2);
      let min = Infinity;
      for (const v of profile) if (v < min) min = v;
      const topIsMin = top <= min + 1e-9 ? 1 : 0;
      const bottomNotMin = bottom > min + 1e-9 ? 1 : 0;
      const topMargin = (middle - top) / (middle + 1e-6);
      const midDominant = (middle - 0.5 * (top + bottom)) / (middle + 1e-6);
      return 3 * topIsMin + 3 * bottomNotMin + topMargin + midDominant;
    };

    // Sky is brighter than the ground, so an upright picture is brighter at
    // the top than at the bottom. This is a weak but independent signal; it
    // only matters when the detail profile cannot separate the candidates.
    const lumaScore = (bands) => {
      if (!bands || bands.length < 2) return 0;
      return (bands[0] - bands[bands.length - 1]) / 255;
    };

    const zscore = (values) => {
      let m = 0;
      for (const v of values) m += v;
      m /= values.length || 1;
      let sd = 0;
      for (const v of values) sd += (v - m) * (v - m);
      sd = Math.sqrt(sd / (values.length || 1)) || 1e-9;
      return values.map((v) => (v - m) / sd);
    };

    // --- which of the four candidates is upright? ----------------------------
    const fam = [0, 1, 2, 3].map((k) => (peak + k * 90) % 360);
    const stats = fam.map((c) => {
      const r = rotateGray(c);
      return { bands: bandStats(r.rot, r.okv), h: hscore(r.rot, r.okv) };
    });
    const familyDetail = stats.map((s) => uprightScore(s.bands.det));
    const familyLuma = stats.map((s) => lumaScore(s.bands.lum));
    // The detail profile is the stronger signal, but it cannot tell a
    // picture from its upside-down twin on its own. The brightness term is
    // weighted up so it can break such ties.
    const familyScores = familyDetail.map((d, i) => d + 3 * familyLuma[i]);
    let bestIdx = 0;
    for (let i = 1; i < 4; i += 1) if (familyScores[i] > familyScores[bestIdx]) bestIdx = i;
    const pick = fam[bestIdx];

    // --- final angle ---------------------------------------------------------
    // Search a narrow window around the winning candidate and combine the
    // alignment score with the horizontal-edge score.
    const SPAN = 12;
    const win = [];
    for (let d = -SPAN; d <= SPAN; d += 1) win.push((pick + d + 360) % 360);
    const hvals = win.map((c) => {
      const r = rotateGray(c);
      return hscore(r.rot, r.okv);
    });
    const az = zscore(win.map((c) => align[c]));
    const hz = zscore(hvals);
    let refineIdx = 0;
    for (let i = 0; i < win.length; i += 1) {
      if (az[i] + 0.5 * hz[i] > az[refineIdx] + 0.5 * hz[refineIdx]) refineIdx = i;
    }
    const angle = win[refineIdx];

    const sorted = familyScores.slice().sort((a, b) => b - a);
    return {
      ok: true,
      info: info,
      angle: angle,
      family: fam,
      familyScores: familyScores,
      familyDetail: familyDetail,
      familyLuma: familyLuma,
      familyMargin: sorted[0] - sorted[1],
      alignmentPeak: peak,
      width: W,
      height: H,
    };
  };

  // --- capture the server's verdict -----------------------------------------
  // The captcha posts the attempt to /cap/log and the answer is in data.op:
  // 1 or 2 = accepted, 3 = rejected.
  //
  // The page reloads itself right after a rejected attempt, which destroys
  // any state kept on window. Two things make the capture survive that:
  //
  //   - the verdict is mirrored into localStorage, which survives a reload;
  //   - the response body is captured by listening for the request's 'load'
  //     event. The listener is registered at send() time, so it runs right
  //     after the page's own handler; the page reacts by swapping the
  //     picture about half a second later, which leaves enough time.
  const LS_KEY = '__ffb_spin_verdict';
  const record = (v) => {
    const payload = {
      status: v.status,
      op: v.op,
      opp: v.opp,
      msg: v.msg,
    };
    window.__ffbSpinVerdict = payload;
    try { localStorage.setItem(LS_KEY, JSON.stringify(payload)); } catch (e) {}
  };
  const capture = (raw) => {
    let parsed = null;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    } else if (raw && typeof raw === 'object') {
      parsed = raw;
    }
    if (!parsed) return;
    const data = parsed.data || {};
    record({
      status: 200,
      op: data.op,
      opp: data.opp,
      msg: parsed.msg,
    });
  };

  if (!window.__ffbSpinHooked) {
    window.__ffbSpinHooked = true;

    const proto = XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;
    proto.open = function (m, u, ...rest) {
      this.__ffbUrl = u;
      return origOpen.call(this, m, u, ...rest);
    };
    proto.send = function (body) {
      const url = String(this.__ffbUrl || '');
      if (url.indexOf('/cap/log') !== -1) {
        this.addEventListener('load', () => {
          try { capture(this.responseText); } catch (e) {}
        });
        this.addEventListener('error', () => {
          record({ status: 'error', msg: 'network' });
        });
      }
      return origSend.call(this, body);
    };

    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const p = origFetch.call(this, input, init);
        if (String(url).indexOf('/cap/log') !== -1) {
          p.then((res) => {
            try {
              const clone = res.clone();
              clone.text().then((t) => capture(t)).catch(() => {});
            } catch (e) {}
          }).catch(() => {});
        }
        return p;
      };
    }
  }

  // Kick the fetch off. The promise is chained but the RESULT is returned
  // synchronously-ish: the caller polls, because the page may reload.
  // Clear any verdict left over from a previous round so the next one is
  // unambiguous.
  window.__ffbSpinVerdict = null;
  try { localStorage.removeItem(LS_KEY); } catch (e) {}
  window.__ffbSpin = { state: 'pending' };
  fetch(bg.src, { mode: 'cors', credentials: 'omit' })
    .then((r) => r.arrayBuffer())
    .then((buf) => createImageBitmap(new Blob([buf], { type: 'image/jpeg' })))
    .then((bmp) => {
      const res = finish(bmp);
      window.__ffbSpin = { state: 'done', result: res, info: info };
    })
    .catch((e) => {
      window.__ffbSpin = { state: 'error', error: String(e), info: info };
    });
  return JSON.stringify({ ok: true, started: true, info: info });
})()`
}

/**
 * Poll the page-side measurement.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {number} deadline
 * @returns {Promise<object|null>}
 */
async function awaitMeasurement(client, contextId, deadline) {
  for (;;) {
    let state = null
    try {
      const remote = await evaluate(
        client,
        `(() => {
  const s = window.__ffbSpin;
  if (!s) return JSON.stringify({ state: 'missing' });
  return JSON.stringify({ state: s.state, result: s.result || null, error: s.error || null, info: s.info || null });
})()`,
        contextId,
      )
      state = parseJson(remote)
    } catch {
      state = null
    }
    if (state && state.state === 'done') return state.result
    if (state && state.state === 'error') {
      return { ok: false, reason: 'decode_failed', error: state.error }
    }
    if (Date.now() >= deadline) {
      return { ok: false, reason: 'measure_timeout' }
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

/**
 * Read a JSON payload that a page-side expression returned.
 *
 * The page hands structured data back as a JSON STRING on purpose: BiDi
 * serialises objects without their property names, so an object coming back
 * over the wire cannot be read reliably. A string always can.
 *
 * @param {any} remote
 * @returns {any}
 */
function parseJson(remote) {
  const raw = unwrapRemoteValue(remote)
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Convert the desired angle into the drag distance the widget expects.
 *
 * The widget computes `percent = round(distance / (trackWidth - 52), 2)` and
 * rotates by `360 * percent`. Because percent is rounded to two decimals the
 * reachable angles are multiples of 3.6 degrees, so the distance is chosen to
 * land on the nearest REACHABLE angle rather than the nearest pixel.
 *
 * @param {number} angle
 * @param {number} trackWidth
 * @returns {{distance: number, percent: number, rotation: number, error: number}}
 */
export function angleToDrag(angle, trackWidth) {
  const span = Math.max(1, trackWidth - 52)
  let best = null
  for (let d = 0; d <= span; d += 1) {
    const percent = Math.round((d / span) * 100) / 100
    const rotation = 360 * percent
    const error = Math.abs(((((rotation - angle + 180) % 360) + 360) % 360) - 180)
    if (!best || error < best.error) best = { distance: d, percent, rotation, error }
  }
  return best
}

/**
 * Solve a spin captcha.
 *
 * @param {object} opts
 * @param {import('../../bidi/client.js').BidiClient} opts.client
 * @param {string} opts.contextId
 * @param {string} opts.topContextId
 * @param {object} opts.challenge
 * @param {string} opts.closedRootProp
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.attempts] how many pictures to try before giving up
 * @returns {Promise<object>}
 */
export async function solveSpin(opts) {
  const { client, contextId, topContextId, closedRootProp } = opts
  const deadline = Date.now() + (opts.timeoutMs || 60000)
  // Pictures the solver cannot judge are skipped rather than guessed, so a
  // larger budget mostly buys more fresh pictures, not more wrong answers.
  const maxAttempts = opts.attempts || 4
  // The captcha runs a proof-of-work in a worker before it submits, which
  // takes several seconds. One round therefore needs its own budget.
  const perRoundMs = opts.perRoundMs || 25000
  // Pause between rounds so the session does not look like it is hammering
  // the challenge.
  const retryDelayMs = opts.retryDelayMs === undefined ? 2500 : opts.retryDelayMs

  // 1. The page reports `navigator.webdriver` to the server as a "simulator"
  //    flag. Firefox sets it whenever the Remote Agent runs and no pref turns
  //    it off, but the flag is read by the page's own JavaScript, so
  //    overriding the getter before the submission is what the server sees.
  //    The override is installed in the page (not the browser) and is undone
  //    by a reload.
  try {
    await evaluate(
      client,
      `(() => {
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      configurable: true,
      enumerable: true,
      get: () => false,
    });
  } catch (e) {}
  return true;
})()`,
      contextId,
    )
  } catch {
    // Not fatal: the challenge may still be solved without it.
  }

  // A site under risk control can accept the angle and then ask for another
  // round ("存在安全风险，请再次验证"). Each attempt therefore works on a
  // fresh picture, and the loop keeps going while the widget is still there.
  const watcher = await watchVerdictRequests(client, contextId)
  const rounds = []
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Each round gets its own budget: the captcha runs a proof-of-work in a
      // worker before it submits, which takes several seconds.
      const roundDeadline = Math.min(deadline, Date.now() + perRoundMs)
      const round = await solveSpinOnce(client, {
        contextId,
        topContextId,
        closedRootProp,
        deadline: roundDeadline,
        watcher,
        attempt,
      })
      rounds.push({
        attempt,
        status: round.status,
        ok: round.ok,
        angle: round.angle,
        rotation: round.rotation,
        distance: round.distance,
        ...(round.message ? { message: round.message } : {}),
        // The server's own verdict is the only proof that matters.
        ...(round.verdict ? { verdict: round.verdict } : {}),
        // Did the handle actually move?
        ...(round.handleState ? { handleState: round.handleState } : {}),
        // How far the orientation estimate was from the runner-up.
        ...(round.measured && round.measured.familyMargin !== undefined
          ? { familyMargin: round.measured.familyMargin }
          : {}),
        // The four 90-degree candidates and their scores.
        ...(round.family ? { family: round.family } : {}),
        ...(round.familyScores ? { familyScores: round.familyScores } : {}),
        ...(round.familyLuma ? { familyLuma: round.familyLuma } : {}),
      })

      if (round.ok) {
        return {
          ...round,
          attempts: rounds,
        }
      }

      // A rejected answer refreshes the picture; a measured-but-unsolved widget
      // needs a new attempt too. Either way, loop while the widget remains.
      const stillThere = await widgetPresent(client, contextId)
      if (!stillThere) {
        return {
          ...round,
          attempts: rounds,
          message:
            round.message +
            ' The captcha is no longer on the page, so the outcome could not be ' +
            'confirmed from here.',
        }
      }
      // Risk control is a property of the SESSION, not of the picture.
      // Answering again in the same breath only escalates it, so stop here
      // and report it: the angle was right, the session is flagged.
      if (round.status === 'risk_challenge') break

      // The site swaps the picture roughly half a second after a verdict.
      // Measuring before the swap would measure the SAME picture again and
      // submit the same answer, so wait for the new one.
      if (round.measured && round.measured.info && round.measured.info.src) {
        if (round.status === 'low_confidence') {
          // Nothing was submitted, so the picture has to be replaced by hand.
          await refreshPicture(client, contextId)
        }
        await waitForNewPicture(client, contextId, round.measured.info.src)
      }
      // Give the site a moment between rounds. Answering again within a
      // second looks like a script hammering the challenge and is exactly
      // what puts a session under extra scrutiny.
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      if (Date.now() >= deadline) break
    }
  } finally {
    watcher.dispose()
    // Leave a trace in the page so a failed run can be inspected without
    // re-running it.
    try {
      await evaluate(
        client,
        `(() => { window.__ffbSpinDebug = ${JSON.stringify(rounds)}; return true; })()`,
        contextId,
      )
    } catch {
      // The page may be gone; the report is a convenience, not a result.
    }
  }

  const riskStop = rounds.find((r) => r.status === 'risk_challenge')
  return {
    ok: false,
    status: riskStop ? 'risk_challenge' : 'solve_failed',
    attempts: rounds,
    message: riskStop
      ? riskStop.message
      : 'The spin captcha was not accepted within the attempt budget. Every ' +
        'picture was measured and dragged, but the server did not take the ' +
        'answer.',
  }
}

/**
 * Ask the captcha for a different picture.
 *
 * Used when a picture cannot be judged with enough confidence: submitting a
 * guess would be a wrong answer, and wrong answers are what make the site
 * start demanding extra checks.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @returns {Promise<boolean>} true when the refresh link was clicked
 */
async function refreshPicture(client, contextId) {
  let point = null
  try {
    const remote = await evaluate(
      client,
      `(() => {
  const el = document.querySelector('.passMod_dialog-footer-refresh');
  if (!el) return 'null';
  const r = el.getBoundingClientRect();
  if (!r || r.width <= 0) return 'null';
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
})()`,
      contextId,
    )
    const value = unwrapRemoteValue(remote)
    if (typeof value === 'string') point = JSON.parse(value)
  } catch {
    point = null
  }
  if (!point) return false
  try {
    await pointerClick(client, { context: contextId, x: point.x, y: point.y })
    return true
  } catch {
    return false
  }
}

/**
 * Wait until the captcha shows a different picture.
 *
 * After a verdict the site swaps the picture about half a second later.
 * Measuring in between would measure the picture that was just judged, and
 * the same answer would be submitted again.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} previousSrc
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} true when a new picture is showing
 */
async function waitForNewPicture(client, contextId, previousSrc, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    let src = null
    try {
      const remote = await evaluate(
        client,
        `(() => {
  const bg = document.querySelector('.passMod_spin-background');
  return bg ? bg.src : '';
})()`,
        contextId,
      )
      const value = unwrapRemoteValue(remote)
      src = typeof value === 'string' ? value : null
    } catch {
      src = null
    }
    if (src && src !== previousSrc) return true
    if (Date.now() >= deadline) return false
  }
}

/**
 * Wander the pointer over the picture before the drag.
 *
 * The captcha records the mouse path over the picture area and sends it to
 * the server together with the answer, so a run that jumps straight onto the
 * slider leaves that path empty. This walks a short, curved path across the
 * picture and ends on the slider handle.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {object} image  the picture's bounding box
 * @param {number} knobX
 * @param {number} knobY
 * @returns {Promise<void>}
 */
async function warmupPointer(client, contextId, image, knobX, knobY) {
  const cx = image.x + image.width / 2
  const cy = image.y + image.height / 2
  const radius = Math.max(8, Math.min(image.width, image.height) * 0.3)
  const actions = []
  const steps = 10
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    // A lazy spiral, so consecutive points are never collinear.
    const angle = t * Math.PI * 2.1 + 0.7
    const r = radius * (0.35 + 0.65 * Math.sin(t * Math.PI))
    actions.push({
      type: 'pointerMove',
      x: Math.round(cx + Math.cos(angle) * r),
      y: Math.round(cy + Math.sin(angle) * r * 0.7),
    })
    actions.push({ type: 'pause', duration: 35 + Math.round(Math.random() * 45) })
  }
  actions.push({ type: 'pointerMove', x: Math.round(knobX), y: Math.round(knobY) })
  actions.push({ type: 'pause', duration: 70 })
  try {
    await client.send('input.performActions', {
      context: contextId,
      actions: [
        {
          type: 'pointer',
          id: 'firefox-browser-spin-warmup',
          parameters: { pointerType: 'mouse' },
          actions,
        },
      ],
    })
  } catch {
    // The warm-up is a nicety; if the browser rejects the pause action the
    // drag can still be performed.
    try {
      await client.send('input.performActions', {
        context: contextId,
        actions: [
          {
            type: 'pointer',
            id: 'firefox-browser-spin-warmup',
            parameters: { pointerType: 'mouse' },
            actions: actions.filter((a) => a.type === 'pointerMove'),
          },
        ],
      })
    } catch {
      // Give up on the warm-up; the drag below still works.
    }
  }
}

/**
 * One measure-and-drag round against the current picture.
 *
 * @param {object} args
 * @returns {Promise<object>}
 */
async function solveSpinOnce(client, args) {
  const { contextId, closedRootProp, deadline, watcher, attempt } = args

  // 2. Measure the picture.
  let start
  try {
    const remote = await evaluate(client, measureExpression(closedRootProp), contextId)
    start = parseJson(remote)
  } catch (err) {
    return {
      ok: false,
      status: 'measure_unavailable',
      message:
        'The spin widget could not be inspected. The page may have ' +
        'reloaded while it was being measured.',
    }
  }
  if (!start || !start.ok) {
    return {
      ok: false,
      status: 'measure_unavailable',
      message: 'The spin widget was not found on this page.',
      detail: start,
    }
  }

  const measured = await awaitMeasurement(client, contextId, deadline)
  if (!measured || !measured.ok) {
    return {
      ok: false,
      status: measured && measured.reason === 'decode_failed' ? 'decode_failed' : 'measure_timeout',
      message:
        'The captcha picture could not be measured in time. The endpoint ' +
        'did not deliver the image, or the page reloaded mid-measurement.',
      detail: measured,
    }
  }

  // 3. A picture whose candidates score almost the same cannot be judged
  //    reliably. Submitting a guess on such a picture is worse than asking
  //    for another one: a wrong answer is what triggers the site's risk
  //    checks. So skip it and let the caller fetch a fresh picture.
  const minMargin = args.minMargin === undefined ? 1.0 : args.minMargin
  if (typeof measured.familyMargin === 'number' && measured.familyMargin < minMargin) {
    return {
      ok: false,
      status: 'low_confidence',
      angle: measured.angle,
      family: measured.family,
      familyScores: measured.familyScores,
      measured,
      message:
        'The picture could not be judged with enough confidence (the best ' +
        'candidate scored only ' +
        measured.familyMargin.toFixed(2) +
        ' ahead of the runner-up), so no answer was submitted.',
    }
  }

  // 4. The track width drives the distance->angle mapping. The widget uses
  //    the track's own width, minus 52px for the handle.
  const trackWidth =
    (measured.info && measured.info.trackRect && measured.info.trackRect.width) || 290
  const drag = angleToDrag(measured.angle, trackWidth)

  if (!drag || drag.distance <= 0) {
    return {
      ok: false,
      status: 'no_drag_distance',
      message: 'The picture was measured but produced a drag distance of zero.',
      measured,
    }
  }

  // 4. Drag it. A multi-step path with easing reads as a hand; a single jump
  //    reads as a script.
  const knob = measured.info && measured.info.knobRect
  if (!knob) {
    return {
      ok: false,
      status: 'no_knob',
      message: 'The slider handle was not found.',
      measured,
    }
  }
  const startX = knob.x + knob.width / 2
  const startY = knob.y + knob.height / 2

  // 5a. Move the pointer over the picture first.
  //
  //     The site records the mouse path over the picture area and sends it to
  //     the server with the answer. A drag that starts straight on the
  //     handle produces no path at all, which is one of the things the risk
  //     engine looks at. A short wandering path over the picture looks like
  //     a person looking at the image before they answer.
  const image = measured.info && measured.info.imageRect
  if (image && image.width > 0) {
    await warmupPointer(client, contextId, image, startX, startY)
  }

  // 5b. Drag it. A multi-step path with easing reads as a hand; a single
  //     jump reads as a script. The pauses make the gesture take about
  //     half a second, like a real drag.
  try {
    await pointerDrag(client, {
      context: contextId,
      x: startX,
      y: startY,
      dx: drag.distance,
      dy: 0,
      steps: 18,
      stepDelayMs: 28,
      easing: 'easeInOut',
      jitter: 1.5,
    })
  } catch (err) {
    // Some BiDi implementations reject the pause action. Fall back to the
    // plain drag rather than giving up.
    try {
      await pointerDrag(client, {
        context: contextId,
        x: startX,
        y: startY,
        dx: drag.distance,
        dy: 0,
        steps: 18,
      })
    } catch (err2) {
      return {
        ok: false,
        status: 'drag_failed',
        message: `Could not dispatch the drag: ${err2 && err2.message ? err2.message : err2}`,
        measured,
        drag,
      }
    }
  }

  // Look at the handle right after the drag: did it move, and did the widget
  // react? This separates "the drag never reached the slider" from "the
  // slider moved but the server said no".
  let handleState = null
  try {
    const remote = await evaluate(
      client,
      `(() => {
  const h = document.querySelector('.passMod_slide-btn');
  if (!h) return 'null';
  return JSON.stringify({ cls: h.className || '', transform: h.style.transform || '' });
})()`,
      contextId,
    )
    handleState = unwrapRemoteValue(remote)
  } catch {
    handleState = null
  }

  // 6. Verify against the SERVER's verdict, not the widget's appearance.
  //    The spin captcha posts to /cap/log and the answer is in `data.op`:
  //    1 = accepted, 3 = rejected.
  const verdict = await awaitVerdict(client, contextId, deadline, watcher)
  const accepted = verdict && (verdict.op === 1 || verdict.op === 2)

  if (accepted) {
    // The server took the angle. There is one caveat: the server sometimes accepts
    // the angle and STILL asks for another round — that is `opp === 3`, and
    // the site says "存在安全风险，请再次验证". In that case the answer was
    // right and the session is simply under extra scrutiny, so another
    // picture has to be solved.
    const risky = verdict.opp === 3 || /风险|再次验证/.test(String(verdict.msg || ''))
    if (!risky) {
      return {
        ok: true,
        status: 'solved',
        tokenLength: 0,
        via: 'spin-angle',
        attempt,
        angle: measured.angle,
        rotation: drag.rotation,
        percent: drag.percent,
        distance: drag.distance,
        family: measured.family,
        familyMargin: measured.familyMargin,
        handleState,
        verdict,
        message:
          'The server accepted the angle (data.op = ' +
          verdict.op +
          '). ' +
          'The picture was rotated upright. If the site still shows another ' +
          'verification prompt, that is its risk control reacting to the ' +
          'session, not a wrong answer.',
      }
    }
    return {
      ok: false,
      status: 'risk_challenge',
      angle: measured.angle,
      family: measured.family,
      familyScores: measured.familyScores,
      message:
        'The server accepted the angle, but it also asked for another ' +
        'verification ("存在安全风险，请再次验证"). The angle was right; the ' +
        'session is simply under extra scrutiny.',
      measured,
      drag,
      handleState,
      verdict,
      attempt,
    }
  }

  // The server rejected the answer. If it also complained about risk, that
  // is a different problem from a wrong angle and worth telling apart.
  const risk = verdict && /风险|risk/i.test(String(verdict.msg || ''))
  return {
    ok: false,
    status: risk ? 'risk_rejected' : 'drag_rejected',
    angle: measured.angle,
    family: measured.family,
    familyScores: measured.familyScores,
    familyLuma: measured.familyLuma,
    message: risk
      ? 'The server rejected the answer and flagged the session as risky ' +
        '("存在安全风险，请再次验证"). The angle may well have been right, but ' +
        'the site is not letting this session through.'
      : 'The picture was rotated to the computed upright angle, but the server ' +
        'rejected the answer. The angle estimate was off, or the site wanted a ' +
        'different kind of motion.',
    measured,
    drag,
    handleState,
    verdict,
    attempt,
  }
}

/**
 * Is the spin widget still on the page?
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @returns {Promise<boolean>}
 */
async function widgetPresent(client, contextId) {
  try {
    const remote = await evaluate(
      client,
      `(() => {
  if (document.querySelector('.passMod_spin-wrapper')) return true;
  if (document.querySelector('.passMod_slide-control')) return true;
  return false;
})()`,
      contextId,
    )
    const value = unwrapRemoteValue(remote)
    return value === true
  } catch {
    return false
  }
}

/**
 * Read the server's verdict from the captcha's own request.
 *
 * The verdict lives in the response of `POST /cap/log`. There are two ways to
 * get at it, and the solver uses both:
 *
 *   1. The BiDi network domain. The response body is read directly from the
 *      browser, so the verdict is the server's own `data.op` — no guessing
 *      from the widget's appearance.
 *   2. The page. The widget sets `passMod_slide-btn-success` / `-fail` on the
 *      slider handle AFTER the server answered, so the class is a faithful
 *      mirror of the verdict. It is the fallback for browsers or sessions
 *      where the network domain is unavailable.
 *
 * The page-side mirror in localStorage (installed by measureExpression) is
 * read as a third source.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {number} deadline
 * @param {object|null} watcher network watcher, or null when unavailable
 * @returns {Promise<object|null>}
 */
async function awaitVerdict(client, contextId, deadline, watcher) {
  for (;;) {
    // 1. The server's own response body.
    if (watcher) {
      const viaNetwork = watcher.read()
      if (viaNetwork) return viaNetwork
    }

    let verdict = null
    try {
      const remote = await evaluate(
        client,
        `(() => {
  const LS_KEY = '__ffb_spin_verdict';
  let v = window.__ffbSpinVerdict || null;
  if (!v) {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) v = JSON.parse(raw);
    } catch (e) { v = null; }
  }
  // The widget mirrors the server's answer in its own class names, but only
  // after the answer arrives, and it swaps the picture ~500ms later.
  const handle = document.querySelector('.passMod_slide-btn');
  const cls = handle ? (handle.className || '') : '';
  let op = null;
  let source = v ? 'hook' : null;
  if (v && (v.op === 1 || v.op === 2 || v.op === 3)) {
    op = v.op;
  } else if (cls.indexOf('passMod_slide-btn-success') !== -1) {
    op = 1;
    source = 'widget';
  } else if (cls.indexOf('passMod_slide-btn-fail') !== -1) {
    op = 3;
    source = 'widget';
  }
  const msgEl = document.querySelector('.passMod_spin-msg');
  const text = msgEl ? (msgEl.innerText || msgEl.textContent || '') : '';
  const gone = !document.querySelector('.passMod_spin-wrapper');
  if (op === null && !gone) return 'null';
  return JSON.stringify({
    op: op,
    opp: v ? v.opp : undefined,
    msg: (text && text.trim()) || (v ? v.msg : undefined),
    status: v ? v.status : undefined,
    source: source,
    widgetGone: gone,
  });
})()`,
        contextId,
      )
      verdict = parseJson(remote)
    } catch {
      verdict = null
    }
    if (verdict) {
      // A widget that vanished without an explicit verdict means the challenge
      // released the page — the server accepted it and the site moved on.
      if (verdict.op === null || verdict.op === undefined) {
        if (verdict.widgetGone) return { op: 2, source: 'widget-gone', msg: verdict.msg }
        return null
      }
      return verdict
    }
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

/**
 * Watch the browser's network for the captcha's verdict request.
 *
 * The spin captcha posts the attempt to `/cap/log` and the answer is in
 * `data.op`: 1 or 2 = accepted, 3 = rejected. Reading the response body
 * through the BiDi network domain is the only way to see the server's own
 * verdict — the widget's appearance is a second-hand copy of it.
 *
 * @param {import('../../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @returns {Promise<{read: () => object|null, dispose: () => void}|null>}
 */
async function watchVerdictRequests(client, contextId) {
  let latest = null
  let enabled = false

  const onEvent = (method, params) => {
    if (method !== 'network.responseCompleted') return
    if (!params || !params.response) return
    const url = String(params.response.url || '')
    if (url.indexOf('/cap/log') === -1) return
    const requestId = params.request
    if (!requestId) return
    client
      .send('network.getResponseBody', { request: requestId })
      .then((res) => {
        const raw = res && res.body
        if (!raw) return
        const text = res.base64 ? Buffer.from(raw, 'base64').toString('utf8') : raw
        const parsed = JSON.parse(text)
        const data = (parsed && parsed.data) || {}
        latest = {
          op: data.op,
          opp: data.opp,
          msg: parsed ? parsed.msg : undefined,
          status: params.response.status,
          source: 'network',
        }
      })
      .catch(() => {})
  }

  client.on('event', onEvent)
  try {
    await client.send('network.enable', { contexts: [contextId] })
    enabled = true
  } catch {
    // The network domain is optional: the widget's own status classes are
    // used instead when it is unavailable.
    enabled = false
  }

  return {
    read: () => latest,
    dispose: () => {
      client.removeListener('event', onEvent)
      if (enabled) {
        client.send('network.disable', { contexts: [contextId] }).catch(() => {})
      }
    },
  }
}
