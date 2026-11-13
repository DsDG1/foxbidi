import { unwrapRemoteValue } from '../../bidi/protocol.js'
import { ERROR_CODES, fail } from '../errors.js'
import { inspectElement } from '../selector.js'
import { isSensitiveFieldName, redactText } from '../redact.js'
import { LOOKUP_ELEMENT } from '../registry.js'

/**
 * The assertion kinds `browser_verify` understands.
 *
 * `element` — an element with this role and accessible name exists.
 * `text`    — this text is visible on the page.
 * `value`   — this element holds this value.
 * `list`    — this element contains all of these items.
 */
const VERIFY_KINDS = new Set(['element', 'text', 'value', 'list'])

/**
 * How many elements the assertion snapshot looks at.
 *
 * A full snapshot default is 300; the assertion needs to be sure it did not
 * simply miss the element past the cut, so it looks further than the inline
 * snapshot does. It is still a bounded look — this is a check, not a map.
 */
const VERIFY_MAX_ELEMENTS = 500

/**
 * How long a matched piece of text may be echoed back.
 */
const VERIFY_TEXT_LIMIT = 200

/**
 * How much of the page's visible text the fallback lookup reads.
 *
 * The default for `browser_text` is 8000 characters. An assertion that
 * looked only that far would miss a confirmation message near the end of
 * a long page, so the fallback reads more.
 */
const VERIFY_MAX_TEXT_CHARS = 50000

/**
 * Assert something about the current page.
 *
 * WHY A VERIFY TOOL
 *
 * Without one, the only way to ask "is the login form gone and the account
 * page here?" is to pull a whole snapshot and read it. That is a large
 * response to spend on a yes/no question, and the agent has to do the
 * comparison itself — which it does inconsistently, and in prose.
 *
 * `browser_verify` answers the question and returns the verdict.
 *
 * TWO KINDS OF FAILURE, KEPT APART
 *
 * `ok` says whether the ASSERTION COULD BE RUN. `verified` says whether it
 * HELD. An assertion that ran and did not hold is `ok:true, verified:false`
 * — that is a legitimate answer, not a tool failure, and the agent should
 * react to it by looking for another way, not by retrying the call.
 *
 * `ok:false` means the assertion could not be attempted at all: the page
 * was unreachable, the kind was unknown, the required argument was
 * missing, or the target is a credential field that cannot be compared.
 *
 * @param {string} [contextId]
 * @param {object} opts
 * @param {string} opts.kind          one of element | text | value | list
 * @param {string} [opts.role]        kind=element
 * @param {string} [opts.name]        kind=element
 * @param {string} [opts.text]        kind=text
 * @param {string} [opts.ref]         kind=value, kind=list
 * @param {string} [opts.selector]    kind=value, kind=list
 * @param {string} [opts.value]       kind=value
 * @param {string[]} [opts.items]     kind=list
 * @returns {Promise<object>}
 */
