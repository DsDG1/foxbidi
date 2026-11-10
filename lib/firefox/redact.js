// lib/firefox/redact.js
// The redaction layer.
//
// WHY THIS MODULE EXISTS
//
// The plugin already redacts network URLs — the query string and the
// fragment are stripped before a request URL leaves the plugin, because
// "query strings routinely carry tokens" (see ./network.js). That policy was
// correct, but it was applied to ONE channel. Every other channel that
// carries raw page content into the model's context went unfiltered:
//
//   - cookie values, including HttpOnly session cookies
//   - the page's own console output (pages log tokens as a matter of course)
//   - the value of an input field in a snapshot (a one-time code in a
//     `type=text` box is a code, not a password, and used to be exposed)
//   - a response body read through `network.getData`
//
// So the plugin was inconsistent with itself: it scrubbed a URL's query
// string while handing over the session cookie that the same request would
// have carried.
//
// This module is the single place where "raw content leaves the plugin" is
// decided. New channels plug in here rather than growing their own rules.
//
// THE TWO KINDS OF REDACTION
//
//   1. STRUCTURED — a value that is KNOWN to be a secret because of what it
//      is (a password field, an OTP field, a session cookie). These are
//      replaced by a placeholder that still says "there was a value here".
//
//   2. SHAPED — a value inside free text that LOOKS like a secret (a JWT, a
//      `token=...` pair, a `Bearer` header). These are replaced in place,
//      leaving the rest of the text readable.
//
// The difference matters: structured redaction is a decision, and it is
// reversible through an explicit, visible escape hatch (`revealValues`).
// Shaped redaction is a heuristic, and it is not reversible — because the
// plugin cannot know whether the shape it found was a secret or a UUID.
//
// WHAT IS DELIBERATELY NOT DONE
//
// There is no generic "high entropy" detection. A base64 image data URL and
// a session token have the same statistical shape, and a plugin that
// redacted both would be useless on half the web. Only unambiguous shapes
// are replaced.
//
// WHAT IS NEVER RECORDED
//
// Redaction happens on the way OUT, so the raw value still exists in the
// browser and in the plugin's own memory. It simply never reaches the
// model's context, the conversation log, or any downstream transcript.

/**
 * The placeholder that replaces a redacted value.
 *
 * It keeps the LENGTH, because "there is a 32-character value here" is
 * actionable ("this is a session token") while the value itself is not.
 */
export const REDACTED_PLACEHOLDER = '<redacted>'

/**
 * Field names that mark a value as a credential.
 *
 * This is deliberately BROADER than the pattern in ./confirm.js. The gate
 * there decides whether an action is irreversible, so a false positive
 * there costs one extra `confirm: true`; a false positive HERE costs a
 * hidden field value, which is a much smaller price than leaking a code.
 *
 * The Chinese terms matter as much as the English ones — a verification
 * code on a Chinese site is called 验证码, and a password is 密码.
 */
const SENSITIVE_NAME_PATTERN =
  /(pass(word|wd|phrase)?|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|auth[-_]?token|bearer|session[-_]?id|sessionid|csrf|xsrf|otp|one[-_]?time|2fa|mfa|two[-_]?factor|verification[-_]?code|verify[-_]?code|security[-_]?code|cvv|cvc|cvv2|pin[-_]?code|bank[-_]?code|iban|swift|routing[-_]?number|account[-_]?number|card[-_]?number|cc[-_]?num|card[-_]?code|social[-_]?security|身份证|银行卡|信用卡|密码|口令|验证码|动态码|短信码|支付密码|私钥|令牌|密钥)/i

/**
 * `autocomplete` values that mark a field as holding a secret.
 *
 * This is the browser's OWN declaration of what the field is for, which
 * makes it the most reliable signal available — far better than guessing
 * from a placeholder string.
 */
const SENSITIVE_AUTOCOMPLETE = new Set([
  'one-time-code',
  'current-password',
  'new-password',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-type',
  'impp',
])

/**
 * `input type` values whose content is always a secret.
 */
const SENSITIVE_INPUT_TYPES = new Set(['password'])

/**
 * Does this field hold a credential?
 *
 * The decision is made from FACTS about the element — its type, its
 * `autocomplete` attribute, and the names it carries — never from the
 * content of the value itself. A field named "password" is treated as a
 * password even when it is currently empty, because it will not stay empty.
 *
 * @param {object} [info]
 * @param {string} [info.name]       name / id / placeholder / aria-label
 * @param {string} [info.type]       the input type attribute
 * @param {string} [info.autocomplete]
 * @param {string} [info.role]        the snapshot role
 * @returns {boolean}
 */
export function isSensitiveFieldName(info) {
  if (!info || typeof info !== 'object') return false

  const type = String(info.type || '').toLowerCase()
  if (SENSITIVE_INPUT_TYPES.has(type)) return true

  const autocomplete = String(info.autocomplete || '').toLowerCase()
  if (SENSITIVE_AUTOCOMPLETE.has(autocomplete)) return true

  const role = String(info.role || '').toLowerCase()
  if (role === 'password') return true

  // EVERY name the element carries is consulted — not just `name`. A page
  // labels a field "密码" in the placeholder and gives the element no name
  // at all, so looking at `name` alone would miss it. This mirrors the
  // page-side guard, which reads the same set.
  const names = [info.name, info.id, info.placeholder, info.ariaLabel, info.title, info.label]
  for (const candidate of names) {
    const text = String(candidate || '')
    if (!text) continue
    if (SENSITIVE_NAME_PATTERN.test(text)) return true
  }
  return false
}

