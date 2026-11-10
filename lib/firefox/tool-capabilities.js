// lib/firefox/tool-capabilities.js
// Which capability each tool belongs to, and what each preset exposes.
//
// WHY THIS EXISTS
//
// The preset used to be a hand-written list of tool NAMES per preset. That
// list had to be kept in step with the catalogue by a test, because it
// drifted once already and silently dropped six tools from the "all"
// preset. A second copy of the catalogue is a liability.
//
// Instead, every tool declares the CAPABILITY it belongs to, next to its
// own definition, and the preset is computed from those declarations. The
// catalogue now has exactly one list — the tool definitions themselves —
// and a new tool cannot be forgotten: it is either in the catalogue (and
// so has a capability) or it is not.
//
// THE CAPABILITIES
//
//   core    — the everyday loop. Always on, in every preset.
//   input   — fine-grained input and tab handling: keys, selects,
//             checkboxes, hover, scroll, upload, new/close tab.
//   logs    — the console log buffer.
//   assert  — answering questions about the page: browser_verify and
//             browser_find.
//   cookie  — reading and writing cookies.
//   firefox — what only Firefox can do: containers, extensions, request
//             blocking, detectability.
//   captcha — solving CAPTCHAs.
//
// WHY `core` IS ALWAYS PRESENT
//
// `browser_config` is the only way to widen the preset again. A preset that
// dropped it would strand the agent without the tools it needs — so it is
// in `core`, and `core` is in every preset.
//
// WHY COOKIE IS ITS OWN CAPABILITY
//
// The slim preset is for ordinary browsing, and a cookie READ is part of
// that — a session that logged itself out, a banner that will not go away.
// Writing cookies is a different matter and goes through the confirmation
// gate. So reading and writing cookies ride together in `cookie`, which
// basic has and slim does not, and the Firefox-only family sits in
// `firefox`, which only developer has.

/**
 * The tools each capability covers.
 *
 * This is the single place where a tool's capability is decided. The tool
 * definitions carry the same tag next to themselves — a test checks that
 * the two agree, so neither can drift.
 *
 * @type {Record<string, string[]>}
 */
export const CAPABILITY_TOOLS = {
  core: [
    'browser_start',
    'browser_stop',
    'browser_status',
    'browser_tabs',
    'browser_navigate',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_wait_for',
    'browser_handoff',
    'browser_batch',
    'browser_run_script',
    'browser_config',
    'browser_back',
    'browser_forward',
    'browser_reload',
    'browser_set_viewport',
    'browser_handle_dialog',
    'browser_text',
    'browser_evaluate',
    'browser_screenshot',
    'browser_network',
    'browser_net_check',
    'browser_restart',
  ],
  input: [
    'browser_press_key',
    'browser_select_option',
    'browser_check',
    'browser_hover',
    'browser_scroll',
    'browser_upload',
    'browser_new_tab',
    'browser_close_tab',
  ],
  logs: ['browser_logs'],
  assert: ['browser_verify', 'browser_find'],
  cookie: ['browser_cookie'],
  firefox: ['browser_context', 'browser_extension', 'browser_intercept', 'browser_detectability'],
  captcha: ['browser_captcha', 'browser_captcha_status'],
  /**
   * The local egress proxy.
   *
   * It opens a listening socket on the loopback interface, so it is not
   * part of everyday browsing: it is a repair path for a browser that
   * cannot reach the network at all.
   */
  egress: ['browser_egress'],
}

/**
 * The capabilities each preset exposes.
 *
 * `slim` is the everyday loop. `basic` adds fine-grained input, the log
 * buffer, the page-question tools and cookies. `developer` adds the
 * Firefox-only family and the CAPTCHA solvers. `all` is everything.
 *
 * @type {Record<string, string[]>}
 */
export const PRESET_CAPABILITIES = {
  slim: ['core'],
  basic: ['core', 'input', 'logs', 'assert', 'cookie'],
  developer: ['core', 'input', 'logs', 'assert', 'cookie', 'firefox', 'captcha', 'egress'],
  all: ['core', 'input', 'logs', 'assert', 'cookie', 'firefox', 'captcha', 'egress'],
}

/**
 * The capability a tool belongs to, or 'core' when it has none.
 *
 * @param {string} name
 * @returns {string}
 */
export function capabilityOf(name) {
  for (const [capability, tools] of Object.entries(CAPABILITY_TOOLS)) {
    if (tools.includes(name)) return capability
  }
  return 'core'
}
