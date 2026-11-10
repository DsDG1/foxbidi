# foxbidi

A Node MCP server that drives Firefox over WebDriver BiDi.

[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen.svg)](https://nodejs.org)
[![mcp](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](https://modelcontextprotocol.io)
[![firefox](https://img.shields.io/badge/Firefox-140%20ESR-verified-orange.svg)](docs/capabilities-matrix.md)
[![deps](https://img.shields.io/badge/runtime%20deps-0-success.svg)](package.json)

> 中文版：[README.zh-CN.md](README.zh-CN.md)

Firefox removed its experimental CDP implementation at the end of 2024, which left
WebDriver BiDi as the only protocol it exposes for automation. `foxbidi`
implements that protocol — WebSocket framing and the BiDi session layer are both
hand-rolled on `node:net` — and exposes the browser through 43 MCP tools.

It runs as a plain stdio MCP server, so any MCP client can attach to it. The
same code is also packaged as a MiniMax Code plugin; the host side of that
integration is documented separately in
[docs/mcode-plugin.md](docs/mcode-plugin.md).

## Design

- **No runtime npm dependencies.** The only npm packages in the repository are
  ESLint and Prettier, and both are devDependencies.
- **The session runs against a copy of a Firefox profile.** Cookies and logins
  in that profile are available to the session. Tabs are not shared with a
  running Firefox, and the copy is a snapshot.
- **Input is delivered as browser events.** Clicks are pointer events
  (`pointerMove → pointerDown → pointerUp`) and typing sends one key action per
  character, rather than synthetic DOM events.
- **Every action returns an `effect` block.** `effect.verified` is `true` only
  when the URL or the DOM fingerprint changed.
- **Dialogs are closed and reported.** A JavaScript `alert()` blocks Firefox;
  the plugin closes it and returns what it said.
- **Capabilities are probed at runtime.** The tool set is probed against the
  running browser, so one build works on Firefox 118 and on Firefox 150.
  Missing features are reported as `capability_unavailable`.

## Requirements

Node ≥ 20 and Firefox 118+ (140 ESR is the verified configuration). The
browser is launched on demand, on the first tool call that needs it.

## Install

### As a plain MCP server

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

### As a MiniMax Code plugin

Clone the repository into the host's plugin directory; the host scans that
directory and starts the server itself:

```bash
git clone https://github.com/DsDG1/foxbidi.git ~/.minimax/plugins/foxbidi
```

The package layout, the host's package contract and the failure modes that
keep a plugin from being loaded are documented in
[docs/mcode-plugin.md](docs/mcode-plugin.md).

## How it works

### Package layout

```
foxbidi/
  server.js                 # MCP server entry point
  lib/bidi/                 # WebDriver BiDi protocol layer
  lib/firefox/              # profile handling, launching, the provider
  lib/mcp/                  # output schemas and the tool catalogue
  skills/firefox-browser/   # the guide the agent reads
  tools/                    # CLI entry point and package tooling
  docs/                     # reference documents
```

### The MCP server

The server speaks MCP over stdin/stdout. It builds the tool catalogue from
`lib/mcp/tools/`, answers `tools/list` and `tools/call`, and starts the browser
on the first call that needs it.

### The tool catalogue and presets

Every tool definition is injected into the model's context on every turn, so
the catalogue is a permanent context cost rather than a one-off. The server
therefore ships presets and picks one automatically:

| Preset      | Tools | Contents                                        |
| ----------- | ----- | ----------------------------------------------- |
| `slim`      | 24    | the everyday loop                               |
| `basic`     | 36    | + fine-grained input, logs, assertions, cookies |
| `developer` | 43    | + the Firefox-only family, CAPTCHA, egress      |
| `all`       | 43    | everything                                      |

Switch with `browser_config({preset: "all"})`.

### The agent guide

`skills/firefox-browser/SKILL.md` is read by the agent, not by the user. It
carries the operating rules: take a snapshot first, act on a `ref`, read the
`effect` block, branch on `code` rather than on `error`, never route around the
confirmation gate. `REFERENCE.md` next to it is the parameter reference and the
full error vocabulary.

### Why a profile copy instead of attaching to a running Firefox

`--remote-debugging-port` is a startup flag: a running Firefox cannot be given
a BiDi endpoint afterwards, and the running instance holds an exclusive lock on
its profile. Copying the profile and launching a second instance against the
copy is therefore the only way to drive a Firefox that carries a real session.
The copy is a snapshot — tabs are not shared.

### The CLI entry point

Tools normally reach the agent through an MCP client. The repository also ships
a direct entry point that needs no client configuration:

```bash
node tools/ff-call.mjs browser_status '{}'   # call any tool
node tools/ff-call.mjs --doctor              # what works, what does not
node tools/ff-call.mjs --serve               # start the long-lived server
node tools/ff-call.mjs --stop                # stop it
```

A call needs a server on the other end of the control socket. When none is
running, the call starts one: a detached daemon that survives the shell that
started it and keeps one Firefox alive across calls. The daemon is started with
no stdin at all, because a stdio transport treats EOF as "the client is gone" —
a server that reads stdin kills itself the moment it is detached.

The control socket is off by default for a stdio server. With
`FIREFOX_BROWSER_CONTROL_SOCKET=1` the server also listens on `control.sock`
(0600) in the data directory, speaking the same JSON-RPC to the same provider —
the same Firefox, the same tabs. A server that finds the socket already served
by a live peer steps aside instead of taking it over: two servers would mean
two Firefoxes, and the BiDi session allows only one.

`--doctor` reports the plugin version, the control socket, the browser state and
whether this machine can resolve and reach the outside world. On MiniMax Code it
also compares the host's tool registry against this build; see
[docs/mcode-plugin.md](docs/mcode-plugin.md).

### The runtime data directory

The profile copy, the control socket, the audit log and the screenshot server
live in a data directory outside the package. It is resolved in this order:
`FIREFOX_BROWSER_PROFILE_COPY`, then `PLUGIN_DATA`, then
`<package root>/../.plugin-data/firefox-browser`, then
`~/.minimax/v2/plugin-data/agent-plugins/firefox-browser`.

### Screenshots

`browser_screenshot` returns the PNG as an MCP image content block, so the
model receives the image natively and the bytes never become text tokens. The
result also carries an `imageUrl`: the screenshot is served by a small HTTP
server bound to `127.0.0.1`, under a path with a 192-bit random token. A client
that renders markdown turns

```markdown
![page](http://127.0.0.1:54321/i/<token>.png)
```

into a visible picture. Only the ~120-character URL travels through the model's
reply.

## Tools

43 tools, grouped by what they are for:

| Group        | Tools                                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lifecycle    | `browser_start` `browser_stop` `browser_status` `browser_new_tab` `browser_navigate` `browser_tabs` `browser_close_tab` `browser_back` `browser_forward` `browser_reload` `browser_restart` `browser_set_viewport` `browser_handoff` |
| Reading      | `browser_snapshot` `browser_text` `browser_evaluate` `browser_screenshot` `browser_logs` `browser_network` `browser_verify` `browser_find`                                                                                           |
| Actions      | `browser_click` `browser_type` `browser_press_key` `browser_select_option` `browser_check` `browser_hover` `browser_scroll` `browser_upload` `browser_wait_for`                                                                      |
| Workflow     | `browser_batch` `browser_run_script` `browser_config` `browser_handle_dialog`                                                                                                                                                        |
| Firefox-only | `browser_context` `browser_extension` `browser_cookie` `browser_intercept` `browser_detectability`                                                                                                                                   |
| Network      | `browser_net_check` `browser_egress`                                                                                                                                                                                                 |
| CAPTCHA      | `browser_captcha` `browser_captcha_status`                                                                                                                                                                                           |

Full parameter reference:
[`skills/firefox-browser/REFERENCE.md`](skills/firefox-browser/REFERENCE.md).

### Firefox-only tools

These exist because the server drives Firefox itself:

| Tool                    | What it does                                                                      |
| ----------------------- | --------------------------------------------------------------------------------- |
| `browser_context`       | Firefox containers — isolated cookies, localStorage and cache per identity        |
| `browser_extension`     | Install and uninstall WebExtensions                                               |
| `browser_cookie`        | Read and write cookies, **including HttpOnly ones**                               |
| `browser_intercept`     | Block requests by URL; every request is released again, so the page never freezes |
| `browser_detectability` | Measure how detectable this session is                                            |

### The working loop

```
browser_snapshot  →  act on a ref  →  read the effect block
```

## Safety and the error contract

- **The confirmation gate.** Actions that cannot be undone — submitting a form,
  downloading, uploading, installing an extension, writing a cookie — are
  refused unless the caller passes `confirm: true`. Classification uses **DOM
  facts**, not button text, because a Chinese site labels a search button 搜索
  and an English site labels a harmless button OK.
- **The error contract.** A failure carries both `code` (a fixed,
  machine-readable word) and `error` (a human-readable sentence). Branch on
  `code`; matching an English sentence means matching its wording.
- **Redaction.** Cookies, passwords, one-time codes and tokens are redacted on
  every outbound channel.
- **Untrusted page content.** If a page hides instructions in the DOM for the
  agent — off-screen text, white-on-white, 1px fonts — the plugin reports it as
  untrusted content instead of acting on it.

## Configuration

All settings are environment variables; the MCP server inherits `HOME`, `PATH`
and the rest from the host.

| Variable                       | Default                 | Meaning                                                  |
| ------------------------------ | ----------------------- | -------------------------------------------------------- |
| `FIREFOX_BROWSER_BIN`          | auto-detected           | Path to the Firefox binary.                              |
| `FIREFOX_BROWSER_PORT`         | `9333`                  | Preferred BiDi port; occupied ports are probed upward.   |
| `FIREFOX_BROWSER_HEADLESS`     | `1`                     | Set to `0` for a visible window.                         |
| `FIREFOX_BROWSER_PROFILE`      | auto-detected           | Source profile; prefers the one a running Firefox holds. |
| `FIREFOX_BROWSER_PROFILE_COPY` | —                       | Base directory for the profile copy.                     |
| `FIREFOX_BROWSER_TIMEOUT_MS`   | `30000`                 | Per-BiDi-command timeout.                                |
| `FIREFOX_BROWSER_PRIVILEGED`   | `0`                     | `1` unlocks the privileged `chrome://` contexts.         |
| `FIREFOX_BROWSER_PREFS`        | —                       | JSON object of prefs applied to the profile copy only.   |
| `FIREFOX_BROWSER_SCRIPT_ROOTS` | `~/.mavis/ff-workspace` | Where `browser_run_script` may read scripts from.        |

## Development

```bash
npm test                # unit + integration tests
npm run test:unit       # unit tests only — no browser needed
npm run test:integration# launches a real Firefox
npm run lint            # ESLint
npm run format:check    # Prettier
npm run validate        # validate the plugin package
```

No runtime npm dependencies; ESLint and Prettier are devDependencies only.

## Documentation

| Document                                         | What it covers                           |
| ------------------------------------------------ | ---------------------------------------- |
| [Capability matrix](docs/capabilities-matrix.md) | Which Firefox version each feature needs |
| [CAPTCHA](docs/captcha.md)                       | The optional solver                      |
| [MiniMax Code plugin](docs/mcode-plugin.md)      | Host integration and package contract    |
| [Agent guide](skills/firefox-browser/SKILL.md)   | How an agent should drive it             |

## License

MIT. See [LICENSE](LICENSE).
