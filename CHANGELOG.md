# Changelog

All notable changes to the `firefox-browser` plugin are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/), and
versions follow `MAJOR.MINOR.PATCH`.

## v2.6.0 — 2026-11-10

动作响应自带精简元素列表、新增 `browser_verify` 断言工具。
从 `microsoft/playwright-mcp` 的会话契约层提炼的两项能力。

### Added

- **动作响应内联快照** —— `browser_click` / `browser_type` / `browser_press_key` /
  `browser_select_option` / `browser_check` / `browser_hover` / `browser_scroll` /
  `browser_upload` 的响应现在带 `effect.snapshot`：动作**之后**页面上的元素，
  每条只有 `ref` / `role` / `name`，最多 60 条。动作改变页面之后，Agent 的下一个
  问题几乎总是"现在长什么样"——以前要再发一次 `browser_snapshot`，现在一次往返
  就同时拿到"动作生效没有"（`effect.verified`）和"页面现在什么样"。
  - 它是**轻量且只读**的：不递增快照序号、不覆盖 `since`/`delta` 的基准、
    不产出 `snapshotId`、不带 `rect` / `value`（凭据的值本来就不出页面）。
  - 页面拒绝脚本执行时**动作仍然成功**，失败原因放在 `effect.snapshotError`。
  - 用 `browser_config({inlineSnapshot: false})` 关掉（会话级）。
- **`browser_verify` 断言工具** —— `kind` 取 `element` / `text` / `value` / `list`，
  返回结论而不是原始数据。`ok` 表示断言**能不能跑**，`verified` 表示断言**成不成立**——
  两者分开，Agent 才能区分"断言失败"和"工具出错"。
  - 凭据字段（密码、验证码、卡号）返回 `code: "redacted_value"`：那些字段的真值
    **从来没有离开过页面**，插件手里没有可比对的东西，所以拒绝比对而不是给一个
    假的空值。
  - `kind: "text"` 依次查快照的块级文本块、元素无障碍名、整页可见文本——所以把
    文字放在 `<div>` 里的页面也断言得到。
  - `kind: "element"` 只能在交互元素里找（快照候选集只含交互元素与显式 `role`
    的元素），纯文本段落断言不到——这是既有快照语义的限制。

### Changed

- **工具目录瘦身**：共享的 `CONTEXT_SCHEMA` / `REF_SCHEMA` 描述收短，
  输出 schema 里的 `code` 属性不再带描述（"Failure code when ok is false."
  原本在每个工具里重复一遍）。这两项为新功能腾出空间——工具 payload 从
  33879 字节（预算 34000，余量只有 121 字节）降到 33167 字节。

## v2.5.0 — 2026-11-10

提示词注入防护（分层）、两个既有缺陷修复、工具目录按 preset 裁剪。
工具名、参数名、参数类型和顺序**全部不变**，只新增了可选参数。

### Fixed

- **`browser_text` 与 `browser_evaluate` 未经过脱敏层** —— 插件对 cookie 值、
  console 日志、快照输入框值、响应体做了严格脱敏，但页面正文和 evaluate
  的返回值是原样进上下文的：JWT、`Bearer` 令牌会直接出现在 Agent 看到的内容里。
  现在这两条通道（以及快照的可见文本块）共用 `lib/firefox/redact.js`。
  `README.md` 里"所有通道都脱敏"的陈述此前并不成立，现已对齐实现。
- **`browser_evaluate` 吞掉页面异常** —— 页面表达式抛异常、语法错误、引用
  未定义变量，三种情况都返回 `ok: true` 且没有 `value`。BiDi 把页面异常
  作为**正常响应**返回（`type: "exception"`），不走 error envelope，所以
  client 不会 reject，`unwrapRemoteValue` 再落到 default 分支变成
  `undefined` —— 与"表达式确实返回了 undefined"无法区分。现在返回
  `code: "evaluate_failed"` 并带页面侧的异常文本。

### Added

- **可见性事实层**（`lib/firefox/visibility.js`）—— 页面侧计算渲染事实：
  离屏、白底白字、1px 字号、`opacity:0`、clip、透明色。**不删除任何内容**。
  实测证明删除会误伤真实站点：离屏抽屉菜单、hover 显现面板、sr-only 无障碍
  标签都会被判定为"隐藏"。折叠区以下的内容**不算**隐藏 —— 人能滚动看到。
