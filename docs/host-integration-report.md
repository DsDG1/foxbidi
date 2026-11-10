# 宿主侧问题报告：插件工具未被注入会话

**状态**：待上游处理
**插件**：`firefox-browser` v2.8.0（`~/.minimax/plugins/firefox-browser`）
**宿主**：MiniMax Code 本地运行时 v0.7.6（`~/.minimax-code/releases/0.7.6`）
**复现环境**：Linux，宿主 0.7.6，插件 2026-11-10 16:44 更新后未重新绑定
**日期**：2026-11-10

这份报告只描述**宿主侧**的行为。插件本身已经做了力所能及的兜底
（自带控制通道与调用器，见下文「插件侧的缓解」），但根因不在插件里。

---

## 1. 现象

会话的注入工具列表里**一个 firefox 相关工具都没有**，而同一宿主版本下别的插件正常：

| 插件                | 来源          | 登记工具数 | 本会话注入     |
| ------------------- | ------------- | ---------- | -------------- |
| `dynamic-workflows` | OFFICIAL      | 11         | **11（全部）** |
| `rea`               | OFFICIAL      | 170        | 0              |
| `firefox-browser`   | LOCAL_MINIMAX | 34         | **0**          |

对照 2026-11-10 05:17 的会话：注入 71 个工具，其中 **firefox 相关 34 个全部在位**。
也就是说，**同一台机器、同一个宿主版本、同一份插件包，注入与否只随时间变化**。

---

## 2. 已排除的原因

### 2.1 不是插件包结构的问题

宿主以 `.minimax-plugin/plugin.json` 为清单（运行时常量 `Ijt`），`mcpServers` 与
`skills` 相对**插件根**解析，MCP 的 `cwd` 缺省即插件根。本插件与官方**可用**插件
`rea` 逐项同构：

| 约定                   | 官方 `rea`                                  | 本插件                            |
| ---------------------- | ------------------------------------------- | --------------------------------- |
| 清单                   | `.minimax-plugin/plugin.json`               | 同                                |
| 清单字段               | `schemaVersion/name/displayName/…`          | 同（`author` 两者都是字符串）     |
| MCP 配置               | `rea.mcp.json`（根目录）                    | `servers.mcp.json`（根目录）      |
| MCP 配置的 V1 wrapper  | `{"schemaVersion":1,"mcpServers":{…}}`      | 同                                |
| MCP 传输               | `stdio` + `command` + `args` + `timeout`    | 同                                |
| Skill                  | `skills/reverse-engineer-anything/SKILL.md` | `skills/firefox-browser/SKILL.md` |
| Skill frontmatter name | 与目录名一致                                | 同                                |
| Skill description 长度 | ≤ 1024                                      | 同（本插件 234 字符）             |

宿主对 MCP 配置文件的校验（`SEe`/`vEe`）要求：`schemaVersion === 1`、`mcpServers`
是对象、wrapper 只允许 `$schema`/`schemaVersion`/`mcpServers` 三个键、传输类型合法、
`command` 是可执行名或 `./` 相对路径、args 只能是字符串。**本插件逐条满足。**

### 2.2 不是用户禁用

`local_runtime_plugin_local_disabled` 表**为空**，插件没有被禁用。

### 2.3 不是 Skill 校验失败

宿主的 Skill 校验要求：frontmatter 存在、`name` 匹配目录名、`name` 匹配
`^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$`、description ≤ 1024 字符。本插件全部满足。

### 2.4 不是 MCP 服务起不来

手动以 stdio 拉起本插件的 `server.js`，服务正常就绪：

```
[firefox-browser] ready — firefox=(auto) port=9333 headless=true tools=43 preset=basic visible=36
```

---

## 3. 最可能的根因：宿主的工具登记表陈旧

宿主把插件 MCP 服务器及其工具名登记在一张表里。这张表：

- 写于 **2026-11-09 14:19**；
- 登记 `firefox-browser` 为 **34 个工具**，且**不含 `browser_find`**；
- 而插件自 **2026-11-10 16:44** 起就有 40 个工具（本次发布后为 43 个）。

也就是说，**宿主掌握的工具表比插件代码旧了一天**——它少了 `browser_find`，
以及本次新增的 `browser_net_check` / `browser_restart` / `browser_egress`。

插件在 16:43–16:44 连续推了三个提交（`feat: add browser_find`、
`refactor: decide the preset by capability instead of a list of tool names`、
`docs: document the injection warnings, the hard block and the preset trimming`），
其中最后一个**改动了 `.minimax-plugin/plugin.json`**（版本号 2.6.0 → 2.7.0）。
本会话在 16:57 建立，晚于这批更新 13 分钟——**更新之后没有发生重新绑定**。

这条线索与「同宿主版本下 `dynamic-workflows` 正常」并不矛盾：它的工具表与代码
没有漂移，因此不需要重新绑定。

