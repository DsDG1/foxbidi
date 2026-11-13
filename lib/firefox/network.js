// lib/firefox/network.js
// Network request capture and querying.
//
// WHY THIS IS WORTH THE CODE
//
// When a page "does nothing" after a click, the most common cause is a
// failed request (a 4xx/5xx, a blocked third-party call, a CORS refusal).
// The agent needs that evidence. Before this module the plugin only
// captured console logs — the network layer was entirely unexploited even
// though Firefox exposes the events.
//
// SUBSCRIPTION IS PER-EVENT
//
// Firefox's `session.subscribe` is all-or-nothing: one invalid event name
// voids the whole batch. So each event is subscribed to individually and a
// failure is recorded rather than propagated.
//
// REDACTION
//
// This browser carries the user's real login state, so request URLs can
// carry session tokens in their query string. Every URL is stripped of its
// query and fragment before it leaves this module, and no headers, cookies
// or bodies are ever captured.

/** Maximum number of requests kept in the ring buffer. */
export const MAX_ENTRIES = 500

/** The network events this module subscribes to. */
export const NETWORK_EVENTS = [
  'network.beforeRequestSent',
  'network.responseCompleted',
  'network.fetchError',
  'network.authRequired',
]

/**
 * Strip the sensitive parts of a URL.
 *
 * Query strings and fragments routinely carry tokens, and this browser has
 * real credentials, so they never leave the plugin.
 *
 * @param {string} url
 * @returns {string}
 */
