# Changelog

All notable changes to the `firefox-browser` plugin are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/), and
versions follow `MAJOR.MINOR.PATCH`.

## v2.9.0 — 2026-11-10

把**降级路径**从"考古才能走通"变成"一条命令"，并把每次调用的 token 成本砍掉一半。

宿主不注入插件工具时，`tools/ff-call.mjs` 是唯一的入口。v2.8.0 把这个入口
做出来了，但用起来还有三处硌手，这一版把它们一次清掉。

### Added

- **守护进程模式** —— `ff-call.mjs --serve` 起一个**脱离会话**的服务，
  `--stop` 停掉它。
  - 服务端新增 `FIREFOX_BROWSER_DAEMON=1`：daemon 模式**不挂 stdin 读循环**
    （stdio 传输把 EOF 当作"客户端走了"，对 daemon 是致命的），控制 socket
    成为它唯一的传输通道。
  - 拉起时 `detached: true`、`stdio: ['ignore', 日志, 日志]`，因此**调用方的
    shell 退出、进程组收到 SIGTERM、stdin 关闭都不会带走它**。日志落在
    `<插件数据目录>/server.log`。
  - **`shutdown` method**（MCP 生命周期里的那个）现在可用：从 socket 发起，
    服务端先回 `{ok:true}`，再走自己的清理路径（关 socket、停浏览器、删 socket
    文件）。`--stop` 优先走它，pid 文件只是兜底——pid 会过期，请求不会。
- **自动拉起** —— 调用工具时若没有服务在跑，**自动**起一个守护进程再调用，
  同一个 Firefox 跨调用复用。`--no-autostart` 可关。
  - 零前置：`node tools/ff-call.mjs browser_status '{}'` 开箱即用。
  - 拉起用 `O_EXCL` 锁文件串行化；锁超过 60 秒视为陈旧并接管。
- **`browser_status` 的 `detail` 参数** —— `summary`（默认）给
  `features` 布尔表 + `unavailable`（不可用项的 `reason`/`source`）+
  `knownRisks`；`full` 给完整的 `featureDetails`。
- **`ff-call.mjs` 的输出开关** —— `--text`（只给摘要行）、`--raw`（给完整
  MCP 结果）、`--pretty`（缩进）。
- **单实例保护** —— server 启动时若发现控制 socket **已被活的服务持有**，
  不再 unlink 抢占：stdio 模式下放弃开 socket，daemon 模式下退出码 3
  让位。BiDi 只允许一个活跃会话，两个 server 就意味着两个 Firefox。

### Changed

- **`ff-call.mjs` 默认只输出 `structuredContent`**（紧凑 JSON）——
  **这是 CLI 的破坏性变更**：旧格式把回复的 text 块和结构化载荷并排打印，
  而 12 个 legacy 工具的 text 块**就是**同一份载荷的 pretty JSON，等于同一
  份数据打两遍（实测 `browser_text` 3.7 KB 正文 → 15 KB 输出）。
  - 迁移：依赖旧 stdout 里 `.text` 字段的脚本改用 `--text`；需要完整协议形状
    的用 `--raw`。
- **`browser_status` 默认 payload 精简** —— `capabilities.featureDetails`
  （每个 feature 一条 `{available, source, reason}`）不再默认返回，只有
  不可用的那些以 `unavailable` 形式保留原因。**这是宿主可见的契约变更**：
  解析 `featureDetails` 的调用方改用 `detail: "full"`。
  - 可信度标记（`probed` / `knownRisks`）两个模式都保留——"这是实探还是按
    版本推断"不能被裁掉。

### Fixed

- **daemon 不再因 stdin 关闭而自杀**（`shutting down (stdin closed)`）。
- **一次性 `--spawn` 不再占用共享 socket**：它只说 stdio 上的 MCP，不与
  长驻服务抢同一个 socket，也就不会拉起第二个 Firefox。
- **`--doctor` 报告 daemon 状态**（pid 文件、日志路径），并给出"下一次该
  做什么"的正确建议（"没有 socket → 一次调用就会把它起起来"）。

## v2.8.0 — 2026-11-10

把"AI 用不顺手"的三类障碍一次扫掉：接入、可观测、可配置。

