// lib/mcp/tools/firefox.js
// Firefox-only capabilities: containers, extensions, cookies, intercepts, detectability.
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
 * Build the firefox tools.
 *
 * @param ctx the server context
 * @returns the tool definitions, in list order
 */
import { outputSchema } from '../schema.js'
import { CONFIRM_SCHEMA, CONTEXT_SCHEMA } from './schemas.js'

export function createFirefoxTools(ctx) {
  const { provider } = ctx
  return [
    {
      name: 'browser_context',
      capability: 'firefox',
      description:
        'Manage Firefox containers — isolated identities with separate cookies, storage and cache.',
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
          },
          userContext: {
            type: 'string',
          },
          contextId: { type: 'string' },
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
      capability: 'firefox',
      description: 'Install, uninstall or list WebExtensions. Firefox 137+.',
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
            description: 'Unpacked directory or XPI file.',
          },
          extensionId: {
            type: 'string',
          },
          permanent: {
            type: 'boolean',
            description: 'Request a permanent install (Firefox 138+).',
          },
          confirm: CONFIRM_SCHEMA,
        },
        required: ['action'],
        additionalProperties: false,
      },
      outputSchema: outputSchema({
        properties: {
          extensionId: { type: 'string' },
          installed: { type: 'boolean' },
          extensions: { type: 'array' },
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
      capability: 'cookie',
      description: 'Read or write cookies, including HttpOnly ones. Firefox 124+.',
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
            description: 'Which cookies to read.',
            additionalProperties: true,
          },
          cookie: {
            type: 'object',
            description: 'The cookie to write.',
            additionalProperties: true,
          },
          revealValues: {
            type: 'boolean',
            description: 'Return cookie values verbatim. Off by default.',
          },
          confirm: CONFIRM_SCHEMA,
        },
        required: ['action'],
        additionalProperties: false,
      },
      outputSchema: outputSchema({
        properties: {
          cookies: { type: 'array' },
          count: { type: 'number' },
        },
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
      run: (args) =>
        provider.cookie({
          action: args.action,
          filter: args.filter,
          cookie: args.cookie,
          revealValues: args.revealValues,
          confirm: args.confirm,
        }),
    },
    {
      name: 'browser_intercept',
      capability: 'firefox',
      description:
        'Block requests whose URL contains one of the given patterns (trackers, ads, APIs).',
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
            description: 'URL substrings to block.',
            items: { type: 'string' },
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      outputSchema: outputSchema({
        properties: {
          interceptId: { type: 'string' },
          active: { type: 'number' },
          patterns: { type: 'array' },
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
      capability: 'firefox',
      description:
        'Report how detectable this session is — read it before claiming a page cannot tell it is automated.',
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
            description: 'Elements still carrying a plugin marker attribute.',
          },
          registryKeys: {
            type: 'number',
          },
          notes: { type: 'array' },
        },
      }),
      annotations: { readOnlyHint: true },
      run: (args) => provider.detectability(args.contextId),
    },
  ]
}
