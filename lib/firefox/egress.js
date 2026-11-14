// lib/firefox/egress.js
// An optional local egress proxy.
//
// WHY THIS EXISTS
//
// Some environments let a program open a socket to the loopback interface
// but not to the outside world: the browser process is walled off from the
// network, while the machine itself is not. A proxy on 127.0.0.1 is the one
// route that is still open — the browser can always reach loopback.
//
// So when `browser_net_check` reports `firefox_egress_blocked`, this
// module gives the browser a way out: a forward proxy on the loopback
// interface that resolves names and opens the connections itself.
//
// WHAT IT IS NOT
//
//   - It is OFF by default. Nothing starts it without an explicit
//     `browser_egress {action:"start"}`.
//   - It does not decrypt anything. HTTPS goes through a CONNECT tunnel and
//     the end-to-end TLS stays between the browser and the site.
//   - It is not a general-purpose proxy for the machine. It refuses
//     private, loopback and link-local targets, so it cannot be used to
//     reach the user's own network or the services running on this host.
//
// THE RESOLVER
//
// Name resolution is the first thing that fails in these environments, so
// the proxy does not rely on it: the system resolver is tried first, and
// when it comes up empty a DoH request is made to a resolver reached by its
// literal IP address (which needs no DNS of its own).

import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import dns from 'node:dns/promises'
import net from 'node:net'
import { isPrivateHost } from './navigation-policy.js'

/** The ports the proxy will connect to. */
export const ALLOWED_PORTS = [80, 443]

/** The DoH endpoint used when the system resolver cannot answer. */
export const DEFAULT_DOH_URI = 'https://doh.pub/dns-query'

/** The literal address the DoH endpoint is reached at. */
export const DEFAULT_DOH_BOOTSTRAP = '1.12.12.12'

/**
 * Read the DoH settings from the environment.
 *
 * @param {Record<string, any>} [env]
 * @returns {{uri: string, bootstrap: string}}
 */
export function dohSettings(env = process.env) {
  return {
    uri: String(env.FIREFOX_BROWSER_DOH_URI || DEFAULT_DOH_URI).trim() || DEFAULT_DOH_URI,
    bootstrap: String(env.FIREFOX_BROWSER_DOH_BOOTSTRAP || DEFAULT_DOH_BOOTSTRAP).trim(),
  }
}

/**
 * Is this target allowed to leave the machine?
 *
 * Two checks, in this order:
 *
 *   1. The NAME must not be a private name (localhost and friends), and
 *      the PORT must be one a web page uses.
 *   2. Every ADDRESS the name resolves to must be a public address. The
 *      second check is the one that matters: a name that points at the
 *      user's LAN is not private by name at all.
 *
 * The private checks are lifted by the same switch that lifts them for
 * navigation — `FIREFOX_BROWSER_ALLOW_PRIVATE_HOSTS=1` — so an operator
 * who wants the proxy to reach a local service can say so.
 *
 * @param {string} host
 * @param {number} port
 * @param {object} [opts]
 * @param {boolean} [opts.allowPrivateHosts]
 * @param {number[]} [opts.ports]
 * @returns {{allowed: boolean, reason?: string}}
 */
export function checkTarget(host, port, opts = {}) {
  const allowPrivate = opts.allowPrivateHosts === true
  const ports = opts.ports || ALLOWED_PORTS
  const name = String(host || '')
    .trim()
    .toLowerCase()
  if (!name) return { allowed: false, reason: 'empty host' }
  if (!allowPrivate && isPrivateHost(name)) {
    return { allowed: false, reason: 'private or loopback host' }
  }
  if (!ports.includes(Number(port))) {
    return { allowed: false, reason: `port ${port} is not a web port` }
  }
  return { allowed: true }
}

/**
 * Resolve a name to IPv4 addresses, over DoH when the system cannot.
 *
 * @param {string} host
 * @param {object} [opts]
 * @param {string} [opts.uri]       the DoH endpoint
 * @param {string} [opts.bootstrap] the literal address of that endpoint
 * @returns {Promise<string[]>}
 */
export async function resolveHost(host, opts = {}) {
  const settings = { ...dohSettings(), ...opts }
  try {
    const results = await dns.lookup(host, { all: true })
    const addresses = results.map((r) => r.address).filter((a) => net.isIPv4(a))
    if (addresses.length) return addresses
  } catch {
    // The system resolver knows nothing about this name — try DoH.
  }
  return resolveViaDoH(host, settings)
}

/**
 * Resolve a name over DoH, reaching the resolver by its literal address.
 *
 * @param {string} host
 * @param {Record<string, any>} settings
 * @returns {Promise<string[]>}
 */
