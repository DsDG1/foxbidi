// lib/firefox/captcha/stt.js
// Client for a Whisper / OpenAI-compatible speech-to-text endpoint.
//
// The plugin does NOT bundle a speech model. A Whisper model is 75 MB
// (tiny) to 150 MB (base) — bundling one would multiply the plugin's size
// by two orders of magnitude for a capability most sessions never use.
//
// Instead the plugin is an HTTP client. Point it at any endpoint that speaks
// the OpenAI transcription API and it works; leave it unset and the audio
// challenges report a clear, actionable error instead of failing silently.
//
// Protocol (verified against a local faster-whisper server):
//   POST {base}/v1/audio/transcriptions
//   multipart/form-data: file=<audio>, model=whisper-1, language=en,
//                         response_format=text
//
// Not every server implements `response_format=text` — the upstream
// faster-whisper-server only emits json. So the client asks for text and
// falls back to json, parsing `.text` out of the response.

/**
 * Build the multipart body for a transcription request.
 *
 * FormData is used rather than a hand-rolled body so the boundary is
 * generated correctly.
 *
 * @param {Buffer|Uint8Array} audio
 * @param {string} filename
 * @param {string} language
 * @param {string} responseFormat
 * @returns {FormData}
 */
export function buildTranscribeForm(audio, filename, language, responseFormat) {
  const form = new FormData()
  form.append('file', new Blob([audio], { type: 'audio/mpeg' }), filename)
  form.append('model', 'whisper-1')
  form.append('language', language)
  form.append('response_format', responseFormat)
  return form
}

/**
 * Normalise the base URL to a transcription endpoint.
 *
 * Accepts either a bare base (`http://127.0.0.1:8000`) or a full endpoint
 * (`http://127.0.0.1:8000/v1/audio/transcriptions`).
 *
 * @param {string} url
 * @returns {string}
 */
export function transcriptionEndpoint(url) {
  const trimmed = String(url || '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (trimmed.endsWith('/audio/transcriptions')) return trimmed
  if (trimmed.endsWith('/v1')) return `${trimmed}/audio/transcriptions`
  return `${trimmed}/v1/audio/transcriptions`
}

/**
 * Pull the transcript out of a response body.
 *
 * @param {string} body
 * @returns {string}
 */
export function parseTranscript(body) {
  const text = String(body || '').trim()
  if (!text) return ''
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed.text === 'string') return parsed.text.trim()
      return ''
    } catch {
      return text
    }
  }
  return text
}

/**
 * Transcribe audio with a Whisper-compatible endpoint.
 *
 * @param {object} opts
 * @param {string} opts.sttUrl
 * @param {Buffer|Uint8Array} opts.audio
 * @param {string} [opts.filename]
 * @param {string} [opts.language]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.apiKey]
 * @returns {Promise<{ok: boolean, transcript?: string, status?: string, message?: string}>}
 */
export async function transcribe(opts) {
  const endpoint = transcriptionEndpoint(opts.sttUrl)
  if (!endpoint) {
    return {
      ok: false,
      status: 'stt_unavailable',
      message:
        'This challenge needs speech-to-text, but no speech-to-text endpoint is ' +
        'configured. Pass sttUrl (for example http://127.0.0.1:8000) pointing at ' +
        'a Whisper-compatible server, or solve this challenge manually.',
    }
  }

  const headers = {}
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`

  const language = opts.language || 'en'
  const filename = opts.filename || 'audio.mp3'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 60000)

  try {
    // Prefer plain text; fall back to json for servers that do not support it.
    let res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: buildTranscribeForm(opts.audio, filename, language, 'text'),
      signal: controller.signal,
    })

    if (res.status === 400) {
      res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: buildTranscribeForm(opts.audio, filename, language, 'json'),
        signal: controller.signal,
      })
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return {
        ok: false,
        status: 'stt_failed',
        message: `The speech-to-text endpoint answered ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}.`,
      }
    }

    const transcript = parseTranscript(await res.text())
    if (!transcript) {
      return {
        ok: false,
        status: 'stt_empty',
        message: 'The speech-to-text endpoint returned an empty transcript.',
      }
    }
    return { ok: true, transcript }
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')
    return {
      ok: false,
      status: aborted ? 'stt_timeout' : 'stt_unreachable',
      message: aborted
        ? 'The speech-to-text endpoint timed out.'
        : `The speech-to-text endpoint could not be reached: ${err && err.message ? err.message : err}`,
    }
  } finally {
    clearTimeout(timer)
  }
}