/**
 * Redact a single value.
 *
 * A sensitive value is replaced by a placeholder that keeps the length. A
 * value that is not known to be sensitive is returned untouched.
 *
 * @param {string} value
 * @param {object} [info]  the field facts, as returned by isSensitiveFieldName
 * @returns {{value: string, redacted: boolean, length: number}}
 */
export function redactValue(value, info) {
  const text = value === null || value === undefined ? '' : String(value)
  if (!text) return { value: '', redacted: false, length: 0 }
  if (!isSensitiveFieldName(info)) {
    return { value: text, redacted: false, length: text.length }
  }
  return {
    value: `${REDACTED_PLACEHOLDER}:len=${text.length}`,
    redacted: true,
    length: text.length,
  }
}

/**
 * The shapes that are unambiguous enough to redact inside free text.
 *
 * Each entry is [pattern, replacement]. The patterns are deliberately
 * anchored to a KEY NAME (`token=`, `password:`) or a known token FORMAT,
 * so that ordinary prose and ordinary base64 blobs are left alone.
 */
const TEXT_RULES = [
  // An Authorization header value. This comes FIRST because the generic
  // key=value rule below would otherwise match "authorization: Bearer" and
  // redact the word "Bearer" — leaving the actual token behind.
  [/\b(Bearer|Basic)\s+([A-Za-z0-9+/=._~-]{8,})/g, '$1 <redacted>'],
  // key=value / key: value / key":"value" — the key names a secret.
  // The negative lookahead keeps the rule away from "Bearer" and "Basic",
  // which are handled above.
  [
    /\b(token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|pwd|api[_-]?key|apikey|secret[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer[_-]?token|session[_-]?id|sessionid|csrf[_-]?token|xsrf[_-]?token|otp|verification[_-]?code|cvv2|cvc|card[_-]?number|authorization)\b(\s*["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic)\b)([^\s"',;}&]{4,})/gi,
    '$1$2<redacted>',
  ],
  // A JSON Web Token: three base64url segments.
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '<redacted>'],
  // Well-known credential prefixes.
  [/\bAKIA[0-9A-Z]{16}\b/g, '<redacted>'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '<redacted>'],
  [/\bgh[pousr]_[0-9A-Za-z]{20,}\b/g, '<redacted>'],
  [/\bsk-[0-9A-Za-z_-]{16,}\b/g, '<redacted>'],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, '<redacted>'],
]

/**
 * Redact the secret-looking parts of a free-text blob.
 *
 * This is used for console output, response bodies, and the plugin's own
 * log lines. It replaces the SECRET, not the whole line, so the message
 * around it stays readable — which is the whole point of reading a log.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactText(text) {
  if (text === null || text === undefined) return ''
  let out = String(text)
  for (const [pattern, replacement] of TEXT_RULES) {
    out = out.replace(pattern, replacement)
  }
  return out
}

/**
 * Redact a cookie record.
 *
 * The cookie's IDENTITY is what an agent needs — its name, domain, path,
 * lifetime, and flags. Its VALUE is the credential. So the value is
 * replaced and everything else is kept.
 *
 * @param {object} cookie
 * @returns {object}
 */
export function redactCookie(cookie) {
  if (!cookie || typeof cookie !== 'object') return cookie
  const out = { ...cookie }
  if (out.value !== undefined && out.value !== null && out.value !== '') {
    const text = String(out.value)
    out.value = `${REDACTED_PLACEHOLDER}:len=${text.length}`
    out.valueRedacted = true
  }
  return out
}

/**
 * Redact a list of cookies.
 *
 * @param {Array<object>} cookies
 * @returns {Array<object>}
 */
export function redactCookies(cookies) {
  if (!Array.isArray(cookies)) return []
  return cookies.map((c) => redactCookie(c))
}

/**
 * The page-side field guard.
 *
 * A snapshot script is injected into the page, so it cannot import this
 * module. This string carries the SAME decision into the page — one source
 * of truth, two delivery mechanisms.
 *
 * It defines `isSensitiveField(el)`, which returns true when the element
 * holds a credential by DECLARING that it does (its type, its
 * `autocomplete` attribute, or the names it carries). It never looks at the
 * value's content.
 *
 * `String.raw` keeps the regex escapes intact: the browser receives
 * `\s` and `\d`, not the letters that a normal template literal would
 * produce.
 */
export const PAGE_FIELD_GUARD = String.raw`
  const FFB_SENSITIVE_AUTOCOMPLETE = new Set([
    'one-time-code', 'current-password', 'new-password',
    'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
    'cc-type', 'impp',
  ]);
  const FFB_SENSITIVE_NAME_RE = /(pass(word|wd|phrase)?|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|auth[-_]?token|bearer|session[-_]?id|sessionid|csrf|xsrf|otp|one[-_]?time|2fa|mfa|two[-_]?factor|verification[-_]?code|verify[-_]?code|security[-_]?code|cvv|cvc|cvv2|pin[-_]?code|bank[-_]?code|iban|swift|routing[-_]?number|account[-_]?number|card[-_]?number|cc[-_]?num|card[-_]?code|social[-_]?security|身份证|银行卡|信用卡|密码|口令|验证码|动态码|短信码|支付密码|私钥|令牌|密钥)/i;
  const isSensitiveField = (el) => {
    try {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'password') return true;
      const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      if (FFB_SENSITIVE_AUTOCOMPLETE.has(ac)) return true;
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (role === 'password') return true;
      const names = [
        el.getAttribute('name'), el.id, el.getAttribute('placeholder'),
        el.getAttribute('aria-label'), el.getAttribute('title'),
      ];
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        if (n && FFB_SENSITIVE_NAME_RE.test(n)) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  };
`
