// lib/mcp/tools/lifecycle.js
// Browser lifecycle: starting, stopping, inspecting and configuring the instance.
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
 * Build the lifecycle tools.
 *
 * @param ctx the server context
 * @returns the tool definitions, in list order
 */
import { outputSchema } from '../schema.js'
import { BASE_SCHEMA, CONTEXT_SCHEMA } from './schemas.js'

export function createLifecycleTools(ctx) {
  const { provider } = ctx
  return [
    {
      name: 'browser_start',
      description:
        'Start Firefox and open a WebDriver BiDi session. Idempotent — a second call reuses the running instance.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: BASE_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      run: () => provider.start(),
    },
    {
      name: 'browser_stop',
      description:
        'Stop the browser session. keep=true leaves the Firefox process running for a later browser_start.',
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
        'Report the browser state: lifecycle, BiDi port, session, capabilities matrix, ref mode, dialog policy.',
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
      description: 'List the open tabs and iframes with their browsing context ids.',
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
      name: 'browser_back',
      description: 'Go back one entry in the tab history. Firefox 122+.',
      inputSchema: {
        type: 'object',
        properties: { contextId: CONTEXT_SCHEMA },
        additionalProperties: false,
      },
      outputSchema: BASE_SCHEMA,
      annotations: { readOnlyHint: false, idempotentHint: false },
      run: (args) => provider.back(args.contextId),
    },
    {
      name: 'browser_forward',
      description: 'Go forward one entry in the tab history. Firefox 122+.',
      inputSchema: {
        type: 'object',
        properties: { contextId: CONTEXT_SCHEMA },
        additionalProperties: false,
      },
      outputSchema: BASE_SCHEMA,
      annotations: { readOnlyHint: false, idempotentHint: false },
      run: (args) => provider.forward(args.contextId),
    },
    {
      name: 'browser_reload',
      description: 'Reload the current tab. Firefox 119+.',
      inputSchema: {
        type: 'object',
        properties: { contextId: CONTEXT_SCHEMA },
        additionalProperties: false,
      },
      outputSchema: BASE_SCHEMA,
      annotations: { readOnlyHint: false, idempotentHint: true },
      run: (args) => provider.reload(args.contextId),
    },
    {
      name: 'browser_config',
      description:
        'Read or change the plugin behaviour: tool preset, dialog policy, default snapshot size.',
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
            description: 'How JavaScript dialogs are handled (default autoDismiss).',
          },
          maxSnapshotElements: {
            type: 'number',
          },
        },
        additionalProperties: false,
      },
      outputSchema: outputSchema({
        properties: {
          preset: { type: 'string' },
          dialogPolicy: { type: 'string' },
          maxSnapshotElements: { type: 'number' },
          effectiveTools: { type: 'array' },
          notes: { type: 'array' },
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
}
