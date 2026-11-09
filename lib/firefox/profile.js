// lib/firefox/profile.js
// Locate the user's Firefox profile and make a private copy we can drive.
//
// WHY A COPY (and not "attach to the running Firefox"):
//
//   1. Firefox's `--remote-debugging-port` is a STARTUP flag. A Firefox that
//      is already running cannot be given a BiDi endpoint afterwards — the
//      `remote.active-protocols` pref only takes effect on restart.
//   2. The running instance holds an exclusive lock on its profile
//      (`parent.lock` → `127.0.1.1:+<pid>`), so the same directory cannot be
//      opened by a second instance.
//
//   So the only way to drive a Firefox that carries the user's real login
//   state is: copy the profile, then launch a second instance against the
//   copy with the BiDi port enabled.
//
// WHAT THE COPY BUYS US: cookies.sqlite + key4.db + logins.json travel with
// the copy, so sites the user is logged into stay logged in (verified: 322
// cookies carried over). WHAT IT COSTS: the copy is a snapshot — tabs are
// not shared, and later changes in the real Firefox need a re-copy.
//
// SAFETY: the copy contains live credentials. It lives under the plugin's
// own data directory with 0700 permissions and is never served over HTTP.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  lstatSync,
  rmSync,
  chmodSync,
} from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

/**
 * Files that carry login state and MUST be copied verbatim.
 * The `-wal` / `-shm` siblings matter: Firefox keeps recent writes in the
 * write-ahead log, so copying only `cookies.sqlite` yields a stale snapshot.
 */
const ESSENTIAL_FILES = [
  'cookies.sqlite',
  'cookies.sqlite-wal',
  'cookies.sqlite-shm',
  'key4.db',
  'key4.db-wal',
  'key4.db-shm',
  'logins.json',
  'logins-backup.json',
  'cert9.db',
  'cert9.db-wal',
  'cert9.db-shm',
  'places.sqlite',
  'places.sqlite-wal',
  'places.sqlite-shm',
  'formhistory.sqlite',
  'formhistory.sqlite-wal',
  'formhistory.sqlite-shm',
  'permissions.sqlite',
  'extensions.json',
  'handlers.json',
  'prefs.js',
  'user.js',
]

/**
 * Parse `~/.mozilla/firefox/profiles.ini` and return the profile to copy.
 *
 * The INI format uses `Path=` / `Default=1` pairs under `[ProfileN]`
 * sections. `Default=1` marks the profile Firefox uses for NEW windows —
 * but it is NOT necessarily the one the user has open right now. On a
 * machine with both a release and an ESR install, `Default=1` can point at
 * an untouched profile while the user actually browses in the other one.
 *
 * Selection order:
 *   1. A LOCKED profile (one with parent.lock) — that is the profile a
 *      running Firefox owns, i.e. the one holding the user's live session.
 *   2. `Default=1`.
 *   3. Conventional `*.default-release` / `*.default-esr` / `*.default` name.
 *   4. Any existing profile.
 *
 * @param {string} [firefoxDir]  defaults to ~/.mozilla/firefox
 * @returns {string|null} absolute profile path, or null when not found
 */
