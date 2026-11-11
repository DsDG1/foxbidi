// lib/mcp/tools/captcha.js
// CAPTCHA detection and solving.
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
 * Build the captcha tools.
 *
 * @param ctx the server context
 * @returns the tool definitions, in list order
 */
import { outputSchema } from '../schema.js'
import { CONTEXT_SCHEMA } from './schemas.js'

export function createCaptchaTools(ctx) {
  const { provider } = ctx
  return [
    {
      name: 'browser_captcha',
      capability: 'captcha',
      description:
        'Solve a CAPTCHA: Turnstile, reCAPTCHA v2, hCaptcha, GeeTest, proof-of-work, rotate-to-upright slider.',
      inputSchema: {
        type: 'object',
        properties: {
          contextId: CONTEXT_SCHEMA,
          solver: {
            type: 'string',
            enum: ['auto', 'turnstile', 'recaptcha', 'hcaptcha', 'geetest', 'pow', 'spin'],
            description: 'Which challenge to solve; "auto" detects it.',
          },
          sttUrl: {
            type: 'string',
            description: 'Whisper-compatible endpoint for audio challenges.',
          },
          visionUrl: {
            type: 'string',
            description: 'Image-recognition endpoint for image-grid challenges.',
          },
          timeoutMs: {
            type: 'number',
            description: 'How long to spend on the challenge (default 60000).',
          },
        },
        additionalProperties: false,
      },
      outputSchema: outputSchema({
        properties: {
          ok: { type: 'boolean', description: 'True only when the site issued a token.' },
          status: {
            type: 'string',
            description: 'Why it ended: solved, not_detected, no_token, …',
          },
          solver: { type: 'string' },
          tokenLength: { type: 'number' },
          detected: {
            type: 'array',
            items: { type: 'string' },
          },
          attempts: { type: 'array' },
          message: {
            type: 'string',
          },
          notes: { type: 'array', items: { type: 'string' } },
        },
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: (args) =>
        provider.captcha(args.contextId, {
          solver: args.solver,
          sttUrl: args.sttUrl,
          visionUrl: args.visionUrl,
          timeoutMs: args.timeoutMs,
        }),
    },
    {
      name: 'browser_captcha_status',
      capability: 'captcha',
      description: 'Report whether a CAPTCHA on the current page is already solved. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          contextId: CONTEXT_SCHEMA,
          kind: {
            type: 'string',
            enum: ['turnstile', 'recaptcha', 'hcaptcha', 'geetest', 'pow', 'spin'],
            description: 'Which challenge to check.',
          },
        },
        required: ['kind'],
        additionalProperties: false,
      },
      outputSchema: outputSchema({
        properties: {
          solved: { type: 'boolean', description: 'True when the site has issued a token.' },
          tokenLength: { type: 'number' },
          contextId: { type: 'string' },
        },
      }),
      annotations: { readOnlyHint: true },
      run: (args) => provider.captchaStatus(args.contextId, { kind: args.kind }),
    },
  ]
}