export async function resolveViaDoH(host, settings) {
  const url = new URL(settings.uri)
  const path = `${url.pathname}?name=${encodeURIComponent(host)}&type=A`
  const body = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: url.hostname,
        port: url.port || 443,
        path,
        method: 'GET',
        headers: { accept: 'application/dns-json', host: url.host },
        // The resolver is reached by its literal address: asking the system
        // resolver for the resolver's own name is exactly the circular
        // dependency this whole path exists to avoid.
        lookup: (hostname, options, callback) => {
          if (options && options.all) {
            callback(null, [{ address: settings.bootstrap, family: 4 }])
          } else {
            callback(null, settings.bootstrap, 4)
          }
        },
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => resolve(data))
      },
    )
    req.setTimeout(8000, () => req.destroy(new Error('DoH request timed out')))
    req.on('error', reject)
    req.end()
  })

  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('DoH response was not JSON')
  }
  const answers = (parsed.Answer || []).filter((a) => a.type === 1).map((a) => a.data)
  if (!answers.length) throw new Error(`no A record for ${host}`)
  return answers
}

/**
 * Open a connection to a resolved address.
 *
 * @param {string[]} addresses
 * @param {number} port
 * @param {object} [opts]
 * @param {boolean} [opts.allowPrivateHosts]
 * @returns {Promise<net.Socket>}
 */
async function connectTo(addresses, port, opts = {}) {
  let last = null
  for (const address of addresses) {
    // The name check above is not enough: the ADDRESS has to be public too.
    if (!opts.allowPrivateHosts && isPrivateHost(address)) continue
    try {
      return await new Promise((resolve, reject) => {
        const onTimeout = () => {
          socket.destroy()
          reject(new Error('connect timed out'))
        }
        const socket = net.connect({ host: address, port }, () => {
          socket.setTimeout(0, onTimeout)
          socket.removeListener('error', reject)
          resolve(socket)
        })
        socket.once('error', reject)
        socket.setTimeout(15000, onTimeout)
      })
    } catch (e) {
      last = e
    }
  }
  throw last || new Error('no usable address')
}

/**
 * The local egress proxy.
 */
export class EgressProxy {
  /**
   * @param {object} [opts]
   * @param {(event: Record<string, any>) => void} [opts.onEvent] called for every connection
   * @param {boolean} [opts.allowPrivateHosts]
   * @param {number[]} [opts.ports]
   */
  constructor(opts = {}) {
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {}
    this.allowPrivateHosts =
      opts.allowPrivateHosts !== undefined
        ? opts.allowPrivateHosts === true
        : String(process.env.FIREFOX_BROWSER_ALLOW_PRIVATE_HOSTS || '0').trim() === '1'
    /**
     * The ports the proxy may connect to.
     *
     * The default is the two web ports. It is configurable so the proxy
     * can be pointed at a service on another port in a test or in a
     * deliberately narrow setup — the default stays narrow.
     */
    this.ports = Array.isArray(opts.ports) && opts.ports.length ? opts.ports : ALLOWED_PORTS
    this._server = null
    this._port = null
    this._connections = 0
    this._refused = []
    /**
     * The open sockets.
     *
     * `server.close()` only stops the listener — it waits for the open
     * connections to end on their own. Firefox holds keep-alive connections
     * to the proxy, so waiting for them would hang the stop forever. The
     * sockets are tracked so they can be dropped instead of waited for.
     *
     * @type {Set<import('node:net').Socket>}
     */
    this._sockets = new Set()
  }

  /**
   * Remember a socket so it can be dropped when the proxy stops.
   *
   * @param {import('node:net').Socket} socket
   */
  _track(socket) {
    if (!socket) return socket
    this._sockets.add(socket)
    socket.once('close', () => this._sockets.delete(socket))
    return socket
  }

  /** Is the proxy listening? */
  get running() {
    return !!this._server
  }

  /** The port it listens on. */
  get port() {
    return this._port
  }

