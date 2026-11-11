# Firefox / WebDriver BiDi 能力矩阵

插件在会话建立后**探测**运行中的 Firefox，而不是假设某个特性存在。`browser_status`
一次报出结果；`capability_unavailable` 错误会写明"需要哪个版本"、"当前是哪个版本"、
"还能怎么做"。

`browser_status` 是**只读**工具：它不会为了回答问题而启动浏览器。于是有两种状态：

| 状态       | `capabilities.probed` | 含义                                                                          |
| ---------- | --------------------- | ----------------------------------------------------------------------------- |
| 浏览器在跑 | `true`                | 矩阵是**实探**结果                                                            |
| 浏览器没跑 | `false`               | 矩阵是**版本预期**：`knownRisks` 里会写明"浏览器没运行，这是版本预期不是实探" |

两种情况下 `capabilities.features` 的形状完全一样，Agent 不必分支处理。

## 版本门槛

| 能力                    | 需要                 | 对应 BiDi                                               | 缺了会怎样                                   |
| ----------------------- | -------------------- | ------------------------------------------------------- | -------------------------------------------- |
| JS 弹窗处理             | FF **118** / 119     | `browsingContext.userPromptOpened` / `handleUserPrompt` | 弹窗会**阻塞页面**，后续命令全部超时         |
| 视口覆盖                | FF **117**           | `browsingContext.setViewport`                           | 返回 `capability_unavailable`                |
| 标签页重载              | FF **119**           | `browsingContext.reload`                                | 返回 `capability_unavailable`                |
| 历史前进后退            | FF **122**           | `browsingContext.traverseHistory`                       | 返回 `capability_unavailable`                |
| 容器（多身份）          | FF **124**           | `browser.createUserContext` 等                          | 返回 `capability_unavailable`                |
| Cookie 读写             | FF **124**           | `storage.getCookies` / `setCookie`                      | 返回 `capability_unavailable`                |
| 请求拦截                | FF **124**           | `network.addIntercept`                                  | 返回 `capability_unavailable`                |
| 扩展管理                | FF **137**           | `webExtension.install` / `uninstall`                    | 返回 `capability_unavailable`                |
| 特权（chrome://）上下文 | FF **138**           | `--remote-allow-system-access`                          | 读不了 `about:preferences` / `about:addons`  |
| 下载事件（开始 / 结束） | FF **144** / **145** | `browsingContext.downloadWillBegin` / `downloadEnd`     | 未接入                                       |
| **响应体读取**          | FF **144**           | `network.getData`                                       | `browser_network` 返回 `bodyAvailable:false` |

下载事件的两个门槛是**分别实测**的：Firefox 140.11.0esr 上
`downloadWillBegin` 和 `downloadEnd` 都会被直接拒绝（"not a valid event name"），
协议在 FF 144 落地前者、FF 145 落地后者。

## 永远可用的工具

| 工具                        | 需要                                | 缺了会怎样                                                     |
| --------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| `browser_net_check`         | 无（纯 node API + BiDi）            | 永远可用；探针只是"本机能连 + 浏览器能加载"两个样本            |
| `browser_restart`           | 无                                  | 永远可用；写进 profile 副本的首选项靠它才生效                  |
| `browser_egress`            | 无（纯 node API）                   | 永远可用；代理自己解析、自己开连接                             |
| `browser_config` 即时首选项 | FF + `--remote-allow-system-access` | 返回 `privileged_unavailable`，并**降级**为"写副本 + 重启生效" |

## 降级行为

- 能力缺失时**不乐观尝试**：直接返回 `capability_unavailable`，并写明缺的是哪个版本。
- 验证码链路只在 Firefox 140 ESR 上端到端验证过，更早的版本一律报"不可用"。
- 响应体读不了时，用 `browser_evaluate` 在页面里自己 `fetch()` 一次。
- 升级 Firefox 之后不用重装插件：能力是运行时探测的，重启会话即可。

## 探测方式

| 能力               | 判定依据                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `userPrompt`       | **订阅结果**。Firefox 接受了 `browsingContext.userPromptOpened` 订阅 → 支持。比版本号更强的证据 |
| `userContexts`     | **实探**。真的发一次 `browser.getUserContexts`                                                  |
| `storageCookies`   | **实探**。真的发一次 `storage.getCookies`                                                       |
| `networkIntercept` | **实探**。发 `network.addIntercept`，立刻 `network.removeIntercept` 收掉                        |
