// test/tool-capabilities.test.js
// The capability each tool declares, and the preset computed from it.
//
// The preset used to be a hand-written list of tool NAMES. That list
// drifted once already and silently dropped six tools from the "all"
// preset, so an agent that asked for everything got a subset and never
// found out.
//
// The membership is now COMPUTED from the capability each tool declares,
// so there is no second copy of the catalogue to drift. But the two places
// that must agree — the declaration next to the tool, and the table that
// maps capabilities to tools — can still disagree, and these tests are
// what says so loudly when they do.
//
// They also guard the properties the old list had to be checked for by
// hand: browser_config is always reachable, the relative order never
// changes, and no preset invents a tool.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createTools, TOOL_ORDER } from '../lib/mcp/tools/index.js'
import { presetTools } from '../lib/firefox/provider/workflow.js'
import {
  CAPABILITY_TOOLS,
  PRESET_CAPABILITIES,
  capabilityOf,
} from '../lib/firefox/tool-capabilities.js'

const fakeProvider = new Proxy(
  {},
  {
    get: () => () => ({ ok: true }),
  },
)

const tools = createTools({ provider: fakeProvider })

describe('tool capabilities', () => {
  test('every tool declares a capability', () => {
    for (const tool of tools) {
      assert.equal(
        typeof tool.capability,
        'string',
        `${tool.name} must declare the capability it belongs to`,
      )
    }
  })

  test('the declaration and the table agree', () => {
    // The two places that must know the same thing. When they disagree,
    // one of them is wrong — and the preset is computed from the TABLE,
    // so the tool's own declaration would be a lie.
    for (const tool of tools) {
      assert.equal(
        tool.capability,
        capabilityOf(tool.name),
        `${tool.name} declares "${tool.capability}" but the table says "${capabilityOf(tool.name)}"`,
      )
    }
  })

  test('the table covers every tool, and no tool twice', () => {
    const listed = Object.values(CAPABILITY_TOOLS).flat()
    assert.equal(
      new Set(listed).size,
      listed.length,
      'a tool must not appear under two capabilities',
    )
    assert.deepEqual(
      [...listed].sort(),
      [...TOOL_ORDER].sort(),
      'the capability table must cover exactly the catalogue',
    )
  })

  test('every capability is reachable from some preset', () => {
    const reachable = new Set(Object.values(PRESET_CAPABILITIES).flat())
    for (const capability of Object.keys(CAPABILITY_TOOLS)) {
      assert.ok(reachable.has(capability), `the "${capability}" capability is in no preset`)
    }
  })

  test('the capability never reaches the wire', () => {
    // The catalogue is injected into the context on every turn. The
    // capability is a build-time concern and must not cost a byte there.
    const payload = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      annotations: t.annotations,
    }))
    assert.ok(
      !JSON.stringify(payload).includes('capability'),
      'the capability must not appear in the injected payload',
    )
  })
})

describe('the presets computed from capabilities', () => {
  test('browser_config is always reachable', () => {
    for (const preset of ['slim', 'basic', 'developer', 'all']) {
      assert.ok(
        presetTools(preset, TOOL_ORDER).includes('browser_config'),
        `browser_config must survive the ${preset} preset`,
      )
    }
  })

  test('the all preset is exactly the tool order', () => {
    assert.deepEqual(presetTools('all', TOOL_ORDER), TOOL_ORDER)
  })

  test('no preset invents a tool that does not exist', () => {
    const known = new Set(TOOL_ORDER)
    for (const preset of ['slim', 'basic', 'developer', 'all']) {
      for (const name of presetTools(preset, TOOL_ORDER)) {
        assert.ok(known.has(name), `the ${preset} preset lists an unknown tool: ${name}`)
      }
    }
  })

  test('the relative order of the retained tools never changes', () => {
    // The host injects the catalogue as a prompt-cache prefix, so a
    // reordering would invalidate the cache for everything after the
    // first move.
    for (const preset of ['slim', 'basic', 'developer']) {
      const list = presetTools(preset, TOOL_ORDER)
      const positions = list.map((n) => TOOL_ORDER.indexOf(n))
      for (let i = 1; i < positions.length; i++) {
        assert.ok(positions[i] > positions[i - 1], `the ${preset} preset reordered the catalogue`)
      }
    }
  })

  test('the presets are nested', () => {
    // A wider preset must contain everything a narrower one has. If it
    // did not, switching presets could REMOVE a tool the agent was
    // already using.
    const slim = new Set(presetTools('slim', TOOL_ORDER))
    const basic = new Set(presetTools('basic', TOOL_ORDER))
    const developer = new Set(presetTools('developer', TOOL_ORDER))
    for (const name of slim) assert.ok(basic.has(name), `${name} is missing from basic`)
    for (const name of basic) {
      assert.ok(developer.has(name), `${name} is missing from developer`)
    }
  })

  test('the presets grow', () => {
    const slim = presetTools('slim', TOOL_ORDER).length
    const basic = presetTools('basic', TOOL_ORDER).length
    const all = presetTools('all', TOOL_ORDER).length
    assert.ok(slim < basic, 'slim must be smaller than basic')
    assert.ok(basic <= all, 'basic must not be larger than all')
  })

  test('an unknown preset falls back to the narrow one', () => {
    // Falling back to EVERYTHING would be a surprise: the agent asked for
    // a preset that does not exist and got the whole catalogue.
    assert.deepEqual(presetTools('nonsense', TOOL_ORDER), presetTools('slim', TOOL_ORDER))
  })
})
