# Firefox 浏览器 Skill —— 参数与错误码参考

这份文件是 `SKILL.md` 的展开版：**主文件保持精简**（每轮都要读），细节按需查这里。

工具的 `description` 在 2.3.0 压到一句话——每个工具定义每轮对话都注入上下文，散文是常驻成本。
参数语义因此搬到了这里。工具的 `inputSchema` 里仍然保留每个参数的简短说明，可以对照着看。

## 通用参数

- `contextId` — 目标标签页；省略即作用于最近使用的那个。
- `ref` — 来自 `browser_snapshot` 的元素引用；与 `selector` 同时给时 `ref` 优先。
- `selector` — CSS 选择器。`ref` 失效时用它兜底。
- `confirm` — 不可逆动作（表单提交、上传、扩展安装、cookie 写入、视口改写）必须传 `true`。

## 读取

- `browser_snapshot` — `maxElements`（默认 300，上限 5000）、`offset`（配返回的 `nextOffset` 翻页）、`roleFilter`（如 `["button","link"]`）、`nameContains`（按无障碍名过滤）、`includeText`（附带可见文本块）、`frames: "all"`（连 iframe 内容一起快照，refs 带 frame 前缀）、`since`（上次的 `snapshotId`，会在全量列表之外附带一个 `delta` 字段）。
- `browser_text` — `maxChars`（默认 8000）、`offset`（字符偏移）、`selector`（只读某个元素）。
- `browser_network` — `status`（如 `["4xx","5xx","error"]`）、`types`（如 `["xhr","fetch"]`）、`filter`（URL 子串）、`afterSeq`（只看更新的请求）、`limit`（默认 50）、`requestId` + `bodyType`（取响应体，Firefox 144+）。**响应体默认脱敏**（只替换明确的 secret 形态）；要原样传 `revealBody: true`。
- `browser_logs` — `channel`（`console` / `plugin` / `bidi` / `all`）、`levels`、`filter`、`limit`。
- `browser_evaluate` — `expression` 在页面上下文执行，返回其值。`confirm`（页面带隐藏注入时必需）。返回值有上限（默认 8192 字符），超限返回 `truncated: true`；页面侧抛异常返回 `code: "evaluate_failed"`。
- `browser_screenshot` — `fullPage`（整篇文档而不是视口）、`elementRef`（只截某个快照 ref）。
- `browser_verify` — 对页面做断言，拿结论。`kind` 必填：
  - `kind: "element"` — 存在某个 role + 无障碍名的元素。给 `role`（如 `"button"`）和/或 `name`。名字先精确匹配、再包含匹配，大小写不敏感。命中返回 `verified: true` 和该元素的 `ref`。
  - `kind: "text"` — 可见文本里有这段字。`text` 必填。大小写不敏感。页面可见文本**先脱敏再读**，所以拿真验证码去断言必然失败（`hint` 会说明）。
  - `kind: "value"` — 目标元素的值等于期望值。需要 `ref` 或 `selector`，外加 `value`。
  - `kind: "list"` — 目标元素里包含这些条目。需要 `ref` 或 `selector`，外加 `items` 数组。返回 `matched`（命中的）和 `missing`（没命中的）分开列。
  - **凭据字段拒绝比对**：目标是密码、验证码、卡号一类字段时返回 `code: "redacted_value"`。这不是策略上的拒绝——那些字段的真值**从来没有离开过页面**（页面侧脚本返回空串），插件手里根本没有可比对的东西。
  - **`kind: "text"` 的查找范围**：先查快照的文本块（只含 `p` / `li` / 标题 / 表格单元格这类**块级**元素），再查元素的无障碍名，最后查整页可见文本。所以把文字放在 `<div>` 里的页面也能断言到。
  - **`ok` 与 `verified` 是两回事**：`ok: true` + `verified: false` 表示断言跑了但没成立（换个思路，别重复调用）；`ok: false` 表示断言压根没跑起来（参数不对、页面不可达、目标不存在）。
  - `kind: "element"` 只能在**交互元素**里找（按钮、链接、表单控件、显式 `role` 的元素）。纯文本段落（`<p>`）不在快照候选集里，断言不到。
- `browser_find` — 在页面上搜一段文字，拿**位置**。`text` 必填（子串匹配，不区分大小写；不支持正则）。
  - 结果**分开报**：`elements` 是能点的元素（每条带 `ref` / `role` / `name`），`texts` 是正文里的段落（**没有 ref，别去点它**）。两类命中用 `elementCount` / `textCount` 分别计数。
  - 每个元素命中带 `before` / `after` —— 文档顺序上紧邻它的前后的元素（各带 `ref` / `role` / `name`）。本地快照是**扁平列表、没有父子层级**，所以邻居就是"这东西在页面哪个位置"的答案。
  - `context` 控制邻居数量（默认 2，上限 10），`maxResults` 限制返回的命中条数。
  - 找不到是**成功的搜索**：`ok: true`、`total: 0`。
  - 正文是**脱敏后**读的，所以搜一个真验证码搜不到——这是诚实答案，不是故障。

