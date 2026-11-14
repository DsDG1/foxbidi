// lib/firefox/provider/state.js
// Explicit state container for FirefoxProvider.
//
// Centralises per-tab URL tracking, snapshot baselines/history, page-side
// injection scan state, last-acted viewport coordinates, and runtime config
// so prototype mixin modules do not mutate scattered ad-hoc fields directly.

import { DIALOG_POLICY } from '../dialogs.js'
import { DEFAULT_MAX_ELEMENTS } from '../snapshot.js'

const MAX_SNAPSHOT_BASELINES = 20

export class ProviderState {
  /**
   * @param {Record<string, any>} [opts]
   */
  constructor(opts = {}) {
    /** Monotonic formal snapshot id. */
    this.snapshotSeq = 0
    /** @type {Array<Record<string, any>>} */
    this.lastSnapshotElements = []
    /** @type {Map<number, Array<Record<string, any>>>} */
    this.snapshotBaselines = new Map()
    /** @type {Map<string, Array<Record<string, any>>>} */
    this.snapshotByContext = new Map()
    /** @type {Array<Record<string, any>>} */
    this.pageWarnings = []
    /** @type {Array<Record<string, any>>} */
    this.pageSignals = []
    /** @type {string} */
    this.lastUrl = ''
    /** @type {Map<string, string>} */
    this.tabUrls = new Map()
    /** @type {Map<string, {x: number, y: number}>} */
    this.lastActedPoints = new Map()

    /**
     * Runtime configuration shared across tools.
     *
     * @type {{
     *   preset: string,
     *   dialogPolicy: string,
     *   maxSnapshotElements: number,
     *   inlineSnapshot: boolean,
     *   snapshotFormat: 'records' | 'compact',
     * }}
     */
    this.config = {
      preset: opts.preset || 'basic',
      dialogPolicy: opts.dialogPolicy || DIALOG_POLICY.AUTO_DISMISS,
      maxSnapshotElements: opts.maxSnapshotElements || DEFAULT_MAX_ELEMENTS,
      inlineSnapshot: opts.inlineSnapshot !== false,
      snapshotFormat: opts.snapshotFormat === 'compact' ? 'compact' : 'records',
    }
  }

  /**
   * Record a formal snapshot baseline and advance `snapshotSeq`.
   *
   * @param {string} contextId
   * @param {Array<Record<string, any>>} elements
   * @returns {number} the new snapshotId
   */
  recordBaseline(contextId, elements) {
    this.snapshotSeq += 1
    this.lastSnapshotElements = elements
    if (contextId) {
      this.snapshotByContext.set(contextId, elements)
    }
    this.snapshotBaselines.set(this.snapshotSeq, elements)
    while (this.snapshotBaselines.size > MAX_SNAPSHOT_BASELINES) {
      const oldest = this.snapshotBaselines.keys().next().value
      if (oldest === undefined) break
      this.snapshotBaselines.delete(oldest)
    }
    return this.snapshotSeq
  }

  /**
   * Resolve a baseline for a `since` delta query.
   *
   * @param {string} contextId
   * @param {number|null} [since]
   * @returns {Array<Record<string, any>>}
   */
  resolveBaseline(contextId, since = null) {
    if (since !== null && this.snapshotBaselines.has(since)) {
      return this.snapshotBaselines.get(since) || []
    }
    if (contextId && this.snapshotByContext.has(contextId)) {
      return this.snapshotByContext.get(contextId) || []
    }
    return this.lastSnapshotElements
  }

  /**
   * Read the latest baseline for a context without mutating state.
   *
   * @param {string} contextId
   * @returns {Array<Record<string, any>>}
   */
  contextBaseline(contextId) {
    return (contextId && this.snapshotByContext.get(contextId)) || this.lastSnapshotElements
  }

  /**
   * Remember the coordinates of the element most recently acted on in a tab.
   *
   * @param {string} contextId
   * @param {number} x
   * @param {number} y
   */
  recordActedPoint(contextId, x, y) {
    if (!contextId || !Number.isFinite(x) || !Number.isFinite(y)) return
    this.lastActedPoints.set(contextId, { x, y })
  }

  /**
   * @param {string} contextId
   * @returns {{x: number, y: number}|null}
   */
  getActedPoint(contextId) {
    return (contextId && this.lastActedPoints.get(contextId)) || null
  }

  /**
   * Record a known URL for a tab, optionally clearing previous page scan warnings.
   *
   * @param {string} contextId
   * @param {string} url
   * @param {{updateLastUrl?: boolean, clearScan?: boolean}} [opts]
   */
  recordUrl(contextId, url, opts = {}) {
    if (contextId && url) {
      this.tabUrls.set(contextId, url)
    }
    if (opts.updateLastUrl !== false && url !== undefined) {
      this.lastUrl = url
    }
    if (opts.clearScan) {
      this.pageWarnings = []
      this.pageSignals = []
    }
  }

  /**
   * Apply a completed visibility scan without overwriting state on scan failure.
   *
   * @param {{ok: boolean, warnings: Array<Record<string, any>>, signals: Array<Record<string, any>>}} scan
   */
  applyScan(scan) {
    if (!scan || !scan.ok) return
    this.pageWarnings = scan.warnings
    this.pageSignals = scan.signals
  }

  /**
   * Remove per-tab state when a browsing context is destroyed.
   *
   * @param {string} contextId
   */
  dropContext(contextId) {
    if (!contextId) return
    this.tabUrls.delete(contextId)
    this.snapshotByContext.delete(contextId)
    this.lastActedPoints.delete(contextId)
  }
}
