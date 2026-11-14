// lib/firefox/page/dom.js
// Pure browser-realm DOM helpers shared across snapshot, selector, and input scripts.

import { serializePageFn } from './serialize.js'

export const ROLE_BY_TAG = {
  a: 'link',
  button: 'button',
  select: 'combobox',
  textarea: 'textbox',
  option: 'option',
  summary: 'button',
  label: 'text',
}

export const FFB_SENSITIVE_AUTOCOMPLETE = new Set([
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

export const FFB_SENSITIVE_NAME_RE =
  /(pass(word|wd|phrase)?|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|auth[-_]?token|bearer|session[-_]?id|sessionid|csrf|xsrf|otp|one[-_]?time|2fa|mfa|two[-_]?factor|verification[-_]?code|verify[-_]?code|security[-_]?code|cvv|cvc|cvv2|pin[-_]?code|bank[-_]?code|iban|swift|routing[-_]?number|account[-_]?number|card[-_]?number|cc[-_]?num|card[-_]?code|social[-_]?security|身份证|银行卡|信用卡|密码|口令|验证码|动态码|短信码|支付密码|私钥|令牌|密钥)/i

/**
 * Look up an element by registry ref (preferred) or CSS selector.
 *
 * @param {string} key
 * @param {string} ref
 * @param {string} selector
 * @returns {Element|null}
 */
export const lookupElement = (key, ref, selector) => {
  if (ref) {
    const reg = /** @type {any} */ (window)[key]
    return reg ? reg.get(ref) || null : null
  }
  return selector ? document.querySelector(selector) : null
}

/**
 * Serialized lookup helper for backward compatibility with callers importing LOOKUP_ELEMENT.
 */
export const LOOKUP_ELEMENT_SCRIPT = serializePageFn(lookupElement)

/**
 * True when an element declares itself as holding credentials/secrets.
 *
 * @param {Element} el
 * @returns {boolean}
 */
export const isSensitiveField = (el) => {
  try {
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (type === 'password') return true
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase()
    if (FFB_SENSITIVE_AUTOCOMPLETE.has(ac)) return true
    const role = (el.getAttribute('role') || '').toLowerCase()
    if (role === 'password') return true
    const names = [
      el.getAttribute('name'),
      el.id,
      el.getAttribute('placeholder'),
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
    ]
    for (let i = 0; i < names.length; i++) {
      const n = names[i]
      if (n && FFB_SENSITIVE_NAME_RE.test(n)) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Compute ARIA role of an element.
 *
 * @param {Element} el
 * @returns {string}
 */
export const roleOf = (el) => {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit.trim().toLowerCase()
  const tag = el.tagName.toLowerCase()
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase()
    if (type === 'checkbox') return 'checkbox'
    if (type === 'radio') return 'radio'
    if (type === 'password') return 'password'
    if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') {
      return 'button'
    }
    if (type === 'range') return 'slider'
    if (type === 'number') return 'spinbutton'
    if (type === 'file') return 'file'
    if (type === 'search') return 'searchbox'
    return 'textbox'
  }
  return /** @type {Record<string, string>} */ (ROLE_BY_TAG)[tag] || tag
}

/**
 * Root node lookup supporting Shadow DOM `aria-labelledby` resolution.
 *
 * @param {Element} el
 * @returns {Document|ShadowRoot|Node}
 */
export const rootOf = (el) => {
  try {
    return el.getRootNode ? el.getRootNode() : document
  } catch {
    return document
  }
}

/**
 * Look up an element by id within the same root (shadow root or document).
 *
 * @param {Element} el
 * @param {string} id
 * @returns {Element|null}
 */
export const byId = (el, id) => {
  const root = /** @type {any} */ (rootOf(el))
  if (root && typeof root.getElementById === 'function') {
    const found = root.getElementById(id)
    if (found) return found
  }
  return document.getElementById(id)
}

/**
 * Accessible name in screen-reader preference order.
 *
 * @param {Element} el
 * @returns {string}
 */
export const nameOf = (el) => {
  const aria = el.getAttribute('aria-label')
  if (aria && aria.trim()) return aria.trim().slice(0, 120)
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const parts = []
    const ids = labelledBy.split(/\s+/)
    for (let i = 0; i < ids.length; i++) {
      const ref = byId(el, ids[i])
      if (ref && ref.textContent) parts.push(ref.textContent.trim())
    }
    if (parts.length) return parts.join(' ').slice(0, 120)
  }
  if (el.id) {
    let label = null
    try {
      label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
    } catch {}
    if (label && label.textContent) return label.textContent.trim().slice(0, 120)
  }
  const wrapping = el.closest ? el.closest('label') : null
  if (wrapping && wrapping.textContent) return wrapping.textContent.trim().slice(0, 120)
  const placeholder = el.getAttribute('placeholder')
  if (placeholder && placeholder.trim()) return placeholder.trim().slice(0, 120)
  const alt = el.getAttribute('alt')
  if (alt && alt.trim()) return alt.trim().slice(0, 120)
  const title = el.getAttribute('title')
  if (title && title.trim()) return title.trim().slice(0, 120)
  if (el.tagName === 'SELECT') {
    const selectEl = /** @type {HTMLSelectElement} */ (el)
    const selected = selectEl.selectedOptions && selectEl.selectedOptions[0]
    if (selected) {
      const text = (selected.textContent || '').trim()
      if (text) return text.slice(0, 120)
    }
    return ''
  }
  const text = (el.textContent || '').trim()
  if (text) return text.slice(0, 120)
  const attrName = el.getAttribute('name')
  if (attrName && attrName.trim()) return attrName.trim().slice(0, 120)
  return ''
}

/**
 * Whether an element has non-zero painted box and is not CSS-hidden.
 *
 * @param {Element} el
 * @returns {boolean}
 */
export const isVisible = (el) => {
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  const style = window.getComputedStyle(el)
  if (!style) return true
  if (style.visibility === 'hidden' || style.display === 'none') return false
  if (Number(style.opacity) === 0) return false
  return true
}

/**
 * Nearest semantic landmark containing an element (`dialog`, `nav`, `main`,
 * `header`, `footer`, `aside`, `form`, or `body`).
 *
 * @param {Element} el
 * @returns {string}
 */
export const landmarkOf = (el) => {
  /** @type {Element|null} */
  let cur = el.parentElement
  while (cur) {
    const explicitRole = (cur.getAttribute && cur.getAttribute('role')) || ''
    const r = explicitRole.trim().toLowerCase()
    if (
      r === 'dialog' ||
      r === 'alertdialog' ||
      r === 'navigation' ||
      r === 'main' ||
      r === 'banner' ||
      r === 'contentinfo' ||
      r === 'complementary' ||
      r === 'search' ||
      r === 'form'
    ) {
      if (r === 'navigation') return 'nav'
      if (r === 'banner') return 'header'
      if (r === 'contentinfo') return 'footer'
      if (r === 'complementary') return 'aside'
      if (r === 'alertdialog') return 'dialog'
      return r
    }
    const tag = cur.tagName ? cur.tagName.toLowerCase() : ''
    if (
      tag === 'dialog' ||
      tag === 'nav' ||
      tag === 'main' ||
      tag === 'header' ||
      tag === 'footer' ||
      tag === 'aside' ||
      tag === 'form'
    ) {
      return tag
    }
    const root = cur.getRootNode ? cur.getRootNode() : null
    if (root && /** @type {ShadowRoot} */ (root).host) {
      cur = /** @type {ShadowRoot} */ (root).host
    } else {
      cur = cur.parentElement
    }
  }
  return 'body'
}

export const SNAPSHOT_DOM_BINDINGS = {
  ROLE_BY_TAG,
  FFB_SENSITIVE_AUTOCOMPLETE,
  FFB_SENSITIVE_NAME_RE,
  isSensitiveField,
  roleOf,
  rootOf,
  byId,
  nameOf,
  isVisible,
  landmarkOf,
}
