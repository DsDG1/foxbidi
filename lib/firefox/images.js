// lib/firefox/images.js
// A tiny, loopback-only HTTP server that hands out screenshots by URL.
//
// WHY THIS EXISTS
//
// A screenshot has to reach two different audiences:
//
//   - the MODEL, which gets the PNG as an MCP image content block. That is
//     free for the model — the bytes never become text tokens.
//   - the USER, who is often looking at a chat client (the webui) rather
//     than at the model's tool output. The webui renders the model's reply
//     as markdown, so a plain `![](http://127.0.0.1:PORT/i/TOKEN.png)` in
//     the reply becomes a real picture.
//
// The webui extracts only `content[].type === "text"` from a tool result and
// renders tool output as escaped text, so an MCP image block is invisible
// there, and a base64 data URI inside the tool text would show up as a wall
// of escaped garbage. A URL solves both problems: the picture renders, and
// the image bytes never enter the model's context.
//
// SECURITY
//
// A screenshot can contain anything the user was looking at, so this server
// is deliberately narrow:
//   - it binds 127.0.0.1 only (never 0.0.0.0 — a LAN client would be able
//     to read the user's pages);
//   - the port is chosen by the OS, so it is not guessable either;
//   - the path carries a 192-bit random token, and only tokens that were
//     actually published are served — anything else is a 404;
//   - the files live in a 0700 directory that is removed on stop().

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createReadStream, rmSync } from 'node:fs'
import { join } from 'node:path'

/** The largest screenshot this server will publish. */
export const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024

export class ImageServer {
  /**
   * @param {object} [opts]
   * @param {string} opts.dir        directory the images are written to
   * @param {string} [opts.host]     interface to bind (default '127.0.0.1')
   * @param {number} [opts.maxBytes] per-image size limit
   */
  constructor(opts = {}) {
    if (!opts.dir) throw new Error('ImageServer needs a directory')
    this.dir = opts.dir
    this.host = opts.host || '127.0.0.1'
    this.maxBytes = opts.maxBytes || DEFAULT_MAX_IMAGE_BYTES

    /** @type {Map<string, {path: string, bytes: number}>} token -> published file */
    this._files = new Map()
    this._server = null
    this._port = null
    this._startPromise = null
    this._exitHook = null
  }

  /** Whether the HTTP server is currently listening. */
  get running() {
    return !!this._server && !!this._port
  }

  /**
   * Start the server if it is not running yet.
   *
   * Concurrent callers share one in-flight promise, so the server is only
   * ever started once — the same pattern the browser provider uses for its
   * own start().
   *
   * @returns {Promise<{port:number, baseUrl:string}>}
   */
  async ensureStarted() {
    if (this._server && this._port) {
      return { port: this._port, baseUrl: this._baseUrl() }
    }
    if (!this._startPromise) {
      this._startPromise = this._start().finally(() => {
        this._startPromise = null
      })
    }
    return this._startPromise
  }

  /**
   * Write a base64 PNG and return the URL it is served under.
   *
   * @param {string} pngBase64
   * @returns {Promise<{url:string, bytes:number, token:string}>}
   */
  async publish(pngBase64) {
    if (typeof pngBase64 !== 'string' || !pngBase64) {
      throw new Error('no image data to publish')
    }
    const bytes = Buffer.from(pngBase64, 'base64')
    if (bytes.length === 0) throw new Error('the image data was not valid base64')
    if (bytes.length > this.maxBytes) {
      throw new Error(
        `the image is ${bytes.length} bytes, over the ${this.maxBytes} byte limit`,
      )
    }

    const { baseUrl } = await this.ensureStarted()
    const token = randomBytes(24).toString('base64url')
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const filePath = join(this.dir, `${token}.png`)
    await writeFile(filePath, bytes)
    this._files.set(token, { path: filePath, bytes: bytes.length })
    return { url: `${baseUrl}/i/${token}.png`, bytes: bytes.length, token }
  }

  /**
   * Stop the server and delete every published image.
   *
   * Safe to call more than once.
   */
  async stop() {
    const server = this._server
    this._server = null
    this._port = null
    this._files.clear()
    this._removeExitHook()

    if (server) {
      // Keep-alive sockets would keep the server alive; drop them first.
      try {
        server.closeAllConnections()
      } catch {
        /* older runtimes */
      }
      await new Promise((resolve) => {
        try {
          server.close(() => resolve())
        } catch {
          resolve()
        }
      })
    }

    try {
      await rm(this.dir, { recursive: true, force: true })
    } catch {
      /* the directory may never have been created */
    }
  }

  // ---------------------------------------------------------------- internals

  _baseUrl() {
    return `http://${this.host}:${this._port}`
  }

  async _start() {
    const server = createServer((req, res) => this._handle(req, res))
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, this.host)
    })

    const address = server.address()
    this._server = server
    this._port = typeof address === 'object' && address ? address.port : null
    this._installExitHook()
    return { port: this._port, baseUrl: this._baseUrl() }
  }

  _handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('method not allowed')
    }

    let pathname = ''
    try {
      pathname = new URL(req.url, 'http://localhost').pathname
    } catch {
      pathname = ''
    }

    const match = pathname.match(/^\/i\/([A-Za-z0-9_-]+)\.png$/)
    const entry = match ? this._files.get(match[1]) : null
    if (!entry) {
      // Deliberately identical for "unknown token" and "no such route" — the
      // response must not reveal which tokens exist.
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('not found')
    }

    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': String(entry.bytes),
      'Cache-Control': 'no-store',
    })
    if (req.method === 'HEAD') return res.end()
    const stream = createReadStream(entry.path)
    stream.on('error', () => {
      res.destroy()
    })
    return stream.pipe(res)
  }

  _installExitHook() {
    if (this._exitHook) return
    this._exitHook = () => {
      try {
        rmSync(this.dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
    process.once('exit', this._exitHook)
  }

  _removeExitHook() {
    if (!this._exitHook) return
    process.removeListener('exit', this._exitHook)
    this._exitHook = null
  }
}
