## Destination

一份可实现的小程序 C 端设计规格：信息架构、页面清单、关键流程时序、后端接口映射、**异常态与降级口径**、与柜机中控屏的职责边界。做到实现者可单独开工。不写实现代码。

spec 正文落 `docs/spec/`（跟 repo 走，可 diff、可 review）；本 issue 只承载决策与 ticket 状态。

## Notes

- **术语事实源**：`java/smart-locker/CONTEXT.md`。本仓库尚无 `CONTEXT.md`，按 `docs/agents/domain.md` 的「缺失时静默继续」处理；术语真正落定时由 `/domain-modeling` 懒创建。
- **契约源**：`java/smart-locker/docs/API设计文档.md` v1.0 —— 用户端 §13（`/api/app/v1/**`）、错误码 §15、契约增量 §16。
- **不可违反的既有设计**（conformance，不是待议项）：
  - **一期柜机屏不承载支付** —— 真出处是 `java/smart-locker/docs/API设计文档.md:1257`（§14.6）与屏端 `vue/smart-locker-device/src/device/pickup.ts:19-21`；`/pickup-verify` 返回 `paid:false` 时引导用户「去小程序支付」。
    - ⚠️ **更正**（由 R2 findings 推翻原记载，已独立复核）：**device ADR-0003 与支付无关**，其主题是「开门只由指令驱动，点击门 = 模拟用户关门」（`0003-door-opens-only-by-command.md`）。charting 简报把这条约束的出处挂错了。
  - 中控屏九态（**显示态**）：待机 / 输入中 / 校验中 / 已付清 / 待支付 / 无效 / 已核销 / 传输失败 / 业务拒绝 —— 事实源 `vue/smart-locker-device/src/device/terminal.ts`。
    - ⚠️ **更正**：底层 `TerminalStatus` 枚举**只有 7 个值**，九态是**显示态**（待机/输入中共用 `input`，已付清/待支付共用 `matched`）。完整触发表见 R2 findings §4。
  - `vue/smart-locker-device/.scratch/device-simulator/spec.md` §12（V1–V25）：色调层五档、语义色只做背景/边框/圆点/色条、文字一律走 ink。
- **工程约定**：`smart-locker-admin/docs/adr/0002` —— 前端不得自造契约，一律引后端 v1.0。
- **后端事实**：用户端 16 个端点已实现且带测试。**没有**「站点列表」端点 —— C 端只能按 `code` 反查柜机。
- **设备端事实**：`DOOR_CLOSED` 才驱动订单状态与计时起点，`OPEN_CELL` 不改订单状态；指令 `PENDING → SENT → DONE/FAILED`，`SENT` 超 5min → `EXPIRED`，**失败/过期不自动重发**；取件码 6 位数字、同一柜机内唯一、存入关门后生成。
- **参考仓库中与 C 端无关的表面**（避免走偏）：admin 是纯运营台，其 `users` 模块的信用分/黑名单是**管理端视角**；device 的「本地演示开门」绕过服务端、**不是**后端 `ADMIN_FORCE`。
- **Skills**：`/grilling`（HITL 决策）、`/domain-modeling`（术语落库）、`/research`（AFK 事实核查）。

## Research results（AFK findings，已落分支）

三张 R 票的 findings 均已就位，各自在一条一次性分支上。**已于 2026-09-20 resolve（关闭）**，随之解锁 D1 / D4 / D5 / D6（R1）、D2（R2）、D3（R3）。context pointer 已追加到下方 Decisions so far。

| 票 | 分支 | 文件 | 一句话结论 |
|---|---|---|---|
| R1 | `research/r1-api-mapping` | `docs/research/R1-api-mapping.md` | 16 端点逐条契约 + 四类时序 + 令牌判定式 + 15 条字段陷阱；`/lockers/by-code` 鉴权自相矛盾（卡 D1） |
| R2 | `research/r2-pickup-code-semantics` | `docs/research/R2-pickup-code-semantics.md` | 扫码 tab 是**柜机码**、屏端**无入站扫码能力** →「二维码给屏扫」不可行；取件码 6 位同柜机唯一、核销后稳定 `CONSUMED` |
| R3 | `research/r3-open-gaps` | `docs/research/R3-open-gaps.md` | N1 / N2 / N4 **后端均已闭合**；唯一真缺口是 `openedNotClosed` 不在 C 端 §13.9（登记挂账，本 effort 不提议改后端） |

