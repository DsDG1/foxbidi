---
name: firefox-browser
description: 用真实 Firefox 浏览网页并执行交互动作（打开链接、点击、输入、读取页面文本、截图）。当用户要求"用 Firefox 打开/点击/搜索/截图"，或需要访问需要登录态的站点时使用本 Skill。默认优先使用本 Skill 驱动的真实 Firefox（带用户真实登录态）；只有当用户明确提到"当前浏览器 / 右侧浏览器 / 内置浏览器 / browser use"时，才改用宿主内置的浏览器能力。需要把页面在两种浏览器之间转移时，用 browser_handoff。
---

# Firefox 浏览器控制

通过 WebDriver BiDi 驱动一个**真实的 Firefox**，而不是内置的无头浏览器。

## 选哪个浏览器

| 表面                            | 是什么                                                | 什么时候用                                                   |
| ------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| **本 Skill 的 Firefox**（默认） | 插件复制的用户 profile，完整登录态，真实 Firefox 内核 | **默认都用它。** 任何网页浏览/交互任务                       |
| **宿主内置浏览器**              | `mcp_browser` 控制的宿主浏览器面板                    | 用户明确说"当前浏览器 / 右侧那个 / 内置浏览器 / browser use" |

判据：**默认 Firefox。** 它带用户真实登录态，且只有它能跑 Firefox。内置浏览器走 Chromium 路线（同样带登录态），但**驱动不了 Firefox**——Firefox 没有 CDP。**两个表面的登录态、cookie、标签页互不相通。** 需要换表面时用 `browser_handoff`。

## 核心工作流

```
快照 → 动作 → 验证
```

1. **`browser_snapshot`** 拿页面元素（role + name + ref）。这是第一步。
2. **用 `ref` 动手**，不要猜 CSS 选择器。`ref` 是快照给的，猜选择器是失败率最高的做法。
3. **看 `effect`**。`effect.verified: false` = 页面确实没变，动作多半没生效——**别重复同一个动作**，重新快照看当前状态。
4. **ref 失效就重新快照**。页面重渲染后旧 ref 全部作废（工具会返回 `requiresResnapshot: true`）。

## 决策树

```
要做什么？
├─ 打开页面          → browser_navigate（重页面用 wait:"none" 再 browser_wait_for）
├─ 看有什么可点的    → browser_snapshot（roleFilter 缩小范围；frames:"all" 含 iframe）
├─ 点/输入/选择      → browser_click / browser_type / browser_select_option / browser_check
├─ 读文字            → browser_text（长文分页读 offset/nextOffset；或 snapshot+includeText）
├─ 页面没反应        → browser_network 找 4xx/5xx → browser_logs 看 console → 重新快照
├─ 连续几步          → browser_batch（一次调用走完，省往返）
├─ 重复性操作        → 写 helper 脚本 + browser_run_script（见下）
├─ 页面弹了框        → 看 effect.dialog；需要自己答 → browser_handle_dialog
└─ 需要多账号/隔离   → browser_context（Firefox 容器）
```

## 快照

`browser_snapshot` 返回 `elements[]`，每项含 `ref` / `role` / `name` / `rect` / `inViewport`。

| 参数                            | 用途                                                           |
| ------------------------------- | -------------------------------------------------------------- |
| `roleFilter: ["button","link"]` | 只保留这些角色，页面吵时用                                     |
| `nameContains: "登录"`          | 只保留名字含此文本的                                           |
| `offset` + `maxElements`        | 分页。`nextOffset` 是下一页起点，**第 300 个之后照样能拿到**   |
| `includeText: true`             | 顺便返回可见文本块，省一次 browser_text                        |
| `frames: "all"`                 | 连 iframe 内容一起快照，iframe 里的 ref 带帧前缀 `fxxxxxxx:e0` |

快照**能穿透 open shadow root**；closed shadow root 平台层面进不去。ref **不写进 DOM**（映射在页面里一个不可枚举属性上），所以**别再用 `document.querySelectorAll('[data-mavis-ff-ref]')` 找元素**，那个属性已经不存在了。

## 动作

`browser_click`（真实指针事件，会先滚动到可见再点）· `browser_type`（逐字符输入，`clear:true` 先清空、`submit:true` 打完回车）· `browser_press_key`（`Ctrl+Enter` 这类组合会按住修饰键再按目标键）· `browser_select_option`（默认按 value，`byText:true` 按可见文字）· `browser_check` · `browser_hover`（下拉菜单、tooltip）· `browser_scroll` · `browser_upload`（**不可逆，要 confirm**）· `browser_wait_for`（等元素/文字/加载/网络空闲，**别用固定 sleep**）· `browser_batch`（见下）。

