# R2 — 取件码与中控屏「扫码」tab 的真实语义（事实基线）

> 只读调研产物。本文件只给**事实 + 可行性**，不给设计裁决（裁决属 D2）。
> 标注约定：✅ = 代码里确实这么写（附 文件路径:行号）；🔍 = 从命名/注释/结构推断，非直接代码证据。
> 所有结论均可回溯到 `vue/smart-locker-device`、`java/smart-locker` 的源码与文档。

---

## 0. 对题面两条线索的纠正（先说清，免得误读）

1. **「ADR 0003 定义中控屏不承载支付」不成立。**
   ✅ ADR 0003 实际文件是 `vue/smart-locker-device/docs/adr/0003-door-opens-only-by-command.md`，主题是「开门只由 `OPEN_CELL` 指令驱动、点击门=模拟关门」。与支付无关。
   ✅ 「一期柜机屏不承载支付」这句话的真实出处是 `java/smart-locker/docs/API设计文档.md:1257`，以及屏端 `vue/.../device/pickup.ts:19-21` 的注释。本文件按这两处真实来源引用，不按 ADR 0003 引用。
2. **C 端（smart-locker-app）目前没有任何取件码代码。**
   ✅ 在 `smart-locker-app` 全仓 grep `pickupCode|取件码|pickup` 命中 0 处（仅 `typings/types/wx` 微信自带类型里的 `code` 无关）。即：小程序尚未实现取件码的展示/重展示——这是「谁能重新展示取件码」一条的关键事实。

---

## 1. `TerminalScanTab` 的扫码内容：是柜机码，不是取件码

**结论（代码证据，非推断）：扫码 tab 显示的二维码内容 = 柜机码（`deviceCode`），与取件码完全无关。**

- ✅ `TerminalScanTab.vue:25-28`：`template = loadTerminalConfig().qrTemplate`；`lockerCode = loadCredential().deviceCode`；`content = resolveQrContent(template, { lockerCode })`。即内容只由「模板 × 设备身份里的 deviceCode」算出，**没有任何 pickupCode 参与**。
- ✅ `terminal-config.ts:25`：`DEFAULT_QR_TEMPLATE = '{lockerCode}'`；`terminal-config.ts:122-126`：`resolveQrContent` 把 `{lockerCode}` 替换为 `deviceCode`，凭证为空时原样回落成字面量 `{lockerCode}`。
- ✅ `terminal-scan.spec.ts:42-46`：默认模板下断言 `码内容：WD-02`（`WD-02` 是 deviceCode，非取件码）。`terminal-scan.spec.ts:54-58`：凭证为空时显示字面量 `{lockerCode}`。测试只断言「内容与结构」，不断言像素（`terminal-scan.spec.ts:1-8`）——像素比对属 acceptance-09，不在本文件范围。
- ✅ 该 QR 的用途（下游）：`TerminalScanTab.vue:53` 引导语「请使用手机微信/小程序扫描二维码」；`TerminalPanel.vue:5` 注释称它是「真实二维码（内容走可配置模板，默认 `{lockerCode}`；与 3D 贴图同源）」。
  - 🔍 **推断**：这块码是给手机「扫柜机」用的（让小程序识别当前是哪台柜机），属于**柜机→手机**方向。vue 代码里没有定义「手机扫到柜机码之后做什么」的逻辑——这部分是 C 端/小程序侧的职责，本文件不替它下结论。
- ✅ **关键区分**：扫码 tab 的产出**不会**回流进 `pickup-verify`。取件码来自屏上键盘（`TerminalKeypadTab`）的 6 位键入，经 `pickup.ts:buildPickupPayload` 组装成 `pickupCode` 字段提交。扫码 tab 是纯 outbound 展示。

---

## 2. `POST /api/device/v1/pickup-verify` 完整契约

事实源：`java/.../docs/API设计文档.md:1233-1266`（§14.6）、`PickupVerifyRequest.java`、`PickupVerifyVO.java`、`PickupVerifyServiceImpl.java`、`vue/.../device/pickup.ts`、`vue/.../device/result.ts`。

