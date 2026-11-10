// lib/firefox/visibility.js
// What the page shows a human versus what it shows an agent.
//
// WHY THIS EXISTS
//
// A page can hide text from a person while leaving it in the DOM:
// off-screen positioning, white-on-white paint, a 1px font, a clip. An
// agent that reads innerText sees all of it. That is the carrier for
// "the page is talking to the agent" injections.
//
// WHAT THIS MODULE DOES NOT DO
//
// It does not delete anything, and it does not judge whether the content
// is malicious. It computes RENDER FACTS: this node is painted in a way
// a sighted human cannot see it. Whether that matters is L2's decision.
//
// A NOTE ON FALSE POSITIVES
//
// Off-canvas drawers (left:-320px), hover-revealed panels (opacity:0) and
// screen-reader-only labels (clip:rect(0,0,0,0)) are all REAL patterns
// that real sites ship. They will be flagged here, and that is fine —
// because a flag is a signal, not a verdict. L2 only escalates when a
// hidden fact and an instruction pattern co-occur.
//
// ARIA-HIDDEN IS NOT "HIDDEN"
//
// `aria-hidden="true"` hides content from SCREEN READERS, not from eyes.
// A sighted human reads such content perfectly well, so it is NOT a
// render fact of the same kind. It is reported in its own bucket, and the
// classification keeps the two apart: `hidden` and `ariaHidden`.

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
 * `aria_hidden` is deliberately NOT part of the hidden verdict: such content
 * is visible to a sighted human. It is tracked separately because a page
 * that hides text from screen readers but not from eyes is still odd.
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

/**
 * The page-side script that collects the render facts.
 *
 * It is a FUNCTION EXPRESSION — the caller evaluates it as
 * `(${VISIBILITY_SCRIPT})()` — and returns a plain object with three
 * buckets:
 *
 *   hidden     text nodes painted so a human cannot see them
 *   ariaHidden text nodes that are only hidden from assistive technology
 *   named      interactive elements whose ACCESSIBLE NAME carries a hidden
 *              fact — the hardest carrier, because the agent picks
 *              elements by name and that name never passes through
 *              innerText
 *
 * `String.raw` keeps the regex escapes intact: the browser receives `\s`
 * and not the letter `s`.
 *
 * The script only READS. There is deliberately no removal anywhere in it:
 * deleting a drawer's labels breaks a real site, and the whole point of
 * this layer is to produce facts, not verdicts.
 */
export const VISIBILITY_SCRIPT = String.raw`() => {
  const out = { hidden: [], ariaHidden: [], named: [] };

  try {
    if (!document.body) return out;

    const effectiveBackground = (el) => {
      let node = el;
      while (node && node.nodeType === 1) {
        const s = window.getComputedStyle(node);
        if (!s) break;
        const bg = s.backgroundColor;
        const m = bg && bg.match(/rgba?\(([^)]+)\)/);
        if (m) {
          const parts = m[1].split(',').map((x) => parseFloat(x));
          const a = parts.length > 3 ? parts[3] : 1;
          if (a > 0.05) return { rgb: parts.slice(0, 3), alpha: a };
        }
        if (s.backgroundImage && s.backgroundImage !== 'none') return { rgb: null, alpha: 1 };
        node = node.parentElement;
      }
      return { rgb: [255, 255, 255], alpha: 1 };
    };

    const effectiveColor = (el) => {
      const s = window.getComputedStyle(el);
      const m = s.color && s.color.match(/rgba?\(([^)]+)\)/);
      return m ? m[1].split(',').map((x) => parseFloat(x)) : [0, 0, 0, 1];
    };

    const reasonsFor = (el) => {
      const found = [];
      const s = window.getComputedStyle(el);
      if (!s) return found;
      const rect = el.getBoundingClientRect();

      if (s.display === 'none' || s.visibility === 'hidden') found.push('display_visibility');
      if (Number(s.opacity) === 0) found.push('opacity_zero');

      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      // Below the fold is legitimate — a human scrolls to it. Off to the
      // side, above, or to the left is hiding.
      const belowFold = rect.top >= vh && rect.top < vh * 12;
      if (!belowFold && (rect.right <= 0 || rect.bottom <= 0 || rect.left >= vw || rect.top >= vh)) {
        found.push('offscreen');
      }

      const fs = parseFloat(s.fontSize || '16');
      if (fs > 0 && fs <= 2) found.push('tiny_font');

      const clip = s.clip || '';
      if (/rect\(\s*0px\s*,\s*0px\s*,\s*0px\s*,\s*0px\s*\)/.test(clip)) found.push('clip_rect');
      const cp = s.clipPath || '';
      if (/inset\(\s*50%|inset\(\s*100%/.test(cp)) found.push('clip_path');

      const c = effectiveColor(el);
      if (c.length > 3 && c[3] === 0) found.push('color_transparent');

      const bg = effectiveBackground(el);
      if (bg.alpha > 0.5 && bg.rgb) {
        const same = c.length >= 3 && bg.rgb.every((v, i) => Math.abs(v - c[i]) < 6);
        if (same) found.push('color_equals_background');
      }

      if (el.getAttribute('aria-hidden') === 'true') found.push('aria_hidden');

      return found;
    };

    // aria-hidden on its own is not "hidden from a human", so it goes into
    // its own bucket.
    const bucketFor = (reasons) => {
      const real = reasons.filter((r) => r !== 'aria_hidden');
      if (real.length) return 'hidden';
      if (reasons.includes('aria_hidden')) return 'ariaHidden';
      return null;
    };

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const el = n.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        if (el.closest('script,style,noscript,template')) return NodeFilter.FILTER_REJECT;
        const reasons = reasonsFor(el);
        const bucket = bucketFor(reasons);
        if (bucket) {
          out[bucket].push({
            tag: tag,
            text: n.nodeValue.trim().slice(0, 200),
            reasons: reasons,
            cls: el.className ? String(el.className).slice(0, 60) : '',
          });
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) {}

    // The accessible NAME of an interactive element is where an injection
    // lands hardest: the agent picks elements by name. Those names come from
    // aria-label / title / alt, which never pass through innerText.
    const sel = 'a[href],button,input,select,textarea,[role],[onclick],[contenteditable="true"]';
    const named = document.querySelectorAll(sel);
    for (let i = 0; i < named.length; i++) {
      const el = named[i];
      const name = (
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        el.getAttribute('placeholder') ||
        ''
      ).trim();
      if (!name) continue;
      const reasons = reasonsFor(el);
      const bucket = bucketFor(reasons);
      if (bucket) {
        out.named.push({ tag: el.tagName, name: name.slice(0, 200), reasons: reasons, bucket: bucket });
      }
    }
  } catch (e) {
    // A page that breaks the scan must not break the read.
  }

  return out;
}`
