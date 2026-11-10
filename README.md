# firefox-browser

A MiniMax Code plugin that drives a **real Firefox** over
[WebDriver BiDi](https://w3c.github.io/webdriver-bidi/) and exposes it to the
agent as native MCP tools.

- **Zero npm dependencies.** The WebSocket framing and the BiDi protocol layer
  are hand-rolled on top of `node:net` — nothing to install, nothing to audit.
- **Real login state.** The plugin drives a copy of your Firefox profile, so
  sites you are signed into stay signed in.
- **Trusted input.** Clicks deliver genuine pointer events
  (`pointerMove → pointerDown → pointerUp`) and typing sends one key action per
  character — not synthetic DOM events, which many sites reject.
- **Built for agents.** A snapshot layer with stable element refs, an explicit
  confirmation gate for irreversible actions, honest effect reporting, and
  network diagnostics for the "the click did nothing" case.
- **It never hangs on a dialog.** A JavaScript dialog blocks Firefox; the plugin
  closes it automatically and tells the agent what it said.
- **It finds what is really there.** The snapshot reaches into open shadow roots
  and iframes, and pages past the 300th element instead of stopping there.
- **It leaves no trace in the DOM.** Refs live in a page-side registry under a
  random, non-enumerable key — nothing is written into the markup.
- **It knows what this Firefox can do.** Capabilities are probed at runtime, so
  one build works on Firefox 118 and on Firefox 150, and says plainly when a
  feature is missing.
- **It uses what only Firefox has.** Containers (isolated identities),
  extension management, privileged chrome:// contexts, HttpOnly cookies.
- **It can solve a CAPTCHA when the site asks for one.** Turnstile, reCAPTCHA
  audio, hCaptcha, GeeTest sliders, proof-of-work, and Baidu's rotate-to-upright
  slider (`spin`) — all without a bundled model and without npm dependencies.

> Firefox has no CDP support (Mozilla removed the experimental implementation
> at the end of 2024), so WebDriver BiDi is the only way to automate it — and
> that is exactly what makes the Firefox-only capabilities available.

## What 2.3 changed

**The plugin got faster, smaller and easier to branch on.**

- **Four new tools.** `browser_back` and `browser_forward` walk the tab history
  (`browsingContext.traverseHistory`, Firefox 122+), `browser_reload` reloads the
  tab (Firefox 119+), and `browser_set_viewport` overrides the viewport so a
  responsive layout can be exercised without resizing the window (Firefox 117+).
  The protocol layer already had the wrappers; nothing called them.
- **Machine-readable error codes.** Every failure now carries a `code` next to
  the human-readable `error`, so an agent can branch on `ref_stale` instead of
  matching an English sentence. The `error` text is unchanged, so existing
  callers keep working. The full vocabulary is in
  [`skills/firefox-browser/REFERENCE.md`](skills/firefox-browser/REFERENCE.md).
- **Actions are ~4× faster.** The plugin used to wait a fixed 250ms on every
  action for a dialog event that might never arrive. It now counts dialogs with
  an epoch counter and only waits for an event that is actually in flight:
  **272.8ms → 66.6ms** mean for a click, measured on Firefox 140.
- **The injected tool catalogue is 24% smaller.** The tool definitions are
  re-injected on every turn, so their prose is a permanent cost: **44128 →
  33380 bytes** for the 38 tools. Tool names, parameters, types and order did
  not change; only the descriptions were trimmed, and the detail moved into the
  skill's reference file, which is read on demand.
- **The source is smaller.** `provider.js` went from 3457 lines to 316 (one
  module per concern) and `server.js` from 1665 to 526 (the tool catalogue
  moved to `lib/mcp/tools/`).
- **The download event gates were wrong.** They claimed Firefox 133 for both
  `downloadWillBegin` and `downloadEnd`. Firefox ships them in **144** and
  **145** respectively — on Firefox 140 the event names are rejected outright.

## What 2.2 changed

**Baidu's rotate-to-upright captcha is now a first-class solver.**

The challenge shows a photo that is already turned off-axis inside a circle and
asks you to drag a slider until the picture is straight. The site does not
issue a token: it grades the **angle** you dragged, in the response of
`POST /cap/log` (`data.op`). So `browser_captcha` for this solver reports
success when the **server** accepted the angle.

- The picture is fetched and analysed **inside the page** — the bytes are pulled
  separately (the canvas would otherwise be tainted by the cross-origin image),
  decoded with `createImageBitmap`, and only the resulting angle travels back.
- The orientation estimate combines an edge-alignment histogram, a masked
  per-band detail profile (an upright photo is sparse at the top, dense in the
  middle, tapering below) and a top-versus-bottom brightness term, then refines
  inside the winning candidate. Sampling is bilinear: nearest-neighbour turns
  every edge into a staircase, and the staircase's own edge directions drag the
  angle off by several degrees.
- Pictures the solver cannot judge with confidence are **skipped, not guessed**
  — a wrong answer is what makes the site start demanding extra checks.
- The drag is human-shaped: the pointer first wanders over the picture (the
  site records that path), then the handle is dragged with easing, a pause
  between steps and a little vertical wobble.
- Baidu's risk control may still ask for one more verification after accepting
  the angle (`data.opp = 3`). That is reported as `risk_challenge`, because a
  correct answer and a flagged session are different problems — and because
  risk control is session-level, the solver stops there instead of hammering
  the endpoint.
- Measured on a single egress IP: the server accepts the angle on roughly half
  of the rounds that are submitted, and about half of the `browser_captcha`
  calls end in `solved`. The rest are mostly risk-control prompts. Pictures the
  solver cannot judge are skipped instead of guessed.

## What 2.0 changed

**Fixed the things that made the agent fail.**

- JavaScript dialogs are handled. Before, a page that raised an `alert()` froze
  Firefox and every later command timed out with no explanation. Now the dialog
  is closed automatically and reported in the action's `effect.dialog`.
- The snapshot reaches past the 300th element. The old script stopped after 300
  candidates, so everything beyond that was unreachable no matter what offset
  was asked for. Paging is now applied in the page.
- The snapshot pierces open shadow roots and can include iframe contents.
- A stale ref is detected even when the element was merely detached — acting on
  it would have hit nothing, or worse, whatever replaced it.

**Removed the DOM trace.**

Refs used to be written into the page as `data-mavis-ff-ref` attributes, which
any page could find with a `MutationObserver` or a single attribute selector.
They now live in a page-side registry under a random, non-enumerable `window`
key. Nothing is written into the markup.

**Added the Firefox-only capabilities.** Containers, extension management,
privileged chrome:// contexts, HttpOnly cookies, request interception, response
bodies (Firefox 144+) and an honest detectability report.

**Added the workflow tools.** `browser_batch` (many actions, one round trip),
`browser_run_script` (write a helper once, reuse it forever) and `browser_config`.

**Changed one contract.** `browser_status` no longer returns a pretty-printed
JSON dump in its text block — the status grew a capability matrix, and a dump
costs tokens on every call. The text block is now a one-screen summary and the
full payload is in `structuredContent`, as with every other tool.

**Probed instead of assumed.** The plugin asks the running Firefox what it
supports instead of hard-coding a version. A missing feature produces
`capability_unavailable` with the requirement, the detected version and an
alternative — never an opaque `unknown command`. `browser_status` stays read-only
(it never starts a browser just to answer a question): while Firefox is idle the
matrix is a version-based expectation (`capabilities.probed: false`), and once it
runs the same matrix is a live probe (`capabilities.probed: true`).

## Install

The package is a standard local MiniMax plugin:

```
firefox-browser/
  .minimax-plugin/plugin.json   # manifest
  servers.mcp.json              # stdio MCP server declaration
  server.js                     # MCP server entry point
  lib/bidi/                     # WebDriver BiDi protocol layer
  lib/firefox/                  # profile handling, launching, high-level API
  lib/mcp/                      # output schemas and result shaping
  skills/firefox-browser/        # usage guide for the agent
  docs/                         # capability matrix, Firefox-only guide, troubleshooting
```

Point MiniMax Code at `~/.minimax/plugins/firefox-browser/` and the MCP tools
appear alongside your other plugin tools.

## The agent loop

The plugin is designed around the way an agent actually drives a browser:

```
browser_snapshot  →  act on a ref  →  read the effect block
```

`browser_snapshot` returns an ARIA-style list of the page's interactive
elements — role, accessible name, state, geometry — each with a short stable
`ref`:

```jsonc
{
  "ok": true,
  "snapshotId": 3,
  "refMode": "registry",
  "elements": [
    {
      "ref": "e3",
      "role": "textbox",
      "name": "User",
      "rect": { "x": 8, "y": 40, "w": 280, "h": 24 },
      "inViewport": true,
    },
    {
      "ref": "e5",
      "role": "button",
      "name": "Sign in",
      "rect": { "x": 8, "y": 80, "w": 90, "h": 32 },
      "inViewport": true,
    },
  ],
}
```

Actions then target a `ref` instead of a guessed CSS selector. Refs are bound
to the DOM, so they expire when the page re-renders — a stale ref is reported
explicitly (`requiresResnapshot: true`) rather than silently hitting the wrong
element.

The snapshot reaches further than a plain DOM walk:

- **open shadow roots** are entered, so controls inside web components are found;
- **iframe contents** can be included with `frames: "all"` (their refs carry a
  frame prefix, and an action on one is routed to the right frame);
- **pagination is real** — `offset`/`maxElements` are applied in the page, so the
  301st element is as reachable as the 1st;
- **filters shrink the payload**: `roleFilter`, `nameContains`, `includeText`.

Refs are stored in a page-side registry under a random, non-enumerable `window`
key, so the page cannot find the plugin's bookkeeping in the markup.

Every action reports an `effect` block comparing the page before and after.
`effect.verified` is honest: it is `true` only when the URL or the DOM
fingerprint actually changed. A command that ran without effect is reported as
`verified: false`, with a hint — never as success.

## Tools

Every tool declares an `outputSchema` and returns matching `structuredContent`,
so a host can consume the result as data rather than parsing prose.

### Lifecycle

| Tool                | Arguments                            | Behaviour                                                                                                           |
| ------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `browser_start`     | —                                    | Copy the profile, launch Firefox, open a BiDi session. Idempotent and concurrency-safe.                             |
| `browser_stop`      | `keep?: boolean`                     | End the session; terminates the process unless `keep` is true. A later `browser_start` re-adopts the kept instance. |
| `browser_status`    | —                                    | Instance state, port, pid, session id, profile info, the capability matrix, the ref mode and the dialog policy.     |
| `browser_new_tab`   | `url?: string`                       | Open a tab, optionally navigating it.                                                                               |
| `browser_navigate`  | `url`, `contextId?`, `wait?`         | Navigate a tab. `wait` is `none`, `interactive` or `complete` (default).                                            |
| `browser_tabs`      | —                                    | Open tabs and iframes with their context ids.                                                                       |
| `browser_close_tab` | `contextId?`                         | Close a tab.                                                                                                        |
| `browser_back`      | `contextId?`                         | Go back one entry in the tab history. Firefox 122+.                                                                 |
| `browser_forward`   | `contextId?`                         | Go forward one entry in the tab history. Firefox 122+.                                                              |
| `browser_reload`    | `contextId?`                         | Reload the tab. Firefox 119+.                                                                                       |
| `browser_handoff`   | `to`, `url?`, `contextId?`, `carry?` | Move the page between this Firefox and the host's in-app browser.                                                   |

### Discovery and reading

| Tool                 | Arguments                                                                                          | Behaviour                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `browser_snapshot`   | `contextId?`, `offset?`, `maxElements?`, `roleFilter?`, `nameContains?`, `includeText?`, `frames?` | Elements with role, name, state, geometry and a stable `ref`. Reaches into shadow roots and (optionally) iframes.      |
| `browser_text`       | `contextId?`, `maxChars?`, `offset?`, `selector?`                                                  | Visible text. Capped at 8000 characters by default; `truncated` and `nextOffset` let you page through.                 |
| `browser_evaluate`   | `expression`, `contextId?`                                                                         | Evaluate JavaScript in the page.                                                                                       |
| `browser_screenshot` | `contextId?`, `fullPage?`, `elementRef?`                                                           | PNG screenshot, delivered as an MCP image block plus an `imageUrl` (see below).                                        |
| `browser_logs`       | `limit?`, `levels?`, `channel?`, `filter?`                                                         | Buffered logs, split into `console` (the page), `plugin` (what the plugin did) and `bidi` (a command Firefox refused). |
| `browser_network`    | `limit?`, `status?`, `types?`, `filter?`, `requestId?`                                             | Captured requests. URLs never carry a query string. `requestId` also fetches the response body (Firefox 144+).         |

### Actions

All action tools accept **either** `ref` (preferred) **or** `selector`. When
both are given, the ref wins and the result says so.

| Tool                    | Arguments                                                        | Behaviour                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_click`         | `ref?` / `selector?`, `button?`, `clickCount?`, `confirm?`       | Click with real pointer events.                                                                                                               |
| `browser_type`          | `ref?` / `selector?`, `text`, `clear?`, `submit?`, `confirm?`    | Focus and type character by character.                                                                                                        |
| `browser_press_key`     | `key`, `contextId?`                                              | Key or shortcut: `Enter`, `Escape`, `Ctrl+Enter`. A shortcut holds its modifier down across the target key.                                   |
| `browser_select_option` | `ref?` / `selector?`, `value`                                    | Choose a `<select>` option by value.                                                                                                          |
| `browser_check`         | `ref?` / `selector?`, `checked`                                  | Check or uncheck a checkbox / radio.                                                                                                          |
| `browser_hover`         | `ref?` / `selector?`                                             | Move the pointer over an element.                                                                                                             |
| `browser_scroll`        | `ref?` / `selector?`, `direction?`, `amount?`                    | Scroll the page, or bring an element into view.                                                                                               |
| `browser_upload`        | `ref?` / `selector?`, `paths`, `confirm?`                        | Attach local files to a file input.                                                                                                           |
| `browser_wait_for`      | `for?`, `selector?`, `text?`, `timeoutMs?`                       | Wait for a selector, text, load, or network idle.                                                                                             |
| `browser_set_viewport`  | `width`, `height`, `devicePixelRatio?`, `contextId?`, `confirm?` | Override the viewport to test a responsive layout without resizing the window. Firefox 117+. Confirmation required — it re-lays-out the page. |

The browser starts on demand — the first tool call launches it, so there is no
separate launch step.

### Workflow and Firefox-only

| Tool                    | Arguments                                                   | Behaviour                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_batch`         | `steps[]`, `stopOnError?`                                   | Run several actions in one call — click, type, press a key, wait, snapshot. Stops at the first failure and reports how far it got.              |
| `browser_run_script`    | `path`, `args?`, `contextId?`                               | Run a helper script in the page. Scripts live in `~/.mavis/ff-workspace/` so a repeatable sequence can be written once and reused.              |
| `browser_config`        | `preset?`, `dialogPolicy?`, `maxSnapshotElements?`          | Read or change the tool preset, the dialog policy and the default snapshot size.                                                                |
| `browser_handle_dialog` | `action`, `text?`                                           | Accept, dismiss, or answer a JavaScript dialog.                                                                                                 |
| `browser_context`       | `action`, `userContext?`, `label?`, `url?`                  | Firefox containers: isolated cookies, localStorage and cache. Firefox 124+.                                                                     |
| `browser_extension`     | `action`, `path?`, `extensionId?`, `permanent?`, `confirm?` | Install, uninstall or list WebExtensions. Firefox 137+.                                                                                         |
| `browser_cookie`        | `action`, `filter?`, `cookie?`, `confirm?`                  | Read or write cookies, including HttpOnly ones. Firefox 124+.                                                                                   |
| `browser_intercept`     | `action`, `patterns?`                                       | Block requests whose URL matches. Matching happens in the plugin, and every request is released again, so the page never freezes. Firefox 124+. |
| `browser_detectability` | `contextId?`                                                | Measure how detectable this session is — honestly.                                                                                              |

See [`docs/firefox-only.md`](docs/firefox-only.md) for what these can do that a
CDP-based harness cannot, and
[`docs/capabilities-matrix.md`](docs/capabilities-matrix.md) for the version
requirements.

## The context cost of the tool catalogue

Every tool definition is injected into the model's context **on every turn**, so
the catalogue is a permanent cost — not a one-off. Measured on the wire, in
exactly the shape the server sends for `tools/list`:

|                                   | Bytes     | Per tool |
| --------------------------------- | --------- | -------- |
| v2.2.0 (34 tools)                 | 37925     | 1115     |
| v2.3.0 before the trim (38 tools) | 44128     | 1161     |
| v2.3.0 after the trim (38 tools)  | 33380     | 879      |
| v2.5.0 slim preset (22 tools)     | **18774** | **854**  |
| v2.5.0 basic preset (32 tools)    | **27621** | **863**  |
| v2.5.0 full catalogue (38 tools)  | 33672     | 886      |

The trim cut the tool descriptions to one short clause each, shortened the
shared schema fragments (one of which is copied into 27 tools, so its wording is
multiplied by 27), and made the output-schema property descriptions optional.
Tool names, parameters, types and order did not change — only prose moved, and
it moved into the skill's reference file, which is read on demand.

**The catalogue is now trimmed to the active preset.** `tools/list` returns
only the tools the current preset exposes, and the server tells the host when
that set changes. The default preset is `basic`, which saves about 6KB per
turn against the full catalogue and 18KB against the pre-trim size; `slim` saves
almost half. `browser_config` is always in the list, so the agent can widen
the set itself:

```json
{ "tool": "browser_config", "args": { "preset": "all" } }
```

**What was deliberately not done.** The catalogue is trimmed by PRESET, not per
task: deciding which tools a particular task needs is a product decision, and a
tool the agent cannot see is a tool it will not use. The preset is the seam for
that decision, and the user can always widen it.

## Two browser surfaces, and how to move between them

This machine has two browser surfaces:

| Surface                             | What it is                                                                                   | When to use it                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **This plugin's Firefox** (default) | A real Firefox running on a copy of the user profile — full login state, real Firefox engine | **The default for every browsing task.**                                                                                       |
| **The host's in-app browser**       | The `mcp_browser` capability, i.e. the browser panel the host owns                           | When the user explicitly says "current browser" / "right-side browser" / "built-in browser", or wants to watch the work happen |

The in-app browser can drive Chrome and Edge, so it does carry a login state —
it just cannot drive Firefox, because Firefox has no CDP.

`browser_handoff` moves a page between them:

- `{"to": "in-app"}` — read-only. Returns the current Firefox URL, the title
  and a guidance line; the agent then opens that URL in the in-app browser.
- `{"to": "firefox", "url": "…"}` — acts. Navigates this Firefox to a URL you
  read from the in-app browser, and reports the `effect` (including
  `verified`).

**Session state never travels across.** Logins, cookies and tabs stay on the
surface they came from; only the URL is handed over.

> This plugin deliberately does **not** declare a `browser.use` host binding.
> The host resolves that capability by requiring exactly one plugin to claim
> it — a second claimant would make the in-app browser disappear entirely.

## How a screenshot reaches the user

`browser_screenshot` returns the PNG as an MCP image content block, which the
model receives natively — the image bytes never become text tokens.

For the _user_, the result also carries an `imageUrl`: the plugin serves the
screenshot from a tiny HTTP server bound to `127.0.0.1`, under a path with a
192-bit random token. A chat client that renders markdown — the webui does —
turns

```markdown
![page](http://127.0.0.1:54321/i/<token>.png)
```

into a visible picture. Only the ~120-character URL travels through the
model's reply; the picture itself stays out of the context window.

If the image server cannot start, the screenshot still succeeds and the result
carries `imageUrlError` instead of `imageUrl`.

The server starts lazily on the first screenshot and is closed — with its
files deleted — when the browser session stops.

## The confirmation gate

Actions that cannot be undone are refused unless the caller passes
`confirm: true`:

- submitting a form (a submit control, or a POST form),
- downloading a file (`download` attribute),
- uploading a local file,
- posting account or credential data to another origin,
- installing an extension,
- writing a cookie.

Classification is done on **DOM facts**, not on button text — a Chinese site
labels a search button 搜索 and an English site labels a harmless button OK,
so keyword matching would misfire constantly. A false positive costs one extra
`confirm: true`; a false negative can commit an irreversible action, so the
gate leans strict.

A refused action is stopped _before_ the input is dispatched, and the result
carries `blocked: true`, `action`, `requiresConfirm: true` and a human-readable
`hint`.

## The error contract

A failed tool call returns two fields for the same failure:

- `code` — a fixed, machine-readable word (`ref_stale`, `confirm_required`,
  `invalid_argument`, `capability_unavailable`, …).
- `error` — the human-readable sentence, unchanged from previous versions.

Agents should branch on `code`. Matching an English sentence means matching
its wording, which breaks the moment someone rewords the message. The
`error` text is still there for people and for existing callers, and the
`hint` field says what to do next.

The full vocabulary is in
[`skills/firefox-browser/REFERENCE.md`](skills/firefox-browser/REFERENCE.md),
and a test checks it against the source table so the two cannot drift apart.

## Configuration

All settings are environment variables. The MCP server inherits `HOME`,
`PATH` and the other standard variables from the host.

| Variable                           | Default                 | Meaning                                                                                                                                           |
| ---------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIREFOX_BROWSER_BIN`              | auto-detected           | Path to the Firefox binary.                                                                                                                       |
| `FIREFOX_BROWSER_PORT`             | `9333`                  | Preferred BiDi port; occupied ports are probed upward.                                                                                            |
| `FIREFOX_BROWSER_HEADLESS`         | `1`                     | Set to `0` for a visible window (manual CAPTCHA / login).                                                                                         |
| `FIREFOX_BROWSER_PROFILE`          | auto-detected           | Source profile. Auto-detection prefers the profile a running Firefox holds.                                                                       |
| `FIREFOX_BROWSER_PROFILE_COPY`     | see below               | Base directory for the profile copy.                                                                                                              |
| `FIREFOX_BROWSER_TIMEOUT_MS`       | `30000`                 | Per-BiDi-command timeout.                                                                                                                         |
| `FIREFOX_BROWSER_READY_TIMEOUT_MS` | `30000`                 | How long to wait for the BiDi endpoint.                                                                                                           |
| `FIREFOX_BROWSER_PRIVILEGED`       | `0`                     | Set to `1` to launch with `--remote-enable-system-access`, which unlocks the privileged chrome:// contexts (`about:preferences`, `about:addons`). |
| `FIREFOX_BROWSER_PREFS`            | —                       | JSON object of Firefox preferences to apply to the **profile copy** only, e.g. `{"privacy.resistFingerprinting":true}`.                           |
| `FIREFOX_BROWSER_SCRIPT_ROOTS`     | `~/.mavis/ff-workspace` | Colon-separated directories `browser_run_script` may read scripts from.                                                                           |
| `FIREFOX_BROWSER_DIALOG_SETTLE_MS` | `40`                    | How long an action waits for a dialog event that may still be in flight. See below.                                                               |

### The dialog settle window

Every action reports whether a dialog appeared while it ran. The plugin used
to do that by waiting a **fixed 250ms** for an event that might never arrive,
which is why every action used to cost ~270ms.

It does not work that way any more. The `browsingContext.userPromptOpened`
event arrives _before_ the action's own command returns, so the plugin counts
dialogs with an epoch counter: an action captures the counter before it runs
and compares afterwards. If it moved, a dialog opened and the action waits
only for the auto-handler to close it. If it did not move, the action waits
the small window above for an event that might still be in flight.

Measured on Firefox 140 (5 clicks, no dialog): **272.8ms → 66.6ms** mean.

The window is configurable for pages that open their dialog unusually late.
Raising it makes every action slower, so raise it only if a dialog is being
missed; the default is enough for normal pages.

### Where the profile copy lives

The copy contains live credentials, so it must live **outside** the plugin
package — the package is size-limited, scanned, and may be reinstalled. The
base directory is resolved at runtime, first hit wins:

1. `FIREFOX_BROWSER_PROFILE_COPY` — explicit operator override.
2. `PLUGIN_DATA` — the host's own per-plugin data directory, when injected.
3. `<plugin-root>/../.plugin-data/firefox-browser` — the platform's plugin-data
   convention, derived from this package's own location, so it works with no
   injection at all.
4. `~/.minimax/v2/plugin-data/agent-plugins/firefox-browser`.
5. `~/.cache/firefox-browser/profile` — last resort.

The copy itself is `<base>/profile-<hash>` (the hash is derived from the source
profile path, so different profiles do not collide) and is created with mode
`0700`.

### Why a copy, and not "attach to the running Firefox"

`--remote-debugging-port` is a **startup** flag — a running Firefox cannot be
given a BiDi endpoint afterwards, because `remote.active-protocols` only takes
effect on restart. The running instance also holds an exclusive lock on its
profile. Copying the profile and launching a second instance against the copy
is therefore the only way to drive a Firefox that carries your real session.

The copy is a snapshot: tabs are not shared, and later changes in the real
Firefox are picked up on the next re-copy.

A profile can only be opened by one browser at a time, so **one running
browser needs one profile copy**. The plugin drives a single instance, which
is all the Firefox remote agent allows anyway (one BiDi session per endpoint).

### Restarting after `browser_stop({keep: true})`

`keep: true` leaves Firefox running, and a running Firefox keeps the profile
copy locked — a second Firefox cannot open it, and Firefox reports _"Firefox is
already running, but is not responding."_ That is a **locked profile**, not a
port conflict, and the plugin says so instead of guessing.

The kept instance's BiDi endpoint is still alive and accepts a new session, so
the next `browser_start` **re-adopts** it (`adopted: true`): same pid, same
port, same tabs, same login state.

### When the port is already taken

If the preferred port is held — by a stale browser from an earlier run, or by
another process — the plugin does not connect to it. A freshly launched Firefox
cannot already carry a session, so a refused `session.new` proves the endpoint
belongs to somebody else; the plugin then moves to the next port instead of
silently driving the wrong browser.

## Development

```bash
npm test                # unit + integration tests (Node's built-in runner)
npm run test:unit       # unit tests only — no browser needed
npm run test:integration# integration tests only — launches a real Firefox
npm run lint            # ESLint (flat config)
npm run format          # Prettier, in place
npm run format:check    # Prettier, check only
npm run validate        # validate the plugin package
```

The integration tests launch a real Firefox and skip themselves when none is
installed. Each live-browser test file uses its own base port, because the test
runner runs files in parallel.

The plugin has **no runtime npm dependencies** — ESLint and Prettier are
devDependencies only, and the MCP server runs on a bare Node install.

Layout:

- `lib/bidi/frame.js` — RFC 6455 frame codec (masking, length extension,
  fragmentation, ping/pong).
- `lib/bidi/client.js` — BiDi command/event routing, command serialisation,
  timeouts.
- `lib/bidi/protocol.js` — BiDi command wrappers and `RemoteValue` unwrapping.
- `lib/mcp/schema.js` — output schemas and result shaping.
- `lib/mcp/tools/` — the tool catalogue, one module per concern, with an
  explicit `TOOL_ORDER` so the order the host receives cannot drift.
- `lib/firefox/profile.js` — profile detection, lock detection, copying,
  fingerprinting.
- `lib/firefox/launcher.js` — binary detection, port allocation, process start.
- `lib/firefox/provider.js` — the provider class and the state every method
  shares.
- `lib/firefox/provider/` — the provider methods, one module per concern
  (session, process, tabs, action, target, inspect, diagnostic, firefox,
  captcha, workflow, events, support).
- `lib/firefox/errors.js` — the error contract: the code table, `fail()` and
  the classification helpers.
- `lib/firefox/snapshot.js` — the injected ARIA snapshot script and ref helpers.
- `lib/firefox/registry.js` — the page-side ref registry (no DOM attributes).
- `lib/firefox/dialogs.js` — JavaScript-dialog handling.
- `lib/firefox/capabilities.js` — the capability probe and its gating.
- `lib/firefox/contexts.js` — Firefox container (user context) management.
- `lib/firefox/selector.js` — ref / selector resolution and element inspection.
- `lib/firefox/inputs.js` — pointer, keyboard, typing and selection.
- `lib/firefox/wait.js` — condition waiting.
- `lib/firefox/fingerprint.js` — the page fingerprint used to detect change.
- `lib/firefox/network.js` — request capture and URL redaction.
- `lib/firefox/images.js` — the loopback screenshot server.
- `lib/firefox/confirm.js` — the irreversibility gate.
- `server.js` — the MCP stdio server.

## Security notes

- The BiDi endpoint binds `127.0.0.1` and is reachable only from this machine.
- The profile copy holds real cookies and saved passwords. It is created with
  `0700`, the credential-bearing files inside it with `0600`, is never served
  over HTTP, and is not part of the plugin package. Delete the base directory
  to revoke it. The copy expires after 24 hours by default
  (`FIREFOX_BROWSER_PROFILE_TTL_HOURS`) and is rebuilt from the source when
  it does.
- `browser_evaluate` executes arbitrary JavaScript in the page. It is exposed
  as a named, visible tool rather than a hidden escape hatch.
- **Every channel that carries raw page content is redacted** (see
  `lib/firefox/redact.js`): cookie values, the page's console output, input
  field values in a snapshot, response bodies, the text read by
  `browser_text`, the visible text blocks of a snapshot, and the value
  returned by `browser_evaluate`. A password, a one-time code and a card
  number are all values a page can hold, and only a password was covered
  before. `revealValues` / `revealBody` are the explicit escape hatches.
- **Content that a human cannot see is reported, and can stop an action.**
  A page can hide text from a person — off-screen, white-on-white, a 1px
  font, a clip — while leaving it in the DOM for an agent to read. The
  plugin computes those render facts (`lib/firefox/visibility.js`), checks
  the text for instruction patterns (`lib/firefox/injection.js`), and
  reports the combination as `warnings[]` on the reading tools. Nothing is
  deleted: off-canvas menus and screen-reader labels are legitimately
  hidden, and removing them would break real sites.
- **A hidden injection can block data egress.** When a page carries a
  high-severity warning, the actions that would carry data out — form
  submits, uploads, downloads, cookie writes, extension installs — are
  refused with `code: 'injection_blocked'`. This block is deliberately
  NOT released by `confirm: true`: the agent supplies that flag itself, so
  a hijacked agent could release its own lock. Only the user can, by
  setting `FIREFOX_BROWSER_INJECTION_GATE=off`. Reading the page is never
  blocked — the agent needs to read it to report what happened.
- **Page content is labelled as page content.** Reading tools return a
  `source` field (`{origin, kind, trusted}`) alongside `warnings[]`. The
  `origin` is the site's origin only — never the full URL, because the
  query string routinely carries session tokens.
- Captured request URLs are stripped of their query string and fragment before
  they leave the plugin — query strings routinely carry session tokens. No
  headers, cookies or bodies are captured.
- **The confirmation gate covers every path that can submit a form**, not
  just a click on a submit button: pressing Enter in a field, changing a
  `<select>` and toggling a radio can all submit one in standard HTML. The
  gate decides on DOM facts — a submit control, a POST form, or a form that
  has a submit control.
- `browser_run_script` only reads scripts from the configured roots
  (`~/.mavis/ff-workspace/` by default). The check resolves every symbolic
  link on both sides before comparing, so a link inside the workspace
  pointing outside it is refused. It executes the script in the page, like
  `browser_evaluate`.
- **Navigation is restricted.** The browser carries the user's real login
  state, so it will not navigate to a literal private address or `localhost`,
  nor to `file:` / `data:` / `javascript:`. `FIREFOX_BROWSER_ALLOW_PRIVATE_HOSTS=1`
  allows private hosts for local development. A hostname that resolves to a
  private address is NOT covered — the policy does not resolve DNS.
- **Every tool call is audited** to a per-day JSONL file under the plugin's
  data directory: what was called, what it targeted, whether it was blocked.
  Typed text and cookie values are never recorded.
- `FIREFOX_BROWSER_PREFS` is applied to the profile **copy** only; the user's
  own profile is never modified.
- The plugin opens no listening ports of its own, except the screenshot
  service described above: it binds `127.0.0.1` only, uses an OS-assigned
  port, serves nothing but PNGs whose token was actually published (anything
  else is a 404), expires each URL after an hour, and is closed with its files
  deleted when the session stops.
