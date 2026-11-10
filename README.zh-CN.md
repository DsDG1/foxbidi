# foxbidi

### 给你的编码代理一个真实的 Firefox —— 走 WebDriver BiDi。

[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen.svg)](https://nodejs.org)
[![mcp](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](https://modelcontextprotocol.io)
[![firefox](https://img.shields.io/badge/Firefox-140%20ESR-verified-orange.svg)](docs/capabilities-matrix.md)
[![deps](https://img.shields.io/badge/runtime%20deps-0-success.svg)](package.json)

> English: [README.md](README.md)

Firefox 在 2024 年底移除了实验性的 CDP 实现，WebDriver BiDi 成了它唯一剩下的协议，
而 `foxbidi` 说的就是这门语言：一个**零运行时依赖**的 Node MCP server，驱动**真实的
Firefox** —— 你的 profile、你的登录态 —— 并以 **43 个原生工具**交给代理使用。

它以 MiniMax Code（MCode）插件的形式提供，同时兼容任何 MCP 客户端。

## 它是什么

- **零运行时依赖。** WebSocket 分帧和 BiDi 协议层全部手写在 `node:net` 上。
  不用装任何东西，也没什么好审计的。
- **带着你的登录态。** 插件驱动的是你 Firefox profile 的**副本**，你已经登录的站点
  依然是登录状态。
- **输入是真人的输入。** 点击走完整的指针事件（`pointerMove → pointerDown → pointerUp`），
  输入是逐字符发键事件，不是合成的 DOM 事件 —— 后者大量网站会直接拒绝。
- **结果如实上报。** 每个动作都返回 `effect` 块。`effect.verified` 只有在 URL 或
  DOM 指纹**确实变了**时才是 `true`。
- **遇到弹窗不会卡死。** 一个 JavaScript `alert()` 就能把 Firefox 完全堵住；插件
  自动关掉并把内容告诉代理。
- **它清楚当前这台 Firefox 能干什么。** 能力在运行时对着真实浏览器探测，所以一份构建
  在 Firefox 118 和 Firefox 150 上都能用 —— 缺功能时会明说。

## 安装

**环境要求：** Node ≥ 20，Firefox 118+（推荐 140 ESR，已实测）。
浏览器按需启动 —— 第一次调用工具时才会拉起。

### 作为 MiniMax Code 插件

```bash
git clone https://github.com/DsDG1/foxbidi.git ~/.minimax/plugins/foxbidi
```

把 MCode 指向这个目录，工具就会和其他插件工具一起出现。

### 作为普通 MCP server

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

## 它是怎么接进 MiniMax Code 的

这一节值得读。这个插件不是你 import 进来的库，而是**宿主会扫描的一个包**，
里面每个文件都有它自己的职责。

### 包的结构

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
  "version": "2.9.1",
  "description": "…",
  "icon": "icon.png",
  "category": "Code",
  "exampleQueries": ["…"],
  "mcpServers": ["servers.mcp.json"],
  "skills": ["skills/firefox-browser/SKILL.md"]
}
```

`mcpServers` 和 `skills` 是把一个目录变成可用插件的关键：前者指明要启动哪个 MCP
server，后者是告诉代理该怎么驱动它的那份文档。

### MCP server

`servers.mcp.json` 声明的是一个 stdio server：

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

宿主 spawn `node server.js`，通过它的 stdin/stdout 说 MCP。server 从
`lib/mcp/tools/` 组装工具目录，响应 `tools/list` 和 `tools/call`。

### 工具是怎么进到模型里的

每个工具定义都会在**每一轮对话**被注入模型上下文，所以这份目录是**永久性开销**，
不是一次性的。插件因此提供若干 preset，并自动挑一个：

| preset      | 工具数 | 内容                                 |
| ----------- | ------ | ------------------------------------ |
| `slim`      | 24     | 日常主循环                           |
| `basic`     | 36     | + 精细输入、日志、断言、cookie       |
| `developer` | 43     | + Firefox 独有能力、验证码、出口代理 |
| `all`       | 43     | 全部                                 |

用 `browser_config({preset: "all"})` 切换。

### Skill

`skills/firefox-browser/SKILL.md` 是给代理读的，不是给你读的。它写的是操作规矩：
先快照、按 `ref` 动手、读 `effect` 块、按 `code` 而不是按 `error` 分支、
绝不绕开确认闸门。旁边的 `REFERENCE.md` 是参数参考和完整的错误词表。

### 插件包契约

这一条最容易踩。宿主把 `~/.minimax/plugins/` 的**每个直接子目录**都当作一个插件包
扫描，并套用两条约束。

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

**失败是静默的。** `readLocalPluginCandidate` 把 `PluginPackageContractError`
捕获后降级成一条 diagnostic —— 不抛异常，也不记在用户能看见的地方。于是这个插件
既不进注册表，也不进 `mcode plugin list`，代理手上一个工具都没有。
`mcode plugin add` 也不是解法：本地插件没有「安装」这一步，**扫描成不成功是唯一的
决定因素**。

### 开发仓库和已安装包是两回事

一个检出目录不是合法的插件包：它带着 `.git`（几百个条目）、`node_modules`
（`@scope/` 段不合法，`.bin/` 里是符号链接）和运行时残留。所以两者分开住：

- **开发仓库** —— git 历史、devDependencies，全在这儿；
- **已安装包** 在 `~/.minimax/plugins/foxbidi` —— 只有 `git ls-files` 点名的那些文件，
  别的都没有。

```bash
npm run publish          # 写出插件包并对着契约自检
npm run contract -- ~/.minimax/plugins/foxbidi   # 检查任意目录
```

`npm run publish` 拒绝擦除一个看起来不像插件包的目标（真要擦就加 `--force`），
并且在报告成功之前会先验证结果。`npm run contract` 在本地复刻宿主的规则，
这样宿主会静默丢弃的包会先在这里失败。CI 校验的是**发布产物**，不是检出目录。

### 宿主没把工具注入进来的时候

工具正常情况下是通过宿主到达代理的。注入没发生时，插件其实运行得好好的，
只是**够不着** —— 这是个很让人困惑的位置。所以插件自带一条入口：

```bash
node tools/ff-call.mjs browser_status '{}'   # 直接调用任意工具，不用任何配置
node tools/ff-call.mjs --doctor              # 体检：什么能用、什么不能用
node tools/ff-call.mjs --serve               # 起常驻服务
node tools/ff-call.mjs --stop                # 收掉
```

调用需要控制套接字那头有个服务。没有的话，这次调用会**自己起一个**：一个脱离当前
shell 的守护进程，跨调用复用同一个 Firefox。这个守护进程启动时**完全不接 stdin**，
因为 stdio 传输把 EOF 读作「客户端没了」—— 一个读 stdin 的服务在被分离的瞬间会自杀。

控制套接字对 stdio server 默认关闭。设 `FIREFOX_BROWSER_CONTROL_SOCKET=1` 后，
server 还会在插件数据目录里监听 `control.sock`（0600），用同一套 JSON-RPC 说给
**同一个 provider** —— 同一个 Firefox、同一批标签页。发现套接字已经被一个活着的
同伴服务时，它会让开而不是抢占：两个 server 意味着两个 Firefox，而 BiDi 会话只允许
一个。

`--doctor` 报四件事：宿主自己那份工具登记表（以及是否陈旧）、控制套接字、浏览器、
以及这台机器到底能不能解析并连上外网。

### 运行时数据目录

profile 副本、控制套接字、审计日志和截图服务都在
`<plugin root>/../.plugin-data/firefox-browser` 下 —— 挨着插件，不在插件里面。

两份代码就意味着两个插件根目录，各自会拉起自己的守护进程和自己的 profile 副本。
把开发副本指到已安装副本的数据目录：

```bash
export FIREFOX_BROWSER_PROFILE_COPY="$HOME/.minimax/plugins/.plugin-data/firefox-browser"
```

### 为什么要复制 profile，而不是「接管正在跑的 Firefox」

`--remote-debugging-port` 是**启动参数**：已经在跑的 Firefox 没法事后再给它一个 BiDi
端点，而且运行中的实例对它的 profile 持有排他锁。所以，复制 profile 再针对副本启动
第二个实例，是唯一能驱动一个带着你真实会话的 Firefox 的办法。副本是快照 —— 标签页
不共享。

### 两个浏览器表面

MCode 还有一个内置浏览器。`browser_handoff` 负责在两个表面之间搬页面：

- `{"to": "in-app"}` —— 只读。返回当前 URL、标题和一句引导。
- `{"to": "firefox", "url": "…"}` —— 动手。把这个 Firefox 导航到你从内置浏览器读到的
  URL，并回报 `effect`。

**会话状态永远不跨表面。** 登录态、cookie 和标签页留在它们原来那一侧，搬过去的只有 URL。

### 截图怎么到你手里

`browser_screenshot` 把 PNG 作为 MCP image content block 返回，模型原生接收 ——
图片字节不会变成文本 token。对你来说，结果里还带一个 `imageUrl`：插件用一个只监听
`127.0.0.1` 的小 HTTP 服务提供这张截图，路径里带一个 192 位随机 token。会渲染 markdown
的聊天客户端（webui 就是）会把

```markdown
![page](http://127.0.0.1:54321/i/<token>.png)
```

变成一张能看见的图。穿过模型回复的只有那串约 120 字符的 URL。

## 怎么用

插件是围绕代理实际驱动浏览器的方式设计的：

```
browser_snapshot  →  按 ref 动手  →  读 effect 块
```

**试试看：**

- 「用 Firefox 打开 example.com 并截图。」
- 「在 Firefox 里搜索『hello』，把结果页文本读给我。」
- 「开两个 Firefox 容器 —— 一个登录状态，一个没有。」

## 工具一览

43 个工具，按用途分组：

| 分组         | 工具                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 生命周期     | `browser_start` `browser_stop` `browser_status` `browser_new_tab` `browser_navigate` `browser_tabs` `browser_close_tab` `browser_back` `browser_forward` `browser_reload` `browser_set_viewport` `browser_handoff` |
| 读取         | `browser_snapshot` `browser_text` `browser_evaluate` `browser_screenshot` `browser_logs` `browser_network` `browser_verify` `browser_find`                                                                         |
| 动作         | `browser_click` `browser_type` `browser_press_key` `browser_select_option` `browser_check` `browser_hover` `browser_scroll` `browser_upload` `browser_wait_for`                                                    |
| 工作流       | `browser_batch` `browser_run_script` `browser_config` `browser_handle_dialog`                                                                                                                                      |
| Firefox 独有 | `browser_context` `browser_extension` `browser_cookie` `browser_intercept` `browser_detectability`                                                                                                                 |
| 网络         | `browser_net_check` `browser_egress`                                                                                                                                                                               |
| 验证码       | `browser_captcha` `browser_captcha_status`                                                                                                                                                                         |

完整参数参考：[`skills/firefox-browser/REFERENCE.md`](skills/firefox-browser/REFERENCE.md)。

### Firefox 独有的工具

有些工具是因为插件直接驱动 Firefox 才有的：

| 工具                    | 作用                                                             |
| ----------------------- | ---------------------------------------------------------------- |
| `browser_context`       | Firefox 容器 —— 每个身份一套隔离的 cookie / localStorage / cache |
| `browser_extension`     | 安装 / 卸载 WebExtension                                         |
| `browser_cookie`        | 读写 cookie，**包括 HttpOnly 的那些**                            |
| `browser_intercept`     | 按 URL 拦截请求；每个请求都有兜底放行，页面不会被永久冻住        |
| `browser_detectability` | 实测本会话有多容易被检测，如实报告                               |

### 安全与诚实

- **确认闸门。** 不可逆的动作 —— 提交表单、下载、上传、装扩展、写 cookie —— 一律拒绝，
  除非调用方传 `confirm: true`。判定依据是 **DOM 事实**而不是按钮文字：中文站的搜索
  按钮叫「搜索」，英文站一个无害按钮叫「OK」，按关键字匹配会一直误判。
- **错误契约。** 一次失败同时给 `code`（固定的机器可读词）和 `error`（给人看的句子）。
  按 `code` 分支；去匹配一句英文报错，等于在匹配它的措辞。
- **脱敏。** cookie、密码、验证码和 token 在所有出站通道上都被脱敏。
- **不可信页面内容。** 如果某个页面把指令藏在 DOM 里只给代理看 —— 离屏文字、白底白字、
  1px 字号 —— 插件会把它标为不可信内容，而不是照着执行。

## 配置

所有设置都是环境变量；MCP server 会继承宿主的 `HOME`、`PATH` 等标准变量。

| 变量                           | 默认值                  | 含义                                              |
| ------------------------------ | ----------------------- | ------------------------------------------------- |
| `FIREFOX_BROWSER_BIN`          | 自动探测                | Firefox 可执行文件路径。                          |
| `FIREFOX_BROWSER_PORT`         | `9333`                  | 首选 BiDi 端口；被占用时向上探测。                |
| `FIREFOX_BROWSER_HEADLESS`     | `1`                     | 设为 `0` 则显示窗口。                             |
| `FIREFOX_BROWSER_PROFILE`      | 自动探测                | 源 profile；优先用正在运行的 Firefox 持有的那个。 |
| `FIREFOX_BROWSER_PROFILE_COPY` | —                       | profile 副本的存放目录。                          |
| `FIREFOX_BROWSER_TIMEOUT_MS`   | `30000`                 | 单条 BiDi 命令的超时。                            |
| `FIREFOX_BROWSER_PRIVILEGED`   | `0`                     | 设为 `1` 解锁特权 `chrome://` 上下文。            |
| `FIREFOX_BROWSER_PREFS`        | —                       | 只作用于 profile 副本的首选项 JSON 对象。         |
| `FIREFOX_BROWSER_SCRIPT_ROOTS` | `~/.mavis/ff-workspace` | `browser_run_script` 允许读取脚本的目录。         |

## 开发

```bash
npm test                # 单元 + 集成测试
npm run test:unit       # 只跑单元测试，不需要浏览器
npm run test:integration# 会启动真实的 Firefox
npm run lint            # ESLint
npm run format:check    # Prettier
npm run validate        # 校验插件包
```

没有运行时 npm 依赖；ESLint 和 Prettier 只是 devDependencies。

## 文档

| 文档                                            | 内容                          |
| ----------------------------------------------- | ----------------------------- |
| [能力矩阵](docs/capabilities-matrix.md)         | 每项功能需要哪个 Firefox 版本 |
| [验证码](docs/captcha.md)                       | 可选的求解器                  |
| [代理使用指南](skills/firefox-browser/SKILL.md) | 代理该怎么驱动它              |

## 许可

MIT，见 [LICENSE](LICENSE)。
