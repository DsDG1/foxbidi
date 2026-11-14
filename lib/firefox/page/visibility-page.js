// lib/firefox/page/visibility-page.js
// Pure browser-realm visibility & hidden-text fact collector for prompt-injection defense.

import { serializePageFn } from './serialize.js'

/**
 * Collect hidden, aria-hidden, and named interactive render facts without mutating DOM.
 */
export const scanVisibilityPage = () => {
  /** @type {{hidden: Array<any>, ariaHidden: Array<any>, named: Array<any>, error?: string}} */
  const out = { hidden: [], ariaHidden: [], named: [] }

  try {
    if (!document.body) return out

    /** @type {Map<Element, {rgb: number[]|null, alpha: number}>} */
    const bgCache = new Map()

    /** @param {Element} el */
    const effectiveBackground = (el) => {
      if (bgCache.has(el))
        return /** @type {{rgb: number[]|null, alpha: number}} */ (bgCache.get(el))
      /** @type {Element[]} */
      const chain = []
      /** @type {Element|null} */
      let node = el
      /** @type {{rgb: number[]|null, alpha: number}|null} */
      let result = null
      while (node && node.nodeType === 1) {
        const cached = bgCache.get(node)
        if (cached) {
          result = cached
          break
        }
        chain.push(node)
        const s = window.getComputedStyle(node)
        if (!s) break
        const bg = s.backgroundColor
        const m = bg && bg.match(/rgba?\(([^)]+)\)/)
        if (m) {
          const parts = m[1].split(',').map((x) => parseFloat(x))
          const a = parts.length > 3 ? parts[3] : 1
          if (a > 0.05) {
            result = { rgb: parts.slice(0, 3), alpha: a }
            break
          }
        }
        if (s.backgroundImage && s.backgroundImage !== 'none') {
          result = { rgb: null, alpha: 1 }
          break
        }
        node = node.parentElement
      }
      if (!result) result = { rgb: [255, 255, 255], alpha: 1 }
      for (const n of chain) bgCache.set(n, result)
      bgCache.set(el, result)
      return result
    }

    /** @param {CSSStyleDeclaration} s */
    const effectiveColor = (s) => {
      const m = s.color && s.color.match(/rgba?\(([^)]+)\)/)
      return m ? m[1].split(',').map((x) => parseFloat(x)) : [0, 0, 0, 1]
    }

    /** @type {Map<Element, string[]>} */
    const reasonCache = new Map()

    /** @param {Element} el */
    const reasonsFor = (el) => {
      const cached = reasonCache.get(el)
      if (cached) return cached

      /** @type {string[]} */
      const found = []
      const s = window.getComputedStyle(el)
      if (!s) {
        reasonCache.set(el, found)
        return found
      }
      const rect = el.getBoundingClientRect()

      if (s.display === 'none' || s.visibility === 'hidden') found.push('display_visibility')
      if (Number(s.opacity) === 0) found.push('opacity_zero')

      const vw = window.innerWidth || 0
      if (rect.bottom <= 0 || rect.right <= 0 || rect.left >= vw) {
        found.push('offscreen')
      }

      const fs = parseFloat(s.fontSize || '16')
      if (fs > 0 && fs <= 2) found.push('tiny_font')

      const clip = s.clip || ''
      if (/rect\(\s*0px\s*,\s*0px\s*,\s*0px\s*,\s*0px\s*\)/.test(clip)) found.push('clip_rect')
      const cp = s.clipPath || ''
      if (/inset\(\s*50%|inset\(\s*100%/.test(cp)) found.push('clip_path')

      const c = effectiveColor(s)
      if (c.length > 3 && c[3] === 0) found.push('color_transparent')

      const bg = effectiveBackground(el)
      if (bg.alpha > 0.5 && bg.rgb) {
        const rgb = bg.rgb
        const same = c.length >= 3 && rgb.every((v, i) => Math.abs(v - c[i]) < 6)
        if (same) found.push('color_equals_background')
      }

      if (el.getAttribute('aria-hidden') === 'true') found.push('aria_hidden')

      reasonCache.set(el, found)
      return found
    }

    /** @param {string[]} reasons */
    const bucketFor = (reasons) => {
      const real = reasons.filter((r) => r !== 'aria_hidden')
      if (real.length) return 'hidden'
      if (reasons.includes('aria_hidden')) return 'ariaHidden'
      return null
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT
        const el = n.parentElement
        if (!el) return NodeFilter.FILTER_REJECT
        const tag = el.tagName
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
          return NodeFilter.FILTER_REJECT
        }
        if (el.closest('script,style,noscript,template')) return NodeFilter.FILTER_REJECT
        const reasons = reasonsFor(el)
        const bucket = bucketFor(reasons)
        if (bucket) {
          out[bucket].push({
            tag,
            text: n.nodeValue.trim().slice(0, 200),
            reasons,
            cls: el.className ? String(el.className).slice(0, 60) : '',
          })
          return NodeFilter.FILTER_REJECT
        }
        return NodeFilter.FILTER_ACCEPT
      },
    })
    while (walker.nextNode()) {
      /* walk all text nodes */
    }

    const sel = 'a[href],button,input,select,textarea,[role],[onclick],[contenteditable="true"]'
    const named = document.querySelectorAll(sel)
    for (let i = 0; i < named.length && out.named.length < 300; i++) {
      const el = named[i]
      const name = (
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        el.getAttribute('placeholder') ||
        ''
      ).trim()
      if (!name) continue
      const reasons = reasonsFor(el)
      out.named.push({
        tag: el.tagName,
        name: name.slice(0, 200),
        reasons,
        bucket: bucketFor(reasons),
      })
    }
  } catch (e) {
    out.error = String(/** @type {any} */ (e && /** @type {any} */ (e).message) || e)
  }

  return out
}

export const VISIBILITY_SCRIPT = serializePageFn(scanVisibilityPage)
