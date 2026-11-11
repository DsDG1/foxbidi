# foxbidi 插件测试报告（v2.9.2 → v2.9.3）

- **被测对象**：`foxbidi` v2.9.2 → **v2.9.3**（MCP server，通过 WebDriver BiDi 驱动真实 Firefox），43 个 MCP 工具（默认 `basic` 预设暴露 36 个），~11.6k 行代码
- **源码**：`/home/corvel/src/firefox-browser`　**宿主包**：`/home/corvel/.minimax/plugins/firefox-browser`
- **测试机**：Firefox 140.11.0esr、Node v24.19.0、Linux x86_64
- **测试日期**：2026-11-11
- **测试方式**：自动化测试套件 + 真实 Firefox 端到端实测（受控夹具 + 公共站点）+ **宿主原生 MCP 路径验收**

> 前一轮（v2.9.1 → v2.9.2）的报告没有留在仓库里——git 历史中唯一一份报告是 `docs/host-integration-report.md`（宿主侧问题报告，v2.8.0），后来在"docs: 文档修改"里被删掉了。本轮把那一轮找到的 **9 条缺陷**全部修掉，并在修的过程中又发现了 **3 条新缺陷**（其中 1 条是宿主级高危）。

---

## 一、总体结论

**这一版修的全是同一类故障：插件把"我卡住了"说成了别的样子。**

会话被卡住、导航没落地、弹窗挡着页面——这三件事在插件的旧版本里分别报成 `timeout`、报成 `ok: true`、报成 `timeout`。Agent 拿着这些回答只能瞎试：重试、干等、换工具。修复之后，这三件事各自有了**专属的错误码**和**唯一正确的下一步**，而且这三条路都在真实 Firefox 上端到端验过。

最关键的一条：**恢复手段现在不牺牲用户正在看的东西**。`browser_restart {scope:"session"}` 只换掉卡住的 BiDi 会话，**Firefox 进程、标签页、当前页面、登录态全部保留**——实测 pid 与 contextId 前后一致。

另外发现并修掉了一条**宿主级高危**：output schema 把标量数组约束成 object，导致一批工具被宿主**用自己的 schema 拒绝自己的载荷**，整次调用变成 `-32602`，Agent 连结果都看不到。

| 级别 | 数量 | 说明                                                                                         |
| ---- | ---- | -------------------------------------------------------------------------------------------- |
| 高   | 3    | 会话卡死后导航全废；导航假成功；output schema 拒掉标量数组（宿主级）                         |
| 中   | 4    | restart 后 context 残留；manual 弹窗下动作必然超时且无提示；hint 优先级错；同 URL 再导航误报 |
| 低   | 5    | 诊断误报；错误码不一致；`npm run contract` 本地必失败；batch 参数无文档；run_script 相对路径 |

**全部已修**，修法与验证见下。

---

## 二、门禁结果

发布门禁（版本号 2.9.3）：

| 项目                     | 命令                                   | 结果                                                               |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------------ |
| 单元测试                 | `npm run test:unit`                    | **918 tests / 164 suites / 918 pass / 0 fail**（4.2s）             |
| 集成测试（真实 Firefox） | `npm run test:integration`             | **154 tests / 19 suites / 152 pass / 0 fail / 2 skipped**（39.5s） |
| 覆盖率                   | `npm run test:coverage`                | 行 **83.51%**、分支 **75.26%**、函数 **79.04%**                    |
| ESLint                   | `npx eslint .`                         | **0 error / 0 warning**（v2.9.2 有 13 条 warning）                 |
| Prettier                 | `npm run format:check`                 | 全部通过                                                           |
| 包校验                   | `npm run validate`                     | 通过，`✓ host registry: in step (36 tools)`                        |
| 宿主契约                 | `npm run contract`（`--package` 模式） | 通过：**185 文件 / 201 条目 / 1.87 MB**                            |

2 个跳过项为 Turnstile 集成测试，原因是**环境未下发挑战**（`the challenge provider did not deliver a challenge to this client`），属环境限制而非缺陷。

