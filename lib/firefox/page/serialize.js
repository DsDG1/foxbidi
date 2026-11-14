// lib/firefox/page/serialize.js
// Deterministic serializer that turns pure JS functions into self-contained
// functionDeclaration strings for WebDriver BiDi `script.callFunction`.
//
// Authoring page scripts as real JS functions (instead of backtick strings)
// gives full ESLint (`globals.browser`), TypeScript `checkJs` verification,
// and direct Node unit testing without launching Firefox.

/**
 * Serialize a helper value (function, RegExp, Set, or JSON literal) as JS source.
 *
 * @param {unknown} value
 * @returns {string}
 */
function serializeBinding(value) {
  if (typeof value === 'function') return value.toString()
  if (value instanceof RegExp) return value.toString()
  if (value instanceof Set) return `new Set(${JSON.stringify([...value])})`
  return JSON.stringify(value)
}

/**
 * Extract parameter names from a function's source signature.
 *
 * Only simple positional identifiers `(a, b, c) => ...` or `function f(a, b)`
 * are used in BiDi entry functions, since BiDi passes positional RemoteValues.
 *
 * @param {Function} fn
 * @returns {string[]}
 */
function extractParamNames(fn) {
  const src = fn.toString().trim()
  const arrowSingle = src.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*=>/)
  if (arrowSingle) return [arrowSingle[1]]
  const parens = src.match(
    /^(?:async\s+)?(?:function(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*)?\(([^)]*)\)/,
  )
  if (!parens) return []
  const raw = parens[1].trim()
  if (!raw) return []
  return raw
    .split(',')
    .map((p) => p.trim().split('=')[0].trim())
    .filter(Boolean)
}

/**
 * Bundle an entry function and its pure lexical bindings into a self-contained
 * BiDi `functionDeclaration` string `(arg0, arg1, ...) => { ... }`.
 *
 * @param {Function} entryFn
 * @param {Record<string, unknown>} [bindings]
 * @returns {string}
 */
export function serializePageFn(entryFn, bindings = {}) {
  const entries = Object.entries(bindings)
  if (!entries.length) {
    const src = entryFn.toString().trim()
    return src.startsWith('function') ? `(${src})` : src
  }
  const params = extractParamNames(entryFn)
  const isAsync = /^\s*async\b/.test(entryFn.toString())
  const header = `${isAsync ? 'async ' : ''}(${params.join(', ')}) => {`
  const decls = entries.map(([name, val]) => `  const ${name} = ${serializeBinding(val)};`)
  const invoke = `${isAsync ? 'await ' : ''}__entry(${params.join(', ')})`
  return [
    header,
    ...decls,
    `  const __entry = ${entryFn.toString()};`,
    `  return ${invoke};`,
    '}',
  ].join('\n')
}
