// lib/mcp/tools/index.js
// The tool catalogue.
//
// ORDER MATTERS. The host injects the tool schemas in the order the server
// returns them, and the injected order is part of the prompt cache. The
// order below is therefore the historical order, kept deliberately.
//
// The definitions live in one module per concern; this file only decides
// which concern each tool belongs to and in what order they appear.

import { createLifecycleTools } from './lifecycle.js'
import { createReadingTools } from './reading.js'
import { createActionTools } from './action.js'
import { createWorkflowTools } from './workflow.js'
import { createFirefoxTools } from './firefox.js'
import { createCaptchaTools } from './captcha.js'
import { createVerifyTools } from './verify.js'
import { createFindTools } from './find.js'
import { createNetTools } from './net.js'

/**
 * The tool names, in list order.
 *
 * @returns the tool names
 */
export const TOOL_ORDER = [
  'browser_start',
  'browser_stop',
  'browser_status',
  'browser_tabs',
  'browser_new_tab',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_select_option',
  'browser_check',
  'browser_hover',
  'browser_scroll',
  'browser_upload',
  'browser_wait_for',
  'browser_network',
  'browser_close_tab',
  'browser_handoff',
  'browser_text',
  'browser_evaluate',
  'browser_screenshot',
  'browser_logs',
  'browser_handle_dialog',
  'browser_context',
  'browser_extension',
  'browser_cookie',
  'browser_intercept',
  'browser_detectability',
  'browser_captcha',
  'browser_captcha_status',
  'browser_batch',
  'browser_run_script',
  'browser_config',
  // New tools are APPENDED, never inserted. The host sends the tool list as
  // a prefix of every request, so appending keeps the existing 34 entries
  // byte-identical and the prompt cache prefix intact; inserting one in the
  // middle would invalidate everything after it.
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_set_viewport',
  'browser_verify',
  'browser_find',
  'browser_net_check',
  'browser_restart',
  'browser_egress',
]

/**
 * Build the full tool list.
 *
 * @param ctx the server context
 * @returns every tool, in list order
 */
export function createTools(ctx) {
  const byName = new Map()
  for (const tool of [
    ...createLifecycleTools(ctx),
    ...createReadingTools(ctx),
    ...createActionTools(ctx),
    ...createWorkflowTools(ctx),
    ...createFirefoxTools(ctx),
    ...createCaptchaTools(ctx),
    ...createVerifyTools(ctx),
    ...createFindTools(ctx),
    ...createNetTools(ctx),
  ]) {
    byName.set(tool.name, tool)
  }
  return TOOL_ORDER.map((name) => byName.get(name))
}

/**
 * The names of every tool, in list order.
 *
 * @returns the tool names
 */
export function toolNames(ctx) {
  return createTools(ctx).map((t) => t.name)
}
