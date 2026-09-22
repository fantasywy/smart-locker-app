# 小程序 C 端设计规格 — Wayfinder Charting 简报

> ## ⛔ 已作废（SUPERSEDED，2026-09-20）
>
> Charting 已完成，canonical artifact 现在是 **GitHub issue `#1`（label `wayfinder:map`）** 及其 13 个 child（`#2`–`#14`）。本文件仅作历史 provenance 保留，**不要再依据它行动** —— 它已被 R1/R2/R3 的 findings 更正过两处事实（ADR-0003 的真实主题、九态实为 7 枚举 × 显示态），详见 map 的 Notes。
>
> 保留此文件而不删除：`.scratch/` 未入版本控制，删除不可逆；如需清理请自行删除。

> **这是 handoff 文件，不是 canonical artifact。**
> canonical artifact 将是 GitHub issue（label `wayfinder:map`），由本仓库 tracker 承载。
> 本文件存在的唯一目的：让**重开后的 session** 不需要任何对话记忆就能接着把 chart 落成。
> 一旦 map 与 tickets 建成，本文件作废。

---

## Destination

**一份可实现的小程序 C 端设计规格（spec）。**

覆盖：信息架构、页面清单、关键流程时序、后端接口映射、异常与文案口径、以及与柜机中控屏的职责边界——做到一个实现者拿着它就能单独开工，不必回头再做产品决策。

**不写实现代码。设计决策是产出，代码不是。**

---

## Notes

- **Domain 术语事实源**：`java/smart-locker/CONTEXT.md`（订单 / 存入 / 取件 / 预约 / 爽约 / 未存入阶段 / 支付即定额 / 应收 vs 实收 / 信用积分 / 黑名单 …）。本仓库**尚无 `CONTEXT.md`**，按 `docs/agents/domain.md` 的「缺失时静默继续」处理；有术语真正落定时由 `/domain-modeling` 懒创建。
- **契约源**：`java/smart-locker/docs/API设计文档.md` v1.0 —— 用户端 §13（`/api/app/v1/**`）、错误码 §15、契约增量 §16。
- **不可违反的既有设计**（conformance，不是待议项）：
  - `vue/smart-locker-device/docs/adr/0003`：中控屏**不承载支付**；`/pickup-verify` 返回 `paid:false` 时引导用户「去小程序支付」。
  - 中控屏九态：`vue/smart-locker-device/src/device/terminal.ts`（待机 / 输入中 / 校验中 / 已付清 / 待支付 / 无效 / 已核销 / 传输失败 / 业务拒绝）。
  - `vue/smart-locker-device/.scratch/device-simulator/spec.md` §12（V1–V25）：色调层五档、语义色只做背景/边框/圆点/色条、文字一律走 ink。
- **工程约定**：`smart-locker-admin/docs/adr/0002` —— 前端不得自造契约，一律引后端 v1.0。
- **Skills 建议**：`/grilling`（HITL 决策）、`/domain-modeling`（术语落库）。

---

## 侦察摘要（已查证，勿再重复查）

### 后端用户端接口（16 个，已实现且带测试）

认证与个人：

| 端点 | 作用 / 关键字段 |
|---|---|
| `POST /auth/login` | `code` → openid，首登自动注册；resp `accessToken, refreshToken, expiresIn(7200), user{...score,status}`；`code` 无效 `8001` |
| `POST /auth/refresh` | 头 `X-Refresh-Token`；access 2h / refresh 30d；失效 401 + `2005` |
| `POST /auth/logout` | 作废 refresh |
| `GET/PUT /profile` | 含 `score, status, blacklistRecord{reason,createdAt,auto}` |
| `GET /score-logs` | 积分明细分页 |

柜机 / 订单 / 预约：

