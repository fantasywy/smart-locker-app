# R3 — 三个未闭合口径在后端文档里的确切表述

> 调研对象：`fantasywy/smart-locker-app` issue #4（R3）。
> 范围：只读调研，仅 C 端（微信小程序）「如何消费」裁定；不改后端、不改管理端、不写 GitHub。
> 事实源优先级：**后端文档优先**；管理端两个文件（`.scratch/.../06-pre-integration-fixlist.md`、`CONTEXT.md`）只是线索，不当后端事实。
> 核心结论（先说）：**管理端 fixlist 把三项登记为「待联调确认 / 后端未给字段名」，但后端文档其实都已声明**——「未闭合口径」基本已被后端闭合，剩下的是 C 端侧可自行裁定的渲染/筛选决策。

---

## N1 — `openNotClosed`（开门未闭）

### 1. 后端原文引用

后端**已给出确切字段名与类型**，并非「未给字段名」：

- `java/smart-locker/docs/API设计文档.md:1340`（契约增量 #12）：
  > 管理端订单详情新增**「开门未闭」**异常标记展示（需求 4.1 / ADR-0002）：指令已回执 `DONE` 且延长一程后仍无关门确认的订单，详情响应 `order.openedNotClosed=true`（**布尔字段追加**，终局订单恒 `false`；格口保持 `RESERVED` 待管理端核验）

- `java/smart-locker/docs/API设计文档.md:493`（§16 详情后端实现要点）：
  > `order.openedNotClosed`（契约增量 #12 / ADR-0002）：开门未闭标记存在**且订单仍在途**（`IN_PROGRESS`）时为 `true`；迟到关门确认（14.4 规则 1）或强制结束/退款闭合后为 `false`，**终局订单恒 `false`**。

- `java/smart-locker/CONTEXT.md:33-35`（概念定义）：
  > **开门未闭（Opened-not-closed）**：开门指令已被设备回执 `DONE` 但迟迟没有关门确认的异常订单……打上该标记（订单级字段、格口保持 `RESERVED`）……文档旧称「占用异常」。

- `java/smart-locker/docs/API设计文档.md:1363`（一期联调核对，契约测试守护）：
  > #12 详情 `openedNotClosed`（`AdminOrderControllerTest` / `JourneyTwoOpenedNotClosedReviewTest`）

**关键限制（C 端相关）**：上述字段只挂在**管理端订单详情（§7.2）**。C 端详情契约 `§13.9`（`API设计文档.md:1027-1047`）的 `order` 块字段为 `id/orderNo/status/baseFee/overtimeFee/discount/payAmount/startAt/endAt/estimatedAmount/pickupCode`，**不含 `openedNotClosed`**。C 端列表 `§13.8`（`API设计文档.md:1000-1025`）同样不含。

> 另：管理端 fixlist `06-pre-integration-fixlist.md:86` 记前端暂定 `order.openNotClosed`，**拼写为错**（正确是 `openedNotClosed`，过去分词）。管理端「以后端为准」的暂定名本身就是错的，需在联调改名——但这不构成「后端未声明」。

### 2. 判定

**C 端可自行裁定**（安全方向），但带一个联调挂账项。

- 字段名/类型后端已闭合，管理端「未给字段名」的登记是**误报**。
- 但 `openedNotClosed` **不在 C 端契约（§13.9）内**，所以 C 端当下无法消费该异常标记。

### 3. C 端消费规则

- **保守方向（漏报而非误报）**：C 端详情/列表不渲染「开门未闭」标记；因字段在 C 端契约内缺失，`undefined/false` 一律视为「非异常」，不会误报。
- **若需在 C 端展示此异常**：须后端把 `openedNotClosed` 加入 `§13.9` 响应（契约增量）。这属于后端契约改动，**超出本次范围、不在本 effort 提议**；作为联调挂账项登记（与 N1 字段改名一并）。
- 不要用管理端暂定名 `openNotClosed` 去对字段；以后端 `openedNotClosed` 为准。

---

## N2 — `Order.startAt` 未存入时为空

### 1. 后端原文引用

后端**明确声明**未存入阶段 `startAt` 为空，且多处一致：

- `java/smart-locker/docs/需求分析文档.md:451`（§11 #5 开放默认值）：
  > **未存入阶段展示**：`IN_PROGRESS` 未存入时管理端列表 `startAt` 为空；今日订单拆分不区分未存入。

- `java/smart-locker/docs/需求分析文档.md:151`：
  > 分配空闲格口……订单置 `IN_PROGRESS`（`startAt` 为空，表示未完成存入）

- `java/smart-locker/docs/需求分析文档.md:181 / 185`：
  > `IN_PROGRESS`（未存入，`startAt=null`）……`IN_PROGRESS`（使用中，`startAt=关门时间`）

- `java/smart-locker/docs/API设计文档.md:995`：
  > 分配空闲格口（`FREE → RESERVED`）；创建订单 `IN_PROGRESS`（`startAt=null`）

- `java/smart-locker/docs/API设计文档.md:1213`：
  > 匹配**未存入订单**（`IN_PROGRESS` 且 `startAt` 为空）→ `startAt` = 服务器接收时间

- `java/smart-locker/docs/API设计文档.md:1021`（§13.8 实现要点，确认 C 端侧可空）：
  > `estimatedAmount` 仅在「已存入且未结算」（`IN_PROGRESS|TIMEOUT` 且 `startAt` 非空）时现算，未存入（无计时起点）与已终局订单一律 `null`

> 管理端 fixlist `06-pre-integration-fixlist.md:87` 称「后端需求 §11 #5『未存入时管理端列表 startAt 为空』」——这与后端原文一致，说明管理端**已读到**后端声明，其「类型不精确（非空 string）」只是管理端本地 TS 类型问题，运行期靠 `formatDateTime` 渲染「—」已安全。C 端同理。

