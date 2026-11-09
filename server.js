#!/usr/bin/env node
// server.js
// MCP (Model Context Protocol) stdio server for the `firefox-browser` plugin.
//
// Exposes a real Firefox — driven over WebDriver BiDi — as a set of MCP tools
// the agent can call directly. The server is long-lived: one stdio process
// holds one Firefox instance, so browser state survives across tool calls.
//
// Transport: stdio, JSON-RPC 2.0, NEWLINE-DELIMITED JSON (verified against
// the host's own MCP servers — no `Content-Length` framing).
//
// stdout carries the protocol. stderr carries diagnostics.
//
// RESULT SHAPE
//
// Every tool returns BOTH:
//   - a compact text summary, and
//   - `structuredContent` matching the tool's declared `outputSchema`.
//
// The host renders `structuredContent` into the text output as
// "[MCP structured content]\n{json}", so the text block deliberately carries
// only a SUMMARY — repeating the full payload there would double the token
// cost of every call.
//
// The host VALIDATES `structuredContent` against `outputSchema`: a missing or
// mismatched payload fails the call. Every tool therefore declares a schema
// and always returns a matching payload, on the error path too.

import {
  getFirefoxProvider,
  resetFirefoxProvider,
} from './lib/firefox/provider.js'
import {
  outputSchema,
  toStructured,
  summarize,
  summarizeCaptcha,
  prettyJson,
} from './lib/mcp/schema.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Firefox binary. Empty = auto-detect (see lib/firefox/launcher.js). */
const FIREFOX_BROWSER_BIN = process.env.FIREFOX_BROWSER_BIN || ''

/** Preferred BiDi port. Occupied ports are probed upward. */
const FIREFOX_BROWSER_PORT = Number(process.env.FIREFOX_BROWSER_PORT || 9333)

/** Headless by default. Set to 0 for a visible window (manual CAPTCHA / login). */
const FIREFOX_BROWSER_HEADLESS = process.env.FIREFOX_BROWSER_HEADLESS !== '0'

/** Source profile. Empty = auto-detect the user's active profile. */
const FIREFOX_BROWSER_PROFILE = process.env.FIREFOX_BROWSER_PROFILE || ''

/** Where the profile copy lives. Empty = the resolved default (see provider.js). */
const FIREFOX_BROWSER_PROFILE_COPY = process.env.FIREFOX_BROWSER_PROFILE_COPY || ''

/** Per-BiDi-command timeout. */
const FIREFOX_BROWSER_TIMEOUT_MS = Number(process.env.FIREFOX_BROWSER_TIMEOUT_MS || 30000)

/** How long to wait for Firefox's BiDi endpoint to come up. */
const FIREFOX_BROWSER_READY_TIMEOUT_MS = Number(
  process.env.FIREFOX_BROWSER_READY_TIMEOUT_MS || 30000,
)

/**
 * Privileged (chrome://) contexts.
 *
 * Off by default: the flag widens what the browser exposes to the driver
 * (about:preferences, about:addons, about:logins). Turn it on when the task
 * needs to read the real preferences or the extension list.
 */
const FIREFOX_BROWSER_PRIVILEGED = process.env.FIREFOX_BROWSER_PRIVILEGED === '1'

const provider = getFirefoxProvider({
  bin: FIREFOX_BROWSER_BIN || undefined,
  port: FIREFOX_BROWSER_PORT,
  headless: FIREFOX_BROWSER_HEADLESS,
  profileDir: FIREFOX_BROWSER_PROFILE || undefined,
  copyBaseDir: FIREFOX_BROWSER_PROFILE_COPY || undefined,
  timeoutMs: FIREFOX_BROWSER_TIMEOUT_MS,
  readyTimeoutMs: FIREFOX_BROWSER_READY_TIMEOUT_MS,
  privileged: FIREFOX_BROWSER_PRIVILEGED,
})

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

const SERVER_NAME = 'firefox-browser'
const SERVER_VERSION = '2.2.0'
const LATEST_PROTOCOL_VERSION = '2025-11-25'
const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]

const INSTRUCTIONS = [
  'Drive a real Firefox over WebDriver BiDi.',
  'The browser starts on demand — there is no separate launch step.',
  'Clicks use real pointer events, so they work on sites that require trusted input.',
  'The browser reuses a copy of the user profile, so logged-in sites stay logged in.',
  '',
  'WORKFLOW: call browser_snapshot first to see the page as a list of elements with',
  'stable refs (role + name), then act on a ref. Guessing CSS selectors is',
  'unreliable; a ref is not. Refs expire when the page re-renders — if a tool',
  'reports that a ref is stale, take a fresh snapshot.',
  '',
  'EFFICIENCY: browser_batch runs several actions in one call, which is usually',
  'cheaper than one call per action. For a repeatable sequence, write a helper',
  'script under ~/.mavis/ff-workspace/ and run it with browser_run_script.',
  '',
  'Every action returns an `effect` block. `effect.verified` is honest: when it is',
  'false, nothing on the page observably changed, so the action probably did not',
  'take effect. If the effect carries a `dialog`, the page raised a JavaScript',
  'dialog — it was closed automatically, and the message is what it said.',
  '',
  'Actions that cannot be undone (submitting a form, downloading, uploading,',
  'posting account data, installing an extension, writing a cookie) are refused',
  'unless you pass confirm: true.',
  '',
  'FIREFOX-ONLY TOOLS: browser_context (isolated identities), browser_extension',
  '(install extensions), browser_cookie (HttpOnly cookies), browser_intercept',
  '(block requests). They need a recent Firefox — browser_status reports exactly',
  'what the running browser supports.',
  '',
  'WHICH BROWSER: default to this plugin’s Firefox — it runs the real Firefox',
  'and carries the user’s login state. Switch to the host’s in-app browser only',
  'when the user explicitly says "current browser" / "right-side browser" /',
  '"built-in browser". Use browser_handoff to move a page between the two;',
  'session state (logins, cookies, tabs) never travels with it.',
  '',
  'SCREENSHOTS: browser_screenshot returns an imageUrl. If the user is chatting',
  'in a web client, put that URL into your reply as a markdown image so they',
  'can see the picture. Never inline base64 image data.',
].join(' ')

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const CONTEXT_SCHEMA = {
  type: 'string',
  description:
    'Target browsing context. Omit to use the most recently focused tab.',
}