### 2.1 请求体
- ✅ `{ "pickupCode": "385214", "lockerCode": "WD-01" }`（`API设计文档.md:1237-1239`）。
- ✅ 字段：`pickupCode`（`@NotBlank`，6 位数字）、`lockerCode`（`@NotBlank`）。`PickupVerifyRequest.java:11-18`。
- ✅ 屏端前置校验：`pickupCode` 必须匹配 `/^\d{6}$/`，`lockerCode` 非空，否则当场抛错不发报文（`pickup.ts:53-63`，`PICKUP_CODE_LENGTH=6` 见 `pickup.ts:36`）。
- ✅ `lockerCode` 必须与验签身份 `X-Device-Code` 一致，否则 → `9003`（`DEVICE_DATA_INVALID`）。`PickupVerifyServiceImpl.java:45-48`；`API设计文档.md:1259`。

### 2.2 成功响应（HTTP 200，外层 `code:0`）
- ✅ `data` 形状（`API设计文档.md:1243-1247`、`PickupVerifyVO.java:19-37`）：
  | 字段 | 类型 | 可空 | 说明 |
  |---|---|---|---|
  | `matched` | boolean | 否 | `true` |
  | `orderNo` | string | 否 | 订单号 |
  | `cellNo` | string | **可空** | 格口号；后端 cell 为 null 时回 null（`PickupVerifyVO.java:70`） |
  | `cellType` | enum(string) | 否 | `CellType`（`SMALL/MEDIUM/LARGE`）；屏上按字符串读（`pickup.ts:23,75`） |
  | `status` | enum(string) | 否 | `OrderStatus`；屏上按字符串读 + 中文标签表（`pickup.ts:154-162`） |
  | `payable` | Long | **可空** | **校验时刻参考快照（分，5 分钟粒度）**，后端取不到为 null（`pickup.ts:76-80`） |
  | `paid` | boolean | 否 | **已付清**；`false` 不是失败 |
  | `hint` | string | **可空** | 引导语（`PickupVerifyServiceImpl.java:35-36`：`请在小程序完成支付后取件` / `请在小程序点击取件开门`） |
- ✅ `payable` 是参考快照，禁止渲染为「应付锁定价」：`API设计文档.md:1253`；`pickup.ts:16-18`；`PickupVerifyVO.java:13-14`。屏端文案须带「参考」二字（`pickup.ts:18`）。
- ✅ `paid:false` **不是失败**，而是「已匹配、待支付」：引导用户去小程序支付（`API设计文档.md:1251,1257`；`pickup.ts:19-21`）。与 `paid:true` 共用同一张结果卡骨架，仅引导语/`已付清|待支付` 行不同（`terminal.ts:12-13`）。
- ✅ 匹配成功条件：本柜机内按 `pickupCode` 查到订单，且 `IN_PROGRESS|TIMEOUT`、已存入未取件（`PickupVerifyServiceImpl.java:50-72`，`awaitingPickup` 见 `:77-79`）。

### 2.3 失败分支（HTTP 200，外层 `code:0`，`matched:false`）
- ✅ 形状：`{ matched:false, reason:"INVALID"|"CONSUMED" }`，其余字段全 null（`PickupVerifyVO.java:35-37`；`API设计文档.md:1249`）。
  - `INVALID` = 查无此码（`PickupVerifyServiceImpl.java:55-57`，对应错误码表 `8005`）。
  - `CONSUMED` = 订单已终局（码已核销，`PickupVerifyServiceImpl.java:58-60`，对应 `9004`）。
  - 🔍 注：`8005/9004` 是错误码表的「语义映射」，本端点**实际不返回**这些业务码，而是用 `matched:false+reason` 承载（`API设计文档.md:1255`）。
- ✅ 屏端解读：`parseResult`（`result.ts:34-43`，`SUCCESS_CODE=0`）→ `code===0` → 看 `data.matched`；`matched:false` 归 `unmatched`，reason 原样带出，未知值回落 `'UNKNOWN'`（`pickup.ts:129-146`）。
- ✅ **两个独立分支，不要混淆**：
  - `unmatched`（`INVALID/CONSUMED`）= HTTP 200 + `matched:false`，属「码的事」→ 屏上 `invalid`/`consumed` 两态（`terminal.ts:182-188`）。
  - `reject`（业务错误码 `9001/9002/9003`）= HTTP 200 + `code≠0` → 屏上 `reject` 态，照实显示 `code`+`message`（`pickup.ts:132`；`terminal.ts:189-193`）。
  - `transport-failure` = 响应解析不出 / `matched` 非布尔 → 屏上 `transport-failure` 态，保留输入（`pickup.ts:131,134,136,144`；`terminal.ts:194-199`）。

