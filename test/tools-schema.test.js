// test/tools-schema.test.js
// The MCP contract snapshot.
//
// The host already knows these tools by name and by schema. If a refactor
// renames a tool, reorders the list, drops a field or edits a description,
// the host silently starts sending different calls — or the prompt cache
// misses on every turn.
//
// So the contract is pinned here: names, order, and the shape of every
// schema. Descriptions are checked for LENGTH (they are prose, and prose
// gets trimmed on purpose) but their wording is not pinned.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createTools, TOOL_ORDER } from '../lib/mcp/tools/index.js'
import { presetTools } from '../lib/firefox/provider/workflow.js'

const fakeProvider = new Proxy(
  {},
  {
    get: () => () => ({ ok: true }),
  },
)

const tools = createTools({ provider: fakeProvider })

/** The names, in the order the host receives them. */
const EXPECTED_ORDER = [
  'browser_start',
  'browser_stop',
  'browser_status',
  'browser_tabs',
  'browser_new_tab',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_select_option',
  'browser_check',
  'browser_hover',
  'browser_scroll',
  'browser_upload',
  'browser_wait_for',
  'browser_network',
  'browser_close_tab',
  'browser_handoff',
  'browser_text',
  'browser_evaluate',
  'browser_screenshot',
  'browser_logs',
  'browser_handle_dialog',
  'browser_context',
  'browser_extension',
  'browser_cookie',
  'browser_intercept',
  'browser_detectability',
  'browser_captcha',
  'browser_captcha_status',
  'browser_batch',
  'browser_run_script',
  'browser_config',
  // New tools are APPENDED so the existing prefix stays byte-identical and
  // the host's prompt cache keeps hitting.
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_set_viewport',
]

