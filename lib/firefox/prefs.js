// lib/firefox/prefs.js
// Firefox preferences the agent can set while the plugin runs.
//
// WHY TWO PATHS
//
// A preference can be applied in two ways, and they are not equally
// available:
//
//   - WRITE IT INTO THE PROFILE COPY (user.js). Firefox reads user.js at
//     STARTUP, so the value applies to the NEXT start. This path always
//     works, on every Firefox, with no special flag.
//
//   - SET IT IN THE RUNNING BROWSER (Services.prefs, through a privileged
//     context). The value applies IMMEDIATELY — no restart, no lost tabs.
//     But it needs Firefox to have been started with
//     `--remote-allow-system-access`, which the plugin cannot turn on by
//     itself: it is a start-time flag.
//
// So the default path is the first one, and the second is an accelerator
// that the agent uses when it is available and the user has enabled it.
//
// WHAT THE AGENT MAY SET
//
// Only the profile COPY is touched. The user's real profile is never
// written to — it holds their real cookies, passwords and history, and the
// plugin copies it precisely so that a destructive experiment cannot touch
// the original.

/**
 * What a Firefox preference name may look like.
 *
 * Firefox's own names are dotted lowercase (`network.proxy.type`), but a
 * few use uppercase and digits. Anything outside this shape is rejected:
 * the name ends up inside a `user_pref("…")` line, so a name containing a
 * quote or a newline would be able to inject other preferences.
 */
export const PREF_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]*$/

/**
 * Split a set of preferences into the ones that may be applied and the ones
 * that may not.
 *
 * @param {object} prefs the requested preferences
 * @returns {{valid: object, invalid: Array<{name: string, error: string}>}}
 */
export function validatePrefs(prefs) {
  const valid = {}
  const invalid = []
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    return { valid, invalid: [{ name: '*', error: 'preferences must be an object' }] }
  }
  for (const [name, value] of Object.entries(prefs)) {
    if (!PREF_NAME_PATTERN.test(String(name))) {
      invalid.push({
        name: String(name),
        error: 'preference names must look like "network.proxy.type"',
      })
      continue
    }
    const type = typeof value
    if (type !== 'string' && type !== 'number' && type !== 'boolean') {
      invalid.push({
        name: String(name),
        error: `preference values must be a string, number or boolean (got ${type})`,
      })
      continue
    }
    valid[String(name)] = value
  }
  return { valid, invalid }
}

/**
 * Render preferences as `user_pref(...)` lines.
 *
 * @param {object} prefs
 * @returns {string[]}
 */
export function prefLines(prefs) {
  return Object.entries(prefs || {}).map(([name, value]) => {
    const serialized = typeof value === 'string' ? JSON.stringify(value) : String(value)
    return `user_pref(${JSON.stringify(name)}, ${serialized});`
  })
}

/**
 * Build the expression that sets preferences in a RUNNING Firefox.
 *
 * It runs in a privileged page, where `ChromeUtils` is available, and it
 * picks the setter that matches the value's type: Firefox stores a
 * preference under the type it was first written with, and writing "3" into
 * a string preference silently does nothing.
 *
 * @param {object} prefs
 * @returns {string} a JS expression
 */
export function applyPrefsScript(prefs) {
  const payload = JSON.stringify(prefs || {})
  return `(() => {
    const Services = ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs").Services;
    const wanted = ${payload};
    const applied = [];
    const failed = [];
    for (const [name, value] of Object.entries(wanted)) {
      try {
        if (typeof value === "boolean") Services.prefs.setBoolPref(name, value);
        else if (typeof value === "number") Services.prefs.setIntPref(name, Math.trunc(value));
        else Services.prefs.setStringPref(name, String(value));
        applied.push(name);
      } catch (e) {
        failed.push({ name, error: String(e && e.message || e) });
      }
    }
    return { applied, failed };
  })()`
}
