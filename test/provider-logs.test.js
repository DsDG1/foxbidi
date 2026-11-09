// test/provider-logs.test.js
// Unit tests for the three-channel log buffer.
//
// "The page logged an error" and "the plugin could not reach Firefox" need
// different fixes, so they must not be mixed up in one undifferentiated
// stream.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { FirefoxProvider } from '../lib/firefox/provider.js'

function providerWith() {
  const provider = new FirefoxProvider({ copyBaseDir: '/tmp/ffb-test' })
  provider._ensureReady = async () => true
  provider._resolveContext = async (id) => id || 'ctx-1'
  return provider
}

describe('log channels', () => {
  test('a page console entry is on the console channel', async () => {
    const provider = providerWith()
    provider._onEvent('log.entryAdded', {
      level: 'error',
      text: 'Uncaught TypeError',
      source: { context: 'ctx-1' },
    })
    const result = await provider.consoleLogs(10)
    assert.equal(result.count, 1)
    assert.equal(result.logs[0].channel, 'console')
    assert.equal(result.logs[0].level, 'error')
    assert.equal(result.channels.console, 1)
  })

  test('a plugin entry is on the plugin channel', async () => {
    const provider = providerWith()
    provider._log('plugin', 'info', 'capabilities probed')
    const result = await provider.consoleLogs(10, { channel: 'plugin' })
    assert.equal(result.count, 1)
    assert.equal(result.logs[0].text, 'capabilities probed')
  })

  test('a refused command is on the bidi channel', async () => {
    const provider = providerWith()
    provider._log('bidi', 'error', 'network.getData: unknown command')
    const result = await provider.consoleLogs(10, { channel: 'bidi' })
    assert.equal(result.count, 1)
    assert.match(result.logs[0].text, /unknown command/)
  })

  test('the channel filter separates the streams', async () => {
    const provider = providerWith()
    provider._onEvent('log.entryAdded', { level: 'info', text: 'page log' })
    provider._log('plugin', 'info', 'plugin did a thing')
    provider._log('bidi', 'error', 'command failed')

    const consoleOnly = await provider.consoleLogs(10, { channel: 'console' })
    assert.equal(consoleOnly.count, 1)
    assert.equal(consoleOnly.logs[0].text, 'page log')

    const all = await provider.consoleLogs(10, { channel: 'all' })
    assert.equal(all.count, 3)
  })

  test('the level filter still works across channels', async () => {
    const provider = providerWith()
    provider._onEvent('log.entryAdded', { level: 'info', text: 'fyi' })
    provider._log('bidi', 'error', 'boom')
    const result = await provider.consoleLogs(10, { levels: ['error'] })
    assert.equal(result.count, 1)
    assert.equal(result.logs[0].text, 'boom')
  })

  test('the buffer stays bounded', async () => {
    const provider = providerWith()
    for (let i = 0; i < 600; i++) {
      provider._log('plugin', 'info', `entry ${i}`)
    }
    const result = await provider.consoleLogs(1000)
    assert.ok(result.count <= 500, `the buffer grew to ${result.count}`)
  })
})