> 插件侧现在**主动**暴露了这个证据：
> `node tools/validate-package.mjs` 会比对宿主的登记表与插件代码，
> 并把差异**逐个工具名**列成告警：
>
> ```
> WARNINGS:
>   ⚠ host registry: stale — the host knows 34 tools, the code has 43;
>     missing: browser_back, browser_forward, browser_reload, browser_set_viewport,
>              browser_verify, browser_find, browser_net_check, browser_restart, browser_egress
> ```
>
> `node tools/ff-call.mjs --doctor` 也会报告同一件事。

---

## 4. 延迟工具入口在本回合不可用

宿主提供了 `mcp_invoke` 用于调用「延迟」工具，但它在本回合无法触达本插件的工具：

```
Unknown tool_name. Use tool_search only if it is available in this turn.
For Host-bound tools, fully read the Plugin Skill and use the exact tool_ref
from its Host tool contracts.
```

- 该回合**没有** `tool_search`（提示指向了一个不存在的入口）。
- 提示要求「用 Plugin Skill 里的 tool_ref」，但插件的 SKILL.md 里**没有**
  `tool_ref` 这个概念，`skill` 工具也加载不到 `firefox-browser`
  （它不在会话的可用 Skill 列表里）。

于是：**宿主没有注入工具，也没有给出别的入口。**

---

## 5. 诉求

1. **插件更新后应重新绑定工具表。** 宿主的登记表与插件代码的版本之间没有联动，
   更新后需要显式刷新，否则会话拿到的是一份旧工具表。
2. **延迟工具入口要么始终可用，要么明确不可用。** 错误信息把调用方指向了
   `tool_search` 与 `tool_ref`，而这两者在本回合都不存在——一条不存在的路，
   比明确说"这条路没有"更费时间。
3. **把"工具未注入"说清楚。** 当一个已安装插件的工具一个都没进会话时，
   宿主至少应该在插件列表或会话状态里指出原因，而不是让调用方自己推理。
4. **插件 Skill 应随插件一起注册。** 本插件的 Skill 通过清单声明
   （`skills: ["skills/firefox-browser/SKILL.md"]`），与官方插件同构，
   但没有出现在会话的可用 Skill 列表中。

---

## 6. 插件侧的缓解（已实现，随 v2.8.0 交付）

插件不能修宿主，但可以保证**宿主不注入时仍然可用**：

- **控制通道**：以 `FIREFOX_BROWSER_CONTROL_SOCKET=1` 启动服务，它会在插件数据目录
  开一个 `control.sock`（0600），说与宿主相同的 JSON-RPC，走**同一个 provider**
  ——同一个 Firefox、同一批标签页。
- **自带调用器**：`node tools/ff-call.mjs <tool> '<json>'` 直接调工具；
  `--doctor` 一次性报告宿主登记、控制通道、浏览器、网络四件事；
  `--spawn` 在没有服务可连时另起一个（**会另起一个 Firefox**）。
- **打包自检**：`tools/validate-package.mjs` 把宿主的登记表陈旧问题变成一条告警。

这些是缓解，不是修复：宿主的注入问题仍然存在，插件的工具仍然不在会话的工具表里。

---

## 7. 降级路径的实战记录（随 v2.9.0 交付）

v2.8.0 把"怎么进去"做出来了，但第一次真在降级路径上跑完一轮，才知道它还差三步。
这一节记的是那三步，以及它们各自踩到了什么。

### 7.1 守护进程必须由插件自己拉起

调用方拼出来的命令靠不住：

| 试过的写法                          | 结果                                           |
| ----------------------------------- | ---------------------------------------------- |
| `VAR=1 cmd \| node cmd`             | 环境变量只作用于**管道左端**，node 没拿到      |
| 后台任务管理器里跑 `node server.js` | 进程组收到 SIGTERM，服务一起死                 |
| `nohup ... &` + `stdin=/dev/null`   | 服务立刻自退（`shutting down (stdin closed)`） |

根因是**stdin**：stdio 传输把 EOF 当作"客户端走了"，所以一个不读 stdin 的服务
（daemon）必须显式地不挂 stdin 读循环。v2.9.0 的 `FIREFOX_BROWSER_DAEMON=1` 就是
这件事，调用方不再需要知道它。

### 7.2 调用方不该知道"要先起服务"

v2.8.0 的 `ff-call.mjs` 连不上 socket 就报错，让人先去设环境变量起服务——这等于把
插件的实现细节推给了调用方。v2.9.0 的做法是：**socket 不存在就自动起一个**，
`--serve` / `--stop` 只是手动入口。

### 7.3 同一个 payload 打了两遍

降级路径上每次调用都要多付一次进程启动 + 一次 JSON-RPC 往返，这时候再把同一份数据
打印两遍就更亏。旧格式把回复的 text 块和结构化载荷并排打印，而 12 个 legacy 工具的
text 块**就是**同一份载荷的 pretty JSON——`browser_text` 实测把 3.7 KB 正文打成
15 KB。v2.9.0 把三种模式改成互斥，默认只给结构化载荷。
