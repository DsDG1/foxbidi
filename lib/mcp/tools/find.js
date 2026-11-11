// lib/mcp/tools/find.js
// Searching the page.
//
// The snapshot answers "what can I interact with?"; the page text answers
// "what does it say?". `browser_find` answers "where is the thing that
// says X?" — and reports element hits and text hits SEPARATELY, because
// only an element hit carries a ref the agent can act on.
//
// The match is a case-insensitive substring. Regex is deliberately not
// supported: the tool catalogue is injected into the context on every
// turn, and a second mode would cost bytes on every task to serve a
// minority of searches.

import { outputSchema } from '../schema.js'
import { CONTEXT_SCHEMA } from './schemas.js'

/**
 * Build the find tool.
 *
 * @param ctx the server context
 * @returns the tool definitions, in list order
 */
export function createFindTools(ctx) {
  const { provider } = ctx
  return [
    {
      name: 'browser_find',
      capability: 'assert',
      description: 'Search the page for text — matching elements (with refs) and text, apart.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'What to look for (case-insensitive).',
          },
          context: {
            type: 'number',
            description: 'Neighbours per side (default 2).',
          },
          maxResults: { type: 'number', description: 'Cap on the hits.' },
          contextId: CONTEXT_SCHEMA,
        },
        required: ['text'],
        additionalProperties: false,
      },
      outputSchema: outputSchema({
        properties: {
          // No descriptions: every name says what it is, and the schema is
          // re-serialized into the tools/list payload on every turn.
          elements: { type: 'array' },
          texts: { type: 'array', items: { type: 'string' } },
          elementCount: { type: 'number' },
          textCount: { type: 'number' },
        },
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: (args) =>
        provider.find(args.contextId, {
          text: args.text,
          context: args.context,
          maxResults: args.maxResults,
        }),
    },
  ]
}
