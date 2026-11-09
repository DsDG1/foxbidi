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

## 支持状态

| 挑战                                               | 状态                                        | 说明                                               |
| -------------------------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| Cloudflare Turnstile                               | ✅ **已端到端验证**                         | 点 checkbox，轮询站点发放的 token                  |
| reCAPTCHA v2                                       | ⚠️ 未在本机端到端验证                       | 走音频挑战，需要 `sttUrl`；本机访问不到 google.com |
| hCaptcha                                           | ⚠️ 未在本机端到端验证                       | 同上；**不支持图片九宫格**                         |
| GeeTest 滑块                                       | ⚠️ 拖拽与缺口匹配已分别验证，站点端到端未验 | 纯数学找缺口，无模型                               |
| PoW（ALTCHA / Cap / Anubis / Friendly Captcha）    | ⚠️ 未在真实站点验证                         | 页面自己跑 hash，插件只等 token                    |
| 百度旋转验证码（`spin`，"拖动左侧滑块使图片为正"） | ✅ **已端到端验证**                         | 纯几何求正立角度，无模型；见下                     |

## 百度旋转验证码（`spin`）

百度在 `wappass.baidu.com/static/captcha/tuxing_v2.html` 提供的挑战：一张**已经转歪**的
照片放在圆框里，下方一条滑轨，提示"拖动左侧滑块使图片为正"。

它和别的挑战不一样：**不发放 token**。站点把答案交给 `POST /cap/log`，
判定写在响应的 `data.op` 里（`1` / `2` = 接受，`3` = 拒绝）。所以 `spin` 是唯一
一个 `ok: true` 不代表"拿到 token"的求解器——它的含义是**服务端确认角度正确**。

求解分三步：

1. **取图并算角度**（全部在页面内完成）。照片是 `passport.baidu.com` 的跨域 JPEG，
   直接把页面里的 `<img>` 画到 canvas 会被污染（`getImageData` 抛 `SecurityError`），
   所以插件单独 `fetch` 字节 → `createImageBitmap` → 画到干净的 canvas 上分析。
   像素不离开浏览器，只有角度回到 Node 侧。
   - 角度候选来自梯度方向直方图的 `cos(4θ)` 对齐分数（90° 周期），
   - 族内用**带掩膜的分带细节**（正立照片的细节呈"上稀—中密—下疏"的山形）
     加上**上下亮度差**（天空比地面亮）来判定，
   - 最后在族内做小范围精修（对齐分数 + 水平边缘能量）。
     旋转采样用**双线性**：最近邻会把每条边变成阶梯，阶梯自带的边缘方向会把角度带偏好几度。
2. **拟人化拖动**。先用真实指针事件在图片区走一段轨迹（站点会记录鼠标路径），
   再按住滑块拖到目标位置：缓动 + 每步停顿 + 轻微纵向抖动。
3. **读服务端判定**。页面里的 `XMLHttpRequest` 被 hook 住，`/cap/log` 的响应
   `data.op` 就是成败依据。判定同时镜像进 `localStorage`，因为被拒后页面会刷新。

拿不准的图会**跳过而不是乱猜**：四个候选得分接近时（正/倒难以分辨），
插件换一张图重来——错答案正是招来风控的原因。

**风控是另一回事**：百度的风控可能在接受角度后仍要求"再次验证"
（`data.opp = 3`，提示"存在安全风险，请再次验证"）。这时 `status` 是 `risk_challenge`，
角度是对的，但这个会话被盯上了。风控是**会话级**的，所以插件在这里**停止**：在同一口气里
继续提交只会让风控升级。能不能放行取决于站点的风控，不是角度算错了。

**实测（2025-10，本机出口 IP）**：每次 `browser_captcha` 调用最多 4 轮。单轮里
"角度被服务端接受（`data.op = 1`）"的比例约一半；分不清正倒的图会被跳过
（`low_confidence`）而不是乱猜。整体上约**一半的调用能拿到 `solved`**，其余主要是
风控二次验证（`risk_challenge`）。这是与百度风控对抗的结果，不是"点中了就算成功"。

