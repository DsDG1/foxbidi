// test/batch.test.js
// Unit tests for the batch orchestrator and the script-path guard.
//
// The batch exists to cut round trips, so its contract matters: it runs the
// steps in order, it stops at the first failure, and it reports exactly how
// far it got — because the steps that already ran cannot be undone.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { FirefoxProvider, scriptRoots, presetTools } from '../lib/firefox/provider.js'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * A provider whose browser-facing methods are stubbed.
 *
 * @param {object} stubs  method name → return value or function
 */
function stubbedProvider(stubs = {}) {
  const provider = new FirefoxProvider({ copyBaseDir: '/tmp/ffb-test' })
  provider._ensureReady = async () => true
  provider._resolveContext = async (id) => id || 'ctx-1'
  for (const [name, value] of Object.entries(stubs)) {
    provider[name] = async () => (typeof value === 'function' ? value() : value)
  }
  return provider
}

describe('browser_batch', () => {
  test('the steps run in order and all of them are reported', async () => {
    const order = []
    const provider = stubbedProvider({
      click: () => {
        order.push('click')
        return { ok: true, effect: { verified: true } }
      },
      type: () => {
        order.push('type')
        return { ok: true, typed: 3 }
      },
    })
    const result = await provider.batch([
      { action: 'click', ref: 'e1' },
      { action: 'type', ref: 'e2', text: 'abc' },
    ])
    assert.equal(result.ok, true)
    assert.equal(result.completed, 2)
    assert.deepEqual(order, ['click', 'type'])
    assert.equal(result.steps[1].typed, 3)
  })

  test('a failing step stops the batch and says where it stopped', async () => {
    let typed = false
    const provider = stubbedProvider({
      click: () => ({ ok: false, error: 'ref e1 no longer exists', requiresResnapshot: true }),
      type: () => {
        typed = true
        return { ok: true }
      },
    })
    const result = await provider.batch([
      { action: 'click', ref: 'e1' },
      { action: 'type', ref: 'e2', text: 'x' },
    ])
    assert.equal(result.ok, false)
    assert.equal(result.failedAt, 0)
    assert.equal(typed, false, 'the steps after the failure must not run')
    assert.equal(result.steps[0].requiresResnapshot, true)
    assert.match(result.note, /not rolled back/)
  })

  test('a blocked irreversible action stops the batch', async () => {
    const provider = stubbedProvider({
      click: () => ({
        ok: false,
        error: 'irreversible',
        blocked: true,
        requiresConfirm: true,
        action: 'form_submit',
      }),
    })
    const result = await provider.batch([{ action: 'click', ref: 'e1' }])
    assert.equal(result.ok, false)
    assert.equal(result.steps[0].blocked, true)
    assert.equal(result.steps[0].requiresConfirm, true)
  })

  test('stopOnError false keeps going past a failure', async () => {
    const provider = stubbedProvider({
      click: () => ({ ok: false, error: 'nope' }),
      type: () => ({ ok: true }),
    })
    const result = await provider.batch([{ action: 'click' }, { action: 'type' }], {
      stopOnError: false,
    })
    assert.equal(result.failedAt, undefined)
    assert.equal(result.completed, 1)
    assert.equal(result.steps.length, 2)
  })

  test('an unknown action is reported rather than ignored', async () => {
    const provider = stubbedProvider()
    const result = await provider.batch([{ action: 'teleport' }])
    assert.equal(result.ok, false)
    assert.match(result.steps[0].error, /unknown batch action/)
  })

  test('an empty step list is an actionable error', async () => {
    const provider = stubbedProvider()
    const result = await provider.batch([])
    assert.equal(result.ok, false)
    assert.match(result.error, /non-empty/)
  })

  test('a snapshot step returns the snapshot inline', async () => {
    const provider = stubbedProvider({
      snapshot: () => ({
        ok: true,
        elements: [{ ref: 'e0', role: 'button', name: 'Go' }],
        count: 1,
        total: 1,
      }),
    })
    const result = await provider.batch([{ action: 'snapshot' }])
    assert.equal(result.ok, true)
    assert.equal(result.steps[0].snapshot.count, 1)
    assert.equal(result.steps[0].snapshot.elements[0].ref, 'e0')
  })
})

describe('browser_run_script path guard', () => {
  test('the allowed roots include the agent workspace', () => {
    const roots = scriptRoots()
    assert.ok(roots.some((r) => r.endsWith(join('.mavis', 'ff-workspace'))))
  })

  test('a script outside the allowed roots is refused', async () => {
    const provider = stubbedProvider()
    const result = await provider.runScript('/etc/passwd')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'path_not_allowed')
  })

  test('a path that tries to escape the workspace is refused', async () => {
    const provider = stubbedProvider()
    const root = scriptRoots()[0]
    const escape = join(root, '..', '..', '..', 'etc', 'passwd')
    const result = await provider.runScript(escape)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'path_not_allowed')
  })

  test('a missing script inside the workspace reports the read error', async () => {
    const provider = stubbedProvider()
    const root = scriptRoots()[0]
    const result = await provider.runScript(join(root, 'does-not-exist.js'))
    assert.equal(result.ok, false)
    assert.match(result.error, /cannot read script/)
  })
})

describe('tool presets', () => {
  test('the slim preset drops the rarely needed tools', () => {
    const slim = presetTools('slim')
    assert.ok(!slim.includes('browser_press_key'))
    assert.ok(!slim.includes('browser_hover'))
    assert.ok(slim.includes('browser_snapshot'))
    assert.ok(slim.includes('browser_click'))
  })

  test('the basic preset keeps everything', () => {
    const basic = presetTools('basic')
    assert.ok(basic.includes('browser_press_key'))
    assert.ok(basic.includes('browser_hover'))
    assert.ok(basic.length > presetTools('slim').length)
  })
})

describe('browser_config', () => {
  test('the dialog policy can be changed', async () => {
    const provider = stubbedProvider()
    const result = await provider.config({ dialogPolicy: 'manual' })
    assert.equal(result.ok, true)
    assert.equal(result.dialogPolicy, 'manual')
    assert.equal(provider.dialogs.policy, 'manual')
  })

  test('an unknown policy is refused', async () => {
    const provider = stubbedProvider()
    const result = await provider.config({ dialogPolicy: 'nonsense' })
    assert.equal(result.ok, false)
    assert.match(result.error, /unknown dialog policy/)
  })

  test('the snapshot size is clamped to the ceiling', async () => {
    const provider = stubbedProvider()
    const result = await provider.config({ maxSnapshotElements: 999999 })
    assert.equal(result.ok, true)
    assert.ok(result.maxSnapshotElements <= 5000)
  })
})
