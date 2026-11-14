// lib/firefox/page/inputs-page.js
// Pure browser-realm functions for element inspection, focus, clearing,
// option selection, checkbox toggling, and scrolling.
//
// Failures return machine-readable `code` values directly from the page realm
// so Node callers do not have to regex-match English error sentences.

import { serializePageFn } from './serialize.js'
import {
  lookupElement,
  isSensitiveField,
  FFB_SENSITIVE_AUTOCOMPLETE,
  FFB_SENSITIVE_NAME_RE,
} from './dom.js'

const LOOKUP_BINDINGS = { lookupElement }
const INSPECT_BINDINGS = {
  lookupElement,
  FFB_SENSITIVE_AUTOCOMPLETE,
  FFB_SENSITIVE_NAME_RE,
  isSensitiveField,
}

/**
 * Inspect `document.activeElement` for implicit form submission checks.
 */
export const inspectActiveElementPage = () => {
  const el = document.activeElement
  if (!el || el === document.body || el === document.documentElement) return null
  const tag = el.tagName.toLowerCase()
  const type = (el.getAttribute('type') || '').toLowerCase()
  const anyEl = /** @type {any} */ (el)
  const form = anyEl.form || (el.closest ? el.closest('form') : null)
  let formHasSubmitControl = false
  if (form) {
    try {
      formHasSubmitControl = !!form.querySelector(
        'button[type=submit],button[type=image],input[type=submit],input[type=image]',
      )
    } catch {
      formHasSubmitControl = false
    }
  }
  return {
    tag,
    type,
    role: el.getAttribute('role') || '',
    name: (
      el.getAttribute('aria-label') ||
      el.getAttribute('name') ||
      el.getAttribute('placeholder') ||
      ''
    ).trim(),
    inForm: !!form,
    formAction: form && form.action ? form.action : null,
    formMethod: form && form.method ? String(form.method).toLowerCase() : null,
    isSubmit:
      (tag === 'button' && (type === 'submit' || (type === '' && !!form))) ||
      (tag === 'input' && (type === 'submit' || type === 'image')),
    formHasSubmitControl,
  }
}

/**
 * Inspect target element geometry, form context, and redacted state.
 *
 * @param {string} key
 * @param {string} ref
 * @param {string} selector
 */
export const inspectElementPage = (key, ref, selector) => {
  const el = lookupElement(key, ref, selector)
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const tag = el.tagName.toLowerCase()
  const type = (el.getAttribute('type') || '').toLowerCase()
  const anyEl = /** @type {any} */ (el)
  const form = anyEl.form || (el.closest ? el.closest('form') : null)
  const isSubmit =
    (tag === 'button' && (type === 'submit' || (type === '' && !!form))) ||
    (tag === 'input' && (type === 'submit' || type === 'image'))
  let formHasSubmitControl = false
  if (form) {
    try {
      formHasSubmitControl = !!form.querySelector(
        'button[type=submit],button[type=image],input[type=submit],input[type=image]',
      )
    } catch {
      formHasSubmitControl = false
    }
  }
  const sensitive = isSensitiveField(el)
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    w: rect.width,
    h: rect.height,
    tag,
    type,
    role: el.getAttribute('role') || '',
    name: (
      el.getAttribute('aria-label') ||
      el.getAttribute('name') ||
      el.getAttribute('placeholder') ||
      ''
    ).trim(),
    value: sensitive ? '' : typeof anyEl.value === 'string' ? anyEl.value : '',
    checked: !!anyEl.checked,
    disabled: !!anyEl.disabled || el.getAttribute('aria-disabled') === 'true',
    formAction: form && form.action ? form.action : null,
    formMethod: form && form.method ? String(form.method).toLowerCase() : null,
    isSubmit,
    formHasSubmitControl,
    hasDownload: el.hasAttribute('download'),
    isFileInput: tag === 'input' && type === 'file',
  }
}

/**
 * Return raw DOM node so BiDi serializes its `sharedId`.
 *
 * @param {string} key
 * @param {string} ref
 * @param {string} selector
 */
export const resolveSharedIdPage = (key, ref, selector) => {
  const el = lookupElement(key, ref, selector)
  return el || null
}

/**
 * Focus an element and verify `document.activeElement`.
 *
 * @param {string} key
 * @param {string} ref
 * @param {string} selector
 */
export const focusElementPage = (key, ref, selector) => {
  const el = /** @type {HTMLElement|null} */ (lookupElement(key, ref, selector))
  if (!el) return false
  el.focus()
  return document.activeElement === el
}

/**
 * Clear an input or contenteditable element and dispatch framework events.
 *
 * @param {string} key
 * @param {string} ref
 * @param {string} selector
 */
