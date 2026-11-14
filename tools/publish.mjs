#!/usr/bin/env node
// Publish the plugin package into the host's plugins root.
//
// The host scans the installed directory as a package: it must contain
// exactly the tracked source files and nothing else — no .git, no
// node_modules, no runtime scratch. This script writes that directory from
// the git index and then re-checks it against the host contract.
//
// Usage:
//   node tools/publish.mjs [--target <dir>] [--dry-run] [--force]

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkHostContract, trackedFiles } from './check-host-contract.mjs'

// The repository this script ships in — not the current working directory,
// and not argv (the CLI flags would be mistaken for a source path).
const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Write the tracked files of `source` into `target` and verify the result.
 *
 * @param {{source?: string, target?: string, dryRun?: boolean, force?: boolean}} [options]
 * @returns {{target: string, files: string[], contract: Record<string, any>}}
 */
export function publish({ source = SOURCE, target = '', dryRun = false, force = false } = {}) {
  const sourceAbs = resolve(source)
  const targetAbs = resolve(target)
  if (targetAbs === sourceAbs) throw new Error('refusing to publish a directory onto itself')

  const files = trackedFiles(sourceAbs)
  if (!files.length) throw new Error('git ls-files returned nothing — is this a git repository?')

  if (!dryRun) {
    if (existsSync(targetAbs)) {
      const existing = readdirSync(targetAbs)
      const looksLikeAPackage =
        existing.length === 0 || existing.includes('.minimax-plugin') || force
      if (!looksLikeAPackage) {
        throw new Error(
          `refusing to wipe ${targetAbs}: it does not look like a plugin package (use --force)`,
        )
      }
      for (const entry of existing) rmSync(join(targetAbs, entry), { recursive: true, force: true })
    } else {
      mkdirSync(targetAbs, { recursive: true })
    }
    for (const file of files) {
      const dest = join(targetAbs, file)
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(join(sourceAbs, file), dest)
    }
  }

  const contract = dryRun
    ? {
        ok: true,
        root: targetAbs,
        files: files.length,
        entries: files.length,
        totalBytes: 0,
        violations: [],
      }
    : checkHostContract(targetAbs)
  return { target: targetAbs, files, contract }
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const force = args.includes('--force')
  let target
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--target') target = args[i + 1]
  }
  target = target || join(homedir(), '.minimax', 'plugins', 'firefox-browser')
  const result = publish({ target, dryRun, force })
  console.log(
    `${dryRun ? 'would publish' : 'published'} ${result.files.length} files → ${result.target}`,
  )
  for (const v of result.contract.violations) console.log(`  ✗ ${v.code} ${v.path} — ${v.detail}`)
  if (!result.contract.ok) process.exit(1)
  console.log('  ✓ host package contract OK')
}

if (import.meta.url === `file://${process.argv[1]}`) main()