## 动作

动作类工具（`browser_click` / `browser_type` / `browser_press_key` / `browser_select_option` / `browser_check` / `browser_hover` / `browser_scroll` / `browser_upload`）的响应里带 `effect`，其中：

- `effect.verified` — 动作到底有没有生效（比对动作前后的页面状态）。
- `effect.snapshot` — **动作之后**页面上的一批元素，每条只有 `ref` / `role` / `name` 三项，最多 60 条。这是"顺带看一眼"，让 agent 不用再单独调一次 `browser_snapshot` 才知道页变成什么样了。
  - 里面的 `ref` 是**当下最新**的；但页面之后若重渲染，ref 照样会失效（工具会回 `requiresResnapshot: true`）。
  - 需要坐标、当前值、完整列表时，仍然调 `browser_snapshot`。
- `effect.dialog` — 动作触发的 JavaScript 弹窗（插件按 `dialogPolicy` 处理，默认自动关掉）。

**关掉内联快照**：`browser_config { inlineSnapshot: false }`（会话级，默认开）。页面很大、这些元素是噪音时关掉。

- `browser_click` — `button`（0 左键 / 1 中键 / 2 右键）、`clickCount`（双击填 2）。
- `browser_type` — `text` 必填；`clear` 先清空；`submit` 打完回车（可能提交表单，要 `confirm`）。
- `browser_select_option` — `value` 可传值或可见文本；`byText: true` 按可见文本匹配。改 `<select>` 可能隐式提交表单，**要 `confirm`**。
- `browser_check` — `checked` 为 `true` 勾选、`false` 取消。切 radio 可能隐式提交表单，**要 `confirm`**。
- `browser_press_key` — `key` 如 `"Enter"` / `"Ctrl+Enter"`。**在表单输入框里按 Enter 会提交表单，要 `confirm`**；焦点探测不到时保守拒绝（也要 confirm）。
- `browser_hover` — 只移动指针，不点击。
- `browser_scroll` — `direction`（`up`/`down`/`top`/`bottom`）、`amount`（像素，默认 400）；给了 `ref`/`selector` 就是滚动到该元素。
- `browser_upload` — `paths` 绝对路径数组；**不可逆，要 `confirm`**。
- `browser_wait_for` — `for`（`selector`/`text`/`load`/`networkIdle`）、`timeoutMs`（默认 10000）。
- `browser_batch` — `steps` 是有序动作数组，每步一个 `"action"` 加它的参数；`stopOnError`（默认 true）控制失败即停。
- `browser_run_script` — `path` 必须在 `~/.mavis/ff-workspace/` 内；`args` 会作为脚本的 `args` 参数传入。
- `browser_handle_dialog` — `action` 为 `accept` / `dismiss` / `acceptWithText`（后者用 `text` 填入）。
  - `dialogPolicy: "manual"` 时弹窗**保持打开**，页面被它挡着：动作会返回 `code: "dialog_open"`（而不是干等到超时），`browser_handle_dialog` 处理完页面才恢复。

## 网络

- `browser_net_check` — 页面打不开时先跑它。`target`（主机名或 URL，省略则用当前页）、`timeoutMs`（默认 8000）。
  - 同时取两个样本：**本机**（能否解析、能否连通）与**浏览器**（能否加载），两者的差就是诊断。
  - `diagnosis` 取值：`ok` / `dns_broken` / `firefox_egress_blocked` / `host_egress_blocked` / `inconclusive`。
  - `host` 与 `browser` 两个对象带各段的原始事实；`hint` 是下一步该做什么；`suggestEgress` 为 true 时提示可以用 `browser_egress`。
  - **端口**：目标 URL 带端口就试那个端口，没带就试 443 再 80——只试 443 会把"站点只在 8080 上服务"误判成不通。`ports` 字段列出试过的每个端口。
  - 探针页用完即关，**不留残留标签页**；不读页面内容，因此不受页面注入告警影响。
- `browser_egress` — 本地出口代理（可选，默认关）。`action` 为 `start` / `stop` / `status`。
  - `start` 会起一个监听 `127.0.0.1` 的转发代理，并把代理设置写进 profile 副本；**端口每次可能变，所以要 `browser_restart` 才生效**。
  - 只连 80/443，**拒绝私网/回环/链路本地的目标**（按解析出来的地址判定，所以指向内网的名字也进不来）；不做 TLS 中间人；连接记审计，但只记主机、端口和字节数。
  - 解析优先用系统解析器，失败再走 DoH（可用 `FIREFOX_BROWSER_DOH_URI` / `FIREFOX_BROWSER_DOH_BOOTSTRAP` 覆盖）。

