// lib/mcp/tools/reading.js
// Reading the page: snapshots, text, evaluation, screenshots, logs and network.
//
// The tool objects below are copied VERBATIM from the previous single TOOLS
// array in server.js — name, description, inputSchema, outputSchema,
// annotations and the `run` body are byte-identical, so the MCP contract the
// host already relies on does not change.

/**
 * Build the reading tools.
 *
 * @param ctx the server context
 * @returns the tool definitions, in list order
 */
import { outputSchema } from '../schema.js'
import { BASE_SCHEMA, CONTEXT_SCHEMA, CONFIRM_SCHEMA } from './schemas.js'

export function createReadingTools(ctx) {
  const { provider } = ctx
  return [
    {
      name: 'browser_navigate',
      description:
        'Navigate a tab to a URL. Prefer this plugin’s Firefox unless the user ' +
        'explicitly asked for the in-app browser; use browser_handoff to move a ' +
        'page between them.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL to navigate to. A missing scheme is filled in as https.',
          },
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
      name: 'browser_set_viewport',
      description:
        'Override the tab viewport to test a responsive layout without resizing the window. Firefox 117+.',
      inputSchema: {
        type: 'object',
        properties: {
          width: { type: 'number', description: 'Viewport width in CSS pixels.' },
          height: { type: 'number', description: 'Viewport height in CSS pixels.' },
          devicePixelRatio: { type: 'number', description: 'Device pixel ratio (default 1).' },
          contextId: CONTEXT_SCHEMA,
          confirm: CONFIRM_SCHEMA,
        },
        required: ['width', 'height'],
        additionalProperties: false,
      },
      outputSchema: BASE_SCHEMA,
      annotations: { readOnlyHint: false, idempotentHint: true },
      run: (args) =>
        provider.setViewport(
          {
            width: args.width,
            height: args.height,
            devicePixelRatio: args.devicePixelRatio,
          },
          args.contextId,
          args.confirm,
        ),
    },
    {
      name: 'browser_snapshot',
      description:
        "List the page's interactive elements with stable refs, roles and names. START HERE — take a snapshot, then act on a ref instead of guessing CSS selectors. Reaches into open shadow roots, and can include iframe contents.",
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
          elements: {
            type: 'array',
            description: 'The elements found, each with ref, role and name.',
          },
          snapshotId: { type: 'number', description: 'Increments with every snapshot.' },
          count: { type: 'number', description: 'Number of elements returned.' },
          total: { type: 'number', description: 'Number of elements found in total.' },
          truncated: {
            type: 'boolean',
            description: 'True when more elements exist than were returned.',
          },
          hasMore: { type: 'boolean', description: 'True when more elements can be fetched.' },
          nextOffset: { type: 'number', description: 'Offset to pass to fetch the next page.' },
          refMode: {
            type: 'string',
            description:
              '"registry" (refs live in the page, not the DOM) or "attribute" (fallback).',
          },
          frames: {
            type: 'array',
            description: 'Per-frame element lists, when frames:"all" was requested.',
          },
          texts: {
            type: 'array',
            description: 'Visible text blocks, when includeText was requested.',
          },
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
            description: "Read only this element's text instead of the whole page.",
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
          requests: {
            type: 'array',
            description: 'The captured requests, with URLs stripped of query and fragment.',
          },
          count: { type: 'number', description: 'Number of requests returned.' },
          total: { type: 'number', description: 'Number of requests matching the filter.' },
          lastSequence: {
            type: 'number',
            description: 'Sequence number of the most recent request.',
          },
          body: { type: 'string', description: 'The response body, when one was requested.' },
          bodyAvailable: {
            type: 'boolean',
            description: 'True when the response body was fetched.',
          },
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
  ]
}
