// lib/firefox/injection.js
// Detecting text that is shaped like an instruction aimed at an agent.
//
// WHY THIS EXISTS
//
// A page that says "ignore previous instructions" is not addressing the
// user — it is addressing whatever is reading the page. Detecting that
// shape lets the plugin label the content and, when the content is also
// hidden, block the actions that would carry the data out.
//
// PRECISION OVER RECALL
//
// These patterns are deliberately narrow. A false positive here degrades a
// legitimate page; a false negative lets one attack through. The patterns
// match WHOLE PHRASES that have no place in ordinary prose, and each one
// has a near-miss test that must not match.
//
// TWO PATTERNS NEEDED TIGHTENING AFTER MEASUREMENT
//
//   "act as a pirate"      — a blog post about roleplay, not a takeover.
//                            The agent-addressed form is "act as if you
//                            are …", so that is what matches.
//
//   "Operating system: X"  — a specs page, not a prompt spoof. A system
//                            prompt spoof puts the token in a ROLE
//                            POSITION: at the start of a line, or inside
//                            brackets. "system" mid-sentence does not.
//
// WHAT THIS DOES NOT DO
//
// It does not understand intent, does not classify semantics, and does not
// use generic entropy scoring — the same rule lib/firefox/redact.js
// already established: base64 images and session tokens have the same
// statistical shape, and redacting both would break half the web.

/** The signal kinds this module can produce. */
export const SIGNAL_KINDS = new Set([
  'instruction_reset',
  'role_reassign',
  'system_spoof',
  'guard_bypass',
  'conceal_from_user',
  'encoded_payload',
])

/**
 * The instruction-shaped patterns.
 *
 * Each entry is [kind, RegExp]. The regexes are anchored to phrases that
 * would be strange in a product's own copy.
 *
 * None of them carry the `g` flag: `.test` is used, and a sticky global
 * regex would keep its `lastIndex` between calls and silently skip
 * matches.
 */
