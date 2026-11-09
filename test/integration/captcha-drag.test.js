// test/integration/captcha-drag.test.js
// End-to-end test of the drag primitive against a REAL browser.
//
// The GeeTest solver's hardest part is not the puzzle maths but the gesture:
// a slider only moves if the page receives press -> moves -> release, with
// intermediate moves rather than one teleport. This test drives a real
// slider page with the same primitive the solver uses and asserts the handle
// ended up where it was dragged.
//
// The page also records the event sequence, so the test can prove the gesture
// looked like a drag and not a click.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = resolve(HERE, '..', '..')
const absPath = (rel) => pathToFileURL(resolve(SERVER_DIR, rel)).href

const { detectFirefoxBin } = await import(absPath('lib/firefox/launcher.js'))
const { FirefoxProvider } = await import(absPath('lib/firefox/provider.js'))
const { getTree } = await import(absPath('lib/bidi/protocol.js'))
const inputs = await import(absPath('lib/firefox/inputs.js'))

const firefoxBin = detectFirefoxBin()
const skip = firefoxBin ? false : 'firefox is not installed — skipping the live-browser drag test'

/** The slider page under test. */
const PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>slider</title>
<style>
  body { margin: 0; font-family: sans-serif; }
  #track { position: relative; width: 400px; height: 50px; margin: 40px; background: #eee; }
  #handle { position: absolute; left: 0; top: 0; width: 50px; height: 50px; background: #333; }
</style>
</head>
<body>
  <div id="track"><div id="handle"></div></div>
  <div id="log"></div>
  <script>
    const track = document.getElementById('track');
    const handle = document.getElementById('handle');
    const events = [];
    window.__events = events;
    let startX = 0;
    handle.addEventListener('pointerdown', (e) => {
      events.push('pointerdown');
      startX = e.clientX;
      handle.setPointerCapture(e.pointerId);
      window.addEventListener('pointermove', onMove);
    });
    function onMove(e) {
      events.push('pointermove');
      handle.style.left = (e.clientX - startX) + 'px';
    }
    window.addEventListener('pointerup', () => {
      events.push('pointerup');
      window.removeEventListener('pointermove', onMove);
    });
  </script>
</body>
</html>`

describe('slider drag (live browser)', { skip }, () => {
  let tmpRoot
  let provider
  let server
  let origin

  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${server.address().port}/`

    tmpRoot = mkdtempSync(join(tmpdir(), 'ffbrowser-drag-'))
    provider = new FirefoxProvider({
      bin: firefoxBin,
      headless: true,
      port: 9633,
      copyBaseDir: join(tmpRoot, 'copies'),
      timeoutMs: 20000,
      readyTimeoutMs: 45000,
    })
    const started = await provider.start()
    if (!started.ok) throw new Error(`could not start firefox: ${started.error}`)
  })

  after(async () => {
    if (provider) await provider.stop()
    if (server) await new Promise((resolve) => server.close(resolve))
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  /**
   * Read the page's slider state.
   *
   * @returns {Promise<{left: number, events: string[]}>}
   */
  async function sliderState() {
    const result = await provider.evaluate(`(() => {
      const handle = document.getElementById('handle');
      return { left: parseFloat(handle.style.left || '0'), events: window.__events || [] };
    })()`)
    if (!result.ok) throw new Error(`could not read the slider: ${result.error}`)
    const value = result.value || {}
    return { left: Number(value.left) || 0, events: value.events || [] }
  }

  test('the drag moves the handle and looks like a drag', async () => {
    const navigated = await provider.navigate(origin)
    assert.equal(navigated.ok, true, `could not open the slider page: ${navigated.error}`)

    const tree = await getTree(provider.client)
    assert.ok(tree.length > 0, 'the browser should have a context')
    const contextId = tree[0].contextId

    const before = await sliderState()
    assert.equal(before.left, 0, 'the handle should start at the left edge')

    // The track sits at margin 40px; the handle is 50px wide, so its centre
    // starts at 40 + 25 = 65 on the x axis.
    await inputs.pointerDrag(provider.client, {
      context: contextId,
      x: 65,
      y: 40 + 25,
      dx: 200,
      dy: 0,
      steps: 14,
    })

    const after = await sliderState()

    // The handle must have travelled with the pointer.
    assert.ok(
      Math.abs(after.left - 200) <= 2,
      `the handle should have moved 200px, it moved ${after.left}px`,
    )

    // And the page must have seen a real gesture: down, moves, up.
    assert.ok(after.events.includes('pointerdown'), 'the page should see a pointerdown')
    assert.ok(after.events.includes('pointermove'), 'the page should see pointermove')
    assert.ok(after.events.includes('pointerup'), 'the page should see a pointerup')

    const moves = after.events.filter((e) => e === 'pointermove').length
    assert.ok(moves >= 10, `the drag should contain intermediate moves, got ${moves}`)
    assert.ok(
      after.events.indexOf('pointerdown') < after.events.indexOf('pointerup'),
      'pointerdown must come before pointerup',
    )
  })

  test('a drag with zero distance still presses and releases', async () => {
    const navigated = await provider.navigate(origin)
    assert.equal(navigated.ok, true)

    const tree = await getTree(provider.client)
    const contextId = tree[0].contextId

    await inputs.pointerDrag(provider.client, {
      context: contextId,
      x: 65,
      y: 65,
      dx: 0,
      dy: 0,
      steps: 3,
    })

    const state = await sliderState()
    assert.ok(state.events.includes('pointerdown'))
    assert.ok(state.events.includes('pointerup'))
    assert.equal(state.left, 0, 'a zero-distance drag must not move the handle')
  })
})
