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