---

## 3. `pickupCode` 生命周期

事实源：`java/.../service/impl/DeviceEventServiceImpl.java`、`PickupVerifyServiceImpl.java`、`API设计文档.md`。

- **生成时机（存入关门后）**
  ✅ 在 `DOOR_CLOSED` 事件处理「规则 1」里生成：匹配本格口「未存入订单」（`IN_PROGRESS` + `startAt` 为空），落定 `startAt` 同时写 `pickupCode`（`DeviceEventServiceImpl.java:107-127`，写入点 `:126`）。
  ✅ 与 `DOOR_CLOSED` 的关系：关门（物理事实）是生成取件码的**唯一触发**；与订单状态关系是「订单须处于未存入的 `IN_PROGRESS`」才绑定并生成（`:109-114`）。
- **位数与唯一性范围**
  ✅ 6 位数字、零填充：`"%06d".formatted(...)`，`PICKUP_CODE_BOUND = 1_000_000`（`DeviceEventServiceImpl.java:54,195`）；屏端同样 6 位（`pickup.ts:36,39`）。
  ✅ **同一柜机内唯一、历史不复用**：`nextPickupCode` 先 `SELECT pickup_code WHERE locker_id=? AND pickup_code IS NOT NULL` 收集已用码再随机去重（`DeviceEventServiceImpl.java:185-200`）；注释「码在同一柜机内历史唯一、不复用」（`PickupVerifyServiceImpl.java:26-27`）；`API设计文档.md:1261`。
- **失效条件**
  ✅ 取件码「失效/被核销」= 订单进入终局：`awaitingPickup` 要求 `status.awaitingPickup() && startAt!=null && endAt==null`（`PickupVerifyServiceImpl.java:77-79`）。一旦 `endAt` 非空或状态非在途（如 `COMPLETED`/`TIMEOUT` 结算、`FORCE_ENDED`、`REFUNDED`、`CANCELLED`），再校验即返回 `CONSUMED`（`:58-60`）。
- **核销后果（CONSUMED 之后再次提交）**
  ✅ 取件码**保留在订单上不清除**（仅作审计，`PickupVerifyServiceImpl.java:26`；`API设计文档.md:1261`）。再次提交同一码：仍能查到该订单，但 `awaitingPickup` 为 false → **仍返回 `CONSUMED`**（`PickupVerifyServiceImpl.java:55-60`）。即：重复提交的表现是稳定地 `CONSUMED`，码既不复用也不清空。
  ✅ 取件核销的实际发生点：规则 2「已支付取件关门」→ `IN_PROGRESS→COMPLETED` 或 `TIMEOUT` 补录 `endAt`、释放格口、取件码随终局失效（`DeviceEventServiceImpl.java:147-183`，注释 `:153`）。
- **谁能重新展示它**
  ✅ 中控屏**永不展示取件码**——扫码 tab 只显示柜机码（`§1`），键盘 tab 只接收键入。取件码存储在后端 `Order` 上。
  ✅ 重新展示给用户的职责在 **C 端（小程序）订单详情**，但 `smart-locker-app` 当前**没有任何取件码代码**（见 §0.2），即重展示尚未实现。
  🔍 **推断（非证据）**：若按现有契约，取件码应由小程序从订单详情读取并展示给用户键入；但「小程序订单详情如何呈现取件码」属未实现的设计，本文件不下结论。

---

## 4. 中控屏九态清单与事实源（供 C 端语义对齐）

事实源：`vue/.../device/terminal.ts`（九态映射注释 `:9-18`，状态枚举 `:42-49`，结算分支 `:171-200`）。

> ⚠️ 枚举只有 **7 个值**（`TerminalStatus`：`input|verifying|matched|invalid|consumed|transport-failure|reject`）。所谓「九态」是**显示态**：`待机/输入中` 共用 `input`（靠 `code` 空/非空区分，`terminal.ts:10,139`），`已付清/待支付` 共用 `matched`（靠 `order.paid` 区分，`terminal.ts:12-13`）。

