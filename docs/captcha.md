# 验证码求解（browser_captcha）

`browser_captcha` 是**可选**能力：不调用它，插件什么都不做，也没有后台行为。

```json
{ "solver": "auto", "sttUrl": "http://127.0.0.1:8000", "visionUrl": "", "timeoutMs": 30000 }
```

| 参数        | 作用                                                                                 |
| ----------- | ------------------------------------------------------------------------------------ |
| `solver`    | `auto`（默认）或 `turnstile` / `recaptcha` / `hcaptcha` / `geetest` / `pow` / `spin` |
| `sttUrl`    | 语音识别服务（Whisper / OpenAI 兼容）。音频挑战必需                                  |
| `visionUrl` | 图片识别服务。可选，默认不启用图片九宫格                                             |
| `timeoutMs` | 整体超时，默认 60 秒                                                                 |

`browser_captcha_status` 是配套的只读工具：`{"kind":"turnstile"}`，读站点会用的那个 token，
不点击、不输入。用来确认"这个挑战到底解开了没有"。

## 成功判据

**站点发放的 token，不是"点中了"。**

`ok: true` 只在 token 长度 > 0 时返回；没解开就是 `ok: false`，并带一个 `status`
（`not_detected`、`checkbox_not_found`、`stt_unavailable`、`notch_not_found`、
`drag_rejected`、`low_confidence`、`risk_challenge`、`pow_timeout`、`solve_failed` 等），
完整词表见 `skills/firefox-browser/REFERENCE.md`。

有个别挑战不发放 token，判据是服务端的接受结果；这类求解器报 `ok: true` 的含义是
**服务端确认答案正确**，而不是拿到了 token。

## 降级原则

**缺服务就报错，绝不假装成功。**

- 音频挑战需要语音识别，插件**不含模型**，必须你指一个服务（`sttUrl`）。没有就是
  `stt_unavailable`，附上怎么配的说明。
- 图片九宫格默认**不支持**；要接就传 `visionUrl`。
- 拿不准的挑战会**跳过而不是乱猜**——错答案正是招来风控的原因。

## 体积与代价

插件**不含任何模型、任何 npm 依赖**：语音识别和图片识别都走外部 HTTP 服务，
滑块定位是纯数学。代价是明说的：checkbox 在 closed shadow root 里，插件会 patch
`attachShadow`（页面理论上能观测到这个 patch）；`navigator.webdriver` 仍然是 `true`。
