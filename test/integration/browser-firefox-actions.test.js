// test/integration/browser-firefox-actions.test.js
// End-to-end tests of the agent-facing loop against a REAL browser:
// snapshot → act by ref → verify.
//
// This suite is OPTIONAL: it is skipped when Firefox is not installed, so
// CI on a machine without Firefox still passes. When Firefox IS present it
// exercises the full chain — launch → BiDi session → snapshot → click by
// ref → type by ref → wait → network — against a headless instance.
//
// It uses a THROWAWAY profile copy in a temp directory; the user's own
// Firefox profile is never opened or modified.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = resolve(HERE, '..', '..')
const absPath = (rel) => pathToFileURL(resolve(SERVER_DIR, rel)).href

const { detectFirefoxBin } = await import(absPath('lib/firefox/launcher.js'))
const { FirefoxProvider } = await import(absPath('lib/firefox/provider.js'))

const firefoxBin = detectFirefoxBin()
const skip = firefoxBin
  ? false
  : 'firefox is not installed — skipping the live-browser integration test'

const EMAIL = 'agent@example.com'

const PAGE = `<!doctype html>
<html><head><title>Agent Test Page</title></head>
<body>
  <h1>Sign in</h1>
  <label for="user">User</label><input id="user" placeholder="email">
  <label for="pass">Password</label><input id="pass" type="password">
  <button id="go" onclick="document.getElementById('out').textContent='clicked'">Sign in</button>
  <div id="out"></div>
  <input id="agree" type="checkbox"><label for="agree">I agree</label>
  <select id="plan"><option value="1">Basic</option><option value="2">Pro</option></select>
  <form id="pay" action="https://example.com/pay" method="post">
    <input name="card"><button id="paybtn" type="submit">Pay</button>
  </form>
</body></html>`

