// lib/firefox/captcha/roots.js
// How a solver reaches the widgets inside a page.
//
// Every solver needs the same list of "roots" it can query: the CLOSED
// shadow roots the preload script parked on elements, plus the OPEN shadow
// roots the platform exposes. That loop used to be copy-pasted into nine
// places; this is the single source of truth.
//
// The code runs INSIDE the page, so what lives here is a SOURCE STRING, not
// a function: each solver splices the block into its own expression.

/**
 * The source of the root-collection block.
 *
 * The emitted text is byte-for-byte the block it replaces, so the page sees
 * exactly the same code as before.
 *
 * @param {string} propVar  the page-side variable holding the closed-root property name
 * @param {string} indent   the indentation the block should carry
 * @returns {string}
 */
export function rootsSource(propVar = 'PROP', indent = '  ') {
  return (
    [
      'const roots = [];',
      `const push = (el) => { if (el && el[${propVar}]) roots.push(el[${propVar}]); };`,
      'push(document.body);',
      'push(document.documentElement);',
      "for (const el of document.querySelectorAll('*')) push(el);",
      "for (const el of document.querySelectorAll('*')) {",
      '  if (el.shadowRoot) roots.push(el.shadowRoot);',
      '}',
    ]
      // The first line carries the call site's own indentation; the rest are
      // relative to it, exactly as the original inlined block was.
      .map((line, index) => (index === 0 ? line : indent + line))
      .join('\n')
  )
}