单元测试比 v2.9.2 增加了 **92 个**（826 → 918），集成测试增加 **3 个**（151 → 154）。

---

## 三、缺陷清单与修法

### 【高】1. 会话一旦卡住，本会话的 `browser_navigate` 全废

**根因**：Firefox 的 BiDi 命令是**串行**的。一条永远不返回的命令占着队列，后面的全在排队——表现上只有导航失效，快照/评估/点击照常工作，极易被误判成"网站慢"。

**实测复现（隔离路径，真实 Firefox）**：

```
browser_start                              → ok
browser_navigate https://example.com        → ok, landedUrl: https://example.com/
browser_context create {label:"probe3"}    → ok
browser_navigate https://example.com        → ok:false, code:"timeout"（30s 超时）
browser_navigate https://example.com        → ok:false, code:"timeout"（再 30s）
browser_navigate https://example.org        → ok:false, code:"timeout"（第三个 URL 也超时）
```

**关键事实（实测得出，和原先的假设不同）**：楔死之后 `browser_evaluate` 与 `browser_snapshot` **照常可用**——会话本身没死，**死的是 Firefox 侧的导航**：请求挂起不返回，后续导航排在它后面（连请求都没发起）。

**修法**：

1. **可放弃的命令**（`lib/bidi/client.js`）：新增 `sendAbandonable()`——放弃即 resolve、清定时器、删 pending 条目，**串行队列立刻放行**；迟到响应由既有 `_dispatch` 丢弃。`send()` / `sendUnqueued()` 语义一字未动。
2. **会话级恢复**（`provider.restart({scope:'session'})`）：`stop({kill:false, keepEgress:true})` + `start()`——**不杀 Firefox、不动标签页**，只把 BiDi 会话换掉。默认的 `browser` 范围保持原行为。
3. **卡死判定**（`_classifyCommandFailure`）：命令超时**且**绕开队列的探活也超时 → `session_stuck`；探活还活着 → 仍是 `timeout`。

**实测恢复**：

```
browser_restart {scope:"session"}  → scope:"session", browserKept:true,
                                     pid 1046326（前后不变）, sessionId 已换新
browser_navigate https://example.com → ok, navigated:true
```

### 【高】2. `browser_navigate` 假成功：返回 `ok:true` 但浏览器并未导航

成功分支直接回填**请求的** URL，不校验浏览器是否真的落地。

**修法**：返回体新增 `landedUrl`（标签页现在真的在的地址）、`navigated`（这次导航有没有生效）、`pending`（`wait:"none"` 时页面还在路上）。`url` 的语义**不变**（仍是请求的地址），跨源重定向因此仍然合法。

**实测**：`browser_navigate https://example.com` → `{ok:true, url:"https://example.com", landedUrl:"https://example.com/", navigated:true}`。

### 【高】3. output schema 拒掉标量数组（宿主级）

`outputSchema()` 以前给**每个**数组属性默认塞 `items:{type:'object'}`。而一批工具返回的是**字符串数组**：`browser_config` 的 `effectiveTools` / `notes`、`browser_detectability` 的 `notes`、`browser_captcha` 的 `detected`、`browser_intercept` 的 `patterns`、`browser_find` 与 `browser_snapshot` 的 `texts`。

宿主拿工具**自己声明的 schema** 去校验工具**自己的载荷**，于是这些工具的载荷被拒——整次调用变成 `-32602`，Agent 连结果都看不到（宿主实测报 `data/effectiveTools/0 must be object` … `/42 must be object`）。

**修法**：默认**不约束**数组元素类型（JSON Schema 里缺 `items` 即"任意元素"），确为字符串数组的显式声明 `items:{type:"string"}`。

**新增 `test/output-schema.test.js`（52 个用例）**把这条规则钉死：内置一个 JSON-Schema 子集校验器，对**每个**工具跑一个代表性载荷，再对 7 个"真实载荷"（从实际响应里抄的）逐个校验，并断言**没有任何 output schema 把数组约束成 object**。

### 【中】4. `browser_restart` 之后 `_lastContextId` 未重置