describe('tool catalogue', () => {
  test('every tool is present', () => {
    assert.deepEqual(
      tools.map((t) => t.name),
      EXPECTED_ORDER,
    )
  })

  test('the exported order matches the built list', () => {
    assert.deepEqual(TOOL_ORDER, EXPECTED_ORDER)
  })

  test('the order is stable across builds', () => {
    // The host injects schemas in list order and that order is part of the
    // prompt cache — a reordering would silently cost cache on every turn.
    const again = createTools({ provider: fakeProvider }).map((t) => t.name)
    assert.deepEqual(again, EXPECTED_ORDER)
  })

  test('every tool has the four fields the host needs', () => {
    for (const tool of tools) {
      assert.equal(typeof tool.name, 'string', `${tool.name}: name`)
      assert.equal(typeof tool.description, 'string', `${tool.name}: description`)
      assert.equal(typeof tool.inputSchema, 'object', `${tool.name}: inputSchema`)
      assert.equal(typeof tool.outputSchema, 'object', `${tool.name}: outputSchema`)
      assert.equal(typeof tool.run, 'function', `${tool.name}: run`)
    }
  })

  test('every input schema is a closed object', () => {
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name}: inputSchema.type`)
      assert.equal(
        tool.inputSchema.additionalProperties,
        false,
        `${tool.name}: inputSchema must reject unknown properties`,
      )
    }
  })

  test('every output schema requires `ok` and allows the error fields', () => {
    for (const tool of tools) {
      assert.deepEqual(tool.outputSchema.required, ['ok'], `${tool.name}: required`)
      assert.ok(tool.outputSchema.properties.ok, `${tool.name}: ok property`)
      assert.ok(tool.outputSchema.properties.code, `${tool.name}: code property`)
      assert.equal(tool.outputSchema.additionalProperties, true, `${tool.name}: extra fields`)
    }
  })

  test('descriptions stay within the injection budget', () => {
    // The budget is the point of the test: every tool description is
    // injected into the model's context on every turn, so the total has to
    // stay bounded. The number is lowered as the descriptions are trimmed.
    //
    // The long-form explanation of each tool lives in
    // skills/firefox-browser/SKILL.md, which is read on demand and therefore
    // costs nothing per turn.
    const TOOL_DESCRIPTION_BUDGET = 130
    for (const tool of tools) {
      assert.ok(
        tool.description.length <= TOOL_DESCRIPTION_BUDGET,
        `${tool.name}: description is ${tool.description.length} chars — over the ${TOOL_DESCRIPTION_BUDGET} budget`,
      )
      assert.ok(tool.description.length > 10, `${tool.name}: description is too short to be useful`)
    }
  })

  test('property descriptions stay within budget', () => {
    const PROPERTY_DESCRIPTION_BUDGET = 70
    for (const tool of tools) {
      const props = tool.inputSchema.properties || {}
      for (const [key, spec] of Object.entries(props)) {
        if (!spec.description) continue
        assert.ok(
          spec.description.length <= PROPERTY_DESCRIPTION_BUDGET,
          `${tool.name}.${key}: description is ${spec.description.length} chars — over the ${PROPERTY_DESCRIPTION_BUDGET} budget`,
        )
      }
    }
  })

  test('the injected tool payload stays within budget', () => {
    // This is the number that actually matters: the bytes the host puts into
    // the model's context for the tool catalogue, on EVERY turn.
    //
    // It is measured on exactly the shape server.js sends for `tools/list`
    // — name, description, inputSchema, outputSchema, annotations — so the
    // budget cannot drift away from the real payload.
    //
    // History: 44128 bytes before the v2.3.0 trim (38 tools), 37925 bytes
    // at v2.2.0 (34 tools). The floor for 38 tools with this parameter
    // surface is ~30000, so this budget is deliberately set just above the
    // trimmed size rather than at a round number that would invite another
    // round of prose.
    //
    // The 2.4.0 security work added five parameters (two reveal flags and
    // three `confirm` flags on the newly gated actions), which cost 215
    // bytes. The shared CONFIRM_SCHEMA description was shortened to pay for
    // most of it — it is multiplied by every tool carrying the flag.
    const TOOL_PAYLOAD_BUDGET = 34000
    const payload = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      annotations: t.annotations,
    }))
    const bytes = Buffer.byteLength(JSON.stringify(payload))
    assert.ok(
      bytes <= TOOL_PAYLOAD_BUDGET,
      `the tool payload is ${bytes} bytes — over the ${TOOL_PAYLOAD_BUDGET} budget`,
    )
  })

  test('the trimmed presets stay within their own budgets', () => {
    // The full-catalogue budget above guards the TOTAL. These guard the
    // lists the agent actually carries, because the trimming is the whole
    // point: a preset that grew back to the full catalogue would be a
    // silent regression of the thing this feature exists to deliver.
    //
    // Measured at the time of writing: slim 18774 bytes, basic 27621.
    const BUDGETS = { slim: 20000, basic: 29000 }
    for (const [preset, budget] of Object.entries(BUDGETS)) {
      const names = new Set(presetTools(preset))
      const subset = tools.filter((t) => names.has(t.name))
      const bytes = Buffer.byteLength(
        JSON.stringify(
          subset.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            outputSchema: t.outputSchema,
            annotations: t.annotations,
          })),
        ),
      )
      assert.ok(
        bytes < budget,
        `the ${preset} preset is ${bytes} bytes — over the ${budget} budget`,
      )
    }
  })

  test('the confirm gate is documented where it applies', () => {
    const withConfirm = tools.filter((t) =>
      Object.keys(t.inputSchema.properties || {}).includes('confirm'),
    )
    assert.ok(withConfirm.length > 0, 'some tools must accept confirm')
    for (const tool of withConfirm) {
      const spec = tool.inputSchema.properties.confirm
      assert.equal(spec.type, 'boolean', `${tool.name}.confirm type`)
      assert.ok(spec.description, `${tool.name}.confirm needs a description`)
    }
  })

  test('no tool name is duplicated', () => {
    const names = tools.map((t) => t.name)
    assert.equal(new Set(names).size, names.length)
  })

  test('every tool name is prefixed the way the host expects', () => {
    for (const tool of tools) {
      assert.match(tool.name, /^browser_[a-z_]+$/, `${tool.name}: unexpected shape`)
    }
  })
})