## 成功判据

**站点发放的 token，不是"点中了"。**

`ok: true` 只在 token 长度 > 0 时返回（`spin` 例外：它的判据是服务端的 `data.op`）。
没解开就是 `ok: false`，并带一个 `status`：

| status                                                                             | 含义                                                                |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `not_detected`                                                                     | 页面上没有受支持的挑战                                              |
| `unknown_solver`                                                                   | `solver` 名字不认识                                                 |
| `checkbox_not_found`                                                               | 找到了挑战框架，但框住控件（可能 closed shadow root 没 patch 成功） |
| `stt_unavailable` / `stt_failed` / `stt_empty` / `stt_timeout` / `stt_unreachable` | 语音识别服务的问题                                                  |
| `vision_unavailable`                                                               | 遇到图片九宫格，但没配 `visionUrl`                                  |
| `geometry_unavailable` / `no_puzzle_canvas` / `notch_not_found`                    | 滑块几何读不到                                                      |
| `drag_rejected`                                                                    | 拖了，但站点没认（`spin`：角度被拒）                                |
| `low_confidence`                                                                   | （`spin`）这张图分不清正倒，没有提交，换图重来                      |
| `risk_challenge`                                                                   | （`spin`）角度被接受，但站点要求再验证一次                          |
| `pow_timeout`                                                                      | PoW 超时没出 token                                                  |
| `solve_failed`                                                                     | auto 模式下全都试过了都没成功，`attempts` 里逐条列了                |

## 降级原则

**缺服务就报错，绝不假装成功。**

- 音频挑战需要语音识别，插件**不含模型**，必须你指一个服务（`sttUrl`）。没有就是
  `stt_unavailable`，附上怎么配的说明。
- 图片九宫格默认**不支持**；要接就传 `visionUrl`。

## 体积与许可

插件**不含任何模型、任何 npm 依赖**：

- 语音识别 → 外部 HTTP 服务（Whisper / OpenAI 兼容协议）
- 图片识别 → 外部 HTTP 服务（`visionUrl`）
- 滑块缺口定位 → 纯数学：拼图块的**边框像素**与背景做差平方匹配，无模型、无图像库

对比：ddddocr 模型 87 MB，AntiCAP 仓库 467 MB——这些都没有 vendor 进来。

## 已知代价（如实说明）

- Turnstile / reCAPTCHA 的 checkbox 在 **closed shadow root** 里，没有任何选择器能选到，
  平台的快照工具也进不去。插件在页面脚本执行前 patch `attachShadow`，把 root 挂到一个
  自有属性上——页面**理论上能观测到这个 patch**。这是刻意取舍：看不见 checkbox 比被看见更糟。
- `navigator.webdriver` 仍然是 `true`（Firefox 用 BiDi 的既定代价，关不掉）。风控严格的站点
  成功率低于专用反检测浏览器。
- 滑块的缺口定位依赖"缺口被画成暗色轮廓"这个前提；不同 GeeTest 版本的画法不同，
  匹配不上会返回 `notch_not_found` 而不是乱拖。
- **不支持**：reCAPTCHA v3、hCaptcha 图片九宫格、腾讯/网易/阿里滑块、2Captcha/CapSolver 等付费 API。

## 依赖的两个浏览器能力

| 能力                   | 最低版本（实测口径） | 命令                                   |
| ---------------------- | -------------------- | -------------------------------------- |
| `captchaPreloadScript` | FF 140 ESR           | `script.addPreloadScript`              |
| `captchaDrag`          | FF 140 ESR           | `input.performActions` 的 pointer 动作 |

Firefox 的 `script.addPreloadScript` 参数形状与 spec 不同（用 `functionDeclaration` 字符串，
目标用 `context` 字符串），细节见 `lib/bidi/protocol.js` 的注释。
