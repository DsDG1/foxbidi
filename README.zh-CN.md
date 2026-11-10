# foxbidi

### 给你的编码代理一个真实的 Firefox —— 走 WebDriver BiDi。

[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen.svg)](https://nodejs.org)
[![mcp](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](https://modelcontextprotocol.io)
[![firefox](https://img.shields.io/badge/Firefox-140%20ESR-verified-orange.svg)](docs/capabilities-matrix.md)
[![deps](https://img.shields.io/badge/runtime%20deps-0-success.svg)](package.json)

> English: [README.md](README.md)

**MiniMax Code（MCode）能驱动 Chromium，但驱动不了 Firefox。**

Firefox 在 2024 年底移除了实验性的 CDP 实现，WebDriver BiDi 成了它唯一剩下的协议；
而当下能用的浏览器 MCP server 绝大多数只会说 CDP —— 于是，碰上那些「非 Firefox 就跑不对」的站点，
你就卡住了。

`foxbidi` 补的就是这一块：一个**零运行时依赖**的 Node MCP server，驱动**真实的 Firefox**
—— 你自己的 profile、你自己已经登录的会话 —— 并以 **43 个原生工具**交给你的代理使用。

它以 MiniMax Code 插件的形式提供，同时兼容任何 MCP 客户端（Claude Code、Cursor 等）。

---

## 你会得到什么

|                 | MCode 内置浏览器 | `foxbidi`                    |
| --------------- | ---------------- | ---------------------------- |
| 内核            | Chromium         | **真实 Firefox**             |
| 协议            | CDP              | **WebDriver BiDi**           |
| 登录态          | 独立 profile     | **你自己的 Firefox profile** |
| 多身份并存      | —                | Firefox 容器                 |
| HttpOnly Cookie | 读不到           | 可读                         |
| 扩展管理        | —                | 可安装 / 卸载                |
| 运行时依赖      | —                | **0**                        |

---

## 亮点

**登录态直接带过去。** 插件驱动的是你 Firefox profile 的**副本**，你已经登录的站点依然是登录状态。
那些在全新 Chromium profile 里死活进不去的站点 —— 企业 SSO、内部工具、任何带设备校验的服务 —— 到这里直接能用。

**输入是真人的输入。** 点击走完整的指针事件（`pointerMove → pointerDown → pointerUp`），
输入是逐字符发键事件，不是合成的 DOM 事件 —— 后者大量网站会直接拒绝。

**遇到弹窗不会卡死。** 一个 JavaScript `alert()` 就能把 Firefox 完全堵住。
插件订阅了弹窗事件，自动关掉并把内容告诉代理，而不是让后面每条命令都莫名其妙超时。

**该找到的都找得到。** 快照能钻进 open shadow root 和 iframe，也能翻过第 300 个元素而不是到那儿就停。

**不在 DOM 上留痕迹。** 元素 ref 存在页面侧一个随机、不可枚举的注册表里，
不会往 HTML 里写任何属性，页面用 `MutationObserver` 也发现不了。

**它清楚当前这台 Firefox 能干什么。** 能力是在运行时对着真实浏览器探测出来的，
所以一份构建在 Firefox 118 和 Firefox 150 上都能用 —— 缺功能时会明说需要哪个版本，
而不是丢一句 `unknown command`。

**结果如实上报。** 每个动作都会返回 `effect` 块。`effect.verified` 只有在 URL 或 DOM 指纹**确实变了**时才是 `true`；
命令跑了但没生效，会如实报 `verified: false`，绝不谎报成功。
失败会带上机器可读的 `code`（`ref_stale`、`confirm_required`、`capability_unavailable`……），
代理可以按错误码分支，而不是去匹配一句英文报错。

**带着真实登录态也是安全的。** 不可逆动作（提交表单、下载、上传、装扩展、写 cookie）都会撞上确认闸门；
所有出站通道统一脱敏。而且如果某个页面把指令藏在 DOM 里只给代理看 —— 离屏文字、白底白字、1px 字号 ——
插件会识别出来并标为不可信内容，而不是照着执行。

---

## 快速上手

**环境要求：** Node ≥ 20，Firefox 118+（推荐 140 ESR，本项目已实测）。

```bash
git clone https://github.com/DsDG1/foxbidi.git ~/.minimax/plugins/foxbidi
```

把 MiniMax Code 指向这个目录，工具就会和其他插件工具一起出现。
其他 MCP 客户端则注册这个 stdio server：

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

浏览器按需启动 —— 第一次调用工具时才会拉起。

**试试看：**

- 「用 Firefox 打开 example.com 并截图。」
- 「在 Firefox 里搜索『hello』，把结果页文本读给我。」
- 「开两个 Firefox 容器 —— 一个登录状态，一个没有。」

---

## 宿主没把工具注入进来时

插件自带一条不需要宿主配合的入口：

```bash
node tools/ff-call.mjs browser_status '{}'   # 直接调用任意工具
node tools/ff-call.mjs --doctor              # 体检：什么能用、什么不能用
node tools/ff-call.mjs --serve               # 起常驻服务
node tools/ff-call.mjs --stop                # 收掉
```

---

## 文档

| 文档                                            | 内容                                     |
| ----------------------------------------------- | ---------------------------------------- |
| [完整插件文档](README-detailed.md)              | 完整工具表、能力矩阵、安全模型与开发指南 |
| [能力矩阵](docs/capabilities-matrix.md)         | 每项功能需要哪个 Firefox 版本            |
| [Firefox 独有能力](docs/firefox-only.md)        | CDP 方案做不到的那些事                   |
| [排障手册](docs/troubleshooting.md)             | 「点了没反应」到底怎么回事               |
| [代理使用指南](skills/firefox-browser/SKILL.md) | 代理该怎么驱动它                         |

---

## 许可

MIT，见 [LICENSE](LICENSE)。