| 端点 | 作用 / 关键字段 |
|---|---|
| `GET /lockers/by-code?code=` | 扫码反查柜机；resp `id,code,siteId,siteName,position,online,status,cellAvailability{small,medium,large}`；不存在 `1002` |
| `POST /orders` | 建存件订单；req `lockerId,cellType`；resp `orderId,orderNo,cellNo,openTimeoutMinutes`；`FREE→RESERVED` + `OPEN_CELL(USER_DROP)`；黑名单 `5004` / 柜机不可用 `4004` / 无空位 `8002` |
| `GET /orders` | 我的订单；行含 `status,payAmount,estimatedAmount,pickupCode`（**`pickupCode` 仅「已存入且未取件」时返回**） |
| `GET /orders/:id` | 详情；含 `order,locker,timeline,payments[]`；非本人 `8003` |
| `POST /orders/:id/cancel` | 仅限「未存入且开门指令未回执 `DONE`」；否则 `3002`；订单 → `CANCELLED` 并释放格口 |
| `POST /orders/:id/pay` | 一期 **MOCK_WECHAT** 模拟渠道，金额服务端现算；resp `payNo,payAmount,channel,paidAt,orderStatus,paid,openCommandIssued`；幂等；生成 `OPEN_CELL(USER_PICKUP)` |
| `POST /reservations` | 建预约；req `lockerId,cellType,planStartAt,planEndAt`；resp `reservationId,resvNo,cellNo`；`8006/8007` |
| `GET /reservations` | 我的预约 |
| `POST /reservations/:id/cancel` | 仅 `PENDING`；否则 `6202` / 非本人 `8003` |
| `POST /reservations/:id/use` | 转单；窗口 `[planStartAt − holdMinutes, planStartAt + noShowMinutes)` |

**空缺点**：用户端**没有**「站点列表」端点——C 端只能按 `code` 反查柜机。

### 设备端关键事实（直接决定 C 端交互形态）

- `POST /api/device/v1/pickup-verify`，体 `{pickupCode, lockerCode}`。失败走 **HTTP 200** + `matched:false` + `reason(INVALID | CONSUMED)`，**不是**业务错误码。成功回订单摘要 `{orderNo,cellNo,cellType,status,payable,paid,hint}`。
  - `payable` 是 **5 分钟粒度参考快照，禁渲染为锁定价**。
  - `paid:false` **不是失败**，而是引导去小程序支付。
- **只有 `DOOR_CLOSED` 驱动订单状态与计时起点**；`OPEN_CELL` 不改订单状态。→ C 端必须有显式的「等你关门」等待态，否则用户会停在一个不推进的界面。
- 指令生命周期 `PENDING → SENT → DONE/FAILED`，`SENT` 超 5min → `EXPIRED`。**失败/过期不自动重发，由用户重试动作重新生成新指令。** → C 端必须有重试入口。
- 取件码：6 位数字，**同一柜机内唯一**，存入关门后生成。
- 设备签名：`key = SHA256(deviceSecret)` 的 hex 的 UTF-8；`message = deviceCode+timestamp+nonce+body`。**与 C 端无关**，仅备查。

### 未闭合口径（C 端必然撞上）

| 编号 | 内容 | 出处 |
|---|---|---|
| **N1** | `openNotClosed`（开门未闭）字段名是 admin 前端**暂定**，后端 §16 只声明"有异常提示"未给字段名。缺失方向安全（漏报而非误报） | `smart-locker-admin/.scratch/smart-locker-admin/issues/06-pre-integration-fixlist.md` L86 |
| **N2** | `Order.startAt` 后端需求 §11 #5 称「未存入时应为空」，但 admin 类型仍是非空 `string`（运行期靠 `formatDateTime` 渲染「—」安全，仅类型不精确） | 同上 L87 / admin `CONTEXT.md` L25–28 |
| **N4** | 「未存入」阶段的列表筛选**尚未与「使用中」分开** | 同上 |

### 参考仓库中与 C 端**无关**的表面（避免走偏）

- admin 是纯运营台，无任何 C 端代码；其 `users` 模块的信用分/黑名单操作是**管理端视角**，不是 C 端体验。
- device 是柜机固件替身，「本地演示开门」绕过服务端、**不是**后端 `ADMIN_FORCE`，切勿混入 C 端设计。

### 当前代码现状

`smart-locker-app` 是微信官方模板空壳：`pages/index`(54 行) + `pages/logs`(21 行) + `components/navigation-bar`。**零业务代码**。
`project.config.json` 已配 `useCompilerPlugins: ["typescript","sass"]`，`miniprogramRoot: miniprogram/`，包管理 pnpm，devDependencies 仅 `miniprogram-api-typings`。

---

## Not yet specified（fog）

通往 destination、但**现在还说不到 ticket 粒度**的问题：

