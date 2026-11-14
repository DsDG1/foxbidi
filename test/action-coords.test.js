// test/action-coords.test.js
// Unit tests for post-scroll coordinate re-measurement, iframe viewport
// offsets, iframe file upload context routing, and error code preservation.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { FirefoxProvider } from '../lib/firefox/provider.js'
import { ERROR_CODES } from '../lib/firefox/errors.js'

function toRemoteValue(value) {
  if (value === null || value === undefined) return { type: 'null' }
  if (typeof value === 'boolean') return { type: 'boolean', value }
  if (typeof value === 'number') return { type: 'number', value }
  if (typeof value === 'string') return { type: 'string', value }
  if (Array.isArray(value)) return { type: 'array', value: value.map(toRemoteValue) }
  return {
    type: 'object',
    value: Object.entries(value).map(([k, v]) => [k, toRemoteValue(v)]),
  }
}

function makeProvider(opts = {}) {
  const sent = []
  const provider = new FirefoxProvider({ copyBaseDir: '/tmp/ffb-action-test' })
  provider.config_.inlineSnapshot = false
  provider.state = 'ready'
  provider._ensureReady = async () => true
  provider._resolveContext = async (id) => id || 'top-ctx'
  provider._injectionGate = async () => ({ allowed: true })

  const client = {
    sent,
    sendAbandonable(method, params) {
      return {
        promise: client.send(method, params),
        abandon() {},
      }
    },
    async send(method, params) {
      sent.push({ method, params })
      if (method === 'browsingContext.getTree') {
        return { contexts: opts.tree || [] }
      }
      if (method === 'script.evaluate') {
        return {
          result: toRemoteValue({
            url: 'https://example.com',
            title: 'Test',
            fingerprint: String(sent.length),
          }),
        }
      }
      if (method === 'script.callFunction') {
        const fn = params.functionDeclaration || ''
        // refExists probe
        if (fn.includes('return !!(reg && reg.has && reg.has(ref))')) {
          return { result: { type: 'boolean', value: opts.refAlive !== false } }
        }
        // inspectElement (pre-scroll)
        if (fn.includes('isSensitiveField(el)')) {
          return { result: toRemoteValue(opts.preScrollInfo) }
        }
        // _frameViewportOffset
        if (fn.includes("querySelectorAll('iframe, frame')")) {
          return { result: toRemoteValue(opts.frameOffset || { dx: 0, dy: 0 }) }
        }
        if (opts.onCallFunction) {
          const custom = opts.onCallFunction(fn, params)
          if (custom !== undefined) return custom
        }
        // _scrollAndMeasure (post-scroll)
        if (fn.includes('el.scrollIntoView') && fn.includes('el.getBoundingClientRect()')) {
          return { result: toRemoteValue(opts.postScrollCoords) }
        }
        // resolveSharedId
        if (fn.includes('return el || null')) {
          return { result: { type: 'node', sharedId: 'shared-node-42' } }
        }
        return { result: { type: 'boolean', value: true } }
      }
      return {}
    },
  }
  provider.client = client
  return { provider, sent }
}

