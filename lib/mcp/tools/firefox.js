// lib/mcp/tools/firefox.js
// Firefox-only capabilities: containers, extensions, cookies, intercepts, detectability.
//
// The tool objects below are copied VERBATIM from the previous single TOOLS
// array in server.js — name, description, inputSchema, outputSchema,
// annotations and the `run` body are byte-identical, so the MCP contract the
// host already relies on does not change.

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
      description:
        "Manage Firefox containers — isolated identities with separate cookies, localStorage and cache. Use it to hold several accounts of the same site side by side, or to keep a task's login state from leaking into other work.",
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
          userContext: {
            type: 'string',
            description: 'The container that was created or selected.',
          },
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
            description:
              'The cookie to write, e.g. {"name":"sid","value":"x","domain":"example.com"}.',
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
            description:
              'Registry keys present on window. They are non-enumerable but discoverable.',
          },
          notes: { type: 'array', description: 'What this means, in plain words.' },
        },
      }),
      annotations: { readOnlyHint: true },
      run: (args) => provider.detectability(args.contextId),
    },
  ]
}