1. **入口与身份模型** —— 扫码（`/lockers/by-code`）是主入口，还是「首页 + 我的订单」才是？登录时机（首屏静默 `wx.login` 换 openid，还是进入具体动作才登）？未登录状态下能看什么？
2. **取件码怎么流转**（最关键的空白）—— 支付已由 device ADR-0003 判给小程序。但取件码呢？中控屏同时有**键盘输入 tab** 和**扫码 tab**，而扫码 tab 目前的内容是模板 `{lockerCode}`（**柜机码，不是取件码**）。小程序究竟是「显示 6 位码给用户在屏上敲」还是「生成二维码给屏扫」？柜机屏的扫码 tab 语义至今未定。
3. **订单首页信息架构** —— 「未存入 / 使用中 / 已完成 / TIMEOUT / 开门未闭」如何在有限首屏表达？直接撞 N2/N4。
4. **支付的一期形态** —— 纯模拟按钮，还是套一层 `wx.requestPayment` 的壳（`/pay/notify` 后端明确二期预留）？
5. **被拉黑 / 低信用分的降级体验** —— `5004` 拦截下单/预约/开始使用，但**不拦截登录与查看**。这个「能看不能做」的降级必须设计，否则用户只会看到裸错误码。
6. **预约的时段选择与占位窗口表达** —— `holdMinutes` / `noShowMinutes` 如何对用户解释？爽约扣分如何预警？
7. **C 端中文文案体系** —— admin 侧中文**未集中**（内联在 `orders/index.vue` 等页面），`status-tag.ts` 只有配色。C 端必须自建一套，且要与中控屏九态语义对齐。
8. **技术栈与工程形态** —— 沿用原生 TS + Sass 骨架，还是引入 Taro / uni-app？请求层（token 刷新、401 静默重试一次）怎么封装？是否分包？
9. **视觉语言移植** —— device 的色调层五档 + ink 文字规则如何落到小程序（小程序无 CSS 变量，需要 SCSS 变量层 + mixin）。

---

## Out of scope

超出 destination，本次 effort **永不 graduate**：

- 小程序实现代码（destination 是 spec，不是 build）。
- 真实微信支付接入与 `/pay/notify` 回调（后端明确二期）。
- 部分退款（二期；一期仅全额退款）。
- **后端任何改动** —— 未闭合口径只做「C 端如何消费」的裁定，不改后端。
- 管理端任何改动。
- 柜机固件 / 中控屏任何改动。
- 短信或推送通知（系统无推送通道，拉取是唯一途径）。
- 优惠 / 活动叠加（二期）。
- `PENDING_PAYMENT`（待支付）状态 —— 一期不启用，枚举预留。

---

## Draft tickets（待建）

类型取值：`wayfinder:research` / `wayfinder:prototype` / `wayfinder:grilling` / `wayfinder:task`。
Blocking 用 GitHub **native issue dependencies**（`blocked_by`）。

### R 类 — AFK，交给 `/research` subagent，可并行启动

| ID | 标题 | 核心问题 |
|---|---|---|
| **R1** | C 端接口映射底稿 | 逐端点提取请求/响应字段、错误码与触发时机，产出「用户动作 → 端点 → 字段」的映射表，范围限 §13 + §15。产出物要能让实现者照抄。 |
| **R2** | 取件码与中控屏「扫码」tab 的真实语义 | 查清 `TerminalScanTab` 的扫码内容究竟是柜机码还是取件码、`/pickup-verify` 完整契约、`pickupCode` 的生命周期（生成 / 失效 / 核销）。为 D2 提供事实基线。 |
| **R3** | 三个未闭合口径在后端文档里的确切表述 | N1 / N2 / N4 逐项找后端原文，判定 C 端能否自行裁定，还是必须挂账等联调窗口。 |

### D 类 — HITL，grilling

| ID | 标题 | Blocked by |
|---|---|---|
| **D1** | 入口与身份模型 | R1 |
| **D2** | 小程序 × 中控屏职责边界：取件码怎么流转 | R2 |
| **D3** | 订单首页如何表达未存入 / 使用中 / 异常 | R3 |
| **D4** | 黑名单与低信用分的降级体验 | R1 |
| **D5** | 预约时段选择与占位窗口的用户表达 | R1 |
| **D6** | 支付的一期形态与异常分支 | R1 |
| **D7** | 技术栈与工程形态 | — |

### P 类 — HITL，prototype

| ID | 标题 | 核心问题 |
|---|---|---|
| **P1** | 「等待关门」等待态与指令失败重试 | 支付成功 ≠ 拿到东西，要等 `DOOR_CLOSED`；指令还会 `FAILED/EXPIRED` 且不自动重发。用原型回答「这个等待怎么让人不焦虑、失败怎么自然地重试」。C 端最独特的交互，无 blocker。 |

### T 类 — task

