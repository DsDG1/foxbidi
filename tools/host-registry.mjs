#!/usr/bin/env node
// Finding this plugin's entry in the host's MCP tool registry, and deciding
// whether that registry still matches the code.
//
// WHY THE LOOKUP IS NOT A PLAIN `find()`
//
// The host's registry file can hold MORE THAN ONE entry for this plugin. A
// plugin that was renamed — or that was installed a second time under a
// different name — leaves the old entry behind, and both entries carry the
// same `raw` server name. Looking an entry up by that raw name returns
// whichever one happens to come first in the file, which is not necessarily
// the entry the host is actually using.
//
// The entry the host uses is keyed by the PLUGIN NAME from the manifest:
//
//   ["plugin", <scope>, <manifest name>, <server name>]
//
// so that is what the lookup has to go by. On this machine the stale entry
// (`parts[2] === "firefox-browser"`, left over from an older manifest) and
// the live one (`parts[2] === "foxbidi"`) both have `raw === "firefox-browser"`,
// and only the latter is the one the host injects.
//
// WHY THE EXPECTED SET IS NOT THE FULL CATALOGUE
//
// The server trims its advertised tool list to the active preset BEFORE the
// host lists it. The default preset exposes 36 of the 43 tools, so a host
// that registers 36 tools is working exactly as designed. Comparing that with
// the full catalogue would report seven "missing" tools that are simply
// behind the preset — a false alarm that sends the maintainer chasing a
// problem that does not exist.
//
// WHAT IS ACTUALLY WORTH FLAGGING
//
//   missing — the host does not know a tool the default preset exposes: the
//             host is running an older build of this plugin.
//   unknown — the host knows a tool the code no longer has: the code dropped
//             it and the host has not rescanned.
//
// A host that exposes MORE than the default preset is not a problem: the
// operator may have widened the preset deliberately, so those tools are
// reported as `wider`, not as a mismatch.

import { presetTools } from '../lib/firefox/provider/workflow.js'

/**
 * The preset the server starts with, and therefore the tool list the host
 * registers when it first scans the plugin.
 */
export const DEFAULT_PRESET = 'basic'

/**
 * Parse a registry key into its parts.
 *
 * @param {string} key
 * @returns {string[]|null}
 */
export function parseRegistryKey(key) {
  try {
    const parsed = JSON.parse(key)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Find the registry entry that belongs to this plugin.
 *
 * @param {Array<object>} servers the registry's `servers` array
 * @param {string} manifestName the plugin name from `.minimax-plugin/plugin.json`
 * @returns {object|null} the entry, or null when the plugin is not registered
 */
export function findPluginEntry(servers, manifestName) {
  const list = Array.isArray(servers) ? servers : []
  const parts = list.map((s) => parseRegistryKey(s && s.key))
  const index = parts.findIndex((p) => p && p[2] === manifestName)
  if (index >= 0) return list[index]
  return null
}

/**
 * The plugin names the registry holds an entry for.
 *
 * @param {Array<object>} servers
 * @returns {string[]}
 */
export function registeredPluginNames(servers) {
  const list = Array.isArray(servers) ? servers : []
  const names = new Set()
  for (const server of list) {
    const parts = parseRegistryKey(server && server.key)
    if (parts && parts[2]) names.add(parts[2])
  }
  return [...names]
}

/**
 * Compare a registry entry against the code.
 *
 * @param {object} entry the registry entry for this plugin
 * @param {object} opts
 * @param {string[]} opts.catalogue every tool the code defines
 * @param {string} [opts.preset] the preset the host saw (default: basic)
 * @returns {{registered: string[], missing: string[], unknown: string[], wider: string[], expected: string[]}}
 */
export function compareEntry(entry, opts = {}) {
  const catalogue = opts.catalogue || []
  const expected = presetTools(opts.preset || DEFAULT_PRESET, catalogue)
  const registered = ((entry && entry.tools) || []).map((t) => t.raw)
  const missing = expected.filter((name) => !registered.includes(name))
  const unknown = registered.filter((name) => !catalogue.includes(name))
  const wider = registered.filter((name) => catalogue.includes(name) && !expected.includes(name))
  return { registered, missing, unknown, wider, expected }
}
