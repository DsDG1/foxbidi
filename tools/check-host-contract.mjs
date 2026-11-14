#!/usr/bin/env node
// Host package contract check.
//
// The host scans every direct child of the plugins root as a local plugin
// package and applies PLUGIN_PACKAGE_V1_LIMITS plus the "minimax-portable"
// path policy to it. A directory that breaks one of those rules never
// reaches the registry: the plugin vanishes from `mcode plugin list` and the
// agent gets an empty tool list — with no error anywhere. This script
// applies the same rules locally so the failure shows up before shipping.
//
// Usage: node tools/check-host-contract.mjs [directory ...] [--json]
//        node tools/check-host-contract.mjs --package
//
// `--package` checks the package this repository SHIPS — the tracked files
// staged into a temporary directory — rather than the working tree. The
// contract is about the package, so checking the working tree reports a
// failure that does not exist: `node_modules` and `.git` are not part of
// the package, but a file count would include them.

import { execFileSync } from 'node:child_process'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** Mirrors PLUGIN_PACKAGE_V1_LIMITS in the host runtime. */
export const LIMITS = {
  maxFiles: 1024,
  maxEntries: 2048,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxPathBytes: 512,
  maxSegmentBytes: 128,
  maxPathSegments: 16,
}

/** Mirrors PORTABLE_SEGMENT_PATTERN in the host runtime. */
export const PORTABLE_SEGMENT = /^[A-Za-z0-9._-]+$/

function pathViolations(rel) {
  const out = []
  const segments = rel.split('/')
  if (segments.length > LIMITS.maxPathSegments) {
    out.push({
      code: 'TOO_MANY_PATH_SEGMENTS',
      path: rel,
      detail: `${segments.length} > ${LIMITS.maxPathSegments}`,
    })
  }
  const pathBytes = Buffer.byteLength(rel, 'utf8')
  if (pathBytes > LIMITS.maxPathBytes) {
    out.push({ code: 'PATH_TOO_LONG', path: rel, detail: `${pathBytes} > ${LIMITS.maxPathBytes}` })
  }
  for (const segment of segments) {
    if (!PORTABLE_SEGMENT.test(segment)) {
      out.push({ code: 'NON_PORTABLE_PATH', path: rel, detail: `segment "${segment}"` })
    } else if (Buffer.byteLength(segment, 'utf8') > LIMITS.maxSegmentBytes) {
      out.push({ code: 'SEGMENT_TOO_LONG', path: rel, detail: `segment "${segment}"` })
    }
  }
  return out
}

/**
 * Check a directory against the host's plugin package contract.
 *
 * @param {string} root directory to check
 * @returns {{ok: boolean, root: string, files: number, entries: number, totalBytes: number, violations: Array<{code: string, path: string, detail: string}>}}
 */
export function checkHostContract(root) {
  const rootAbs = resolve(root)
  const violations = []
  const prefixes = new Map()
  let files = 0
  let entries = 0
  let totalBytes = 0

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const rel = relative(rootAbs, abs).split(sep).join('/')
      entries += 1
      if (entries > LIMITS.maxEntries) {
        violations.push({
          code: 'TOO_MANY_ENTRIES',
          path: rel,
          detail: `${entries} > ${LIMITS.maxEntries}`,
        })
        return
      }
      const st = lstatSync(abs)
      if (st.isSymbolicLink()) {
        violations.push({ code: 'SYMLINK_NOT_ALLOWED', path: rel, detail: 'symlink' })
        continue
      }
      if (st.isDirectory()) {
        violations.push(...pathViolations(rel))
        walk(abs)
        continue
      }
      if (!st.isFile()) {
        violations.push({
          code: 'SPECIAL_ENTRY_NOT_ALLOWED',
          path: rel,
          detail: 'not a regular file',
        })
        continue
      }
      if (st.nlink > 1) {
        violations.push({ code: 'HARDLINK_NOT_ALLOWED', path: rel, detail: `nlink=${st.nlink}` })
      }
      files += 1
      if (files > LIMITS.maxFiles) {
        violations.push({
          code: 'TOO_MANY_FILES',
          path: rel,
          detail: `${files} > ${LIMITS.maxFiles}`,
        })
      }
      if (st.size > LIMITS.maxFileBytes) {
        violations.push({
          code: 'FILE_TOO_LARGE',
          path: rel,
          detail: `${st.size} > ${LIMITS.maxFileBytes}`,
        })
      }
      totalBytes += st.size
      if (totalBytes > LIMITS.maxTotalBytes) {
        violations.push({
          code: 'TOTAL_SIZE_LIMIT',
          path: rel,
          detail: `${totalBytes} > ${LIMITS.maxTotalBytes}`,
        })
      }
      violations.push(...pathViolations(rel))
      const parts = rel.split('/')
      for (let i = 1; i <= parts.length; i += 1) {
        const prefix = parts.slice(0, i).join('/')
        const key = prefix.toLowerCase()
        const prior = prefixes.get(key)
        if (prior !== undefined && prior !== prefix) {
          violations.push({ code: 'CASE_COLLISION', path: prefix, detail: `${prior} vs ${prefix}` })
        }
        prefixes.set(key, prefix)
      }
    }
  }

  walk(rootAbs)
  return { ok: violations.length === 0, root: rootAbs, files, entries, totalBytes, violations }
}

/**
 * The files the package ships: everything in the git index.
 *
 * The host scans the installed directory as a package, so the package is
 * the TRACKED files and nothing else — no .git, no node_modules, no
 * runtime scratch.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function trackedFiles(source) {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: source,
    maxBuffer: 16 * 1024 * 1024,
  })
  return out.toString('utf8').split('\0').filter(Boolean)
}

/**
 * Copy the tracked files of `source` into `target`.
 *
 * @param {string} source
 * @param {string} target
 * @returns {string[]} the files written
 */
export function stagePackage(source, target) {
  const files = trackedFiles(source)
  for (const file of files) {
    const dest = join(target, file)
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(join(source, file), dest)
  }
  return files
}

/**
 * Check the CONTRACT of the package this repository ships.
 *
 * The contract applies to the PACKAGE, not to the working tree. Running it
 * over the repository root counts `node_modules` and `.git` as files of the
 * package and reports a failure that does not exist — the shipped package
 * is fine. So the tracked files are staged into a temporary directory and
 * THAT is what gets checked.
 *
 * @param {string} source
 * @returns {{ok: boolean, root: string, files: number, entries: number, totalBytes: number, violations: Array<Record<string, any>>}}
 */
export function checkPackageContract(source) {
  const staging = mkdtempSync(join(tmpdir(), 'foxbidi-contract-'))
  try {
    stagePackage(source, staging)
    return checkHostContract(staging)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const asPackage = args.includes('--package')
  const targets = args.filter((a) => !a.startsWith('--'))
  const list = targets.length ? targets : ['.']
  let failed = false
  for (const target of list) {
    const result = asPackage ? checkPackageContract(resolve(target)) : checkHostContract(target)
    if (asJson) {
      console.log(JSON.stringify(result))
    } else {
      const what = asPackage ? 'package' : 'directory'
      console.log(
        `${result.root}: ${result.files} files, ${result.entries} entries, ${result.totalBytes} bytes (${what})`,
      )
      for (const v of result.violations) console.log(`  ✗ ${v.code} ${v.path} — ${v.detail}`)
      if (result.ok) console.log('  ✓ host package contract OK')
    }
    if (!result.ok) failed = true
  }
  process.exit(failed ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
