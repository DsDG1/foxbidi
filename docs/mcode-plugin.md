# MiniMax Code 插件集成

本文只覆盖 MiniMax Code（MCode）宿主这一侧：插件怎么被扫描、怎么被启动、工具怎么进
到模型上下文，以及插件加载不出来时怎么排查。

工具本身、协议实现、工具清单和配置项见 [README.zh-CN.md](../README.zh-CN.md)。

## 插件是一个被扫描的包

这个插件不是一个被 import 的库，而是宿主会扫描的一个包，每个文件各有职责：

```
foxbidi/
  .minimax-plugin/plugin.json   # 宿主读的清单
  servers.mcp.json              # MCP server 怎么起
  server.js                     # MCP server 入口
  lib/bidi/                     # WebDriver BiDi 协议层
  lib/firefox/                  # profile 处理、启动、provider
  lib/mcp/                      # 输出 schema 和工具目录
  skills/firefox-browser/       # 代理读的指南
  docs/                         # 参考文档
```

### 清单

`.minimax-plugin/plugin.json` 是宿主扫描插件目录时找的东西：

```json
{
  "name": "foxbidi",
  "displayName": "Firefox 浏览器控制",
  "version": "2.9.3",
  "description": "…",
  "icon": "icon.png",
  "category": "Code",
  "exampleQueries": ["…"],
  "mcpServers": ["servers.mcp.json"],
  "skills": ["skills/firefox-browser/SKILL.md"]
}
```

`mcpServers` 和 `skills` 是把一个目录变成可用插件的关键：前者指明要启动哪个 MCP
server，后者是告诉代理该怎么驱动它的那份文档。`exampleQueries` 只是宿主展示用的示例
问题。

### 卡住时的两级恢复

`browser_restart` 有两个范围，插件在这一点上刻意做得不对称：

- `scope: "browser"`（默认）——杀 Firefox 再起。用于让写进 profile 副本的首选项生效。
- `scope: "session"` ——只换掉 BiDi 会话，**Firefox 进程不杀、标签页全留、登录态不丢**。
  用于会话卡死（`session_stuck`）：一条永远不返回的命令占着串行队列，重置会话是唯一
  的修法，而重启浏览器会把用户正在看的东西一并弄丢。

插件**不会自动重试**卡死的操作——被放弃的导航可能在会话恢复之后才落地，自动重试会让
页面被悄悄改掉。

### MCP server

`servers.mcp.json` 声明的是一个 stdio server：

```json
{
  "mcpServers": {
    "firefox-browser": {
      "type": "stdio",
      "command": "node",
      "args": ["./server.js"],
      "timeout": 300000
    }
  }
}
```

宿主 spawn `node server.js`，通过它的 stdin/stdout 说 MCP。server 从
`lib/mcp/tools/` 组装工具目录，响应 `tools/list` 和 `tools/call`。

### 工具是怎么进到模型里的

每个工具定义都会在**每一轮对话**被注入模型上下文，所以这份目录是**永久性开销**，不是
一次性的。插件因此提供若干 preset，并自动挑一个：

| preset      | 工具数 | 内容                                 |
| ----------- | ------ | ------------------------------------ |
| `slim`      | 24     | 日常主循环                           |
| `basic`     | 36     | + 精细输入、日志、断言、cookie       |
| `developer` | 43     | + Firefox 独有能力、验证码、出口代理 |
| `all`       | 43     | 全部                                 |

用 `browser_config({preset: "all"})` 切换；切换后 server 会通知宿主重新拉 `tools/list`。

### Skill

`skills/firefox-browser/SKILL.md` 是给代理读的，不是给你读的。它写的是操作规矩：
先快照、按 `ref` 动手、读 `effect` 块、按 `code` 而不是按 `error` 分支、绝不绕开确认
闸门。旁边的 `REFERENCE.md` 是参数参考和完整的错误词表。

## 插件包契约

宿主把 `~/.minimax/plugins/` 的**每个直接子目录**都当作一个插件包扫描，并套用两条
约束。

**体积上限**（`PLUGIN_PACKAGE_V1_LIMITS`）：

| 约束       | 上限    |
| ---------- | ------- |
| 文件数     | ≤ 1024  |
| 条目数     | ≤ 2048  |
| 单文件     | ≤ 16 MB |
| 总量       | ≤ 64 MB |
| 路径       | ≤ 512 B |
| 单个路径段 | ≤ 128 B |
| 路径段数   | ≤ 16    |

