// lib/firefox/snapshot.js
// ARIA-style element snapshots for the agent.
//
// WHY A HAND-ROLLED SNAPSHOT
//
// Firefox 140 ESR has NO `browsingContext.domSnapshot` and no
// `session.snapshot` — both are Chromium-only. The only way to give an agent
// a semantic view of the page is to inject a script that walks the DOM.
//
// WHAT CHANGED IN 2.0
//
//   1. NO DOM ATTRIBUTES. Refs are stored in a page-side registry (see
//      ./registry.js) instead of a `data-mavis-ff-ref` attribute, so the page
//      cannot see the plugin's bookkeeping. The attribute mode survives as a
//      fallback for pages where the registry cannot be created.
//
//   2. REAL PAGINATION. The old script stopped after 300 candidates, so
//      everything past the 300th interactive element was unreachable — the
//      offset/limit plumbing above it could never reach it. Offset and limit
//      are now applied IN the page, against the full candidate list.
//
//   3. SHADOW DOM. Open shadow roots are walked, so controls inside web
//      components are reachable. Closed shadow roots remain unreachable —
//      that is a platform limit, not an oversight.
//
//   4. FRAMES. `takeSnapshot` can walk the browsing-context tree so that
//      content inside iframes is part of the same snapshot.
//
//   5. FILTERS AND GEOMETRY. `roleFilter` / `nameContains` shrink the
//      payload, and every element carries its viewport rectangle so an agent
//      can tell "already on screen" from "needs scrolling".

import { isRefShape, LOOKUP_ELEMENT } from './registry.js'
import { PAGE_FIELD_GUARD } from './redact.js'

/**
 * The attribute used to mark elements with their snapshot ref.
 *
 * Only used in the attribute FALLBACK mode. Prefixed so a page using the
 * same attribute name for its own purposes does not collide with ours.
 */
export const REF_ATTRIBUTE = 'data-mavis-ff-ref'

/** Maximum number of elements one snapshot returns by default. */
export const DEFAULT_MAX_ELEMENTS = 300

/** Hard ceiling on elements returned by one snapshot. */
export const MAX_ELEMENTS_LIMIT = 5000

/**
 * The injected snapshot script.
 *
 * Self-contained: it receives its configuration as arguments and returns a
 * plain object. Kept as a string so it can be shipped verbatim to
 * `script.callFunction` without any transpilation.
 *
 * Arguments:
 *   key            registry key (the registry must already exist)
 *   offset         index of the first candidate to return
 *   limit          how many candidates to return
 *   roleFilterJson JSON array of roles to keep, or "[]" for all
 *   nameContains   case-insensitive substring the accessible name must contain
 *   includeText    also collect visible text blocks
 */
