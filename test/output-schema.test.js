// test/output-schema.test.js
// Every tool's output schema must ACCEPT the payload that tool returns.
//
// WHY THIS TEST EXISTS
//
// The host validates a tool's structured output against the output schema
// the tool itself declared. A schema that rejects its own payload does not
// produce a wrong answer — it produces a PROTOCOL ERROR: the whole call
// comes back as `-32602`, and the agent never sees the result at all.
//
// That is not hypothetical. The schema helper used to declare every array
// property as a list of objects (`items: {type:'object'}`), while a number
// of tools return arrays of STRINGS — `browser_config`'s `effectiveTools`
// and `notes`, `browser_detectability`'s `notes`, `browser_captcha`'s
// `detected`, `browser_intercept`'s `patterns`, `browser_find`'s `texts`,
// `browser_snapshot`'s `texts`. Every one of those tools was rejected by
// the host before it could answer.
//
// So the rule this file enforces: an output schema describes a payload, it
// never rejects it.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createTools } from '../lib/mcp/tools/index.js'

const fakeProvider = new Proxy(
  {},
  {
    get: () => () => ({ ok: true }),
  },
)

const tools = createTools({ provider: fakeProvider })

/**
 * Validate a value against the subset of JSON Schema this plugin uses:
 * type, properties, required, items.
 *
 * @param {object} schema
 * @param {*} value
 * @param {string} [path]
 * @returns {string[]} the problems found
 */
