// test/dialogs.test.js
// Unit tests for the JavaScript-dialog manager.
//
// A JavaScript dialog blocks the page: while one is open, Firefox refuses to
// evaluate scripts and to accept input. That is the failure mode that made
// the agent hang with no explanation, so the handling here is the thing that
// has to be right.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DialogManager, DIALOG_POLICY } from '../lib/firefox/dialogs.js'

/**
 * A fake BiDi client that records the commands it was asked to send.
 */
function fakeClient(options = {}) {
  const sent = []
  return {
    sent,
    async send(method, params) {
      sent.push({ method, params })
      if (options.fail) throw new Error(options.fail)
      return {}
    },
  }
}

describe('DialogManager', () => {
  test('an opened dialog is recorded as pending', () => {
    const dialogs = new DialogManager()
    const dialog = dialogs.onPromptOpened({
      context: 'ctx-1',
      type: 'alert',
      message: 'hello',
    })
    assert.equal(dialog.type, 'alert')
    assert.equal(dialog.message, 'hello')
    assert.equal(dialogs.open().length, 1)
  })

  test('an unknown prompt type falls back to alert', () => {
    const dialogs = new DialogManager()
    const dialog = dialogs.onPromptOpened({ context: 'ctx-1', type: 'weird' })
    assert.equal(dialog.type, 'alert')
  })

  test('the default policy dismisses a dialog instead of leaving it open', async () => {
    const dialogs = new DialogManager()
    const client = fakeClient()
    dialogs.onPromptOpened({ context: 'ctx-1', type: 'confirm', message: 'sure?' })

    const handled = await dialogs.autoHandle(client)

    assert.equal(handled.length, 1)
    assert.equal(handled[0].handled, 'dismiss')
    assert.equal(dialogs.open().length, 0)
    const sent = client.sent.find((c) => c.method === 'browsingContext.handleUserPrompt')
    assert.ok(sent, 'the dialog must be closed with handleUserPrompt')
    assert.equal(sent.params.action, 'dismiss')
    assert.equal(sent.params.context, 'ctx-1')
  })

  test('the autoAccept policy accepts the dialog', async () => {
    const dialogs = new DialogManager({ policy: DIALOG_POLICY.AUTO_ACCEPT })
    const client = fakeClient()
    dialogs.onPromptOpened({ context: 'ctx-1', type: 'alert' })

    await dialogs.autoHandle(client)

    const sent = client.sent.find((c) => c.method === 'browsingContext.handleUserPrompt')
    assert.equal(sent.params.action, 'accept')
  })

  test('the manual policy leaves the dialog open', async () => {
    const dialogs = new DialogManager({ policy: DIALOG_POLICY.MANUAL })
    const client = fakeClient()
    dialogs.onPromptOpened({ context: 'ctx-1', type: 'alert' })

    const handled = await dialogs.autoHandle(client)

    assert.equal(handled.length, 0)
    assert.equal(dialogs.open().length, 1, 'the dialog must stay open')
    assert.equal(client.sent.length, 0)
  })

  test('an explicit handle accepts the dialog with text', async () => {
    const dialogs = new DialogManager({ policy: DIALOG_POLICY.MANUAL })
    const client = fakeClient()
    dialogs.onPromptOpened({ context: 'ctx-1', type: 'prompt', message: 'name?' })

    const result = await dialogs.handle(client, {
      action: 'acceptWithText',
      text: 'alice',
    })

    assert.equal(result.ok, true)
    assert.equal(result.handled, 'acceptWithText')
    const sent = client.sent.find((c) => c.method === 'browsingContext.handleUserPrompt')
    assert.equal(sent.params.action, 'acceptAndSetPromptText')
    assert.equal(sent.params.promptText, 'alice')
  })

  test('handling a dialog that is not open says so plainly', async () => {
    const dialogs = new DialogManager()
    const client = fakeClient()
    const result = await dialogs.handle(client, { action: 'accept' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'no_pending_dialog')
  })

  test('a handled dialog is reported to the next action and then forgotten', async () => {
    const dialogs = new DialogManager()
    const client = fakeClient()
    dialogs.onPromptOpened({ context: 'ctx-1', type: 'alert', message: 'careful' })
    await dialogs.autoHandle(client)

    const drained = dialogs.drain()
    assert.equal(drained.length, 1)
    assert.equal(drained[0].message, 'careful')
    assert.equal(drained[0].handled, 'dismiss')
    // Draining twice must not report the same dialog again.
    assert.equal(dialogs.drain().length, 0)
  })

  test('closing a dialog removes it from the pending set', () => {
    const dialogs = new DialogManager()
    dialogs.onPromptOpened({ context: 'ctx-1', type: 'alert' })
    const closed = dialogs.onPromptClosed({ context: 'ctx-1' })
    assert.equal(closed.type, 'alert')
    assert.equal(dialogs.open().length, 0)
  })

  test('an unknown policy is rejected', () => {
    const dialogs = new DialogManager()
    assert.equal(dialogs.setPolicy('nonsense'), false)
    assert.equal(dialogs.setPolicy(DIALOG_POLICY.MANUAL), true)
    assert.equal(dialogs.policy, DIALOG_POLICY.MANUAL)
  })
})
