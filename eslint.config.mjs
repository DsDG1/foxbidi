// ESLint flat config (eslint v9).
//
// Scope: lib/**/*.js + server.js + tools/**/*.mjs + test/**/*.js (Node ESM).
//
// The plugin ships with ZERO runtime npm dependencies — that is a selling
// point of the package ("nothing to install, nothing to audit"). eslint and
// prettier are therefore devDependencies only; the published plugin never
// needs them.
import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    // Local artefacts that live inside the repository but are not part of
    // it: git worktrees (a full second copy of the plugin, plus its own
    // node_modules) and the runtime scratch directories the plugin creates
    // next to itself.
    //
    // ESLint's flat config does NOT read .gitignore, and the recommended
    // config below applies to every file it walks — so without these
    // ignores, `eslint .` lints the worktree copy and reports its files
    // as undefined globals.
    ignores: ['.worktrees/**', '.plugin-data/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  {
    files: ['lib/**/*.js', 'server.js', 'tools/**/*.mjs', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // A typo'd identifier is a real bug, not a style nit.
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      // Deliberate silent catches (`catch {}`) are a codebase convention:
      // they are defensive fallbacks where the error genuinely does not
      // change the outcome.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // False positives in this codebase: ANSI-strip control regexes and
      // CJK full-width spaces inside zh-CN strings and comments.
      'no-control-regex': 'off',
      'no-irregular-whitespace': 'off',
      // The existing code assigns a variable and then overwrites it before
      // reading it. That is a style nit, not a defect, and it is not worth
      // churning the codebase to satisfy — so it stays a warning.
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'error',
    },
  },
]
