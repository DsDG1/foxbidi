// lib/firefox/provider/captcha.js
// CAPTCHA detection and solving.
//
// The methods below were moved here verbatim from the single FirefoxProvider
// class. They stay prototype methods, so `this` means exactly what it meant
// before: the provider instance, with its client, registry key, log buffer
// and dialog manager.

/**
 * The captcha methods.
 *
 * @type an object of methods
 */
import { solveCaptcha, checkSolved } from '../captcha.js'
import { ERROR_CODES, classifyError, fail } from '../errors.js'

export const captchaMethods = {
  /**
   * Solve a CAPTCHA challenge on the current page.
   *
   * The challenge is detected first, then handed to the solver that knows how
   * to answer it. A solve is only reported as successful when the SITE
   * issued a token — a click that "worked" is not a solved challenge.
   *
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} [opts.solver]     'auto' (default) or a challenge id
   * @param {string} [opts.sttUrl]      speech-to-text endpoint (audio challenges)
   * @param {string} [opts.visionUrl]   image-recognition endpoint (image grids)
   * @param {number} [opts.timeoutMs]
   */
  async captcha(contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    if (!target) {
      return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')
    }
    try {
      const result = await solveCaptcha({
        client: this.client,
        topContextId: target,
        preloadInstalled: this._captchaPreloads,
        solver: opts.solver,
        sttUrl: opts.sttUrl,
        visionUrl: opts.visionUrl,
        timeoutMs: opts.timeoutMs,
      })
      return { ...result, contextId: target }
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: target })
    }
  },
  /**
   * Report whether a challenge of the given kind is currently solved.
   *
   * @param {string} [contextId]
   * @param {object} [opts]
   * @param {string} opts.kind  the challenge id
   */
  async captchaStatus(contextId, opts = {}) {
    if (!(await this._ensureReady())) {
      return fail(ERROR_CODES.NOT_RUNNING, this.error || 'firefox provider is not running')
    }
    const target = await this._resolveContext(contextId)
    if (!target) {
      return fail(ERROR_CODES.NO_CONTEXT, 'no browsing context available')
    }
    try {
      const state = await checkSolved(this.client, target, opts.kind)
      return { ok: true, ...state, contextId: target }
    } catch (e) {
      return fail(classifyError(e), e.message, { contextId: target })
    }
  },
}