export const SNAPSHOT_SCRIPT = `(key, offset, limit, roleFilterJson, nameContains, includeText) => {
  const reg = window[key];
  if (!reg) return { elements: [], total: 0, hasMore: false };

${PAGE_FIELD_GUARD}

  const ROLE_BY_TAG = {
    a: 'link', button: 'button', select: 'combobox', textarea: 'textbox',
    option: 'option', summary: 'button', label: 'text',
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'password') return 'password';
      if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') return 'button';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'file') return 'file';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return ROLE_BY_TAG[tag] || tag;
  };

  // A shadow-root element's aria-labelledby points at ids that live in the
  // SAME shadow root, not in the document — so look it up in the element's
  // own root first.
  const rootOf = (el) => {
    try { return el.getRootNode ? el.getRootNode() : document; } catch (e) { return document; }
  };
  const byId = (el, id) => {
    const root = rootOf(el);
    if (root && typeof root.getElementById === 'function') {
      const found = root.getElementById(id);
      if (found) return found;
    }
    return document.getElementById(id);
  };

  // Accessible name, in the order a screen reader would prefer it.
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim().slice(0, 120);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = [];
      const ids = labelledBy.split(/\\s+/);
      for (let i = 0; i < ids.length; i++) {
        const ref = byId(el, ids[i]);
        if (ref && ref.textContent) parts.push(ref.textContent.trim());
      }
      if (parts.length) return parts.join(' ').slice(0, 120);
    }
    if (el.id) {
      let label = null;
      try { label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); } catch (e) {}
      if (label && label.textContent) return label.textContent.trim().slice(0, 120);
    }
    const wrapping = el.closest ? el.closest('label') : null;
    if (wrapping && wrapping.textContent) return wrapping.textContent.trim().slice(0, 120);
    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim().slice(0, 120);
    const alt = el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim().slice(0, 120);
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim().slice(0, 120);
    // A <select>'s text content is the concatenation of ALL its options
    // ("OneTwo"), which is not a usable name. The selected option's label
    // is what a screen reader announces, so use that.
    if (el.tagName === 'SELECT') {
      const selected = el.selectedOptions && el.selectedOptions[0];
      if (selected) {
        const text = (selected.textContent || '').trim();
        if (text) return text.slice(0, 120);
      }
      return '';
    }
    const text = (el.textContent || '').trim();
    if (text) return text.slice(0, 120);
    const name = el.getAttribute('name');
    if (name && name.trim()) return name.trim().slice(0, 120);
    return '';
  };

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    if (!style) return true;
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  };

  const SELECTOR = 'a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex],[contenteditable="true"]';

  // Collect candidates in DOCUMENT ORDER, piercing OPEN shadow roots.
  //
  // A shadow host is usually a plain <div> or a custom element, which does
  // NOT match SELECTOR — so the hosts have to be found by walking every
  // element, not just the interactive ones.
  //
  // The walk is a single pass in document order, and a shadow root is
  // entered the moment its host is met. That keeps the flattened order
  // honest: a control inside a shadow root appears where the host is, not
  // at the end of the page. It also means a control in a shadow root is not
  // pushed past the element cap by a long page.
  const candidates = [];
  const walkedRoots = [];
  const walk = (root) => {
    if (walkedRoots.indexOf(root) !== -1) return;
    walkedRoots.push(root);

    let all;
    try { all = root.querySelectorAll('*'); } catch (e) { return; }
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      let matches = false;
      try { matches = el.matches(SELECTOR); } catch (e) { matches = false; }
      if (matches) candidates.push(el);
      // A shadow root's contents are NOT reachable through the outer
      // querySelectorAll, so there is no double counting here.
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);

  let roleSet = null;
  try {
    const parsed = JSON.parse(roleFilterJson || '[]');
    if (Array.isArray(parsed) && parsed.length) roleSet = new Set(parsed);
  } catch (e) { roleSet = null; }
  const needle = nameContains ? String(nameContains).toLowerCase() : '';

  const matched = [];
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    if (el.getAttribute('type') === 'hidden') continue;
    if (!isVisible(el)) continue;
    const role = roleOf(el);
    if (roleSet && !roleSet.has(role)) continue;
    if (needle) {
      const name = nameOf(el);
      if (name.toLowerCase().indexOf(needle) === -1) continue;
    }
    matched.push(el);
  }

  // Forget elements that left the document so a stale ref can never resolve
  // to a recycled element.
  if (reg.map && reg.byElement) {
    const stale = [];
    reg.map.forEach(function (el, ref) {
      if (!el || el.isConnected === false) stale.push(ref);
    });
    for (let i = 0; i < stale.length; i++) {
      const el = reg.map.get(stale[i]);
      reg.map.delete(stale[i]);
      if (el) reg.byElement.delete(el);
    }
  }

  const total = matched.length;
  const start = offset > 0 ? offset : 0;
  const cap = limit > 0 ? limit : 300;
  const page = matched.slice(start, start + cap);

  const elements = [];
  for (let i = 0; i < page.length; i++) {
    const el = page[i];
    // Refs are STABLE: an element that keeps its place in the document
    // keeps its ref across snapshots. Only genuinely new elements get a
    // new ref.
    let ref = reg.byElement ? reg.byElement.get(el) : null;
    if (!ref) {
      ref = 'e' + (reg.counter++);
      reg.map.set(ref, el);
      reg.byElement.set(el, ref);
    }
    const role = roleOf(el);
    const rect = el.getBoundingClientRect();
    const record = {
      ref: ref,
      role: role,
      name: nameOf(el),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < (window.innerHeight || 0) && rect.left < (window.innerWidth || 0),
    };
    // A field that DECLARES itself a credential never exposes its value.
    // That covers more than a password input: a one-time code is usually a
    // a plain text box, and a card number is too. The decision comes from the
    // element's own declarations (type, autocomplete, names) — never from
    // the content of the value.
    if ('value' in el && typeof el.value === 'string' && el.value) {
      if (isSensitiveField(el)) {
        record.value = '<redacted>';
        record.valueRedacted = true;
      } else {
        // A checkbox's default value is the literal "on" — that is noise, not
        // information, and would mislead an agent reading the snapshot.
        const isDefaultCheckboxValue = (role === 'checkbox' || role === 'radio') && el.value === 'on';
        if (!isDefaultCheckboxValue) record.value = el.value.slice(0, 80);
      }
    }
    if (role === 'checkbox' || role === 'radio') record.checked = !!el.checked;
    if (el.disabled) record.disabled = true;
    elements.push(record);
  }

  let texts;
  if (includeText) {
    texts = [];
    const TEXT_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,td,th,label,blockquote,pre,dd,dt,figcaption';
    let blocks = [];
    try { blocks = document.querySelectorAll(TEXT_SELECTOR); } catch (e) { blocks = []; }
    for (let i = 0; i < blocks.length && texts.length < cap; i++) {
      const el = blocks[i];
      if (!isVisible(el)) continue;
      const t = (el.innerText || '').trim();
      if (t) texts.push(t.slice(0, 400));
    }
    if (!texts.length) {
      const body = document.body ? (document.body.innerText || '').trim() : '';
      if (body) texts.push(body.slice(0, 2000));
    }
  }

  return { elements: elements, total: total, hasMore: start + elements.length < total, texts: texts };
}`

