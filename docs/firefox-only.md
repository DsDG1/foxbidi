# Firefox 独有能力

Firefox 自 2024 年起移除了 CDP，WebDriver BiDi 是唯一驱动路径。有一批能力是
**CDP 方案结构性做不到**的——不是"实现起来麻烦"，是 Chromium 那条路上根本没有对应物。

这是本插件相对通用浏览器 MCP（Playwright MCP、Chrome DevTools MCP、agent-browser）
真正的差异化所在。

## 1. 容器：多身份隔离 `browser_context`

Firefox 的容器给每个身份一套独立的 cookie / localStorage / cache。

```jsonc
// 建一个容器
{ "action": "create", "label": "account-b" }
// 在容器里开一个标签页
{ "action": "select", "userContext": "<uuid>", "url": "https://example.com" }
// 收掉（连带关掉本插件在该容器里开的标签页）
{ "action": "remove", "userContext": "<uuid>" }
```

**Agent 什么时候需要**：同一个任务里登两个账号；或者一个任务登了某个站，不希望这次
登录污染后续无关的任务。Chrome 没有等价物——最接近的是"开一个全新的浏览器实例"，
但那样就丢掉了真实 profile 里的登录态。

**限制**：Firefox 拒绝删除还有打开标签页的容器，所以插件会先关掉**它自己**在那个容器里
开的标签页（并如实报告关了哪些），别人的标签页不碰。BiDi 没有"列出某个 userContext 的
标签页"的命令，所以插件只跟踪自己开过的那些。

## 2. 扩展管理 `browser_extension`

```jsonc
// 装一个未签名的扩展（FF138+ 默认临时安装）
{ "action": "install", "path": "/path/to/unpacked" }
// 要常规安装
{ "action": "install", "path": "/path/to/ext.xpi", "permanent": true }
// 列出已装扩展
{ "action": "list" }
```

**Agent 什么时候需要**：站点挡住了任务（广告盖住按钮、要求 2FA、要求密码管理器），
而装个扩展就能解决。Chromium 那边的扩展路径在 BiDi 之外，且不支持临时安装。

**限制**：

- FF 137+。
- 装扩展是不可逆动作，**必须** `confirm: true`。
- 列扩展需要特权上下文（读 `about:addons`），要 `FIREFOX_BROWSER_PRIVILEGED=1` 启动。
  BiDi 没有"列出扩展"的命令。
- FF 149 起扩展文档内的动态执行代码被移除，用扩展操作页面要改 `runtime.onMessage`。

## 3. 特权（chrome://）上下文

以 `--remote-enable-system-access` 启动 Firefox 后，`browsingContext.getTree{root:true}`
能拿到 chrome:// 上下文，于是可以：

- 读 `about:preferences` 的**实际生效值**（不是猜的，是浏览器真的在用的）
- 读 `about:addons` 的扩展列表
- 打开 `about:downloads`、`about:logins`

```bash
FIREFOX_BROWSER_PRIVILEGED=1   # 启动时打开
```

**默认关闭**：这个开关会扩大浏览器暴露给驱动的内容，按需开。

## 4. Cookie 读写 `browser_cookie`

```jsonc
{ "action": "get", "filter": { "domain": "example.com" } }
{ "action": "set", "cookie": { "name": "sid", "value": "…", "domain": "example.com" }, "confirm": true }
```

比页面里的 `document.cookie` 强在两点：**能读 HttpOnly**、**带 partition key**。
需要 FF 124+。写 cookie 是不可逆动作，要 `confirm: true`。

**两条实测出来的坑**：

- **domain 过滤是精确匹配。** BiDi 里 `domain: "example.com"` **不匹配**
  `".example.com"`——而 cookie 通常就是以点开头的。所以工具在精确匹配为空时会再试一次
  带点的写法。
- **storage 模块没有 context 参数。** Firefox 140 的 `storage.getCookies` /
  `storage.setCookie` 永远操作**默认 cookie jar**，跟当前焦点在哪个容器里无关。
  容器里的 cookie 只有**该容器内的页面**（`document.cookie`）能看到。

  想按容器隔离，就用 `browser_context` 开一个容器再在里面开标签页——页面自己写的
  cookie 会落进那个容器。

## 5. 请求拦截 `browser_intercept`

```jsonc
{ "action": "block", "patterns": ["analytics.example.com", "/ads/"] }
{ "action": "clear" }
```

装上拦截后 Firefox 会**挂起所有请求**直到有人放行或失败。插件在**自己这边**做 URL
匹配：看到请求就逐个决定——命中模式就 `failRequest`，没命中就 `continueRequest`。

这样做的两个好处：

- 不依赖 Firefox 的 `urlPatterns` 参数支持度（各家实现差别很大）。
- 页面**不会被永久冻住**：每个请求都有兜底放行，Agent 中途放弃也会在超时后恢复。

## 6. 响应体读取 `browser_network`

```jsonc
{ "requestId": "<request id>" }
```

直接读某个请求的响应体（XHR/fetch 的 JSON），不用去猜渲染后的 DOM。

**FF 144+ 才有**（BiDi M17）。FF 140 上这条会返回：

```json
{
  "ok": true,
  "bodyAvailable": false,
  "reason": "requires Firefox >= 144",
  "hint": "Use browser_evaluate with fetch() as a fallback."
}
```

## 7. 反检测的真实边界

|                            | 状态                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| 快照不往 DOM 写属性        | ✅ 2.0 起，ref 存在页面里一个不可枚举属性上                                              |
| 注册表键随机、每次会话不同 | ✅                                                                                       |
| 注册表键不可枚举           | ✅（`Object.keys(window)` 看不到）                                                       |
| `navigator.webdriver`      | ❌ **无法关闭**。Firefox 只要 Remote Agent 在跑就是 `true`，没有任何 pref 或启动参数能改 |

所以插件**不承诺隐身**。`browser_detectability` 会实测并如实报告，包括"`window` 上还能
不能被 `Object.getOwnPropertyNames` 找到注册表键"这种不利事实。

要更硬的隔离，可以给 profile 副本加偏好：

```bash
FIREFOX_BROWSER_PREFS='{"privacy.resistFingerprinting":true}'
```

注意 `resistFingerprinting` 会破坏不少站点（字体、时区、canvas），**默认不开**，
按需在单个任务里开。

## 8. 其他 BiDi 独有能力

| 能力                                    | 说明             | 状态               |
| --------------------------------------- | ---------------- | ------------------ |
| `browsingContext.traverseHistory`       | 历史前进后退     | FF122+，未接入工具 |
| `browsingContext.reload`                | 重载             | FF119+，未接入工具 |
| `browsingContext.downloadWillBegin/End` | 下载事件         | 版本门槛待实测     |
| `script.callFunction{userActivation}`   | 脚本里的用户激活 | FF121+，未接入     |
| `storage.getCookies{partition}`         | 分区 cookie      | FF124+             |
