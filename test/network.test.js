// test/network.test.js
// Unit tests for the network capture layer.
//
// The live-browser behaviour is covered by the integration suite; what is
// tested here is the part that runs in Node: URL redaction, status
// bucketing, and the bounded ring buffer.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { NetworkLog, sanitizeUrl, statusBucket, MAX_ENTRIES } from '../lib/firefox/network.js'

describe('network url redaction', () => {
  test('a query string never survives', () => {
    assert.equal(sanitizeUrl('https://example.com/a?token=secret'), 'https://example.com/a')
    assert.equal(sanitizeUrl('https://example.com/?token=secret'), 'https://example.com/')
  })

  test('a fragment never survives', () => {
    assert.equal(sanitizeUrl('https://example.com/page#section'), 'https://example.com/page')
  })

  test('a query string and a fragment both go', () => {
    assert.equal(sanitizeUrl('https://example.com/a?x=1&y=2#frag'), 'https://example.com/a')
  })

  test('the path survives — it is the useful part', () => {
    assert.equal(sanitizeUrl('https://example.com/deep/path'), 'https://example.com/deep/path')
  })

  test('a non-absolute url is stripped by hand', () => {
    assert.equal(sanitizeUrl('/relative/path?token=secret'), '/relative/path')
    assert.equal(sanitizeUrl('/relative/path#frag'), '/relative/path')
  })

  test('an empty url yields an empty string', () => {
    assert.equal(sanitizeUrl(''), '')
    assert.equal(sanitizeUrl(null), '')
    assert.equal(sanitizeUrl(undefined), '')
  })

  test('a data url keeps its media type but never its payload', () => {
    // The payload of a data: URL is the page itself — keeping it would put
    // document content into the log.
    const out = sanitizeUrl('data:text/html;charset=utf-8,<html>secret</html>')
    assert.equal(out, 'data:text/html;charset=utf-8')
    assert.ok(!out.includes('secret'))
  })

  test('a blob url keeps its inner url', () => {
    assert.equal(sanitizeUrl('blob:https://example.com/9a1f'), 'blob:https://example.com/9a1f')
  })

  test('an about url survives', () => {
    assert.equal(sanitizeUrl('about:blank'), 'about:blank')
  })
})

describe('network status buckets', () => {
  test('statuses are bucketed by their class', () => {
    assert.equal(statusBucket(200), '2xx')
    assert.equal(statusBucket(204), '2xx')
    assert.equal(statusBucket(301), '3xx')
    assert.equal(statusBucket(404), '4xx')
    assert.equal(statusBucket(500), '5xx')
    assert.equal(statusBucket(503), '5xx')
  })

  test('an unknown status is pending', () => {
    assert.equal(statusBucket(null), 'pending')
    assert.equal(statusBucket(undefined), 'pending')
    assert.equal(statusBucket(199), 'pending')
  })
})

describe('network log', () => {
  test('a recorded entry is redacted on the way in', () => {
    const log = new NetworkLog()
    log.record({ method: 'GET', url: 'https://example.com/x?token=secret' })
    const [entry] = log.query().requests
    assert.equal(entry.url, 'https://example.com/x')
    assert.ok(!JSON.stringify(entry).includes('secret'))
  })

  test('the query reports totals as well as the returned page', () => {
    const log = new NetworkLog()
    for (let i = 0; i < 5; i++) log.record({ url: `https://example.com/${i}` })
    const result = log.query({ limit: 2 })
    assert.equal(result.total, 5)
    assert.equal(result.count, 2)
  })

  test('the newest entries are the ones returned', () => {
    const log = new NetworkLog()
    log.record({ url: 'https://example.com/first' })
    log.record({ url: 'https://example.com/second' })
    const result = log.query({ limit: 10 })
    assert.equal(result.requests.length, 2)
    assert.equal(result.requests[1].url, 'https://example.com/second')
  })

  test('the buffer is bounded', () => {
    const log = new NetworkLog(5)
    for (let i = 0; i < 20; i++) log.record({ url: `https://example.com/${i}` })
    assert.equal(log.entries.length, 5)
    assert.equal(log.query().total, 5)
  })

  test('the default bound is the documented one', () => {
    assert.equal(MAX_ENTRIES, 500)
  })

  test('the status filter keeps only the requested buckets', () => {
    const log = new NetworkLog()
    log.record({ url: 'https://example.com/ok' })
    log.record({ url: 'https://example.com/bad', status: 500 })
    const result = log.query({ status: ['5xx'] })
    assert.equal(result.total, 1)
    assert.equal(result.requests[0].url, 'https://example.com/bad')
  })

  test('the url filter is a case-insensitive substring match', () => {
    const log = new NetworkLog()
    log.record({ url: 'https://example.com/Alpha' })
    log.record({ url: 'https://example.com/beta' })
    const result = log.query({ filter: 'alpha' })
    assert.equal(result.total, 1)
  })

  test('afterSeq returns only newer entries', () => {
    const log = new NetworkLog()
    log.record({ url: 'https://example.com/one' })
    const checkpoint = log.sequence
    log.record({ url: 'https://example.com/two' })
    assert.equal(log.query({ afterSeq: checkpoint }).total, 1)
    assert.equal(log.query().total, 2)
  })

  test('clearing drops every entry', () => {
    const log = new NetworkLog()
    log.record({ url: 'https://example.com/one' })
    log.clear()
    assert.equal(log.query().total, 0)
  })
})
