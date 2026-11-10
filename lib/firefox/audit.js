// lib/firefox/audit.js
// The action audit trail.
//
// WHY THIS EXISTS
//
// This browser carries the user's real login state. It can read their mail,
// their bank, their internal tools. The plugin's in-memory log buffer is
// not a record: it is a diagnostic aid, it is bounded to 500 entries, and
// it dies with the process.
//
// So: what did the agent actually DO? There was no answer on disk.
//
// WHAT IS RECORDED
//
// One line per tool call, as JSONL, in a per-day file. Each line says what
// was called, what it targeted, whether it was confirmed, and whether it
// was blocked.
//
// WHAT IS NEVER RECORDED
//
// The things that would make the audit log a second copy of the secrets it
// is meant to protect against:
//
//   - the TEXT an agent typed (it can be a password, a one-time code, a
//     private message)
//   - cookie values
//   - any value the redaction layer judged to be a secret
//   - the query string of a URL (where tokens live)
//
// The target's accessible NAME is recorded, because "clicked the button
// labelled 确认支付" is exactly the fact an audit needs — and a button
// label is not a secret. It goes through the redaction layer anyway, so a
// button that happens to be labelled with a token is still covered.
//
// WHERE IT LIVES
//
// Under the plugin's own data directory, in an `audit/` subdirectory. Not in
// the plugin package (which is scanned and may be reinstalled), and not in
// the user's home by accident.
//
// The audit trail is itself sensitive — it says which pages and controls
// the agent touched. `FIREFOX_BROWSER_AUDIT=0` turns it off.

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeUrl } from './network.js'
import { redactText } from './redact.js'

/** The name of the audit subdirectory under the plugin data directory. */
export const AUDIT_DIR_NAME = 'audit'

/**
 * Is the audit trail enabled?
 *
 * @param {object} [env]
 * @returns {boolean}
 */
export function auditEnabled(env = process.env) {
  return String(env.FIREFOX_BROWSER_AUDIT ?? '1').trim() !== '0'
}

/**
 * The directory the audit files live in.
 *
 * @param {string} baseDir  the plugin data directory
 * @returns {string}
 */
export function auditDir(baseDir) {
  return join(baseDir, AUDIT_DIR_NAME)
}

/**
 * The file today's entries go into.
 *
 * @param {string} baseDir
 * @param {Date} [now]
 * @returns {string}
 */
export function auditFile(baseDir, now = new Date()) {
  const day = now.toISOString().slice(0, 10)
  return join(auditDir(baseDir), `${day}.jsonl`)
}

/**
 * Build the audit record for a tool call.
 *
 * The shape is deliberately flat and small: it has to be readable by a
 * human with `cat`, and cheap enough to write on every call.
 *
 * @param {object} entry
 * @param {string} entry.tool       the MCP tool name
 * @param {object} [entry.result]   the provider's result
 * @param {number} [entry.ts]
 * @returns {object}
 */
export function buildAuditEntry(entry) {
  const result = entry.result || {}
  const out = {
    ts: entry.ts || Date.now(),
    tool: entry.tool || 'unknown',
    outcome: result.ok === false ? 'failed' : 'ok',
  }

  // A blocked action is the most interesting line in the file.
  if (result.blocked) out.blocked = true
  if (result.requiresConfirm) out.requiresConfirm = true
  if (result.confirmed === true) out.confirmed = true
  if (result.code) out.code = result.code

  // The URL, with its query stripped — the same rule the network log uses.
  if (result.url) {
    try {
      out.url = sanitizeUrl(String(result.url))
    } catch {
      out.url = ''
    }
  }

  // The element the action targeted. The NAME is what makes the line
  // useful ("确认支付"), and it goes through the redaction layer so a
  // label that carries a token is still covered.
  if (result.ref || result.name || result.role) {
    const target = {}
    if (result.ref) target.ref = String(result.ref)
    if (result.role) target.role = String(result.role)
    if (result.name) target.name = redactText(String(result.name)).slice(0, 120)
    out.target = target
  }

  // Egress: where a proxied connection went. The host and the port are
  // facts about the traffic; the request and the response are not recorded
  // at all, so this cannot become a second copy of the page content.
  if (result.egress && typeof result.egress === 'object') {
    out.egress = {
      host: String(result.egress.host || ''),
      port: Number(result.egress.port) || 0,
      kind: String(result.egress.kind || ''),
    }
    if (result.egress.bytes !== undefined) {
      out.egress.bytes = Number(result.egress.bytes) || 0
    }
  }

  return out
}

/**
 * Append an entry to today's audit file.
 *
 * A failure to write is NEVER fatal: an audit that breaks the browser is
 * worse than no audit. The error is returned so `browser_status` can say
 * that the audit is unavailable.
 *
 * @param {string} baseDir
 * @param {object} entry
 * @param {object} [env]
 * @returns {{ok: boolean, path?: string, error?: string}}
 */
export function appendAudit(baseDir, entry, env = process.env) {
  if (!auditEnabled(env)) {
    return { ok: false, error: 'audit disabled' }
  }
  try {
    const dir = auditDir(baseDir)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = auditFile(baseDir)
    appendFileSync(path, JSON.stringify(buildAuditEntry(entry)) + '\n', { mode: 0o600 })
    return { ok: true, path }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * A small in-session counter, so `browser_status` can report activity
 * without reading the file back.
 */
export class AuditCounter {
  constructor() {
    this.count = 0
    this.blocked = 0
    this.last = null
    this.path = null
    this.error = null
  }

  /**
   * Record one tool call.
   *
   * @param {string} baseDir
   * @param {object} entry
   * @param {object} [env]
   */
  record(baseDir, entry, env = process.env) {
    if (!auditEnabled(env)) return
    const built = buildAuditEntry(entry)
    this.count += 1
    if (built.blocked) this.blocked += 1
    this.last = built
    const res = appendAudit(baseDir, entry, env)
    if (res.ok) this.path = res.path
    else this.error = res.error
  }

  /**
   * The status summary.
   *
   * @returns {object}
   */
  summary() {
    return {
      enabled: true,
      calls: this.count,
      blocked: this.blocked,
      path: this.path,
      last: this.last,
      error: this.error,
    }
  }
}
