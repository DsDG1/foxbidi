// lib/mcp/ff-output.js
// Format a tool reply for the shell.
//
// WHY THIS IS A SEPARATE MODULE
//
// `tools/ff-call.mjs` is the way in when the host does NOT inject the
// plugin's tools. That path is already the expensive one — it pays a process
// spawn and a JSON-RPC round trip per call — so it should not ALSO pay for
// saying the same thing twice.
//
// The old format printed the reply's text block AND spread the structured
// payload next to it. For the twelve LEGACY tools the text block IS the
// pretty-printed structured payload (`prettyJson(structured)` in server.js),
// so every legacy call carried its payload twice: `browser_text` shipped a
// 3.7 KB body as 15 KB of output, `browser_tabs` shipped 485 bytes as 485
// bytes of which half was the duplicate.
//
// The fix is not "drop the text" — the text block is the compact summary for
// the newer tools. The fix is to make the modes MUTUALLY EXCLUSIVE: pick one
// shape, print one shape.
//
// This module holds that decision as a pure function so it can be tested
// without starting a browser.

/**
 * The text block of a tool reply, joined.
 *
 * @param {object} result the MCP tool result
 * @returns {string}
 */
function textBlock(result) {
  return (result.content || [])
    .filter((c) => c && c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

/**
 * Render a value as JSON, compactly by default.
 *
 * The pretty form inflates nested payloads noticeably and buys nothing for a
 * machine consumer — the same conclusion the MCP layer already reached in
 * lib/mcp/schema.js.
 *
 * @param {*} value
 * @param {boolean} pretty
 * @returns {string}
 */
function stringify(value, pretty) {
  if (typeof value === 'string') return pretty ? JSON.stringify(value) : value
  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)
}

/**
 * Format one tool reply for stdout.
 *
 * Modes (mutually exclusive, `--text` / `--raw`):
 *   - default: the structured payload only. It carries everything the text
 *     block carries (for legacy tools they are the same bytes) plus the
 *     fields the summary omits.
 *   - `--text`: the text block only — the one-line summary for the newer
 *     tools, and the legacy pretty payload for the legacy ones.
 *   - `--raw`: the whole MCP result, for callers that want the protocol shape.
 *
 * @param {object} message the JSON-RPC reply
 * @param {object} [flags]
 * @param {boolean} [flags.text] print the text block only
 * @param {boolean} [flags.raw] print the whole MCP result
 * @param {boolean} [flags.pretty] indent the JSON
 * @returns {{stdout: string, exitCode: number}}
 */
export function formatToolResult(message, flags = {}) {
  if (!message) {
    return { stdout: JSON.stringify({ ok: false, error: 'no reply' }, null, 1), exitCode: 1 }
  }

  // A protocol-level error is not a tool result: there is no payload to
  // print, only a reason.
  if (message.error) {
    const error = message.error.message || message.error
    return { stdout: JSON.stringify({ ok: false, error }, null, 1), exitCode: 1 }
  }

  const result = message.result || {}
  const text = textBlock(result)

  let payload
  if (flags.raw) {
    payload = {
      content: result.content,
      structuredContent: result.structuredContent,
      isError: result.isError === true,
    }
  } else if (flags.text) {
    payload = text
  } else if (result.structuredContent !== undefined) {
    payload = result.structuredContent
  } else {
    // Defensive: a server that returns no structured payload still has a
    // text block, and losing the answer entirely would be worse than
    // printing the summary.
    payload = text
  }

  return { stdout: stringify(payload, flags.pretty === true), exitCode: 0 }
}
