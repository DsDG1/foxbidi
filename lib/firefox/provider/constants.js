// lib/firefox/provider/constants.js
// The values the provider modules share.
//
// They used to live at the top of provider.js. When the class body was split
// into one module per concern, they moved here so each module can import
// exactly what it needs instead of reaching back into the facade.

/** This plugin's package name — used to derive the profile-copy location. */
export const PLUGIN_NAME = 'firefox-browser'

/** Provider lifecycle states. */
export const STATE = {
  IDLE: 'idle',
  STARTING: 'starting',
  READY: 'ready',
  DEGRADED: 'degraded',
  FAILED: 'failed',
}

/**
 * Default number of characters `browser_text` returns.
 *
 * Deliberately kept below the ~8195-char budget a single tool result should
 * occupy: reading a page must not flood the agent's context. Longer pages
 * are truncated and the caller pages through with `offset`/`nextOffset`.
 */
export const DEFAULT_MAX_TEXT_CHARS = 8000