const REF_SCHEMA = {
  type: 'string',
  description:
    'Element ref from browser_snapshot. Preferred over a CSS selector; if both are given, the ref wins.',
}

const CONFIRM_SCHEMA = {
  type: 'boolean',
  description:
    'Required (true) for irreversible actions — form submit, download, upload, account change.',
}

/** Result schema shared by every tool. */
const BASE_SCHEMA = outputSchema()

/** Schema for tools that can be blocked by the confirmation gate. */
const GATE_SCHEMA = outputSchema({
  properties: {
    blocked: { type: 'boolean', description: 'True when the action was refused.' },
    action: { type: 'string', description: 'The irreversible action kind that was detected.' },
    requiresConfirm: { type: 'boolean', description: 'True when confirm: true is required.' },
  },
})

/** Schema for tools that resolve an element. */
const TARGET_SCHEMA = outputSchema({
  properties: {
    selector: { type: 'string', description: 'The CSS selector the ref resolved to.' },
    via: { type: 'string', description: 'Either "ref" or "selector".' },
  },
})

/** Schema for tools that report an action effect. */
const EFFECT_SCHEMA = outputSchema({
  properties: {
    effect: { type: 'object', description: 'Before/after comparison proving whether the action landed.' },
  },
})

const TOOLS = [
  {
    name: 'browser_start',
    description:
      'Start Firefox and open a WebDriver BiDi session. Copies the user profile so logged-in sites stay logged in. Idempotent — calling it again reuses the running instance.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: BASE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: () => provider.start(),
  },
  {
    name: 'browser_stop',
    description:
      'Stop the browser session. By default the Firefox process is terminated too; pass keep=true to leave the window open (a later browser_start re-adopts that instance).',
    inputSchema: {
      type: 'object',
      properties: {
        keep: {
          type: 'boolean',
          description: 'Leave the Firefox process running when the session ends.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: BASE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    run: (args) => provider.stop({ kill: args.keep !== true }),
  },
  {
    name: 'browser_status',
    description:
      'Report the browser instance state: lifecycle state, BiDi port, process id, session id, profile copy, buffered log and request counts — plus the capability matrix, the ref storage mode and the dialog policy. Read-only: it never starts a browser. While Firefox is idle the capability matrix is a version-based expectation (capabilities.probed = false); once Firefox runs, the same matrix is a live probe.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: BASE_SCHEMA,
    annotations: { readOnlyHint: true },
    run: async () => {
      // The status is a READ-only report: it must not start a browser just to
      // answer a question. When the browser is already running the matrix is
      // probed live; when it is idle the matrix is a version-based expectation
      // (clearly labelled as such), so the agent still learns what this
      // Firefox can do before it starts anything.
      if (provider.ready) await provider.probeCapabilities()
      return provider.status()
    },
  },
  {
    name: 'browser_tabs',
    description:
      'List the open tabs and iframes with their browsing context ids.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: BASE_SCHEMA,
    annotations: { readOnlyHint: true },
    run: () => provider.tabsStatus(),
  },
  {
    name: 'browser_new_tab',
    description: 'Open a new tab, optionally navigating it to a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open in the new tab.' },
      },
      additionalProperties: false,
    },
    outputSchema: BASE_SCHEMA,
    annotations: { readOnlyHint: false, idempotentHint: false },
    run: (args) => provider.newTab(args.url),
  },
  {
    name: 'browser_navigate',
    description:
      'Navigate a tab to a URL. Prefer this plugin’s Firefox unless the user ' +
      'explicitly asked for the in-app browser; use browser_handoff to move a ' +
      'page between them.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to. A missing scheme is filled in as https.' },
        contextId: CONTEXT_SCHEMA,
        wait: {
          type: 'string',
          description:
            'When to consider the navigation done: none (return immediately), ' +
            'interactive (DOM parsed, subresources may still load), or complete (default).',
          enum: ['none', 'interactive', 'complete'],
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    outputSchema: BASE_SCHEMA,
    annotations: { readOnlyHint: false, idempotentHint: false },
    run: (args) => provider.navigate(args.url, args.contextId, args.wait || 'complete'),
  },
  {
    name: 'browser_snapshot',
    description:
      'List the page\'s interactive elements with stable refs, roles and names. START HERE — take a snapshot, then act on a ref instead of guessing CSS selectors. Reaches into open shadow roots, and can include iframe contents.',
    inputSchema: {
      type: 'object',
      properties: {
        contextId: CONTEXT_SCHEMA,
        maxElements: {
          type: 'number',
          description: 'Maximum number of elements to return (default 300, max 5000).',
        },
        offset: {
          type: 'number',
          description: 'Skip this many elements — use it with the returned nextOffset to page.',
        },
        roleFilter: {
          type: 'array',
          description:
            'Only return these roles, e.g. ["button","link"]. Narrows the payload when the page is noisy.',
          items: { type: 'string' },
        },
        nameContains: {
          type: 'string',
          description: 'Only return elements whose accessible name contains this text.',
        },
        includeText: {
          type: 'boolean',
          description: 'Also return the visible text blocks of the page.',
        },
        frames: {
          type: 'string',
          enum: ['none', 'all'],
          description:
            '"all" also snapshots the contents of iframes. Their refs are prefixed with the frame id.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      properties: {
        elements: { type: 'array', description: 'The elements found, each with ref, role and name.' },
        snapshotId: { type: 'number', description: 'Increments with every snapshot.' },
        count: { type: 'number', description: 'Number of elements returned.' },
        total: { type: 'number', description: 'Number of elements found in total.' },
        truncated: { type: 'boolean', description: 'True when more elements exist than were returned.' },
        hasMore: { type: 'boolean', description: 'True when more elements can be fetched.' },
        nextOffset: { type: 'number', description: 'Offset to pass to fetch the next page.' },
        refMode: {
          type: 'string',
          description: '"registry" (refs live in the page, not the DOM) or "attribute" (fallback).',
        },
        frames: { type: 'array', description: 'Per-frame element lists, when frames:"all" was requested.' },
        texts: { type: 'array', description: 'Visible text blocks, when includeText was requested.' },
      },
    }),
    annotations: { readOnlyHint: true },
    run: (args) =>
      provider.snapshot(args.contextId, {
        maxElements: args.maxElements,
        offset: args.offset,
        roleFilter: args.roleFilter,
        nameContains: args.nameContains,
        includeText: args.includeText,
        frames: args.frames,
      }),
  },
  {
    name: 'browser_click',
    description:
      'Click an element using real pointer events (pointerMove → pointerDown → pointerUp), so sites that reject synthetic clicks still work. Target it by ref (preferred) or CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: REF_SCHEMA,
        selector: {
          type: 'string',
          description: 'CSS selector of the element to click.',
        },
        contextId: CONTEXT_SCHEMA,
        button: {
          type: 'number',
          description: 'Mouse button: 0 left (default), 1 middle, 2 right.',
        },
        clickCount: {
          type: 'number',
          description: 'Number of clicks — use 2 for a double click.',
        },
        confirm: CONFIRM_SCHEMA,
      },
      additionalProperties: false,
    },
    requiresOneOf: ['ref', 'selector'],
    outputSchema: GATE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run: (args) =>
      provider.click(args.selector, args.contextId, {
        ref: args.ref,
        confirm: args.confirm,
        button: args.button,
        clickCount: args.clickCount,
      }),
  },
  {
    name: 'browser_type',
    description:
      'Type text into an element: focuses it, then sends one key action per character so the page receives genuine keyboard events.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: REF_SCHEMA,
        selector: {
          type: 'string',
          description: 'CSS selector of the input element.',
        },
        text: { type: 'string', description: 'Text to type.' },
        contextId: CONTEXT_SCHEMA,
        clear: {
          type: 'boolean',
          description: 'Clear the field before typing.',
        },
        submit: {
          type: 'boolean',
          description: 'Press Enter after typing (may submit a form — needs confirm).',
        },
        confirm: CONFIRM_SCHEMA,
      },
      required: ['text'],
      additionalProperties: false,
    },
    requiresOneOf: ['ref', 'selector'],
    outputSchema: GATE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run: (args) =>
      provider.type(args.selector, args.text, args.contextId, {
        ref: args.ref,
        clear: args.clear,
        submit: args.submit,
        confirm: args.confirm,
      }),
  },
  {
    name: 'browser_press_key',
    description:
      'Press a key or shortcut in the focused element: Enter, Escape, Tab, Backspace, arrows, or a combination like "Ctrl+Enter".',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Key name or combination, e.g. "Enter", "Escape", "Ctrl+Enter".',
        },
        contextId: CONTEXT_SCHEMA,
      },
      required: ['key'],
      additionalProperties: false,
    },
    outputSchema: EFFECT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run: (args) => provider.pressKey(args.key, args.contextId),
  },
  {
    name: 'browser_select_option',
    description:
      'Choose an option in a <select> element, by value or by the option\'s visible text.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: REF_SCHEMA,
        selector: { type: 'string', description: 'CSS selector of the select element.' },
        value: { type: 'string', description: 'The option value, or its visible text.' },
        byText: {
          type: 'boolean',
          description: 'Match the visible text instead of the underlying value.',
        },
        contextId: CONTEXT_SCHEMA,
      },
      required: ['value'],
      additionalProperties: false,
    },
    requiresOneOf: ['ref', 'selector'],
    outputSchema: TARGET_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run: (args) =>
      provider.selectOption(args.selector, args.value, args.contextId, {
        ref: args.ref,
        byText: args.byText,
      }),
  },
  {
    name: 'browser_check',
    description: 'Check or uncheck a checkbox or radio button.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: REF_SCHEMA,
        selector: { type: 'string', description: 'CSS selector of the checkbox or radio.' },
        checked: {
          type: 'boolean',
          description: 'true to check, false to uncheck.',
        },
        contextId: CONTEXT_SCHEMA,
      },
      required: ['checked'],
      additionalProperties: false,
    },
    requiresOneOf: ['ref', 'selector'],
    outputSchema: TARGET_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: (args) =>
      provider.check(args.selector, args.checked, args.contextId, { ref: args.ref }),
  },
  {
    name: 'browser_hover',
    description:
      'Move the pointer over an element without clicking — for menus and tooltips that only appear on hover.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: REF_SCHEMA,
        selector: { type: 'string', description: 'CSS selector of the element to hover.' },
        contextId: CONTEXT_SCHEMA,
      },
      additionalProperties: false,
    },
    requiresOneOf: ['ref', 'selector'],
    outputSchema: TARGET_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: (args) => provider.hover(args.selector, args.contextId, { ref: args.ref }),
  },
  {
    name: 'browser_scroll',
    description:
      'Scroll the page, or bring an element into view. Use it when the target may be below the fold.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: REF_SCHEMA,
        selector: { type: 'string', description: 'CSS selector of the element to scroll into view.' },
        contextId: CONTEXT_SCHEMA,
        direction: {
          type: 'string',
          description: 'up, down, top or bottom (default down).',
          enum: ['up', 'down', 'top', 'bottom'],
        },
        amount: {
          type: 'number',
          description: 'Pixels to scroll for up/down (default 400).',
        },
      },
      additionalProperties: false,
    },
    outputSchema: BASE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: (args) =>
      provider.scroll(args.contextId, {
        ref: args.ref,
        selector: args.selector,
        direction: args.direction,
        amount: args.amount,
      }),
  },
  {
    name: 'browser_upload',
    description:
      'Attach local files to a file input. Requires confirm: true — it sends local data to the site.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: REF_SCHEMA,
        selector: { type: 'string', description: 'CSS selector of the file input.' },
        paths: {
          type: 'array',
          description: 'Absolute paths of the files to attach.',
          items: { type: 'string' },
        },
        contextId: CONTEXT_SCHEMA,
        confirm: CONFIRM_SCHEMA,
      },
      required: ['paths'],
      additionalProperties: false,
    },
    requiresOneOf: ['ref', 'selector'],
    outputSchema: GATE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    run: (args) =>
      provider.upload(args.selector, args.paths || [], args.contextId, {
        ref: args.ref,
        confirm: args.confirm,
      }),
  },
  {
    name: 'browser_wait_for',
    description:
      'Wait until a condition holds: an element appears, some text shows up, the page finishes loading, or the network goes quiet.',
    inputSchema: {
      type: 'object',
      properties: {
        for: {
          type: 'string',
          description: 'What to wait for: selector, text, load or networkIdle (default load).',
          enum: ['selector', 'text', 'load', 'networkIdle'],
        },
        selector: { type: 'string', description: 'Selector to wait for (with for=selector).' },
        text: { type: 'string', description: 'Text to wait for (with for=text).' },
        timeoutMs: {
          type: 'number',
          description: 'How long to wait before giving up (default 10000).',
        },
        contextId: CONTEXT_SCHEMA,
      },
      additionalProperties: false,
    },
    outputSchema: BASE_SCHEMA,
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: (args) =>
      provider.waitFor(args.contextId, {
        for: args.for || 'load',
        selector: args.selector,
        text: args.text,
        timeoutMs: args.timeoutMs,
      }),
  },
  {
    name: 'browser_network',
    description:
      'Inspect the requests the page made. Use it to find out why a page did not update — look at failed and 4xx/5xx requests.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'array',
          description: 'Status buckets to keep, e.g. ["4xx","5xx","error"].',
          items: { type: 'string' },
        },
        filter: {
          type: 'string',
          description: 'Keep only requests whose URL contains this substring.',
        },
        types: {
          type: 'array',
          description: 'Keep only these resource types, e.g. ["xhr","fetch","document"].',
          items: { type: 'string' },
        },
        afterSeq: {
          type: 'number',
          description: 'Only requests newer than this sequence number.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of requests to return (default 50).',
        },
        requestId: {
          type: 'string',
          description:
            'Also fetch the response body of this request. Needs Firefox 144+; on older versions the tool says so instead of failing.',
        },
        bodyType: {
          type: 'string',
          enum: ['text', 'base64'],
          description: 'How to encode the response body (default "text").',
        },
      },
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      properties: {
        requests: { type: 'array', description: 'The captured requests, with URLs stripped of query and fragment.' },
        count: { type: 'number', description: 'Number of requests returned.' },
        total: { type: 'number', description: 'Number of requests matching the filter.' },
        lastSequence: { type: 'number', description: 'Sequence number of the most recent request.' },
        body: { type: 'string', description: 'The response body, when one was requested.' },
        bodyAvailable: { type: 'boolean', description: 'True when the response body was fetched.' },
      },
    }),
    annotations: { readOnlyHint: true },
    run: (args) =>
      provider.network({
        status: args.status,
        filter: args.filter,
        types: args.types,
        afterSeq: args.afterSeq,
        limit: args.limit,
        requestId: args.requestId,
        bodyType: args.bodyType,
      }),
  },
  {
    name: 'browser_close_tab',
    description: 'Close a tab.',
    inputSchema: {
      type: 'object',
      properties: { contextId: CONTEXT_SCHEMA },
      additionalProperties: false,
    },
    outputSchema: BASE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    run: (args) => provider.closeTab(args.contextId),
  },
  {
    name: 'browser_handoff',
    description:
      "Move the current page between this plugin's Firefox and the host's in-app browser. " +
      'to="in-app" hands the current URL over for the in-app browser to open; ' +
      'to="firefox" navigates this Firefox to a URL you already read from the in-app browser. ' +
      'Prefer Firefox unless the user explicitly asked for the in-app browser.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          enum: ['in-app', 'firefox'],
          description: 'Which browser surface should end up with the page.',
        },
        url: {
          type: 'string',
          description:
            'Target URL. Optional for to="in-app" (defaults to the current page); ' +
            'required for to="firefox".',
        },
        contextId: CONTEXT_SCHEMA,
        carry: {
          type: 'string',
          enum: ['url', 'url+summary', 'none'],
          description: 'How much context to carry across (default "url").',
        },
      },
      required: ['to'],
      additionalProperties: false,
    },
    outputSchema: BASE_SCHEMA,
    annotations: { readOnlyHint: false, openWorldHint: false },
    run: (args) =>
      provider.handoff(args.to, {
        url: args.url,
        contextId: args.contextId,
        carry: args.carry,
      }),
  },
  {
    name: 'browser_text',
    description:
      'Read the visible text content of a page. Long pages are truncated — follow nextOffset to read more.',
    inputSchema: {
      type: 'object',
      properties: {
        contextId: CONTEXT_SCHEMA,
        maxChars: {
          type: 'number',
          description: 'Maximum characters to return (default 8000).',
        },
        offset: {
          type: 'number',
          description: 'Character offset to start reading from.',
        },
        selector: {
          type: 'string',
          description: 'Read only this element\'s text instead of the whole page.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      properties: {
        value: { type: 'string', description: 'The visible text.' },
        length: { type: 'number', description: 'Total length of the page text.' },
        truncated: { type: 'boolean', description: 'True when the text was cut.' },
        nextOffset: { type: 'number', description: 'Offset to pass to read the next chunk.' },
      },
    }),
    annotations: { readOnlyHint: true },
    run: (args) =>
      provider.text(args.contextId, {
        maxChars: args.maxChars,
        offset: args.offset,
        selector: args.selector,
      }),
  },
  {
    name: 'browser_evaluate',
    description:
      'Evaluate a JavaScript expression in the page and return its value. Executes arbitrary script in the page context.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'JavaScript expression to evaluate in the page.',
        },
        contextId: CONTEXT_SCHEMA,
      },
      required: ['expression'],
      additionalProperties: false,
    },
    outputSchema: BASE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: (args) => provider.evaluate(args.expression, args.contextId),
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture a PNG screenshot of the page and return it as an image. Optionally capture the full page or a single element.',
    inputSchema: {
      type: 'object',
      properties: {
        contextId: CONTEXT_SCHEMA,
        fullPage: {
          type: 'boolean',
          description: 'Capture the whole document instead of the viewport.',
        },
        elementRef: {
          type: 'string',
          description: 'Capture only the element with this snapshot ref.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: BASE_SCHEMA,
    annotations: { readOnlyHint: true },
    run: (args) =>
      provider.screenshot(args.contextId, {
        fullPage: args.fullPage,
        elementRef: args.elementRef,
      }),
  },
  {
    name: 'browser_logs',
    description:
      'Read the buffered browser logs. Three channels: "console" (the page\'s own output), "plugin" (what the plugin did) and "bidi" (a command Firefox refused).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'How many trailing entries to return (default 100).',
        },
        levels: {
          type: 'array',
          description: 'Keep only these levels, e.g. ["error","warn"].',
          items: { type: 'string' },
        },
        channel: {
          type: 'string',
          enum: ['console', 'plugin', 'bidi', 'all'],
          description: 'Keep only these channels (default "all").',
        },
        filter: {
          type: 'string',
          description: 'Keep only entries whose text contains this substring.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: BASE_SCHEMA,
    annotations: { readOnlyHint: true },
    run: (args) =>
      provider.consoleLogs(args.limit === undefined ? 100 : args.limit, {
        levels: args.levels,
        channel: args.channel,
        filter: args.filter,
      }),
  },
  {
    name: 'browser_handle_dialog',
    description:
      'Handle a JavaScript dialog (alert / confirm / prompt / beforeunload). Dialogs are closed automatically by default and reported in the previous action\'s effect; use this to accept, dismiss, or answer one explicitly.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['accept', 'dismiss', 'acceptWithText'],
          description: 'What to do with the dialog.',
        },
        text: {
          type: 'string',
          description: 'The text to enter, for action "acceptWithText".',
        },
        contextId: CONTEXT_SCHEMA,
      },
      required: ['action'],
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      properties: {
        handled: { type: 'string', description: 'The action that was applied.' },
        message: { type: 'string', description: 'The text the dialog was showing.' },
        type: { type: 'string', description: 'alert | confirm | prompt | beforeunload.' },
      },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: (args) =>
      provider.handleDialog({
        action: args.action,
        text: args.text,
        contextId: args.contextId,
      }),
  },
  {
    name: 'browser_context',
    description:
      'Manage Firefox containers — isolated identities with separate cookies, localStorage and cache. Use it to hold several accounts of the same site side by side, or to keep a task\'s login state from leaking into other work.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'select', 'remove'],
          description: 'What to do with the containers.',
        },
        userContext: {
          type: 'string',
          description: 'The container id, for "select" and "remove".',
        },
        label: {
          type: 'string',
          description: 'A human-readable name for a new container.',
        },
        url: {
          type: 'string',
          description: 'Open this URL in the selected container.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      properties: {
        userContexts: {
          type: 'array',
          description: 'The containers that exist.',
        },
        userContext: { type: 'string', description: 'The container that was created or selected.' },
        contextId: { type: 'string', description: 'The new tab inside the selected container.' },
      },
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: (args) =>
      provider.userContext({
        action: args.action,
        userContext: args.userContext,
        label: args.label,
        url: args.url,
      }),
  },
  {
    name: 'browser_extension',
    description:
      'Install, uninstall or list WebExtensions. Firefox 137+ only. Installing an extension can unblock a site (an ad blocker, a 2FA helper, a password manager) that the agent otherwise cannot work with.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['install', 'uninstall', 'list'],
          description: 'What to do with the extensions.',
        },
        path: {
          type: 'string',
          description: 'Path to an unpacked extension directory or an XPI file, for "install".',
        },
        extensionId: {
          type: 'string',
          description: 'The extension id, for "uninstall".',
        },
        permanent: {
          type: 'boolean',
          description:
            'Request a permanent install. Firefox 138+ installs extensions temporarily by default.',
        },
        confirm: CONFIRM_SCHEMA,
      },
      required: ['action'],
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      properties: {
        extensionId: { type: 'string', description: 'The id of the installed extension.' },
        installed: { type: 'boolean', description: 'True after a successful install.' },
        extensions: { type: 'array', description: 'The installed extensions, for "list".' },
      },
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: (args) =>
      provider.extension({
        action: args.action,
        path: args.path,
        extensionId: args.extensionId,
        permanent: args.permanent,
        confirm: args.confirm,
      }),
  },
  {
    name: 'browser_cookie',
    description:
      'Read or write cookies. Unlike document.cookie this reaches HttpOnly cookies. Firefox 124+ only.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set'],
          description: 'Read the cookies, or write one.',
        },
        filter: {
          type: 'object',
          description: 'Which cookies to read, e.g. {"domain":"example.com"}.',
          additionalProperties: true,
        },
        cookie: {
          type: 'object',
          description: 'The cookie to write, e.g. {"name":"sid","value":"x","domain":"example.com"}.',
          additionalProperties: true,
        },
        confirm: CONFIRM_SCHEMA,
      },
      required: ['action'],
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      properties: {
        cookies: { type: 'array', description: 'The cookies that were read.' },
        count: { type: 'number', description: 'How many cookies were returned.' },
      },
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: (args) =>
      provider.cookie({
        action: args.action,
        filter: args.filter,
        cookie: args.cookie,
        confirm: args.confirm,
      }),
  },
  {
    name: 'browser_intercept',
    description:
      'Block requests whose URL contains one of the given patterns (trackers, ads, a noisy API). Matching happens in the plugin, and every request is released again, so the page never freezes.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['block', 'clear'],
          description: 'Start blocking, or remove every intercept.',
        },
        patterns: {
          type: 'array',
          description: 'URL substrings to block, e.g. ["analytics.example.com"].',
          items: { type: 'string' },
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      properties: {
        interceptId: { type: 'string', description: 'The id of the installed intercept.' },
        active: { type: 'number', description: 'How many intercepts are active.' },
        patterns: { type: 'array', description: 'The patterns being blocked.' },
      },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: (args) =>
      provider.intercept({
        action: args.action,
        patterns: args.patterns,
      }),
  },
  {
    name: 'browser_detectability',
    description:
      'Report how detectable this session is. Read it before claiming a page cannot tell it is automated: Firefox sets navigator.webdriver whenever the Remote Agent runs, and no pref can turn that off.',
    inputSchema: {
      type: 'object',
      properties: {
        contextId: CONTEXT_SCHEMA,
      },
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      properties: {
        webdriver: { type: 'boolean', description: 'The value of navigator.webdriver.' },
        automationDetectable: {
          type: 'boolean',
          description: 'True when the page can tell it is automated.',
        },
        domRefAttributes: {
          type: 'number',
          description: 'Elements still carrying a plugin marker attribute (0 in registry mode).',
        },
        registryKeys: {
          type: 'number',
          description: 'Registry keys present on window. They are non-enumerable but discoverable.',
        },
        notes: { type: 'array', description: 'What this means, in plain words.' },
      },
    }),
    annotations: { readOnlyHint: true },
    run: (args) => provider.detectability(args.contextId),
  },
  {
    name: 'browser_captcha',
    description:
      'Solve a CAPTCHA on the current page: Turnstile, reCAPTCHA v2, hCaptcha, GeeTest sliders, proof-of-work widgets and the Baidu rotate-to-upright spin captcha. Detects the challenge first, then answers it, and reports success only when the site itself issued a token. A challenge that needs a service you have not configured comes back as a named error, never as a false success.',
    inputSchema: {
      type: 'object',
      properties: {
        contextId: CONTEXT_SCHEMA,
        solver: {
          type: 'string',
          enum: ['auto', 'turnstile', 'recaptcha', 'hcaptcha', 'geetest', 'pow', 'spin'],
          description:
            'Which challenge to solve. "auto" (default) detects what is on the page and tries the matching solver.',
        },
        sttUrl: {
          type: 'string',
          description:
            'A Whisper-compatible speech-to-text endpoint, for audio challenges (reCAPTCHA/hCaptcha). No model is bundled: point this at e.g. http://127.0.0.1:8000. Without it, audio challenges report stt_unavailable.',
        },
        visionUrl: {
          type: 'string',
          description:
            'An image-recognition endpoint, for image-grid challenges. No vision model is bundled. Without it, image grids report vision_unavailable.',
        },
        timeoutMs: {
          type: 'number',
          description: 'How long to spend on the challenge (default 60000).',
        },
      },
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      properties: {
        ok: { type: 'boolean', description: 'True only when the site issued a token.' },
        status: {
          type: 'string',
          description:
            'Why it ended: solved, not_detected, checkbox_not_found, no_token, wrong_answer, vision_unavailable, stt_unavailable, solve_failed, and so on.',
        },
        solver: { type: 'string', description: 'Which solver handled it.' },
        tokenLength: { type: 'number', description: 'Length of the token the site issued.' },
        detected: { type: 'array', description: 'The challenge kinds that were found on the page.' },
        attempts: { type: 'array', description: 'Per-challenge outcome when solver is "auto".' },
        message: { type: 'string', description: 'A plain-language explanation of what happened.' },
        notes: { type: 'array', description: 'Caveats worth knowing about the result.' },
      },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: (args) =>
      provider.captcha(args.contextId, {
        solver: args.solver,
        sttUrl: args.sttUrl,
        visionUrl: args.visionUrl,
        timeoutMs: args.timeoutMs,
      }),
  },
  {
    name: 'browser_captcha_status',
    description:
      'Report whether a CAPTCHA on the current page is already solved, by reading the token the site would use. Read-only: it never clicks or types.',
    inputSchema: {
      type: 'object',
      properties: {
        contextId: CONTEXT_SCHEMA,
        kind: {
          type: 'string',
          enum: ['turnstile', 'recaptcha', 'hcaptcha', 'geetest', 'pow', 'spin'],
          description: 'Which challenge to check.',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      properties: {
        solved: { type: 'boolean', description: 'True when the site has issued a token.' },
        tokenLength: { type: 'number', description: 'Length of the token the site issued.' },
        contextId: { type: 'string' },
      },
    }),
    annotations: { readOnlyHint: true },
    run: (args) => provider.captchaStatus(args.contextId, { kind: args.kind }),
  },
  {
    name: 'browser_batch',
    description:
      'Run several actions in one call — click, type, press a key, wait, snapshot. Fewer round trips means less context and less latency. Stops at the first failure and reports exactly how far it got.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description:
            'The steps to run, in order. Each step has an "action" plus that action\'s arguments.',
          items: { type: 'object', additionalProperties: true },
        },
        contextId: CONTEXT_SCHEMA,
        stopOnError: {
          type: 'boolean',
          description: 'Stop at the first failing step (default true). Steps already run are not undone.',
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      properties: {
        steps: { type: 'array', description: 'One entry per step that ran, with its result.' },
        completed: { type: 'number', description: 'How many steps succeeded.' },
        failedAt: { type: 'number', description: 'The index of the step that failed.' },
      },
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: (args) =>
      provider.batch(args.steps, {
        contextId: args.contextId,
        stopOnError: args.stopOnError,
      }),
  },
  {
    name: 'browser_run_script',
    description:
      'Run a JavaScript file in the page. Write a helper for something you keep repeating, save it under ~/.mavis/ff-workspace/, and reuse it on the next task instead of rediscovering the page each time.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the script. Must be inside ~/.mavis/ff-workspace/.',
        },
        args: {
          type: 'object',
          description: 'Passed to the script as its "args" argument.',
          additionalProperties: true,
        },
        contextId: CONTEXT_SCHEMA,
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      properties: {
        result: { description: 'Whatever the script returned.' },
        path: { type: 'string', description: 'The script that was run.' },
      },
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: (args) =>
      provider.runScript(args.path, {
        args: args.args,
        contextId: args.contextId,
      }),
  },
  {
    name: 'browser_config',
    description:
      'Read or change the plugin\'s behaviour: the tool preset, how JavaScript dialogs are handled, and the default snapshot size.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: {
          type: 'string',
          enum: ['slim', 'basic', 'developer', 'all'],
          description: 'Which tools the task actually needs.',
        },
        dialogPolicy: {
          type: 'string',
          enum: ['autoDismiss', 'autoAccept', 'manual'],
          description:
            'autoDismiss (default) closes dialogs so the agent never hangs; manual leaves them open for browser_handle_dialog.',
        },
        maxSnapshotElements: {
          type: 'number',
          description: 'Default number of elements per snapshot (max 5000).',
        },
      },
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      properties: {
        preset: { type: 'string', description: 'The active preset.' },
        dialogPolicy: { type: 'string', description: 'The active dialog policy.' },
        maxSnapshotElements: { type: 'number', description: 'The default snapshot size.' },
        effectiveTools: { type: 'array', description: 'The tools this preset recommends.' },
        notes: { type: 'array', description: 'What the preset means.' },
      },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: (args) =>
      provider.config({
        preset: args.preset,
        dialogPolicy: args.dialogPolicy,
        maxSnapshotElements: args.maxSnapshotElements,
      }),
  },
]

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/**
 * The twelve tools that existed before this version.
 *
 * They keep their ORIGINAL text contract: the text block carries the
 * pretty-printed JSON payload, exactly as before. Existing callers parse
 * that text, so changing it would be a breaking change — and the plugin's
 * own test suite depends on it.
 *
 * The newly added tools use the newer contract instead: a compact summary
 * in the text block plus the full payload in `structuredContent`.
 *
 * `legacy: true` therefore means "keep the old text shape", not "no
 * structured output" — the original tools still return `structuredContent`
 * too, so a caller can migrate to it at its own pace.
 */
