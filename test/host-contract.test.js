import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkHostContract, LIMITS } from '../tools/check-host-contract.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ffb-contract-'))
  return dir
}

test('a plain directory satisfies the contract', () => {
  const dir = fixture()
  writeFileSync(join(dir, 'server.js'), '// ok\n')
  mkdirSync(join(dir, 'lib'))
  writeFileSync(join(dir, 'lib', 'a.js'), '// ok\n')
  const result = checkHostContract(dir)
  assert.equal(result.ok, true)
  assert.equal(result.files, 2)
  assert.deepEqual(result.violations, [])
  rmSync(dir, { recursive: true, force: true })
})

test('a scoped package path segment is rejected', () => {
  const dir = fixture()
  mkdirSync(join(dir, 'node_modules', '@eslint'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '@eslint', 'x.js'), '// x\n')
  const result = checkHostContract(dir)
  assert.equal(result.ok, false)
  assert.ok(result.violations.some((v) => v.code === 'NON_PORTABLE_PATH'))
  rmSync(dir, { recursive: true, force: true })
})

test('a symlink is rejected', () => {
  const dir = fixture()
  writeFileSync(join(dir, 'real.js'), '// x\n')
  symlinkSync(join(dir, 'real.js'), join(dir, 'link.js'))
  const result = checkHostContract(dir)
  assert.equal(result.ok, false)
  assert.ok(result.violations.some((v) => v.code === 'SYMLINK_NOT_ALLOWED'))
  rmSync(dir, { recursive: true, force: true })
})

test('the published plugin tree satisfies the contract', () => {
  const dir = fixture()
  mkdirSync(join(dir, '.minimax-plugin'), { recursive: true })
  writeFileSync(join(dir, '.minimax-plugin', 'plugin.json'), '{}\n')
  const result = checkHostContract(dir)
  assert.equal(result.ok, true)
  assert.equal(result.files, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('the limits match the host contract', () => {
  assert.equal(LIMITS.maxFiles, 1024)
  assert.equal(LIMITS.maxEntries, 2048)
  assert.equal(LIMITS.maxFileBytes, 16 * 1024 * 1024)
  assert.equal(LIMITS.maxTotalBytes, 64 * 1024 * 1024)
  assert.equal(LIMITS.maxPathBytes, 512)
  assert.equal(LIMITS.maxSegmentBytes, 128)
  assert.equal(LIMITS.maxPathSegments, 16)
})
