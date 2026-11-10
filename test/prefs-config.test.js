// test/prefs-config.test.js
// Unit tests for the runtime preferences (lib/firefox/prefs.js) and the
// profile-copy writer (lib/firefox/profile.js).
//
// Every fixture lives in a temp directory: the user's real profile must
// never be touched, and that invariant is asserted here rather than
// assumed.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPrefsScript, prefLines, validatePrefs } from '../lib/firefox/prefs.js'
import { setProfilePrefs, stripManagedBlock } from '../lib/firefox/profile.js'
import { FirefoxProvider } from '../lib/firefox/provider.js'

let tmpRoot

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ffbrowser-prefs-'))
})

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('validatePrefs', () => {
  test('a normal preference passes', () => {
    const { valid, invalid } = validatePrefs({ 'network.proxy.type': 1 })
    assert.deepEqual(valid, { 'network.proxy.type': 1 })
    assert.equal(invalid.length, 0)
  })

  test('a name with a quote is refused', () => {
    const { valid, invalid } = validatePrefs({ 'x"); alert(1); //': true })
    assert.equal(Object.keys(valid).length, 0)
    assert.equal(invalid.length, 1)
  })

  test('a name with a newline is refused', () => {
    const { invalid } = validatePrefs({ 'a\nb': true })
    assert.equal(invalid.length, 1)
  })

  test('a name that is not a preference is refused', () => {
    const { invalid } = validatePrefs({ 42: true })
    assert.equal(invalid.length, 1)
  })

  test('a value that is not a scalar is refused', () => {
    const { invalid } = validatePrefs({ 'a.b': { nested: true } })
    assert.equal(invalid.length, 1)
  })

  test('the valid ones survive alongside the invalid ones', () => {
    const { valid, invalid } = validatePrefs({ 'a.b': 1, 'c d': 2 })
    assert.deepEqual(valid, { 'a.b': 1 })
    assert.equal(invalid.length, 1)
  })
})

describe('prefLines', () => {
  test('a string value is quoted', () => {
    assert.deepEqual(prefLines({ 'a.b': 'x' }), ['user_pref("a.b", "x");'])
  })

  test('a number and a boolean are bare', () => {
    assert.deepEqual(prefLines({ 'a.b': 3, 'c.d': true }), [
      'user_pref("a.b", 3);',
      'user_pref("c.d", true);',
    ])
  })
})

describe('applyPrefsScript', () => {
  test('it carries the preferences', () => {
    const script = applyPrefsScript({ 'network.trr.mode': 3 })
    assert.match(script, /network\.trr\.mode/)
    assert.match(script, /setIntPref/)
  })
})

describe('the profile copy writer', () => {
  test('it writes a managed block', () => {
    const dir = join(tmpRoot, 'copy-1')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const result = setProfilePrefs(dir, { 'network.proxy.type': 1 })
    assert.equal(result.ok, true)
    const text = readFileSync(join(dir, 'user.js'), 'utf8')
    assert.match(text, /user_pref\("network\.proxy\.type", 1\);/)
  })

  test('writing twice replaces the block instead of piling up', () => {
    const dir = join(tmpRoot, 'copy-2')
    mkdirSync(dir, { recursive: true })
    setProfilePrefs(dir, { 'a.b': 1 })
    setProfilePrefs(dir, { 'a.b': 2 })
    const text = readFileSync(join(dir, 'user.js'), 'utf8')
    assert.match(text, /user_pref\("a\.b", 2\);/)
    assert.doesNotMatch(text, /user_pref\("a\.b", 1\);/)
    assert.equal(text.match(/--- firefox-browser plugin overrides ---/g).length, 1)
  })

  test("the user's own content survives", () => {
    const dir = join(tmpRoot, 'copy-3')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'user.js'), 'user_pref("mine", true);\n')
    setProfilePrefs(dir, { 'a.b': 1 })
    const text = readFileSync(join(dir, 'user.js'), 'utf8')
    assert.match(text, /user_pref\("mine", true\);/)
  })

  test('the managed block can be stripped again', () => {
    const dir = join(tmpRoot, 'copy-4')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'user.js'), 'user_pref("mine", true);\n')
    setProfilePrefs(dir, { 'a.b': 1 })
    const stripped = stripManagedBlock(readFileSync(join(dir, 'user.js'), 'utf8'))
    assert.doesNotMatch(stripped, /a\.b/)
    assert.match(stripped, /mine/)
  })
})

