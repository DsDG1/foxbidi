# foxbidi

通过 WebDriver BiDi 驱动 Firefox 的 Node MCP server。

[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen.svg)](https://nodejs.org)
[![mcp](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](https://modelcontextprotocol.io)
[![firefox](https://img.shields.io/badge/Firefox-140%20ESR-verified-orange.svg)](docs/capabilities-matrix.md)
[![deps](https://img.shields.io/badge/runtime%20deps-0-success.svg)](package.json)

> English: [README.md](README.md)

Firefox 在 2024 年底移除了实验性的 CDP 实现，WebDriver BiDi 成了它唯一暴露给自动化
的协议。`foxbidi` 实现这门协议 —— WebSocket 分帧和 BiDi 会话层都手写在 `node:net`
上 —— 并通过 43 个 MCP 工具把浏览器交出来。

它以普通 stdio MCP server 的形式运行，任何 MCP 客户端都能接上。同一份代码也打包成
MiniMax Code 插件，宿主那一侧单独写在
[docs/mcode-plugin.md](docs/mcode-plugin.md)。

## 设计

- **没有运行时 npm 依赖。** 仓库里的 npm 包只有 ESLint 和 Prettier，都是
  devDependencies。
- **会话跑在一个 Firefox profile 的副本上。** 该 profile 里的 cookie 和登录态对会话
  可用。标签页不与正在运行的 Firefox 共享，副本是快照。
- **输入以浏览器事件投递。** 点击是指针事件（`pointerMove → pointerDown → pointerUp`），
  输入逐字符发键事件，而不是合成的 DOM 事件。
- **每个动作都返回 `effect` 块。** `effect.verified` 只有在 URL 或 DOM 指纹确实变了时
  才是 `true`。
- **弹窗会被关掉并回报。** 一个 JavaScript `alert()` 就能把 Firefox 堵住；插件把它
  关掉并返回它说的内容。
- **能力在运行时探测。** 工具集对着真实浏览器探测，所以一份构建在 Firefox 118 和
  Firefox 150 上都能用；缺的功能报 `capability_unavailable`。

## 环境要求

Node ≥ 20，Firefox 118+（已验证的配置是 140 ESR）。浏览器按需启动 —— 第一次需要它的
工具调用才会拉起。

## 安装

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

### 作为 MiniMax Code 插件

把仓库克隆到宿主的插件目录，宿主会扫描该目录并自己启动 server：

```bash
git clone https://github.com/DsDG1/foxbidi.git ~/.minimax/plugins/foxbidi
```

包结构、宿主的包契约，以及导致插件加载不出来的失败模式，写在
[docs/mcode-plugin.md](docs/mcode-plugin.md)。

## 工作原理

### 包结构

```
foxbidi/
  server.js                 # MCP server 入口
  lib/bidi/                 # WebDriver BiDi 协议层
  lib/firefox/              # profile 处理、启动、provider
  lib/mcp/                  # 输出 schema 和工具目录
  skills/firefox-browser/   # 代理读的指南
  tools/                    # CLI 入口和打包工具
  docs/                     # 参考文档
```

### MCP server

server 通过 stdin/stdout 说 MCP。工具目录从 `lib/mcp/tools/` 组装，响应
`tools/list` 和 `tools/call`，并在第一次需要时启动浏览器。

### 工具目录和 preset

每个工具定义都会在每一轮对话被注入模型上下文，所以这份目录是永久性开销，不是一次性
的。server 因此提供若干 preset，并自动挑一个：

| preset      | 工具数 | 内容                                 |
| ----------- | ------ | ------------------------------------ |
| `slim`      | 24     | 日常主循环                           |
| `basic`     | 36     | + 精细输入、日志、断言、cookie       |
| `developer` | 43     | + Firefox 独有能力、验证码、出口代理 |
| `all`       | 43     | 全部                                 |

用 `browser_config({preset: "all"})` 切换。

### 代理使用指南

`skills/firefox-browser/SKILL.md` 是给代理读的，不是给你读的。它写的是操作规矩：
先快照、按 `ref` 动手、读 `effect` 块、按 `code` 而不是按 `error` 分支、绝不绕开
确认闸门。旁边的 `REFERENCE.md` 是参数参考和完整的错误词表。

### 为什么要复制 profile，而不是「接管正在跑的 Firefox」

`--remote-debugging-port` 是**启动参数**：已经在跑的 Firefox 没法事后再给它一个 BiDi
端点，而且运行中的实例对它的 profile 持有排他锁。所以，复制 profile 再针对副本启动
第二个实例，是唯一能驱动一个带着真实会话的 Firefox 的办法。副本是快照 —— 标签页不
共享。

### CLI 入口

工具通常由 MCP 客户端转交给代理。仓库里另带一个直接入口，不需要任何客户端配置：

```bash
node tools/ff-call.mjs browser_status '{}'   # 调用任意工具
node tools/ff-call.mjs --doctor              # 什么能用、什么不能用
node tools/ff-call.mjs --serve               # 起常驻服务
node tools/ff-call.mjs --stop                # 收掉
```

调用需要控制套接字那头有个服务。没有的话，这次调用会**自己起一个**：一个脱离当前
shell 的守护进程，跨调用复用同一个 Firefox。这个守护进程启动时**完全不接 stdin**，
因为 stdio 传输把 EOF 读作「客户端没了」—— 一个读 stdin 的服务在被分离的瞬间会自杀。

控制套接字对 stdio server 默认关闭。设 `FIREFOX_BROWSER_CONTROL_SOCKET=1` 后，
server 还会在数据目录里监听 `control.sock`（0600），用同一套 JSON-RPC 说给**同一个
provider** —— 同一个 Firefox、同一批标签页。发现套接字已经被一个活着的同伴服务时，
它会让开而不是抢占：两个 server 意味着两个 Firefox，而 BiDi 会话只允许一个。

`--doctor` 报插件版本、控制套接字、浏览器状态，以及这台机器能不能解析并连上外网。
在 MiniMax Code 下它还会把宿主的工具登记表和这个构建对一遍，见
[docs/mcode-plugin.md](docs/mcode-plugin.md)。

### 运行时数据目录

profile 副本、控制套接字、审计日志和截图服务都在包外的数据目录里。解析顺序是：
`FIREFOX_BROWSER_PROFILE_COPY` → `PLUGIN_DATA` →
`<包根目录>/../.plugin-data/firefox-browser` →
`~/.minimax/v2/plugin-data/agent-plugins/firefox-browser`。

### 截图怎么到模型手里

`browser_screenshot` 把 PNG 作为 MCP image content block 返回，模型原生接收 ——
图片字节不会变成文本 token。结果里还带一个 `imageUrl`：截图由一个只监听 `127.0.0.1`
的小 HTTP 服务提供，路径里带一个 192 位随机 token。会渲染 markdown 的客户端会把

```markdown
![page](http://127.0.0.1:54321/i/<token>.png)
```

变成一张能看见的图。穿过模型回复的只有那串约 120 字符的 URL。

## 工具一览

43 个工具，按用途分组：

| 分组         | 工具                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 生命周期     | `browser_start` `browser_stop` `browser_status` `browser_new_tab` `browser_navigate` `browser_tabs` `browser_close_tab` `browser_back` `browser_forward` `browser_reload` `browser_restart` `browser_set_viewport` `browser_handoff` |
| 读取         | `browser_snapshot` `browser_text` `browser_evaluate` `browser_screenshot` `browser_logs` `browser_network` `browser_verify` `browser_find`                                                                                           |
| 动作         | `browser_click` `browser_type` `browser_press_key` `browser_select_option` `browser_check` `browser_hover` `browser_scroll` `browser_upload` `browser_wait_for`                                                                      |
| 工作流       | `browser_batch` `browser_run_script` `browser_config` `browser_handle_dialog`                                                                                                                                                        |
| Firefox 独有 | `browser_context` `browser_extension` `browser_cookie` `browser_intercept` `browser_detectability`                                                                                                                                   |
| 网络         | `browser_net_check` `browser_egress`                                                                                                                                                                                                 |
| 验证码       | `browser_captcha` `browser_captcha_status`                                                                                                                                                                                           |

完整参数参考：[`skills/firefox-browser/REFERENCE.md`](skills/firefox-browser/REFERENCE.md)。

### Firefox 独有的工具

这些工具存在，是因为 server 自己驱动 Firefox：

| 工具                    | 作用                                                             |
| ----------------------- | ---------------------------------------------------------------- |
| `browser_context`       | Firefox 容器 —— 每个身份一套隔离的 cookie / localStorage / cache |
| `browser_extension`     | 安装 / 卸载 WebExtension                                         |
| `browser_cookie`        | 读写 cookie，**包括 HttpOnly 的那些**                            |
| `browser_intercept`     | 按 URL 拦截请求；每个请求都有兜底放行，页面不会被永久冻住        |
| `browser_detectability` | 实测本会话有多容易被检测                                         |

### 工作循环

```
browser_snapshot  →  按 ref 动手  →  读 effect 块
```

## 安全与错误契约

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
| [MiniMax Code 插件](docs/mcode-plugin.md)       | 宿主集成与包契约              |
| [代理使用指南](skills/firefox-browser/SKILL.md) | 代理该怎么驱动它              |

## 许可

MIT，见 [LICENSE](LICENSE)。