| ID | 标题 | Blocked by |
|---|---|---|
| **T1** | C 端中文文案与状态口径表 | D3 |
| **T2** | 小程序视觉语言：色调层与 ink 规则移植 | — |

### Blocking edges（draft）

```
R1 ──► D1, D4, D5, D6
R2 ──► D2
R3 ──► D3 ──► T1
R1/R2/R3/D7/T2/P1  无 blocker
```

**Frontier（chart 完成后可立即开的）**：R1、R2、R3、D7、T2、P1。

---

## Map body 草稿

```markdown
## Destination

一份可实现的小程序 C 端设计规格：信息架构、页面清单、关键流程时序、后端接口映射、异常与文案口径、与柜机中控屏的职责边界。做到实现者可单独开工。不写实现代码。

## Notes

术语事实源 `java/smart-locker/CONTEXT.md`；契约源 `java/smart-locker/docs/API设计文档.md` v1.0（用户端 §13 / 错误码 §15）。
不可违反：device ADR-0003（中控屏不承载支付）、中控屏九态、device spec §12 V1–V25（色调层与 ink 规则）。
共识：前端不得自造契约（admin ADR-0002）。
Skills：`/grilling`、`/domain-modeling`。

## Decisions so far

（空）

## Not yet specified

入口与身份模型；取件码在小程序与柜机屏之间的流转；订单首页对未存入/使用中/异常的表达；黑名单降级体验；预约占位窗口的用户表达；支付一期形态；C 端文案体系；技术栈与工程形态；视觉语言移植。

## Out of scope

小程序实现代码；真实微信支付与 /pay/notify；部分退款；后端改动；管理端改动；柜机固件与中控屏改动；短信/推送；优惠叠加；PENDING_PAYMENT。
```

---

## 执行 charting 的步骤（重开 session 后照做）

1. **确认连接器可用**：先 `list_issues` 探一次。若工具仍不可见，说明连接器绑定又在 session 之后了，需要再重开一次并**在重开前不要改动连接器**。
2. **低分辨率 grill 一轮**，确认 Destination 与 Out of scope 没跑偏（本文件已给出建议值），然后建 map（label `wayfinder:map`）。
3. **建 13 个 child issue**：R1–R3、D1–D7、P1、T1、T2。加对应 `wayfinder:<type>` label。child 用 GitHub sub-issues；未启用则退化为 map body 的 task list + child body 顶部 `Part of #<map>`。
4. **第二遍 wire blocking edges**（需要 blocker 的 **database id**，不是 `#number`）。
5. **并行启动 R1 / R2 / R3 三个 `/research` subagent**；findings 存一次性 `research/<name>` branch，并从 ticket 留 context pointer。
6. **停止**。Charting 是一个 session 的工作，**本 session 不 resolve 任何 ticket**。

---

## Tracker 注意事项（踩过的坑）

- 本仓库 `docs/agents/issue-tracker.md` 声明 tracker = **GitHub Issues `fantasywy/smart-locker-app`**，操作走 `gh` CLI。
- **本机没有 `gh` CLI**（Arch Linux + pacman；沙箱内 `sudo` 不可用，`/etc/sudo.conf` 被映射成 uid 65534）。`gh`、`glab` 均未安装。
- GitHub **连接器**已 `bound: true, enabled: true`，endpoint `https://api.githubcopilot.com/mcp/`（可达；未认证 401），凭据以 `Authorization` header override 加密存于 `~/.workbuddy/connectors/<id>/connector-states.json`。
- **坑**：连接器的 MCP 工具**没有注入到「绑定它」的那个 session** —— 工具注册只在 session 边界发生。绑定后必须**新开一个 session** 才看得到工具。已验证：在旧 session 里搜 `create_issue` / `list_issues` / `get_me` 全部落空，直接调用返回 `not found in the deferred tools index`。
- 仓库是**私有**的（未认证 API 返回 `Not Found`），因此**没有**绕过凭据的只读路径。
- 连接器工具补上后的等价操作名：`create_issue` / `list_issues` / `get_issue` / `update_issue` / `add_issue_comment` / `sub_issue_write`。`docs/agents/issue-tracker.md` 里的 `gh` 命令可逐条对译。
- 备用降级路径（仅在连接器彻底不可用时启用）：按兄弟仓库惯例把 map 落到 `.scratch/smart-locker-app/`（`spec.md` + `issues/NN-slug.md`，`Status:` 行记状态、评论追加到 `## Comments`），之后再整体迁到 GitHub Issues。