describe('action coordinate measurement & iframe handling', () => {
  test('click dispatches pointer events at post-scroll coordinates rather than pre-scroll', async () => {
    const { provider, sent } = makeProvider({
      preScrollInfo: {
        x: 120,
        y: 2400,
        w: 80,
        h: 32,
        tag: 'button',
        type: 'button',
        role: 'button',
        name: 'More',
        isSubmit: false,
        hasDownload: false,
        isFileInput: false,
      },
      postScrollCoords: { x: 120, y: 380, w: 80, h: 32 },
    })

    const res = await provider.click('#more', 'top-ctx')
    assert.equal(res.ok, true)
    assert.equal(res.x, 120)
    assert.equal(res.y, 380)

    const pointerCall = sent.find((c) => c.method === 'input.performActions')
    assert.ok(pointerCall)
    const move = pointerCall.params.actions[0].actions[0]
    assert.deepEqual(move, { type: 'pointerMove', x: 120, y: 380 })
  })

  test('click and hover inside an iframe translate coordinates to the top-level viewport', async () => {
    const { provider, sent } = makeProvider({
      tree: [
        {
          context: 'top-ctx',
          url: 'https://example.com/',
          children: [
            { context: 'frame-ctx-1', url: 'https://embed.example.com/widget', children: [] },
          ],
        },
      ],
      preScrollInfo: {
        x: 40,
        y: 25,
        w: 60,
        h: 20,
        tag: 'button',
        type: 'button',
        role: 'button',
        name: 'Pay',
        isSubmit: false,
        hasDownload: false,
        isFileInput: false,
      },
      frameOffset: { dx: 200, dy: 150 },
      postScrollCoords: { x: 40, y: 25, w: 60, h: 20 },
    })
    provider._frameMap.set('f1234567', 'frame-ctx-1')

    const clicked = await provider.click(undefined, 'top-ctx', { ref: 'f1234567:e2' })
    assert.equal(clicked.ok, true)
    assert.equal(clicked.contextId, 'frame-ctx-1')
    assert.equal(clicked.x, 240)
    assert.equal(clicked.y, 175)

    const clickInput = sent.find((c) => c.method === 'input.performActions')
    assert.equal(clickInput.params.context, 'top-ctx')
    assert.deepEqual(clickInput.params.actions[0].actions[0], {
      type: 'pointerMove',
      x: 240,
      y: 175,
    })

    sent.length = 0
    const hovered = await provider.hover(undefined, 'top-ctx', { ref: 'f1234567:e2' })
    assert.equal(hovered.ok, true)
    assert.equal(hovered.x, 240)
    assert.equal(hovered.y, 175)
    assert.equal(hovered.effect.verified, true)
    const hoverInput = sent.find((c) => c.method === 'input.performActions')
    assert.equal(hoverInput.params.context, 'top-ctx')
  })

  test('upload inside an iframe passes the iframe contextId to input.setFiles', async () => {
    const { provider, sent } = makeProvider({
      preScrollInfo: {
        x: 20,
        y: 20,
        w: 100,
        h: 30,
        tag: 'input',
        type: 'file',
        role: 'file',
        name: 'Resume',
        isSubmit: false,
        hasDownload: false,
        isFileInput: true,
      },
    })
    provider._frameMap.set('f9999999', 'frame-ctx-upload')

    const res = await provider.upload(undefined, ['/tmp/resume.pdf'], 'top-ctx', {
      ref: 'f9999999:e1',
      confirm: true,
    })
    assert.equal(res.ok, true)
    assert.equal(res.contextId, 'frame-ctx-upload')
    assert.equal(res.effect.verified, true)

    const setFilesCall = sent.find((c) => c.method === 'input.setFiles')
    assert.ok(setFilesCall)
    assert.equal(setFilesCall.params.context, 'frame-ctx-upload')
  })

  test('_resolveActionTarget preserves FRAME_GONE and INVALID_ARGUMENT codes', async () => {
    const { provider } = makeProvider({})
    const missingFrame = await provider.click(undefined, 'top-ctx', { ref: 'fdeadbeef:e1' })
    assert.equal(missingFrame.ok, false)
    assert.equal(missingFrame.code, ERROR_CODES.FRAME_GONE)

    const missingTarget = await provider.click(undefined, 'top-ctx', {})
    assert.equal(missingTarget.ok, false)
    assert.equal(missingTarget.code, ERROR_CODES.INVALID_ARGUMENT)
  })

  test('selectOption, check, and scroll attach effect.verified', async () => {
    const { provider } = makeProvider({
      preScrollInfo: null,
      onCallFunction(fn) {
        if (fn.includes('Array.from(el.options)')) {
          return {
            result: toRemoteValue({ ok: true, selected: 'pro', options: ['free', 'pro'] }),
          }
        }
        if (fn.includes('checkbox or radio button')) {
          return { result: toRemoteValue({ ok: true, checked: true }) }
        }
        if (fn.includes('scroll target not found')) {
          return { result: toRemoteValue({ ok: true, scrollY: 400, moved: true }) }
        }
        return undefined
      },
    })

    const sel = await provider.selectOption('#plan', 'pro', 'top-ctx')
    assert.equal(sel.ok, true)
    assert.equal(sel.effect.verified, true)

    const chk = await provider.check('#agree', true, 'top-ctx')
    assert.equal(chk.ok, true)
    assert.equal(chk.effect.verified, true)

    const scr = await provider.scroll('top-ctx', { direction: 'down', amount: 400 })
    assert.equal(scr.ok, true)
    assert.equal(scr.effect.verified, true)
  })
})
