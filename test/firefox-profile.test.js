// test/firefox-profile.test.js
// Unit tests for profile detection / copying (lib/firefox/profile.js).
//
// Every fixture is built in a temp directory — the tests never touch the
// user's real ~/.mozilla tree.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  chmodSync,
  statSync,
  utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve, basename, isAbsolute } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const absPath = (rel) => pathToFileURL(resolve(HERE, '..', rel)).href

const {
  defaultFirefoxDirs,
  detectUserProfile,
  isProfileLocked,
  profileFingerprint,
  copyProfile,
  ensureProfileCopy,
  ensureFreshProfile,
  profileFromEnvironment,
  removeProfileCopy,
  profileCopyPath,
  profileCopyTtlHours,
  isProfileCopyExpired,
  removeStaleProfileCopies,
  resolveSourceProfile,
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
// profileFromEnvironment
// ---------------------------------------------------------------------------

describe('profile.profileFromEnvironment', () => {
  test('returns null when the variable is unset', () => {
    assert.equal(profileFromEnvironment({}), null)
  })

  test('returns null for a blank value', () => {
    assert.equal(profileFromEnvironment({ FIREFOX_BROWSER_PROFILE: '   ' }), null)
  })

  test('returns the pinned path', () => {
    const p = profileFromEnvironment({ FIREFOX_BROWSER_PROFILE: '/tmp/pinned-profile' })
    assert.equal(p, '/tmp/pinned-profile')
  })

  test('resolves a relative path to an absolute one', () => {
    const p = profileFromEnvironment({ FIREFOX_BROWSER_PROFILE: 'relative/profile' })
    assert.ok(isAbsolute(p), `expected an absolute path, got ${p}`)
  })
})

// ---------------------------------------------------------------------------
// ensureFreshProfile
// ---------------------------------------------------------------------------

describe('profile.ensureFreshProfile', () => {
  test('creates the directory', () => {
    const res = ensureFreshProfile(join(tmpRoot, 'fresh-base'))
    assert.equal(res.ok, true)
    assert.ok(existsSync(res.dir), 'the fresh profile must exist')
    assert.ok(statSync(res.dir).isDirectory())
  })

  test('the name does not start with profile-', () => {
    // That prefix marks the profile COPIES, and the stale-copy cleanup
    // deletes every profile-* directory except the one it is told to keep.
    const res = ensureFreshProfile(join(tmpRoot, 'fresh-base-2'))
    assert.ok(
      !basename(res.dir).startsWith('profile-'),
      `the fresh profile must not look like a copy: ${basename(res.dir)}`,
    )
  })

  test('survives the stale-copy cleanup', () => {
    const base = join(tmpRoot, 'fresh-base-3')
    const fresh = ensureFreshProfile(base)
    removeStaleProfileCopies(base, profileCopyPath(base, fresh.dir))
    assert.ok(existsSync(fresh.dir), 'the fresh profile must survive the stale-copy cleanup')
  })

  test('reuses the same directory on a second call', () => {
    const base = join(tmpRoot, 'fresh-base-4')
    const a = ensureFreshProfile(base)
    const b = ensureFreshProfile(base)
    assert.equal(a.dir, b.dir)
  })
})

// ---------------------------------------------------------------------------
// resolveSourceProfile
// ---------------------------------------------------------------------------

describe('profile.resolveSourceProfile', () => {
  test('an explicit profile wins over everything', () => {
    const res = resolveSourceProfile({
      explicit: '/tmp/explicit',
      detected: '/tmp/detected',
      copyBase: join(tmpRoot, 'rs-base'),
    })
    assert.equal(res.srcProfile, '/tmp/explicit')
    assert.equal(res.fresh, false)
  })

  test('the detected user profile wins over a fresh one', () => {
    const res = resolveSourceProfile({
      detected: '/tmp/detected',
      copyBase: join(tmpRoot, 'rs-base-2'),
    })
    assert.equal(res.srcProfile, '/tmp/detected')
    assert.equal(res.fresh, false)
  })

  test('a machine without a user profile gets a fresh one', () => {
    // The case that broke CI: Firefox installed, never launched, no profile.
    const res = resolveSourceProfile({ copyBase: join(tmpRoot, 'rs-base-3') })
    assert.equal(res.fresh, true)
    assert.ok(existsSync(res.srcProfile), 'the fresh profile must exist')
  })

  test('an explicit profile never falls back to a fresh one', () => {
    // The operator pinned a path; a missing one is reported by the copy
    // step, not silently replaced by an empty profile.
    const missing = join(tmpRoot, 'does-not-exist')
    const res = resolveSourceProfile({
      explicit: missing,
      copyBase: join(tmpRoot, 'rs-base-4'),
    })
    assert.equal(res.srcProfile, missing)
    assert.equal(res.fresh, false)
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

  test('the credential files are owner-only', () => {
    // The copy holds live cookies and the encrypted password database.
    // The DIRECTORY is 0700, but `copyFileSync` preserved the source
    // modes — which put cookies.sqlite at 0644 and logins.json at 0664.
    // The directory blocks traversal today; the file mode is what
    // protects a copy that is archived, synced or moved.
    const src = mkdtempSync(join(tmpRoot, 'src-perm-'))
    writeFileSync(join(src, 'cookies.sqlite'), 'c')
    writeFileSync(join(src, 'key4.db'), 'k')
    writeFileSync(join(src, 'logins.json'), '{}')
    chmodSync(join(src, 'cookies.sqlite'), 0o644)
    chmodSync(join(src, 'logins.json'), 0o664)
    const dest = join(tmpRoot, 'dest-perm')

    const res = copyProfile(src, dest)
    assert.equal(res.ok, true)

    const mode = (p) => statSync(p).mode & 0o777
    assert.equal(mode(join(dest, 'cookies.sqlite')), 0o600)
    assert.equal(mode(join(dest, 'key4.db')), 0o600)
    assert.equal(mode(join(dest, 'logins.json')), 0o600)
    // The directory itself stays owner-only.
    assert.equal(mode(dest), 0o700)
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

  test('a forced re-copy clears the lock markers of a killed browser', () => {
    // A Firefox that was killed rather than stopped leaves its lock markers
    // behind. Reusing such a copy carries them into the next launch, and
    // Firefox refuses to start on a locked profile — "Firefox is already
    // running, but is not responding". This is why the FRESH profile (whose
    // fingerprint never changes, so the copy would be reused forever) is
    // rebuilt on every start instead.
    const src = mkdtempSync(join(tmpRoot, 'ens-src5-'))
    const dest = join(tmpRoot, 'ens-dest5-')

    ensureProfileCopy({ srcDir: src, destDir: dest })
    writeFileSync(join(dest, '.parentlock'), '')
    symlinkSync('127.0.1.1:+1234', join(dest, 'lock'))

    const forced = ensureProfileCopy({ srcDir: src, destDir: dest, force: true })
    assert.equal(forced.ok, true)
    assert.ok(!existsSync(join(dest, '.parentlock')), 'the stale lock file must be gone')
    assert.ok(!existsSync(join(dest, 'lock')), 'the stale lock symlink must be gone')
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

  test('the copy TTL defaults to 24 hours', () => {
    assert.equal(profileCopyTtlHours({}), 24)
  })

  test('the copy TTL is configurable and 0 disables it', () => {
    assert.equal(profileCopyTtlHours({ FIREFOX_BROWSER_PROFILE_TTL_HOURS: '4' }), 4)
    assert.equal(profileCopyTtlHours({ FIREFOX_BROWSER_PROFILE_TTL_HOURS: '0' }), 0)
  })

  test('a nonsense TTL falls back to the default', () => {
    assert.equal(profileCopyTtlHours({ FIREFOX_BROWSER_PROFILE_TTL_HOURS: 'abc' }), 24)
    assert.equal(profileCopyTtlHours({ FIREFOX_BROWSER_PROFILE_TTL_HOURS: '-5' }), 24)
  })

  test('an old copy is expired and a fresh one is not', () => {
    const dir = join(tmpRoot, 'ttl-dir')
    mkdirSync(dir, { recursive: true })
    // Two days old.
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    utimesSync(dir, old, old)
    assert.equal(isProfileCopyExpired(dir, { FIREFOX_BROWSER_PROFILE_TTL_HOURS: '24' }), true)
    assert.equal(isProfileCopyExpired(dir, { FIREFOX_BROWSER_PROFILE_TTL_HOURS: '0' }), false)
    assert.equal(isProfileCopyExpired(dir, { FIREFOX_BROWSER_PROFILE_TTL_HOURS: '168' }), false)
  })

  test('an expired copy is rebuilt rather than reused', () => {
    const src = mkdtempSync(join(tmpRoot, 'ttl-src-'))
    writeFileSync(join(src, 'cookies.sqlite'), 'c')
    const dest = join(tmpRoot, 'ttl-dest')

    const first = ensureProfileCopy({ srcDir: src, destDir: dest })
    assert.equal(first.ok, true)
    assert.equal(first.refreshed, true)

    // A second call reuses it — the source has not changed.
    const second = ensureProfileCopy({ srcDir: src, destDir: dest })
    assert.equal(second.refreshed, false)

    // Now age the copy past its TTL.
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    utimesSync(dest, old, old)

    const third = ensureProfileCopy({
      srcDir: src,
      destDir: dest,
      env: { FIREFOX_BROWSER_PROFILE_TTL_HOURS: '24' },
    })
    assert.equal(third.ok, true)
    assert.equal(third.refreshed, true, 'an expired copy must be rebuilt, not reused')
  })

  test('copies for other source profiles are removed from the base directory', () => {
    const base = join(tmpRoot, 'stale-base')
    mkdirSync(base, { recursive: true })
    const keep = join(base, 'profile-keep')
    const stale = join(base, 'profile-stale')
    mkdirSync(keep)
    mkdirSync(stale)
    writeFileSync(join(stale, 'cookies.sqlite'), 'c')

    const removed = removeStaleProfileCopies(base, keep)
    assert.equal(removed.length, 1)
    assert.equal(existsSync(stale), false)
    assert.equal(existsSync(keep), true, 'the copy in use must survive')
  })

  test('the cleanup only touches profile-* directories', () => {
    const base = join(tmpRoot, 'stale-base-2')
    mkdirSync(base, { recursive: true })
    const keep = join(base, 'profile-keep')
    mkdirSync(keep)
    const other = join(base, 'not-a-profile')
    mkdirSync(other)

    removeStaleProfileCopies(base, keep)
    assert.equal(existsSync(other), true)
  })

  test('removeStaleProfileCopies does not delete locked profile-* directories', () => {
    const base = join(tmpRoot, 'stale-base-locked')
    mkdirSync(base, { recursive: true })
    const keep = join(base, 'profile-keep')
    const activeOther = join(base, 'profile-active-other')
    const unlockedStale = join(base, 'profile-unlocked-stale')
    mkdirSync(keep)
    mkdirSync(activeOther)
    mkdirSync(unlockedStale)
    writeFileSync(join(activeOther, '.parentlock'), '')

    const removed = removeStaleProfileCopies(base, keep)
    assert.deepEqual(removed, [unlockedStale])
    assert.equal(existsSync(unlockedStale), false)
    assert.equal(existsSync(activeOther), true, 'locked profile copy must survive cleanup')
  })

  test('defaultFirefoxDirs covers macOS, Windows, and Linux locations', () => {
    const mac = defaultFirefoxDirs('darwin', {}, '/Users/alice')
    assert.ok(mac[0].endsWith('Library/Application Support/Firefox'))

    const win = defaultFirefoxDirs('win32', { APPDATA: '/win/AppData/Roaming' }, '/Users/alice')
    assert.ok(win[0].includes('Mozilla'))

    const linux = defaultFirefoxDirs('linux', {}, '/home/alice')
    assert.ok(linux[0].endsWith('.mozilla/firefox'))
  })

  test('detectUserProfile honours [Install...] Default= over legacy Default=1 and supports IsRelative=0', () => {
    const base = mkdtempSync(join(tmpRoot, 'ff-install-'))
    const legacyDir = join(base, 'Profiles', 'legacy.default')
    const activeDir = join(base, 'Profiles', 'active.default-release')
    mkdirSync(legacyDir, { recursive: true })
    mkdirSync(activeDir, { recursive: true })
    writeFileSync(
      join(base, 'profiles.ini'),
      [
        '[Install4F96D1932A9F858E]',
        'Default=Profiles/active.default-release',
        'Locked=1',
        '',
        '[Profile0]',
        'Name=default',
        'IsRelative=1',
        'Path=Profiles/legacy.default',
        'Default=1',
        '',
        '[Profile1]',
        'Name=default-release',
        'IsRelative=0',
        `Path=${activeDir}`,
        '',
      ].join('\n'),
    )

    const chosen = detectUserProfile(base)
    assert.equal(chosen, activeDir)
  })

  test('copyProfile copies storage/default ls and idb while skipping ServiceWorker cache and locks', () => {
    const src = mkdtempSync(join(tmpRoot, 'src-storage-'))
    writeFileSync(join(src, 'cookies.sqlite'), 'c')
    const originDir = join(src, 'storage', 'default', 'https+++example.com')
    mkdirSync(join(originDir, 'ls'), { recursive: true })
    mkdirSync(join(originDir, 'idb'), { recursive: true })
    mkdirSync(join(originDir, 'cache'), { recursive: true })
    writeFileSync(join(originDir, '.metadata-v2'), 'meta')
    writeFileSync(join(originDir, 'ls', 'data.sqlite'), 'localstorage-bytes')
    writeFileSync(join(originDir, 'idb', 'store.sqlite'), 'idb-bytes')
    writeFileSync(join(originDir, 'cache', 'big.bin'), 'cached-asset')
    writeFileSync(join(originDir, '.parentlock'), '')

    const dest = join(tmpRoot, 'dest-storage')
    const res = copyProfile(src, dest)
    assert.equal(res.ok, true)

    const destOrigin = join(dest, 'storage', 'default', 'https+++example.com')
    assert.equal(existsSync(join(destOrigin, 'ls', 'data.sqlite')), true)
    assert.equal(existsSync(join(destOrigin, 'idb', 'store.sqlite')), true)
    assert.equal(existsSync(join(destOrigin, '.metadata-v2')), true)
    assert.equal(existsSync(join(destOrigin, 'cache')), false, 'SW cache must be skipped')
    assert.equal(existsSync(join(destOrigin, '.parentlock')), false)
    assert.equal(statSync(join(destOrigin, 'ls', 'data.sqlite')).mode & 0o777, 0o600)
  })
})
