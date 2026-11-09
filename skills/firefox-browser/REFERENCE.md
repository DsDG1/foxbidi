# Firefox 浏览器 Skill —— 参数与错误码参考

这份文件是 `SKILL.md` 的展开版：**主文件保持精简**（每轮都要读），细节按需查这里。

工具的 `description` 在 2.3.0 被刻意压到一句话——每个工具定义每轮对话都注入上下文，散文是常驻成本。
参数语义因此搬到了这里。工具的 `inputSchema` 里仍然保留每个参数的简短说明，可以对照着看。

## 通用参数

- `contextId` — 目标标签页；省略即作用于最近使用的那个。
- `ref` — 来自 `browser_snapshot` 的元素引用；与 `selector` 同时给时 `ref` 优先。
- `selector` — CSS 选择器。`ref` 失效时用它兜底。
- `confirm` — 不可逆动作（表单提交、上传、扩展安装、cookie 写入、视口改写）必须传 `true`。

## 读取

- `browser_snapshot` — `maxElements`（默认 300，上限 5000）、`offset`（配返回的 `nextOffset` 翻页）、`roleFilter`（如 `["button","link"]`）、`nameContains`（按无障碍名过滤）、`includeText`（附带可见文本块）、`frames: "all"`（连 iframe 内容一起快照，refs 带 frame 前缀）。
- `browser_text` — `maxChars`（默认 8000）、`offset`（字符偏移）、`selector`（只读某个元素）。
- `browser_network` — `status`（如 `["4xx","5xx","error"]`）、`types`（如 `["xhr","fetch"]`）、`filter`（URL 子串）、`afterSeq`（只看更新的请求）、`limit`（默认 50）、`requestId` + `bodyType`（取响应体，Firefox 144+）。
- `browser_logs` — `channel`（`console` / `plugin` / `bidi` / `all`）、`levels`、`filter`、`limit`。
- `browser_evaluate` — `expression` 在页面上下文执行，返回其值。
- `browser_screenshot` — `fullPage`（整篇文档而不是视口）、`elementRef`（只截某个快照 ref）。

## 动作

- `browser_click` — `button`（0 左键 / 1 中键 / 2 右键）、`clickCount`（双击填 2）。
- `browser_type` — `text` 必填；`clear` 先清空；`submit` 打完回车（可能提交表单，要 `confirm`）。
- `browser_select_option` — `value` 可传值或可见文本；`byText: true` 按可见文本匹配。
- `browser_check` — `checked` 为 `true` 勾选、`false` 取消。
- `browser_hover` — 只移动指针，不点击。
- `browser_scroll` — `direction`（`up`/`down`/`top`/`bottom`）、`amount`（像素，默认 400）；给了 `ref`/`selector` 就是滚动到该元素。
- `browser_upload` — `paths` 绝对路径数组；**不可逆，要 `confirm`**。
- `browser_wait_for` — `for`（`selector`/`text`/`load`/`networkIdle`）、`timeoutMs`（默认 10000）。
- `browser_batch` — `steps` 是有序动作数组，每步一个 `"action"` 加它的参数；`stopOnError`（默认 true）控制失败即停。
- `browser_run_script` — `path` 必须在 `~/.mavis/ff-workspace/` 内；`args` 会作为脚本的 `args` 参数传入。
- `browser_handle_dialog` — `action` 为 `accept` / `dismiss` / `acceptWithText`（后者用 `text` 填入）。

## 生命周期与历史

- `browser_start` — 幂等：实例已在跑就复用。首次启动要复制 profile 并等 BiDi 端点就绪。
- `browser_stop` — `keep: true` 保留 Firefox 进程，之后 `browser_start` 会重新接管。
- `browser_navigate` — `url` 必填（缺 scheme 按 https 补）；`wait` 取 `none`（立刻返回）/ `interactive`（DOM 已解析）/ `complete`（默认）。
- `browser_back` / `browser_forward` — 走标签页历史（Firefox 122+）。到头会返回 `code: "invalid_argument"` 和一句提示，不是浏览器坏了。
- `browser_reload` — 重载当前标签页（Firefox 119+）。
- `browser_set_viewport` — `width` / `height`（CSS 像素）必填，`devicePixelRatio` 默认 1。用来测响应式布局而不改窗口大小；会重排页面，所以要 `confirm: true`（Firefox 117+）。
- `browser_config` — `preset`（`slim`/`basic`/`developer`/`all`）、`dialogPolicy`（`autoDismiss` 默认 / `autoAccept` / `manual`）、`maxSnapshotElements`（上限 5000）。

## Firefox 独有

- `browser_context` — `action` 为 `list`/`create`/`select`/`remove`，配 `userContext`、`label`、`url`。
- `browser_extension` — `action` 为 `install`/`uninstall`/`list`，配 `path`（解包目录或 XPI）、`extensionId`、`permanent`（Firefox 138+ 才支持永久安装；更早版本默认临时安装）。
- `browser_cookie` — `action` 为 `get`/`set`；`filter` 如 `{"domain":"example.com"}`，`cookie` 如 `{"name":"sid","value":"x"}`。能读写 HttpOnly cookie（Firefox 124+）。
- `browser_intercept` — `action` 为 `block`/`clear`，`patterns` 是 URL 子串数组。命中后请求被插件拦下再放行，页面不会卡死。
- `browser_detectability` — 只读，实测本会话有多容易被检测。

## 验证码

- `browser_captcha` — `solver` 缺省 `auto`（自动识别再选对应解法）；`sttUrl`（Whisper 兼容的语音转写端点）、`visionUrl`（图像识别端点）、`timeoutMs`（默认 60000）。
- `browser_captcha_status` — `kind` 必填（`turnstile`/`recaptcha`/`hcaptcha`/`geetest`/`pow`/`spin`），只读不点。

## 错误契约

失败时结果里同时有两个字段：`code` 是机器可读的固定词表，`error` 是给人看的原话。
分支逻辑请用 `code`，给用户的解释请用 `error`。

| code                     | 含义                                     |
| ------------------------ | ---------------------------------------- |
| `not_running`            | 浏览器没起来                             |
| `no_context`             | 没有可用的标签页                         |
| `element_not_found`      | 选择器/ref 没匹配到任何东西              |
| `element_not_actionable` | 元素在，但用不了（隐藏、禁用、类型不对） |
| `ref_stale`              | 元素引用已过期，重新 `browser_snapshot`  |
| `frame_gone`             | 目标 iframe 已经不在了                   |
| `capability_unavailable` | 这版 Firefox 不支持该能力                |
| `confirm_required`       | 不可逆动作被拦下，需要 `confirm: true`   |
| `invalid_argument`       | 参数不合法（包括历史到头）               |
| `timeout`                | 等待超时                                 |
| `network_error`          | 请求本身失败                             |
| `path_not_allowed`       | 文件路径不在允许的目录里                 |
| `unknown_tool`           | MCP 层被要求调用一个不存在的工具         |
| `internal`               | 插件内部错误                             |

`hint` 字段会说明下一步该做什么。