### Added

- **`browser_net_check`** —— 页面打不开时的一次性体检。同一条报错可能来自四种完全
  不同的原因（解析器坏、本机不通、**浏览器进程出不了网**、站点挂了），猜错就是白烧
  一轮。它同时取两个样本：**本机**能不能解析并连通、**浏览器**能不能加载，两者的差
  就是诊断。
  - `diagnosis` 取值：`ok` / `dns_broken` / `firefox_egress_blocked` /
    `host_egress_blocked` / `inconclusive`。**这是给人分支用的固定词表**。
  - 探针页用完即关（失败路径也关），不留残留标签页；只取导航是否提交，不读页面
    内容，因此不受页面注入告警影响。
  - `browser_status` 会复述上一次的结论（`net.lastCheck`），不必重复体检。
- **`browser_egress`** —— 可选的本地出口代理（**默认关**）。有些环境允许进程连
  回环、却不允许连外网：浏览器进程被网络挡住，而本机没有。代理监听 `127.0.0.1`
  ——那是浏览器还够得着的唯一出口——并自己解析域名、自己开连接。
  - **不做 TLS 中间人**：HTTPS 走 CONNECT 隧道，端到端 TLS 仍在浏览器与站点之间。
  - **只连 80/443**，并且**按解析出来的地址**判定私网——指向内网的名字同样进不来。
  - 解析优先走系统解析器，失败再走 DoH（按字面 IP 直连，不依赖系统 DNS）。
  - 连接记审计，但只记主机、端口与字节数，不留请求/响应内容。
- **`browser_restart`** —— 重启 Firefox。写进 profile 副本的首选项**重启后才生效**，
  这个工具让它们立刻起作用，agent 不必再去重启 MCP 服务。
- **运行时首选项** —— `browser_config` 新增 `prefs` / `applyNow` / `timeoutMs` /
  `restart`。首选项**只写 profile 副本**，用户真实 profile 永不被改；名字走白名单
  校验，值只收字符串/数字/布尔。
  - 两条生效路径：**写副本**（默认，下次启动生效）与**立即生效**（`applyNow`，走特权
    上下文，需要宿主以 `FIREFOX_BROWSER_PRIVILEGED=1` 启动）。没有特权时**不报错**，
    降级为写副本 + 重启生效。
  - `timeoutMs` **立即生效**（30 秒写死的超时从此可改）。
- **控制通道（降级入口）** —— `FIREFOX_BROWSER_CONTROL_SOCKET=1` 时，服务在插件数据
  目录开一个 `control.sock`（0600），与宿主走**同一个 provider**：同一个 Firefox、
  同一批标签页。配套 `tools/ff-call.mjs` 让 shell 直接调用工具，
  `tools/ff-call.mjs --doctor` 一次性说清"哪里能用、哪里不能用"。
  - 这条路是为**宿主没把工具注入会话**准备的：插件跑得好好的，只是没人接。
- **宿主兼容性自检** —— `tools/validate-package.mjs` 现在会核对宿主的工具登记表
  与插件代码是否一致，并**点名**双方各自多出/缺少哪些工具。

### Changed

- **网络类报错会指向体检** —— `NS_ERROR_UNKNOWN_HOST`、连接被拒、超时的 `hint`
  现在直接说"跑 `browser_net_check`"，而不是只把 Firefox 的原话转述一遍。
- **preset 成员** —— 新增能力 `egress`（`developer` 与 `all` 可见；`slim` 与
  `basic` 不带它，因为代理是修复路径，不是日常路径）。
  `browser_net_check` 与 `browser_restart` 归 `core`，**所有 preset 都能用**。
- **注入体积预算** —— 三个新工具的 JSON Schema 是**结构**成本，省不掉；文案成本
  按仓库的老办法自己买单：被乘 28 / 10 / 8 次的共享描述（`contextId` / `confirm` /
  `ref`）缩短，约二十处一次性属性描述去掉赘词与例子。预算因此从 34000 调到
  36000 字节（实测 35602），并把这一轮写进了测试注释里。

### Fixed

