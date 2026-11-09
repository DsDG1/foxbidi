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
 * @returns {'2xx'|'3xx'|'4xx'|'5xx'|'error'|'pending'}
 */
export function statusBucket(status) {
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
  }

  /**
   * Record an observed request.
   *
   * @param {object} entry
   * @param {string} entry.method
   * @param {string} entry.url
   * @param {string} [entry.type]      resource type
   * @param {number} [entry.status]
   * @param {string} [entry.errorText]  failure reason
   * @param {number} [entry.durationMs]
   */
  record(entry) {
    this.sequence += 1
    const bucket = statusBucket(entry.status)
    this.entries.push({
      seq: this.sequence,
      method: entry.method || 'GET',
      url: sanitizeUrl(entry.url),
      type: entry.type || 'other',
      status: entry.status === undefined ? null : entry.status,
      bucket,
      error: entry.errorText || null,
      durationMs: entry.durationMs === undefined ? null : entry.durationMs,
      at: Date.now(),
    })
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit)
    }
  }

  /**
   * Query the buffer.
   *
   * @param {object} [opts]
   * @param {string[]} [opts.status]  buckets to keep, e.g. ['4xx','5xx','error']
   * @param {string} [opts.filter]    case-insensitive substring of the URL
   * @param {string[]} [opts.types]   resource types to keep
   * @param {number} [opts.afterSeq]   only entries newer than this sequence
   * @param {number} [opts.limit]     max entries returned (default 50)
   * @returns {{count: number, total: number, lastSequence: number, requests: Array}}
   */
  query(opts = {}) {
    const status = opts.status && opts.status.length ? new Set(opts.status) : null
    const types = opts.types && opts.types.length ? new Set(opts.types) : null
    const filter = opts.filter ? opts.filter.toLowerCase() : null
    const afterSeq = opts.afterSeq || 0
    const limit = opts.limit === undefined ? 50 : Math.max(1, opts.limit)

    const matched = this.entries.filter((e) => {
      if (e.seq <= afterSeq) return false
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
  }
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
        method: req.method,
        url: req.url,
        type: params?.type || 'other',
        status: null,
      })
      return
    }
    if (method === 'network.responseCompleted') {
      const req = params?.request || {}
      const res = params?.response || {}
      log.record({
        method: req.method,
        url: req.url,
        type: params?.type || 'other',
        status: res.status,
        durationMs: params?.timing?.requestTime ? undefined : undefined,
      })
      return
    }
    if (method === 'network.fetchError') {
      const req = params?.request || {}
      log.record({
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
      log.record({
        method: req.method,
        url: req.url,
        type: params?.type || 'other',
        status: null,
        errorText: 'authentication required',
      })
    }
  })

  return { subscribed, failed }
}