- **指令样检测层**（`lib/firefox/injection.js`）—— 高精度的指令句式匹配
  （重置指令、角色重设、系统提示伪装、越权请求、保密要求）与编码载荷检测。
  延续既有原则：不做通用高熵检测，不做语义分类。
- **信任层**（`lib/firefox/provenance.js`）—— 页面内容返回 `source`
  （只给 origin）、`signals`（未达告警阈值的信号）、`warnings`（达到阈值的
  告警）。告警需要**两个独立条件同时成立**：渲染事实 ∧ 指令句式。单独命中
  任一项不告警，否则真实站点的抽屉菜单会产生大量噪音。
- **硬阻断**（`lib/firefox/injection-gate.js`）—— 页面存在 high 级告警时，
  数据外行动作（表单提交、账号变更、上传、下载、写 cookie、装扩展）被拒绝，
  返回 `code: "injection_blocked"`。**这个阻断不会被 `confirm: true` 解除** ——
  那个参数是 Agent 自己提供的，被劫持的 Agent 可以自己补上；解除只能由用户
  通过 `FIREFOX_BROWSER_INJECTION_GATE=off` 完成。读取永远不受限。
- **工具目录按 preset 裁剪** —— `tools/list` 现在按当前 preset 返回子集，
  切换 preset 后发送 `notifications/tools/list_changed`（宿主已验证会响应
  并重新拉取）。`browser_config` 永远在列表中，被裁掉的工具通过
  `browser_config({preset: "all"})` 恢复。默认 preset 保持 `basic`。
- **快照增量** —— `browser_snapshot` 新增可选参数 `since`，在上次快照的基础上
  附加一个 `delta` 字段（新增 / 变化 / 消失）。全量快照仍是默认，位置变化
  不算变化（滚动会改所有元素的 rect）。

### Environment

| 变量                             | 默认     | 含义                                         |
| -------------------------------- | -------- | -------------------------------------------- |
| `FIREFOX_BROWSER_INJECTION_GATE` | `strict` | `strict` / `off`。硬阻断开关；Agent 无法读写 |

### Changed

- `browser_evaluate` 的返回值现在有上限（默认 8KB），超限时返回
  `truncated: true`。此前页面可以一次把 1MB 灌进上下文。

### Known limitations

- 页面脚本与插件的快照脚本运行在**同一个 realm**里。一个刻意对抗检测的页面
  可以覆写 `window.getComputedStyle` 让一切看起来可见，从而绕开可见性事实层。
  这需要页面主动对抗，而不是"顺手藏一段文字"，因此不在本期范围内 ——
  Firefox 的 BiDi 目前没有隔离世界（isolated world）可用。
- `browser_evaluate` 在带 high 级告警的页面上只需要 `confirm: true`，而
  `confirm: true` 由 Agent 自己提供。硬阻断覆盖的是显式的数据外发动作
  （表单提交、上传、下载、写 cookie、装扩展），但一个被劫持的 Agent 理论上
  仍可以用 `evaluate` 发起 `fetch`。取舍是：把 evaluate 一并硬阻断会让
  Agent 连"读出注入内容转告用户"都做不到，防御变成自伤。

## v2.4.0 — 2026-11-10

安全性加固：修复三个已验证的漏洞，并补上四处纵深防御。**工具名、参数名、参数类型
和顺序全部不变**，只新增了可选参数。

### Fixed

- **`browser_run_script` 的路径边界可被符号链接绕过** —— 检查用的是 `resolve()`，
  它只规范化字符串、不碰文件系统，所以工作区里一个指向 `/etc/passwd` 的软链能通过
  前缀比较，随后 `readFileSync` 跟着软链读了目标。现在**两侧都过 `realpathSync`**
  再比较：工作区里的软链指向外部会被拒；工作区**本身**是软链仍然可用。
  拒绝时不回显解析出的真实路径——那等于给攻击者一个探测探针。
- **凭据出站通道未脱敏** —— 插件对网络 URL 做了严格脱敏（剥 query，因为 token 常在
  那里），但 cookie 值、页面 console 日志、快照里的输入框值、响应体都是原样进上下文。
  一个 `type=text` 的二次验证码框过去会被写进快照。现在所有通道共用
  `lib/firefox/redact.js`：cookie 值变成 `<redacted:len=N>`，敏感字段值变成
  `<redacted>` 并带 `valueRedacted:true`，日志和响应体里明确的 secret 形态被就地替换。
  `revealValues` / `revealBody` 是显式逃生口。
