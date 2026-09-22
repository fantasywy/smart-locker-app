## Destination

一份可实现的小程序 C 端设计规格：信息架构、页面清单、关键流程时序、后端接口映射、**异常态与降级口径**、与柜机中控屏的职责边界。做到实现者可单独开工。不写实现代码。

spec 正文落 `docs/spec/`（跟 repo 走，可 diff、可 review）；本 issue 只承载决策与 ticket 状态。

## Notes

- **术语事实源**：`java/smart-locker/CONTEXT.md`（上游领域术语）。本仓库的 `CONTEXT.md` **已于 2026-09-21 由 D2 建立**（single-context，首个 glossary：柜机码 / 中控屏 / 开门指令 / 取件码 / 取件开门 / 存入 / 取件）。
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
- **开门这件事的事实源**（D2 期间核定）：**开门只能由服务端下发的 `OPEN_CELL` 指令驱动**（device `docs/adr/0003`）；指令来源**只有三个** —— `13.7` 下单（`USER_DROP`）、`13.11` 支付（`USER_PICKUP`，**支付即开门**）、管理端手动（`ADMIN_FORCE`）。**屏端 `pickup-verify` 不产生任何指令**（只回摘要 + `paid` + `hint`）⇒ 屏上的取件码校验从不开门。另：一期 `13.11` 响应的 `paid` 与 `openCommandIssued` **都写死 `true`**（`AppOrderServiceImpl.java:199`），不可当作「指令已下发」的证据。
- **参考仓库中与 C 端无关的表面**（避免走偏）：admin 是纯运营台，其 `users` 模块的信用分/黑名单是**管理端视角**；device 的「本地演示开门」绕过服务端、**不是**后端 `ADMIN_FORCE`。
- **Skills**：`/grilling`（HITL 决策）、`/domain-modeling`（术语落库）、`/research`（AFK 事实核查）。

## Research results（AFK findings，已落分支）

三张 R 票的 findings 均已就位，各自在一条一次性分支上。**已于 2026-09-20 resolve（关闭）**，随之解锁 D1 / D4 / D5 / D6（R1）、D2（R2）、D3（R3）。context pointer 已追加到下方 Decisions so far。

| 票 | 分支 | 文件 | 一句话结论 |
|---|---|---|---|
| R1 | `research/r1-api-mapping` | `docs/research/R1-api-mapping.md` | 16 端点逐条契约 + 四类时序 + 令牌判定式 + 15 条字段陷阱。~~`/lockers/by-code` 鉴权自相矛盾~~ **已更正（2026-09-20，D1 grilling 期间复核）**：`13.6` **需要 access，不是冲突** —— `§1` 例外清单（`API设计文档.md:25`）是**命名风格例外**（紧接 `:24` 的 RESTful 命名说明），`§16 #29`（`:1359`）明写「**需登录态**」，与总则 `:917` 一致 |
| R2 | `research/r2-pickup-code-semantics` | `docs/research/R2-pickup-code-semantics.md` | 扫码 tab 是**柜机码**、屏端**无入站扫码能力** →「二维码给屏扫」不可行；取件码 6 位同柜机唯一、核销后稳定 `CONSUMED` |
| R3 | `research/r3-open-gaps` | `docs/research/R3-open-gaps.md` | N1 / N2 / N4 **后端均已闭合**；唯一真缺口是 `openedNotClosed` 不在 C 端 §13.9（登记挂账，本 effort 不提议改后端） |

## Decisions so far

