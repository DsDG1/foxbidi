import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publish } from '../tools/publish.mjs'

const REPO = new URL('..', import.meta.url).pathname

test('publish copies exactly the tracked files and nothing else', () => {
  const target = mkdtempSync(join(tmpdir(), 'ffb-publish-'))
  // The real target looks like this: a plugin package plus leftovers.
  mkdirSync(join(target, '.minimax-plugin'), { recursive: true })
  writeFileSync(join(target, '.minimax-plugin', 'plugin.json'), '{}\n')
  writeFileSync(join(target, 'stale.txt'), 'old\n')
  const result = publish({ source: REPO, target })
  assert.equal(result.contract.ok, true)
  assert.ok(!existsSync(join(target, 'stale.txt')), 'stale files must be removed')
  assert.ok(!existsSync(join(target, '.git')), '.git must not be published')
  assert.ok(!existsSync(join(target, 'node_modules')), 'node_modules must not be published')
  const published = []
  const walk = (dir, rel = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const r = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(abs, r)
      else published.push(r)
    }
  }
  walk(target)
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO })
    .toString('utf8')
    .trim()
    .split('\n')
  assert.deepEqual(published.sort(), tracked.sort())
  rmSync(target, { recursive: true, force: true })
})

test('publish refuses to publish a directory onto itself', () => {
  assert.throws(() => publish({ source: REPO, target: REPO }), /itself/)
})