**路径可移植性**（`validatePluginPortablePath`）：每一段路径都必须匹配
`^[A-Za-z0-9._-]+$`；禁止符号链接、硬链接和特殊文件，禁止大小写冲突的路径。

**失败是静默的。** `readLocalPluginCandidate` 把 `PluginPackageContractError` 捕获后
降级成一条 diagnostic —— 不抛异常，也不记在用户能看见的地方。于是这个插件既不进
注册表，也不进 `mcode plugin list`，代理手上一个工具都没有。`mcode plugin add` 也不是
解法：本地插件没有「安装」这一步，**扫描成不成功是唯一的决定因素**。

## 开发仓库和已安装包是两回事

一个检出目录不是合法的插件包：它带着 `.git`（几百个条目）、`node_modules`
（`@scope/` 段不合法，`.bin/` 里是符号链接）和运行时残留。所以两者分开住：

- **开发仓库** —— git 历史、devDependencies，全在这儿；
- **已安装包** 在 `~/.minimax/plugins/foxbidi` —— 只有 `git ls-files` 点名的那些文件，
  别的都没有。

```bash
npm run publish          # 写出插件包并对着契约自检
npm run contract -- ~/.minimax/plugins/foxbidi   # 检查任意目录
```

`npm run publish` 拒绝擦除一个看起来不像插件包的目标（真要擦就加 `--force`），并且在
报告成功之前会先验证结果。`npm run contract` 在本地复刻宿主的规则，这样宿主会静默
丢弃的包会先在这里失败。CI 校验的是**发布产物**，不是检出目录。

## 宿主没把工具注入进来的时候

工具正常情况下是通过宿主到达代理的。注入没发生时，插件其实运行得好好的，只是**够不着**
—— 这是个很让人困惑的位置。所以插件自带一条入口：

```bash
node tools/ff-call.mjs browser_status '{}'   # 直接调用任意工具，不用任何配置
node tools/ff-call.mjs --doctor              # 体检：什么能用、什么不能用
node tools/ff-call.mjs --serve               # 起常驻服务
node tools/ff-call.mjs --stop                # 收掉
```

`--doctor` 报四件事：

1. **宿主的工具登记表**（`~/.minimax/mcp-runtime-names.json`）—— 宿主登记了多少个工具、
   是不是陈旧。登记表比代码旧时，宿主注入的是一份过期的工具列表：插件本身是好的，是宿主
   在注入旧清单。
2. **控制套接字** —— 在不在、活着没有、挂了的话报最后一条错误。
3. **浏览器** —— 状态、pid、BiDi 端口和 Firefox 版本。
4. **网络** —— 这台机器能不能解析并连上外网。

## 运行时数据目录

profile 副本、控制套接字、审计日志和截图服务都在 `<plugin root>/../.plugin-data/
firefox-browser` 下 —— 挨着插件，不在插件里面。

两份代码就意味着两个插件根目录，各自会拉起自己的守护进程和自己的 profile 副本。把
开发副本指到已安装副本的数据目录：

```bash
export FIREFOX_BROWSER_PROFILE_COPY="$HOME/.minimax/plugins/.plugin-data/firefox-browser"
```

## 两个浏览器表面

MCode 还有一个内置浏览器。`browser_handoff` 负责在两个表面之间搬页面：

- `{"to": "in-app"}` —— 只读。返回当前 URL、标题和一句引导。
- `{"to": "firefox", "url": "…"}` —— 动手。把这个 Firefox 导航到你从内置浏览器读到的
  URL，并回报 `effect`。

内置浏览器归宿主所有，插件驱动不了它，所以**搬往内置浏览器**只是把数据和引导交给
代理，由代理自己去那边完成这一步；**搬往 Firefox** 则由插件自己执行。

**会话状态永远不跨表面。** 登录态、cookie 和标签页留在它们原来那一侧，搬过去的只有 URL。

## 截图怎么显示

`browser_screenshot` 把 PNG 作为 MCP image content block 返回，模型原生接收。同时结果
里带一个 `imageUrl`：插件用一个只监听 `127.0.0.1` 的小 HTTP 服务提供这张截图，路径里
带一个 192 位随机 token。会渲染 markdown 的聊天客户端（webui 就是）会把

```markdown
![page](http://127.0.0.1:54321/i/<token>.png)
```

变成一张能看见的图。穿过模型回复的只有那串约 120 字符的 URL。
