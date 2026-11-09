// lib/firefox/fingerprint.js
// The page fingerprint used to tell whether an action changed anything.
//
// WHY A FINGERPRINT
//
// An action that "ran without effect" and an action that "succeeded" look
// identical from the outside unless something observable is compared before
// and after. This is that something: a cheap summary of the page state.
//
// WHAT IT COVERS
//
//   - the body's child count (a re-render changes it)
//   - the visible text length (content changes change it)
//   - the FOCUSED FIELD'S VALUE (typing changes it)
//
// The third part is the one that used to be missing. An <input>'s value is
// not part of innerText, so typing into a field left the fingerprint
// untouched and every typing action was reported as having had no effect —
// even though the characters really were sent. An agent that trusted that
// signal would retry the typing and append the text twice.
//
// SECURITY
//
// A password field's value is never read into the fingerprint. The check is
// on the input's type attribute, so a password never enters the string that
// gets compared, logged, or returned.

/**
 * The expression evaluated inside the page to produce the fingerprint.
 *
 * It must be self-contained: it is serialized and sent to the browser, so it
 * cannot close over anything in this module.
 */
export const FINGERPRINT_EXPRESSION = `(() => {
  const b = document.body;
  const a = document.activeElement;
  // The focused field's value — but never a password's.
  let focused = '';
  if (a && typeof a.value === 'string') {
    const type = (a.getAttribute('type') || '').toLowerCase();
    if (type !== 'password') focused = a.tagName + '#' + (a.id || a.name || '') + '=' + a.value;
  }
  return {
    url: location.href,
    title: document.title || '',
    fingerprint: (b ? b.children.length : 0) + ":" + ((b && b.innerText || "").length) + ":" + focused,
  };
})()`
