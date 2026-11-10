// test/navigation-policy.test.js
// Unit tests for the navigation policy.
//
// The policy is a security boundary: it decides where a browser carrying
// the user's real login state may go. Both directions matter — a private
// address must be refused, and an ordinary web URL must not be.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateNavigation,
  isPrivateHost,
  navigationPolicyFromEnvironment,
  BLOCKED_SCHEMES,
} from '../lib/firefox/navigation-policy.js'

describe('private host detection', () => {
  test('loopback addresses are private', () => {
    assert.equal(isPrivateHost('127.0.0.1'), true)
    assert.equal(isPrivateHost('127.1.2.3'), true)
    assert.equal(isPrivateHost('0.0.0.0'), true)
  })

  test('the RFC1918 ranges are private', () => {
    assert.equal(isPrivateHost('10.0.0.1'), true)
    assert.equal(isPrivateHost('172.16.0.1'), true)
    assert.equal(isPrivateHost('172.31.255.255'), true)
    assert.equal(isPrivateHost('192.168.1.1'), true)
  })

  test('link-local is private', () => {
    assert.equal(isPrivateHost('169.254.1.1'), true)
  })

  test('localhost and its subdomains are private', () => {
    assert.equal(isPrivateHost('localhost'), true)
    assert.equal(isPrivateHost('app.localhost'), true)
    assert.equal(isPrivateHost('LOCALHOST'), true)
  })

  test('IPv6 loopback and unique-local are private', () => {
    assert.equal(isPrivateHost('::1'), true)
    assert.equal(isPrivateHost('[::1]'), true)
    assert.equal(isPrivateHost('fc00::1'), true)
    assert.equal(isPrivateHost('fd12::1'), true)
    assert.equal(isPrivateHost('fe80::1'), true)
  })

  test('an IPv4-mapped IPv6 loopback is private', () => {
    assert.equal(isPrivateHost('::ffff:127.0.0.1'), true)
  })

  test('a public address is not private', () => {
    assert.equal(isPrivateHost('example.com'), false)
    assert.equal(isPrivateHost('8.8.8.8'), false)
    assert.equal(isPrivateHost('172.32.0.1'), false)
    assert.equal(isPrivateHost('172.15.0.1'), false)
    assert.equal(isPrivateHost('11.0.0.1'), false)
    assert.equal(isPrivateHost('2606:4700::1'), false)
  })

  test('an empty host is not private', () => {
    assert.equal(isPrivateHost(''), false)
    assert.equal(isPrivateHost(null), false)
    assert.equal(isPrivateHost(undefined), false)
  })
})

describe('the navigation policy', () => {
  test('an ordinary https URL is allowed', () => {
    const verdict = evaluateNavigation('https://example.com/page')
    assert.equal(verdict.allowed, true)
  })

  test('a loopback URL is refused', () => {
    const verdict = evaluateNavigation('http://127.0.0.1:8080/admin')
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.reason, 'private_host')
    assert.equal(verdict.code, 'navigation_blocked')
  })

  test('a localhost URL is refused', () => {
    const verdict = evaluateNavigation('http://localhost:3000/')
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.reason, 'private_host')
  })

  test('the dangerous schemes are refused', () => {
    for (const scheme of BLOCKED_SCHEMES) {
      const verdict = evaluateNavigation(`${scheme}//example.com/x`)
      assert.equal(verdict.allowed, false, `${scheme} should be refused`)
      assert.equal(verdict.reason, 'blocked_scheme')
    }
  })

  test('the permissive policy allows everything', () => {
    const verdict = evaluateNavigation('http://127.0.0.1:8080/', { strict: false })
    assert.equal(verdict.allowed, true)
  })

  test('allowPrivateHosts lets a private host through but still blocks a scheme', () => {
    const host = evaluateNavigation('http://127.0.0.1:8080/', { allowPrivateHosts: true })
    assert.equal(host.allowed, true)
    const scheme = evaluateNavigation('file:///etc/passwd', { allowPrivateHosts: true })
    assert.equal(scheme.allowed, false)
    assert.equal(scheme.reason, 'blocked_scheme')
  })

  test('an exempt navigation is allowed', () => {
    const verdict = evaluateNavigation('about:addons', { exempt: true })
    assert.equal(verdict.allowed, true)
  })

  test('an empty URL is refused', () => {
    const verdict = evaluateNavigation('')
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.reason, 'empty_url')
  })

  test('a hostname with no scheme is left to normalizeUrl', () => {
    // It is not parseable on its own, and normalizeUrl gives it a scheme
    // before the policy sees it.
    const verdict = evaluateNavigation('example.com')
    assert.equal(verdict.allowed, true)
  })

  test('the refusal explains itself', () => {
    const verdict = evaluateNavigation('http://127.0.0.1/')
    assert.match(verdict.hint, /real login state/)
  })
})

describe('the policy configuration', () => {
  test('strict is the default', () => {
    const policy = navigationPolicyFromEnvironment({})
    assert.equal(policy.strict, true)
    assert.equal(policy.allowPrivateHosts, false)
  })

  test('permissive turns the checks off', () => {
    const policy = navigationPolicyFromEnvironment({
      FIREFOX_BROWSER_NAVIGATION_POLICY: 'permissive',
    })
    assert.equal(policy.strict, false)
  })

  test('allowPrivateHosts is opt-in', () => {
    const policy = navigationPolicyFromEnvironment({
      FIREFOX_BROWSER_ALLOW_PRIVATE_HOSTS: '1',
    })
    assert.equal(policy.allowPrivateHosts, true)
  })

  test('a value other than 1 does not enable private hosts', () => {
    const policy = navigationPolicyFromEnvironment({
      FIREFOX_BROWSER_ALLOW_PRIVATE_HOSTS: 'true',
    })
    assert.equal(policy.allowPrivateHosts, false)
  })
})
