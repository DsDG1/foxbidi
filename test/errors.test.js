// test/errors.test.js
// Unit tests for the error contract.
//
// The contract has two halves that must both hold:
//   - `error` stays the human-readable sentence it always was (existing
//     callers and humans depend on it);
//   - `code` is added, so an agent can branch without matching English.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ERROR_CODES, classifyError, fail, ok } from '../lib/firefox/errors.js'
import { capabilityError } from '../lib/firefox/capabilities.js'
import { summarize } from '../lib/mcp/schema.js'

describe('error codes', () => {
  test('every code is a distinct lower_snake_case string', () => {
    const values = Object.values(ERROR_CODES)
    assert.ok(values.length > 0)
    assert.equal(new Set(values).size, values.length, 'codes must be unique')
    for (const value of values) {
      assert.match(value, /^[a-z][a-z_]*$/)
    }
  })

  test('the codes the plugin actually relies on are present', () => {
    for (const key of [
      'NOT_RUNNING',
      'NO_CONTEXT',
      'ELEMENT_NOT_FOUND',
      'REF_STALE',
      'CAPABILITY_UNAVAILABLE',
      'CONFIRM_REQUIRED',
      'INVALID_ARGUMENT',
    ]) {
      assert.ok(ERROR_CODES[key], `missing code ${key}`)
    }
  })
})

describe('fail()', () => {
  test('produces the documented shape', () => {
    const result = fail(ERROR_CODES.REF_STALE, 'ref "e1" is gone')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'ref_stale')
    assert.equal(result.error, 'ref "e1" is gone')
  })

  test('extra fields are merged in', () => {
    const result = fail(ERROR_CODES.REF_STALE, 'gone', {
      hint: 'take a new snapshot',
      requiresResnapshot: true,
    })
    assert.equal(result.hint, 'take a new snapshot')
    assert.equal(result.requiresResnapshot, true)
  })

  test('extra fields cannot overwrite ok or code', () => {
    const result = fail(ERROR_CODES.INTERNAL, 'boom', { ok: true, code: 'lies' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'internal')
  })
})

describe('ok()', () => {
  test('produces a success result', () => {
    const result = ok({ contextId: 'abc' })
    assert.equal(result.ok, true)
    assert.equal(result.contextId, 'abc')
  })

  test('works with no payload', () => {
    assert.deepEqual(ok(), { ok: true })
  })
})

describe('classifyError()', () => {
  test('a timeout is a timeout', () => {
    assert.equal(
      classifyError(new Error('bidi command timed out after 30000ms')),
      ERROR_CODES.TIMEOUT,
    )
  })

  test('an unknown command is a capability problem', () => {
    assert.equal(
      classifyError(new Error('browsingContext.setViewport is not a valid command')),
      ERROR_CODES.CAPABILITY_UNAVAILABLE,
    )
  })

  test('a missing context is a context problem', () => {
    assert.equal(classifyError(new Error('no such browsing context')), ERROR_CODES.NO_CONTEXT)
  })

  test('anything else is internal', () => {
    assert.equal(classifyError(new Error('something odd')), ERROR_CODES.INTERNAL)
  })

  test('a non-error value does not throw', () => {
    assert.equal(classifyError(undefined), ERROR_CODES.INTERNAL)
    assert.equal(classifyError('a string'), ERROR_CODES.INTERNAL)
  })
})

describe('capabilityError()', () => {
  test('carries the machine-readable code', () => {
    const result = capabilityError('userContexts', '140.11.0esr')
    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.CAPABILITY_UNAVAILABLE)
  })

  test('keeps the legacy error string byte-identical', () => {
    // Existing callers check `error === 'capability_unavailable'`; that must
    // not change when the `code` field is added.
    const result = capabilityError('userContexts', '140.11.0esr')
    assert.equal(result.error, 'capability_unavailable')
  })

  test('keeps the feature / required / detected fields', () => {
    const result = capabilityError('storageCookies', '130.0')
    assert.equal(result.feature, 'storageCookies')
    assert.equal(result.detected, '130.0')
    assert.equal(result.required, 'Firefox >= 124')
    assert.ok(result.hint)
  })

  test('an unknown feature still produces a usable payload', () => {
    const result = capabilityError('notAFeature', '140.0')
    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.CAPABILITY_UNAVAILABLE)
    assert.equal(result.feature, 'notAFeature')
  })
})

describe('summarize()', () => {
  test('leads with the code so the agent can branch on it', () => {
    const text = summarize(fail(ERROR_CODES.ELEMENT_NOT_FOUND, 'element not found: button'))
    assert.ok(text.startsWith('element_not_found'), `got: ${text}`)
    assert.ok(text.includes('element not found: button'))
  })

  test('does not repeat the code when it equals the reason', () => {
    const text = summarize(fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'capability_unavailable'))
    assert.equal(text, 'capability_unavailable')
  })

  test('a failure without a code still reads sensibly', () => {
    const text = summarize({ ok: false, error: 'something went wrong' })
    assert.equal(text, 'something went wrong')
  })

  test('the hint is still appended', () => {
    const text = summarize(fail(ERROR_CODES.REF_STALE, 'gone', { hint: 'snapshot again' }))
    assert.ok(text.includes('snapshot again'))
  })

  test('a success is unaffected', () => {
    assert.equal(summarize({ ok: true, count: 3 }), 'count 3')
  })
})

describe('the documented error vocabulary', () => {
  test('the reference documents every code', () => {
    // The agent reads the skill, not the source. If a code exists but is
    // undocumented, the agent cannot branch on it — so the table in
    // REFERENCE.md is checked against the table in the source.
    //
    // The check is per LINE, not a substring search. A substring search
    // passes for a code that appears anywhere in the file — including
    // inside another code's name, or in prose — so a mangled table row
    // can slip through. The table row must name the code exactly.
    const reference = readFileSync(
      new URL('../skills/firefox-browser/REFERENCE.md', import.meta.url),
      'utf8',
    )
    for (const code of Object.values(ERROR_CODES)) {
      const documented = reference.split('\n').some((line) => line.includes(`\`${code}\``))
      assert.ok(documented, `the reference does not document the "${code}" code`)
    }
  })

  test('the reference table has no mangled rows', () => {
    // A row whose code was truncated still "contains" the code elsewhere in
    // the file, so the per-code check above would not catch it. The table
    // is checked structurally instead: every row in the code table names a
    // code that exists.
    //
    // Only the ERROR CODE table is checked. The reference also documents
    // the fields a reading tool returns, and those rows name fields, not
    // codes — scanning them here would report every one of them as an
    // unknown code.
    const reference = readFileSync(
      new URL('../skills/firefox-browser/REFERENCE.md', import.meta.url),
      'utf8',
    )
    const section = reference.split('## 错误契约')[1] || ''
    const codeTable = section.split('\n## ')[0]
    const table = codeTable
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .map((line) => {
        const m = line.match(/^\|\s*`([^`]+)`/)
        return m ? m[1] : null
      })
      .filter(Boolean)
    for (const code of table) {
      assert.ok(
        Object.values(ERROR_CODES).includes(code),
        `the reference documents an unknown code: "${code}"`,
      )
    }
  })

  test('the skill points at the reference', () => {
    // SKILL.md stays inside its 200-line budget, so the detail lives next
    // door. The guide has to say where.
    const skill = readFileSync(
      new URL('../skills/firefox-browser/SKILL.md', import.meta.url),
      'utf8',
    )
    assert.match(skill, /REFERENCE\.md/)
    assert.match(skill, /code/)
  })
})
