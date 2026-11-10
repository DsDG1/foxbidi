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
      capability: 'core',
      description:
        'Start Firefox and open a WebDriver BiDi session. Idempotent — a second call reuses the running instance.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: BASE_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      run: () => provider.start(),
    },
    {
      name: 'browser_stop',
      capability: 'core',
      description:
        'Stop the browser session. keep=true leaves the Firefox process running for a later browser_start.',
      inputSchema: {
        type: 'object',
        properties: {
          keep: {
            type: 'boolean',
            description: 'Leave the Firefox process running.',
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
      capability: 'core',
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
      capability: 'core',
      description: 'List the open tabs and iframes with their browsing context ids.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: BASE_SCHEMA,
      annotations: { readOnlyHint: true },
      run: () => provider.tabsStatus(),
    },
    {
      name: 'browser_new_tab',
      capability: 'input',
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
      capability: 'input',
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
      capability: 'core',
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
      capability: 'core',
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
      capability: 'core',
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
      capability: 'core',
      description:
        'Read or change the plugin behaviour: tool preset, dialog policy, snapshot size, command timeout, Firefox preferences.',
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
            description: 'How JS dialogs are handled (default autoDismiss).',
          },
          maxSnapshotElements: {
            type: 'number',
          },
          inlineSnapshot: {
            type: 'boolean',
            description: 'Page elements after each action (default true).',
          },
          timeoutMs: {
            type: 'number',
            description: 'Command timeout in ms.',
          },
          prefs: {
            type: 'object',
            description: 'Firefox preferences to set.',
            additionalProperties: true,
          },
          applyNow: {
            type: 'boolean',
            description: 'Also set them in the running browser.',
          },
          restart: {
            type: 'boolean',
            description: 'Restart Firefox afterwards.',
          },
        },
        additionalProperties: false,
      },
      outputSchema: outputSchema({
        properties: {
          preset: { type: 'string' },
          dialogPolicy: { type: 'string' },
          maxSnapshotElements: { type: 'number' },
          inlineSnapshot: { type: 'boolean' },
          timeoutMs: { type: 'number' },
          effectiveTools: { type: 'array' },
          notes: { type: 'array' },
          prefs: { type: 'object' },
          applied: { type: 'array' },
          appliedNow: { type: 'array' },
          pendingRestart: { type: 'array' },
          failed: { type: 'array' },
          restarted: { type: 'boolean' },
        },
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: async (args) => {
        const result = await provider.config({
          preset: args.preset,
          dialogPolicy: args.dialogPolicy,
          maxSnapshotElements: args.maxSnapshotElements,
          inlineSnapshot: args.inlineSnapshot,
          timeoutMs: args.timeoutMs,
        })
        if (!result || result.ok === false) return result

        // The catalogue may have changed shape. Tell the host so it
        // re-lists; it re-reads `tools/list` from us.
        if (result.changed && result.changed.preset) {
          ctx.onToolsetChanged?.()
        }

        // Preferences are handled separately: they have their own failure
        // modes (no privileged context, unwritable profile) and they may
        // end with a restart.
        if (args.prefs && Object.keys(args.prefs).length) {
          const prefs = await provider.applyPrefs(args.prefs, { applyNow: args.applyNow === true })
          if (!prefs.ok) return { ...result, ...prefs }
          Object.assign(result, {
            prefs: prefs.prefs,
            applied: prefs.applied,
            appliedNow: prefs.appliedNow,
            pendingRestart: prefs.pendingRestart,
            failed: prefs.failed,
            hint: prefs.hint,
          })
        }

        if (args.restart === true) {
          const restarted = await provider.restart()
          result.restarted = restarted.restarted
          if (restarted.ok === false) return { ...result, ...restarted }
        }
        return result
      },
    },
    {
      name: 'browser_restart',
      capability: 'core',
      description: 'Restart Firefox. Use it after writing preferences, so they take effect.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      outputSchema: outputSchema({
        properties: {
          restarted: { type: 'boolean' },
          wasRunning: { type: 'boolean' },
          pid: { type: 'number' },
          port: { type: 'number' },
          sessionId: { type: 'string' },
        },
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      run: () => provider.restart(),
    },
  ]
}