- **R1 resolved**（`#2`，2026-09-20）—— 16 端点逐条契约 + 四类时序 + 令牌判定式（`401+2001` 静默刷新一次 / `401+2005` 清登录态）+ 15 条字段陷阱。findings：分支 `research/r1-api-mapping`，文件 `docs/research/R1-api-mapping.md`。**遗留待办（非本 effort）**：登出鉴权、积分明细响应形状、柜机不存在归 `4004`/`4001` 三处未明确。（`/lockers/by-code` 鉴权一项**已闭合**：经 D1 grilling 复核为「需 access」，见上方 Research results 行的更正；findings 分支已同步更正 commit `e3085c3`。）**解锁** D1 / D4 / D5 / D6。
- **R2 resolved**（`#3`，2026-09-20）—— 扫码 tab 内容是**柜机码**（`TerminalScanTab.vue:25-28` + 测试断言 `WD-02`），屏端**无入站扫码能力** →「小程序出二维码给屏扫」不可行且屏侧改造属 Out of scope；`pickup-verify` 契约与取件码生命周期（6 位、同柜机唯一不复用、核销后稳定 `CONSUMED`、屏端永不展示）已固化。findings：分支 `research/r2-pickup-code-semantics`。**解锁** D2。
- **R3 resolved**（`#4`，2026-09-20）—— 三项「未闭合口径」后端**其实均已闭合**（N1 正确字段名是 `openedNotClosed`、拼写错的是管理端暂定名；N2 未存入 `startAt` 为空；N4 后端明示不拆分、拆分权在 C 端）。**唯一真缺口**：`openedNotClosed` 不在 C 端契约 §13.9 → 保守方向（漏报）或登记联调挂账，本 effort 不提议改后端。findings：分支 `research/r3-open-gaps`。**解锁** D3。
- **Destination 口径**：草稿照抄，但「异常与文案口径」收窄为「**异常态与降级口径**」—— 文案表是 T1 的产出物，不挂在 destination 上。
- **spec 载体**：spec 正文落 `docs/spec/`；GitHub issue 只承载决策与 ticket 状态。`.scratch/` 按仓库约定是 throwaway，destination 不住那里。
- **Out of scope 复审**：短信/推送通知、部分退款、`PENDING_PAYMENT` 三项确认为一期不做；其余 6 条（实现代码、真实微信支付、后端/管理端/固件改动、优惠叠加）无翻案空间。
- **T2 不依赖 D7**：T2 先按原生 TS + SCSS 出变量层草案供 D7 比较；若 D7 选跨端框架需重做变量层。加依赖会把 frontier 收窄，故不加。
- **D1 resolved**（`#5`，2026-09-20）—— **入口与身份模型**。11 条裁决 + 3 条派生推论，四轮 grilling 收口。要点：① 扫码两条通道都做（小程序内 `wx.scanCode` + 微信「扫一扫」直达），**柜机码载荷统一为 URL** `https://<域名>/l/{lockerCode}`，三来源（`q` / `options.code` / `scanCode.result`）收敛成一个 `resolveLockerCode()`；② **隐式前置登录**（冷启动静默 `wx.login` → `13.1`），**不设「登录按钮」概念**；`401+2001` 刷新一次重放 / `401+2005` 清态自动重登一次，**重放对写请求也安全**（401 由鉴权拦截器在业务逻辑前返回 ⇒ 请求未执行），**重登也失败即丢弃原动作、不后台补发**；③ 页面骨架 **两 tab（订单 / 我的）**，首页 = 订单列表 + 顶部常驻「扫码存件」，柜机页为非 tab 独立页；④ 冷启动 = 骨架屏 + **全局唯一**失败出口，**不做本地业务数据缓存**；⑤ **柜机上下文 = 页面参数**，禁止隐式记住上次柜机；⑥ 「我的」页 = 资料 + 积分 + 积分明细 + 静态出口，**不做退出登录**（有意，非漏做）。产物：**`docs/spec/01-entry-and-identity.md`**、**`docs/adr/0001-c-end-no-locker-browsing.md`**（跨仓库共识「C 端不做柜机浏览、柜机上下文只能来自扫码」）。**顺带闭合** R1 的 `/lockers/by-code` 鉴权项（需 access）。**顺带给 P1 记了一处前置缺口**：P1 票面只说「等待关门**等待态**」，未澄清是独立页还是列表内状态，开工前须补一问。
- **D2 resolved**（`#6`，2026-09-21）—— **小程序 × 中控屏职责边界：取件码怎么流转**。三轮 grilling 收口。**票面前提被推翻**：开门只能由服务端 `OPEN_CELL` 指令驱动，而**屏端 `pickup-verify` 不产生任何指令** ⇒ **屏 = 只读查询台**（查状态 + 应付参考 + 引导语）、**小程序 = 唯一开门发起方**；**取件码没有开门力**，它是「带到屏上敲」的**查询凭据**，不是取件凭据。要点：① 码只在**订单详情页的固定取件区块**常驻可见，列表行内不铺码、不做防截屏、不做自动隐藏；② C 端唯一的开门动作叫「**取件开门**」（与屏端 hint 逐字对齐），实现 = **幂等调用 `13.11`**，未清账先清账、已清账只重发指令，**重试入口就是同一个按钮**，**按钮不承载金额**（`estimatedAmount` 只是参考快照）；③ 派生判定：能不能取件 = `pickupCode !== null`（与 `13.11` 准入、`14.6` 校验同源）、付没付清 = `payAmount !== null`（⚠️ 全免单是 0 元 `SUCCESS` 支付单，用 `> 0` 会误判）；④ 点完只能说「已发出开门指令」+ 等待态，**不许渲染「门已开」**；⑤ 九态对齐是**语义级**的 —— C 端看不到屏的显示态，屏的「待机/输入中/校验中/无效/传输失败/业务拒绝」都是屏侧局部态；⑥ 「把码发给别人代取」判死（开门只认本人 token）；取件不可达的唯一人工出口 = 客服 → 管理端 `ADMIN_FORCE`。产物：**`docs/spec/02-c-end-device-boundary.md`**、**新建 repo root `CONTEXT.md`**。**屏侧无需改动**，只有两条登记项（屏上 hint 术语同步、屏端键盘按钮文案「开门」的观感冲突）。**给 P1 留了输入**：等待态只能建立在轮询上、只能陈述「已发出指令」。
- **D3 resolved**（`#7`，2026-09-21）—— **订单首页信息架构**。两轮 grilling 收口（7 + 6 问，两次均按推荐）。要点：① **单流不分组** —— 不做 tab / 分段标题 / 筛选器：`13.8` 只接受**单个** `status`，列表项**没有 `createdAt`**、服务端固定 `id DESC`，任何分组都要客户端自造一套与枚举错位的筛选语义；② **第一页内在途上浮**、**跨页不置顶**（服务端不支持多值过滤）、不加分隔标题；③ **11 枚举 → 9 显示态**（待存入 / 使用中 / 待取件 / 已超时 / 已取件 / 已取消 / 已结束 / 已退款 + `PENDING_PAYMENT` 兜底）——「已取件」合并 `COMPLETED` 与补缴取件后的 `TIMEOUT`；**「已超时」刻意不二分已补缴/未补缴**（`TIMEOUT` 应收继续累积，客户端判不出）；④ **行内不给金额、不给动作、不铺取件码**，整行进详情；⑤ **不做未存入倒计时**（`openTimeoutMinutes` 只在 `13.7` 建单响应里，真实截止是两段式且 `openAcked` C 端不可见 ⇒ 倒计时必然说谎；唯一合法位置是 P1 的建单等待态）；⑥ `onShow` + 下拉刷新**均重置回第一页**，列表**不轮询**（真正轮询归 P1 详情页）；⑦ 语义档 = 警示 / 正常 / 危险 / 中性，语义色只做色条与标签背景/边框、**标签文字一律走 ink**（承 V25）；⑧ `pageSize=20` + 上拉加载，终止条件靠 `total`（越界**钳制到末页**）。产物：**`docs/spec/03-order-list.md`**。**顺带就地补正 `docs/spec/02-c-end-device-boundary.md`**：§6「已存入、已付清」限定为**仅 `IN_PROGRESS`**、`TIMEOUT` 行改「**无论已付多少**」都走「补缴并开门」；§7 派生判定改为 **`payAmount !== null ∧ status === IN_PROGRESS`**（已支付未关门的单会转 `TIMEOUT` 且应收继续累积，旧口径会让按钮文案说谎；差额细节仍归 D6）。**登记项**：物理门号 `01`–`15` 与 `cellNo` 不同源（不改两边 —— 开哪个门由服务端指令决定）；「开门未闭」C 端无字段 ⇒ **漏报** + 联调挂账。**解锁** T1。

