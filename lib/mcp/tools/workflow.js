// lib/mcp/tools/workflow.js
// Waiting, batching, running helper scripts and handing a page to another browser.
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
 * Build the workflow tools.
 *
 * @param ctx the server context
 * @returns the tool definitions, in list order
 */
import { outputSchema } from '../schema.js'
import { BASE_SCHEMA, CONTEXT_SCHEMA } from './schemas.js'

export function createWorkflowTools(ctx) {
  const { provider } = ctx
  return [
    {
      name: 'browser_wait_for',
      description:
        'Wait until a condition holds: an element appears, text shows up, load or network idle.',
      inputSchema: {
        type: 'object',
        properties: {
          for: {
            type: 'string',
            description: 'What to wait for: selector, text, load or networkIdle.',
            enum: ['selector', 'text', 'load', 'networkIdle'],
          },
          selector: { type: 'string', description: 'Selector to wait for (for=selector).' },
          text: { type: 'string', description: 'Text to wait for (for=text).' },
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
      name: 'browser_handle_dialog',
      description: 'Handle a JavaScript dialog (alert / confirm / prompt / beforeunload).',
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
          handled: { type: 'string' },
          message: { type: 'string' },
          type: { type: 'string' },
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
      name: 'browser_batch',
      description:
        'Run several actions in one call — click, type, press a key, wait, snapshot. Stops at the first failure.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'The steps to run, in order; each has an "action" and its arguments.',
            items: { type: 'object', additionalProperties: true },
          },
          contextId: CONTEXT_SCHEMA,
          stopOnError: {
            type: 'boolean',
            description: 'Stop at the first failing step (default true).',
          },
        },
        required: ['steps'],
        additionalProperties: false,
      },
      outputSchema: outputSchema({
        properties: {
          steps: { type: 'array' },
          completed: { type: 'number' },
          failedAt: { type: 'number' },
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
        'Run a JavaScript file in the page. The path must be inside ~/.mavis/ff-workspace/.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
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
          path: { type: 'string' },
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
      name: 'browser_handoff',
      description:
        'Move the current page between this plugin’s Firefox and the host’s in-app browser.',
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
            description: 'Target URL; required for to="firefox".',
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
  ]
}
