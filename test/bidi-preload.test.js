// test/bidi-preload.test.js
// Unit tests for the preload-script wrapper.
//
// The parameter shape of `script.addPreloadScript` is the single easiest
// thing to get wrong when implementing against the BiDi spec instead of
// against Firefox. The spec says `script` (a TextSource object) and
// `contexts` (an array). Firefox 140 ESR wants `functionDeclaration` (a
// plain string) and `context` (a string id), and answers `invalid argument`
// or "Expected functionDeclaration to be a string" for the spec shape.
//
// These tests pin the shape Firefox actually accepts, so a spec-driven
// refactor fails here instead of failing silently in a live browser.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { addPreloadScript, removePreloadScript } from '../lib/bidi/protocol.js'

/**
 * A fake BiDi client that records what it was asked to send.
 *
 * @param {object} [result]  what the command should resolve to
 * @returns {{client: object, sent: Array}}
 */
function recordingClient(result = {}) {
  const sent = []
  return {
    sent,
    client: {
      send: async (method, params) => {
        sent.push({ method, params })
        return result
      },
    },
  }
}

describe('addPreloadScript', () => {
  test('sends functionDeclaration as a plain string, not a TextSource', async () => {
    const { client, sent } = recordingClient({ script: 'abc-123' })
    await addPreloadScript(client, '() => { window.x = 1 }', 'ctx-1')

    assert.equal(sent.length, 1)
    assert.equal(sent[0].method, 'script.addPreloadScript')
    assert.equal(typeof sent[0].params.functionDeclaration, 'string')
    assert.equal(sent[0].params.functionDeclaration, '() => { window.x = 1 }')
    // The spec's `script` key must NOT be present: Firefox rejects it.
    assert.equal('script' in sent[0].params, false)
  })

  test('passes context as a string id, not an array', async () => {
    const { client, sent } = recordingClient()
    await addPreloadScript(client, '() => {}', 'ctx-1')

    assert.equal(typeof sent[0].params.context, 'string')
    assert.equal(sent[0].params.context, 'ctx-1')
    assert.equal('contexts' in sent[0].params, false)
  })

  test('omits context entirely when none is given', async () => {
    const { client, sent } = recordingClient()
    await addPreloadScript(client, '() => {}')

    assert.equal('context' in sent[0].params, false)
  })

  test('returns the script id so it can be removed later', async () => {
    const { client } = recordingClient({ script: 'script-uuid' })
    const id = await addPreloadScript(client, '() => {}', 'ctx-1')

    assert.equal(id, 'script-uuid')
  })

  test('returns null when Firefox reports no script id', async () => {
    const { client } = recordingClient({})
    const id = await addPreloadScript(client, '() => {}', 'ctx-1')

    assert.equal(id, null)
  })
})

describe('removePreloadScript', () => {
  test('sends the script id under the key "script"', async () => {
    const { client, sent } = recordingClient()
    await removePreloadScript(client, 'script-uuid')

    assert.equal(sent[0].method, 'script.removePreloadScript')
    assert.equal(sent[0].params.script, 'script-uuid')
  })

  test('is a no-op without a script id', async () => {
    const { client, sent } = recordingClient()
    const removed = await removePreloadScript(client, null)

    assert.equal(removed, false)
    assert.equal(sent.length, 0)
  })
})