- **确认闸门可被绕过** —— 在表单输入框里按 Enter、改 `<select>`、切 radio，在标准
  HTML 里都会提交表单，但这三条路径完全不过闸门：Agent 被 `click` 拦下，改按回车
  就行。现在新增 `classifyImplicitSubmit`，按 DOM 事实（提交控件 / POST 表单 /
  表单里有提交控件）判定，三个动作和 `browser_batch` 的对应步骤行为一致。
  `press_key` 探测不到焦点时**保守拒绝**，因为无法证明安全。

### Added

- **导航策略** —— 浏览器带的是用户真实登录态，所以默认不导航到字面私网/环回地址
  （`127.0.0.1`、`localhost`、`10.x`、`192.168.x`）或 `file:` / `data:` /
  `javascript:`。返回 `code: "navigation_blocked"`。不做 DNS 解析（会引入 TOCTOU
  与延迟），所以域名解析到私网的情况**不在此列**。
- **动作审计** —— 每次工具调用写一条 JSONL 到插件数据目录的 `audit/<日期>.jsonl`：
  做了什么、点了哪个控件、是否被拦。**不记录输入文本和 cookie 值。**
  `browser_status` 报审计路径与会话计数。
- **profile 副本生命周期** —— 副本不再永不过期：默认 24 小时（`FIREFOX_BROWSER_PROFILE_TTL_HOURS`）
  后重建。副本内的凭据文件显式设为 `0600`（此前沿用源文件权限，`cookies.sqlite` 是
  `0644`）。当前基目录下属于其他源 profile 的残留副本会被清理。
- **截图 URL 过期** —— 截图 URL 要写进回复，会进对话记录。现在 1 小时后失效
  （`FIREFOX_BROWSER_IMAGE_TTL_MS`），过期和不存在都回 404——响应不可区分。

### Changed

- **工具目录 33380 → 33595 字节**（+215）。新增五个可选参数（两个 reveal 标志、
  三个 `confirm`）。共享的 `confirm` 参数描述被缩短来抵消大部分增量——它在注入的
  目录里出现 9 次。
- `REFERENCE.md` 的错误码表检测从"子串包含"升级为逐行匹配，防止表格行被截断
  （`capability_unavailable` 曾被写成 `ability_unavailable` 却仍能通过测试）。

### Environment

| 变量                                  | 默认      | 含义                                   |
| ------------------------------------- | --------- | -------------------------------------- |
| `FIREFOX_BROWSER_PROFILE_TTL_HOURS`   | `24`      | profile 副本 TTL（小时）；`0` = 不过期 |
| `FIREFOX_BROWSER_NAVIGATION_POLICY`   | `strict`  | `strict` / `permissive`                |
| `FIREFOX_BROWSER_ALLOW_PRIVATE_HOSTS` | `0`       | `1` = 允许私网/环回 host               |
| `FIREFOX_BROWSER_IMAGE_TTL_MS`        | `3600000` | 截图 token TTL；`0` = 不过期           |
| `FIREFOX_BROWSER_AUDIT`               | `1`       | `0` = 关闭动作审计                     |

## v2.3.0 — 2026-11-09

内部优化为主：文件结构、错误契约、上下文占用、能力暴露面、性能。

### Added

- **`browser_back` / `browser_forward`** —— `browsingContext.traverseHistory`
  （FF 122+）。此前协议层已有封装但没有任何工具调用它。
- **`browser_reload`** —— `browsingContext.reload`（FF 119+）。
- **`browser_set_viewport`** —— `browsingContext.setViewport`（FF 117+），
  可设置视口宽高与 `devicePixelRatio`。改视口是不可逆动作，纳入确认闸门，
  需要 `confirm: true`。
- **机器可读的错误码** —— 失败结果新增 `code` 字段（如 `element_not_found`、
  `ref_stale`、`capability_unavailable`、`confirm_required`），Agent 不再需要
  匹配英文错误文本。`error` 字段保持人类可读，既有调用方不受影响。
