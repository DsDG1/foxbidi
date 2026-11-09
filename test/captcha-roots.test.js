// test/captcha-roots.test.js
// The shared root-collection block.
//
// Every solver splices this block into the page context, so it has to be
// correct in two ways: it must find the closed shadow roots the preload
// script parked, and it must emit exactly the code the solvers used to
// inline (so a refactor cannot silently change what the page runs).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { rootsSource } from '../lib/firefox/captcha/roots.js'

describe('rootsSource', () => {
  test('collects the closed roots and the open shadow roots', () => {
    const source = rootsSource('PROP')
    assert.match(source, /const roots = \[\];/)
    assert.match(source, /roots\.push\(el\[PROP\]\)/)
    assert.match(source, /roots\.push\(el\.shadowRoot\)/)
    assert.match(source, /document\.body/)
    assert.match(source, /document\.documentElement/)
  })

  test('uses the property name it is given', () => {
    assert.match(rootsSource('__captcha_closed_root'), /el\[__captcha_closed_root\]/)
    assert.doesNotMatch(rootsSource('__captcha_closed_root'), /\[PROP\]/)
  })

  test('emits the exact block the solvers used to inline', () => {
    const expected = [
      'const roots = [];',
      '  const push = (el) => { if (el && el[PROP]) roots.push(el[PROP]); };',
      '  push(document.body);',
      '  push(document.documentElement);',
      "  for (const el of document.querySelectorAll('*')) push(el);",
      "  for (const el of document.querySelectorAll('*')) {",
      '    if (el.shadowRoot) roots.push(el.shadowRoot);',
      '  }',
    ].join('\n')
    assert.equal(rootsSource('PROP'), expected)
  })

  test('produces valid JavaScript', () => {
    // The block is spliced into a page expression, so it must parse on its
    // own once wrapped the way the solvers wrap it. It is NOT executed here:
    // it reads `document`, which only exists in the page.
    const wrapped = `(() => {
  ${rootsSource('PROP')}
  return roots.length;
})()`
    const fn = new Function(`return ${wrapped}`)
    assert.equal(typeof fn, 'function')
  })
})
