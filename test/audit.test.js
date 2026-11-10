// test/audit.test.js
// Unit tests for the action audit trail.
//
// The audit is a record of what the agent did with a browser that carries
// the user's real credentials. Two properties matter equally: the record
// must be USEFUL (it says what happened), and it must not become a second
// copy of the secrets it exists to protect.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendAudit,
  buildAuditEntry,
  auditEnabled,
  auditFile,
  auditDir,
  AuditCounter,
} from '../lib/firefox/audit.js'

/** A scratch directory for the file-backed tests. */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'ffb-audit-'))
}

describe('audit entries', () => {
  test('an entry records the tool and the outcome', () => {
    const entry = buildAuditEntry({ tool: 'browser_click', result: { ok: true } })
    assert.equal(entry.tool, 'browser_click')
    assert.equal(entry.outcome, 'ok')
    assert.equal(typeof entry.ts, 'number')
  })

  test('a failure is recorded as a failure', () => {
    const entry = buildAuditEntry({
      tool: 'browser_click',
      result: { ok: false, code: 'element_not_found' },
    })
    assert.equal(entry.outcome, 'failed')
    assert.equal(entry.code, 'element_not_found')
  })

  test('a blocked action is recorded as blocked', () => {
    const entry = buildAuditEntry({
      tool: 'browser_click',
      result: { ok: false, blocked: true, requiresConfirm: true, action: 'form_submit' },
    })
    assert.equal(entry.blocked, true)
    assert.equal(entry.requiresConfirm, true)
  })

  test('the URL is recorded without its query string', () => {
    // The query string is where tokens live.
    const entry = buildAuditEntry({
      tool: 'browser_navigate',
      result: { ok: true, url: 'https://example.com/page?token=secret123' },
    })
    assert.equal(entry.url, 'https://example.com/page')
    assert.ok(!JSON.stringify(entry).includes('secret123'))
  })

  test('the target name is recorded', () => {
    const entry = buildAuditEntry({
      tool: 'browser_click',
      result: { ok: true, ref: 'e12', role: 'button', name: '确认支付' },
    })
    assert.equal(entry.target.ref, 'e12')
    assert.equal(entry.target.role, 'button')
    assert.equal(entry.target.name, '确认支付')
  })

  test('a secret in the target name is redacted', () => {
    const entry = buildAuditEntry({
      tool: 'browser_click',
      result: { ok: true, role: 'button', name: 'login token=abc123def' },
    })
    assert.ok(!JSON.stringify(entry).includes('abc123def'))
  })

  test('the typed text is NEVER recorded', () => {
    // The result of browser_type carries `typed` — a LENGTH, not the text.
    // If a future change started putting the text in the result, the audit
    // must not pick it up.
    const entry = buildAuditEntry({
      tool: 'browser_type',
      result: { ok: true, typed: 12, text: 'my secret password' },
    })
    assert.ok(!JSON.stringify(entry).includes('my secret password'))
  })

  test('a cookie value is never recorded', () => {
    const entry = buildAuditEntry({
      tool: 'browser_cookie',
      result: { ok: true, cookies: [{ name: 'sid', value: 'abcdef0123456789' }] },
    })
    assert.ok(!JSON.stringify(entry).includes('abcdef0123456789'))
  })
})

describe('the audit file', () => {
  test('an entry is appended as one JSON line', () => {
    const dir = scratch()
    try {
      const res = appendAudit(dir, { tool: 'browser_click', result: { ok: true } })
      assert.equal(res.ok, true)
      appendAudit(dir, { tool: 'browser_type', result: { ok: true } })
      const content = readFileSync(res.path, 'utf8')
      const lines = content.trim().split('\n')
      assert.equal(lines.length, 2)
      assert.equal(JSON.parse(lines[0]).tool, 'browser_click')
      assert.equal(JSON.parse(lines[1]).tool, 'browser_type')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the file is named after the day', () => {
    const dir = scratch()
    try {
      const path = auditFile(dir, new Date('2026-11-09T12:00:00Z'))
      assert.ok(path.endsWith('2026-11-09.jsonl'))
      assert.ok(path.startsWith(auditDir(dir)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the audit can be turned off', () => {
    const dir = scratch()
    try {
      const res = appendAudit(
        dir,
        { tool: 'browser_click', result: { ok: true } },
        { FIREFOX_BROWSER_AUDIT: '0' },
      )
      assert.equal(res.ok, false)
      assert.equal(existsSync(auditDir(dir)), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the audit is on by default', () => {
    assert.equal(auditEnabled({}), true)
    assert.equal(auditEnabled({ FIREFOX_BROWSER_AUDIT: '0' }), false)
  })
})

describe('the audit counter', () => {
  test('it counts the calls and the blocked ones', () => {
    const dir = scratch()
    try {
      const counter = new AuditCounter()
      counter.record(dir, { tool: 'browser_click', result: { ok: true } })
      counter.record(dir, {
        tool: 'browser_click',
        result: { ok: false, blocked: true, requiresConfirm: true },
      })
      const summary = counter.summary()
      assert.equal(summary.calls, 2)
      assert.equal(summary.blocked, 1)
      assert.equal(summary.last.tool, 'browser_click')
      assert.ok(summary.path)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a write failure does not throw', () => {
    // The audit must never break a tool call.
    //
    // The failure is provoked with a path whose parent is a FILE, so
    // mkdir fails with ENOTDIR. A read-only directory would need the test
    // to run as a non-root user, and /proc is not usable here because
    // mkdir beneath it does not fail promptly.
    const dir = scratch()
    try {
      const blocker = join(dir, 'not-a-directory')
      writeFileSync(blocker, 'x')
      const counter = new AuditCounter()
      assert.doesNotThrow(() => {
        counter.record(blocker, {
          tool: 'browser_click',
          result: { ok: true },
        })
      })
      assert.ok(counter.summary().error)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