describe('agent loop (live browser)', { skip }, () => {
  let provider
  let tmpRoot
  let contextId

  /** Re-open the test page — some cases deliberately mutate the DOM. */
  async function loadPage() {
    await provider.navigate('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
    const tabs = await provider.listTabs()
    contextId = tabs[0]?.contextId
  }

  before(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ffbrowser-actions-'))
    provider = new FirefoxProvider({
      bin: firefoxBin,
      headless: true,
      // A dedicated base port: the test runner runs files in parallel, and
      // every live-browser file would otherwise race for the same port.
      port: 9620,
      copyBaseDir: join(tmpRoot, 'copies'),
      timeoutMs: 20000,
      readyTimeoutMs: 45000,
    })
    const started = await provider.start()
    assert.equal(started.ok, true, started.error)
    await loadPage()
  })

  after(async () => {
    if (provider) {
      try {
        await provider.stop()
      } catch {}
    }
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('a snapshot exposes elements with roles and names', async () => {
    const snap = await provider.snapshot(contextId)
    assert.equal(snap.ok, true, snap.error)
    assert.ok(snap.elements.length > 0)
    assert.ok(snap.snapshotId > 0)

    const roles = snap.elements.map((e) => e.role)
    assert.ok(roles.includes('button'), 'no button in the snapshot')
    assert.ok(roles.includes('textbox'), 'no textbox in the snapshot')
    assert.ok(roles.includes('checkbox'), 'no checkbox in the snapshot')
    assert.ok(roles.includes('combobox'), 'no combobox in the snapshot')

    const user = snap.elements.find((e) => e.role === 'textbox' && e.name === 'User')
    assert.ok(user, 'the labelled input was not named "User"')
    assert.match(user.ref, /^e\d+$/)
  })

  test('refs are unique within a snapshot', async () => {
    const snap = await provider.snapshot(contextId)
    const refs = snap.elements.map((e) => e.ref)
    assert.equal(new Set(refs).size, refs.length)
  })

  test('a password field never exposes its value', async () => {
    const snap = await provider.snapshot(contextId)
    const pass = snap.elements.find((e) => e.role === 'password')
    assert.ok(pass, 'no password field in the snapshot')
    assert.equal(pass.value, undefined)
  })

  test('a click by ref reaches the real element', async () => {
    await loadPage()
    const snap = await provider.snapshot(contextId)
    const button = snap.elements.find((e) => e.role === 'button' && e.name === 'Sign in')
    const result = await provider.click(undefined, contextId, { ref: button.ref })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.via, 'ref')

    const out = await provider.evaluate("document.getElementById('out').textContent", contextId)
    assert.equal(out.value, 'clicked', 'the click handler did not run')
  })

  test('a click by ref reports a verified effect', async () => {
    await loadPage()
    const snap = await provider.snapshot(contextId)
    const button = snap.elements.find((e) => e.role === 'button' && e.name === 'Sign in')
    const result = await provider.click(undefined, contextId, { ref: button.ref })
    assert.ok(result.effect, 'no effect block')
    assert.equal(typeof result.effect.verified, 'boolean')
    assert.equal(result.effect.verified, true)
  })

  test('typing by ref focuses the right field', async () => {
    await loadPage()
    const snap = await provider.snapshot(contextId)
    const user = snap.elements.find((e) => e.role === 'textbox' && e.name === 'User')
    const result = await provider.type(undefined, EMAIL, contextId, { ref: user.ref })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.typed, EMAIL.length)

    const value = await provider.evaluate("document.getElementById('user').value", contextId)
    assert.equal(value.value, EMAIL)
  })

  test('a stale ref is reported instead of hitting the wrong element', async () => {
    await loadPage()
    const snap = await provider.snapshot(contextId)
    const button = snap.elements.find((e) => e.role === 'button' && e.name === 'Sign in')
    const staleRef = button.ref

    // Re-render the page: every ref marker disappears with the old DOM.
    await provider.evaluate("document.body.innerHTML = '<button>New</button>'", contextId)

    const result = await provider.click(undefined, contextId, { ref: staleRef })
    assert.equal(result.ok, false)
    assert.equal(result.requiresResnapshot, true)
    assert.match(result.error, /no longer exists/)
    assert.match(result.hint, /browser_snapshot/)
  })

  test('a checkbox can be checked and unchecked by ref', async () => {
    await loadPage()
    const snap = await provider.snapshot(contextId)
    const agree = snap.elements.find((e) => e.role === 'checkbox')
    assert.ok(agree, 'no checkbox in the snapshot')

    const on = await provider.check(undefined, true, contextId, { ref: agree.ref })
    assert.equal(on.ok, true, on.error)
    assert.equal(on.checked, true)

    const state = await provider.evaluate("document.getElementById('agree').checked", contextId)
    assert.equal(state.value, true)

    const off = await provider.check(undefined, false, contextId, { ref: agree.ref })
    assert.equal(off.checked, false)
  })

  test('a select option can be chosen by ref', async () => {
    await loadPage()
    const snap = await provider.snapshot(contextId)
    const plan = snap.elements.find((e) => e.role === 'combobox')
    assert.ok(plan, 'no combobox in the snapshot')

    const result = await provider.selectOption(undefined, '2', contextId, { ref: plan.ref })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.selected, '2')

    const value = await provider.evaluate("document.getElementById('plan').value", contextId)
    assert.equal(value.value, '2')
  })

  test('pressing Enter delivers a real Enter key', async () => {
    await loadPage()
    await provider.evaluate(
      "document.getElementById('out').textContent = ''; window.__key = ''; " +
        "document.addEventListener('keydown', (e) => { window.__key = e.key; });",
      contextId,
    )
    const result = await provider.pressKey('Enter', contextId)
    assert.equal(result.ok, true, result.error)

    const key = await provider.evaluate('window.__key', contextId)
    assert.equal(key.value, 'Enter')
  })

  test('a Ctrl chord holds the modifier across the target key', async () => {
    await loadPage()
    await provider.type('#user', 'Hello', contextId)
    await provider.evaluate(
      'window.__last = null; ' +
        "document.addEventListener('keydown', (e) => { window.__last = { key: e.key, ctrlKey: e.ctrlKey }; });",
      contextId,
    )

    const result = await provider.pressKey('Control+a', contextId)
    assert.equal(result.ok, true, result.error)

    // The page must see the modifier held on the target key.
    const last = await provider.evaluate('JSON.stringify(window.__last)', contextId)
    const seen = JSON.parse(last.value)
    assert.equal(seen.key, 'a')
    assert.equal(seen.ctrlKey, true, 'the modifier was not held across the target key')

    // A chord must NOT type a literal character into the field.
    const value = await provider.evaluate("document.getElementById('user').value", contextId)
    assert.equal(value.value, 'Hello', 'the chord typed a literal character instead of selecting')

    // And it must have selected the text.
    const selection = await provider.evaluate(
      "var el = document.getElementById('user'); el.selectionStart + ':' + el.selectionEnd",
      contextId,
    )
    assert.equal(selection.value, '0:5', 'the chord did not select the field contents')
  })

  test('typing reports that it changed the page', async () => {
    await loadPage()
    const result = await provider.type('#user', EMAIL, contextId)
    assert.equal(result.ok, true, result.error)
    assert.ok(result.effect, 'no effect block')
    assert.equal(
      result.effect.verified,
      true,
      'typing into a field must be observable — otherwise an agent retries and duplicates the text',
    )
    assert.equal(result.effect.domChanged, true)
  })

  test('typing that writes nothing reports no observable change', async () => {
    await loadPage()
    const result = await provider.type('#user', '', contextId)
    assert.equal(result.ok, true, result.error)
    assert.equal(result.effect.verified, false)
  })

  test('navigation accepts the interactive wait strategy', async () => {
    const result = await provider.navigate('https://example.com/', undefined, 'interactive')
    assert.equal(result.ok, true, result.error)
    const tabs = await provider.listTabs()
    assert.ok(tabs.length > 0)
    await loadPage()
  })

  test('the legacy "load" wait strategy is accepted, not rejected by Firefox', async () => {
    const result = await provider.navigate('https://example.com/', undefined, 'load')
    assert.equal(result.ok, true, result.error)
    assert.doesNotMatch(String(result.error || ''), /Expected "wait"/)
    await loadPage()
  })

  test('waiting for text that is present succeeds', async () => {
    await loadPage()
    const result = await provider.waitFor(contextId, {
      for: 'text',
      text: 'Sign in',
      timeoutMs: 3000,
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.for, 'text')
  })

  test('waiting for text that never appears times out with an explanation', async () => {
    await loadPage()
    const result = await provider.waitFor(contextId, {
      for: 'text',
      text: 'this string is definitely not on the page',
      timeoutMs: 400,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /timed out/)
    assert.ok(result.elapsedMs >= 0)
  })

  test('waiting for an element that exists succeeds', async () => {
    await loadPage()
    const result = await provider.waitFor(contextId, {
      for: 'selector',
      selector: '#go',
      timeoutMs: 3000,
    })
    assert.equal(result.ok, true, result.error)
  })

  test('a file can be uploaded to a file input', async () => {
    const filePath = join(tmpRoot, 'upload.txt')
    writeFileSync(filePath, 'payload')

    await provider.navigate(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent('<input id="f" type="file"><div id="out"></div>'),
    )
    const tabs = await provider.listTabs()
    const ctx = tabs[0]?.contextId

    const snap = await provider.snapshot(ctx)
    const input = snap.elements.find((e) => e.role === 'file')
    assert.ok(input, 'no file input in the snapshot')

    // Uploading is irreversible — it must be blocked without confirmation.
    const blocked = await provider.upload(undefined, [filePath], ctx, { ref: input.ref })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.requiresConfirm, true)
    assert.equal(blocked.blocked, true)

    // The gate must STOP the upload, not merely report it after the fact.
    const afterBlock = await provider.evaluate("document.getElementById('f').files.length", ctx)
    assert.equal(afterBlock.value, 0, 'the file was attached despite the gate')

    const allowed = await provider.upload(undefined, [filePath], ctx, {
      ref: input.ref,
      confirm: true,
    })
    assert.equal(allowed.ok, true, allowed.error)

    const count = await provider.evaluate("document.getElementById('f').files.length", ctx)
    assert.equal(count.value, 1)
  })

  test('a form submit is blocked without confirmation', async () => {
    await provider.navigate(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<form id="f" action="https://example.com/x" method="post">' +
            '<input name="a"><button id="s" type="submit">Send</button></form>',
        ),
    )
    const tabs = await provider.listTabs()
    const ctx = tabs[0]?.contextId

    // Record any submission attempt so we can prove the gate stopped it.
    await provider.evaluate(
      "window.__submitted = false; document.getElementById('f')" +
        ".addEventListener('submit', () => { window.__submitted = true; });",
      ctx,
    )

    const snap = await provider.snapshot(ctx)
    const submit = snap.elements.find((e) => e.role === 'button' && e.name === 'Send')
    assert.ok(submit, 'no submit button in the snapshot')

    const blocked = await provider.click(undefined, ctx, { ref: submit.ref })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.requiresConfirm, true)
    assert.equal(blocked.action, 'form_submit')
    assert.equal(blocked.blocked, true)

    // The gate must STOP the submission, not merely report it afterwards.
    // A real submission would navigate away and lose the flag entirely.
    const fired = await provider.evaluate('window.__submitted', ctx)
    assert.equal(fired.value, false, 'the form was submitted despite the gate')
  })

  test('the network log captures requests and strips query strings', async () => {
    // The query string carries a token on purpose — it must not survive.
    await provider.navigate('https://example.com/?token=super-secret-value')
    await new Promise((r) => setTimeout(r, 1500))

    const result = await provider.network({ limit: 50 })
    assert.equal(result.ok, true)
    assert.ok(result.total > 0, 'no requests were captured')

    // No captured URL may keep a query string or the token.
    for (const req of result.requests) {
      assert.ok(!req.url.includes('?'), `the URL kept its query string: ${req.url}`)
      assert.ok(!req.url.includes('super-secret-value'), 'the token leaked into the log')
    }

    // The navigation itself must be among the captured requests.
    const http = result.requests.filter((r) => r.url.startsWith('http'))
    assert.ok(http.length > 0, 'no http request was captured')
    assert.ok(
      http.some((r) => r.url.includes('example.com')),
      `the example.com request was not captured: ${JSON.stringify(result.requests)}`,
    )
  })

  test('page text is bounded by default and marks the truncation', async () => {
    await provider.navigate(
      'data:text/html;charset=utf-8,' + encodeURIComponent(`<body>${'x'.repeat(20000)}</body>`),
    )
    const tabs = await provider.listTabs()
    const ctx = tabs[0]?.contextId

    const result = await provider.text(ctx)
    assert.equal(result.ok, true, result.error)
    // A single tool result must stay inside the ~8195-char budget.
    assert.ok(
      result.value.length <= 8195,
      `the text was ${result.value.length} chars — over the baseline`,
    )
    assert.equal(result.truncated, true)
    assert.ok(result.nextOffset > 0)
    assert.equal(result.length, 20000, 'the page text was not read in full')

    // The next chunk continues exactly where this one stopped.
    const next = await provider.text(ctx, { offset: result.nextOffset })
    assert.equal(next.ok, true, next.error)
    assert.ok(next.value.length > 0)
  })

  test('a screenshot returns a real PNG', async () => {
    await loadPage()
    const result = await provider.screenshot(contextId)
    assert.equal(result.ok, true, result.error)
    assert.match(result.data, /^iVBORw0KGgo/, 'not a PNG')
  })

  test('a screenshot carries a fetchable image url', async () => {
    await loadPage()
    const result = await provider.screenshot(contextId)
    assert.equal(result.ok, true, result.error)
    assert.ok(result.imageUrl, 'the screenshot must carry an image url')

    const res = await fetch(result.imageUrl)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
    const body = Buffer.from(await res.arrayBuffer())
    assert.equal(body.subarray(0, 4).toString('hex'), '89504e47')

    // 图片字节绝不能进上下文：文本块只应带一个短 URL。
    assert.ok(result.imageUrl.length < 200, `the url is ${result.imageUrl.length} chars`)
  })

  test('a screenshot still succeeds when the image server cannot publish', async () => {
    await loadPage()
    // Simulate a failing image host (unwritable directory, no port, …).
    const real = provider.images
    provider.images = {
      publish: async () => {
        throw new Error('the image host is unavailable')
      },
    }
    try {
      const result = await provider.screenshot(contextId)
      assert.equal(result.ok, true, result.error)
      assert.match(result.data, /^iVBORw0KGgo/, 'the screenshot itself must still be captured')
      assert.equal(result.imageUrl, undefined)
      assert.match(result.imageUrlError, /image host is unavailable/)
    } finally {
      provider.images = real
    }
  })

  test('a handoff to the in-app browser hands over the current url', async () => {
    await loadPage()
    const result = await provider.handoff('in-app')
    assert.equal(result.ok, true, result.error)
    assert.equal(result.from, 'firefox')
    assert.equal(result.to, 'in-app')
    assert.match(result.url, /^data:text\/html/)
    assert.ok(result.guidance && result.guidance.length > 10)
  })

  test('a handoff to firefox navigates and reports the effect', async () => {
    const result = await provider.handoff('firefox', {
      url: 'data:text/html;charset=utf-8,' + encodeURIComponent('<h1>Landed</h1>'),
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.to, 'firefox')
    assert.equal(result.effect.verified, true)
    const title = await provider.evaluate('document.querySelector("h1").textContent')
    assert.equal(title.value, 'Landed')
  })

  test('an unknown handoff target is refused', async () => {
    const result = await provider.handoff('nope')
    assert.equal(result.ok, false)
    assert.match(result.error, /unknown handoff target/i)
  })

  test('an element screenshot returns a real PNG', async () => {
    await loadPage()
    const snap = await provider.snapshot(contextId)
    const target = snap.elements[0]
    const result = await provider.screenshot(contextId, { elementRef: target.ref })
    assert.equal(result.ok, true, result.error)
    assert.match(result.data, /^iVBORw0KGgo/, 'not a PNG')
  })

  test('page text is readable and reports its length', async () => {
    await loadPage()
    const result = await provider.text(contextId, { maxChars: 20 })
    assert.equal(result.ok, true, result.error)
    assert.ok(result.length > 0)
    assert.equal(result.value.length, 20)
    assert.equal(result.truncated, true)
    assert.ok(result.nextOffset > 0)
  })
})
