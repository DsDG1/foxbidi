// test/firefox-profile.test.js
// Unit tests for profile detection / copying (lib/firefox/profile.js).
//
// Every fixture is built in a temp directory — the tests never touch the
// user's real ~/.mozilla tree.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const absPath = (rel) => pathToFileURL(resolve(HERE, '..', rel)).href

const {
  detectUserProfile,
  isProfileLocked,
  profileFingerprint,
  copyProfile,
  ensureProfileCopy,
  removeProfileCopy,
  profileCopyPath,
} = await import(absPath('lib/firefox/profile.js'))

let tmpRoot

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ffbrowser-profile-'))
})

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

/**
 * Build a fake firefox directory with profiles.ini + profile dirs.
 */
function makeFirefoxDir(opts = {}) {
  const base = mkdtempSync(join(tmpRoot, 'ff-'))
  const profiles = opts.profiles || []
  let ini = ''
  profiles.forEach((p, i) => {
    ini += `[Profile${i}]\nName=${p.name || p.dir}\nIsRelative=1\nPath=${p.dir}\n`
    if (p.default) ini += 'Default=1\n'
    ini += '\n'
  })
  writeFileSync(join(base, 'profiles.ini'), ini)
  for (const p of profiles) {
    const dir = join(base, p.dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cookies.sqlite'), 'cookie-data-' + p.dir)
    writeFileSync(join(dir, 'key4.db'), 'key-data-' + p.dir)
    writeFileSync(join(dir, 'logins.json'), '{}')
  }
  return base
}

// ---------------------------------------------------------------------------
// detectUserProfile
// ---------------------------------------------------------------------------

describe('profile.detectUserProfile', () => {
  test('returns null when there is no firefox directory', () => {
    const empty = join(tmpRoot, 'does-not-exist')
    assert.equal(detectUserProfile(empty), null)
  })

  test('picks the profile marked Default=1', () => {
    const base = makeFirefoxDir({
      profiles: [{ dir: 'abc.default', default: true }, { dir: 'def.default-esr' }],
    })
    const p = detectUserProfile(base)
    assert.ok(p.endsWith('abc.default'))
  })

  test('prefers a LOCKED profile over Default=1', () => {
    // The in-use profile is the one holding the live session, even when
    // profiles.ini points Default=1 at a different (untouched) profile.
    const base = makeFirefoxDir({
      profiles: [{ dir: 'abc.default', default: true }, { dir: 'def.default-esr' }],
    })
    // Firefox's lock is a SYMLINK named `lock` (plus a `.parentlock` file).
    symlinkSync('127.0.1.1:+1234', join(base, 'def.default-esr', 'lock'))
    writeFileSync(join(base, 'def.default-esr', '.parentlock'), '')

    const p = detectUserProfile(base)
    assert.ok(p.endsWith('def.default-esr'), 'the locked profile must win')
  })

  test('falls back to a conventional name when no Default=1 exists', () => {
    const base = makeFirefoxDir({
      profiles: [{ dir: 'aaa.custom' }, { dir: 'zzz.default-release' }],
    })
    const p = detectUserProfile(base)
    assert.ok(p.endsWith('zzz.default-release'))
  })

  test('ignores a profile path that does not exist on disk', () => {
    // A profile listed in profiles.ini whose directory was deleted.
    const base = makeFirefoxDir({
      profiles: [{ dir: 'other.default' }],
    })
    // Write an INI that references a directory we then remove.
    writeFileSync(
      join(base, 'profiles.ini'),
      '[Profile0]\nName=gone\nIsRelative=1\nPath=gone.default\nDefault=1\n',
    )
    rmSync(join(base, 'gone.default'), { recursive: true, force: true })
    // The remaining real profile must win over the stale INI entry.
    const p = detectUserProfile(base)
    assert.ok(p && p.endsWith('other.default'))
    assert.ok(existsSync(p), 'the returned profile must exist on disk')
  })

  test('returns null when every listed profile is missing', () => {
    const base = mkdtempSync(join(tmpRoot, 'ff-empty-'))
    writeFileSync(join(base, 'profiles.ini'), '[Profile0]\nPath=gone.default\nDefault=1\n')
    assert.equal(detectUserProfile(base), null)
  })
})

// ---------------------------------------------------------------------------
// isProfileLocked
// ---------------------------------------------------------------------------

describe('profile.isProfileLocked', () => {
  test('reports unlocked for a directory with no lock markers', () => {
    const dir = mkdtempSync(join(tmpRoot, 'unlocked-'))
    assert.equal(isProfileLocked(dir), false)
  })

  test('detects the `lock` symlink even when it dangles', () => {
    // existsSync() follows symlinks and would report false for a dangling
    // link — the lock must still be detected via lstat.
    const dir = mkdtempSync(join(tmpRoot, 'dangling-'))
    symlinkSync('127.0.1.1:+99999', join(dir, 'lock'))
    assert.equal(isProfileLocked(dir), true)
  })

  test('detects the .parentlock regular file', () => {
    const dir = mkdtempSync(join(tmpRoot, 'parentlock-'))
    writeFileSync(join(dir, '.parentlock'), '')
    assert.equal(isProfileLocked(dir), true)
  })

  test('returns false for a null path', () => {
    assert.equal(isProfileLocked(null), false)
  })
})

// ---------------------------------------------------------------------------
// profileFingerprint
// ---------------------------------------------------------------------------

describe('profile.profileFingerprint', () => {
  test('is stable for an unchanged profile', () => {
    const dir = mkdtempSync(join(tmpRoot, 'fp-'))
    writeFileSync(join(dir, 'cookies.sqlite'), 'abc')
    assert.equal(profileFingerprint(dir), profileFingerprint(dir))
  })

  test('changes when a login-state file changes', () => {
    const dir = mkdtempSync(join(tmpRoot, 'fp2-'))
    writeFileSync(join(dir, 'cookies.sqlite'), 'abc')
    const before = profileFingerprint(dir)
    writeFileSync(join(dir, 'cookies.sqlite'), 'abcd')
    assert.notEqual(profileFingerprint(dir), before)
  })
})

// ---------------------------------------------------------------------------
// copyProfile / ensureProfileCopy
// ---------------------------------------------------------------------------

describe('profile.copyProfile', () => {
  test('copies the login-state files including WAL/SHM siblings', () => {
    const src = mkdtempSync(join(tmpRoot, 'src-'))
    writeFileSync(join(src, 'cookies.sqlite'), 'c')
    writeFileSync(join(src, 'cookies.sqlite-wal'), 'w')
    writeFileSync(join(src, 'cookies.sqlite-shm'), 's')
    writeFileSync(join(src, 'key4.db'), 'k')
    const dest = join(tmpRoot, 'dest-1')

    const res = copyProfile(src, dest)
    assert.equal(res.ok, true)
    assert.ok(existsSync(join(dest, 'cookies.sqlite')))
    assert.ok(existsSync(join(dest, 'cookies.sqlite-wal')), 'WAL must be copied')
    assert.ok(existsSync(join(dest, 'cookies.sqlite-shm')), 'SHM must be copied')
    assert.ok(existsSync(join(dest, 'key4.db')))
  })

  test('removes the lock markers from the copy', () => {
    const src = mkdtempSync(join(tmpRoot, 'src-lock-'))
    writeFileSync(join(src, 'cookies.sqlite'), 'c')
    symlinkSync('127.0.1.1:+1', join(src, 'lock'))
    writeFileSync(join(src, '.parentlock'), '')
    const dest = join(tmpRoot, 'dest-2')

    copyProfile(src, dest)
    assert.equal(existsSync(join(dest, 'lock')), false, 'lock symlink must not be copied')
    assert.equal(existsSync(join(dest, '.parentlock')), false)
  })

  test('reports an error for a missing source', () => {
    const res = copyProfile(join(tmpRoot, 'nope'), join(tmpRoot, 'dest-3'))
    assert.equal(res.ok, false)
    assert.match(res.error, /not found/)
  })
})

describe('profile.ensureProfileCopy', () => {
  test('creates the copy on the first call', () => {
    const src = mkdtempSync(join(tmpRoot, 'ens-src-'))
    writeFileSync(join(src, 'cookies.sqlite'), 'c')
    const dest = join(tmpRoot, 'ens-dest-')

    const res = ensureProfileCopy({ srcDir: src, destDir: dest })
    assert.equal(res.ok, true)
    assert.equal(res.refreshed, true)
    assert.ok(existsSync(join(dest, 'cookies.sqlite')))
  })

  test('does not re-copy when the source is unchanged', () => {
    const src = mkdtempSync(join(tmpRoot, 'ens-src2-'))
    writeFileSync(join(src, 'cookies.sqlite'), 'c')
    const dest = join(tmpRoot, 'ens-dest2-')

    ensureProfileCopy({ srcDir: src, destDir: dest })
    const second = ensureProfileCopy({ srcDir: src, destDir: dest })
    assert.equal(second.refreshed, false, 'an unchanged source must not be re-copied')
  })

  test('re-copies when the source changed', () => {
    const src = mkdtempSync(join(tmpRoot, 'ens-src3-'))
    writeFileSync(join(src, 'cookies.sqlite'), 'c')
    const dest = join(tmpRoot, 'ens-dest3-')

    ensureProfileCopy({ srcDir: src, destDir: dest })
    // Rewrite with different content AND a different size so the
    // fingerprint definitely changes.
    writeFileSync(join(src, 'cookies.sqlite'), 'changed-content-longer')
    const third = ensureProfileCopy({ srcDir: src, destDir: dest })
    assert.equal(third.refreshed, true, 'a changed source must be re-copied')
  })

  test('force always re-copies', () => {
    const src = mkdtempSync(join(tmpRoot, 'ens-src4-'))
    writeFileSync(join(src, 'cookies.sqlite'), 'c')
    const dest = join(tmpRoot, 'ens-dest4-')

    ensureProfileCopy({ srcDir: src, destDir: dest })
    const forced = ensureProfileCopy({ srcDir: src, destDir: dest, force: true })
    assert.equal(forced.refreshed, true)
  })

  test('reports an error when there is no source', () => {
    const res = ensureProfileCopy({ srcDir: '', destDir: join(tmpRoot, 'x') })
    assert.equal(res.ok, false)
  })
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

describe('profile helpers', () => {
  test('profileCopyPath is deterministic per source', () => {
    const a = profileCopyPath('/base', '/home/u/.mozilla/firefox/abc.default')
    const b = profileCopyPath('/base', '/home/u/.mozilla/firefox/abc.default')
    const c = profileCopyPath('/base', '/home/u/.mozilla/firefox/other.default')
    assert.equal(a, b)
    assert.notEqual(a, c)
    assert.ok(a.startsWith('/base'))
  })

  test('removeProfileCopy deletes the directory', () => {
    const dir = join(tmpRoot, 'rm-dest')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'x'), 'x')
    const res = removeProfileCopy(dir)
    assert.equal(res.ok, true)
    assert.equal(existsSync(dir), false)
  })
})
