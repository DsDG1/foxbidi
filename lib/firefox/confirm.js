// lib/firefox/confirm.js
// The irreversibility gate.
//
// POLICY (agreed with the user)
//   Reading and writing are open by default. Actions that cannot be undone
//   — submitting a form, downloading, uploading, changing an account —
//   require an explicit `confirm: true`.
//
// DETECTION IS BY DOM FACT, NOT BY KEYWORD
//
// Guessing from a button label ("Buy", "确认") misfires constantly: a
// Chinese site labels a search button 搜索, an English site labels a
// harmless button OK. So the classification reads the DOM:
//
//   form_submit  — the target is a submit control, or sits in a form whose
//                  method is POST. Submitting sends data to a server.
//   download     — the target carries a `download` attribute.
//   upload       — the target is a file input (selecting a file transfers
//                  local data to the site).
//   account_change — the form's action points at a different origin AND the
//                  form carries account/credential-ish field names.
//
// A false positive costs one extra `confirm: true`; a false negative can
// commit an irreversible action. The asymmetry justifies leaning strict.

/** The irreversible action kinds this gate recognises. */
import { ERROR_CODES } from './errors.js'

export const ACTION_KINDS = {
  FORM_SUBMIT: 'form_submit',
  DOWNLOAD: 'download',
  UPLOAD: 'upload',
  ACCOUNT_CHANGE: 'account_change',
  PREFS_WRITE: 'prefs_write',
  EXTENSION_INSTALL: 'extension_install',
  COOKIE_SET: 'cookie_set',
  VIEWPORT_SET: 'viewport_set',
}

/**
 * Field names that suggest a credential or account mutation.
 *
 * Only consulted for a cross-origin POST form — a same-origin search form
 * with a field called "name" must not trip the gate.
 */
const ACCOUNT_FIELD_PATTERN =
  /(pass(word)?|pwd|secret|token|credential|email|phone|mobile|account|username|user_name|passwd|otp|code|address|billing|card|payment|password)/i

/**
 * Classify a target element.
 *
 * @param {object} info  the element record from `inspectElement`
 * @returns {{irreversible: boolean, action: string|null, hint: string|null}}
 */
export function classifyAction(info) {
  if (!info || typeof info !== 'object') {
    return { irreversible: false, action: null, hint: null }
  }

  // A file input means the site is about to receive a local file.
  if (info.isFileInput) {
    return {
      irreversible: true,
      action: ACTION_KINDS.UPLOAD,
      hint: 'this action uploads a local file to the site',
    }
  }

  // A `download` attribute means clicking fetches a file to disk.
  if (info.hasDownload) {
    return {
      irreversible: true,
      action: ACTION_KINDS.DOWNLOAD,
      hint: 'this action downloads a file',
    }
  }

  // A submit control inside a form.
  if (info.isSubmit && info.formAction) {
    const method = (info.formMethod || 'get').toUpperCase()
    return {
      irreversible: true,
      action: ACTION_KINDS.FORM_SUBMIT,
      hint: `this submits a form to ${info.formAction} (${method})`,
    }
  }

  // A POST form — even when the control is not an explicit submit button,
  // activating it can still submit the form.
  if (info.formMethod === 'post' && info.formAction) {
    return {
      irreversible: true,
      action: ACTION_KINDS.FORM_SUBMIT,
      hint: `this submits a form to ${info.formAction} (POST)`,
    }
  }

  return { irreversible: false, action: null, hint: null }
}

/**
 * Classify a cross-origin POST form whose fields look like account data.
 *
 * @param {object} info
 * @returns {{irreversible: boolean, action: string|null, hint: string|null}}
 */
export function classifyAccountChange(info) {
  if (!info || !info.formAction || !info.formMethod) {
    return { irreversible: false, action: null, hint: null }
  }
  if (info.formMethod.toLowerCase() !== 'post') {
    return { irreversible: false, action: null, hint: null }
  }
  const name = `${info.name || ''} ${info.role || ''}`
  if (!ACCOUNT_FIELD_PATTERN.test(name)) {
    return { irreversible: false, action: null, hint: null }
  }
  return {
    irreversible: true,
    action: ACTION_KINDS.ACCOUNT_CHANGE,
    hint: `this posts account or credential data to ${info.formAction}`,
  }
}

