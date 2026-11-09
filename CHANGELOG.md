# Changelog

All notable changes to the `firefox-browser` plugin are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/), and
versions follow `MAJOR.MINOR.PATCH`.

## Unreleased

Nothing yet.

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
  模块；`server.js` 的 1127 行 TOOLS 数组外提为 `lib/mcp/tools/`。
  对外工具名、描述、schema 与顺序**逐字节不变**。
- **工具 schema 瘦身** —— 34 个工具的 schema 注入体积从 19953 字节降到
  18000 字节以下，参数语义细节迁到按需加载的 SKILL.md。

### Fixed

- **弹窗结算不再空等 250ms** —— `_settleDialogs()` 改为事件驱动：动作期间若
  `userPromptOpened` 已到达则立即结算，否则只等一个短兜底窗口（默认 40ms，
  可用 `FIREFOX_BROWSER_DIALOG_SETTLE_MS` 调整）。实测普通点击从 ~282ms
  降到 ~30ms。
- **迟到弹窗不再漏报** —— 旧实现在弹窗迟到 300ms 时会漏掉它（要到下一个动作
  才补报），新实现不再依赖固定 250ms 窗口。
- **启动失败重试不再阻塞事件循环** —— `_killProcess` 的忙等改为异步版本；
  仅 `process.on('exit')` 路径保留一个极短的同步收尾。
- **`downloadEvents` 能力门槛修正** —— 文档标注 FF 133，但 Firefox 实际在
  **FF 144** 才实现 `downloadWillBegin`、**FF 145** 才实现 `downloadEnd`
  （FF 140 上该事件名会被直接拒绝）。门槛已拆分修正。

### Notes

- 插件**仍然零运行时 npm 依赖**；eslint 与 prettier 仅为 devDependency。
- 能力门槛以本机实测（Firefox 140.11.0esr）为准，而非文档假设。

## v2.2.0

Baidu 的旋转验证码求解器成为一等公民。

## v2.0.0

重写：能力矩阵按运行中的 Firefox 实探、ref 注册表不写入 DOM、确认闸门、
诚实的 effect 报告、网络诊断。
