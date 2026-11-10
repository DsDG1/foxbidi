# Firefox / WebDriver BiDi 能力矩阵

插件在会话建立后**探测**运行中的 Firefox，而不是假设某个特性存在。`browser_status`
会一次报出结果；`capability_unavailable` 错误会写明"需要哪个版本"、"当前是哪个版本"、
"还能怎么做"。

`browser_status` 是**只读**工具：它不会为了回答问题而启动浏览器。于是有两种状态：

| 状态       | `capabilities.probed` | 含义                                                                                                                   |
| ---------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 浏览器在跑 | `true`                | 矩阵是**实探**结果，`featureDetails[*].source` 说明每项怎么判的                                                        |
| 浏览器没跑 | `false`               | 矩阵是**版本预期**：按 `firefox --version` 的版本号推出来的，`knownRisks` 里会写明"浏览器没运行，这是版本预期不是实探" |

两种情况下 `capabilities.features` 的形状完全一样，Agent 不必分支处理。

## 新增工具的能力依赖

| 工具                        | 需要                                 | 缺了会怎样                                                     |
| --------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| `browser_net_check`         | 无（纯 node API + BiDi）             | 永远可用；探针只是"本机能连 + 浏览器能加载"两个样本            |
| `browser_restart`           | 无                                   | 永远可用；写进 profile 副本的首选项靠它才生效                  |
| `browser_egress`            | 无（纯 node API）                    | 永远可用；代理自己解析、自己开连接                             |
| `browser_config` 即时首选项 | FF + `--remote-enable-system-access` | 返回 `privileged_unavailable`，并**降级**为"写副本 + 重启生效" |

## 版本门槛

| 能力                       | 需要                   | 对应 BiDi                                                                                                    | 缺了会怎样                                                                        |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| JS 弹窗处理                | FF **118** / 119       | `browsingContext.userPromptOpened` / `userPromptClosed` / `handleUserPrompt`                                 | 弹窗会**阻塞页面**，后续命令全部超时。插件会在 `browser_status` 里标 `knownRisk`  |
| 视口覆盖                   | FF **117**             | `browsingContext.setViewport`                                                                                | `browser_set_viewport` 返回 `capability_unavailable`                              |
| 标签页重载                 | FF **119**             | `browsingContext.reload`                                                                                     | `browser_reload` 返回 `capability_unavailable`                                    |
| 用户激活                   | FF **121**             | `script.callFunction{userActivation}`                                                                        | 未接入                                                                            |
| 历史前进后退               | FF **122**             | `browsingContext.traverseHistory`                                                                            | `browser_back` / `browser_forward` 返回 `capability_unavailable`                  |
| 容器（多身份）             | FF **124**             | `browser.createUserContext` / `getUserContexts` / `removeUserContext`，`browsingContext.create{userContext}` | `browser_context` 返回 `capability_unavailable`                                   |
| Cookie 读写                | FF **124**             | `storage.getCookies` / `setCookie`                                                                           | `browser_cookie` 返回 `capability_unavailable`                                    |
| 请求拦截                   | FF **124**             | `network.addIntercept` / `continueRequest` / `failRequest`                                                   | `browser_intercept` 返回 `capability_unavailable`                                 |
| 扩展管理                   | FF **137**             | `webExtension.install` / `uninstall`                                                                         | `browser_extension` 返回 `capability_unavailable`                                 |
| 特权（chrome://）上下文    | FF **138**             | `--remote-enable-system-access` + `browsingContext.getTree{root:true}`                                       | 读不了 `about:preferences` / `about:addons`                                       |
| 下载事件（开始）           | FF **144**（实测）     | `browsingContext.downloadWillBegin`                                                                          | 未接入                                                                            |
| 下载事件（结束）           | FF **145**（实测）     | `browsingContext.downloadEnd`                                                                                | 未接入                                                                            |
| **响应体读取**             | FF **144**             | `network.getData` / `network.addDataCollector`                                                               | `browser_network` 返回 `bodyAvailable:false` + `reason:"requires Firefox >= 144"` |
| 验证码：closed shadow root | FF **140**（实测版本） | `script.addPreloadScript`（Firefox 的参数名与 spec 不同）                                                    | 求解器报 `checkbox_not_found`，而不是假装成功                                     |
| 验证码：滑块拖拽           | FF **140**（实测版本） | `input.performActions` 的 pointer 动作序列                                                                   | 求解器报 `drag_failed`                                                            |

这几项的版本号是**保守口径**：插件的验证码链路只在 Firefox 140 ESR 上端到端验证过，
更早的版本一律报"不可用"，而不是乐观尝试。

下载事件的两个门槛是**分别实测**的：Firefox 140.11.0esr 上
`browsingContext.downloadWillBegin` 和 `browsingContext.downloadEnd` 都会被直接
拒绝（"not a valid event name"），协议在 FF 144 落地 `downloadWillBegin`、
FF 145 落地 `downloadEnd`。此前文档写的"FF 133"是错的，已修正。

## 验证码链路依赖的两个能力

