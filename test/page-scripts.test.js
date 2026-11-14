// test/page-scripts.test.js
// Unit tests for pure browser-realm functions and serialized BiDi scripts in lib/firefox/page/*.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { serializePageFn } from '../lib/firefox/page/serialize.js'
import { isSensitiveField, landmarkOf, roleOf } from '../lib/firefox/page/dom.js'
import {
  SNAPSHOT_SCRIPT,
  LEGACY_SNAPSHOT_SCRIPT,
  MATCH_ELEMENT_SCRIPT,
} from '../lib/firefox/page/snapshot-page.js'
import {
  SELECT_OPTION_SCRIPT,
  CHECK_ELEMENT_SCRIPT,
  CLEAR_ELEMENT_SCRIPT,
  SCROLL_SCRIPT,
  SCROLL_AND_MEASURE_SCRIPT,
} from '../lib/firefox/page/inputs-page.js'
import { VISIBILITY_SCRIPT } from '../lib/firefox/page/visibility-page.js'

describe('serializePageFn & self-contained browser scripts', () => {
  test('serializePageFn embeds bindings without leaking outer Node scope', () => {
    const helper = (x) => x * 2
    const entry = (n) => helper(n) + 1
    const src = serializePageFn(entry, { helper })
    const fn = vm.runInNewContext(`(${src})`, Object.create(null))
    assert.equal(fn(5), 11)
  })

  test('every exported *_SCRIPT compiles cleanly inside an isolated VM realm', () => {
    const scripts = [
      ['SNAPSHOT_SCRIPT', SNAPSHOT_SCRIPT],
      ['LEGACY_SNAPSHOT_SCRIPT', LEGACY_SNAPSHOT_SCRIPT],
      ['MATCH_ELEMENT_SCRIPT', MATCH_ELEMENT_SCRIPT],
      ['SELECT_OPTION_SCRIPT', SELECT_OPTION_SCRIPT],
      ['CHECK_ELEMENT_SCRIPT', CHECK_ELEMENT_SCRIPT],
      ['CLEAR_ELEMENT_SCRIPT', CLEAR_ELEMENT_SCRIPT],
      ['SCROLL_SCRIPT', SCROLL_SCRIPT],
      ['SCROLL_AND_MEASURE_SCRIPT', SCROLL_AND_MEASURE_SCRIPT],
    ]
    for (const [name, source] of scripts) {
      const fn = vm.runInNewContext(`(${source})`, { window: {}, document: {} })
      assert.equal(typeof fn, 'function', `${name} must evaluate to a function in an isolated VM`)
    }
    assert.equal(typeof VISIBILITY_SCRIPT, 'string')
    assert.ok(VISIBILITY_SCRIPT.startsWith('('))
  })
})

describe('pure DOM helpers & structured page error codes', () => {
  test('landmarkOf detects ancestor semantic landmarks and dialog containers', () => {
    const dialogNode = {
      tagName: 'DIV',
      getAttribute: (attr) => (attr === 'role' ? 'dialog' : null),
      parentElement: null,
    }
    const btn = {
      tagName: 'BUTTON',
      getAttribute: () => null,
      parentElement: dialogNode,
    }
    assert.equal(landmarkOf(/** @type {any} */ (btn)), 'dialog')

    const navNode = {
      tagName: 'NAV',
      getAttribute: () => null,
      parentElement: null,
    }
    const link = {
      tagName: 'A',
      getAttribute: () => null,
      parentElement: navNode,
    }
    assert.equal(landmarkOf(/** @type {any} */ (link)), 'nav')
  })

  test('isSensitiveField flags password, one-time-code, and token-named fields', () => {
    const pw = {
      tagName: 'INPUT',
      type: 'password',
      getAttribute: (k) => (k === 'type' ? 'password' : ''),
      labels: [],
    }
    assert.equal(isSensitiveField(/** @type {any} */ (pw)), true)

    const otp = {
      tagName: 'INPUT',
      type: 'text',
      getAttribute: (k) => (k === 'placeholder' ? 'enter verification otp' : ''),
      labels: [],
    }
    assert.equal(isSensitiveField(/** @type {any} */ (otp)), true)

    const search = {
      tagName: 'INPUT',
      type: 'search',
      getAttribute: (k) => (k === 'type' ? 'search' : k === 'name' ? 'q' : ''),
      labels: [],
    }
    assert.equal(roleOf(/** @type {any} */ (search)), 'searchbox')
    assert.equal(isSensitiveField(/** @type {any} */ (search)), false)
  })

  test('serialized input scripts return structured error codes in an isolated VM', () => {
    const sandbox = {
      window: {},
      document: {
        querySelector: (sel) => {
          if (sel === '#missing') return null
          if (sel === '#plain-div') {
            return { tagName: 'DIV', isConnected: true, getAttribute: () => null }
          }
          if (sel === '#sel') {
            return {
              tagName: 'SELECT',
              isConnected: true,
              disabled: false,
              getAttribute: () => null,
              options: [{ value: 'a', textContent: 'Alpha', selected: false }],
            }
          }
          return null
        },
      },
      Event: class {
        constructor(type) {
          this.type = type
        }
      },
    }

    const selectFn = vm.runInNewContext(`(${SELECT_OPTION_SCRIPT})`, sandbox)
    assert.equal(selectFn('k', '', '#missing', 'a', false).code, 'element_not_found')
    assert.equal(selectFn('k', '', '#plain-div', 'a', false).code, 'element_not_actionable')
    assert.equal(selectFn('k', '', '#sel', 'nope', false).code, 'invalid_argument')

    const checkFn = vm.runInNewContext(`(${CHECK_ELEMENT_SCRIPT})`, sandbox)
    assert.equal(checkFn('k', '', '#missing', true).code, 'element_not_found')
    assert.equal(checkFn('k', '', '#plain-div', true).code, 'element_not_actionable')

    const clearFn = vm.runInNewContext(`(${CLEAR_ELEMENT_SCRIPT})`, sandbox)
    assert.equal(clearFn('k', '', '#missing'), false)
  })

  test('MATCH_ELEMENT_SCRIPT resolves role + name / nth inside an isolated VM', () => {
    const regMap = new Map()
    const byElement = new WeakMap()
    const windowObj = {
      innerWidth: 1280,
      innerHeight: 800,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    }
    Object.defineProperty(windowObj, '__reg', {
      value: { map: regMap, byElement, counter: 0 },
    })

    const makeBtn = (label) => ({
      tagName: 'BUTTON',
      textContent: label,
      matches: () => true,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 80, height: 32 }),
    })
    const b1 = makeBtn('Save')
    const b2 = makeBtn('Save')
    const sandbox = {
      window: windowObj,
      document: {
        getElementById: () => null,
        querySelectorAll: () => [b1, b2],
      },
    }

    const matchFn = vm.runInNewContext(`(${MATCH_ELEMENT_SCRIPT})`, sandbox)
    const hit = matchFn('__reg', 'button', 'save', '', 1)
    assert.equal(hit.ok, true)
    assert.equal(hit.ref, 'e0')
    assert.equal(regMap.get('e0'), b2)

    const miss = matchFn('__reg', 'button', 'Delete', '', 0)
    assert.equal(miss.ok, false)
    assert.equal(miss.code, 'element_not_found')
  })
})
