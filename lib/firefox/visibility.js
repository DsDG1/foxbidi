// lib/firefox/visibility.js
// What the page shows a human versus what it shows an agent.
//
// Computes render facts for hidden/aria-hidden text and accessible names.
// The browser-realm implementation lives as a real linted/typechecked JS
// function in `./page/visibility-page.js` and is serialized here for BiDi.

import { VISIBILITY_SCRIPT } from './page/visibility-page.js'

/** The reason codes a hidden node can carry. */
export const HIDDEN_REASON_CODES = new Set([
  'display_visibility',
  'opacity_zero',
  'offscreen',
  'tiny_font',
  'clip_rect',
  'clip_path',
  'color_transparent',
  'color_equals_background',
  'aria_hidden',
])

/**
 * Classify a reason list into "hidden to a human" and "hidden to assistive
 * technology".
 *
 * @param {string[]} reasons
 * @returns {{hidden: boolean, ariaHidden: boolean}}
 */
export function classifyHiddenReasons(reasons) {
  const list = Array.isArray(reasons) ? reasons : []
  return {
    hidden: list.some((r) => r !== 'aria_hidden'),
    ariaHidden: list.includes('aria_hidden'),
  }
}

export { VISIBILITY_SCRIPT }