export const clearElementPage = (key, ref, selector) => {
  const el = /** @type {HTMLElement|null} */ (lookupElement(key, ref, selector))
  if (!el) return false
  const contentEditableAttr = el.getAttribute ? el.getAttribute('contenteditable') : null
  if (el.isContentEditable || (contentEditableAttr !== null && contentEditableAttr !== 'false')) {
    el.textContent = ''
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }
  const inputEl = /** @type {HTMLInputElement} */ (el)
  const setter = Object.getOwnPropertyDescriptor(inputEl.constructor.prototype, 'value')
  if (setter && setter.set) setter.set.call(inputEl, '')
  else inputEl.value = ''
  inputEl.dispatchEvent(new Event('input', { bubbles: true }))
  inputEl.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

/**
 * Select an `<option>` inside a `<select>` element, returning structured error codes on failure.
 *
 * @param {string} key
 * @param {string} ref
 * @param {string} selector
 * @param {string} wanted
 * @param {boolean} byText
 */
export const selectOptionPage = (key, ref, selector, wanted, byText) => {
  const rawEl = lookupElement(key, ref, selector)
  if (!rawEl) {
    return { ok: false, code: 'element_not_found', error: 'select element not found' }
  }
  if (rawEl.tagName.toLowerCase() !== 'select') {
    return {
      ok: false,
      code: 'element_not_actionable',
      error: 'target is not a <select> element',
    }
  }
  const el = /** @type {HTMLSelectElement} */ (rawEl)
  if (el.disabled) {
    return { ok: false, code: 'element_not_actionable', error: 'the select control is disabled' }
  }
  const options = Array.from(el.options).map((o) => ({
    value: o.value,
    text: (o.textContent || '').trim(),
  }))
  const match = byText
    ? options.find((o) => o.text === wanted)
    : options.find((o) => o.value === wanted)
  if (!match) {
    return {
      ok: false,
      code: 'invalid_argument',
      error: 'no option matched',
      options: options.map((o) => o.text || o.value),
    }
  }
  el.value = match.value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, selected: match.value, options: options.map((o) => o.text || o.value) }
}

/**
 * Toggle a checkbox or radio control, returning structured error codes on failure.
 *
 * @param {string} key
 * @param {string} ref
 * @param {string} selector
 * @param {boolean} wanted
 */
export const checkElementPage = (key, ref, selector, wanted) => {
  const el = lookupElement(key, ref, selector)
  if (!el) {
    return { ok: false, code: 'element_not_found', error: 'checkbox not found' }
  }
  const type = (el.getAttribute('type') || '').toLowerCase()
  if (type !== 'checkbox' && type !== 'radio') {
    return {
      ok: false,
      code: 'element_not_actionable',
      error: 'target is not a checkbox or radio button',
    }
  }
  const inputEl = /** @type {HTMLInputElement} */ (el)
  if (inputEl.disabled) {
    return { ok: false, code: 'element_not_actionable', error: 'the control is disabled' }
  }
  if (!!inputEl.checked !== !!wanted) inputEl.click()
  return { ok: true, checked: !!inputEl.checked }
}

/**
 * Scroll either a targeted element or the window, returning structured error codes on failure.
 *
 * @param {string} key
 * @param {string} ref
 * @param {string} selector
 * @param {string} direction
 * @param {number} amount
 * @param {boolean} explicitDirection
 */
export const scrollPage = (key, ref, selector, direction, amount, explicitDirection) => {
  const before = window.scrollY || 0
  if (ref || selector) {
    const el = /** @type {HTMLElement|null} */ (lookupElement(key, ref, selector))
    if (!el) {
      return { ok: false, code: 'element_not_found', error: 'scroll target not found' }
    }
    if (explicitDirection && el.scrollHeight > el.clientHeight) {
      const elBefore = el.scrollTop || 0
      if (direction === 'top') {
        el.scrollTop = 0
      } else if (direction === 'bottom') {
        el.scrollTop = el.scrollHeight
      } else {
        const delta = direction === 'up' ? -amount : amount
        if (typeof el.scrollBy === 'function') el.scrollBy(0, delta)
        else el.scrollTop = elBefore + delta
      }
      const elAfter = el.scrollTop || 0
      return { ok: true, scrollY: elAfter, moved: elAfter !== elBefore }
    }
    const rectBefore = el.getBoundingClientRect ? el.getBoundingClientRect() : null
    el.scrollIntoView({ block: 'center', inline: 'nearest' })
    const rectAfter = el.getBoundingClientRect ? el.getBoundingClientRect() : null
    const after = window.scrollY || 0
    const rectMoved =
      !!rectBefore &&
      !!rectAfter &&
      (Math.abs(rectAfter.top - rectBefore.top) > 0.5 ||
        Math.abs(rectAfter.left - rectBefore.left) > 0.5)
    return { ok: true, scrollY: after, moved: after !== before || rectMoved }
  } else if (direction === 'top') {
    window.scrollTo(0, 0)
  } else if (direction === 'bottom') {
    window.scrollTo(0, document.documentElement.scrollHeight)
  } else {
    const delta = direction === 'up' ? -amount : amount
    window.scrollBy(0, delta)
  }
  const after = window.scrollY || 0
  return { ok: true, scrollY: after, moved: after !== before }
}

/**
 * Scroll target into view and measure center coordinates in viewport.
 *
 * @param {string} key
 * @param {string} ref
 * @param {string} selector
 */
export const scrollAndMeasurePage = (key, ref, selector) => {
  const el = lookupElement(key, ref, selector)
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const rect = el.getBoundingClientRect()
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    w: rect.width,
    h: rect.height,
  }
}

export const INSPECT_ACTIVE_SCRIPT = serializePageFn(inspectActiveElementPage)
export const INSPECT_ELEMENT_SCRIPT = serializePageFn(inspectElementPage, INSPECT_BINDINGS)
export const RESOLVE_SHARED_ID_SCRIPT = serializePageFn(resolveSharedIdPage, LOOKUP_BINDINGS)
export const FOCUS_ELEMENT_SCRIPT = serializePageFn(focusElementPage, LOOKUP_BINDINGS)
export const CLEAR_ELEMENT_SCRIPT = serializePageFn(clearElementPage, LOOKUP_BINDINGS)
export const SELECT_OPTION_SCRIPT = serializePageFn(selectOptionPage, LOOKUP_BINDINGS)
export const CHECK_ELEMENT_SCRIPT = serializePageFn(checkElementPage, LOOKUP_BINDINGS)
export const SCROLL_SCRIPT = serializePageFn(scrollPage, LOOKUP_BINDINGS)
export const SCROLL_AND_MEASURE_SCRIPT = serializePageFn(scrollAndMeasurePage, LOOKUP_BINDINGS)