- **工程基建** —— ESLint 9 flat config、Prettier、GitHub Actions CI
  （Node 22 / 24 矩阵）、Keep a Changelog 格式的本文件、`test:unit` /
  `test:integration` / `test:coverage` / `lint` / `format` 分段脚本。

### Changed

- **错误契约统一** —— provider 的失败返回统一经 `fail(code, message, extra)`
  构造，保留 `hint` / `feature` / `required` / `detected` / `requiresResnapshot`
  等既有字段。
- **文件结构拆分** —— `provider.js`（3457 行）按资源拆为 `lib/firefox/provider/`
  下的 session / tabs / action / inspect / diagnostic / firefox / captcha
  模块（拆分后 316 行，最大模块 555 行）；`server.js` 的 1127 行 TOOLS 数组
  外提为 `lib/mcp/tools/`（拆分后 526 行）。拆分阶段对外工具名、描述、schema
  与顺序**逐字节不变**；随后的 schema 瘦身只改了描述文字，工具名、参数、
  类型与顺序未动。
- **工具 schema 瘦身** —— 工具目录每轮对话都要注入上下文，因此按实测的
  `tools/list` 载荷计算：38 个工具 **44128 → 33380 字节**（-24%），
  平均每个工具 1161 → 879 字节。做法是：工具描述压到一句话、共享 schema
  片段缩短、输出 schema 的属性描述改为可选（类型不动，那才是宿主校验的
  契约）。参数语义细节迁到按需加载的 `skills/firefox-browser/REFERENCE.md`。
  原计划中的 18000 字节目标在"不裁工具"的前提下不可达：38 个工具、
  122 个输入参数、每个工具都声明 output schema，光 JSON 结构就有约 20000
  字节。测试锁定的预算是实际达成的 34000 字节，而不是一个需要删工具才能
  达到的数字。

### Fixed

- **弹窗结算不再空等 250ms** —— `_settleDialogs()` 改为事件驱动：动作开始前
  记下弹窗计数（epoch），动作结束后对比——计数变了说明动作期间弹过窗，只等
  自动处理器收尾；没变说明事件还没到或根本不会来，只等一个短兜底窗口
  （默认 40ms，可用 `FIREFOX_BROWSER_DIALOG_SETTLE_MS` 调整）。
  实测 Firefox 140 上 5 次无弹窗点击，均值 **272.8ms → 66.6ms**
  （稳定态 49–52ms）。触发弹窗的点击仍在同一个结果里回报 `effect.dialog`，
  耗时 106ms。
- **迟到弹窗不再漏报** —— 旧实现在弹窗迟到 300ms 时会漏掉它（要到下一个动作
  才补报），新实现不再依赖固定 250ms 窗口。
- **启动失败重试不再阻塞事件循环** —— 启动重试路径原本调用同步的
  `_killProcess`，它用 `sleepSync(100)` 忙等最多 3 秒，期间整个事件循环
  （含 BiDi 客户端）全部卡住。现改为 `await _killProcessAndWait`，
  等待时长不变但不阻塞。`sleepSync` 现在只剩 `killNow()` 一处调用，
  即 `process.on('exit')` 处理器——那里已经没有时间 await 了。
- **`downloadEvents` 能力门槛修正** —— 文档标注 FF 133，但 Firefox 实际在
  **FF 144** 才实现 `downloadWillBegin`、**FF 145** 才实现 `downloadEnd`
  （FF 140 上该事件名会被直接拒绝）。门槛已拆分修正。

### Notes

- 插件**仍然零运行时 npm 依赖**；eslint 与 prettier 仅为 devDependency。
- 能力门槛以本机实测（Firefox 140.11.0esr）为准，而非文档假设。
- 新工具一律**追加到工具列表末尾**：宿主把工具列表当作每轮请求的前缀，
  追加能保住既有 34 项的缓存前缀；插到中间会让其后全部失效。
- `FIREFOX_BROWSER_TOOLSET=core`（按任务裁剪工具集）本轮**未实现**。
  裁工具集是压缩上下文的最大杠杆（可省 55%），但会让部分工具对 Agent
  不可见，属于产品决策，留待后续单独评估。

## v2.2.0

Baidu 的旋转验证码求解器成为一等公民。

## v2.0.0

重写：能力矩阵按运行中的 Firefox 实探、ref 注册表不写入 DOM、确认闸门、
诚实的 effect 报告、网络诊断。