const LEGACY_TOOLS = new Set([
  'browser_start',
  'browser_stop',
  'browser_tabs',
  'browser_new_tab',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_text',
  'browser_evaluate',
  'browser_screenshot',
  'browser_logs',
])

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } })
}

/**
 * Validate the call arguments against the tool's input schema.
 *
 * Only the subset that matters here is enforced: required properties present,
 * and property types matching. Unknown properties are rejected too — a typo in
 * an argument name should fail loudly rather than silently do nothing.
 *
 * `requiresOneOf` handles the dual addressing: an element may be named by a
 * snapshot `ref` OR by a CSS `selector`, so neither can be "required" in the
 * JSON Schema — but one of them must be present.
 *
 * @returns {string|null} an error message, or null when the args are valid
 */
function validateArgs(tool, args) {
  const schema = tool.inputSchema || {}
  const props = schema.properties || {}
  const value = args && typeof args === 'object' ? args : {}

  for (const key of schema.required || []) {
    if (value[key] === undefined || value[key] === null || value[key] === '') {
      return `missing required argument "${key}" for tool "${tool.name}"`
    }
  }

  if (tool.requiresOneOf) {
    const provided = tool.requiresOneOf.some(
      (key) => value[key] !== undefined && value[key] !== null && value[key] !== '',
    )
    if (!provided) {
      const names = tool.requiresOneOf.map((k) => `"${k}"`).join(' or ')
      return `missing required argument ${names} for tool "${tool.name}"`
    }
  }

  for (const [key, raw] of Object.entries(value)) {
    const spec = props[key]
    if (!spec) {
      return `unknown argument "${key}" for tool "${tool.name}"`
    }
    if (raw === undefined || raw === null) continue
    if (spec.type === 'string' && typeof raw !== 'string') {
      return `argument "${key}" of tool "${tool.name}" must be a string`
    }
    if (spec.type === 'number' && typeof raw !== 'number') {
      return `argument "${key}" of tool "${tool.name}" must be a number`
    }
    if (spec.type === 'boolean' && typeof raw !== 'boolean') {
      return `argument "${key}" of tool "${tool.name}" must be a boolean`
    }
    if (spec.type === 'array' && !Array.isArray(raw)) {
      return `argument "${key}" of tool "${tool.name}" must be an array`
    }
    if (spec.enum && !spec.enum.includes(raw)) {
      return `argument "${key}" of tool "${tool.name}" must be one of: ${spec.enum.join(', ')}`
    }
  }
  return null
}