所有元素类工具都收 `ref`（推荐）或 `selector`（兜底）。两个都给时 **ref 优先**，selector 被忽略并会提示。

## 省 token

- **用快照代替 browser_text**。快照只给交互元素；要读文章才读全文。
- **不要为了"看看长什么样"截图**。截图是像素不是文字，只在需要给人看时用。
- **browser_batch** 把"点击 → 输入 → 快照"从 3 次往返压成 1 次。
- **长文本分页读**：`browser_text` 截断后带 `nextOffset`，只续读需要的部分。
- **browser_evaluate 只在专用工具不够用时用**——它返回的一切都会进上下文。

### 沉淀 helper（browser-harness 模式）

重复的操作不要每次重新摸索。写成脚本存到 `~/.mavis/ff-workspace/`，之后用 `browser_run_script` 跑。脚本体是一个接收 `args` 的函数，返回值会回传；只允许读 `~/.mavis/ff-workspace/` 下的文件（路径按软链解析后的真实路径判定）。

```js
// ~/.mavis/ff-workspace/expand-row.js
return (args) => {
  const row = document.querySelector(args.selector)
  row?.querySelector('[aria-expanded="false"]')?.click()
  return { ok: true }
}
```

## 弹窗（重要）

页面弹 `alert()` / `confirm()` / `prompt()` / `beforeunload` 时**会阻塞页面**——后续所有命令都会卡住。插件会**自动关掉**它，并把弹窗内容放进上一个动作的 `effect.dialog`（`{type, message, handled}`）。

看到 `effect.dialog` 就知道刚才有个框被关掉了。想自己答就用 `browser_handle_dialog`：`action: "accept"` / `"dismiss"` / `"acceptWithText"`（后者带 `text`）。想让弹窗保持打开：`browser_config({dialogPolicy: "manual"})`。

**注意**：弹窗是页面自己的对话框，不走确认闸门；但如果它说"确定支付"，应该先把情况告诉用户。

## Firefox 独有能力

这些是 CDP 方案**做不到**的（Firefox 没有 CDP）：

| 工具                            | 用途                                                     | 需要       |
| ------------------------------- | -------------------------------------------------------- | ---------- |
| `browser_context`               | 容器：独立 cookie / localStorage / cache。多账号同站并存 | FF124+     |
| `browser_extension`             | 安装/卸载扩展（uBlock、2FA、密码管理器）                 | FF137+     |
| `browser_cookie`                | 读写 cookie，**能读 HttpOnly**                           | FF124+     |
| `browser_intercept`             | 屏蔽请求（追踪器、广告、吵闹的 API）                     | FF124+     |
| `browser_detectability`         | 实测本会话有多容易被检测                                 | —          |
| `browser_network` + `requestId` | 读响应体                                                 | **FF144+** |

**用之前先看 `browser_status`**：它一次报清"什么 Firefox、哪些能力可用、ref 存哪、有没有挂起的弹窗"。它是只读的——不会为了回答问题而启动浏览器。浏览器没跑时，能力矩阵是按版本号推出来的**预期**（`capabilities.probed` 为 `false`）；跑起来之后就是实探结果。

能力不可用时，工具会返回 `capability_unavailable` 并写明"需要 Firefox >= 144"、当前版本、以及替代做法——**不是**一句看不懂的 `unknown command`。`browser_intercept` 的 URL 匹配在插件侧做：装上拦截后所有请求会被 Firefox 挂起，插件逐个决定放行还是失败，所以**页面不会被永久冻住**。用完 `browser_intercept({action:"clear"})` 收掉。

## 反检测：能做什么，不能做什么

**能**：快照不再往 DOM 写属性（最大的痕迹没了）；注册表键随机且不可枚举。**不能**：Firefox 只要 Remote Agent 在跑，`navigator.webdriver` 就是 `true`，**没有任何 pref 或启动参数能关掉它**——这是 Firefox 用 BiDi 的既定代价。所以**别说"隐身"**。要事实就调 `browser_detectability`，它会实测并如实报告。

## 验证码（可选能力）

