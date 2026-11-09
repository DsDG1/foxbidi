// lib/mcp/tools/lifecycle.js
// Browser lifecycle: starting, stopping, inspecting and configuring the instance.
//
// The tool objects below are copied VERBATIM from the previous single TOOLS
// array in server.js — name, description, inputSchema, outputSchema,
// annotations and the `run` body are byte-identical, so the MCP contract the
// host already relies on does not change.

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
      name: 'browser_config',
      description:
        "Read or change the plugin's behaviour: the tool preset, how JavaScript dialogs are handled, and the default snapshot size.",
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
}