- **profile 副本的 `user.js` 会被每次启动覆盖** —— 于是运行时写的首选项在下次启动
  时会消失。现在它们记在插件内存里，**每次拷贝之后重新写回副本**，并且
  `user.js` 里插件自己的那一段是**托管区块**：重复写会替换而不是堆积。

以下四条是**实机跑出来的**（在真实 Firefox 上过一遍 `browser_net_check` /
`browser_config` / `browser_egress` / `browser_restart`），不是推测：

- **浏览器加载失败会被误报成"页面正常"** —— Firefox 提交自己的错误页时，
  `location.href` 仍然是**请求的那个 URL**，所以只看 URL 的话，探针会把
  `about:neterror` 当成一次成功加载。判定改成看
  `document.documentURI`（Firefox 140 是 `about:neterror?e=dnsNotFound&u=…`）
  与 body 的 `neterror` class。症状是：一个根本不存在的域名，
  `browser_net_check` 报 `ok`。
- **浏览器自己的解析器失败时，诊断会说成"浏览器出不了网"** —— 现在浏览器报出
  DNS 类错误码（`dnsNotFound` / `NS_ERROR_UNKNOWN_HOST`）时，结论是
  `dns_broken` 而不是 `firefox_egress_blocked`：这是解析问题，而代理正是解药。
- **`browser_config` 的 hint 会说谎** —— 只写副本（默认路径）时，它却说
  "已应用到运行中的浏览器"。Firefox 启动时才读 `user.js`，所以没 `applyNow`
  就**必须重启才生效**。hint 现在分三种情况说清楚。
- **`browser_egress stop` 会挂死** —— `server.close()` 要等所有连接自己结束，
  而浏览器把 keep-alive 连接握在手里，于是这个调用永远不返回（实测卡到
  120 秒超时）。现在连接按"接入时"就被记录，停止时直接掐掉；实测从"卡死"
  变成 **27 毫秒**。
- **`ff-call.mjs` 打印完结果不退出** —— 打开的控制 socket 让 Node 的事件循环
  一直活着，脚本会挂在那里不结束（能拿到输出，但没法用在脚本里）。
  现在用完就关连接，命令正常返回。

## v2.7.0 — 2026-11-10

新增 `browser_find`，并把 preset 的成员判定从"手写工具名名单"改成"按能力计算"。

### Added

- **`browser_find`** —— 在页面上搜一段文字，拿**位置**。`text` 必填（子串匹配，
  不区分大小写；**不支持正则**——工具目录每轮都进上下文，多一种模式就要多付
  一次钱，而少数搜索才需要它）。
  - 结果**分开报**：`elements` 是能点的元素（带 `ref`），`texts` 是正文里的段落
    （**没有 ref，别去点它**）。混在一起报，agent 就会去点一个段落。
  - 每个元素命中带**前后邻居**（`before` / `after`，各带 `ref` / `role` / `name`）。
    上游用"缩进树的路径"表达同一个问题——这东西在页面的哪个位置——但本地快照
    是**扁平列表、没有父子层级**，没有路径可显示；邻居就是扁平结构下的等价答案。
  - 找不到是**成功的搜索**：`ok: true`、`total: 0`。

### Changed

- **preset 的成员按能力计算**（`lib/firefox/tool-capabilities.js`）—— 以前每个
  preset 是一份**手写的工具名名单**，要靠一个测试跟目录保持同步；那份名单漂移过
  一次，"all" 档悄悄少了六个工具，agent 要了全部却拿到子集，还完全不知道。
  现在每个工具在**自己的定义旁边**声明所属能力，preset 由这些声明算出——
  目录只有一份清单，没有第二份会漂移的副本。
  - 能力分组：`core`（日常主循环）/ `input`（精细输入与标签页）/ `logs` /
    `assert`（`browser_verify` 与 `browser_find`）/ `cookie` / `firefox`（容器、
    扩展、拦截、可检测性）/ `captcha`。`slim` = `core`；`basic` 再加 `input`、
    `logs`、`assert`、`cookie`；`developer` 与 `all` 再加其余。
  - **preset 成员与顺序完全不变**（slim 仍是 22 个工具，成员逐项一致）。
  - 能力标签**不进 wire payload**，不占上下文预算。

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