## Decisions so far

- **R1 resolved**（`#2`，2026-09-20）—— 16 端点逐条契约 + 四类时序 + 令牌判定式（`401+2001` 静默刷新一次 / `401+2005` 清登录态）+ 15 条字段陷阱。findings：分支 `research/r1-api-mapping`，文件 `docs/research/R1-api-mapping.md`。**遗留待办（非本 effort）**：`/lockers/by-code` 鉴权自相矛盾需向后端确认；登出鉴权、积分明细响应形状、柜机不存在归 `4004`/`4001` 三处未明确。**解锁** D1 / D4 / D5 / D6。
- **R2 resolved**（`#3`，2026-09-20）—— 扫码 tab 内容是**柜机码**（`TerminalScanTab.vue:25-28` + 测试断言 `WD-02`），屏端**无入站扫码能力** →「小程序出二维码给屏扫」不可行且屏侧改造属 Out of scope；`pickup-verify` 契约与取件码生命周期（6 位、同柜机唯一不复用、核销后稳定 `CONSUMED`、屏端永不展示）已固化。findings：分支 `research/r2-pickup-code-semantics`。**解锁** D2。
- **R3 resolved**（`#4`，2026-09-20）—— 三项「未闭合口径」后端**其实均已闭合**（N1 正确字段名是 `openedNotClosed`、拼写错的是管理端暂定名；N2 未存入 `startAt` 为空；N4 后端明示不拆分、拆分权在 C 端）。**唯一真缺口**：`openedNotClosed` 不在 C 端契约 §13.9 → 保守方向（漏报）或登记联调挂账，本 effort 不提议改后端。findings：分支 `research/r3-open-gaps`。**解锁** D3。
- **Destination 口径**：草稿照抄，但「异常与文案口径」收窄为「**异常态与降级口径**」—— 文案表是 T1 的产出物，不挂在 destination 上。
- **spec 载体**：spec 正文落 `docs/spec/`；GitHub issue 只承载决策与 ticket 状态。`.scratch/` 按仓库约定是 throwaway，destination 不住那里。
- **Out of scope 复审**：短信/推送通知、部分退款、`PENDING_PAYMENT` 三项确认为一期不做；其余 6 条（实现代码、真实微信支付、后端/管理端/固件改动、优惠叠加）无翻案空间。
- **T2 不依赖 D7**：T2 先按原生 TS + SCSS 出变量层草案供 D7 比较；若 D7 选跨端框架需重做变量层。加依赖会把 frontier 收窄，故不加。

## Not yet specified

入口与身份模型；取件码在小程序与柜机屏之间的流转；订单首页对未存入/使用中/异常的表达；黑名单与低信用分的降级体验；预约占位窗口的用户表达；支付一期形态；C 端文案体系；技术栈与工程形态；视觉语言移植。

## Out of scope

小程序实现代码；真实微信支付接入与 `/pay/notify` 回调（后端明确二期）；部分退款（二期，一期仅全额）；**后端任何改动**（未闭合口径只做「C 端如何消费」的裁定）；管理端任何改动；柜机固件 / 中控屏任何改动；短信与推送通知（系统无推送通道，拉取是唯一途径）；优惠 / 活动叠加（二期）；`PENDING_PAYMENT` 待支付状态（一期不启用，枚举预留）。

## Tickets

见本 issue 的 sub-issues。Ticket 类型由 label 区分：`wayfinder:research`（AFK）/ `wayfinder:grilling` / `wayfinder:prototype` / `wayfinder:task`。Blocking 用 GitHub native issue dependencies。

**Frontier（可立即开）**：D1、D2、D3、D4、D5、D6、D7、P1、T2 —— R1/R2/R3 于 2026-09-20 关闭后，除 T1 外全部解锁；**T1 仍被 D3 阻塞**。
