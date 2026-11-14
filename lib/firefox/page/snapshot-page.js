// lib/firefox/page/snapshot-page.js
// Pure browser-realm snapshot and semantic element-matching functions.

import { serializePageFn } from './serialize.js'
import {
  SNAPSHOT_DOM_BINDINGS,
  isSensitiveField,
  roleOf,
  nameOf,
  isVisible,
  landmarkOf,
} from './dom.js'

/**
 * Primary registry-backed snapshot function executed inside the page.
 *
 * @param {string} key
 * @param {number} offset
 * @param {number} limit
 * @param {string} roleFilterJson
 * @param {string} nameContains
 * @param {boolean} includeText
 */
export const runSnapshotPage = (key, offset, limit, roleFilterJson, nameContains, includeText) => {
  const reg = /** @type {any} */ (window)[key]
  if (!reg) return { elements: [], total: 0, hasMore: false }

  const SELECTOR =
    'a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex],[contenteditable="true"]'

  /** @type {Element[]} */
  const candidates = []
  /** @type {Array<Document|ShadowRoot>} */
  const walkedRoots = []
  /** @param {Document|ShadowRoot} root */
  const walk = (root) => {
    if (walkedRoots.indexOf(root) !== -1) return
    walkedRoots.push(root)

    let all
    try {
      all = root.querySelectorAll('*')
    } catch {
      return
    }
    for (let i = 0; i < all.length; i++) {
      const el = all[i]
      let matches
      try {
        matches = el.matches(SELECTOR)
      } catch {
        matches = false
      }
      if (matches) candidates.push(el)
      if (el.shadowRoot) walk(el.shadowRoot)
    }
  }
  walk(document)

  /** @type {Set<string>|null} */
  let roleSet = null
  try {
    const parsed = JSON.parse(roleFilterJson || '[]')
    if (Array.isArray(parsed) && parsed.length) roleSet = new Set(parsed)
  } catch {
    roleSet = null
  }
  const needle = nameContains ? String(nameContains).toLowerCase() : ''

  /** @type {Element[]} */
  const matched = []
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i]
    if (el.getAttribute('type') === 'hidden') continue
    if (!isVisible(el)) continue
    const role = roleOf(el)
    if (roleSet && !roleSet.has(role)) continue
    if (needle) {
      const name = nameOf(el)
      if (name.toLowerCase().indexOf(needle) === -1) continue
    }
    matched.push(el)
  }

  if (reg.map && reg.byElement) {
    /** @type {string[]} */
    const stale = []
    reg.map.forEach((/** @type {Element} */ el, /** @type {string} */ ref) => {
      if (!el || el.isConnected === false) stale.push(ref)
    })
    for (let i = 0; i < stale.length; i++) {
      const el = reg.map.get(stale[i])
      reg.map.delete(stale[i])
      if (el) reg.byElement.delete(el)
    }
  }

  const total = matched.length
  const start = offset > 0 ? offset : 0
  const cap = limit > 0 ? limit : 300
  const page = matched.slice(start, start + cap)

  /** @type {Array<Record<string, any>>} */
  const elements = []
  for (let i = 0; i < page.length; i++) {
    const el = page[i]
    let ref = reg.byElement ? reg.byElement.get(el) : null
    if (!ref) {
      ref = 'e' + reg.counter++
      reg.map.set(ref, el)
      reg.byElement.set(el, ref)
    }
    const role = roleOf(el)
    const rect = el.getBoundingClientRect()
    const landmark = landmarkOf(el)
    /** @type {Record<string, any>} */
    const record = {
      ref,
      role,
      name: nameOf(el),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      inViewport:
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < (window.innerHeight || 0) &&
        rect.left < (window.innerWidth || 0),
    }
    if (landmark && landmark !== 'body') {
      record.landmark = landmark
    }
    const anyEl = /** @type {any} */ (el)
    if ('value' in anyEl && typeof anyEl.value === 'string' && anyEl.value) {
      if (isSensitiveField(el)) {
        record.value = '<redacted>'
        record.valueRedacted = true
      } else {
        const isDefaultCheckboxValue =
          (role === 'checkbox' || role === 'radio') && anyEl.value === 'on'
        if (!isDefaultCheckboxValue) record.value = anyEl.value.slice(0, 80)
      }
    }
    if (role === 'checkbox' || role === 'radio') record.checked = !!anyEl.checked
    if (anyEl.disabled) record.disabled = true
    elements.push(record)
  }

  /** @type {string[]|undefined} */
  let texts
  if (includeText) {
    texts = []
    const TEXT_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,td,th,label,blockquote,pre,dd,dt,figcaption'
    /** @type {NodeListOf<Element>|Element[]} */
    let blocks
    try {
      blocks = document.querySelectorAll(TEXT_SELECTOR)
    } catch {
      blocks = []
    }
    for (let i = 0; i < blocks.length && texts.length < cap; i++) {
      const el = blocks[i]
      if (!isVisible(el)) continue
      const htmlEl = /** @type {HTMLElement} */ (el)
      const t = (htmlEl.innerText || '').trim()
      if (t) texts.push(t.slice(0, 400))
    }
    if (!texts.length) {
      const body = document.body ? (document.body.innerText || '').trim() : ''
      if (body) texts.push(body.slice(0, 2000))
    }
  }

  return { elements, total, hasMore: start + elements.length < total, texts }
}