/**
 * Render the status as one screenful of answers.
 *
 * The status carries the capability matrix, the ref mode, the dialog policy
 * and the session counters — a payload far too long to dump as text. The
 * summary answers the four questions an agent actually has: which Firefox is
 * this, what can it do, how are refs stored, is anything pending.
 *
 * @param {object} status
 * @returns {string}
 */
function summarizeStatus(status) {
  const bits = []
  bits.push(`state ${status.state || 'unknown'}`)
  if (status.bin) bits.push(`firefox ${status.bin}`)
  if (status.port) bits.push(`port ${status.port}`)
  if (status.refMode) bits.push(`refs ${status.refMode}`)
  if (status.dialogPolicy) bits.push(`dialogs ${status.dialogPolicy}`)
  if (status.pendingDialogs) bits.push(`${status.pendingDialogs} dialog open`)
  const caps = status.capabilities
  if (caps && caps.features) {
    const names = Object.keys(caps.features)
    const on = names.filter((name) => caps.features[name])
    // "expected" means the browser was not running, so the matrix comes from
    // the version gates instead of a live probe.
    bits.push(`capabilities ${on.length}/${names.length}${caps.probed ? '' : ' (expected)'}`)
    if (caps.browserVersion) bits.push(`browser ${caps.browserVersion}`)
  }
  if (status.snapshotSeq) bits.push(`snapshot #${status.snapshotSeq}`)
  if (status.networkCount) bits.push(`${status.networkCount} requests`)
  return bits.join(' · ')
}

