// lib/mcp/tools/action.js
// Acting on the page: pointer and keyboard input, forms, scrolling, uploads.
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
 * Build the action tools.
 *
 * @param ctx the server context
 * @returns the tool definitions, in list order
 */
import {
  BASE_SCHEMA,
  CONFIRM_SCHEMA,
  CONTEXT_SCHEMA,
  EFFECT_SCHEMA,
  GATE_SCHEMA,
  REF_SCHEMA,
  TARGET_SCHEMA,
} from './schemas.js'

export function createActionTools(ctx) {
  const { provider } = ctx
  return [
    {
      name: 'browser_click',
      capability: 'core',
      description:
        'Click an element with real pointer events. Target it by ref (preferred) or CSS selector.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: REF_SCHEMA,
          selector: {
            type: 'string',
            description: 'CSS selector of the element to click.',
          },
          contextId: CONTEXT_SCHEMA,
          button: {
            type: 'number',
            description: 'Mouse button: 0 left (default), 1 middle, 2 right.',
          },
          clickCount: {
            type: 'number',
            description: 'Number of clicks — use 2 for a double click.',
          },
          confirm: CONFIRM_SCHEMA,
        },
        additionalProperties: false,
      },
      requiresOneOf: ['ref', 'selector'],
      outputSchema: GATE_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      run: (args) =>
        provider.click(args.selector, args.contextId, {
          ref: args.ref,
          confirm: args.confirm,
          button: args.button,
          clickCount: args.clickCount,
        }),
    },
    {
      name: 'browser_type',
      capability: 'core',
      description:
        'Type text into an element — focuses it, then sends one key action per character.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: REF_SCHEMA,
          selector: {
            type: 'string',
            description: 'CSS selector of the input element.',
          },
          text: { type: 'string', description: 'Text to type.' },
          contextId: CONTEXT_SCHEMA,
          clear: {
            type: 'boolean',
            description: 'Clear the field before typing.',
          },
          submit: {
            type: 'boolean',
            description: 'Press Enter after typing (may submit — needs confirm).',
          },
          confirm: CONFIRM_SCHEMA,
        },
        required: ['text'],
        additionalProperties: false,
      },
      requiresOneOf: ['ref', 'selector'],
      outputSchema: GATE_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      run: (args) =>
        provider.type(args.selector, args.text, args.contextId, {
          ref: args.ref,
          clear: args.clear,
          submit: args.submit,
          confirm: args.confirm,
        }),
    },
    {
      name: 'browser_press_key',
      capability: 'input',
      description:
        'Press a key or shortcut in the focused element, e.g. "Enter", "Escape", "Ctrl+Enter".',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Key name or combination, e.g. "Enter", "Ctrl+Enter".',
          },
          contextId: CONTEXT_SCHEMA,
          confirm: CONFIRM_SCHEMA,
        },
        required: ['key'],
        additionalProperties: false,
      },
      outputSchema: EFFECT_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      run: (args) => provider.pressKey(args.key, args.contextId, { confirm: args.confirm }),
    },
    {
      name: 'browser_select_option',
      capability: 'input',
      description:
        'Choose an option in a <select> element, by value or by the option’s visible text.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: REF_SCHEMA,
          selector: { type: 'string', description: 'CSS selector of the select element.' },
          value: { type: 'string', description: 'The option value, or its visible text.' },
          byText: {
            type: 'boolean',
            description: 'Match the visible text instead of the underlying value.',
          },
          contextId: CONTEXT_SCHEMA,
          confirm: CONFIRM_SCHEMA,
        },
        required: ['value'],
        additionalProperties: false,
      },
      requiresOneOf: ['ref', 'selector'],
      outputSchema: TARGET_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      run: (args) =>
        provider.selectOption(args.selector, args.value, args.contextId, {
          ref: args.ref,
          byText: args.byText,
          confirm: args.confirm,
        }),
    },
    {
      name: 'browser_check',
      capability: 'input',
      description: 'Check or uncheck a checkbox or radio button.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: REF_SCHEMA,
          selector: { type: 'string', description: 'CSS selector of the checkbox or radio.' },
          checked: {
            type: 'boolean',
            description: 'true to check, false to uncheck.',
          },
          contextId: CONTEXT_SCHEMA,
          confirm: CONFIRM_SCHEMA,
        },
        required: ['checked'],
        additionalProperties: false,
      },
      requiresOneOf: ['ref', 'selector'],
      outputSchema: TARGET_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      run: (args) =>
        provider.check(args.selector, args.checked, args.contextId, {
          ref: args.ref,
          confirm: args.confirm,
        }),
    },
    {
      name: 'browser_hover',
      capability: 'input',
      description: 'Move the pointer over an element without clicking — for hover-only menus.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: REF_SCHEMA,
          selector: { type: 'string', description: 'CSS selector of the element to hover.' },
          contextId: CONTEXT_SCHEMA,
        },
        additionalProperties: false,
      },
      requiresOneOf: ['ref', 'selector'],
      outputSchema: TARGET_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      run: (args) => provider.hover(args.selector, args.contextId, { ref: args.ref }),
    },
    {
      name: 'browser_scroll',
      capability: 'input',
      description: 'Scroll the page, or bring an element into view.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: REF_SCHEMA,
          selector: {
            type: 'string',
            description: 'CSS selector of the element to scroll into view.',
          },
          contextId: CONTEXT_SCHEMA,
          direction: {
            type: 'string',
            description: 'up, down, top or bottom (default down).',
            enum: ['up', 'down', 'top', 'bottom'],
          },
          amount: {
            type: 'number',
            description: 'Pixels to scroll for up/down (default 400).',
          },
        },
        additionalProperties: false,
      },
      outputSchema: BASE_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      run: (args) =>
        provider.scroll(args.contextId, {
          ref: args.ref,
          selector: args.selector,
          direction: args.direction,
          amount: args.amount,
        }),
    },
    {
      name: 'browser_upload',
      capability: 'input',
      description:
        'Attach local files to a file input. Requires confirm: true — it sends local data.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: REF_SCHEMA,
          selector: { type: 'string', description: 'CSS selector of the file input.' },
          paths: {
            type: 'array',
            description: 'Absolute paths of the files to attach.',
            items: { type: 'string' },
          },
          contextId: CONTEXT_SCHEMA,
          confirm: CONFIRM_SCHEMA,
        },
        required: ['paths'],
        additionalProperties: false,
      },
      requiresOneOf: ['ref', 'selector'],
      outputSchema: GATE_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      run: (args) =>
        provider.upload(args.selector, args.paths || [], args.contextId, {
          ref: args.ref,
          confirm: args.confirm,
        }),
    },
  ]
}