### 2. 判定

**C 端可自行裁定。** 后端已给出完整口径，`startAt` 为可空字段，未存入 = `IN_PROGRESS && startAt === null`。

### 3. C 端消费规则

- `startAt` 在 C 端类型层放宽/视为可选（`string | null`）。
- 为空时：时间列渲染「—」（或「未存入」/「待存入」），**不报错、不误报时段**。
- 排序/筛选：把 `startAt === null` 的订单排在「未存入」分组；计时类展示（已用时长、预估费用 `estimatedAmount`）后端已对未存入返回 `null`，C 端直接「无」即可。
- 安全方向：缺失/空一律按「未存入」保守处理，不臆造时间。

---

## N4 — 「未存入」列表筛选与「使用中」分开

### 1. 后端原文引用

后端**明确选择不拆分**，且列表 API 未给独立筛选项——拆分是纯前端派生决策：

- `java/smart-locker/docs/需求分析文档.md:451`（§11 #5）：
  > `IN_PROGRESS` 未存入时管理端列表 `startAt` 为空；**今日订单拆分不区分未存入**。

- `java/smart-locker/docs/API设计文档.md:1357`（契约增量 #28 ②，看板口径）：
  > 未存入订单计入 `inProgress`，故拆分「**不区分未存入**」

- 列表 API 仅提供 `status` 枚举，无独立「未存入」值：
  - `java/smart-locker/docs/API设计文档.md:440`（管理端 §7.1）：`status`（`PENDING_PAYMENT|IN_PROGRESS|COMPLETED|TIMEOUT|FORCE_ENDED|REFUNDED|CANCELLED`）
  - `java/smart-locker/docs/API设计文档.md:1002`（C 端 §13.8）：`status`（同管理端 7.1 枚举，可空=全部）

> 管理端 `CONTEXT.md:26` 写「列表筛选与『使用中』分开」，那是**管理端自己的前端文档口径**，不是后端契约；后端反而明示「不区分」（见上）。管理端 `06-pre-integration-fixlist.md:90` 据此登记 N4 为待确认——但后端事实是「不强制拆分 + 列表无独立筛选项」。

### 2. 判定

**C 端可自行裁定。** 后端未强制拆分，且已提供足够数据（`status` + 可空 `startAt`）让 C 端在客户端派生「未存入」（`status===IN_PROGRESS && startAt===null`）与「使用中」（`status===IN_PROGRESS && startAt!==null`）。是否分列是 C 端设计选择。

### 3. C 端消费规则

- 是否在「我的订单」列表把 `IN_PROGRESS` 按 `startAt` 空值拆成「未存入 / 使用中」两个标签/分组，由 C 端自行决定。
- 派生公式：`未存入 = status==='IN_PROGRESS' && !startAt`；`使用中 = status==='IN_PROGRESS' && !!startAt`。
- 安全方向：默认合并展示为「进行中」也不误事；若拆分，未存入单不应显示计时/费用（后端已给 `null`）。

---

## 总额外说明：这三项如何决定「订单首页如何表达 未存入 / 使用中 / 异常」（issue #7 输入）

三项里 **N2 与 N4 直接框定 issue #7 的设计空间**，N1 限定「异常」表达的可得性：

1. **N2（startAt 可空）** = 区分「未存入 / 使用中」的**唯一数据信号**。`startAt===null` 就是「未存入」的判定源；没有它，首页无法表达这两态。后端已确认可空 → issue #7 可放心用该信号。
2. **N4（是否拆分）** = 首页是否把这两态**分列展示/分标签**的决策权。后端明示「不强制拆分、列表无独立筛选项」，故 issue #7 可二选一（合并为「进行中」或拆成「未存入 / 使用中」），纯 C 端 UI 决策，无契约风险。
3. **N1（openedNotClosed）** = 「异常（开门未闭）」态的表达依据，但**该字段不在 C 端契约 §13.9**。因此 issue #7 当前**无法在 C 端可靠渲染「开门未闭」异常标记**——要么首页对该异常态暂时留白（漏报而非误报），要么把「在 §13.9 加 `openedNotClosed`」作为联调挂账项提出。这直接收窄了 issue #7 的「异常」表达设计空间。

即：未存入/使用中两态的数据与拆分权后端都已给足（N2、N4 闭合），issue #7 可立即设计；唯「异常」态受 C 端契约缺字段制约（N1），需联调时定。

---

## 推翻题目预设的结论

管理端 `06-pre-integration-fixlist.md`（N1 L86、N2 L87、N4 L90）把三项登记为「后端未给字段名 / 待联调确认」。但逐条核对后端文档后：

- **N1**：后端已命名 `order.openedNotClosed`（布尔），见 `API设计文档.md:1340`、`:493`、`:1363`、及 `CONTEXT.md:33-35`。管理端「未给字段名」为**误登记**（且其暂定名 `openNotClosed` 拼写错）。唯一真实缺口是：该字段**不在 C 端契约 §13.9**。
- **N2**：后端明确「未存入 `startAt` 为空」，见 `需求分析文档.md:451`、`:151`、`:181`、`:185` 及 `API设计文档.md:995`、`:1213`、`:1021`。已闭合。
- **N4**：后端明确「今日订单拆分不区分未存入」（`需求分析文档.md:451`、`API设计文档.md:1357` ②），列表 API 无独立筛选项。拆分是 C 端派生决策，已闭合。

**结论：三项「未闭合口径」在后端文档里实际均已闭合/可派生；真正需要联调挂账的只有一项——把 `openedNotClosed` 加入 C 端 §13.9（或确认 C 端不需展示该异常）。** 其余均可由 C 端自行裁定。
