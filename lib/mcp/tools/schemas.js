// lib/mcp/tools/schemas.js
// The JSON Schema fragments the tool definitions share.
//
// These live in their own module so the tool modules can import them without
// reaching back into server.js — and without server.js importing the tool
// modules, which would be a cycle.
//
// WHY THE DESCRIPTIONS ARE SHORT
//
// Every tool definition is injected into the model's context on EVERY turn.
// A shared fragment is not shared on the wire: each tool that references it
// carries its own copy in the JSON payload. So the wording here is multiplied
// by the number of tools that use it — CONTEXT_SCHEMA alone appears 30 times.
//
// The fragments are therefore kept to a single short clause, and the longer
// explanation of what each parameter means lives in skills/firefox-browser/
// SKILL.md, which is read on demand and costs nothing per turn.

import { outputSchema } from '../schema.js'

/** The browsing context a tool acts on. */
export const CONTEXT_SCHEMA = {
  type: 'string',
  description: 'Target tab; omit for focused.',
}

/** An element ref from browser_snapshot. */
export const REF_SCHEMA = {
  type: 'string',
  description: 'Element ref from browser_snapshot.',
}

/**
 * The explicit confirmation flag for irreversible actions.
 *
 * The wording here is multiplied by every tool that carries the flag — it
 * appears 9 times in the injected payload — so it is kept to the shortest
 * form that still says what it does. The full explanation of WHICH actions
 * need it lives in skills/firefox-browser/SKILL.md.
 */
export const CONFIRM_SCHEMA = {
  type: 'boolean',
  description: 'Confirm an irreversible action.',
}

/** Result schema shared by every tool. */
export const BASE_SCHEMA = outputSchema()

/** Schema for tools that can be blocked by the confirmation gate. */
export const GATE_SCHEMA = outputSchema({
  properties: {
    blocked: { type: 'boolean', description: 'True when the action was refused.' },
    action: { type: 'string', description: 'The irreversible action kind detected.' },
    requiresConfirm: { type: 'boolean' },
  },
})

/** Schema for tools that resolve an element. */
export const TARGET_SCHEMA = outputSchema({
  properties: {
    selector: { type: 'string', description: 'The CSS selector the ref resolved to.' },
    via: { type: 'string' },
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

/**
 * The inline-snapshot flag carried by every action tool.
 *
 * An action's response already carries a light view of the page as it
 * looks NOW, so the agent does not have to spend a second round trip
 * asking. Passing false skips that view.
 *
 * The wording is multiplied by every action tool that carries it, so it
 * is kept to the shortest form that still says what it does.
 */
export const INCLUDE_SNAPSHOT_SCHEMA = {
  type: 'boolean',
  description: 'Also return the page elements after the action.',
}
