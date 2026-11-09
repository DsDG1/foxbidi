// test/provider-dialogs.test.js
// Unit tests for the event-driven dialog settlement.
//
// The plugin used to wait a FIXED 250ms on every action for a dialog event
// that might never arrive. That was the single largest source of latency in
// the plugin, and it bought nothing: the `browsingContext.userPromptOpened`
// event arrives BEFORE the action's own command returns, so by the time an
// action settles, the epoch already knows whether a dialog opened.
//
// These tests pin the new behaviour:
//   - no dialog  → the action settles in a short window, not 250ms;
//   - a dialog   → it is reported in the SAME result as the action;
//   - a late event is still caught inside the grace window.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { FirefoxProvider } from '../lib/firefox/provider.js'
import { DialogManager, DIALOG_POLICY } from '../lib/firefox/dialogs.js'

/** A provider with just enough state to settle dialogs. */
function makeProvider(opts = {}) {
  const provider = new FirefoxProvider(opts)
  provider.dialogs = new DialogManager({ policy: DIALOG_POLICY.AUTO_DISMISS })
  provider.client = {
    send: async () => ({}),
    sendUnqueued: async () => ({}),
  }
  return provider
}

describe('dialog epoch', () => {
  test('a fresh provider starts at epoch zero', () => {
    const provider = makeProvider()
    assert.equal(provider._dialogEpoch, 0)
  })

  test('the settle window is short by default', () => {
    const provider = makeProvider()
    assert.ok(
      provider._dialogSettleMs <= 100,
      `the default settle window is ${provider._dialogSettleMs}ms — too long`,
    )
  })

  test('an opened dialog moves the epoch', () => {
    const provider = makeProvider()
    const before = provider._dialogEpoch
    provider._onEvent('browsingContext.userPromptOpened', {
      context: 'ctx-1',
      type: 'alert',
      message: 'hi',
    })
    assert.equal(provider._dialogEpoch, before + 1)
  })

  test('an unrelated event does not move the epoch', () => {
    const provider = makeProvider()
    const before = provider._dialogEpoch
    provider._onEvent('log.entryAdded', { level: 'info', text: 'hello' })
    provider._onEvent('network.beforeRequestSent', { request: {} })
    assert.equal(provider._dialogEpoch, before)
  })
})

describe('_settleDialogs', () => {
  test('an action without a dialog settles quickly', async () => {
    const provider = makeProvider()
    const before = provider._dialogEpoch
    const started = Date.now()
    const dialogs = await provider._settleDialogs(before)
    const elapsed = Date.now() - started
    assert.deepEqual(dialogs, [])
    assert.ok(elapsed < 200, `settling took ${elapsed}ms — the fixed wait is back`)
  })

  test('a dialog that opened during the action is reported', async () => {
    const provider = makeProvider()
    const before = provider._dialogEpoch
    // The event arrives while the action is running — before the settle.
    provider._onEvent('browsingContext.userPromptOpened', {
      context: 'ctx-1',
      type: 'confirm',
      message: 'are you sure?',
    })
    const dialogs = await provider._settleDialogs(before)
    assert.equal(dialogs.length, 1)
    assert.equal(dialogs[0].type, 'confirm')
    assert.equal(dialogs[0].message, 'are you sure?')
  })

  test('a dialog that arrives late is still caught inside the grace window', async () => {
    const provider = makeProvider()
    const before = provider._dialogEpoch
    // The event lands just after the action's command returned.
    setTimeout(() => {
      provider._onEvent('browsingContext.userPromptOpened', {
        context: 'ctx-1',
        type: 'alert',
        message: 'late',
      })
    }, 10)
    const dialogs = await provider._settleDialogs(before)
    assert.equal(dialogs.length, 1)
    assert.equal(dialogs[0].message, 'late')
  })

  test('a dialog is drained only once', async () => {
    const provider = makeProvider()
    const before = provider._dialogEpoch
    provider._onEvent('browsingContext.userPromptOpened', {
      context: 'ctx-1',
      type: 'alert',
      message: 'once',
    })
    const first = await provider._settleDialogs(before)
    const second = await provider._settleDialogs(provider._dialogEpoch)
    assert.equal(first.length, 1)
    assert.equal(second.length, 0)
  })

  test('the grace window is configurable', async () => {
    const provider = makeProvider()
    provider._dialogSettleMs = 120
    const before = provider._dialogEpoch
    setTimeout(() => {
      provider._onEvent('browsingContext.userPromptOpened', {
        context: 'ctx-1',
        type: 'alert',
        message: 'slow',
      })
    }, 60)
    const started = Date.now()
    const dialogs = await provider._settleDialogs(before)
    const elapsed = Date.now() - started
    assert.equal(dialogs.length, 1)
    assert.ok(elapsed >= 55, `it waited ${elapsed}ms — the window was not honoured`)
  })
})