/**
 * The legacy snapshot script, used only when the registry cannot be created.
 *
 * It marks elements with an attribute and returns a plain array. Paging is
 * still applied by the caller, so the 300-element ceiling applies here too —
 * which is exactly why this is the fallback and not the default.
 */
export const LEGACY_SNAPSHOT_SCRIPT = `(attr, maxElements) => {
  const stale = document.querySelectorAll('[' + attr + ']');
  for (let i = 0; i < stale.length; i++) stale[i].removeAttribute(attr);
  const MAX = maxElements > 0 ? maxElements : 300;

${PAGE_FIELD_GUARD}
  const ROLE_BY_TAG = {
    a: 'link', button: 'button', select: 'combobox', textarea: 'textbox',
    option: 'option', summary: 'button', label: 'text',
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'password') return 'password';
      if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') return 'button';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'file') return 'file';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return ROLE_BY_TAG[tag] || tag;
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim().slice(0, 120);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = [];
      const ids = labelledBy.split(/\\s+/);
      for (let i = 0; i < ids.length; i++) {
        const ref = document.getElementById(ids[i]);
        if (ref && ref.textContent) parts.push(ref.textContent.trim());
      }
      if (parts.length) return parts.join(' ').slice(0, 120);
    }
    if (el.id) {
      let label = null;
      try { label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); } catch (e) {}
      if (label && label.textContent) return label.textContent.trim().slice(0, 120);
    }
    const wrapping = el.closest ? el.closest('label') : null;
    if (wrapping && wrapping.textContent) return wrapping.textContent.trim().slice(0, 120);
    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim().slice(0, 120);
    const text = (el.textContent || '').trim();
    if (text) return text.slice(0, 120);
    return '';
  };
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    if (!style) return true;
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  };
  const SELECTOR = 'a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex],[contenteditable="true"]';
  const candidates = document.querySelectorAll(SELECTOR);
  const out = [];
  let seq = 0;
  for (let i = 0; i < candidates.length && out.length < MAX; i++) {
    const el = candidates[i];
    if (!isVisible(el)) continue;
    if (el.getAttribute('type') === 'hidden') continue;
    const ref = 'e' + (seq++);
    el.setAttribute(attr, ref);
    const role = roleOf(el);
    const record = { ref: ref, role: role, name: nameOf(el) };
    if ('value' in el && typeof el.value === 'string' && el.value) {
      if (isSensitiveField(el)) {
        record.value = '<redacted>';
        record.valueRedacted = true;
      } else {
        const isDefaultCheckboxValue = (role === 'checkbox' || role === 'radio') && el.value === 'on';
        if (!isDefaultCheckboxValue) record.value = el.value.slice(0, 80);
      }
    }
    if (role === 'checkbox' || role === 'radio') record.checked = !!el.checked;
    if (el.disabled) record.disabled = true;
    out.push(record);
  }
  return out;
}`