| # | 显示态 | 底层枚举/判据 | 触发条件 | 输入是否清空 |
|---|---|---|---|---|
| 1 | 待机 | `input` + `code` 空 | 初始 / `dismiss` 后 / 60s 无操作回待机（`TERMINAL_IDLE_MS=60000`，`:36`；`tick` `:210-215`） | — |
| 2 | 输入中 | `input` + `code` 非空未满 6 | 敲键/退格（`press`/`backspace` `:145-155`） | 保留 |
| 3 | 校验中 | `verifying` | `submit` 置位，`cardOpen` 恒 false（`:162-169,120`） | 保留（上趟结果清空） |
| 4 | 已付清 | `matched` + `order.paid===true` | 校验成功且已付清（`terminal.ts:12,177-181`） | 保留 |
| 5 | 待支付 | `matched` + `order.paid===false` | 校验成功但未付（`terminal.ts:13,177-181`） | 保留 |
| 6 | 无效 | `invalid` | `unmatched` + `reason!=CONSUMED`（`terminal.ts:182-188`） | **清空** |
| 7 | 已核销 | `consumed` | `unmatched` + `reason==CONSUMED`（`terminal.ts:184`） | **清空** |
| 8 | 传输失败 | `transport-failure` | 响应解析不出/`matched` 非布尔/`not-sent`（`terminal.ts:194-199`） | 保留 |
| 9 | 业务拒绝 | `reject` | 业务错误码 `≠0`（`9001/9002/9003`）（`terminal.ts:189-193`） | 保留 |

✅ 口径红线（`terminal.ts:19-27`）：清空输入**只**发生在 `invalid`/`consumed`；卡片**只在结算后升起**；60s 无操作回待机**只针对输入中**（卡片升起时不计时）。

---

## 5. 可行性结论（只给事实与可行性，不给裁决）

**问题：小程序侧若要「生成二维码给屏扫」，在当前屏端实现下是否可行？阻碍是什么？**

- ✅ 当前屏端**没有任何入站扫码能力**。全仓 grep `camera|getUserMedia|mediaDevices` 命中均为 3D 场景相机（`scene.ts` 的 `THREE.PerspectiveCamera`），无任何媒体采集/扫码输入（`terminal-scan.spec.ts` 与 `qr.ts` 也只做「出码」，不做「读码」）。
- ✅ 屏端唯一接收取件码的入口是**屏上键盘**（`TerminalKeypadTab`）键入 6 位 → `pickup-verify`（`pickup.ts:buildPickupPayload`）。
- ✅ 屏端现有的「扫码」tab 是**出向**展示柜机码二维码（手机扫柜机，反向），其模板默认 `{lockerCode}`，与取件码无关（§1）。
- 🔍 **结论（可行性，非裁决）**：在当前屏端实现下，「小程序生成二维码→屏扫」**不可行**——屏端无扫码硬件/输入分支，且 `pickup-verify` 只接受键入的 `pickupCode`。要走这条路，必须做**屏侧改造**（加装扫码 + 在输入流里新增「解析扫描二维码取 pickupCode」分支），而按本次 effort 约束**屏侧改造属于 Out of scope**。
- ✅ 对照之下，「小程序显示 6 位码、用户在屏上键盘敲」已被现有 `pickup-verify` 契约完整支持（§2），无需屏侧改动。
- ⚠️ 本文件**不做** A/B 选型裁决，裁决交由 D2。

---

## 6. 诚实标注：哪些结论靠推断而非代码证据

- 🔍 §1「扫码 tab 的柜机码是给手机识别柜机用（柜机→手机方向）」及其下游含义：vue 代码只定义「码内容=柜机码」与引导语，**未定义**手机扫到后的行为；下游逻辑属 C 端，属推断。
- 🔍 §3「取件码应由小程序订单详情展示」：基于契约与屏端不展示取件码的事实推断；`smart-locker-app` 当前无实现代码，属推断/未实现。
- 🔍 §5「屏侧改造属 Out of scope」：来自本次 effort 约束（题面给定），非代码证据；「屏无扫码能力」本身是代码证据（grep 结果），但「需改造才能支持」是可行性推断。
- ✅ 其余所有字段形状、状态枚举、生成/核销逻辑均为直接代码或文档证据，已逐条标注 文件路径:行号。
