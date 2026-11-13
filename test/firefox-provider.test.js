// test/firefox-provider.test.js
// Unit tests for the provider's profile-copy base resolution.
//
// The copy holds live credentials, so where it lands matters. The resolution
// chain must work in every plugin-hosting configuration — including the ones
// where the host injects no plugin-specific environment at all.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const absPath = (rel) => pathToFileURL(resolve(HERE, '..', rel)).href

const { defaultCopyBase, STATE } = await import(absPath('lib/firefox/provider.js'))

/** The plugin root, derived the same way provider.js does. */
const PLUGIN_ROOT = resolve(HERE, '..')

const ENV_KEYS = ['FIREFOX_BROWSER_PROFILE_COPY', 'PLUGIN_DATA']
let saved = {}

beforeEach(() => {
  saved = {}
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('profile copy base resolution', () => {
  test('an explicit FIREFOX_BROWSER_PROFILE_COPY wins over everything', () => {
    process.env.PLUGIN_DATA = '/tmp/plugin-data-should-lose'
    process.env.FIREFOX_BROWSER_PROFILE_COPY = '/tmp/explicit-copy-base'
    assert.equal(defaultCopyBase(), '/tmp/explicit-copy-base')
  })

  test('PLUGIN_DATA is used when no explicit override is set', () => {
    process.env.PLUGIN_DATA = '/tmp/plugin-data-wins'
    assert.equal(defaultCopyBase(), '/tmp/plugin-data-wins')
  })

  test('falls back to the platform plugin-data convention derived from import.meta.url', () => {
    // No env at all — the plugin root must be recoverable from the module path.
    const base = defaultCopyBase()
    assert.equal(base, resolve(PLUGIN_ROOT, '..', '.plugin-data', 'firefox-browser'))
  })

  test('always resolves to an absolute path', () => {
    const base = defaultCopyBase()
    assert.ok(isAbsolute(base), `expected an absolute path, got ${base}`)
  })

  test('never resolves inside the plugin package', () => {
    // The package is size-limited and scanned; live credentials must not
    // sit inside it.
    const base = defaultCopyBase()
    const rel = resolve(base).slice(PLUGIN_ROOT.length + 1)
    assert.ok(
      !rel.startsWith('lib') && !rel.startsWith('test') && !rel.startsWith('skills'),
      `copy base ${base} must not live inside the plugin package`,
    )
  })

  test('resolves under the user home by default', () => {
    const base = defaultCopyBase()
    assert.ok(base.startsWith(homedir()), `expected the copy base under ${homedir()}, got ${base}`)
  })
})

const { safeSerializable, resolveWithin } = await import(absPath('lib/firefox/provider/helpers.js'))

describe('provider lifecycle states', () => {
  test('exposes the documented state vocabulary', () => {
    assert.deepEqual(Object.keys(STATE).sort(), ['DEGRADED', 'FAILED', 'IDLE', 'READY', 'STARTING'])
    assert.equal(STATE.IDLE, 'idle')
    assert.equal(STATE.READY, 'ready')
    assert.equal(STATE.DEGRADED, 'degraded')
  })
})

describe('safeSerializable', () => {
  test('drops circular references without overflowing the stack while keeping shared DAG nodes', () => {
    const shared = { count: 3 }
    const root = { a: shared, b: shared, big: 9007199254740993n, fn: () => {} }
    root.self = root
    const arr = [1]
    arr.push(arr)
    root.arr = arr

    const safe = safeSerializable(root)
    assert.deepEqual(safe.a, { count: 3 })
    assert.deepEqual(safe.b, { count: 3 })
    assert.equal(safe.big, '9007199254740993')
    assert.equal(safe.fn, undefined)
    assert.equal(safe.self, undefined)
    assert.deepEqual(safe.arr, [1, null])
    assert.doesNotThrow(() => JSON.stringify(safe))
  })
})

describe('resolveWithin', () => {
  test('resolves paths inside base including filenames starting with ..', () => {
    assert.equal(resolveWithin('/tmp/base', 'sub/file.js'), resolve('/tmp/base/sub/file.js'))
    assert.equal(resolveWithin('/tmp/base', '.'), resolve('/tmp/base'))
    assert.equal(resolveWithin('/tmp/base', '..hidden'), resolve('/tmp/base/..hidden'))
  })

  test('rejects parent traversal, absolute escapes, and sibling-prefix escapes', () => {
    assert.throws(() => resolveWithin('/tmp/base', '..'), /escapes base directory/)
    assert.throws(() => resolveWithin('/tmp/base', '../../etc/passwd'), /escapes base directory/)
    assert.throws(() => resolveWithin('/tmp/base', '/etc/passwd'), /escapes base directory/)
    assert.throws(
      () => resolveWithin('/tmp/base', '../base-evil/payload.js'),
      /escapes base directory/,
    )
  })
})
