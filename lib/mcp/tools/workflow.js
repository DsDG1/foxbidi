// lib/mcp/tools/workflow.js
// Waiting, batching, running helper scripts and handing a page to another browser.
//
// The tool objects below are copied VERBATIM from the previous single TOOLS
// array in server.js — name, description, inputSchema, outputSchema,
// annotations and the `run` body are byte-identical, so the MCP contract the
// host already relies on does not change.

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
      name: 'browser_handle_dialog',
      description:
        "Handle a JavaScript dialog (alert / confirm / prompt / beforeunload). Dialogs are closed automatically by default and reported in the previous action's effect; use this to accept, dismiss, or answer one explicitly.",
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
            description:
              'Stop at the first failing step (default true). Steps already run are not undone.',
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
  ]
}
