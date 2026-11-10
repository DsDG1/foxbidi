# foxbidi

### Real Firefox for your coding agent — over WebDriver BiDi.

[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen.svg)](https://nodejs.org)
[![mcp](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](https://modelcontextprotocol.io)
[![firefox](https://img.shields.io/badge/Firefox-140%20ESR-verified-orange.svg)](docs/capabilities-matrix.md)
[![deps](https://img.shields.io/badge/runtime%20deps-0-success.svg)](package.json)

> 中文版：[README.zh-CN.md](README.zh-CN.md)

Firefox removed its experimental CDP implementation at the end of 2024.
WebDriver BiDi is the only protocol left, and `foxbidi` speaks it: a
**zero-dependency** Node MCP server that drives a **real Firefox** — your
profile, your login state — and exposes it to an agent as **43 native tools**.

It ships as a MiniMax Code (MCode) plugin and works with any MCP client.

## What it is

- **Zero runtime dependencies.** The WebSocket framing and the BiDi protocol
  layer are hand-rolled on `node:net`. Nothing to install, nothing to audit.
- **Your real login state.** The plugin drives a _copy_ of your Firefox
  profile, so the sites you are signed into stay signed in.
- **Trusted input.** Clicks deliver genuine pointer events
  (`pointerMove → pointerDown → pointerUp`) and typing sends one key action per
  character — not synthetic DOM events, which many sites reject.
- **Honest results.** Every action returns an `effect` block. `effect.verified`
  is `true` only when the URL or the DOM fingerprint actually changed.
- **It never hangs on a dialog.** A JavaScript `alert()` blocks Firefox; the
  plugin closes it automatically and tells the agent what it said.
- **It knows what this Firefox can do.** Capabilities are probed at runtime, so
  one build works on Firefox 118 and on Firefox 150 — and says plainly when a
  feature is missing.

## Install

**Requirements:** Node ≥ 20, Firefox 118+ (140 ESR recommended and verified).
The browser starts on demand — the first tool call launches it.

### As a MiniMax Code plugin

```bash
git clone https://github.com/DsDG1/foxbidi.git ~/.minimax/plugins/foxbidi
```

Point MCode at that directory and the tools appear alongside your other plugin
tools.

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

## How it plugs into MiniMax Code

This is the part worth reading. The plugin is not a library you import — it is
a **package the host scans**, and every file in it has a job.

### The package layout

```
foxbidi/
  .minimax-plugin/plugin.json   # the manifest the host reads
  servers.mcp.json              # how the MCP server is started
  server.js                     # the MCP server entry point
  lib/bidi/                     # the WebDriver BiDi protocol layer
  lib/firefox/                  # profile handling, launching, the provider
  lib/mcp/                      # output schemas and the tool catalogue
  skills/firefox-browser/       # the guide the agent reads
  docs/                         # reference documents
```

### The manifest

`.minimax-plugin/plugin.json` is what the host looks for while scanning the
plugins directory:

```json
{
  "name": "foxbidi",
  "displayName": "Firefox 浏览器控制",
  "version": "2.9.1",
  "description": "…",
  "icon": "icon.png",
  "category": "Code",
  "exampleQueries": ["…"],
  "mcpServers": ["servers.mcp.json"],
  "skills": ["skills/firefox-browser/SKILL.md"]
}
```

`mcpServers` and `skills` are what turn a directory into a working plugin: the
first names the MCP server to launch, the second is the document that tells the
agent how to drive it.

### The MCP server

`servers.mcp.json` declares a stdio server:

```json
{
  "mcpServers": {
    "foxbidi": {
      "type": "stdio",
      "command": "node",
      "args": ["./server.js"],
      "timeout": 300000
    }
  }
}
```

The host spawns `node server.js` and speaks MCP over its stdin/stdout. The
server builds the tool catalogue from `lib/mcp/tools/` and answers
`tools/list` and `tools/call`.

### How the tools reach the model

Every tool definition is injected into the model's context on **every turn**, so
the catalogue is a permanent cost, not a one-off. The plugin therefore ships
presets and picks one automatically:

| Preset      | Tools | What it adds                                    |
| ----------- | ----- | ----------------------------------------------- |
| `slim`      | 24    | the everyday loop                               |
| `basic`     | 36    | + fine-grained input, logs, assertions, cookies |
| `developer` | 43    | + the Firefox-only family, CAPTCHA, egress      |
| `all`       | 43    | everything                                      |

Switch with `browser_config({preset: "all"})`.

### The skill

`skills/firefox-browser/SKILL.md` is read by the agent, not by you. It carries
the operating rules: take a snapshot first, act on a `ref`, read the `effect`
block, branch on `code` rather than on `error`, never route around the
confirmation gate. `REFERENCE.md` next to it is the parameter reference and the
full error vocabulary.

### The plugin package contract

This is the one that bites. The host scans **every direct subdirectory** of
`~/.minimax/plugins/` as a plugin package and applies two constraints.

**Size limits** (`PLUGIN_PACKAGE_V1_LIMITS`):

| Constraint      | Limit   |
| --------------- | ------- |
| Files           | ≤ 1024  |
| Archive entries | ≤ 2048  |
| Single file     | ≤ 16 MB |
| Total           | ≤ 64 MB |
| Path            | ≤ 512 B |
| Path segment    | ≤ 128 B |
| Path segments   | ≤ 16    |

**Path portability** (`validatePluginPortablePath`): every path segment must
match `^[A-Za-z0-9._-]+$`. No symlinks, no hard links, no special files, no
case-conflicting paths.

**The failure is silent.** `readLocalPluginCandidate` catches
`PluginPackageContractError` and downgrades it to a diagnostic — it does not
throw, and it does not log anywhere the user can see. The plugin simply does
not enter the registry, does not appear in `mcode plugin list`, and the agent
gets no tools at all. `mcode plugin add` is not the answer either: local
plugins have no "install" step, and **whether the scan succeeds is the only
thing that decides**.

### The repository and the installed package are two different things

A checkout is not a valid package: it carries `.git` (hundreds of entries),
`node_modules` (whose `@scope/` segments are illegal and whose `.bin/` entries
are symlinks), and runtime scratch. So the two live apart:

- the **development repository** — git history, devDependencies, everything;
- the **installed package** at `~/.minimax/plugins/foxbidi` — exactly the files
  `git ls-files` names, nothing else.

```bash
npm run publish          # write the package and verify it against the contract
npm run contract -- ~/.minimax/plugins/foxbidi   # check any directory
```

`npm run publish` refuses to wipe a target that does not look like a plugin
package, and verifies the result before reporting success. `npm run contract`
reproduces the host's rules locally, so a package the host would silently drop
fails here first. The CI job checks the **published artifact**, not the
checkout.

### When the host does not inject the tools

The tools normally reach the agent through the host. When that injection does
not happen, the plugin is running perfectly well and is simply unreachable — a
confusing place to stand. So the plugin ships its own way in:

```bash
node tools/ff-call.mjs browser_status '{}'   # call any tool — no setup needed
node tools/ff-call.mjs --doctor              # what works, what does not
node tools/ff-call.mjs --serve               # start the long-lived server
node tools/ff-call.mjs --stop                # stop it
```

A call needs a server on the other end of the control socket. When none is
running, the call **starts one**: a detached daemon that survives the shell
that started it and keeps ONE Firefox alive across calls. The daemon is
started with no stdin at all, because a stdio transport treats EOF as "the
client is gone" — a server that reads stdin kills itself the moment it is
detached.

The control socket is off by default for a stdio server. With
`FIREFOX_BROWSER_CONTROL_SOCKET=1` the server also listens on `control.sock`
(0600) in the plugin data directory, speaking the same JSON-RPC to the **same
provider** — the same Firefox, the same tabs. A server that finds the socket
already served by a live peer steps aside instead of taking it over: two
servers would mean two Firefoxes, and the BiDi session allows only one.

`--doctor` reports four things: the host's own registry of this plugin's tools
(and whether it is stale), the control socket, the browser, and whether this
machine can resolve and reach the outside world at all.

### The runtime data directory

The profile copy, the control socket, the audit log and the screenshot server
all live under `<plugin root>/../.plugin-data/firefox-browser` — next to the
plugin, not inside it.

Two copies of the code mean two plugin roots, and each would spawn its own
daemon and its own profile copy. Point the development copy at the installed
copy's data directory:

```bash
export FIREFOX_BROWSER_PROFILE_COPY="$HOME/.minimax/plugins/.plugin-data/firefox-browser"
```

### Why a copy, and not "attach to the running Firefox"

`--remote-debugging-port` is a **startup** flag: a running Firefox cannot be
given a BiDi endpoint afterwards, and the running instance holds an exclusive
lock on its profile. Copying the profile and launching a second instance
against the copy is therefore the only way to drive a Firefox that carries
your real session. The copy is a snapshot — tabs are not shared.

### The two browser surfaces

MCode also has an in-app browser. `browser_handoff` moves a page between the
two surfaces:

- `{"to": "in-app"}` — read-only. Returns the current URL, the title and a
  guidance line.
- `{"to": "firefox", "url": "…"}` — acts. Navigates this Firefox to a URL you
  read from the in-app browser, and reports the `effect`.

**Session state never travels across.** Logins, cookies and tabs stay on the
surface they came from; only the URL is handed over.

### How a screenshot reaches you

`browser_screenshot` returns the PNG as an MCP image content block, which the
model receives natively — the image bytes never become text tokens. For you, the
result also carries an `imageUrl`: the plugin serves the screenshot from a tiny
HTTP server bound to `127.0.0.1`, under a path with a 192-bit random token. A
chat client that renders markdown turns

```markdown
![page](http://127.0.0.1:54321/i/<token>.png)
```

into a visible picture. Only the ~120-character URL travels through the
model's reply.

## Using it

The plugin is built around the way an agent actually drives a browser:

```
browser_snapshot  →  act on a ref  →  read the effect block
```

**Try it:**

- _"Use Firefox to open example.com and screenshot it."_
- _"Search for 'hello' in Firefox and read the results back to me."_
- _"Open two Firefox containers — one signed in, one not."_

## Tools

43 tools, grouped by what they are for:

| Group        | Tools                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lifecycle    | `browser_start` `browser_stop` `browser_status` `browser_new_tab` `browser_navigate` `browser_tabs` `browser_close_tab` `browser_back` `browser_forward` `browser_reload` `browser_set_viewport` `browser_handoff` |
| Reading      | `browser_snapshot` `browser_text` `browser_evaluate` `browser_screenshot` `browser_logs` `browser_network` `browser_verify` `browser_find`                                                                         |
| Actions      | `browser_click` `browser_type` `browser_press_key` `browser_select_option` `browser_check` `browser_hover` `browser_scroll` `browser_upload` `browser_wait_for`                                                    |
| Workflow     | `browser_batch` `browser_run_script` `browser_config` `browser_handle_dialog`                                                                                                                                      |
| Firefox-only | `browser_context` `browser_extension` `browser_cookie` `browser_intercept` `browser_detectability`                                                                                                                 |
| Network      | `browser_net_check` `browser_egress`                                                                                                                                                                               |
| CAPTCHA      | `browser_captcha` `browser_captcha_status`                                                                                                                                                                         |

Full parameter reference:
[`skills/firefox-browser/REFERENCE.md`](skills/firefox-browser/REFERENCE.md).

### Firefox-only tools

Some tools exist because the plugin drives Firefox itself:

| Tool                    | What it does                                                                      |
| ----------------------- | --------------------------------------------------------------------------------- |
| `browser_context`       | Firefox containers — isolated cookies, localStorage and cache per identity        |
| `browser_extension`     | Install and uninstall WebExtensions                                               |
| `browser_cookie`        | Read and write cookies, **including HttpOnly ones**                               |
| `browser_intercept`     | Block requests by URL; every request is released again, so the page never freezes |
| `browser_detectability` | Measure how detectable this session is — honestly                                 |

### Safety and honesty

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
| [Agent guide](skills/firefox-browser/SKILL.md)   | How an agent should drive it             |

## License

MIT. See [LICENSE](LICENSE).