describe('the provider applies preferences', () => {
  test('they are written to the COPY, and the source is untouched', async () => {
    const source = join(tmpRoot, 'source-profile')
    const copy = join(tmpRoot, 'copy-profile')
    mkdirSync(source, { recursive: true })
    mkdirSync(copy, { recursive: true })
    writeFileSync(join(source, 'user.js'), 'user_pref("source", true);\n')

    const provider = new FirefoxProvider({ copyDir: copy })
    const result = await provider.applyPrefs({ 'network.proxy.type': 1 })

    assert.equal(result.ok, true)
    assert.ok(result.applied.includes('network.proxy.type'))
    assert.match(readFileSync(join(copy, 'user.js'), 'utf8'), /network\.proxy\.type/)
    // The source profile is not ours to write.
    assert.doesNotMatch(readFileSync(join(source, 'user.js'), 'utf8'), /network\.proxy\.type/)
  })

  test('an invalid preference is refused, and the valid ones still land', async () => {
    const copy = join(tmpRoot, 'copy-profile-2')
    mkdirSync(copy, { recursive: true })
    const provider = new FirefoxProvider({ copyDir: copy })
    const result = await provider.applyPrefs({ 'a.b': 1, 'bad name': 2 })
    assert.equal(result.ok, true)
    assert.equal(result.failed.length, 1)
    assert.match(readFileSync(join(copy, 'user.js'), 'utf8'), /a\.b/)
  })

  test('without a privileged context the values are still written', async () => {
    const copy = join(tmpRoot, 'copy-profile-3')
    mkdirSync(copy, { recursive: true })
    const provider = new FirefoxProvider({ copyDir: copy })
    const result = await provider.applyPrefs({ 'network.trr.mode': 3 }, { applyNow: true })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'privileged_unavailable')
    // The value is NOT lost: it is in the copy and in the runtime set.
    assert.match(readFileSync(join(copy, 'user.js'), 'utf8'), /network\.trr\.mode/)
    assert.equal(provider._runtimePrefs['network.trr.mode'], 3)
  })

  test('the runtime set survives, so the next start re-applies it', async () => {
    const copy = join(tmpRoot, 'copy-profile-4')
    mkdirSync(copy, { recursive: true })
    const provider = new FirefoxProvider({ copyDir: copy })
    await provider.applyPrefs({ 'network.trr.mode': 3 })
    assert.equal(provider._runtimePrefs['network.trr.mode'], 3)
  })

  test('the command timeout can be changed at runtime', async () => {
    const provider = new FirefoxProvider({ timeoutMs: 30000 })
    const result = await provider.config({ timeoutMs: 45000 })
    assert.equal(result.ok, true)
    assert.equal(result.timeoutMs, 45000)
    assert.equal(provider.opts.timeoutMs, 45000)
  })

  test('the hint does not claim the browser already picked the values up', async () => {
    // Firefox reads user.js at startup, so a preference written into the copy
    // is not in effect yet. A hint that says it was applied would send the
    // agent off believing no restart is needed.
    const copy = join(tmpRoot, 'copy-profile-5')
    mkdirSync(copy, { recursive: true })
    const provider = new FirefoxProvider({ copyDir: copy })
    const result = await provider.applyPrefs({ 'network.trr.mode': 3 })

    assert.equal(result.ok, true)
    assert.equal(result.appliedNow.length, 0)
    assert.doesNotMatch(result.hint, /applied to the running browser/)
    assert.match(result.hint, /browser_restart/)
  })

  test('an absurd timeout is refused', async () => {
    const provider = new FirefoxProvider({ timeoutMs: 30000 })
    const result = await provider.config({ timeoutMs: 5 })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid_argument')
    assert.equal(provider.opts.timeoutMs, 30000)
  })
})
