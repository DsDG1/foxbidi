// lib/mcp/tools/net.js
// The network tools: what can the browser reach, and why not.
//
// WHY THESE TOOLS EXIST
//
// "The page did not load" is one sentence that hides four different faults:
// a resolver that does not know the name, a machine with no route to the
// host, a browser process that cannot open sockets at all, and a site that
// is simply down. Without a way to tell them apart, an agent retries
// blindly — and a retry loop against a browser that cannot reach the
// network burns the whole session without ever succeeding.
//
// `browser_net_check` takes one sample from the machine and one from the
// browser and reports the difference.

import { outputSchema } from '../schema.js'

/**
 * Build the network tools.
 *
 * @param ctx the server context
 * @returns the tool definitions, in list order
 */
export function createNetTools(ctx) {
  const { provider } = ctx
  return [
    {
      name: 'browser_net_check',
      capability: 'core',
      description:
        'Diagnose why a page will not load: DNS, host route, browser egress, or the site itself.',
      inputSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Hostname or URL; defaults to the current page.',
          },
          timeoutMs: {
            type: 'number',
            description: 'Probe timeout in ms.',
          },
        },
        additionalProperties: false,
      },
      outputSchema: outputSchema({
        properties: {
          diagnosis: { type: 'string' },
          target: { type: 'string' },
          host: { type: 'object' },
          browser: { type: 'object' },
          hint: { type: 'string' },
          suggestEgress: { type: 'boolean' },
        },
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      run: (args) => provider.netCheck(args),
    },
    {
      name: 'browser_egress',
      capability: 'egress',
      description:
        'Start, stop or inspect a loopback egress proxy, for a browser that cannot reach the network.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'stop', 'status'],
            description: 'What to do with the proxy.',
          },
        },
        additionalProperties: false,
      },
      outputSchema: outputSchema({
        properties: {
          running: { type: 'boolean' },
          port: { type: 'number' },
          connections: { type: 'number' },
          refused: { type: 'array' },
          prefs: { type: 'object' },
          hint: { type: 'string' },
        },
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      run: (args) => provider.egress(args.action),
    },
  ]
}