function validate(schema, value, path = 'data') {
  const errors = []
  if (!schema || typeof schema !== 'object') return errors
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${path} must be an object`)
        break
      }
      for (const key of schema.required || []) {
        if (!(key in value)) errors.push(`${path}.${key} is required`)
      }
      for (const [key, sub] of Object.entries(schema.properties || {})) {
        if (key in value) errors.push(...validate(sub, value[key], `${path}.${key}`))
      }
      break
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path} must be an array`)
        break
      }
      if (schema.items) {
        value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)))
      }
      break
    }
    case 'string':
      if (typeof value !== 'string') errors.push(`${path} must be a string`)
      break
    case 'number':
      if (typeof value !== 'number') errors.push(`${path} must be a number`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path} must be a boolean`)
      break
    default:
      break
  }
  return errors
}

/**
 * A representative value for one property spec.
 *
 * @param {object} spec
 * @returns {*}
 */
function sampleFor(spec) {
  switch (spec.type) {
    case 'array':
      return spec.items && spec.items.type === 'string' ? ['x'] : [{}]
    case 'object':
      return {}
    case 'number':
      return 1
    case 'boolean':
      return true
    default:
      return 'x'
  }
}

/**
 * A representative payload for a whole tool: every declared property, with
 * a value of the declared type.
 *
 * @param {object} schema
 * @returns {object}
 */
function payloadFor(schema) {
  const payload = {}
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    payload[key] = sampleFor(spec)
  }
  return payload
}

/**
 * REAL payloads, copied from actual responses.
 *
 * These are the tools whose payload shape is not derivable from the schema
 * alone — the ones that broke the host. They are the ground truth: if a
 * schema is tightened in a way that rejects one of these, the tool is
 * broken again.
 */
const REAL_PAYLOADS = {
  browser_config: {
    ok: true,
    preset: 'basic',
    dialogPolicy: 'autoDismiss',
    maxSnapshotElements: 300,
    inlineSnapshot: true,
    timeoutMs: 30000,
    effectiveTools: ['browser_start', 'browser_stop', 'browser_status'],
    notes: ['The basic preset hides the diagnostic and automation tools.'],
    prefs: {},
    applied: ['network.trr.mode'],
    appliedNow: [],
    pendingRestart: [],
    failed: [],
  },
  browser_detectability: {
    ok: true,
    contextId: 'ctx-1',
    webdriver: true,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
    headlessUA: false,
    domRefAttributes: 0,
    registryKeys: 1,
    enumerableRegistryKeys: 0,
    plugins: 5,
    languages: 'en-US,en',
    automationDetectable: true,
    refMode: 'registry',
    notes: [
      'navigator.webdriver is true. Firefox sets it whenever the Remote Agent runs.',
      '1 registry key(s) exist on window. They are non-enumerable.',
    ],
  },
  browser_captcha: {
    ok: false,
    status: 'solve_failed',
    solver: 'turnstile',
    tokenLength: 0,
    detected: ['turnstile'],
    attempts: [{ solver: 'turnstile', status: 'not_detected', ok: false }],
    message: 'A challenge was found but could not be solved.',
    notes: [],
  },
  browser_intercept: {
    ok: true,
    interceptId: 'abc-123',
    active: 1,
    patterns: ['ads.example.com'],
  },
  browser_find: {
    ok: true,
    contextId: 'ctx-1',
    query: 'Example',
    elements: [{ ref: 'e0', role: 'link', name: 'Learn more' }],
    texts: ['Example Domain', 'More information...'],
    elementCount: 1,
    textCount: 2,
    total: 3,
    truncated: false,
  },
  browser_snapshot: {
    ok: true,
    contextId: 'ctx-1',
    snapshotId: 1,
    elements: [{ ref: 'e0', role: 'link', name: 'Learn more' }],
    count: 1,
    total: 1,
    truncated: false,
    hasMore: false,
    refMode: 'registry',
    frames: [],
    texts: ['Example Domain'],
  },
  browser_egress: {
    ok: true,
    running: true,
    port: 39181,
    connections: 0,
    refused: [{ host: 'evil.example.com', port: 443, reason: 'private address' }],
    prefs: { 'network.proxy.type': 1 },
    hint: 'The proxy is listening on 127.0.0.1:39181.',
  },
}

describe('output schemas accept their own payloads', () => {
  for (const tool of tools) {
    test(`${tool.name} accepts a representative payload`, () => {
      const schema = tool.outputSchema
      assert.ok(schema, `${tool.name} must declare an output schema`)
      const errors = validate(schema, payloadFor(schema))
      assert.deepEqual(errors, [], `${tool.name}: ${errors.join('; ')}`)
    })
  }

  for (const [name, payload] of Object.entries(REAL_PAYLOADS)) {
    test(`${name} accepts its real payload`, () => {
      const tool = tools.find((t) => t.name === name)
      assert.ok(tool, `${name} must exist`)
      const errors = validate(tool.outputSchema, payload)
      assert.deepEqual(errors, [], `${name}: ${errors.join('; ')}`)
    })
  }
})

describe('array output properties', () => {
  test('no output schema constrains an array to objects', () => {
    // The old default (`items: {type:'object'}` for every array) is what
    // rejected the string arrays and made those tools unusable. An array
    // whose elements are records does not need the constraint stated.
    const offenders = []
    for (const tool of tools) {
      for (const [key, spec] of Object.entries(tool.outputSchema?.properties || {})) {
        if (spec.type === 'array' && spec.items && spec.items.type === 'object') {
          offenders.push(`${tool.name}.${key}`)
        }
      }
    }
    assert.deepEqual(offenders, [])
  })

  test('a string array is declared as such', () => {
    // Every property above whose real payload is an array of strings.
    const expected = {
      browser_config: ['effectiveTools', 'notes', 'applied', 'appliedNow', 'pendingRestart'],
      browser_detectability: ['notes'],
      browser_captcha: ['detected', 'notes'],
      browser_intercept: ['patterns'],
      browser_find: ['texts'],
      browser_snapshot: ['texts'],
    }
    for (const [name, keys] of Object.entries(expected)) {
      const tool = tools.find((t) => t.name === name)
      assert.ok(tool, `${name} must exist`)
      for (const key of keys) {
        const spec = tool.outputSchema.properties[key]
        assert.ok(spec, `${name}.${key} must be declared`)
        assert.equal(spec.type, 'array', `${name}.${key} must be an array`)
        assert.equal(
          spec.items && spec.items.type,
          'string',
          `${name}.${key} carries strings, so it must declare items:{type:'string'}`,
        )
      }
    }
  })
})