/**
 * Turn a provider result into an MCP tool result.
 *
 * Provider methods never throw — they return `{ok:false, error}` on failure —
 * so the error text is taken straight from the provider's message.
 *
 * The result carries BOTH a text block and the full structured payload.
 *
 * The twelve original tools keep their original text shape — the
 * pretty-printed JSON payload — because existing callers parse that text
 * and changing it would be a breaking change. The tools added in this
 * version use a compact summary in the text block instead, so the payload
 * is not stated twice (the host renders `structuredContent` into the text
 * output as well).
 *
 * `browser_status` left the legacy set in 2.0: its payload grew to include
 * the capability matrix, and a status dump is exactly the kind of thing that
 * belongs in `structuredContent` rather than in the text.
 */
function toToolResult(result, tool) {
  const structured = toStructured(result)
  const isError = structured.ok === false
  const isLegacy = tool ? LEGACY_TOOLS.has(tool.name) : false

  // A screenshot is delivered as an MCP image content block so the model
  // receives an actual image rather than an opaque base64 blob.
  if (tool && tool.name === 'browser_screenshot' && !isError) {
    const data = structured.data
    if (typeof data !== 'string' || !data) {
      return errorResult('screenshot produced no image data', tool)
    }
    // The image URL lets a chat client (the webui renders markdown) show the
    // picture to the user, while the image bytes stay out of the model's
    // context — only the short URL travels through the reply.
    const extra = {}
    if (structured.imageUrl) extra.imageUrl = structured.imageUrl
    if (structured.imageUrlError) extra.imageUrlError = structured.imageUrlError
    const hint = structured.imageUrl
      ? 'Paste imageUrl into your reply as a markdown image so the user can see the screenshot.'
      : undefined

    const legacyPayload = {
      ok: true,
      contextId: structured.contextId,
      mimeType: structured.mimeType || 'image/png',
      encoding: 'base64',
      bytes: data.length,
      fullPage: !!structured.fullPage,
      ...extra,
    }
    if (hint) legacyPayload.hint = hint

    return {
      content: [
        { type: 'image', data, mimeType: structured.mimeType || 'image/png' },
        {
          type: 'text',
          text: isLegacy
            ? prettyJson(legacyPayload)
            : summarize(structured, {
                summary:
                  `screenshot captured (${structured.fullPage ? 'full page' : 'viewport'}, ${data.length} base64 chars)` +
                  (structured.imageUrl ? ` — image url: ${structured.imageUrl}` : ''),
              }),
        },
      ],
      structuredContent: {
        ok: true,
        contextId: structured.contextId,
        mimeType: structured.mimeType || 'image/png',
        encoding: 'base64',
        bytes: data.length,
        fullPage: !!structured.fullPage,
        ...extra,
      },
      isError: false,
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: isLegacy
          ? prettyJson(structured)
          : tool && (tool.name === 'browser_captcha' || tool.name === 'browser_captcha_status')
            ? summarizeCaptcha(structured)
            : tool && tool.name === 'browser_status'
              ? summarizeStatus(structured)
              : summarize(structured),
      },
    ],
    structuredContent: structured,
    isError,
  }
}