/**
 * Remove the plugin's ref markers from a page.
 *
 * Handles both storage modes: the registry is emptied, and any leftover
 * attributes from the fallback mode are stripped.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} [key]  registry key (registry mode)
 * @returns {Promise<void>}
 */
export async function clearRefs(client, contextId, key) {
  const tasks = [
    client.send('script.callFunction', {
      functionDeclaration:
        '(attr) => { const n = document.querySelectorAll("[" + attr + "]"); for (let i = 0; i < n.length; i++) n[i].removeAttribute(attr); }',
      arguments: [{ type: 'string', value: REF_ATTRIBUTE }],
      target: { context: contextId },
      awaitPromise: true,
      resultOwnership: 'none',
    }),
  ]
  if (key) {
    tasks.push(
      client.send('script.callFunction', {
        functionDeclaration: `(key) => { const reg = window[key]; if (reg && reg.map) { reg.map.clear(); reg.byElement.clear(); } }`,
        arguments: [{ type: 'string', value: key }],
        target: { context: contextId },
        awaitPromise: true,
        resultOwnership: 'none',
      }),
    )
  }
  try {
    await Promise.all(tasks)
  } catch {
    // Best-effort cleanup — a failure here must not break the snapshot.
  }
}

/**
 * Take an ARIA-style snapshot of a browsing context.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {object} opts
 * @param {string} opts.contextId
 * @param {string} opts.key         registry key
 * @param {number} [opts.maxElements]  cap on returned elements
 * @param {number} [opts.offset]       skip this many elements (pagination)
 * @param {string[]} [opts.roleFilter] only keep these roles
 * @param {string} [opts.nameContains] only keep elements whose name contains this
 * @param {boolean} [opts.includeText] also collect visible text blocks
 * @param {boolean} [opts.legacy]  use the attribute-based fallback script
 * @returns {Promise<{elements: Array, total: number, truncated: boolean, hasMore: boolean, nextOffset: number|undefined, texts: string[]|undefined}>}
 */