## Not yet specified

黑名单与低信用分的降级体验；预约占位窗口的用户表达；支付一期形态；技术栈与工程形态；视觉语言移植。（「取件码在小程序与柜机屏之间的流转」已于 2026-09-21 由 D2 graduate 成 `#6` 并 resolve；「订单首页对未存入/使用中/异常的表达」已于 2026-09-21 由 D3 `#7` resolve，产物 `docs/spec/03-order-list.md`；「C 端文案体系」已是 live ticket T1 `#13`。）

## Out of scope

小程序实现代码；真实微信支付接入与 `/pay/notify` 回调（后端明确二期）；部分退款（二期，一期仅全额）；**后端任何改动**（未闭合口径只做「C 端如何消费」的裁定）；管理端任何改动；柜机固件 / 中控屏任何改动；短信与推送通知（系统无推送通道，拉取是唯一途径）；优惠 / 活动叠加（二期）；`PENDING_PAYMENT` 待支付状态（一期不启用，枚举预留）。

## Tickets

见本 issue 的 sub-issues。Ticket 类型由 label 区分：`wayfinder:research`（AFK）/ `wayfinder:grilling` / `wayfinder:prototype` / `wayfinder:task`。Blocking 用 GitHub native issue dependencies。

**Frontier（可立即开）**：D4、D5、D6、D7、P1、T1、T2 —— R1/R2/R3（2026-09-20）、**D1**（2026-09-20）、**D2**（2026-09-21）、**D3**（2026-09-21）关闭后，**全部子票解锁**（含此前被 D3 阻塞的 T1）。

**D1 已 resolve（`#5`，2026-09-20）** —— 产物 `docs/spec/01-entry-and-identity.md` + `docs/adr/0001-c-end-no-locker-browsing.md`。⚠️ **ADR 编号**：D1 占 `0001`，故 D7（`#11`）票面里的 `docs/adr/0001-<技术栈>.md` 应顺延为 `0002`（票面已同步改）。

**D2 已 resolve（`#6`，2026-09-21）** —— 产物 `docs/spec/02-c-end-device-boundary.md` + `CONTEXT.md`。**屏侧不需要改**；两条登记项见该票的「移交说明」。

**D3 已 resolve（`#7`，2026-09-21）** —— 产物 `docs/spec/03-order-list.md`；并**就地补正**了 `docs/spec/02-c-end-device-boundary.md` §6/§7 的「付没付清」口径（限定到 `IN_PROGRESS`）。两条登记项见 `03` §10。**T1（`#13`）随之解锁**。