function errorResult(text, tool) {
  return {
    content: [{ type: 'text', text }],
    structuredContent: { ok: false, error: text },
    isError: true,
  }
}

async function callTool(name, args) {
  const tool = TOOLS_BY_NAME.get(name)
  if (!tool) {
    return errorResult(`unknown tool "${name}"`, null)
  }
  const invalid = validateArgs(tool, args)
  if (invalid) return errorResult(invalid, tool)

  let result
  try {
    result = await tool.run(args || {})
  } catch (e) {
    return errorResult(`tool "${name}" failed: ${e && e.message ? e.message : String(e)}`, tool)
  }

  return toToolResult(result, tool)
}

async function handleMessage(message) {
  const { id, method, params } = message

  // Notifications carry no id and get no reply.
  if (id === undefined || id === null) {
    if (method === 'notifications/cancelled') {
      log(`cancelled: ${params && params.requestId}`)
    }
    return
  }

  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION
      reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      })
      return
    }
    case 'ping':
      reply(id, {})
      return
    case 'tools/list':
      reply(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema,
          annotations: t.annotations,
        })),
      })
      return
    case 'tools/call': {
      const name = params && params.name
      const args = params && params.arguments
      reply(id, await callTool(name, args))
      return
    }
    default:
      replyError(id, -32601, `method not found: ${method}`)
  }
}

// ---------------------------------------------------------------------------
// stdin loop
// ---------------------------------------------------------------------------

function log(message) {
  process.stderr.write(`[firefox-browser] ${message}\n`)
}

let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch (e) {
      log(`ignoring unparseable line: ${e.message}`)
      continue
    }
    Promise.resolve(handleMessage(message)).catch((err) => {
      log(`handler error: ${err && err.stack ? err.stack : err}`)
    })
  }
})

process.stdin.on('end', () => {
  shutdown('stdin closed')
})

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false

async function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutting down (${reason})`)
  try {
    await provider.stop()
  } catch (e) {
    log(`stop failed: ${e && e.message ? e.message : e}`)
  }
  resetFirefoxProvider()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Last-resort net: if the process dies without a signal, take the browser
// with it rather than leaving an orphaned headless Firefox behind.
process.on('exit', () => {
  try {
    provider.killNow()
  } catch {
    // Nothing more we can do at exit time.
  }
})

log(
  `ready — firefox=${FIREFOX_BROWSER_BIN || '(auto)'} port=${FIREFOX_BROWSER_PORT} ` +
    `headless=${FIREFOX_BROWSER_HEADLESS} tools=${TOOLS.length}`,
)