## 生命周期与历史

- `browser_start` — 幂等：实例已在跑就复用。首次启动要复制 profile 并等 BiDi 端点就绪。
- `browser_stop` — `keep: true` 保留 Firefox 进程，之后 `browser_start` 会重新接管。
- `browser_navigate` — `url` 必填（缺 scheme 按 https 补）；`wait` 取 `none`（立刻返回）/ `interactive`（DOM 已解析）/ `complete`（默认）。
  - 返回里 `url` 是**请求的** URL，`landedUrl` 是标签页**现在真的在**的 URL，`navigated` 说明这次导航有没有生效（标签页动过，或它正站在你要的那一页上）。
  - `wait: "none"` 时页面可能还没到：这时会带 `pending: true` 和一句提示，让 `browser_wait_for` 去等。**别把 `ok: true` 当成"页面已经到了"**——命令被接受不等于页面到了。
  - 跨源重定向是合法的，所以 `landedUrl` 可能和 `url` 不同（OAuth 登录常见）。这不是失败。
  - **超时时看 `hint`**：它说的是事实——哪个请求、挂了多久。请求还没超过命令超时就
    `browser_wait_for` 等；已经超过就是"卡住了"，按提示跑 `browser_restart {scope:"session"}`。
- `browser_back` / `browser_forward` — 走标签页历史（Firefox 122+）。到头会返回 `code: "invalid_argument"` 和一句提示，不是浏览器坏了。
- `browser_reload` — 重载当前标签页（Firefox 119+）。
- `browser_set_viewport` — `width` / `height`（CSS 像素）必填，`devicePixelRatio` 默认 1。用来测响应式布局而不改窗口大小；会重排页面，所以要 `confirm: true`（Firefox 117+）。
- `browser_restart` — 重启 Firefox。写进 profile 副本的首选项**重启后才生效**，用这个让它们立刻起作用（不用重启 MCP 服务）。返回新的 `pid` / `port` / `sessionId`。
  - `scope` 选范围：`browser`（默认）杀 Firefox 再起，首选项随之生效；`session` 只**重置 BiDi 会话**——**Firefox 不杀、标签页全留、登录态不丢**，只把卡住的会话换掉。
  - 什么时候用哪个：`session_stuck`（会话卡死）用 `scope: "session"`；改了首选项等它生效用默认的 `browser`。
  - 返回里 `scope` 和 `browserKept` 说明这次实际做了什么。
- `browser_config` 的扩展参数：`prefs`（Firefox 首选项对象）、`applyNow`（是否立即作用于运行中的浏览器）、`timeoutMs`（单条命令超时，立即生效）、`restart`（改完是否重启）。
  - 首选项**只写 profile 副本**，用户真实 profile 永不被改；首选项名会做白名单校验，值只收字符串/数字/布尔。
  - `applyNow: true` 需要特权 Firefox（宿主以 `FIREFOX_BROWSER_PRIVILEGED=1` 启动）。没有特权时不报错，降级为「写副本 + 重启生效」，并在 `hint` 里说明。
- `browser_config` — `preset`（`slim`/`basic`/`developer`/`all`）、`dialogPolicy`（`autoDismiss` 默认 / `autoAccept` / `manual`）、`maxSnapshotElements`（上限 5000）、`inlineSnapshot`（动作后是否附带精简元素列表，默认 `true`）。

## Firefox 独有

- `browser_context` — `action` 为 `list`/`create`/`select`/`remove`，配 `userContext`、`label`、`url`。
- `browser_extension` — `action` 为 `install`/`uninstall`/`list`，配 `path`（解包目录或 XPI）、`extensionId`、`permanent`（Firefox 138+ 才支持永久安装；更早版本默认临时安装）。
- `browser_cookie` — `action` 为 `get`/`set`；`filter` 如 `{"domain":"example.com"}`，`cookie` 如 `{"name":"sid","value":"x"}`。能读写 HttpOnly cookie（Firefox 124+）。**`get` 的值默认脱敏成 `<redacted:len=N>`**；要原值传 `revealValues: true`。`set` 是不可逆写入，**要 `confirm`**。
- `browser_intercept` — `action` 为 `block`/`clear`，`patterns` 是 URL 子串数组。命中后请求被插件拦下再放行，页面不会卡死。
- `browser_detectability` — 只读，实测本会话有多容易被检测。

## 验证码