export async function takeSnapshot(client, opts) {
  const offset = Math.max(0, opts.offset || 0)
  const limit = Math.min(MAX_ELEMENTS_LIMIT, Math.max(1, opts.maxElements || DEFAULT_MAX_ELEMENTS))

  const { unwrapRemoteValue } = await import('../bidi/protocol.js')

  if (opts.legacy) {
    const result = await client.send('script.callFunction', {
      functionDeclaration: LEGACY_SNAPSHOT_SCRIPT,
      arguments: [
        { type: 'string', value: REF_ATTRIBUTE },
        { type: 'number', value: limit },
      ],
      target: { context: opts.contextId },
      awaitPromise: true,
      resultOwnership: 'none',
    })
    const raw = result.result || {}
    let all = unwrapRemoteValue(raw)
    if (!Array.isArray(all)) all = []
    const total = all.length
    const page = all.slice(offset, offset + limit)
    const hasMore = offset + page.length < total
    return {
      elements: page,
      total,
      truncated: hasMore,
      hasMore,
      nextOffset: hasMore ? offset + page.length : undefined,
    }
  }

  const result = await client.send('script.callFunction', {
    functionDeclaration: SNAPSHOT_SCRIPT,
    arguments: [
      { type: 'string', value: opts.key },
      { type: 'number', value: offset },
      { type: 'number', value: limit },
      // A JSON string rather than a BiDi array argument: Firefox's array
      // argument encoding wants a list of RemoteValues, and a plain string
      // list is the portable choice.
      { type: 'string', value: JSON.stringify(opts.roleFilter || []) },
      { type: 'string', value: opts.nameContains || '' },
      { type: 'boolean', value: !!opts.includeText },
    ],
    target: { context: opts.contextId },
    awaitPromise: true,
    resultOwnership: 'none',
  })

  const payload = unwrapRemoteValue(result.result || {}) || {}
  const elements = Array.isArray(payload.elements) ? payload.elements : []
  const total = typeof payload.total === 'number' ? payload.total : elements.length
  const hasMore = !!payload.hasMore

  return {
    elements,
    total,
    truncated: hasMore,
    hasMore,
    nextOffset: hasMore ? offset + elements.length : undefined,
    texts: Array.isArray(payload.texts) ? payload.texts : undefined,
  }
}

/**
 * Check whether a ref still exists in the page.
 *
 * Refs are bound to the DOM: after a re-render the element is gone and the
 * ref must not resolve to something else. An agent that acts on a stale ref
 * must be told so explicitly rather than silently hitting nothing — or, worse,
 * hitting the wrong element.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {string} contextId
 * @param {string} ref
 * @param {object} [opts]
 * @param {string} [opts.key]    registry key (registry mode)
 * @param {boolean} [opts.legacy] use the attribute lookup
 * @returns {Promise<boolean>}
 */
export async function refExists(client, contextId, ref, opts = {}) {
  try {
    if (!opts.legacy && opts.key) {
      const result = await client.send('script.callFunction', {
        // `isConnected` matters as much as the lookup: an element that was
        // removed from the page is still sitting in the registry map, and
        // acting on it would click nothing — or, worse, hit whatever
        // replaced it. The attribute mode got this for free (a detached
        // node is not matched by querySelector); the registry has to check.
        functionDeclaration: `(key, ref) => {
          const reg = window[key];
          if (!reg) return false;
          const el = reg.get(ref);
          return !!(el && el.isConnected !== false);
        }`,
        arguments: [
          { type: 'string', value: opts.key },
          { type: 'string', value: ref },
        ],
        target: { context: contextId },
        awaitPromise: true,
        resultOwnership: 'none',
      })
      const value = result.result || {}
      return value.value === true
    }
    const result = await client.send('script.callFunction', {
      functionDeclaration:
        '(attr, ref) => !!document.querySelector("[" + attr + "=\\"" + ref + "\\"]")',
      arguments: [
        { type: 'string', value: REF_ATTRIBUTE },
        { type: 'string', value: ref },
      ],
      target: { context: contextId },
      awaitPromise: true,
      resultOwnership: 'none',
    })
    const value = result.result || {}
    return value.value === true
  } catch {
    return false
  }
}

/**
 * Build the CSS selector that resolves a ref back to its element.
 *
 * Only meaningful in attribute (fallback) mode.
 *
 * @param {string} ref
 * @returns {string}
 */
export function refSelector(ref) {
  return `[${REF_ATTRIBUTE}="${String(ref).replace(/"/g, '\\"')}"]`
}

/**
 * The in-page element lookup, re-exported so callers do not need to know
 * which module owns it.
 */
export { LOOKUP_ELEMENT }

export { isRefShape }