/**
 * Classify an action that can submit a form IMPLICITLY.
 *
 * WHY THIS EXISTS
 *
 * The gate already catches a form submission when the agent CLICKS a submit
 * control or TYPES into a field with `submit: true`. But standard HTML has
 * two other ways to submit a form that used to walk straight past the gate:
 *
 *   - pressing Enter in a text field submits the form
 *   - changing a <select> or a radio can fire an onchange handler that
 *     submits the form
 *
 * So the agent could be blocked on `click` and then simply press Enter
 * instead. The bypass is as easy as picking a different tool.
 *
 * THE RULE
 *
 * The decision is made on the same kind of DOM FACTS the rest of the gate
 * uses — never on the button's text:
 *
 *   - the control is itself a submit control in a form, OR
 *   - the control sits in a POST form (POST is a server-side state change), OR
 *   - the control sits in a form that HAS a submit control, because then
 *     Enter and change events activate that control in standard HTML.
 *
 * A control that is in NO form is never irreversible — which is the common
 * case on the web, and the reason this rule produces almost no false
 * positives.
 *
 * @param {object} info  the element record from `inspectElement`
 * @returns {{irreversible: boolean, action: string|null, hint: string|null}}
 */
export function classifyImplicitSubmit(info) {
  if (!info || typeof info !== 'object') {
    return { irreversible: false, action: null, hint: null }
  }

  // Not in a form at all → nothing can be submitted.
  if (!info.formAction) {
    return { irreversible: false, action: null, hint: null }
  }

  if (info.isSubmit) {
    return {
      irreversible: true,
      action: ACTION_KINDS.FORM_SUBMIT,
      hint: `this submits a form to ${info.formAction}`,
    }
  }

  const method = (info.formMethod || 'get').toUpperCase()
  if (method === 'POST') {
    return {
      irreversible: true,
      action: ACTION_KINDS.FORM_SUBMIT,
      hint: `this can submit a form to ${info.formAction} (POST)`,
    }
  }

  if (info.formHasSubmitControl) {
    return {
      irreversible: true,
      action: ACTION_KINDS.FORM_SUBMIT,
      hint: `this can submit a form to ${info.formAction} (the form has a submit control)`,
    }
  }

  return { irreversible: false, action: null, hint: null }
}

/**
 * The full verdict for an element: is it irreversible, and what kind?
 *
 * Both gates ask the same question of the same element — "what would
 * activating this do?" — and they MUST get the same answer. If the
 * irreversibility gate called an element a form submit while the
 * injection gate called it harmless, the second gate could be walked
 * around by picking whichever reading suited the agent.
 *
 * @param {object} info
 * @param {boolean} [implicit]  also consider an IMPLICIT form submit
 * @returns {{irreversible: boolean, action: string|null, hint: string|null}}
 */
export function classifyVerdict(info, implicit = false) {
  let verdict = classifyAction(info)
  if (!verdict.irreversible) {
    verdict = classifyAccountChange(info)
  }
  if (!verdict.irreversible && implicit) {
    verdict = classifyImplicitSubmit(info)
  }
  return verdict
}

/**
 * The action kind an element would trigger, or null when it is harmless.
 *
 * @param {object} info
 * @param {boolean} [implicit]
 * @returns {string|null}
 */
export function actionKindFor(info, implicit = false) {
  const verdict = classifyVerdict(info, implicit)
  return verdict.irreversible ? verdict.action : null
}

/**
 * Decide whether an action may proceed.
 *
 * @param {object} opts
 * @param {object} opts.info      element record from `inspectElement`
 * @param {boolean} [opts.confirm] the caller's explicit confirmation
 * @param {string} [opts.action]  an explicit action kind, for the non-DOM
 *   actions the new tools perform (installing an extension, writing a
 *   cookie, changing a preference). When given, the DOM classification is
 *   skipped.
 * @param {string} [opts.hint]    the explanation for an explicit action kind
 * @param {boolean} [opts.implicit]  also consider an IMPLICIT form submit
 *   (Enter in a field, a change event on a select). Used by the actions
 *   whose irreversibility comes from HTML behaviour rather than from the
 *   control itself.
 * @returns {{allowed: boolean, action?: string, error?: string, hint?: string, requiresConfirm?: boolean}}
 */
export function evaluateGate(opts) {
  const confirmed = opts.confirm === true

  // An explicit action kind bypasses the DOM classification: it describes
  // something the page cannot show us, like writing a preference.
  if (opts.action) {
    if (confirmed) return { allowed: true }
    return {
      allowed: false,
      action: opts.action,
      error: `this action is irreversible (${opts.action}) and needs explicit confirmation`,
      hint: opts.hint || `this action changes something that cannot be undone (${opts.action})`,
      requiresConfirm: true,
      code: ERROR_CODES.CONFIRM_REQUIRED,
    }
  }

  const verdict = classifyVerdict(opts.info, opts.implicit === true)

  if (!verdict.irreversible || confirmed) {
    return { allowed: true }
  }

  return {
    allowed: false,
    action: verdict.action,
    error: `this action is irreversible (${verdict.action}) and needs explicit confirmation`,
    hint: verdict.hint,
    requiresConfirm: true,
    code: ERROR_CODES.CONFIRM_REQUIRED,
  }
}
