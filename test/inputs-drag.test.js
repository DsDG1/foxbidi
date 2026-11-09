// test/inputs-drag.test.js
// Unit tests for the pointer-drag primitive.
//
// A slider CAPTCHA watches the motion, not just the end position, so the
// action SEQUENCE matters: the button must go down before the moves and up
// after them. A drag that omits the press is a hover, not a drag.
//
// The BiDi wire shape is equally fussy: `input.performActions` wants a source
// type wrapping the action list. A flat array of actions is rejected with
// `Expected "actionSequence.actions" to be an array`.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pointerDrag } from '../lib/firefox/inputs.js'

/**
 * A fake BiDi client that records the action list it was asked to send.
 *
 * @returns {{client: object, sent: Array}}
 */
function recordingClient() {
  const sent = []
  return {
    sent,
    client: {
      send: async (method, params) => {
        sent.push({ method, params })
        return {}
      },
    },
  }
}

/**
 * Pull the flat action list out of a recorded performActions call.
 *
 * @param {Array} sent
 * @returns {Array}
 */
function actionsOf(sent) {
  assert.equal(sent.length, 1)
  assert.equal(sent[0].method, 'input.performActions')
  const sources = sent[0].params.actions
  assert.equal(Array.isArray(sources), true, 'actions must be a source array')
  assert.equal(sources.length, 1)
  assert.equal(sources[0].type, 'pointer')
  assert.equal(sources[0].parameters.pointerType, 'mouse')
  return sources[0].actions
}

describe('pointerDrag', () => {
  test('presses, moves in steps, then releases', async () => {
    const { client, sent } = recordingClient()
    await pointerDrag(client, { context: 'ctx', x: 10, y: 20, dx: 100, dy: 0, steps: 4 })

    const actions = actionsOf(sent)
    assert.deepEqual(
      actions.map((a) => a.type),
      [
        'pointerMove',
        'pointerDown',
        'pointerMove',
        'pointerMove',
        'pointerMove',
        'pointerMove',
        'pointerUp',
      ],
    )
  })

  test('starts at the given position and ends at the target', async () => {
    const { client, sent } = recordingClient()
    await pointerDrag(client, { context: 'ctx', x: 50, y: 60, dx: 100, dy: 40, steps: 4 })

    const actions = actionsOf(sent)
    assert.deepEqual(actions[0], { type: 'pointerMove', x: 50, y: 60 })
    const last = actions[actions.length - 2]
    assert.equal(last.x, 150)
    assert.equal(last.y, 100)
  })

  test('interpolates intermediate points linearly', async () => {
    const { client, sent } = recordingClient()
    await pointerDrag(client, { context: 'ctx', x: 0, y: 0, dx: 120, dy: 0, steps: 4 })

    const moves = actionsOf(sent).filter((a) => a.type === 'pointerMove')
    // First move is the start, then four steps of 30px each.
    assert.deepEqual(
      moves.map((m) => m.x),
      [0, 30, 60, 90, 120],
    )
  })

  test('supports negative distances', async () => {
    const { client, sent } = recordingClient()
    await pointerDrag(client, { context: 'ctx', x: 200, y: 0, dx: -80, dy: 0, steps: 2 })

    const moves = actionsOf(sent).filter((a) => a.type === 'pointerMove')
    assert.deepEqual(
      moves.map((m) => m.x),
      [200, 160, 120],
    )
  })

  test('defaults to 12 steps', async () => {
    const { client, sent } = recordingClient()
    await pointerDrag(client, { context: 'ctx', x: 0, y: 0, dx: 100, dy: 0 })

    const actions = actionsOf(sent)
    // 1 start move + 12 steps + down + up
    assert.equal(actions.filter((a) => a.type === 'pointerMove').length, 13)
  })

  test('rounds coordinates to integers', async () => {
    const { client, sent } = recordingClient()
    await pointerDrag(client, { context: 'ctx', x: 10.4, y: 20.6, dx: 33.3, dy: 0, steps: 3 })

    for (const action of actionsOf(sent)) {
      if (action.x !== undefined) assert.equal(Number.isInteger(action.x), true)
      if (action.y !== undefined) assert.equal(Number.isInteger(action.y), true)
    }
  })

  test('targets the given browsing context', async () => {
    const { client, sent } = recordingClient()
    await pointerDrag(client, { context: 'frame-ctx-42', x: 0, y: 0, dx: 10, dy: 0 })

    assert.equal(sent[0].params.context, 'frame-ctx-42')
  })

  test('never emits fewer than one step', async () => {
    const { client, sent } = recordingClient()
    await pointerDrag(client, { context: 'ctx', x: 0, y: 0, dx: 10, dy: 0, steps: 0 })

    const actions = actionsOf(sent)
    assert.equal(actions.filter((a) => a.type === 'pointerMove').length, 2)
  })
})
