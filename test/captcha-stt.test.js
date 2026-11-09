// test/captcha-stt.test.js
// The speech-to-text client.
//
// The plugin bundles no model — it is an HTTP client for a Whisper-compatible
// endpoint. So the behaviour that matters is the PROTOCOL: which URL is
// called, which format is requested, and what happens when the service is
// missing or broken. The contract is explicit degradation: a structured
// error, never a silent fake success.

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  transcriptionEndpoint,
  parseTranscript,
  buildTranscribeForm,
  transcribe,
} from '../lib/firefox/captcha/stt.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('transcriptionEndpoint', () => {
  test('appends the OpenAI transcription path to a bare base', () => {
    assert.equal(
      transcriptionEndpoint('http://127.0.0.1:8000'),
      'http://127.0.0.1:8000/v1/audio/transcriptions',
    )
  })

  test('does not double the /v1 segment', () => {
    assert.equal(
      transcriptionEndpoint('http://127.0.0.1:8000/v1'),
      'http://127.0.0.1:8000/v1/audio/transcriptions',
    )
  })

  test('leaves a full endpoint alone', () => {
    const full = 'http://127.0.0.1:8000/v1/audio/transcriptions'
    assert.equal(transcriptionEndpoint(full), full)
  })

  test('trims trailing slashes', () => {
    assert.equal(
      transcriptionEndpoint('http://127.0.0.1:8000///'),
      'http://127.0.0.1:8000/v1/audio/transcriptions',
    )
  })

  test('returns an empty string for an unset url', () => {
    assert.equal(transcriptionEndpoint(''), '')
    assert.equal(transcriptionEndpoint(undefined), '')
  })
})

describe('parseTranscript', () => {
  test('reads a plain text body', () => {
    assert.equal(parseTranscript('  seven nine  '), 'seven nine')
  })

  test('reads the text field of a json body', () => {
    assert.equal(parseTranscript('{"text":"seven nine"}'), 'seven nine')
  })

  test('returns an empty string for json without a text field', () => {
    assert.equal(parseTranscript('{"segments":[]}'), '')
  })

  test('keeps a malformed json body as-is', () => {
    assert.equal(parseTranscript('{not json'), '{not json')
  })

  test('returns an empty string for an empty body', () => {
    assert.equal(parseTranscript(''), '')
  })
})

describe('buildTranscribeForm', () => {
  test('carries the audio, the model and the requested format', () => {
    const form = buildTranscribeForm(new Uint8Array([1, 2, 3]), 'audio.mp3', 'en', 'text')
    assert.ok(form.has('file'))
    assert.ok(form.has('model'))
    assert.ok(form.has('language'))
    assert.ok(form.has('response_format'))
    assert.equal(form.get('model'), 'whisper-1')
    assert.equal(form.get('language'), 'en')
    assert.equal(form.get('response_format'), 'text')
  })
})

describe('transcribe', () => {
  test('reports stt_unavailable when no endpoint is configured', async () => {
    const result = await transcribe({ audio: new Uint8Array([1]) })
    assert.equal(result.ok, false)
    assert.equal(result.status, 'stt_unavailable')
    assert.match(result.message, /sttUrl/)
  })

  test('returns the transcript from a text endpoint', async () => {
    const calls = []
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts })
      return { ok: true, status: 200, text: async () => 'seven nine' }
    }

    const result = await transcribe({
      sttUrl: 'http://127.0.0.1:8000',
      audio: new Uint8Array([1, 2, 3]),
    })

    assert.equal(result.ok, true)
    assert.equal(result.transcript, 'seven nine')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'http://127.0.0.1:8000/v1/audio/transcriptions')
    assert.equal(calls[0].opts.method, 'POST')
  })

  test('falls back to json when the server rejects response_format=text', async () => {
    const formats = []
    globalThis.fetch = async (url, opts) => {
      const format = opts.body.get('response_format')
      formats.push(format)
      if (format === 'text') {
        return { ok: false, status: 400, text: async () => 'unsupported' }
      }
      return { ok: true, status: 200, text: async () => '{"text":"seven nine"}' }
    }

    const result = await transcribe({
      sttUrl: 'http://127.0.0.1:8000',
      audio: new Uint8Array([1, 2, 3]),
    })

    assert.equal(result.ok, true)
    assert.equal(result.transcript, 'seven nine')
    assert.deepEqual(formats, ['text', 'json'])
  })

  test('reports stt_failed when the endpoint answers an error', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'model missing',
    })

    const result = await transcribe({
      sttUrl: 'http://127.0.0.1:8000',
      audio: new Uint8Array([1]),
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'stt_failed')
    assert.match(result.message, /500/)
  })

  test('reports stt_empty when the endpoint returns nothing usable', async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '' })

    const result = await transcribe({
      sttUrl: 'http://127.0.0.1:8000',
      audio: new Uint8Array([1]),
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'stt_empty')
  })

  test('reports stt_unreachable when the endpoint cannot be reached', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED')
    }

    const result = await transcribe({
      sttUrl: 'http://127.0.0.1:9',
      audio: new Uint8Array([1]),
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'stt_unreachable')
    assert.match(result.message, /ECONNREFUSED/)
  })
})
