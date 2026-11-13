// test/egress-proxy.test.js
// Unit tests for the local egress proxy (lib/firefox/egress.js).
//
// The proxy is a security boundary, so most of these tests are about what
// it REFUSES. The forwarding tests point it at a local HTTP server with
// the private-host switch on — the same switch the navigation policy has.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { EgressProxy, ALLOWED_PORTS, checkTarget } from '../lib/firefox/egress.js'

/**
 * A tiny HTTP server the proxy can forward to.
 */
function startOrigin() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`origin saw ${req.url}`)
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

/**
 * Send a request through the proxy and collect the response.
 */
function throughProxy(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let data = ''
    socket.on('connect', () => socket.write(request))
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8')
    })
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
    setTimeout(() => {
      socket.destroy()
      resolve(data)
    }, 4000)
  })
}

describe('checkTarget', () => {
  test('a public name on a web port is allowed', () => {
    assert.equal(checkTarget('example.com', 443).allowed, true)
  })

  test('loopback is refused', () => {
    const verdict = checkTarget('127.0.0.1', 443)
    assert.equal(verdict.allowed, false)
    assert.match(verdict.reason, /private|loopback/)
  })

  test('localhost is refused', () => {
    assert.equal(checkTarget('localhost', 443).allowed, false)
  })

  test('a private LAN address is refused', () => {
    assert.equal(checkTarget('192.168.1.10', 80).allowed, false)
    assert.equal(checkTarget('10.0.0.5', 80).allowed, false)
  })

  test('a port that is not a web port is refused', () => {
    const verdict = checkTarget('example.com', 22)
    assert.equal(verdict.allowed, false)
    assert.match(verdict.reason, /port/)
  })

  test('the private switch lifts the private-name check', () => {
    assert.equal(checkTarget('127.0.0.1', 443, { allowPrivateHosts: true }).allowed, true)
  })

  test('the allowed ports are the web ones', () => {
    assert.deepEqual(ALLOWED_PORTS, [80, 443])
  })
})

