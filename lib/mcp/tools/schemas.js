// lib/mcp/tools/schemas.js
// The JSON Schema fragments the tool definitions share.
//
// These live in their own module so the tool modules can import them without
// reaching back into server.js — and without server.js importing the tool
// modules, which would be a cycle.

import { outputSchema } from '../schema.js'

/** The browsing context a tool acts on. */
export const CONTEXT_SCHEMA = {
  type: 'string',
  description: 'Target browsing context. Omit to use the most recently focused tab.',
}

/** An element ref from browser_snapshot. */
export const REF_SCHEMA = {
  type: 'string',
  description:
    'Element ref from browser_snapshot. Preferred over a CSS selector; if both are given, the ref wins.',
}

/** The explicit confirmation flag for irreversible actions. */
export const CONFIRM_SCHEMA = {
  type: 'boolean',
  description:
    'Required (true) for irreversible actions — form submit, download, upload, account change.',
}

/** Result schema shared by every tool. */
export const BASE_SCHEMA = outputSchema()

/** Schema for tools that can be blocked by the confirmation gate. */
export const GATE_SCHEMA = outputSchema({
  properties: {
    blocked: { type: 'boolean', description: 'True when the action was refused.' },
    action: { type: 'string', description: 'The irreversible action kind that was detected.' },
    requiresConfirm: { type: 'boolean', description: 'True when confirm: true is required.' },
  },
})

/** Schema for tools that resolve an element. */
export const TARGET_SCHEMA = outputSchema({
  properties: {
    selector: { type: 'string', description: 'The CSS selector the ref resolved to.' },
    via: { type: 'string', description: 'Either "ref" or "selector".' },
  },
})

/** Schema for tools that report an action effect. */
export const EFFECT_SCHEMA = outputSchema({
  properties: {
    effect: {
      type: 'object',
      description: 'Before/after comparison proving whether the action landed.',
    },
  },
})
