// lib/mcp/tools/verify.js
// Asserting something about the page.
//
// WHY THIS IS A TOOL AND NOT A SNAPSHOT
//
// The question an agent asks after an action is almost always a yes/no one:
// did the page change the way it should? Answering it with a full snapshot
// costs a large response and leaves the COMPARISON to the model, which
// does it inconsistently and in prose. `browser_verify` answers the
// question and returns the verdict.
//
// TWO FAILURES, KEPT APART
//
// `ok` says the assertion could be RUN. `verified` says it HELD. An
// assertion that ran and did not hold is `ok:true, verified:false` — a
// legitimate answer, not a tool failure. `ok:false` means the assertion
// could not be attempted: an unknown kind, a missing argument, an
// unreachable page, or a credential field whose value is never read out of
// the page and so cannot be compared.

import { outputSchema } from '../schema.js'
import { CONTEXT_SCHEMA, REF_SCHEMA } from './schemas.js'

/**
 * Build the verification tool.
 *
 * @param ctx the server context
 * @returns the tool definitions, in list order
 */
export function createVerifyTools(ctx) {
  const { provider } = ctx
  return [
    {
      name: 'browser_verify',
      capability: 'assert',
      description: 'Assert the page state and get a verdict: element, text, value, list.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['element', 'text', 'value', 'list'],
            description: 'What to assert.',
          },
          role: { type: 'string', description: 'element: the ARIA role.' },
          name: { type: 'string', description: 'element: the accessible name.' },
          text: { type: 'string', description: 'text: the text that must be visible.' },
          ref: REF_SCHEMA,
          selector: { type: 'string', description: 'CSS selector of the target element.' },
          value: { type: 'string', description: 'value: the expected value.' },
          items: {
            type: 'array',
            description: 'list: the items that must all be present.',
            items: { type: 'string' },
          },
          contextId: CONTEXT_SCHEMA,
        },
        required: ['kind'],
        additionalProperties: false,
      },
      outputSchema: outputSchema({
        properties: {
          verified: { type: 'boolean', description: 'True when the assertion held.' },
          kind: { type: 'string' },
          expected: { type: 'string' },
          actual: { type: 'string' },
        },
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: (args) => provider.verify(args.contextId, args),
    },
  ]
}