`browser_captcha` 是**可选**的：不调用它，插件什么都不做。`{"solver":"auto","sttUrl":"http://127.0.0.1:8000"}`；`solver` 可填 `turnstile` / `recaptcha` / `hcaptcha` / `geetest` / `pow` / `spin`。

**成功判据是站点发放的 token，不是"点中了"**：`ok:true` 只在 token 长度 > 0 时返回，否则 `ok:false` + `status`。插件**不含任何模型**：音频挑战要你指一个 Whisper 兼容服务（`sttUrl`），没有就报 `stt_unavailable`；图片九宫格默认不支持（可传 `visionUrl`）。**缺服务就报错，绝不假装成功。**

已端到端验证：Turnstile、百度旋转验证码（`spin`，成功判据是服务端 `POST /cap/log` 回 `data.op ∈ {1,2}`）。未在本机验证：reCAPTCHA v2 / hCaptcha / GeeTest / PoW。不支持 reCAPTCHA v3、hCaptcha 九宫格、腾讯/网易/阿里滑块、付费 API。细节见 `docs/captcha.md`。

## 不可逆动作需要确认

提交表单、下载文件、上传本地文件、向站点提交账号数据、安装扩展、写 cookie——这些默认被拒，返回 `{ok:false, blocked:true, action:"form_submit", requiresConfirm:true}`。确认后再加 `confirm: true` 重试**同一个**调用。别绕闸门，也别替用户猜——涉及花钱、发消息、改账号时先告诉用户。

判断依据是 **DOM 事实**，不是按钮文字：提交控件、POST 表单、`download` 属性、文件输入框、跨域 POST 且字段名像账号信息。中文站的"确认"、英文站的"OK"不会误触发。

**闸门覆盖所有能提交表单的路径**，不只是点击：在表单输入框里按 `Enter`、改 `<select>`、切 radio 都会隐式提交，所以 `browser_press_key` / `browser_select_option` / `browser_check` 同样要 `confirm: true`。**别换条路绕过它**——那不是聪明，是漏洞。

## 脱敏：默认看不见凭据

这个浏览器带的是用户**真实登录态**，所以插件对所有出站通道统一脱敏（cookie 值、页面 console 日志、快照里的输入框值、响应体）：

- `browser_cookie` 默认只给 cookie 的**身份**（名字/域/路径），值是 `<redacted:len=N>`。真要原值：`browser_cookie({action:"get", revealValues:true})`。
- 快照里 `type=password`、`autocomplete="one-time-code"`、名字像 `otp`/`token`/`card`/`验证码`/`密码` 的字段，值是 `<redacted>` 并带 `valueRedacted:true`——**你知道那里有东西，但拿不到内容**。真要原值请用户自己读，别绕过。
- console 日志和响应体里的 token/JWT/`Bearer` 会被就地替换，句子其余部分照常可读。响应体要原样：`browser_network({requestId, revealBody:true})`。

**这是默认行为，不是故障。** 看到 `<redacted>` 不要重试到拿到为止。

## 导航策略与审计

导航默认拒绝私网/环回地址（`127.0.0.1`、`localhost`、`10.x`、`192.168.x`）和 `file:`/`data:` 等 scheme——带真实登录态的浏览器能访问机器上你访问不到的服务。被拒时返回 `code: "navigation_blocked"`。需要调本地开发服务：`FIREFOX_BROWSER_ALLOW_PRIVATE_HOSTS=1`。

每次工具调用都写一条审计到 `<插件数据目录>/audit/<日期>.jsonl`：做了什么、点了哪个控件、是否被拦。**审计不记录输入文本和 cookie 值**。路径见 `browser_status` 的 `audit` 字段。

## 在两个浏览器之间交接

`browser_handoff` 负责搬页面。**Firefox → 内置浏览器**：只读，`{ "to": "in-app" }` 返回 URL 和引导（`carry: "url+summary"` 还会带上当前页可交互元素摘要）。**内置浏览器 → Firefox**：有动作，`{ "to": "firefox", "url": "..." }` 会真的导航并回报 `effect`（含 `verified`）。

**不共享状态**：交接过去的只是 URL。登录态、cookie、标签页都留在原表面。需要 Firefox 的登录态就往 Firefox 交。

## 让用户在 webui 里看到截图

`browser_screenshot` 会返回一个 **`imageUrl`**——插件在 `127.0.0.1` 上用一个小 HTTP 服务托管这张截图。如果用户是在 webui（浏览器里的聊天界面）里对话，把这个 URL 以 markdown 图片写进回复：`![页面截图](http://127.0.0.1:54321/i/xxxxxxxx.png)`。