const INSTRUCTION_RULES = [
  // --- A negative reset of what the agent was told ------------------------
  [
    'instruction_reset',
    /\bignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|foregoing)\s+(?:instructions?|prompts?|rules?|directions?|messages?)\b/i,
  ],
  [
    'instruction_reset',
    /\bdisregard\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|directions?)\b/i,
  ],
  // "disregard your guidelines" — the same reset, aimed at the rules
  // rather than at the instructions. Measured on a real injection page.
  [
    'instruction_reset',
    /\b(?:disregard|ignore)\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?guidelines?\b/i,
  ],
  [
    'instruction_reset',
    /\bforget\s+(?:all\s+|your\s+|the\s+)?(?:previous|prior|earlier)\s+(?:instructions?|prompts?|rules?)\b/i,
  ],

  // --- A role reassignment aimed at the reader ----------------------------
  // The subject must be "you": "act as a pirate" is prose, "act as if you
  // are a pirate" is an instruction to whoever is reading.
  ['role_reassign', /\byou\s+are\s+now\s+(?:a|an|the)\b/i],
  ['role_reassign', /\bfrom\s+now\s+on,?\s+you\s+are\s+(?:a|an|the)\b/i],
  [
    'role_reassign',
    /\b(?:act|behave|respond)\s+as\s+(?:if|though)\s+you\s+(?:are|were)\s+(?:a|an|the)\b/i,
  ],
  ['role_reassign', /\b(?:act|behave|respond)\s+as\s+you\s+(?:are|were)\s+(?:a|an|the)\b/i],
  ['role_reassign', /\bpretend\s+(?:that\s+)?you\s+(?:are|were)\s+(?:a|an|the)\b/i],
  ['role_reassign', /\bpretend\s+to\s+be\s+(?:a|an|the)\b/i],

  // --- A system prompt impersonation --------------------------------------
  // The token has to sit in a ROLE POSITION — the start of a line, or
  // inside brackets or angle brackets. "Operating system: Linux" is a
  // specs page, and it must not read as a spoof.
  ['system_spoof', /^\s*system\s*[:-]/im],
  ['system_spoof', /["'[(<]\s*system\s*[:-]/i],
  ['system_spoof', /\[\s*system\s*\]/i],
  ['system_spoof', /<\|?\s*system\s*\|?>|<\/?\s*system\s*>/i],
  ['system_spoof', /\bnew\s+instructions?\s*[:-]/i],

  // --- A request to step around a guardrail --------------------------------
  [
    'guard_bypass',
    /\b(?:bypass|override|disable|ignore|circumvent|turn\s+off)\b[^.\n]{0,40}?\b(?:safety|guard|guardrail|filter|restriction|protection|security|policy|policies)\b/i,
  ],
  [
    'guard_bypass',
    /\b(?:bypass|override|disable|circumvent)\b[^.\n]{0,40}?\b(?:all\s+)?(?:restrictions?|limitations?|safeguards?)\b/i,
  ],

  // --- A request to keep it from the user ----------------------------------
  [
    'conceal_from_user',
    /\bdo\s+not\s+(?:tell|mention|inform|reveal\s+to|show|report\s+to)\s+(?:the\s+)?(?:user|human|operator)\b/i,
  ],
  [
    'conceal_from_user',
    /\bwithout\s+(?:telling|informing|asking|notifying|alerting)\s+(?:the\s+)?(?:user|human|operator)\b/i,
  ],
  [
    'conceal_from_user',
    /\b(?:secretly|silently|covertly|without\s+(?:the\s+)?user(?:'s)?\s+(?:knowledge|consent))\b/i,
  ],
]

/**
 * The encoded-payload patterns.
 *
 * These are WEAK signals. A long base64 blob is a legitimate thing to find
 * on a page (an embedded image, a cache key, a signed URL). They only count
 * as evidence when something else already points at an injection.
 */
const ENCODED_RULES = [
  ['encoded_payload', /[A-Za-z0-9+/]{200,}={0,2}/],
  ['encoded_payload', /\b[0-9a-fA-F]{120,}\b/],
  ['encoded_payload', /(?:%[0-9A-Fa-f]{2}){40,}/],
]

/**
 * Detect the instruction-shaped signals in a blob of text.
 *
 * @param {string} text
 * @returns {string[]} the signal kinds, deduplicated, in definition order
 */
export function detectInjectionSignals(text) {
  const source = String(text || '')
  if (!source.trim()) return []
  const found = new Set()
  for (const [kind, pattern] of INSTRUCTION_RULES) {
    if (pattern.test(source)) found.add(kind)
  }
  return [...found]
}

/**
 * Detect the encoded-payload signals in a blob of text.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function detectEncodedPayloads(text) {
  const source = String(text || '')
  if (!source.trim()) return []
  const found = new Set()
  for (const [kind, pattern] of ENCODED_RULES) {
    if (pattern.test(source)) found.add(kind)
  }
  return [...found]
}

/** How long a signal excerpt may be. */
const EXCERPT_MAX_CHARS = 200

/**
 * Cut a window of text around a match.
 *
 * The window starts a little BEFORE the match, because the instruction
 * often carries its own subject ("... and then ignore previous
 * instructions"), and the agent needs the whole thought, not just the
 * keyword.
 *
 * @param {string} source
 * @param {number} index
 * @param {number} length
 * @returns {string}
 */
function excerptAround(source, index, length) {
  const lead = 60
  const start = Math.max(0, index - lead)
  const end = Math.min(source.length, index + length + lead)
  const cut = source.slice(start, end).trim()
  return cut.length > EXCERPT_MAX_CHARS ? `${cut.slice(0, EXCERPT_MAX_CHARS)}…` : cut
}

/**
 * Match every signal in a blob of text, with the excerpt that produced it.
 *
 * This is the richer form of the two detectors above: the kind, which
 * CLASS of evidence it is, where it sits in the text, and the text around
 * it. The provenance layer needs the excerpt — a warning that says
 * "instruction_reset" without showing what was found sends the agent back
 * to search the page for it.
 *
 * Class A is an instruction-shaped pattern; class C is an encoded
 * payload. C is only ever corroborating evidence.
 *
 * @param {string} text
 * @returns {Array<{kind: string, class: 'A'|'C', index: number, excerpt: string}>}
 */
export function matchInjectionSignals(text) {
  const source = String(text || '')
  if (!source.trim()) return []
  const matches = []
  for (const [kind, pattern] of INSTRUCTION_RULES) {
    const m = pattern.exec(source)
    if (m && m.index >= 0) {
      matches.push({
        kind,
        class: 'A',
        index: m.index,
        excerpt: excerptAround(source, m.index, m[0].length),
      })
    }
  }
  for (const [kind, pattern] of ENCODED_RULES) {
    const m = pattern.exec(source)
    if (m && m.index >= 0) {
      matches.push({
        kind,
        class: 'C',
        index: m.index,
        excerpt: excerptAround(source, m.index, m[0].length),
      })
    }
  }
  matches.sort((a, b) => a.index - b.index)
  return matches
}