`restart` 路径没清 `_lastContextId`，重启后不带 `contextId` 的调用会报 `no_context`。

**修法**：`stop()` 清掉记录的 context 并置 `_contextsStale`；`_resolveContext()` 在标记为陈旧时拿标签页列表校验一次，失效就回退到第一个可用标签页。

### 【中】5. `dialogPolicy:"manual"` 下触发弹窗的点击必然 30 秒超时，且没有任何提示

弹窗挡着页面时，Firefox 拒绝执行脚本、拒绝接受输入，开弹窗的那条命令永远不回来——而 `manual` 策略下没人关它。

**修法**：弹窗一开就**放弃**那条命令（队列立刻放行，迟到响应丢弃）并返回 `code:"dialog_open"`；动作开头还有一道检查——**页面被挡着的时候，不会再有任何命令被发出去**。

**宿主原生路径实测**：

```
browser_config {dialogPolicy:"manual"}   → ok
browser_click {ref:"e1"}（页面弹 alert）  → ok:false, code:"dialog_open", blocked:true,
                                            requiresDialogHandling:true,
                                            dialog:{type:"alert", message:"blocked here"},
                                            hint: "… Handle it with browser_handle_dialog …"
browser_click {ref:"e1"}（弹窗仍在）       → ok:false, code:"dialog_open"（立即返回，不是超时）
browser_handle_dialog {action:"accept"}  → ok
browser_evaluate String(window.__clicked) → "true"   ← 点击确实落地了
```

注意最后一条：**放弃命令不等于丢掉点击**——点击已经送进页面了，只是它的确认回不来。

### 【中】6. 导航超时的 hint 优先级错了

`networkHint()` 会匹配 "timed out"，所以它抢在更具体的 `session_stuck` / 导航超时提示前面。结果是：会话真的卡死了，提示却说"跑 `browser_net_check` 看看这台机器能不能连上"。

**修法**：改成按判定优先级——`session_stuck` → 会话提示；`timeout` → 导航超时提示；其它网络形态错误 → `networkHint`。

### 【中】7. 同一个 URL 再导航一次，`navigated` 误报 false

`navigated` 原来定义成"标签页的 URL 变了"。对同一 URL 再导航（重载）来说 URL 不变，于是报 false——但页面**确实重新取过**。

**修法**：判定改为"标签页动过，**或者**它正站在你要的那一页上"（新增 `sameTarget()`：同 scheme + 同 origin + 路径忽略尾斜杠）。实测 `data:` URL 连取两次都报 `navigated: true`。

### 【低】8–12. 其余五条

| #   | 缺陷                                                                                       | 修法                                                                                                        |
| --- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 8   | `browser_net_check` 只试 443，把"站点只在 8080 上服务"误判成不通                           | 目标 URL 带端口就试那个端口，没带就试 443 再 80；返回里新增 `ports` 列出试过的每个端口                      |
| 9   | `browser_wait_for` 超时报 `invalid_argument`（同一类失败 `browser_navigate` 报 `timeout`） | 改用 `ERROR_CODES.TIMEOUT`                                                                                  |
| 10  | `npm run contract` 在仓库里本地执行必然失败（扫的是工作区，宿主契约针对的是**发布包**）    | 新增 `--package` 模式：把 git 跟踪的文件暂存成临时包再检查，用完即删；`npm run contract` 改走该模式         |
| 11  | `browser_batch` 的步骤形状没有 schema 说明，错误信息难定位                                 | `steps` 的 description 压到 ≤70 字符并给三个 `examples`；未知 action 的 hint 点名可用 action 与平铺参数写法 |
| 12  | `browser_run_script` 的相对路径按进程工作目录解析，调用方换个目录就找不到文件              | 相对路径改为以允许的脚本根为基准解析；hint 改为提示"绝对路径或工作目录内的文件名"                           |
| —   | 13 条 ESLint warning（全是死初始化）                                                       | 全部清掉，ESLint 现为 **0 warning**                                                                         |

---

## 四、宿主原生路径验收

全部经宿主注入的 MCP 工具（`mcp__firefox-browser_2__*`）执行，即 Agent 实际走的那条路。