**不要把 base64 写进回复**——图片字节留在 URL 后面，模型上下文里只有一个短 URL。图片服务只监听 `127.0.0.1`，URL 带 192-bit 随机 token，**1 小时后失效**（过期和不存在都回 404）。从另一台设备经局域网打开 webui 时 `127.0.0.1` 指向那台设备自己，图片会显示不出来——这种情况改用文字描述。

## ref 失效了怎么办

ref 绑定在 DOM 上。**页面一旦重新渲染**（React 刷新、翻页、AJAX 替换节点），旧 ref 全部作废，工具返回 `{ok:false, requiresResnapshot:true, hint:"take a fresh browser_snapshot"}`。

看到 `requiresResnapshot: true` 就**重新调 `browser_snapshot`**，不要换选择器硬试，也不要重试同一个 ref。

## 排查"点击没反应"

按这个顺序查：

1. `effect.verified` 是 `false` 吗？→ 动作没生效，继续往下。
2. `browser_network` 看请求：有没有 4xx/5xx、CORS 拒绝、被拦截的第三方调用。**这是"点了没反应"最常见的原因**。
3. `browser_logs` 看 console 报错。
4. 重新 `browser_snapshot`——页面结构可能已经变了。

`browser_network` 的 URL **永远不带 query string**（那里可能藏着会话 token），只看 origin + path。

## 工具速查

**读**：`browser_snapshot`（第一步）· `browser_text` · `browser_tabs` · `browser_logs` · `browser_network` · `browser_screenshot` · `browser_evaluate` · `browser_detectability` · `browser_status`
**动**：`browser_click` · `browser_type` · `browser_press_key` · `browser_select_option` · `browser_check` · `browser_hover` · `browser_scroll` · `browser_upload` · `browser_wait_for` · `browser_batch` · `browser_run_script` · `browser_handle_dialog`
**Firefox 独有**：`browser_context` · `browser_extension` · `browser_cookie` · `browser_intercept`
**验证码**：`browser_captcha` · `browser_captcha_status`（可选；不调用就完全不参与）
**生命周期/历史/视口**：`browser_start` · `browser_stop` · `browser_status` · `browser_new_tab` · `browser_navigate` · `browser_close_tab` · `browser_back` · `browser_forward` · `browser_reload` · `browser_set_viewport` · `browser_config` · `browser_handoff`

**失败时读 `code`，别读 `error`。** 失败结果同时带 `code`（机器可读的固定词表，如 `ref_stale`、`confirm_required`、`invalid_argument`）和 `error`（给人看的原话）。分支请用 `code`。全部词表和每个工具的完整参数说明见 `REFERENCE.md`（同目录，需要时再读）。

## 用法要点与限制

**浏览器按需启动。** 任何工具在实例未运行时都会自动拉起 Firefox——不需要先调 `browser_start`。首次调用会复制 profile 并等待 BiDi 端点就绪，可能需要十几秒。profile 副本默认 24 小时过期（`FIREFOX_BROWSER_PROFILE_TTL_HOURS`），过期后重建。

**不需要指定 contextId。** 省略时自动作用于最近使用的标签页。只有在同时操作多个标签页、且要精确指定目标时才传。

**重页面用 `wait: "none"`。** `bing.com`、`addons.mozilla.org` 这类默认的 `complete` 可能超过 30 秒的 BiDi 命令超时而报错——但页面其实已经加载好了。然后用 `browser_wait_for` 等到你要的东西。

- **只支持 Firefox。** Firefox 没有 CDP，WebDriver BiDi 是唯一路径。Chrome/Edge 请用宿主内置的浏览器能力。
- **单实例、单会话。** Firefox 的 BiDi 端点只允许一个活跃会话。
- **profile 副本是快照。** 插件复制的是用户 profile 的某一时刻，之后真实 Firefox 里的变化不会自动同步。标签页不共享。
- **无头模式。** 默认 headless。需要人工过验证码或登录时，把 `FIREFOX_BROWSER_HEADLESS` 设为 `0`。
- **副本含真实凭据。** profile 副本目录（含 cookies、登录信息）权限为 `0700`，存放于插件数据目录。可以用 `rm -rf` 手动清理。
- **`browser_evaluate` 能执行任意 JavaScript。** 这是能力本身固有的。请把它当作显式动作使用。
