// lib/firefox/provider/find.js
// Searching the page for something.
//
// WHY A SEARCH TOOL
//
// The snapshot answers "what can I interact with?". The page text answers
// "what does it say?". Neither is good at "where is the thing that says
// X?" — the snapshot can only be filtered by ROLE or by a substring of the
// accessible NAME, so an agent hunting for a word it saw in the prose has
// to read the whole page to work out whether it belongs to a button.
//
// `browser_find` searches both and reports the two kinds of hit SEPARATELY,
// because they mean different things to the agent:
//
//   - an element hit carries a REF, so it can be acted on directly;
//   - a text hit is prose, which tells the agent the words are on the page
//     but gives it nothing to click.
//
// Reporting them together would blur that distinction, and the agent would
// try to click a paragraph.
//
// WHY THERE IS NO TREE PATH
//
// The upstream tool renders its results as snippets of an indented text
// tree, with each match shown under its path from the root. This plugin's
// snapshot is a FLAT list of interactive elements — it carries no parent
// links, so there is no path to show.
//
// What it can show instead is the NEIGHBOURHOOD: the elements just before
// and just after the match in document order. That answers the same
// question the tree path answers — "what is this thing near?" — for a flat
// list, and it costs nothing extra because the order is already known.

import { ERROR_CODES, fail } from '../errors.js'

/**
 * How many neighbours a match carries on each side by default.
 *
 * Two is enough to tell "the button under the Total label" from "the button
 * in the footer", without turning the response into a snapshot.
 */
const DEFAULT_CONTEXT = 2

/**
 * How many neighbours a match may carry at most.
 */
const MAX_CONTEXT = 10

/**
 * How much of the page's visible text the search reads.
 *
 * The whole page, so that a word in the last paragraph is as findable as
 * one in the first.
 */
const FIND_MAX_TEXT_CHARS = 200000

/**
 * How long a reported text hit may be.
 */
const FIND_TEXT_LIMIT = 400

/**
 * The elements a match carries as neighbours.
 */
function neighbours(elements, index, count) {
  const before = []
  for (let i = Math.max(0, index - count); i < index; i++) {
    before.push({ ref: elements[i].ref, role: elements[i].role, name: elements[i].name })
  }
  const after = []
  for (let i = index + 1; i <= Math.min(elements.length - 1, index + count); i++) {
    after.push({ ref: elements[i].ref, role: elements[i].role, name: elements[i].name })
  }
  return { before, after }
}

export const findMethods = {
  /**
   * Search the page for a piece of text.
   *
   * The match is a case-insensitive substring. Both the interactive
   * elements and the page's visible text are searched, and the two kinds of
   * hit are reported separately: `elements` carries refs you can act on,
   * `texts` is prose.
   *
   * @param {string} [contextId]
   * @param {object} opts
   * @param {string} opts.text      what to look for
   * @param {number} [opts.context]  neighbours per side (default 2, max 10)
   * @param {number} [opts.maxResults]  cap on the reported hits
   * @returns {Promise<object>}
   */
  async find(contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    if (!target) return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')

    const text = opts.text ? String(opts.text) : ''
    if (!text.trim()) {
      return fail(ERROR_CODES.INVALID_ARGUMENT, 'find needs a text argument')
    }
    const context = Math.min(
      MAX_CONTEXT,
      Math.max(0, Number.isFinite(opts.context) ? opts.context : DEFAULT_CONTEXT),
    )

    const needle = text.toLowerCase()
    const snap = await this.snapshot(target, { maxElements: 5000 })
    if (!snap.ok) return snap

    const elements = Array.isArray(snap.elements) ? snap.elements : []
    const elementHits = []
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      if (
        !String(el.name || '')
          .toLowerCase()
          .includes(needle)
      )
        continue
      elementHits.push({
        ref: el.ref,
        role: el.role,
        name: el.name,
        ...neighbours(elements, i, context),
      })
    }

    // The page's own prose, read separately. It is redacted on the way
    // out, so a credential in the text is never reported — and a search
    // for one finds nothing, which is the honest answer.
    const page = await this.text(target, { maxChars: FIND_MAX_TEXT_CHARS })
    const textHits = []
    if (page && page.ok) {
      const lines = String(page.value || '').split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (!trimmed.toLowerCase().includes(needle)) continue
        textHits.push(trimmed.slice(0, FIND_TEXT_LIMIT))
        if (textHits.length >= 50) break
      }
    }

    const maxResults =
      Number.isFinite(opts.maxResults) && opts.maxResults > 0 ? opts.maxResults : null
    const cap = (list) =>
      maxResults && list.length > maxResults ? list.slice(0, maxResults) : list

    const elementsOut = cap(elementHits)
    const textsOut = cap(textHits)
    const total = elementHits.length + textHits.length

    return {
      ok: true,
      contextId: target,
      query: text,
      elements: elementsOut,
      texts: textsOut,
      elementCount: elementHits.length,
      textCount: textHits.length,
      total,
      truncated: maxResults ? total > maxResults : textHits.length >= 50,
    }
  },
}
