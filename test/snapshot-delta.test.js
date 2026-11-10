// test/snapshot-delta.test.js
// Snapshot deltas.
//
// A page that has not changed costs the agent a full element list on every
// snapshot. The delta says what changed SINCE the last one, so an agent
// polling a page pays for the interesting parts only.
//
// The rule that makes this useful: a POSITION change is not a change.
// Scrolling moves every element's rectangle, and counting that would make
// the delta report the whole page every time — which is exactly what the
// delta exists to avoid.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { diffSnapshots } from '../lib/firefox/snapshot.js'

const snapA = [
  { ref: 'e0', role: 'button', name: 'One' },
  { ref: 'e1', role: 'button', name: 'Two' },
]
const snapB = [
  { ref: 'e0', role: 'button', name: 'One' },
  { ref: 'e1', role: 'button', name: 'Two changed' },
  { ref: 'e2', role: 'link', name: 'Three' },
]

describe('snapshot diffing', () => {
  test('a new element is reported as added', () => {
    const out = diffSnapshots(snapA, snapB)
    assert.deepEqual(
      out.added.map((e) => e.ref),
      ['e2'],
    )
  })

  test('a changed name is reported as changed', () => {
    const out = diffSnapshots(snapA, snapB)
    assert.deepEqual(
      out.changed.map((e) => e.ref),
      ['e1'],
    )
  })

  test('a removed element is reported as removed', () => {
    const out = diffSnapshots(snapA, snapA.slice(0, 1))
    assert.deepEqual(out.removed, ['e1'])
  })

  test('identical snapshots produce no differences', () => {
    const out = diffSnapshots(snapA, snapA)
    assert.deepEqual(out.added, [])
    assert.deepEqual(out.changed, [])
    assert.deepEqual(out.removed, [])
  })

  test('a position change is not a change', () => {
    const a = [{ ref: 'e0', role: 'button', name: 'One', rect: { x: 0, y: 0, w: 10, h: 10 } }]
    const b = [{ ref: 'e0', role: 'button', name: 'One', rect: { x: 50, y: 80, w: 10, h: 10 } }]
    const out = diffSnapshots(a, b)
    assert.deepEqual(out.changed, [])
  })

  test('a value change is a change', () => {
    const a = [{ ref: 'e0', role: 'textbox', name: 'Q', value: 'one' }]
    const b = [{ ref: 'e0', role: 'textbox', name: 'Q', value: 'two' }]
    const out = diffSnapshots(a, b)
    assert.deepEqual(
      out.changed.map((e) => e.ref),
      ['e0'],
    )
  })

  test('a checkbox toggle is a change', () => {
    const a = [{ ref: 'e0', role: 'checkbox', name: 'Agree', checked: false }]
    const b = [{ ref: 'e0', role: 'checkbox', name: 'Agree', checked: true }]
    const out = diffSnapshots(a, b)
    assert.deepEqual(
      out.changed.map((e) => e.ref),
      ['e0'],
    )
  })

  test('an empty before-snapshot reports everything as added', () => {
    const out = diffSnapshots([], snapB)
    assert.equal(out.added.length, snapB.length)
    assert.deepEqual(out.changed, [])
    assert.deepEqual(out.removed, [])
  })

  test('missing input is handled without throwing', () => {
    const out = diffSnapshots(undefined, undefined)
    assert.deepEqual(out.added, [])
    assert.deepEqual(out.changed, [])
    assert.deepEqual(out.removed, [])
  })
})