### 4.1 宿主加载状态

| 检查项             | 结果                                                           |
| ------------------ | -------------------------------------------------------------- |
| 宿主加载的版本     | **2.9.3**（`initialize` 握手 `serverInfo.version`）            |
| 宿主 server 进程   | 停掉旧进程后由宿主重新拉起（pid 变化），加载的是已发布的新代码 |
| 已发布包 vs 源码   | **185 个跟踪文件逐字节一致**，0 差异 0 缺失                    |
| 宿主暴露的工具数   | 36 = 默认 `basic` 预设暴露数，**与代码一致**                   |
| `npm run validate` | `✓ host registry: in step (36 tools)`                          |
| 宿主契约           | 通过：185 文件 / 201 条目 / 1.87 MB                            |

### 4.2 新行为在宿主侧逐条核对

对**已发布的** server 直接做 stdio 握手（`initialize` + `tools/list`）：

```
serverInfo: {"name":"firefox-browser","version":"2.9.3"}
tool count: 36
browser_restart inputSchema: {"properties":{"scope":{"enum":["browser","session"], …}}}
browser_config effectiveTools items: {"type":"array","items":{"type":"string"}}
arrays pinned to object: none
```

宿主原生调用：

| 验收项                         | 结果                                                           |
| ------------------------------ | -------------------------------------------------------------- |
| `browser_navigate example.com` | ✅ 返回 `landedUrl:"https://example.com/"`、`navigated:true`   |
| MANUAL 弹窗下的点击            | ✅ 立即返回 `code:"dialog_open"` + 弹窗类型/内容 + 可操作 hint |
| 弹窗打开时的后续点击           | ✅ 同样立即返回 `dialog_open`，**不发任何命令到被挡住的页面**  |
| 点击是否真的落地               | ✅ `window.__clicked === "true"`——放弃命令不等于丢掉点击       |
| `browser_handle_dialog` 后     | ✅ 页面恢复可用                                                |
| 宿主登记 / 预设裁剪            | ✅ 36 个，`in step`                                            |

### 4.3 一处宿主侧缓存（不是插件缺陷）

**当前会话里注入的 `browser_restart` 工具 schema 仍是旧的**（`{"properties":{}}`，没有 `scope`），宿主因此把 `{"scope":"session"}` 拒成 `must not have additional properties`。

这是**宿主会话级缓存**：工具 schema 是会话启动时注入的。已发布的 server 上报的 schema 是新的（见 4.2），下一次宿主重新列举工具列表时会拿到它。因此 `scope:"session"` 这条路径的端到端验证走的是**隔离路径**（`tools/ff-call.mjs`，与宿主跑的是同一份代码、逐字节一致），实测：

```
browser_restart {"scope":"session"} → scope:"session", browserKept:true,
                                      pid 1042906（前后不变）, sessionId 已换新
```

---

## 五、变更清单

