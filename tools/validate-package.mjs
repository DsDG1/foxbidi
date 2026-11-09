#!/usr/bin/env node
// Local plugin package validation (plugin-creator "Validate before reporting success").
// Run from the plugin root: node tools/validate-package.mjs

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(process.argv[2] || '.')
const problems = []
const notes = []

function fail(msg) {
  problems.push(msg)
}
function ok(msg) {
  notes.push(msg)
}

function readJson(rel) {
  const path = join(ROOT, rel)
  if (!existsSync(path)) {
    fail(`missing file: ${rel}`)
    return null
  }
  const raw = readFileSync(path)
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) fail(`${rel}: has a BOM`)
  const text = raw.toString('utf8')
  try {
    // A duplicate key makes JSON.parse keep the last one silently; detect it.
    const dup = findDuplicateKey(text)
    if (dup) fail(`${rel}: duplicate JSON key ${dup}`)
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      fail(`${rel}: root is not a JSON object`)
    }
    return value
  } catch (e) {
    fail(`${rel}: invalid JSON (${e.message})`)
    return null
  }
}

function findDuplicateKey(text) {
  const stack = []
  let key = null
  let inString = false
  let escaped = false
  let isKey = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') {
        inString = false
        if (isKey) {
          const set = stack[stack.length - 1]
          if (set && set.has(key)) return key
          if (set) set.add(key)
        }
      }
      continue
    }
    if (ch === '"') {
      inString = true
      isKey = false
      key = ''
      continue
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? new Set() : null)
      continue
    }
    if (ch === '}' || ch === ']') {
      stack.pop()
      continue
    }
    if (ch === ':') {
      isKey = true
      continue
    }
    if (isKey) key += ch
  }
  return null
}

function insideRoot(p) {
  const abs = resolve(p)
  return abs === ROOT || abs.startsWith(ROOT + '/')
}

// --- manifest ---------------------------------------------------------------
const manifestPath = '.minimax-plugin/plugin.json'
const manifest = readJson(manifestPath)
if (manifest) {
  for (const field of [
    'schemaVersion',
    'name',
    'displayName',
    'version',
    'description',
    'author',
    'category',
    'icon',
    'exampleQueries',
  ]) {
    if (manifest[field] === undefined) fail(`manifest: missing "${field}"`)
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version || ''))
    fail(`manifest: version "${manifest.version}" is not SemVer`)
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(manifest.name || ''))
    fail(`manifest: bad name "${manifest.name}"`)
  if (!Array.isArray(manifest.exampleQueries) || manifest.exampleQueries.length === 0) {
    fail('manifest: exampleQueries must be a non-empty array')
  }
  if (!Array.isArray(manifest.apps) || manifest.apps.length !== 0) fail('manifest: apps must be []')
  const caps = ['mcpServers', 'skills', 'agents', 'hooks']
  let any = false
  for (const c of caps) {
    if (!Array.isArray(manifest[c])) {
      fail(`manifest: "${c}" must be an array`)
      continue
    }
    if (manifest[c].length) any = true
  }
  if (!any) fail('manifest: no effective capability')

  // every referenced file must exist and stay inside the package
  for (const field of ['icon', 'darkIcon']) {
    const rel = manifest[field]
    if (!rel) continue
    if (rel.includes('..') || rel.startsWith('/') || rel.includes('\\'))
      fail(`manifest: ${field} "${rel}" is not a portable relative path`)
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) fail(`manifest: ${field} "${rel}" does not exist`)
    else if (!insideRoot(abs)) fail(`manifest: ${field} "${rel}" escapes the plugin root`)
  }
  for (const rel of manifest.skills || []) {
    if (rel.includes('..') || rel.startsWith('/'))
      fail(`manifest: skill path "${rel}" is not portable relative`)
    if (!existsSync(join(ROOT, rel))) fail(`manifest: skill "${rel}" does not exist`)
  }
  for (const rel of manifest.mcpServers || []) {
    if (rel.includes('..') || rel.startsWith('/'))
      fail(`manifest: mcp path "${rel}" is not portable relative`)
    if (!existsSync(join(ROOT, rel))) fail(`manifest: mcp "${rel}" does not exist`)
  }
  ok(`manifest ${manifest.name}@${manifest.version} — ${manifest.category}, apps=[]`)
}

// --- skills -----------------------------------------------------------------
const skillDir = join(ROOT, 'skills')
if (existsSync(skillDir)) {
  for (const name of readdirSync(skillDir)) {
    const file = join(skillDir, name, 'SKILL.md')
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!fm) {
      fail(`skills/${name}/SKILL.md: no YAML frontmatter`)
      continue
    }
    const fmName = (fm[1].match(/^name:\s*(.+)$/m) || [])[1]
    const fmDesc = (fm[1].match(/^description:\s*(.+)$/m) || [])[1]
    if (!fmName || fmName.trim() !== name)
      fail(`skills/${name}/SKILL.md: frontmatter name "${fmName}" != directory`)
    if (!fmDesc || !fmDesc.trim()) fail(`skills/${name}/SKILL.md: empty description`)
    ok(`skill ${name}: frontmatter ok`)
  }
}

// --- MCP servers ------------------------------------------------------------
for (const rel of (manifest && manifest.mcpServers) || []) {
  const cfg = readJson(rel)
  if (!cfg) continue
  const servers = cfg.mcpServers || cfg.servers || {}
  for (const [name, def] of Object.entries(servers)) {
    const transport = def.type || def.transport
    if (!['stdio', 'streamable-http', 'sse'].includes(transport)) {
      fail(`${rel}: server "${name}" has unsupported transport "${transport}"`)
    }
    if (transport === 'stdio') {
      if (!def.command) fail(`${rel}: server "${name}" has no command`)
      else if (String(def.command).includes('/'))
        fail(`${rel}: server "${name}" command must be PATH-resolved, got "${def.command}"`)
    } else if (!def.url) {
      fail(`${rel}: server "${name}" has no url`)
    }
    for (const bad of ['auth', 'oauth', 'headers']) {
      if (def[bad]) fail(`${rel}: server "${name}" declares unsupported field "${bad}"`)
    }
    for (const a of def.args || []) {
      const s = String(a)
      if (s.includes('..')) fail(`${rel}: server "${name}" arg "${s}" escapes the package`)
    }
    ok(`mcp ${name}: ${transport}`)
  }
}

// --- javascript syntax ------------------------------------------------------
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      try {
        execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' })
      } catch (e) {
        fail(`syntax error in ${relative(ROOT, full)}`)
      }
    }
  }
}
walk(ROOT)
ok('all javascript files parse')

// --- no stray absolute paths / symlinks --------------------------------------
function checkPaths(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) fail(`symlink inside package: ${relative(ROOT, full)}`)
    else if (entry.isDirectory()) checkPaths(full)
  }
}
checkPaths(ROOT)

console.log('checks passed:')
for (const n of notes) console.log('  ✓', n)
if (problems.length) {
  console.log('\nPROBLEMS:')
  for (const p of problems) console.log('  ✗', p)
  process.exit(1)
}
console.log('\npackage validation OK')
