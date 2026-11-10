// test/redact.test.js
// Unit tests for the redaction layer.
//
// The redaction layer is the plugin's boundary between "raw page content"
// and "what the model sees". A leak here is a leak of a credential, so
// both directions are tested: a secret must NOT survive, and ordinary
// content must survive intact (a redactor that eats everything is as
// broken as one that eats nothing).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  redactValue,
  redactText,
  redactCookie,
  redactCookies,
  isSensitiveFieldName,
  REDACTED_PLACEHOLDER,
} from '../lib/firefox/redact.js'

describe('sensitive field detection', () => {
  test('a password input is sensitive', () => {
    assert.equal(isSensitiveFieldName({ type: 'password' }), true)
  })

  test('the password role is sensitive', () => {
    assert.equal(isSensitiveFieldName({ role: 'password' }), true)
  })

  test('a one-time-code field is sensitive', () => {
    // The browser's own declaration — the most reliable signal there is.
    assert.equal(isSensitiveFieldName({ autocomplete: 'one-time-code' }), true)
    assert.equal(isSensitiveFieldName({ autocomplete: 'current-password' }), true)
    assert.equal(isSensitiveFieldName({ autocomplete: 'cc-number' }), true)
    assert.equal(isSensitiveFieldName({ autocomplete: 'cc-csc' }), true)
  })

  test('a field named after a credential is sensitive', () => {
    assert.equal(isSensitiveFieldName({ name: 'otp_code' }), true)
    assert.equal(isSensitiveFieldName({ name: 'user_password' }), true)
    assert.equal(isSensitiveFieldName({ name: 'csrf_token' }), true)
    assert.equal(isSensitiveFieldName({ name: 'card_number' }), true)
    assert.equal(isSensitiveFieldName({ name: 'cvv' }), true)
    assert.equal(isSensitiveFieldName({ name: 'api_key' }), true)
  })

  test('a Chinese credential field is sensitive', () => {
    // A verification code on a Chinese site is 验证码, and a password is
    // 密码. The English-only pattern would have missed both.
    assert.equal(isSensitiveFieldName({ name: '验证码' }), true)
    assert.equal(isSensitiveFieldName({ placeholder: '密码' }), true)
    assert.equal(isSensitiveFieldName({ name: '动态码' }), true)
  })

  test('an ordinary field is not sensitive', () => {
    assert.equal(isSensitiveFieldName({ name: 'q', type: 'text' }), false)
    assert.equal(isSensitiveFieldName({ name: 'search' }), false)
    assert.equal(isSensitiveFieldName({ name: 'country' }), false)
    assert.equal(isSensitiveFieldName({ name: 'message' }), false)
    assert.equal(isSensitiveFieldName({}), false)
    assert.equal(isSensitiveFieldName(null), false)
  })
})

describe('value redaction', () => {
  test('a sensitive value is replaced but keeps its length', () => {
    const out = redactValue('123456', { name: 'otp' })
    assert.equal(out.redacted, true)
    assert.equal(out.length, 6)
    assert.ok(out.value.includes(REDACTED_PLACEHOLDER))
    assert.ok(!out.value.includes('123456'))
  })

  test('an ordinary value survives untouched', () => {
    const out = redactValue('hello world', { name: 'greeting' })
    assert.equal(out.redacted, false)
    assert.equal(out.value, 'hello world')
  })

  test('an empty value is empty', () => {
    const out = redactValue('', { name: 'otp' })
    assert.equal(out.redacted, false)
    assert.equal(out.value, '')
    assert.equal(out.length, 0)
  })

  test('null and undefined are treated as empty', () => {
    assert.equal(redactValue(null).value, '')
    assert.equal(redactValue(undefined).value, '')
  })
})

describe('text redaction', () => {
  test('a key=value secret is replaced but the sentence survives', () => {
    const out = redactText('request failed with token=abc123def456')
    assert.ok(!out.includes('abc123def456'))
    assert.ok(out.includes('request failed'))
    assert.ok(out.includes('token='))
  })

  test('a quoted JSON secret is replaced', () => {
    const out = redactText('{"access_token":"eyJhbGciOiJIUzI1NiJ9.payload.sig"}')
    assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9.payload.sig'))
    assert.ok(out.includes('access_token'))
  })

  test('a bearer header is replaced', () => {
    const out = redactText('Authorization: Bearer abcdefghijklmnop')
    assert.ok(!out.includes('abcdefghijklmnop'))
    assert.ok(out.includes('Bearer'))
  })

  test('a JWT is replaced', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    const out = redactText(`the token was ${jwt}`)
    assert.ok(!out.includes(jwt))
    assert.ok(out.includes('the token was'))
  })

  test('a known cloud credential prefix is replaced', () => {
    assert.ok(!redactText('AKIAIOSFODNN7EXAMPLE').includes('AKIAIOSFODNN7EXAMPLE'))
    assert.ok(
      !redactText('ghp_abcdefghijklmnopqrstuvwxyz1234').includes(
        'ghp_abcdefghijklmnopqrstuvwxyz1234',
      ),
    )
    assert.ok(
      !redactText('sk-abcdefghijklmnopqrstuvwxyz').includes('sk-abcdefghijklmnopqrstuvwxyz'),
    )
  })

  test('ordinary prose is untouched', () => {
    const text = 'the page loaded in 320ms and shows 12 results'
    assert.equal(redactText(text), text)
  })

  test('ordinary JSON is untouched', () => {
    const text = '{"name":"Alice","role":"admin","count":3}'
    assert.equal(redactText(text), text)
  })

  test('a base64 blob is NOT redacted', () => {
    // The redactor only replaces UNAMBIGUOUS secret shapes. A generic
    // high-entropy rule would eat every image data URL on the web.
    const blob =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    assert.equal(redactText(blob), blob)
  })

  test('empty and nullish input is handled', () => {
    assert.equal(redactText(''), '')
    assert.equal(redactText(null), '')
    assert.equal(redactText(undefined), '')
  })
})

describe('cookie redaction', () => {
  test('the value is replaced but the identity survives', () => {
    const out = redactCookie({
      name: 'sessionid',
      value: 'abcdef0123456789',
      domain: 'example.com',
      path: '/',
      httpOnly: true,
      secure: true,
    })
    assert.equal(out.name, 'sessionid')
    assert.equal(out.domain, 'example.com')
    assert.equal(out.httpOnly, true)
    assert.equal(out.secure, true)
    assert.ok(!out.value.includes('abcdef0123456789'))
    assert.ok(out.value.includes(REDACTED_PLACEHOLDER))
    assert.equal(out.valueRedacted, true)
  })

  test('the length is disclosed', () => {
    const out = redactCookie({ name: 'sid', value: '0123456789' })
    assert.ok(out.value.includes('len=10'))
  })

  test('an empty value is left alone', () => {
    const out = redactCookie({ name: 'sid', value: '' })
    assert.equal(out.value, '')
    assert.equal(out.valueRedacted, undefined)
  })

  test('a cookie without a value is left alone', () => {
    const out = redactCookie({ name: 'sid' })
    assert.equal(out.name, 'sid')
    assert.equal(out.valueRedacted, undefined)
  })

  test('a list is redacted element by element', () => {
    const out = redactCookies([
      { name: 'a', value: 'secret1' },
      { name: 'b', value: 'secret2' },
    ])
    assert.equal(out.length, 2)
    for (const c of out) {
      assert.ok(!String(c.value).includes('secret'))
    }
  })

  test('a non-array is an empty list', () => {
    assert.deepEqual(redactCookies(null), [])
    assert.deepEqual(redactCookies(undefined), [])
  })
})