验证码求解靠的是两个 Firefox 侧形状并不稳定的命令：

| 能力                   | 为什么需要它                                                                                                                                                | 缺了会怎样                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `captchaPreloadScript` | Turnstile / reCAPTCHA 的 checkbox 在 **closed shadow root** 里，没有任何选择器能选到。插件在页面脚本执行前 patch `attachShadow`，把 root 挂到一个自有属性上 | 找不到 checkbox → `checkbox_not_found` |
| `captchaDrag`          | 滑块只认真实手势：`pointerMove → pointerDown → N×pointerMove → pointerUp`。一次跳过去的 `element.click()` 会被识别成机器                                    | 拖不动 → `drag_failed`                 |

`script.addPreloadScript` 的 Firefox 形状与 spec 不同（用 `functionDeclaration` 字符串，
目标用 `context` 字符串），细节见 `lib/bidi/protocol.js` 的注释。

## 本机情况

Firefox **140.11.0esr**。所以：

- ✅ 弹窗、容器、Cookie、拦截、扩展、特权上下文——全部可用。
- ✅ 验证码链路的两个能力（preload script、拖拽）在本机可用。
- ❌ **响应体读不了**。需要读 XHR/fetch 返回的 JSON 时，用 `browser_evaluate` 在页面里
  自己 `fetch()` 一次。

## 探测方式

| 能力                                                | 判定依据                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `userPrompt`                                        | **订阅结果**。Firefox 接受了 `browsingContext.userPromptOpened` 订阅 → 支持。这是更强的证据，优先于版本号 |
| `userContexts` / `storageCookies`                   | **实探**。真的发一次 `browser.getUserContexts` / `storage.getCookies`，看是否成功                         |
| `networkIntercept`                                  | **实探**。发 `network.addIntercept`，立刻 `network.removeIntercept` 收掉                                  |
| `webExtension` / `networkBodies` / `downloadEvents` | **版本号**。探测它们需要真的装扩展或读响应体，不适合当探针                                                |
| `privilegedContext`                                 | **版本号 + 启动参数**。Firefox 够新，还得启动时带 `--remote-enable-system-access`                         |

`browser_status` 的 `capabilities.featureDetails` 里每一项都带 `source`
（`probe` / `version`）和 `reason`，可以据此判断结论有多硬。浏览器没运行时整张矩阵的
`source` 都是 `version`，且 `capabilities.probed` 为 `false`。

## 默认是精简的

`browser_status` 默认**不**返回整张 `featureDetails`——每个 feature 一条
`{available, source, reason}`，十五项占了大半个 payload，而**只有不可用的那些是
可操作的**（"这个 Firefox 读不了响应体"值得带，"这个特性可用因为探针这么说"不值得）。

默认给的是：

| 字段                       | 内容                                               |
| -------------------------- | -------------------------------------------------- |
| `capabilities.features`    | 布尔表，形状两种状态都一样                         |
| `capabilities.unavailable` | **不可用**的 feature：`{feature, reason, source}`  |
| `capabilities.knownRisks`  | 需要注意的前提（版本、启动参数、实探 vs 版本预期） |
| `capabilities.probed`      | `true` 实探 / `false` 版本预期                     |

需要每一项的来源时用 `detail: "full"`：

```js
await browser_status({}) // 精简
await browser_status({ detail: 'full' }) // 带完整 featureDetails
```

`probed` 与 `knownRisks` 在两种模式下都在——"这是量出来的还是按版本猜的"是 Agent
最不能丢的一条信息。

## 降级行为

能力缺失时**不会**把原始 BiDi 错误抛给 Agent，而是返回：

```json
{
  "ok": false,
  "error": "capability_unavailable",
  "feature": "networkBodies",
  "required": "Firefox >= 144",
  "detected": "140.11.0esr",
  "label": "Response body capture",
  "hint": "Response bodies need Firefox >= 144. Use browser_evaluate with fetch() as a fallback."
}
```

这条路径本身也有测试（`test/capabilities.test.js`）。

## 升级 Firefox 之后

插件**不需要**改代码。能力探测在会话建立时运行，探测到新版本就自动解锁对应功能。
换 Firefox 会导致 profile 副本重新拷贝（登录态随之刷新）。

## 已知的版本行为变化

- **Firefox 138**：`webExtension.install` 默认**临时安装**（会话内有效，不写进 profile）。
  要常规安装传 `permanent: true`（走 `moz:permanent`）。
- **Firefox 138**：`--remote-enable-system-access` 引入，特权上下文由此可用。
- **Firefox 137**：`browsingContext.navigate` 的 `wait:"none"` 行为调整——有
  `beforeunload` 弹窗时不再立刻返回。插件对导航加了弹窗检测与超时保护。
- **Firefox 149**：扩展文档内的动态执行代码（`tabs.executeScript` 等）被移除。
  想用扩展操作页面得改用 `runtime.onMessage`。
- **Firefox 152**：`webExtension.install` 支持隐私窗口；`browser.setDownloadBehavior`
  可以覆盖目标目录。
