// test/bidi-protocol.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  unwrapRemoteValue,
  BidiEvaluateError,
  callFunction,
  getTree,
  sessionEnd,
  continueRequest,
  failRequest,
  handleUserPrompt,
} from '../lib/bidi/protocol.js'

describe('bidi evaluate exception handling', () => {
  test('an exception response is recognised, not silently dropped', () => {
    const remote = {
      type: 'exception',
      exceptionDetails: { text: 'Error: boom', lineNumber: 0, columnNumber: 13 },
    }
    const out = unwrapRemoteValue(remote)
    assert.equal(out.__exception, true)
    assert.match(out.text, /boom/)
  })

  test('a successful number keeps its value', () => {
    assert.equal(unwrapRemoteValue({ type: 'number', value: 2 }), 2)
  })

  test('a successful string keeps its value', () => {
    assert.equal(unwrapRemoteValue({ type: 'string', value: 'hi' }), 'hi')
  })

  test('the error class carries the page-side text', () => {
    const err = new BidiEvaluateError('Error: boom')
    assert.match(err.message, /boom/)
    assert.equal(err.code, 'evaluate_failed')
  })

  test('callFunction throws BidiEvaluateError on exception envelopes', async () => {
    const client = {
      async send() {
        return {
          type: 'exception',
          exceptionDetails: { text: 'TypeError: bad call' },
        }
      },
    }
    await assert.rejects(
      () => callFunction(client, '() => { throw new TypeError("bad call") }', [], 'ctx-1'),
      (err) => {
        assert.ok(err instanceof BidiEvaluateError)
        assert.match(err.message, /bad call/)
        return true
      },
    )
  })
})

describe('bidi protocol tree & out-of-band commands', () => {
  test('getTree preserves nested iframes beyond two levels', async () => {
    const client = {
      async send() {
        return {
          contexts: [
            {
              context: 'tab-1',
              url: 'https://a.example/',
              children: [
                {
                  context: 'frame-1',
                  url: 'https://b.example/',
                  children: [
                    {
                      context: 'frame-2',
                      url: 'https://c.example/',
                      children: [
                        {
                          context: 'frame-3',
                          url: 'https://d.example/',
                          children: [],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }
      },
    }
    const tree = await getTree(client)
    const leaf = tree[0].children[0].children[0].children[0]
    assert.equal(leaf.contextId, 'frame-3')
    assert.equal(leaf.parent, 'frame-2')
    assert.equal(leaf.type, 'iframe')
  })

  test('sessionEnd, continueRequest, failRequest, and handleUserPrompt use sendUnqueued', async () => {
    const unqueued = []
    const queued = []
    const client = {
      async send(method, params) {
        queued.push({ method, params })
        return {}
      },
      async sendUnqueued(method, params) {
        unqueued.push({ method, params })
        return {}
      },
    }

    await sessionEnd(client)
    await continueRequest(client, 'req-1')
    await failRequest(client, 'req-2', 'blocked')
    await handleUserPrompt(client, {
      context: 'ctx-1',
      action: 'acceptAndSetPromptText',
      promptText: 'hello',
    })

    assert.equal(queued.length, 0, 'must not block behind serialized queue')
    assert.deepEqual(
      unqueued.map((c) => c.method),
      [
        'session.end',
        'network.continueRequest',
        'network.failRequest',
        'browsingContext.handleUserPrompt',
      ],
    )
    assert.deepEqual(unqueued[3].params, {
      context: 'ctx-1',
      accept: true,
      userText: 'hello',
    })
  })
})
