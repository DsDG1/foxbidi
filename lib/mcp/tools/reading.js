// lib/mcp/tools/reading.js
// Reading the page: snapshots, text, evaluation, screenshots, logs and network.
//
// The tool objects below are copied VERBATIM from the previous single TOOLS
// array in server.js — name, description, inputSchema, outputSchema,
// annotations and the `run` body are byte-identical, so the MCP contract the
// host already relies on does not change.
//
// EXCEPT FOR THE DESCRIPTIONS, which were trimmed in v2.3.0. Every tool
// definition is injected into the model's context on every turn, so the
// prose was cut to one short clause each and the long-form explanation moved
// to skills/firefox-browser/SKILL.md, which is read on demand.

/**
 * Build the reading tools.
 *
 * @param ctx the server context
 * @returns the tool definitions, in list order
 */
import { outputSchema } from '../schema.js'
import { BASE_SCHEMA, CONTEXT_SCHEMA, CONFIRM_SCHEMA, INCLUDE_SNAPSHOT_SCHEMA } from './schemas.js'

/**
 * @param {{provider: Record<string, any>}} ctx
 */
export function createReadingTools(ctx) {
  const { provider } = ctx
  return [
    {
      name: 'browser_navigate',
      capability: 'core',
      description: 'Navigate tab to URL. Default to this Firefox over host in-app browser.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Target URL (missing scheme -> https).',
          },
          contextId: CONTEXT_SCHEMA,
          wait: {
            type: 'string',
            description: 'Wait until: none, interactive, complete (default).',
            enum: ['none', 'interactive', 'complete'],
          },
          includeSnapshot: INCLUDE_SNAPSHOT_SCHEMA,
        },
        required: ['url'],
        additionalProperties: false,
      },
      outputSchema: BASE_SCHEMA,
      annotations: { readOnlyHint: false, idempotentHint: false },
      run: (args) =>
        provider.navigate(args.url, args.contextId, args.wait || 'complete', {
          includeSnapshot: args.includeSnapshot,
        }),
    },
    {
      name: 'browser_set_viewport',
      capability: 'core',
      description: 'Override tab viewport size (Firefox 117+).',
      inputSchema: {
        type: 'object',
        properties: {
          width: { type: 'number', description: 'Width in CSS px.' },
          height: { type: 'number', description: 'Height in CSS px.' },
          devicePixelRatio: { type: 'number', description: 'DPR (default 1).' },
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
      capability: 'core',
      description:
        'Observe interactive elements with stable refs, roles and names. Prefer format="compact".',
      inputSchema: {
        type: 'object',
        properties: {
          contextId: CONTEXT_SCHEMA,
          format: {
            type: 'string',
            enum: ['records', 'compact'],
            description: 'compact (~70% smaller tree) or records.',
          },
          maxElements: {
            type: 'number',
            description: 'Max elements (default 300).',
          },
          offset: {
            type: 'number',
            description: 'Skip element count.',
          },
          roleFilter: {
            type: 'array',
            description: 'Role allowlist, e.g. ["button","link"].',
            items: { type: 'string' },
          },
          nameContains: {
            type: 'string',
            description: 'Substring match on accessible name.',
          },
          includeText: {
            type: 'boolean',
            description: 'Also return visible text.',
          },
          frames: {
            type: 'string',
            enum: ['none', 'all'],
            description: '"all" includes iframes.',
          },
          since: {
            type: 'number',
            description: 'Diff against snapshotId.',
          },
          deltaOnly: {
            type: 'boolean',
            description: 'With since, return only delta.',
          },
        },
        additionalProperties: false,
      },
      outputSchema: outputSchema({
        properties: {
          elements: { type: 'array' },
          tree: { type: 'string' },
          unchanged: { type: 'boolean' },
          snapshotId: { type: 'number' },
          count: { type: 'number' },
          total: { type: 'number' },
          truncated: { type: 'boolean' },
          hasMore: { type: 'boolean' },
          nextOffset: { type: 'number' },
          refMode: { type: 'string' },
          frames: { type: 'array' },
          texts: {
            type: 'array',
            items: { type: 'string' },
          },
          delta: {
            type: 'object',
            properties: {
              since: { type: 'number' },
              added: { type: 'array' },
              changed: { type: 'array' },
              removed: { type: 'array' },
            },
          },
        },
      }),
      annotations: { readOnlyHint: true },
      run: (args) =>
        provider.snapshot(args.contextId, {
          format: args.format,
          maxElements: args.maxElements,
          offset: args.offset,
          roleFilter: args.roleFilter,
          nameContains: args.nameContains,
          includeText: args.includeText,
          frames: args.frames,
          since: args.since,
          deltaOnly: args.deltaOnly,
        }),
    },
    {
      name: 'browser_text',
      capability: 'core',
      description: 'Read the visible text of a page. Long pages are truncated — follow nextOffset.',
      inputSchema: {
        type: 'object',
        properties: {
          contextId: CONTEXT_SCHEMA,
          maxChars: {
            type: 'number',
            description: 'Max characters to return (default 8000).',
          },
          offset: {
            type: 'number',
            description: 'Character offset to start reading from.',
          },
          selector: {
            type: 'string',
            description: "Read only this element's text.",
          },
        },
        additionalProperties: false,
      },
      outputSchema: outputSchema({
        properties: {
          value: { type: 'string' },
          length: { type: 'number' },
          truncated: { type: 'boolean' },
          nextOffset: { type: 'number' },
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
      capability: 'core',
      description: 'Evaluate a JavaScript expression in the page and return its value.',
      inputSchema: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'JavaScript expression to evaluate in the page.',
          },
          contextId: CONTEXT_SCHEMA,
          confirm: CONFIRM_SCHEMA,
        },
        required: ['expression'],
        additionalProperties: false,
      },
      outputSchema: BASE_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: true },
      run: (args) => provider.evaluate(args.expression, args.contextId, { confirm: args.confirm }),
    },
    {
      name: 'browser_screenshot',
      capability: 'core',
      description: 'Capture a PNG screenshot of the page, the full document or a single element.',
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
      capability: 'logs',
      description:
        'Read the buffered logs: "console" (page output), "plugin", "bidi" (a refused command).',
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
            description: 'Keep entries containing this text.',
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
      capability: 'core',
      description: 'Inspect the requests the page made — use it to find why a page did not update.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'array',
            description: 'Status buckets to keep.',
            items: { type: 'string' },
          },
          filter: {
            type: 'string',
            description: 'Keep requests whose URL contains this.',
          },
          types: {
            type: 'array',
            description: 'Keep these resource types.',
            items: { type: 'string' },
          },
          afterSeq: {
            type: 'number',
            description: 'Only requests newer than this sequence number.',
          },
          limit: {
            type: 'number',
            description: 'Max requests to return (default 50).',
          },
          requestId: {
            type: 'string',
            description: 'Fetch this response body. Firefox 144+.',
          },
          bodyType: {
            type: 'string',
            enum: ['text', 'base64'],
            description: 'How to encode the response body (default "text").',
          },
          revealBody: {
            type: 'boolean',
            description: 'Return the response body verbatim, without secret redaction.',
          },
        },
        additionalProperties: false,
      },
      outputSchema: outputSchema({
        properties: {
          requests: {
            type: 'array',
            description: 'The captured requests, with query and fragment stripped.',
          },
          count: { type: 'number' },
          total: { type: 'number' },
          lastSequence: { type: 'number' },
          body: { type: 'string' },
          bodyAvailable: { type: 'boolean' },
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
          revealBody: args.revealBody,
        }),
    },
  ]
}