export function sanitizeUrl(url) {
  if (typeof url !== 'string' || !url) return ''
  try {
    const parsed = new URL(url)
    const protocol = parsed.protocol

    // http(s): the origin plus the path is everything an agent needs.
    if (protocol === 'http:' || protocol === 'https:') {
      return `${parsed.origin}${parsed.pathname}`
    }

    // A `data:` URL's "path" IS the page payload — the HTML of the document
    // itself. Emitting it would put page content (and whatever it contains)
    // into the log, so only the media type survives.
    if (protocol === 'data:') {
      const mediaType = (parsed.pathname || '').split(',')[0]
      return mediaType ? `data:${mediaType}` : 'data:'
    }

    // Every other scheme (blob:, about:, file:, view-source:, chrome:) is
    // opaque: keep the scheme and the path, drop query and fragment.
    const cleaned = `${protocol}${parsed.pathname}`
    const cut = cleaned.search(/[?#]/)
    return cut === -1 ? cleaned : cleaned.slice(0, cut)
  } catch {
    // Not a parseable absolute URL — strip at the first ? or # by hand.
    const cut = url.search(/[?#]/)
    return cut === -1 ? url : url.slice(0, cut)
  }
}

/**
 * Classify a response status into a filter-friendly bucket.
 *
 * @param {number|null|undefined} status
 * @param {string|null|undefined} [errorText]
 * @returns {'2xx'|'3xx'|'4xx'|'5xx'|'error'|'pending'}
 */
export function statusBucket(status, errorText) {
  if (errorText) return 'error'
  if (status === null || status === undefined) return 'pending'
  if (status >= 500) return '5xx'
  if (status >= 400) return '4xx'
  if (status >= 300) return '3xx'
  if (status >= 200) return '2xx'
  return 'pending'
}

/**
 * A bounded, in-memory ring buffer of observed requests.
 */
export class NetworkLog {
  constructor(limit = MAX_ENTRIES) {
    this.limit = limit
    this.entries = []
    this.sequence = 0
    /** @type {Map<string, object>} */
    this._byRequestId = new Map()
  }

  /**
   * Record or update an observed request.
   *
   * When `requestId` matches an existing entry, the entry is updated in place
   * so `beforeRequestSent` → `responseCompleted` / `fetchError` transitions
   * settle the pending record instead of leaving zombie `'pending'` entries.
   *
   * @param {object} entry
   * @param {string} [entry.requestId]
   * @param {string} [entry.contextId]
   * @param {string} [entry.phase]      'start' | 'complete' | 'error' | 'auth'
   * @param {string} entry.method
   * @param {string} entry.url
   * @param {string} [entry.type]      resource type
   * @param {number|null} [entry.status]
   * @param {string} [entry.errorText]  failure reason
   * @param {number} [entry.durationMs]
   * @param {string} [entry.mimeType]
   * @param {number} [entry.bytes]
   * @param {number} [entry.at]
   */
  record(entry) {
    const now = entry.at !== undefined ? entry.at : Date.now()
    const requestId = entry.requestId ? String(entry.requestId) : null
    const contextId = entry.contextId ? String(entry.contextId) : null

    if (requestId && this._byRequestId.has(requestId)) {
      const existing = this._byRequestId.get(requestId)
      this.sequence += 1
      existing.seq = this.sequence
      if (contextId && !existing.contextId) existing.contextId = contextId
      if (entry.method) existing.method = entry.method
      if (entry.url) existing.url = sanitizeUrl(entry.url)
      if (entry.type && (existing.type === 'other' || !existing.type)) existing.type = entry.type

      if (entry.phase === 'start') {
        existing.status = null
        existing.error = null
        existing.bucket = 'pending'
        return existing
      }

      if (entry.status !== undefined) existing.status = entry.status
      existing.error = entry.errorText || null
      existing.bucket = statusBucket(existing.status, existing.error)
      existing.durationMs =
        entry.durationMs !== undefined ? entry.durationMs : Math.max(0, now - (existing.at || now))
      if (entry.mimeType) existing.mimeType = entry.mimeType
      if (entry.bytes !== undefined) existing.bytes = entry.bytes
      return existing
    }

    this.sequence += 1
    const status = entry.status === undefined ? null : entry.status
    const error = entry.errorText || null
    const bucket = statusBucket(status, error)
    const rec = {
      seq: this.sequence,
      requestId,
      contextId,
      method: entry.method || 'GET',
      url: sanitizeUrl(entry.url),
      type: entry.type || 'other',
      status,
      bucket,
      error,
      durationMs: entry.durationMs === undefined ? null : entry.durationMs,
      at: now,
    }
    if (entry.mimeType) rec.mimeType = entry.mimeType
    if (entry.bytes !== undefined) rec.bytes = entry.bytes

    this.entries.push(rec)
    if (requestId) this._byRequestId.set(requestId, rec)
    if (this.entries.length > this.limit) {
      const removed = this.entries.splice(0, this.entries.length - this.limit)
      for (const item of removed) {
        if (item.requestId && this._byRequestId.get(item.requestId) === item) {
          this._byRequestId.delete(item.requestId)
        }
      }
    }
    return rec
  }

  /**
   * Count active in-flight BiDi requests (`bucket === 'pending'` with a tracked
   * `requestId`), optionally scoped to a browsing context and bounded by age so
   * long-lived SSE streams do not block network-idle checks indefinitely.
   *
   * @param {string} [contextId]
   * @param {number} [maxAgeMs]
   * @returns {number}
   */
  pendingCount(contextId, maxAgeMs = 30000) {
    const now = Date.now()
    let count = 0
    for (const e of this.entries) {
      if (e.bucket !== 'pending' || !e.requestId) continue
      if (contextId && e.contextId && e.contextId !== contextId) continue
      if (maxAgeMs > 0 && now - (e.at || 0) >= maxAgeMs) continue
      count += 1
    }
    return count
  }

  /**
   * Latest sequence number observed globally or for a specific context.
   *
   * @param {string} [contextId]
   * @returns {number}
   */
  lastActivitySeq(contextId) {
    if (!contextId) return this.sequence
    let maxSeq = 0
    for (const e of this.entries) {
      if (e.contextId && e.contextId !== contextId) continue
      if (e.seq > maxSeq) maxSeq = e.seq
    }
    return maxSeq
  }

  /**
   * Query the buffer.
   *
   * @param {object} [opts]
   * @param {string[]} [opts.status]  buckets to keep, e.g. ['4xx','5xx','error']
   * @param {string} [opts.filter]    case-insensitive substring of the URL
   * @param {string[]} [opts.types]   resource types to keep
   * @param {string} [opts.contextId] browsing context filter
   * @param {number} [opts.afterSeq]   only entries newer than this sequence
   * @param {number} [opts.limit]     max entries returned (default 50)
   * @returns {{count: number, total: number, lastSequence: number, requests: Array}}
   */
  query(opts = {}) {
    const status = opts.status && opts.status.length ? new Set(opts.status) : null
    const types = opts.types && opts.types.length ? new Set(opts.types) : null
    const filter = opts.filter ? opts.filter.toLowerCase() : null
    const contextId = opts.contextId || null
    const afterSeq = opts.afterSeq || 0
    const limit = opts.limit === undefined ? 50 : Math.max(1, opts.limit)

    const matched = this.entries.filter((e) => {
      if (e.seq <= afterSeq) return false
      if (contextId && e.contextId && e.contextId !== contextId) return false
      if (status && !status.has(e.bucket)) return false
      if (types && !types.has(e.type)) return false
      if (filter && !e.url.toLowerCase().includes(filter)) return false
      return true
    })

    const page = matched.slice(-limit)
    return {
      count: page.length,
      total: matched.length,
      lastSequence: this.sequence,
      requests: page,
    }
  }

  /** Drop every recorded entry. */
  clear() {
    this.entries = []
    this._byRequestId.clear()
  }
}

/**
 * Compute request duration from BiDi fetch timing info when available.
 *
 * @param {object} [timings]
 * @returns {number|undefined}
 */
function timingDurationMs(timings) {
  if (!timings || typeof timings !== 'object') return undefined
  const start = timings.requestStart || timings.fetchStart
  const end = timings.responseEnd || timings.responseStart
  if (typeof start === 'number' && typeof end === 'number' && end >= start && start > 0) {
    return Math.round(end - start)
  }
  return undefined
}

/**
 * Attach a network log to a live BiDi client.
 *
 * @param {import('../bidi/client.js').BidiClient} client
 * @param {NetworkLog} log
 * @returns {Promise<{subscribed: string[], failed: Array}>}
 */
export async function attachNetworkLog(client, log) {
  const { subscribe } = await import('../bidi/protocol.js')
  const { subscribed, failed } = await subscribe(client, NETWORK_EVENTS)

  client.on('event', (method, params) => {
    if (method === 'network.beforeRequestSent') {
      const req = params?.request || {}
      log.record({
        requestId: req.request,
        contextId: params?.context || null,
        phase: 'start',
        method: req.method,
        url: req.url,
        type: params?.type || params?.initiator?.type || 'other',
        status: null,
      })
      return
    }
    if (method === 'network.responseCompleted') {
      const req = params?.request || {}
      const res = params?.response || {}
      log.record({
        requestId: req.request,
        contextId: params?.context || null,
        phase: 'complete',
        method: req.method,
        url: req.url,
        type: params?.type || 'other',
        status: res.status,
        mimeType: res.mimeType || undefined,
        bytes: typeof res.bytesReceived === 'number' ? res.bytesReceived : undefined,
        durationMs: timingDurationMs(req.timings),
      })
      return
    }
    if (method === 'network.fetchError') {
      const req = params?.request || {}
      log.record({
        requestId: req.request,
        contextId: params?.context || null,
        phase: 'error',
        method: req.method,
        url: req.url,
        type: params?.type || 'other',
        status: null,
        errorText: params?.errorText || 'request failed',
      })
      return
    }
    if (method === 'network.authRequired') {
      const req = params?.request || {}
      const res = params?.response || {}
      log.record({
        requestId: req.request,
        contextId: params?.context || null,
        phase: 'auth',
        method: req.method,
        url: req.url,
        type: params?.type || 'other',
        status: res.status ?? 401,
        errorText: 'authentication required',
      })
    }
  })

  return { subscribed, failed }
}