export function detectUserProfile(firefoxDir) {
  const base = firefoxDir || join(homedir(), '.mozilla', 'firefox')
  const iniPath = join(base, 'profiles.ini')

  if (existsSync(iniPath)) {
    const raw = readFileSync(iniPath, 'utf8')
    const sections = raw.split(/\r?\n\[/)
    const candidates = []
    let defaultProfile = null
    for (const section of sections) {
      const pathMatch = section.match(/^Path=(.+)$/m)
      if (!pathMatch) continue
      const rel = pathMatch[1].trim()
      const abs = resolve(base, rel)
      if (!existsSync(abs)) continue
      candidates.push(abs)
      if (/^Default=1\s*$/m.test(section)) defaultProfile = abs
    }

    // 1) A profile currently in use by a running Firefox.
    const locked = candidates.find((p) => isProfileLocked(p))
    if (locked) return locked

    // 2) The configured default.
    if (defaultProfile) return defaultProfile

    // 3) Conventional names.
    const named = candidates.find((p) => /\.(default-release|default-esr|default)$/.test(p))
    if (named) return named

    // 4) Anything at all.
    if (candidates.length > 0) return candidates[0]
  }

  // Fallback: conventional directory names under the firefox dir.
  try {
    const entries = readdirSync(base)
    const named = entries.filter((e) => /\.(default-release|default-esr|default)$/.test(e))
    // Only return a directory that actually exists — a stale entry in
    // profiles.ini must not send the launcher at a non-existent path.
    for (const entry of named) {
      const p = join(base, entry)
      try {
        if (statSync(p).isDirectory()) return p
      } catch {}
    }
  } catch {}
  return null
}

/**
 * Is the profile currently locked by a running Firefox?
 *
 * Firefox uses TWO lock markers, and neither is named `parent.lock`:
 *   - `lock`       — a SYMLINK pointing at `<ip>:+<pid>`; it is a symlink,
 *                    so it can be DANGLING (target gone) while the lock
 *                    file itself still exists. `existsSync` follows
 *                    symlinks and would report false for a dangling one —
 *                    we must use lstat.
 *   - `.parentlock` — a zero-byte regular file.
 *
 * Both indicate "a Firefox instance owns this profile".
 *
 * @param {string} profileDir
 * @returns {boolean}
 */
export function isProfileLocked(profileDir) {
  if (!profileDir) return false
  for (const name of ['lock', '.parentlock', 'parent.lock']) {
    const p = join(profileDir, name)
    try {
      // lstat does NOT follow the symlink — a dangling `lock` symlink still
      // counts as a lock.
      lstatSync(p)
      return true
    } catch {
      // not present
    }
  }
  return false
}

/**
 * Names of the lock markers present in a profile directory.
 *
 * Used by the launcher to explain WHY a launch failed (a locked profile is
 * a different failure from a busy port) and by the provider to decide
 * whether a kept-alive instance still owns the profile copy.
 *
 * @param {string} profileDir
 * @returns {string[]}
 */
export function profileLockMarkers(profileDir) {
  if (!profileDir) return []
  const found = []
  for (const name of ['lock', '.parentlock', 'parent.lock']) {
    try {
      lstatSync(join(profileDir, name))
      found.push(name)
    } catch {
      // not present
    }
  }
  return found
}

/**
 * Fingerprint the source profile's login-state files.
 *
 * Used to decide whether an existing copy is stale. We hash the mtime+size
 * of the essential files — cheap, and enough to notice "the user logged into
 * something new since we copied".
 *
 * @param {string} profileDir
 * @returns {string} hex digest
 */
export function profileFingerprint(profileDir) {
  const h = createHash('sha256')
  for (const name of ESSENTIAL_FILES) {
    const p = join(profileDir, name)
    try {
      const st = statSync(p)
      h.update(`${name}:${st.size}:${Math.floor(st.mtimeMs)}\n`)
    } catch {
      h.update(`${name}:-\n`)
    }
  }
  return h.digest('hex')
}

/**
 * Copy the source profile into `destDir`, replacing any previous copy.
 *
 * @param {string} srcDir   source profile
 * @param {string} destDir  destination directory (created if absent)
 * @returns {{ok: boolean, error?: string, copied: string[]}}
 */
export function copyProfile(srcDir, destDir) {
  if (!srcDir || !existsSync(srcDir)) {
    return { ok: false, error: `source profile not found: ${srcDir}`, copied: [] }
  }
  const copied = []
  try {
    // Remove the previous copy first — a stale copy is worse than none.
    rmSync(destDir, { recursive: true, force: true })
    mkdirSync(destDir, { recursive: true, mode: 0o700 })

    for (const name of ESSENTIAL_FILES) {
      const src = join(srcDir, name)
      if (!existsSync(src)) continue
      copyFileSync(src, join(destDir, name))
      copied.push(name)
    }

    // The copy must NOT carry the lock files — otherwise the new instance
    // thinks another Firefox already owns this profile and refuses to start
    // ("Firefox is already running, but is not responding").
    for (const lockName of ['parent.lock', 'lock', '.parentlock']) {
      const p = join(destDir, lockName)
      if (existsSync(p)) rmSync(p, { force: true })
    }

    // Credentials live in here — keep it owner-only.
    try {
      chmodSync(destDir, 0o700)
    } catch {}
    return { ok: true, copied }
  } catch (e) {
    return { ok: false, error: e.message, copied }
  }
}

/**
 * Ensure a usable profile copy exists at `destDir`, refreshing it when the
 * source changed.
 *
 * @param {object} opts
 * @param {string} opts.srcDir   source profile (user's real one)
 * @param {string} opts.destDir  where the copy lives
 * @param {boolean} [opts.force]  always re-copy, ignoring the fingerprint
 * @returns {{ok: boolean, error?: string, srcDir: string, destDir: string, refreshed: boolean, copied: string[]}}
 */
export function ensureProfileCopy(opts) {
  const srcDir = opts.srcDir
  const destDir = opts.destDir
  if (!srcDir) {
    return { ok: false, error: 'no source profile detected', srcDir: '', destDir, refreshed: false, copied: [] }
  }
  if (!existsSync(srcDir)) {
    return { ok: false, error: `source profile not found: ${srcDir}`, srcDir, destDir, refreshed: false, copied: [] }
  }

  const srcFingerprint = profileFingerprint(srcDir)

  if (!opts.force && existsSync(destDir)) {
    const markerPath = join(destDir, '.firefox-browser-fingerprint')
    if (existsSync(markerPath)) {
      try {
        const prev = readFileSync(markerPath, 'utf8').trim()
        if (prev === srcFingerprint) {
          return {
            ok: true,
            srcDir,
            destDir,
            refreshed: false,
            copied: [],
          }
        }
      } catch {}
    }
  }

  const result = copyProfile(srcDir, destDir)
  if (!result.ok) {
    return { ok: false, error: result.error, srcDir, destDir, refreshed: false, copied: [] }
  }
  try {
    const markerPath = join(destDir, '.firefox-browser-fingerprint')
    // The fingerprint file lives INSIDE the copy, but copyProfile() only
    // copies ESSENTIAL_FILES — so it is written after the copy completes.
    writeFileSafe(markerPath, srcFingerprint)
  } catch {}
  return {
    ok: true,
    srcDir,
    destDir,
    refreshed: true,
    copied: result.copied,
  }
}

/**
 * Write a small text file, ignoring failures (best-effort marker).
 */
function writeFileSafe(path, content) {
  try {
    writeFileSync(path, content, { mode: 0o600 })
  } catch {}
}

/**
 * Apply extra preferences to a profile COPY.
 *
 * Only the copy is touched — the user's real profile is never modified.
 *
 * The preferences are appended to the copy's `user.js`, which Firefox reads
 * AFTER `prefs.js`, so they win. The existing `user.js` content is kept:
 * an operator may have preferences there that still matter.
 *
 * @param {string} destDir  the profile copy
 * @param {object} prefs    e.g. { 'privacy.resistFingerprinting': true }
 * @returns {{ok: boolean, applied: string[], error?: string}}
 */
export function applyProfilePrefs(destDir, prefs) {
  const entries = Object.entries(prefs || {})
  if (!entries.length) return { ok: true, applied: [] }
  const userJs = join(destDir, 'user.js')
  let existing = ''
  try {
    if (existsSync(userJs)) existing = readFileSync(userJs, 'utf8')
  } catch {
    existing = ''
  }
  const lines = entries.map(([name, value]) => {
    const serialized = typeof value === 'string' ? JSON.stringify(value) : String(value)
    return `user_pref(${JSON.stringify(name)}, ${serialized});`
  })
  const body = existing && !existing.endsWith('\n') ? existing + '\n' : existing
  const content = `${body}// --- firefox-browser plugin overrides ---\n${lines.join('\n')}\n`
  try {
    writeFileSync(userJs, content, { mode: 0o600 })
    return { ok: true, applied: entries.map(([name]) => name) }
  } catch (e) {
    return { ok: false, applied: [], error: e.message }
  }
}

/**
 * Read the extra preferences from the environment.
 *
 * `FIREFOX_BROWSER_PREFS` is a JSON object, e.g.
 * `FIREFOX_BROWSER_PREFS='{"privacy.resistFingerprinting":true}'`.
 *
 * @returns {{ok: boolean, prefs: object, error?: string}}
 */
export function prefsFromEnvironment(env = process.env) {
  const raw = (env.FIREFOX_BROWSER_PREFS || '').trim()
  if (!raw) return { ok: true, prefs: {} }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, prefs: {}, error: 'FIREFOX_BROWSER_PREFS must be a JSON object' }
    }
    return { ok: true, prefs: parsed }
  } catch (e) {
    return { ok: false, prefs: {}, error: `FIREFOX_BROWSER_PREFS is not valid JSON: ${e.message}` }
  }
}

/**
 * Remove the profile copy (used by the CLI's `cleanup` command).
 *
 * @param {string} destDir
 * @returns {{ok: boolean, error?: string}}
 */
export function removeProfileCopy(destDir) {
  try {
    rmSync(destDir, { recursive: true, force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * Build the destination path for a profile copy.
 *
 * The copy lives under the plugin's own data directory — never inside the
 * user's ~/.mozilla tree, so Firefox itself never sees a stray profile.
 *
 * @param {string} baseDir  plugin data dir
 * @param {string} srcDir   source profile path
 * @returns {string}
 */
export function profileCopyPath(baseDir, srcDir) {
  const key = createHash('sha256')
    .update(String(srcDir || ''))
    .digest('hex')
    .slice(0, 12)
  return join(baseDir, `profile-${key}`)
}

/**
 * Human-readable label for a profile path (used in status output).
 */
export function profileLabel(profileDir) {
  if (!profileDir) return 'none'
  return basename(profileDir)
}