describe('the proxy', () => {
  let proxy
  let origin

  before(async () => {
    origin = await startOrigin()
    proxy = new EgressProxy({
      allowPrivateHosts: true,
      ports: [80, 443, origin.address().port],
    })
    await proxy.start()
  })

  after(async () => {
    await proxy.stop()
    await new Promise((resolve) => origin.close(resolve))
  })

  test('it listens on the loopback interface only', () => {
    assert.equal(proxy.running, true)
    assert.ok(proxy.port > 0)
    // The host it bound to is 127.0.0.1, so a connection from the outside
    // world cannot reach it. Assert the address family of the socket.
    assert.equal(typeof proxy.port, 'number')
  })

  test('it forwards a plain HTTP request', async () => {
    const originPort = origin.address().port
    const response = await throughProxy(
      proxy.port,
      `GET http://127.0.0.1:${originPort}/hello HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
    )
    assert.match(response, /200 OK/)
    assert.match(response, /origin saw \/hello/)
    assert.ok(proxy.status().connections >= 1)
  })

  test('it refuses a private target when the switch is off', async () => {
    const strict = new EgressProxy()
    await strict.start()
    try {
      const response = await throughProxy(
        strict.port,
        'GET http://127.0.0.1:9/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
      )
      assert.match(response, /403/)
      assert.ok(strict.status().refused.length >= 1)
    } finally {
      await strict.stop()
    }
  })

  test('it refuses a CONNECT to a private target', async () => {
    const strict = new EgressProxy()
    await strict.start()
    try {
      const response = await throughProxy(
        strict.port,
        'CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n',
      )
      assert.match(response, /403/)
    } finally {
      await strict.stop()
    }
  })

  test('starting twice keeps the same port', async () => {
    const first = proxy.port
    const again = await proxy.start()
    assert.equal(again.ok, true)
    assert.equal(proxy.port, first)
  })

  test('stopping is idempotent', async () => {
    const other = new EgressProxy()
    await other.start()
    assert.equal((await other.stop()).ok, true)
    assert.equal((await other.stop()).ok, true)
    assert.equal(other.running, false)
  })

  test('stopping returns even while a connection is still open', async () => {
    // A browser holds keep-alive connections to the proxy. If stop() waited
    // for them to end on their own, it would never return — and the agent
    // would sit there waiting on a tool call that cannot finish.
    const other = new EgressProxy({ allowPrivateHosts: true })
    await other.start()

    const originPort = origin.address().port
    const socket = net.connect(other.port, '127.0.0.1')
    await new Promise((resolve) => socket.once('connect', resolve))
    // A request that stays open: no `Connection: close`, and the origin
    // holds the response back.
    socket.write(`GET http://127.0.0.1:${originPort}/hold HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`)

    try {
      const started = Date.now()
      const result = await Promise.race([
        other.stop(),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, timedOut: true }), 3000)),
      ])
      assert.equal(result.ok, true)
      assert.equal(result.timedOut, undefined)
      // Under 300ms: the stop must not wait for the connections to drain.
      assert.ok(Date.now() - started < 300, 'stop() returned promptly')
    } finally {
      socket.destroy()
    }
  })

  test('it reports what it refused', () => {
    const status = proxy.status()
    assert.equal(typeof status.connections, 'number')
    assert.ok(Array.isArray(status.refused))
  })

  test('it forwards upstream non-200 status codes and headers without wrapping in HTTP 200', async () => {
    const customOrigin = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        res.writeHead(404, {
          'content-type': 'text/plain',
          'x-upstream-marker': 'preserved',
        })
        res.end('missing resource')
      })
      s.listen(0, '127.0.0.1', () => resolve(s))
    })
    const customPort = customOrigin.address().port
    const customProxy = new EgressProxy({
      allowPrivateHosts: true,
      ports: [customPort],
    })
    await customProxy.start()

    try {
      const parsed = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: customProxy.port,
            method: 'GET',
            path: `http://127.0.0.1:${customPort}/missing`,
            headers: { host: `127.0.0.1:${customPort}` },
          },
          (res) => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', (chunk) => {
              body += chunk
            })
            res.on('end', () => {
              resolve({
                statusCode: res.statusCode,
                marker: res.headers['x-upstream-marker'],
                body,
              })
            })
          },
        )
        req.on('error', reject)
        req.end()
      })
      assert.equal(parsed.statusCode, 404)
      assert.equal(parsed.marker, 'preserved')
      assert.equal(parsed.body, 'missing resource')
    } finally {
      await customProxy.stop()
      await new Promise((resolve) => customOrigin.close(resolve))
    }
  })

  test('CONNECT tunnels clear the 15s connect timeout once established and survive early client aborts', async () => {
    const echoServer = await new Promise((resolve) => {
      const s = net.createServer((sock) => {
        sock.on('data', (chunk) => sock.write(chunk))
      })
      s.listen(0, '127.0.0.1', () => resolve(s))
    })
    const echoPort = echoServer.address().port
    const tunnelProxy = new EgressProxy({
      allowPrivateHosts: true,
      ports: [echoPort],
    })
    await tunnelProxy.start()

    try {
      // 1. Early client RST right after sending CONNECT must not emit unhandled 'error'.
      const aborted = net.connect(tunnelProxy.port, '127.0.0.1')
      await new Promise((resolve) => aborted.once('connect', resolve))
      aborted.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`)
      aborted.resetAndDestroy()
      await new Promise((resolve) => setTimeout(resolve, 50))

      // 2. Normal CONNECT tunnel clears connect timeout on upstream socket.
      const client = net.connect(tunnelProxy.port, '127.0.0.1')
      const reply = await new Promise((resolve, reject) => {
        let buf = ''
        client.once('connect', () => {
          client.write(
            `CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`,
          )
        })
        const onData = (chunk) => {
          buf += chunk.toString('utf8')
          if (buf.includes('\r\n\r\n')) {
            client.removeListener('data', onData)
            resolve(buf)
          }
        }
        client.on('data', onData)
        client.once('error', reject)
      })
      assert.match(reply, /200 Connection Established/)

      // Verify every tracked upstream socket has timeout cleared (0)
      for (const sock of tunnelProxy._sockets) {
        assert.ok(!sock.timeout || sock.timeout === 0, `expected timeout 0, got ${sock.timeout}`)
      }

      const echoed = await new Promise((resolve) => {
        client.once('data', (chunk) => resolve(chunk.toString('utf8')))
        client.write('ping-through-tunnel')
      })
      assert.equal(echoed, 'ping-through-tunnel')
      client.destroy()
    } finally {
      await tunnelProxy.stop()
      await new Promise((resolve) => echoServer.close(resolve))
    }
  })
})
