// lib/mcp/tools/captcha.js
// CAPTCHA detection and solving.
//
// The tool objects below are copied VERBATIM from the previous single TOOLS
// array in server.js — name, description, inputSchema, outputSchema,
// annotations and the `run` body are byte-identical, so the MCP contract the
// host already relies on does not change.

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
      description:
        'Solve a CAPTCHA on the current page: Turnstile, reCAPTCHA v2, hCaptcha, GeeTest sliders, proof-of-work widgets and the Baidu rotate-to-upright spin captcha. Detects the challenge first, then answers it, and reports success only when the site itself issued a token. A challenge that needs a service you have not configured comes back as a named error, never as a false success.',
      inputSchema: {
        type: 'object',
        properties: {
          contextId: CONTEXT_SCHEMA,
          solver: {
            type: 'string',
            enum: ['auto', 'turnstile', 'recaptcha', 'hcaptcha', 'geetest', 'pow', 'spin'],
            description:
              'Which challenge to solve. "auto" (default) detects what is on the page and tries the matching solver.',
          },
          sttUrl: {
            type: 'string',
            description:
              'A Whisper-compatible speech-to-text endpoint, for audio challenges (reCAPTCHA/hCaptcha). No model is bundled: point this at e.g. http://127.0.0.1:8000. Without it, audio challenges report stt_unavailable.',
          },
          visionUrl: {
            type: 'string',
            description:
              'An image-recognition endpoint, for image-grid challenges. No vision model is bundled. Without it, image grids report vision_unavailable.',
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
            description:
              'Why it ended: solved, not_detected, checkbox_not_found, no_token, wrong_answer, vision_unavailable, stt_unavailable, solve_failed, and so on.',
          },
          solver: { type: 'string', description: 'Which solver handled it.' },
          tokenLength: { type: 'number', description: 'Length of the token the site issued.' },
          detected: {
            type: 'array',
            description: 'The challenge kinds that were found on the page.',
          },
          attempts: { type: 'array', description: 'Per-challenge outcome when solver is "auto".' },
          message: {
            type: 'string',
            description: 'A plain-language explanation of what happened.',
          },
          notes: { type: 'array', description: 'Caveats worth knowing about the result.' },
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
      description:
        'Report whether a CAPTCHA on the current page is already solved, by reading the token the site would use. Read-only: it never clicks or types.',
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
          tokenLength: { type: 'number', description: 'Length of the token the site issued.' },
          contextId: { type: 'string' },
        },
      }),
      annotations: { readOnlyHint: true },
      run: (args) => provider.captchaStatus(args.contextId, { kind: args.kind }),
    },
  ]
}
