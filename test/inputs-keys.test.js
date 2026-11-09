// test/inputs-keys.test.js
// Unit tests for key encoding and chord construction.
//
// `pressKeys` talks to a BiDi client, so the client is faked here. The point
// of these tests is the KEY ORDERING a chord produces: a modifier must stay
// HELD DOWN while the target key goes down, otherwise the page never sees
// `ctrlKey === true` and the chord degrades into stray literal characters.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeKey,
  encodeCombo,
  buildKeyActions,
  pressKeys,
  KEY_CODES,
  MODIFIER_KEYS,
} from '../lib/firefox/inputs.js'

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
 * Render an action list as a readable sequence.
 *
 * @param {Array<{type: string, value: string}>} actions
 * @returns {string[]}
 */
function shape(actions) {
  const names = new Map([
    [KEY_CODES.CONTROL, 'CTRL'],
    [KEY_CODES.SHIFT, 'SHIFT'],
    [KEY_CODES.ALT, 'ALT'],
    [KEY_CODES.META, 'META'],
    [KEY_CODES.ENTER, 'ENTER'],
    [KEY_CODES.ESCAPE, 'ESCAPE'],
  ])
  return actions.map((a) => `${a.type}:${names.get(a.value) ?? a.value}`)
}

describe('encodeKey', () => {
  test('a single character is returned as-is', () => {
    assert.equal(encodeKey('a'), 'a')
    assert.equal(encodeKey('/'), '/')
  })

  test('a named key resolves through the code table', () => {
    assert.equal(encodeKey('Enter'), KEY_CODES.ENTER)
    assert.equal(encodeKey('enter'), KEY_CODES.ENTER)
    assert.equal(encodeKey('Escape'), KEY_CODES.ESCAPE)
  })

  test('a modifier alias resolves to its WebDriver code point', () => {
    assert.equal(encodeKey('Control'), KEY_CODES.CONTROL)
    assert.equal(encodeKey('ctrl'), KEY_CODES.CONTROL)
    assert.equal(encodeKey('Alt'), KEY_CODES.ALT)
    assert.equal(encodeKey('Shift'), KEY_CODES.SHIFT)
    assert.equal(encodeKey('Meta'), KEY_CODES.META)
  })

  test('an unknown key name resolves to the empty string', () => {
    assert.equal(encodeKey('NotAKey'), '')
    assert.equal(encodeKey(''), '')
  })
})

describe('encodeCombo', () => {
  test('a combination is tokenized into modifier-then-target order', () => {
    const combo = encodeCombo('Control+a')
    assert.deepEqual(combo.keys, [KEY_CODES.CONTROL, 'a'])
    assert.equal(combo.error, undefined)
  })

  test('several modifiers keep their given order', () => {
    const combo = encodeCombo('Ctrl+Shift+Enter')
    assert.deepEqual(combo.keys, [KEY_CODES.CONTROL, KEY_CODES.SHIFT, KEY_CODES.ENTER])
  })

  test('an unknown key in a combination is reported, not guessed', () => {
    const combo = encodeCombo('Ctrl+NotAKey')
    assert.deepEqual(combo.keys, [])
    assert.match(combo.error, /unknown key name/)
  })

  test('an empty combination is reported', () => {
    const combo = encodeCombo('')
    assert.deepEqual(combo.keys, [])
    assert.match(combo.error, /no key given/)
  })
})

describe('buildKeyActions', () => {
  test('a modifier is held down across the target key', () => {
    const actions = buildKeyActions([KEY_CODES.CONTROL, 'a'])
    assert.deepEqual(shape(actions), [
      'keyDown:CTRL',
      'keyDown:a',
      'keyUp:a',
      'keyUp:CTRL',
    ])
  })

  test('the modifier is released strictly AFTER the target key', () => {
    const actions = buildKeyActions([KEY_CODES.CONTROL, 'a'])
    const modUp = actions.findIndex((a) => a.type === 'keyUp' && a.value === KEY_CODES.CONTROL)
    const targetUp = actions.findIndex((a) => a.type === 'keyUp' && a.value === 'a')
    assert.ok(modUp > targetUp, 'the modifier must be released after the target key')
  })

  test('every modifier in a multi-modifier chord is held across the target', () => {
    const actions = buildKeyActions([KEY_CODES.CONTROL, KEY_CODES.SHIFT, KEY_CODES.ENTER])
    assert.deepEqual(shape(actions), [
      'keyDown:CTRL',
      'keyDown:SHIFT',
      'keyDown:ENTER',
      'keyUp:ENTER',
      'keyUp:SHIFT',
      'keyUp:CTRL',
    ])
  })

  test('a modifier-less key is still exactly one press and one release', () => {
    const actions = buildKeyActions([KEY_CODES.ENTER])
    assert.deepEqual(shape(actions), ['keyDown:ENTER', 'keyUp:ENTER'])
  })

  test('a lone literal character is one press and one release', () => {
    const actions = buildKeyActions(['a'])
    assert.deepEqual(shape(actions), ['keyDown:a', 'keyUp:a'])
  })

  test('a modifier on its own is pressed and released exactly once', () => {
    const actions = buildKeyActions([KEY_CODES.CONTROL])
    assert.deepEqual(shape(actions), ['keyDown:CTRL', 'keyUp:CTRL'])
  })

  test('no keys produce no actions', () => {
    assert.deepEqual(buildKeyActions([]), [])
    assert.deepEqual(buildKeyActions(null), [])
  })

  test('the modifier set covers every modifier code point', () => {
    for (const code of [KEY_CODES.CONTROL, KEY_CODES.SHIFT, KEY_CODES.ALT, KEY_CODES.META]) {
      assert.ok(MODIFIER_KEYS.has(code), 'missing modifier in MODIFIER_KEYS')
    }
    assert.ok(!MODIFIER_KEYS.has(KEY_CODES.ENTER), 'ENTER must not be a modifier')
  })
})

describe('pressKeys', () => {
  test('the whole chord is sent as ONE gesture', async () => {
    const { client, sent } = recordingClient()
    await pressKeys(client, { context: 'ctx', keys: [KEY_CODES.CONTROL, 'a'] })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].method, 'input.performActions')
    const sources = sent[0].params.actions
    assert.equal(sources.length, 1)
    assert.deepEqual(shape(sources[0].actions), [
      'keyDown:CTRL',
      'keyDown:a',
      'keyUp:a',
      'keyUp:CTRL',
    ])
  })

  test('an empty key list sends nothing', async () => {
    const { client, sent } = recordingClient()
    await pressKeys(client, { context: 'ctx', keys: [] })
    assert.equal(sent.length, 0)
  })
})