| 区域                      | 改动                                                                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/bidi/client.js`      | 新增 `sendAbandonable()` / `_sendAbandonableNow()`：放弃即释放串行队列                                                                                                                                                              |
| `lib/firefox/errors.js`   | 新增 `SESSION_STUCK`、`DIALOG_OPEN` 两个错误码与 `SESSION_STUCK_HINT`、`DIALOG_OPEN_HINT`                                                                                                                                           |
| `lib/firefox/dialogs.js`  | 新增 `blocking()`（区分"插件会自己关的弹窗"与"真正挡着页面的弹窗"）与 `stuck` 集合                                                                                                                                                  |
| `lib/firefox/inputs.js`   | 输入原语支持调用方接管发送（以便弹窗出现时放弃命令）                                                                                                                                                                                |
| `lib/firefox/provider.js` | 新增 `_dialogWaiters`                                                                                                                                                                                                               |
| `provider/action.js`      | 新增 `_dialogBlocked()` / `_performInput()`：动作在弹窗挡路时**提前返回**，并放弃那条永远不回来的命令                                                                                                                               |
| `provider/events.js`      | 弹窗打开时通知等待者；自动处理失败也通知                                                                                                                                                                                            |
| `provider/session.js`     | 新增 `_sessionResponsive()`（绕开队列探活）与 `_classifyCommandFailure()`                                                                                                                                                           |
| `provider/tabs.js`        | `navigate()` 如实报告落地（`landedUrl`/`navigated`/`pending`）；超时 hint 改为基于**请求挂起时长**的事实                                                                                                                            |
| `provider/target.js`      | `_resolveContext()` 在 context 陈旧时校验并回退                                                                                                                                                                                     |
| `provider/process.js`     | `stop()` 清 `_lastContextId`                                                                                                                                                                                                        |
| `provider/workflow.js`    | `restart({scope})`；`waitFor` 超时改报 `timeout`；`resolveScriptPath` 按脚本根解析；batch 步骤文档与报错文案                                                                                                                        |
| `lib/mcp/schema.js`       | `outputSchema()` 不再默认把数组约束成 object                                                                                                                                                                                        |
| `lib/mcp/tools/*`         | 标量数组显式声明 `items:{type:"string"}`；`browser_restart` 增 `scope` 参数                                                                                                                                                         |
| `tools/*`                 | `check-host-contract.mjs` 新增 `--package` 模式；`publish.mjs` 复用 `trackedFiles`                                                                                                                                                  |
| `test/`                   | 新增 `output-schema.test.js`（52）、`session-recovery.test.js`（14）、`navigate-result.test.js`（9）、`dialog-blocking.test.js`（12）、集成 `browser-firefox-session-recovery.test.js`（3）；`bidi-client.test.js` 增补放弃语义用例 |
| `skills/`、`docs/`        | SKILL.md（≤200 行预算内）、REFERENCE.md、capabilities-matrix.md、mcode-plugin.md 同步                                                                                                                                               |
| 版本                      | `package.json` / `.minimax-plugin/plugin.json` / `server.js` / `docs/mcode-plugin.md` 四处同步到 **2.9.3**                                                                                                                          |

---

## 六、遗留与未验证

1. **`session_stuck` 这条错误码在真实环境里很少触发**。它的判定是"命令超时**且**绕开队列的探活也超时"；实测的楔死场景里探活（`browsingContext.getTree`，由父进程应答）始终成功，所以报的是 `timeout`。它是一条**兜底**（socket 真死时才会命中），不是主路径。主路径的诊断由 §三·6 的超时提示承担。
2. **`browser_evaluate` / `browser_snapshot` 在 MANUAL 弹窗打开时仍会挂到命令超时**。本轮只给**动作**加了提前返回（那是 D 的范围）；读取类工具的阻塞没有一并处理。
3. **建容器后导航卡死的根因仍在 Firefox 内部**。实测触发条件稳定（`browser_context create` 之后的下一次导航），但插件侧只能观察到"请求挂起不返回"，改不了 Firefox 内部的行为。插件能保证的是**诊断准确 + 一键恢复**。
4. **宿主会话的旧工具 schema 要到下一次列举才会刷新**（见 §4.3）。这不影响已发布包的内容，但会影响本次会话内调用 `browser_restart {scope:"session"}`。
5. **Turnstile 集成测试仍是 2 个 skip**（环境未下发挑战），与本轮改动无关。
6. **本报告现在随包发布**。发布包的内容就是 git 跟踪的全部文件（`git ls-files`），所以 `TEST-REPORT.md` 入库之后也会被写进安装目录。

---

## 七、变更后的状态

- 仓库 `/home/corvel/src/firefox-browser`，本轮改动已提交并推送到 `origin/main`（`cf4f166`，53 个文件，+2553/−162），本报告随后作为单独一次提交入库。
- 宿主插件目录 `/home/corvel/.minimax/plugins/firefox-browser`：**185 个文件，2.9.3**，宿主 server 已加载新代码。
- 测试结束后：源码仓库的 daemon 已收掉（`ff-call --stop`），宿主实例正常运行在 2.9.3 上，宿主弹窗策略已恢复 `autoDismiss`、预设已恢复 `basic`。