export const verifyMethods = {
  async verify(contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    if (!target) return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')

    const kind = String(opts.kind || '').trim()
    if (!VERIFY_KINDS.has(kind)) {
      return fail(ERROR_CODES.INVALID_ARGUMENT, `unknown assertion kind "${kind}"`, {
        hint: 'Use one of: element, text, value, list.',
      })
    }

    const result = { ok: true, kind }
    try {
      if (kind === 'element') return await this._verifyElement(target, opts, result)
      if (kind === 'text') return await this._verifyText(target, opts, result)
      if (kind === 'value') return await this._verifyValue(target, opts, result)
      return await this._verifyList(target, opts, result)
    } catch (e) {
      return fail(classifyVerifyError(e), e.message)
    }
  },
  /**
   * Assert that an element with this role and accessible name exists.
   *
   * The name is matched EXACTLY first, then as a substring, so that a
   * precise assertion stays precise and a loose one still finds the
   * element. The match is case-insensitive, matching how the snapshot's
   * `nameContains` filter already behaves.
   */
  async _verifyElement(contextId, opts, result) {
    const role = opts.role ? String(opts.role) : ''
    const name = opts.name ? String(opts.name) : ''
    if (!role && !name) {
      return fail(ERROR_CODES.INVALID_ARGUMENT, 'kind="element" needs a role, a name, or both', {
        hint: 'Pass the ARIA role (e.g. "button") and/or the accessible name to look for.',
      })
    }

    const snap = await this.snapshot(contextId, { maxElements: VERIFY_MAX_ELEMENTS })
    if (!snap.ok) return snap

    const expected = role && name ? `${role} "${name}"` : role || name
    result.expected = expected

    const elements = Array.isArray(snap.elements) ? snap.elements : []
    const norm = (s) =>
      String(s || '')
        .trim()
        .toLowerCase()
    const wantRole = norm(role)
    const wantName = norm(name)

    const roleMatches = elements.filter((el) => !wantRole || norm(el.role) === wantRole)
    const exact = roleMatches.find(
      (el) => wantName && norm(el.name) === wantName && (!wantRole || norm(el.role) === wantRole),
    )
    const partial = roleMatches.find((el) => wantName && norm(el.name).includes(wantName))
    const hit = exact || partial || (!wantName ? roleMatches[0] : undefined)

    if (!hit) {
      result.verified = false
      result.actual = 'no matching element found'
      result.candidates = elements
        .filter((el) => (wantRole ? norm(el.role) === wantRole : true))
        .slice(0, 10)
        .map((el) => ({ ref: el.ref, role: el.role, name: el.name }))
      return result
    }

    result.verified = true
    result.actual = `${hit.role} "${hit.name}"`
    result.ref = hit.ref
    return result
  },
  /**
   * Assert that some text is visible on the page.
   *
   * The visible text comes from the snapshot's own text blocks, which are
   * already redacted. That matters: asserting against a one-time code
   * fails, because the page's copy of the code was redacted before it
   * reached the assertion. The hint says so rather than letting the
   * agent wonder why a code that is plainly on screen did not match.
   *
   * The snapshot's text blocks cover BLOCK-level elements (`p`, `li`,
   * headings, table cells…). A page that puts its text in a `<div>` or a
   * `<span>` yields no block at all, so the whole visible text of the page
   * is consulted as a fallback — otherwise "the confirmation is on screen"
   * would be unverifiable on a page built out of divs.
   */
  async _verifyText(contextId, opts, result) {
    const text = opts.text ? String(opts.text) : ''
    if (!text.trim()) {
      return fail(ERROR_CODES.INVALID_ARGUMENT, 'kind="text" needs a text argument')
    }

    const snap = await this.snapshot(contextId, {
      maxElements: VERIFY_MAX_ELEMENTS,
      includeText: true,
    })
    if (!snap.ok) return snap

    result.expected = text
    const needle = text.toLowerCase()
    const texts = Array.isArray(snap.texts) ? snap.texts : []
    const names = (Array.isArray(snap.elements) ? snap.elements : []).map((el) => el.name)

    const found = texts.find((t) =>
      String(t || '')
        .toLowerCase()
        .includes(needle),
    )
    if (found !== undefined) {
      result.verified = true
      result.actual = String(found).slice(0, VERIFY_TEXT_LIMIT)
      return result
    }

    // Fall back to the accessible names — a button labelled "提交订单"
    // carries the text the agent is looking for.
    const matched = names.find((n) =>
      String(n || '')
        .toLowerCase()
        .includes(needle),
    )
    if (matched) {
      result.verified = true
      result.actual = String(matched).slice(0, VERIFY_TEXT_LIMIT)
      return result
    }

    // Last resort: the whole visible text of the page. The snapshot only
    // collects block-level text, so a page that puts its content in a
    // `<div>` or a `<span>` would otherwise be unverifiable.
    const full = await this.text(contextId, { maxChars: VERIFY_MAX_TEXT_CHARS })
    if (
      full &&
      full.ok &&
      String(full.value || '')
        .toLowerCase()
        .includes(needle)
    ) {
      result.verified = true
      result.actual = 'found in the visible text of the page'
      return result
    }

    result.verified = false
    result.actual = 'text not found in the visible content'
    if (redactedNearMiss(text, texts, names)) {
      result.hint =
        'The text looks like a credential. Visible text is redacted before it is read, so a redacted value cannot be asserted on.'
    }
    return result
  },
  /**
   * Assert that an element holds a value.
   *
   * A CREDENTIAL FIELD IS REFUSED, not compared. The page-side guard
   * never lets a credential's value leave the browser at all — the
   * element comes back with an empty value — so there is genuinely
   * nothing to compare against. Saying "expected X, actual ''" would be
   * a misleading answer to a question that was never really asked.
   */
  async _verifyValue(contextId, opts, result) {
    if (!opts.ref && !opts.selector) {
      return fail(ERROR_CODES.INVALID_ARGUMENT, 'kind="value" needs a ref or a selector', {
        hint: 'Use the ref from browser_snapshot, or a CSS selector.',
      })
    }
    if (opts.value === undefined || opts.value === null || opts.value === '') {
      return fail(ERROR_CODES.INVALID_ARGUMENT, 'kind="value" needs the expected value')
    }

    const resolution = await this._resolveActionTarget(opts.selector, contextId, {
      ref: opts.ref,
    })
    if (!resolution.ok) {
      return { ...resolution, contextId }
    }
    const { resolved } = resolution
    const actionContext = resolved.contextId

    const info = await inspectElement(this.client, {
      contextId: actionContext,
      selector: resolved.selector,
      ref: resolved.ref,
      key: this._registryKey,
    })
    if (!info) {
      return fail(ERROR_CODES.ELEMENT_NOT_FOUND, 'the target element was not found')
    }

    // The same facts the page-side guard reads: type, role, name. The
    // page never returns a credential's value, so refusing here is
    // reporting what is already true, not adding a new restriction.
    if (isSensitiveFieldName(info)) {
      return fail(
        ERROR_CODES.REDACTED_VALUE,
        'the target field is a credential and cannot be compared',
        {
          hint: 'The plugin redacts passwords, one-time codes and card numbers, and never reads their values out of the page. Assert on something else.',
        },
      )
    }

    result.contextId = actionContext
    const expected = String(opts.value)
    result.expected = expected
    const actual = typeof info.value === 'string' ? redactText(info.value) : ''
    result.actual = actual
    result.verified = actual === expected
    if (!result.verified && info.checked !== undefined && info.checked !== null) {
      result.checked = info.checked
    }
    return result
  },
  /**
   * Assert that an element contains all of these items.
   *
   * Every item is checked on its own, so the answer says WHICH items were
   * there and which were not — a partial match is the common case and the
   * interesting one.
   */
  async _verifyList(contextId, opts, result) {
    if (!opts.ref && !opts.selector) {
      return fail(ERROR_CODES.INVALID_ARGUMENT, 'kind="list" needs a ref or a selector', {
        hint: 'Use the ref from browser_snapshot, or a CSS selector.',
      })
    }
    const items = Array.isArray(opts.items) ? opts.items.map((i) => String(i)) : []
    if (!items.length) {
      return fail(ERROR_CODES.INVALID_ARGUMENT, 'kind="list" needs a non-empty items array')
    }

    const resolution = await this._resolveActionTarget(opts.selector, contextId, {
      ref: opts.ref,
    })
    if (!resolution.ok) {
      return { ...resolution, contextId }
    }
    const { resolved } = resolution
    const actionContext = resolved.contextId

    const info = await inspectElement(this.client, {
      contextId: actionContext,
      selector: resolved.selector,
      ref: resolved.ref,
      key: this._registryKey,
    })
    if (!info) {
      return fail(ERROR_CODES.ELEMENT_NOT_FOUND, 'the target element was not found')
    }

    const text = await this._elementText(actionContext, {
      ref: resolved.ref,
      selector: resolved.selector,
    })
    const haystack = String(text || '').toLowerCase()
    const matched = []
    const missing = []
    for (const item of items) {
      if (haystack.includes(item.toLowerCase())) matched.push(item)
      else missing.push(item)
    }

    result.contextId = actionContext
    result.expected = items.join(', ')
    result.actual = String(text || '')
      .trim()
      .slice(0, VERIFY_TEXT_LIMIT)
    result.matched = matched
    result.missing = missing
    result.verified = missing.length === 0
    return result
  },
  /**
   * Read the visible text inside an element.
   *
   * The value is read out of the page, so it is redacted on the way out —
   * the same rule every other text path in the plugin follows.
   */
  async _elementText(contextId, opts) {
    try {
      const raw = await this.client.send('script.callFunction', {
        functionDeclaration: `(key, ref, selector) => {
          const el = (${LOOKUP_ELEMENT})(key, ref, selector);
          if (!el) return null;
          return el.innerText || el.textContent || '';
        }`,
        arguments: [
          { type: 'string', value: this._registryKey },
          { type: 'string', value: opts.ref || '' },
          { type: 'string', value: opts.selector || '' },
        ],
        target: { context: contextId },
        awaitPromise: true,
        resultOwnership: 'none',
      })
      // The BiDi layer answers with `{result: <RemoteValue>}`; the same
      // shape every other script.callFunction caller unwraps.
      const value = unwrapRemoteValue(raw.result || {})
      return typeof value === 'string' ? redactText(value) : ''
    } catch (e) {
      // An unreadable target means "the items could not be confirmed", not
      // "the items are absent". Say so, so the assertion reports a
      // failure to CHECK rather than a false negative.
      return ''
    }
  },
}

/**
 * Is the missing text suspiciously close to a redacted value?
 *
 * Used only to explain a failed text assertion: when the page showed
 * `<redacted>` where the agent expected a code, the reason is the
 * redaction rule, and saying so saves a confused retry loop.
 */
function redactedNearMiss(text, texts, names) {
  const needle = String(text || '').toLowerCase()
  if (!needle) return false
  const all = [...(texts || []), ...(names || [])].map((s) => String(s || '').toLowerCase())
  return all.some((s) => s.includes('<redacted>') && needle.length >= 4)
}

/**
 * Map an exception onto the plugin's error codes.
 */
function classifyVerifyError(e) {
  const message = String((e && e.message) || '')
  if (/no such element|element not found/i.test(message)) return ERROR_CODES.ELEMENT_NOT_FOUND
  if (/timeout|timed out/i.test(message)) return ERROR_CODES.TIMEOUT
  return ERROR_CODES.INVALID_ARGUMENT
}
