// test/dialog-blocking.test.js
// Unit tests for the manual-dialog guard.
//
// WHY THIS EXISTS
//
// A modal dialog BLOCKS the page. While one is open, Firefox refuses to
// evaluate scripts and to accept input — the command that opened it never
// comes back, and every command behind it waits.
//
// Under the `manual` dialog policy nothing closes that dialog, so the wait
// is permanent. The agent used to get a plain timeout, which reads like
// "the page is slow" and sends it into the wrong repair.
//
// These tests pin the new behaviour:
//   - a dialog that is left open is ANNOUNCED, and the waiting command is
//     abandoned so the queue moves on;
//   - a dialog the plugin closes itself does NOT block anything;
//   - an action that starts while a blocking dialog is open returns at once,
//     without dispatching anything.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { FirefoxProvider } from '../lib/firefox/provider.js'
import { DialogManager, DIALOG_POLICY } from '../lib/firefox/dialogs.js'
import { ERROR_CODES } from '../lib/firefox/errors.js'

/**
 * A provider with a fake client.
 *
 * @param {object} [opts]
 * @param {string} [opts.policy]  the dialog policy
 */
function makeProvider(opts = {}) {
  const provider = new FirefoxProvider()
  provider.dialogs = new DialogManager({
    policy: opts.policy || DIALOG_POLICY.MANUAL,
  })
  provider.client = {
    connected: true,
    send: async () => ({}),
    sendUnqueued: async () => ({}),
    sendAbandonable: async () => ({ promise: Promise.resolve({}), abandon: () => {} }),
  }
  provider._dialogSettleMs = 0
  return provider
}

describe('the dialog waiters', () => {
  test('a manual dialog announces itself to whoever is waiting', async () => {
    const provider = makeProvider({ policy: DIALOG_POLICY.MANUAL })
    const waiter = provider._waitForDialogOpen()
    provider._onEvent('browsingContext.userPromptOpened', {
      context: 'ctx-1',
      type: 'confirm',
      message: 'are you sure?',
    })
    const dialog = await waiter.promise
    assert.equal(dialog.type, 'confirm')
    assert.equal(dialog.message, 'are you sure?')
  })

  test('a dialog the plugin closes itself is not announced', async () => {
    const provider = makeProvider({ policy: DIALOG_POLICY.AUTO_DISMISS })
    const waiter = provider._waitForDialogOpen()
    let announced = false
    waiter.promise.then(() => {
      announced = true
    })
    provider._onEvent('browsingContext.userPromptOpened', {
      context: 'ctx-1',
      type: 'alert',
      message: 'hi',
    })
    await provider._settleDialogs(provider._dialogEpoch - 1)
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(announced, false, 'an auto-closed dialog must not block the action')
  })

  test('a cancelled waiter does not fire', async () => {
    const provider = makeProvider()
    const waiter = provider._waitForDialogOpen()
    waiter.cancel()
    let announced = false
    waiter.promise.then(() => {
      announced = true
    })
    provider._onEvent('browsingContext.userPromptOpened', {
      context: 'ctx-1',
      type: 'alert',
      message: 'hi',
    })
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(announced, false)
  })
})

describe('which dialogs block the page', () => {
  test('a manual dialog blocks', () => {
    const dialogs = new DialogManager({ policy: DIALOG_POLICY.MANUAL })
    dialogs.onPromptOpened({ context: 'ctx-1', type: 'alert', message: 'hi' })
    assert.equal(dialogs.blocking().length, 1)
  })

  test('an automatic dialog does not block — it closes itself', () => {
    const dialogs = new DialogManager({ policy: DIALOG_POLICY.AUTO_DISMISS })
    dialogs.onPromptOpened({ context: 'ctx-1', type: 'alert', message: 'hi' })
    assert.equal(dialogs.blocking().length, 0)
  })

  test('a dialog the automatic handling could not close blocks', async () => {
    const dialogs = new DialogManager({ policy: DIALOG_POLICY.AUTO_DISMISS })
    dialogs.onPromptOpened({ context: 'ctx-1', type: 'alert', message: 'hi' })
    // The close command fails — the dialog stays open and blocks the page.
    await dialogs.autoHandle({
      sendUnqueued: async () => {
        throw new Error('refused')
      },
    })
    assert.equal(dialogs.blocking().length, 1)
  })

  test('handling the dialog by hand unblocks the page', async () => {
    const dialogs = new DialogManager({ policy: DIALOG_POLICY.MANUAL })
    dialogs.onPromptOpened({ context: 'ctx-1', type: 'alert', message: 'hi' })
    assert.equal(dialogs.blocking().length, 1)
    await dialogs.handle({ sendUnqueued: async () => ({}) }, { action: 'accept' })
    assert.equal(dialogs.blocking().length, 0)
  })
})

describe('_performInput', () => {
  test('a command that completes normally is reported as done', async () => {
    const provider = makeProvider()
    provider.client.sendAbandonable = () => ({
      promise: Promise.resolve({ ok: 1 }),
      abandon: () => {},
    })
    const result = await provider._performInput({ context: 'ctx-1' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, { ok: 1 })
  })

  test('a dialog that opens mid-command abandons the command', async () => {
    const provider = makeProvider({ policy: DIALOG_POLICY.MANUAL })
    let abandoned = false
    provider.client.sendAbandonable = () => ({
      // The command never comes back — the page is blocked in the dialog.
      promise: new Promise(() => {}),
      abandon: () => {
        abandoned = true
      },
    })
    const pending = provider._performInput({ context: 'ctx-1' })
    // The dialog opens while the command is in flight.
    provider._onEvent('browsingContext.userPromptOpened', {
      context: 'ctx-1',
      type: 'alert',
      message: 'blocked',
    })
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(result.dialog.type, 'alert')
    assert.equal(abandoned, true, 'the command must be abandoned, not waited on')
  })

  test('the command is abandoned so the queue moves on', async () => {
    const provider = makeProvider({ policy: DIALOG_POLICY.MANUAL })
    let released = false
    provider.client.sendAbandonable = () => ({
      promise: new Promise(() => {}),
      abandon: () => {
        released = true
      },
    })
    const pending = provider._performInput({ context: 'ctx-1' })
    provider._onEvent('browsingContext.userPromptOpened', {
      context: 'ctx-1',
      type: 'alert',
      message: 'blocked',
    })
    await pending
    assert.equal(released, true)
  })
})

describe('an action that meets an open dialog', () => {
  test('the action returns at once, without dispatching anything', async () => {
    const provider = makeProvider({ policy: DIALOG_POLICY.MANUAL })
    let dispatched = false
    provider.client.send = async () => {
      dispatched = true
      return {}
    }
    provider.dialogs.onPromptOpened({
      context: 'ctx-1',
      type: 'alert',
      message: 'are you sure?',
    })

    const result = await provider.click('#ok', 'ctx-1')
    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.DIALOG_OPEN)
    assert.equal(dispatched, false, 'nothing may be sent to a blocked page')
    assert.match(result.hint, /browser_handle_dialog/)
    assert.equal(result.dialog.type, 'alert')
    assert.equal(result.requiresDialogHandling, true)
  })

  test('an action under an automatic policy is not blocked', async () => {
    const provider = makeProvider({ policy: DIALOG_POLICY.AUTO_DISMISS })
    provider.dialogs.onPromptOpened({
      context: 'ctx-1',
      type: 'alert',
      message: 'hi',
    })
    const blocked = provider._dialogBlocked('ctx-1')
    assert.equal(blocked, null)
  })
})