/**
 * Attribute-based fallback snapshot function for realms that block `window` registry.
 *
 * @param {string} attr
 * @param {number} maxElements
 */
export const runLegacySnapshotPage = (attr, maxElements) => {
  const stale = document.querySelectorAll('[' + attr + ']')
  for (let i = 0; i < stale.length; i++) stale[i].removeAttribute(attr)
  const MAX = maxElements > 0 ? maxElements : 300

  const SELECTOR =
    'a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex],[contenteditable="true"]'
  const candidates = document.querySelectorAll(SELECTOR)
  /** @type {Array<Record<string, any>>} */
  const out = []
  let seq = 0
  for (let i = 0; i < candidates.length && out.length < MAX; i++) {
    const el = candidates[i]
    if (!isVisible(el)) continue
    if (el.getAttribute('type') === 'hidden') continue
    const ref = 'e' + seq++
    el.setAttribute(attr, ref)
    const role = roleOf(el)
    /** @type {Record<string, any>} */
    const record = { ref, role, name: nameOf(el) }
    const anyEl = /** @type {any} */ (el)
    if ('value' in anyEl && typeof anyEl.value === 'string' && anyEl.value) {
      if (isSensitiveField(el)) {
        record.value = '<redacted>'
        record.valueRedacted = true
      } else {
        const isDefaultCheckboxValue =
          (role === 'checkbox' || role === 'radio') && anyEl.value === 'on'
        if (!isDefaultCheckboxValue) record.value = anyEl.value.slice(0, 80)
      }
    }
    if (role === 'checkbox' || role === 'radio') record.checked = !!anyEl.checked
    if (anyEl.disabled) record.disabled = true
    out.push(record)
  }
  return out
}

/**
 * Dynamically match a visible interactive element by `{ role, name, nameContains, nth }`
 * and bind it into the page ref registry so multi-step batches can act on newly rendered UI.
 *
 * @param {string} key
 * @param {string} role
 * @param {string} exactName
 * @param {string} nameContains
 * @param {number} nth
 */
export const matchElementInPage = (key, role, exactName, nameContains, nth) => {
  const reg = /** @type {any} */ (window)[key]
  if (!reg) {
    return { ok: false, code: 'element_not_found', error: 'page ref registry is not initialized' }
  }
  const SELECTOR =
    'a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex],[contenteditable="true"]'
  /** @type {Element[]} */
  const candidates = []
  /** @type {Array<Document|ShadowRoot>} */
  const walkedRoots = []
  /** @param {Document|ShadowRoot} root */
  const walk = (root) => {
    if (walkedRoots.indexOf(root) !== -1) return
    walkedRoots.push(root)
    let all
    try {
      all = root.querySelectorAll('*')
    } catch {
      return
    }
    for (let i = 0; i < all.length; i++) {
      const el = all[i]
      let matches
      try {
        matches = el.matches(SELECTOR)
      } catch {
        matches = false
      }
      if (matches) candidates.push(el)
      if (el.shadowRoot) walk(el.shadowRoot)
    }
  }
  walk(document)

  const wantedRole = role ? String(role).trim().toLowerCase() : ''
  const wantedExact = exactName ? String(exactName).trim().toLowerCase() : ''
  const wantedSub = nameContains ? String(nameContains).trim().toLowerCase() : ''
  const index = Number.isFinite(nth) && nth >= 0 ? Math.floor(nth) : 0

  /** @type {Array<{el: Element, role: string, name: string}>} */
  const hits = []
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i]
    if (el.getAttribute('type') === 'hidden') continue
    if (!isVisible(el)) continue
    const elRole = roleOf(el)
    if (wantedRole && elRole !== wantedRole) continue
    const elName = nameOf(el)
    const lowerName = elName.toLowerCase()
    if (wantedExact && lowerName !== wantedExact) continue
    if (wantedSub && lowerName.indexOf(wantedSub) === -1) continue
    hits.push({ el, role: elRole, name: elName })
  }

  if (!hits.length || index >= hits.length) {
    return {
      ok: false,
      code: 'element_not_found',
      error: `no visible element matched ${JSON.stringify({
        ...(wantedRole ? { role: wantedRole } : {}),
        ...(exactName ? { name: exactName } : {}),
        ...(nameContains ? { nameContains } : {}),
        ...(index ? { nth: index } : {}),
      })}`,
      matchCount: hits.length,
    }
  }

  const chosen = hits[index]
  let ref = reg.byElement ? reg.byElement.get(chosen.el) : null
  if (!ref) {
    ref = 'e' + reg.counter++
    reg.map.set(ref, chosen.el)
    reg.byElement.set(chosen.el, ref)
  }
  return {
    ok: true,
    ref,
    role: chosen.role,
    name: chosen.name,
    matchCount: hits.length,
  }
}

export const SNAPSHOT_SCRIPT = serializePageFn(runSnapshotPage, SNAPSHOT_DOM_BINDINGS)
export const LEGACY_SNAPSHOT_SCRIPT = serializePageFn(runLegacySnapshotPage, SNAPSHOT_DOM_BINDINGS)
export const MATCH_ELEMENT_SCRIPT = serializePageFn(matchElementInPage, SNAPSHOT_DOM_BINDINGS)
