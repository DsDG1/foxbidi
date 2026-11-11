import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_ORDER } from '../lib/mcp/tools/index.js'
import { presetTools } from '../lib/firefox/provider/workflow.js'
import {
  compareEntry,
  DEFAULT_PRESET,
  findPluginEntry,
  parseRegistryKey,
  registeredPluginNames,
} from '../tools/host-registry.mjs'

/**
 * The registry as the host writes it: one entry per plugin, keyed by
 * ["plugin", <scope>, <plugin name>, <server name>].
 */
function entry(pluginName, tools, serverName = 'firefox-browser') {
  return {
    key: JSON.stringify(['plugin', 'LOCAL_MINIMAX', pluginName, serverName]),
    raw: serverName,
    segment: serverName,
    tools: tools.map((raw) => ({ raw, segment: raw })),
  }
}

test('a registry key is parsed into its parts', () => {
  assert.deepEqual(parseRegistryKey('["plugin","LOCAL_MINIMAX","foxbidi","firefox-browser"]'), [
    'plugin',
    'LOCAL_MINIMAX',
    'foxbidi',
    'firefox-browser',
  ])
  assert.equal(parseRegistryKey('not json'), null)
  assert.equal(parseRegistryKey('{"a":1}'), null)
})

test('the entry is found by the plugin name, not by the raw server name', () => {
  // The shape this actually hits: a renamed plugin leaves the OLD entry
  // behind, and both entries carry the same raw server name. The first
  // `raw` match is the stale one — picking it reports a mismatch that does
  // not exist.
  const stale = entry('firefox-browser', ['browser_status'])
  const live = entry('foxbidi', ['browser_status', 'browser_navigate'])
  const servers = [stale, live]
  assert.equal(findPluginEntry(servers, 'foxbidi'), live)
  assert.equal(findPluginEntry(servers, 'firefox-browser'), stale)
  assert.equal(findPluginEntry(servers, 'not-installed'), null)
  assert.deepEqual(registeredPluginNames(servers).sort(), ['firefox-browser', 'foxbidi'])
})

test('a host that registered the default preset is in step', () => {
  const visible = presetTools(DEFAULT_PRESET, TOOL_ORDER)
  const cmp = compareEntry(entry('foxbidi', visible), { catalogue: TOOL_ORDER })
  assert.deepEqual(cmp.missing, [])
  assert.deepEqual(cmp.unknown, [])
  assert.deepEqual(cmp.wider, [])
  assert.equal(cmp.registered.length, visible.length)
})

test('a host running an older build shows the tools it is missing', () => {
  const visible = presetTools(DEFAULT_PRESET, TOOL_ORDER)
  const older = visible.filter((name) => name !== 'browser_wait_for')
  const cmp = compareEntry(entry('foxbidi', older), { catalogue: TOOL_ORDER })
  assert.deepEqual(cmp.missing, ['browser_wait_for'])
  assert.deepEqual(cmp.unknown, [])
})

test('a host that knows a tool the code dropped reports it as unknown', () => {
  const cmp = compareEntry(entry('foxbidi', ['browser_status', 'browser_gone']), {
    catalogue: TOOL_ORDER,
  })
  assert.deepEqual(cmp.unknown, ['browser_gone'])
})

test('a host on a wider preset is not a mismatch', () => {
  const cmp = compareEntry(entry('foxbidi', TOOL_ORDER), { catalogue: TOOL_ORDER })
  assert.deepEqual(cmp.missing, [])
  assert.deepEqual(cmp.unknown, [])
  // The tools beyond the default preset are reported, not flagged.
  assert.ok(cmp.wider.includes('browser_egress'))
  assert.equal(cmp.wider.length, TOOL_ORDER.length - cmp.expected.length)
})
