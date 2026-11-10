# foxbidi

### Real Firefox for your coding agent — over WebDriver BiDi.

[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen.svg)](https://nodejs.org)
[![mcp](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](https://modelcontextprotocol.io)
[![firefox](https://img.shields.io/badge/Firefox-140%20ESR-verified-orange.svg)](docs/capabilities-matrix.md)
[![deps](https://img.shields.io/badge/runtime%20deps-0-success.svg)](package.json)

> 中文版：[README.zh-CN.md](README.zh-CN.md)

**MiniMax Code (MCode) can drive Chromium, but not Firefox.**

Firefox removed its experimental CDP implementation at the end of 2024.
WebDriver BiDi is the only protocol left, and the browser MCP servers that
exist today mostly speak CDP only — so if your work involves a site that only
behaves properly in Firefox, you are stuck.

`foxbidi` is the missing piece: a **zero-dependency** Node MCP server that
drives a **real Firefox** — the user's own profile, the user's own login state
— and exposes it to your agent as **43 native tools**.

It ships as a MiniMax Code plugin and works with any MCP client
(Claude Code, Cursor, …).

---

## What you get

|                      | MCode built-in browser | `foxbidi`                |
| -------------------- | ---------------------- | ------------------------ |
| Engine               | Chromium               | **Real Firefox**         |
| Protocol             | CDP                    | **WebDriver BiDi**       |
| Login state          | Separate profile       | **Your Firefox profile** |
| Multiple identities  | —                      | Firefox containers       |
| HttpOnly cookies     | Not readable           | Readable                 |
| Extension management | —                      | Install / uninstall      |
| Runtime dependencies | —                      | **0**                    |

---

## Highlights

**It keeps you logged in.** The plugin drives a _copy_ of your Firefox
profile, so the sites you are already signed into stay signed in. Sites that
refuse to work in a fresh Chromium profile — enterprise SSO, internal tools,
anything behind a device check — just work.

**It sends trusted input.** Clicks are delivered as genuine pointer events
(`pointerMove → pointerDown → pointerUp`) and typing is one key action per
character. Not synthetic DOM events, which many sites reject outright.

**It never hangs on a dialog.** A JavaScript `alert()` blocks Firefox
completely. The plugin subscribes to the prompt event, closes it automatically,
and tells the agent what it said — instead of every later command timing out
with no explanation.

**It finds what is really there.** The snapshot reaches into open shadow roots
and iframes, and pages past the 300th element instead of stopping there.

**It leaves no trace in the DOM.** Element refs live in a page-side registry
under a random, non-enumerable key. Nothing is written into the markup for a
page to find with a `MutationObserver`.

**It knows what this Firefox can do.** Capabilities are probed at runtime
against the running browser, so one build works on Firefox 118 and on Firefox
150 — and says plainly, with the required version, when a feature is missing.

**It reports honestly.** Every action returns an `effect` block. `effect.verified`
is `true` only when the URL or the DOM fingerprint actually changed; a command
that ran without effect is reported as `verified: false`, never as success.
Failures carry a machine-readable `code` (`ref_stale`, `confirm_required`,
`capability_unavailable`, …) so an agent can branch on the error instead of
pattern-matching an English sentence.

**It is safe with a real login state.** Irreversible actions (form submits,
downloads, uploads, extension installs, cookie writes) hit a confirmation
gate. Secrets are redacted on every outbound channel. And if a page hides
instructions in the DOM for the agent — off-screen text, white-on-white, 1px
fonts — the plugin detects it and reports it as untrusted content rather than
acting on it.

---

## Quick start

**Requirements:** Node ≥ 20, Firefox 118+ (140 ESR recommended and verified).

```bash
git clone https://github.com/DsDG1/foxbidi.git ~/.minimax/plugins/foxbidi
```

Point MiniMax Code at that directory and the tools appear alongside your other
plugin tools. To drive it from any other MCP client, register the stdio server:

```json
{
  "mcpServers": {
    "foxbidi": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/foxbidi/server.js"]
    }
  }
}
```

The browser starts on demand — the first tool call launches it.

**Try it:**

- _"Use Firefox to open example.com and screenshot it."_
- _"Search for 'hello' in Firefox and read the results back to me."_
- _"Open two Firefox containers — one signed in, one not."_

---

## When the host does not inject the tools

The plugin ships its own way in — no host integration required:

```bash
node tools/ff-call.mjs browser_status '{}'   # call any tool
node tools/ff-call.mjs --doctor              # what works, what does not
node tools/ff-call.mjs --serve               # start the long-lived server
node tools/ff-call.mjs --stop                # stop it
```

---

## Documentation

| Document                                         | What it covers                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| [Full plugin documentation](README-detailed.md)  | Complete tool reference, capability matrix, security model, development guide |
| [Capability matrix](docs/capabilities-matrix.md) | Which Firefox version each feature needs                                      |
| [Firefox-only guide](docs/firefox-only.md)       | What a CDP harness cannot do                                                  |
| [Troubleshooting](docs/troubleshooting.md)       | Why the click did nothing                                                     |
| [Agent guide](skills/firefox-browser/SKILL.md)   | How an agent should drive it                                                  |

---

## License

MIT. See [LICENSE](LICENSE).