  /**
   * Start listening.
   *
   * @returns {Promise<{ok: boolean, port?: number, error?: string}>}
   */
  async start() {
    if (this._server) return { ok: true, port: this._port }
    const server = http.createServer()
    // Track at the connection level: a socket is accepted before its request
    // is parsed, and a stop that arrives in between must still find it.
    server.on('connection', (socket) => this._track(socket))
    server.on('connect', (req, socket, head) => this._onConnect(req, socket, head))
    server.on('request', (req, res) => this._onRequest(req, res))
    try {
      // Loopback only. Never 0.0.0.0.
      await /** @type {Promise<void>} */ (
        new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject)
            resolve()
          })
        })
      )
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'could not listen' }
    }
    this._server = server
    const addr = server.address()
    this._port = addr && typeof addr === 'object' ? addr.port : 0
    return { ok: true, port: this._port }
  }

  /**
   * Stop listening and drop the connections.
   */
  async stop() {
    const server = this._server
    this._server = null
    this._port = null
    if (!server) return { ok: true, stopped: false }
    await /** @type {Promise<void>} */ (
      new Promise((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve()
        }
        // Stop accepting first...
        try {
          server.close(finish)
        } catch {
          finish()
        }
        // ...then drop what is open. Waiting for the open connections to end on
        // their own would never finish: the browser holds them open.
        for (const socket of this._sockets) {
          try {
            socket.destroy()
          } catch {
            /* best effort */
          }
        }
        this._sockets.clear()
        const timer = setTimeout(finish, 500)
        if (typeof timer.unref === 'function') timer.unref()
      })
    )
    return { ok: true, stopped: true }
  }

  /**
   * The status of the proxy.
   *
   * @returns {Record<string, any>}
   */
  status() {
    return {
      running: this.running,
      port: this._port,
      connections: this._connections,
      refused: this._refused.slice(-10),
    }
  }

  /**
   * Handle a CONNECT request: the browser wants a tunnel to host:port.
   */
  _onConnect(req, socket, head) {
    const target = String(req.url || '')
    const separator = target.lastIndexOf(':')
    const host = separator === -1 ? target : target.slice(0, separator)
    const port = separator === -1 ? 443 : Number(target.slice(separator + 1))
    let activeUpstream = null
    socket.on('error', () => {
      if (activeUpstream) activeUpstream.destroy()
    })
    this._track(socket)
    const verdict = checkTarget(host, port, {
      allowPrivateHosts: this.allowPrivateHosts,
      ports: this.ports,
    })
    if (!verdict.allowed) {
      this._refused.push({ host, port, reason: verdict.reason })
      this.onEvent({ kind: 'refused', host, port, reason: verdict.reason })
      if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    resolveHost(host)
      .then((addresses) =>
        connectTo(addresses, port, { allowPrivateHosts: this.allowPrivateHosts }),
      )
      .then((upstream) => {
        if (socket.destroyed) {
          upstream.destroy()
          return
        }
        activeUpstream = upstream
        this._connections += 1
        this._track(upstream)
        this.onEvent({ kind: 'connect', host, port })
        upstream.on('error', () => socket.destroy())
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head && head.length) upstream.write(head)
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      .catch((e) => {
        this._refused.push({ host, port, reason: (e && e.message) || 'connect failed' })
        this.onEvent({ kind: 'refused', host, port, reason: (e && e.message) || 'connect failed' })
        if (!socket.destroyed) {
          try {
            socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
          } catch {}
        }
      })
  }

  /**
   * Handle a plain HTTP request in absolute-URI form.
   */
  _onRequest(req, res) {
    const target = String(req.url || '')
    // The browser's own connection to the proxy is the one that stays open
    // (keep-alive), so it has to be tracked for the stop to be able to drop
    // it.
    this._track(req.socket)
    if (!/^https?:\/\//i.test(target)) {
      res.writeHead(400).end()
      return
    }
    let parsed
    try {
      parsed = new URL(target)
    } catch {
      res.writeHead(400).end()
      return
    }
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
    const verdict = checkTarget(parsed.hostname, port, {
      allowPrivateHosts: this.allowPrivateHosts,
      ports: this.ports,
    })
    if (!verdict.allowed) {
      this._refused.push({ host: parsed.hostname, port, reason: verdict.reason })
      this.onEvent({ kind: 'refused', host: parsed.hostname, port, reason: verdict.reason })
      res.writeHead(403).end()
      return
    }
    resolveHost(parsed.hostname)
      .then((addresses) =>
        connectTo(addresses, port, { allowPrivateHosts: this.allowPrivateHosts }),
      )
      .then((upstream) => {
        if (req.destroyed || res.destroyed) {
          upstream.destroy()
          return
        }
        this._connections += 1
        this._track(upstream)
        this.onEvent({ kind: 'request', host: parsed.hostname, port, url: target })
        const headers = { ...req.headers }
        delete headers['proxy-connection']
        headers.host = parsed.host
        const clientMod = parsed.protocol === 'https:' ? https : http
        const upReq = clientMod.request(
          {
            hostname: parsed.hostname,
            port,
            path: `${parsed.pathname}${parsed.search}`,
            method: req.method,
            headers,
            agent: false,
            createConnection: () =>
              parsed.protocol === 'https:'
                ? tls.connect({ socket: upstream, servername: parsed.hostname })
                : upstream,
          },
          (upRes) => {
            res.writeHead(upRes.statusCode || 502, upRes.headers)
            upRes.pipe(res)
            upRes.on('error', () => res.destroy())
          },
        )
        upReq.on('error', () => {
          upstream.destroy()
          if (!res.headersSent) {
            res.writeHead(502)
            res.end()
          } else {
            res.destroy()
          }
        })
        res.on('close', () => {
          if (!res.writableEnded) upReq.destroy()
        })
        req.on('error', () => upReq.destroy())
        req.pipe(upReq)
      })
      .catch((e) => {
        this._refused.push({
          host: parsed.hostname,
          port,
          reason: (e && e.message) || 'connect failed',
        })
        this.onEvent({
          kind: 'refused',
          host: parsed.hostname,
          port,
          reason: (e && e.message) || 'connect failed',
        })
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
  }
}