- `browser_captcha` — `solver` 缺省 `auto`（自动识别再选对应解法）；`sttUrl`（Whisper 兼容的语音转写端点）、`visionUrl`（图像识别端点）、`timeoutMs`（默认 60000）。
- `browser_captcha_status` — `kind` 必填（`turnstile`/`recaptcha`/`hcaptcha`/`geetest`/`pow`/`spin`），只读不点。

## 错误契约

失败时结果里同时有两个字段：`code` 是机器可读的固定词表，`error` 是给人看的原话。
分支逻辑请用 `code`，给用户的解释请用 `error`。

| code                     | 含义                                          |
| ------------------------ | --------------------------------------------- |
| `not_running`            | 浏览器没起来                                  |
| `no_context`             | 没有可用的标签页                              |
| `element_not_found`      | 选择器/ref 没匹配到任何东西                   |
| `element_not_actionable` | 元素在，但用不了（隐藏、禁用、类型不对）      |
| `ref_stale`              | 元素引用已过期，重新 `browser_snapshot`       |
| `frame_gone`             | 目标 iframe 已经不在了                        |
| `capability_unavailable` | 这版 Firefox 不支持该能力                     |
| `confirm_required`       | 不可逆动作被拦下，需要 `confirm: true`        |
| `invalid_argument`       | 参数不合法（包括历史到头）                    |
| `timeout`                | 等待超时                                      |
| `session_stuck`          | BiDi 会话卡死，只有重置会话才能恢复           |
| `dialog_open`            | 有模态弹窗挡着页面，动作已提前返回            |
| `network_error`          | 请求本身失败                                  |
| `path_not_allowed`       | 文件路径不在允许的目录里                      |
| `navigation_blocked`     | 这个 URL 不允许访问（私网地址、file: 等）     |
| `injection_blocked`      | 页面藏了指令，数据外发动作被拦下              |
| `evaluate_failed`        | 页面里的表达式抛异常或语法错了                |
| `redacted_value`         | 目标是凭据字段，真值从不离开页面，无法比对    |
| `unknown_tool`           | MCP 层被要求调用一个不存在的工具              |
| `privileged_unavailable` | 这版 Firefox 没开系统访问，首选项不能即时生效 |
| `prefs_write_failed`     | 首选项写不进 profile 副本                     |
| `net_check_failed`       | 出网体检本身没能完成                          |
| `egress_start_failed`    | 本地出口代理起不来                            |
| `egress_resolve_failed`  | 系统解析器和 DoH 都解析不出这个域名           |
| `internal`               | 插件内部错误                                  |

`hint` 字段会说明下一步该做什么。

`injection_blocked` 与 `confirm_required` **不是一回事**：`confirm_required`
用 `confirm: true` 就能重试，而 `injection_blocked` **解不开** —— 那个参数是
Agent 自己填的，页面能骗你填。只有用户可以解除（`FIREFOX_BROWSER_INJECTION_GATE=off`）。
读取永远不受限。

`session_stuck` 与 `dialog_open` 各有唯一正确的修法：

- `session_stuck` —— BiDi 会话卡住了：一条永远不返回的命令占着串行队列，后面的全在等。
  **不要重试、也不要干等**：跑 `browser_restart({scope: "session"})` 重置会话，
  Firefox、标签页、登录态都留着。只有重置会话能解开它。
- `dialog_open` —— 有模态弹窗挡着页面。跑 `browser_handle_dialog({action: "accept" | "dismiss"})`。
  插件**不会自动重试**这个动作：被放弃的那次导航可能在弹窗处理完才落地，页面会被悄悄改掉。

## 页面内容返回的字段

读取类工具（`browser_text` / `browser_snapshot` / `browser_evaluate`）返回：

| 字段        | 含义                                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`    | `{origin, kind, trusted}`。`origin` 只到 origin 级别，不含 query。`trusted` 恒为 `false` —— 这是"内容来自网页"的事实陈述，不是安全判断。                 |
| `signals`   | 命中但未达告警阈值的信号（`{kind}`）。不阻断任何动作。                                                                                                   |
| `warnings`  | 达到阈值的告警。`code` ∈ `hidden_injection` / `hidden_encoded_payload` / `aria_hidden_injection` / `encoded_injection`；`severity` ∈ `high` / `medium`。 |
| `redacted`  | 该次读取是否发生了脱敏。                                                                                                                                 |
| `truncated` | 输出是否被截断。                                                                                                                                         |
| `delta`     | 仅 `browser_snapshot` 带 `since` 时出现：`{since, added, changed, removed}`。全量 `elements` 仍然照常返回。                                              |

告警要求**两个独立条件同时成立**：渲染事实（人眼看不到）∧ 指令句式。只命中其中
一项不告警 —— 真实站点的抽屉菜单、hover 面板、无障碍标签都是"隐藏但无害"的。
