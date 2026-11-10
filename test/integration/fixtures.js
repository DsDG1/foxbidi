// test/integration/fixtures.js
// A shared helper for the live-browser integration tests.
//
// WHY THIS EXISTS
//
// The navigation policy (lib/firefox/navigation-policy.js) refuses a
// top-level navigation to a `data:` URL by default — along with `file:`,
// `javascript:` and the private address ranges. The reasoning is sound for
// a browser that carries the user's real login state: a `data:` page has no
// origin the site would recognise, but it is still a page the user did not
// ask for.
//
// The integration tests, however, load their FIXTURES as `data:` URLs —
// that is how they get a page with known markup without standing up an HTTP
// server. So the tests need the policy relaxed, and the plan provides the
// escape hatch for exactly this: `FIREFOX_BROWSER_NAVIGATION_POLICY=permissive`.
//
// The alternative — rewriting every fixture to a served file — would mean
// standing up a local HTTP server per test file, which is slower and would
// run into the private-address rule anyway.
//
// So: one helper, one explanation, and the DEFAULT stays strict.

/**
 * Relax the navigation policy for a fixture-loading test.
 *
 * Must be called BEFORE the provider is constructed and before any
 * navigation happens — the policy is read from the environment when the
 * navigation is requested, so setting it at module scope is enough.
 *
 * @param {object} [env]  the environment to modify (defaults to process.env)
 */
export function relaxNavigationPolicy(env = process.env) {
  env.FIREFOX_BROWSER_NAVIGATION_POLICY = 'permissive'
}
