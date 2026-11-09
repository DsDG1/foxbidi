// test/skill.test.js
// Assertions about the skill guide.
//
// The guide is the ONLY channel the model reliably reads for this plugin:
// the host never consumes an MCP server's `instructions` field, and plugin
// hooks need an app-side capability grant. The skill's frontmatter sits in
// the always-present skill catalogue, so the routing rule has to be there.
//
// These assertions are about content, not formatting — they exist so a
// future edit cannot silently drop the routing rule or reintroduce a fact
// that is wrong (the in-app browser DOES carry a login state).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const skill = readFileSync(join(here, '..', 'skills', 'firefox-browser', 'SKILL.md'), 'utf8')
const frontmatter = skill.split('---')[1] || ''

describe('skill guide', () => {
  test('the catalog description states the routing default', () => {
    assert.match(frontmatter, /内置浏览器|当前浏览器|右侧/)
    assert.match(frontmatter, /默认/)
  })

  test('the body explains how to choose a surface', () => {
    assert.match(skill, /选哪个浏览器|浏览器表面|选择浏览器/)
  })

  test('the body documents the handoff tool', () => {
    assert.match(skill, /browser_handoff/)
  })

  test('the body explains how the user sees a screenshot', () => {
    assert.match(skill, /imageUrl|image url|图片 URL/)
  })

  test('it does not claim the in-app browser lacks a login state', () => {
    assert.doesNotMatch(skill, /内置浏览器[^。\n]*不带登录态/)
  })

  test('it explains the dialog handling', () => {
    // A dialog blocks the page, so the guide has to say what happens to it.
    assert.match(skill, /effect\.dialog/)
    assert.match(skill, /browser_handle_dialog/)
  })

  test('it explains the helper-script workflow', () => {
    assert.match(skill, /browser_run_script/)
    assert.match(skill, /ff-workspace/)
  })

  test('it explains the Firefox-only tools', () => {
    assert.match(skill, /browser_context/)
    assert.match(skill, /browser_extension/)
    assert.match(skill, /browser_cookie/)
    assert.match(skill, /browser_intercept/)
  })

  test('it does not tell the agent to look for the removed marker attribute', () => {
    // The 2.0 registry replaced the DOM attribute. The guide may mention it
    // once — to warn that it is gone — but must never present it as a way to
    // find elements.
    const mentions = skill.match(/data-mavis-ff-ref/g) || []
    assert.ok(
      mentions.length <= 1,
      `the guide mentions the removed attribute ${mentions.length} times`,
    )
    assert.match(skill, /不写进 DOM/)
  })

  test('it states the detectability limit honestly', () => {
    assert.match(skill, /navigator\.webdriver/)
    assert.match(skill, /browser_detectability/)
  })

  test('it stays within the length budget', () => {
    // A guide the model has to re-read every turn costs tokens on every
    // task. 200 lines is the ceiling agreed for 2.0.
    const lines = skill.split('\n').length
    assert.ok(lines <= 200, `the guide is ${lines} lines — over the 200-line budget`)
  })
})
