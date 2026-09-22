# 预约（Reservation）C 端契约事实底稿 —— 只读事实报告

> 性质：**只报事实，不做设计裁决**。每条断言均带 `文件:行号`。
> 事实源：
> - `API` = `/home/fantasywy/codes/java/smart-locker/docs/API设计文档.md`（v1.0）
> - `REQ` = `/home/fantasywy/codes/java/smart-locker/docs/需求分析文档.md`
> - `IMPL` = `/home/fantasywy/codes/java/smart-locker/src/main/java/...`（Java 实现）
> - `R1` = `research/r1-api-mapping:docs/research/R1-api-mapping.md`（已存在，已交叉核对，见 §12）
>
> 标记约定：`[文档明确]` = 源文写过；`[实现事实]` = 源码如此，文档未写；`[未答复]` = 两个源都没写。

---

## 1. 预约端点全集（C 端 `/api/app/v1`）

C 端控制器仅 4 处注册预约路由，**全部集中在 `AppReservationController`**：

`IMPL:src/main/java/com/zhichu/controller/app/AppReservationController.java:26` — `@RequestMapping("/api/app/v1")`

| # | 方法 | 路径 | 位置 |
|---|---|---|---|
| 1 | `POST` | `/api/app/v1/reservations` | `AppReservationController.java:32-35` |
| 2 | `GET` | `/api/app/v1/reservations` | `AppReservationController.java:37-43` |
| 3 | `POST` | `/api/app/v1/reservations/{id}/cancel` | `AppReservationController.java:45-50` |
| 4 | `POST` | `/api/app/v1/reservations/{id}/use` | `AppReservationController.java:53-56` |

对应文档小节：13.12 创建预约（`API:1086`）、13.13 我的预约列表（`API:1101`）、13.14 取消预约（`API:1119`）、13.15 开始使用预约（`API:1125`）。

**全站 C 端端点共 11 条**（其余为 auth 3 / profile 2 / score-logs 1 / orders 5 / lockers 1，见 `IMPL:controller/app/*`）。`API:118` 登记用户端族共 **16** 个端点（`API:118`：`| 用户端 | 认证 / 个人 / 柜机 / 订单 / 预约 / 积分 | 16 | /api/app/v1/** |`），与实现计数口径不同，**该 16 的具体构成文档未列**。

鉴权：`[文档明确]` `API:917` — 「除 13.1/13.2 外均需 `Authorization: Bearer <accessToken>`」，故 4 个预约端点均需 access token。错误码复用管理端表（`API:917`：「错误码复用管理端表（`5004/3002/6202` 等），用户端特有码见 15 章 `8xxx`」）。

---

### 1.1 `POST /api/app/v1/reservations`（13.12 创建预约）

**请求体**（`API:1088-1093`）：

```json
{ "lockerId": 11, "cellType": "MEDIUM",
  "planStartAt": "2025-04-01T10:00:00+08:00", "planEndAt": "2025-04-01T12:00:00+08:00" }
```

| 字段 | 类型 | 必填 | 来源 |
|---|---|---|---|
| `lockerId` | number | **必填**（`@NotNull`） | `API:1091`；`IMPL:dto/CreateReservationRequest.java:19-20` |
| `cellType` | enum `SMALL\|MEDIUM\|LARGE` | **必填**（`@NotNull`） | `API:1091`；`IMPL:dto/CreateReservationRequest.java:22-23` |
| `planStartAt` | string ISO8601 **带时区**（示例 `2025-04-01T10:00:00+08:00`） | **必填**（`@NotNull`） | `API:1092`；`IMPL:dto/CreateReservationRequest.java:25-26` |
| `planEndAt` | string ISO8601 带时区 | **必填** | `API:1092`；`IMPL:dto/CreateReservationRequest.java:28-29` |

- `[文档明确]` `API:1099`：「**`planEndAt` 必填（契约冻结）**；`general.defaultOccupancyHours` 已从冻结参数表移除（无处生效），见第 16 章增量 #10。」
- 服务端 Java 类型为 `LocalDateTime`（`IMPL:dto/CreateReservationRequest.java:26,29`），**非** `OffsetDateTime`；示例 JSON 带 `+08:00`，但实体字段无偏移量语义。**入参时区如何归一化，两个源都未写明。**
- **格口由服务端分配**：`IMPL:dto/CreateReservationRequest.java:10`（「柜机 + 格口类型 + 时段，格口由服务端分配」）；请求体**无** `cellId`/`cellNo`。

**响应 `data`**（`API:1095`）：

```json
{ "reservationId": 301, "resvNo": "R20250401001", "cellNo": "M05" }
```

| 字段 | 类型 | 来源 |
|---|---|---|
| `reservationId` | number | `API:1095`；`IMPL:vo/CreateReservationVO.java:6` |
| `resvNo` | string，形如 `R20250401001` | `API:1095`；`IMPL:vo/CreateReservationVO.java:6` |
| `cellNo` | string，如 `M05` | `API:1095`；`IMPL:vo/CreateReservationVO.java:6` |

单号规则 `[文档明确]` `API:1353`：「单号 `R + yyyyMMdd + 5 位当日序列`」；`IMPL:service/impl/ReservationServiceImpl.java:69` — `RESV_NO_PREFIX = "R"`。

**校验序（契约冻结）**：`[文档明确]` `API:1353`：「13.12 创建校验序固定 `5004 → 4004 → 8002 → 8006 → 8007`（**余位先于时段**：先锁格口再看时段，失败整体回滚、不留半成品占用）」。实现一致：`IMPL:ReservationServiceImpl.java:85,88-90,94-97,98,99`（黑名单→柜机→锁格口→`validatePeriod`→冲突）。

**规则** `[文档明确]` `API:1097`：「黑名单 `5004`；柜机不可用 `4004`；无空闲格口 `8002`；时段非法（`start≥end`、时长超 `reservation.maxHours`、开始时间过早（`planStartAt` 不晚于当前时刻，立即寄存走 13.7））`8006`；同用户同时段已有 `PENDING` 预约 `8007`；分配格口（`FREE → RESERVED`）→ 预约 `PENDING`。」

**`planStartAt`/`planEndAt` 的约束**（问题核心）：

| 约束 | 文档 | 实现 | 数值来源 |
|---|---|---|---|
| 必须 `planEndAt > planStartAt`（`start≥end` 即非法） | `API:1097`、`API:1312`、`API:1339` | `IMPL:domain/ReservationRule.java:21-24`（`!planEndAt.isAfter(planStartAt)`）；文案 `IMPL:ReservationServiceImpl.java:260`「预约结束时间必须晚于开始时间」 | 固定规则 |
| 时长 ≤ `reservation.maxHours` | `API:1097`、`API:1312` | `IMPL:ReservationRule.java:26-29`（**严格大于**才拒绝，恰好等于合法）；文案 `IMPL:ReservationServiceImpl.java:262-264`「预约时长不能超过 N 小时」 | `IMPL:enums/SysParamKey.java:27-28` 默认 **`24`**（小时）；`REQ:302` 未列 maxHours 行但 `REQ` 5.9 表格口径同 |
| `planStartAt` 必须**严格晚于**当前时刻 | `API:1097`、`API:1339` | `IMPL:ReservationRule.java:35-37`（`!planStartAt.isAfter(now)`）；文案 `IMPL:ReservationServiceImpl.java:266-268`「预约开始时间必须晚于当前时刻，立即寄存请走扫码存件」 | 固定规则 |
| **粒度（分钟对齐）** | **`[未答复]`** 两个源均未提任何「15 分钟粒度 / 整点对齐」约束 | 实现无粒度校验（`ReservationRule` 全文件无粒度逻辑） | — |
| **最小提前量（lead time，如「至少提前 2 小时」）** | **`[未答复]`** 无任何 X 分钟/X 小时的最小提前量 | 实现仅有「> now」这一条（`ReservationRule.java:35`） | — |
| **最大提前量（如「最多提前 7 天」）** | **`[未答复]`** 无任何上限 | 实现无上限校验 | — |
| 冲突判定：同用户 `PENDING` 时段半开区间相交 | `API:1097`、`API:1353`（「半开区间相交（首尾相接不算冲突），与格口类型、柜机无关」） | `IMPL:ReservationServiceImpl.java:273-282`（`planStartAt < 新 end && planEndAt > 新 start`）；纯函数 `IMPL:ReservationRule.java:82-85` | 固定规则 |

错误码：`5004` 黑名单、`4004` 柜机不可用、`8002` 无空闲格口、`8006` 时段非法、`8007` 时段冲突 — `API:1295,1287,1308,1312,1313`；`IMPL:common/api/ErrorCode.java:69-70`（`8006`/`8007`）。

---

### 1.2 `GET /api/app/v1/reservations`（13.13 我的预约列表）

见 §7（问题 7 专章）。

---

### 1.3 `POST /api/app/v1/reservations/:id/cancel`（13.14 取消预约）

见 §6（问题 6 专章）。

---

### 1.4 `POST /api/app/v1/reservations/:id/use`（13.15 开始使用 / 转单）

见 §8（问题 8 专章）。

---

## 2. `holdMinutes` —— 来源、暴露面、语义

**语义** `[文档明确]` `API:1129`：

> 当前时间须 ∈ `[planStartAt − reservation.holdMinutes, planStartAt + reservation.noShowMinutes)`，否则 `6202`

即：**「开始使用」窗口在 `planStartAt` 之前 `holdMinutes` 分钟就打开**（提前宽限，可提前到店开存）。

源头文本：

- `REQ:165`：「`planStartAt` 前 `reservation.holdMinutes`（提前宽限）起即可「开始使用」→ 转存件订单（同格口）→ 开门指令；预约置 `USED` 并关联订单；」
- `API:1353`：「13.15 开始使用窗口为**半开** `[planStartAt − reservation.holdMinutes, planStartAt + reservation.noShowMinutes)`，窗口外或非 `PENDING` → `6202`」
- `IMPL:domain/ReservationRule.java:39`：「开始使用窗口起点 = `planStartAt − holdMinutes`（提前宽限，可提前到店开存）」；`:40-42` `useWindowStart()`

**取值来源**：`[实现事实]` 系统参数 `reservation.holdMinutes`（管理端配置项），默认值 **15**。

- `IMPL:enums/SysParamKey.java:23-24`：
  ```
  RESERVATION_HOLD_MINUTES(SysParamGroup.RESERVATION, "holdMinutes", "预约提前宽限",
          SysParamType.NUMBER, "15", "预约开始前允许「开始使用」的提前宽限（分钟）", null),
  ```
- `REQ:302`：`| reservation | reservation.holdMinutes | 预约开始前允许「开始使用」的提前宽限（分钟） | 15 |`
- 读取点：`IMPL:service/impl/ReservationServiceImpl.java:167` — `sysParamService.getLong(SysParamKey.RESERVATION_HOLD_MINUTES)`

**是否出现在任何 C 端响应中？→ `[明确答复：否]`**

- 13.12 响应（`API:1095`）只有 `reservationId/resvNo/cellNo`。
- 13.13 列表项（`API:1110-1113`）无该字段；`IMPL:vo/AppReservationListItemVO.java:11-23` 逐字段列出，**无 `holdMinutes`、无 `noShowMinutes`、无 `createdAt`**。
- 13.15 响应（`API:1127`）只有 `orderId/orderNo/cellNo`。
- 全 C 端**不存在**任何设置/参数查询端点：`IMPL:controller/app/` 下无任何类引用 `SysParam`（grep `SysParam` 在 `controller/app/` 为零命中）。参数读端点在管理端 `GET /api/v1/settings?group=reservation|...`（`API:856`）+ `🔒system:settings:view`，**非 C 端**。
- 13.7 下单响应确实回传过一个同类参数 `openTimeoutMinutes`（`API:1346`：「响应 `openTimeoutMinutes` 取系统参数 `order.openTimeoutMinutes`（缺省 10）」）——**这构成一个「订单侧暴露、预约侧不暴露」的不对称事实**，但预约侧没有任何对应字段。

→ **C 端无法从接口得知 `holdMinutes` 的实际值；只能硬编码 15 或纯靠「窗口外报 6202」被动发现。** `[未答复]`：两个源都没写 C 端应如何获得该值。

---

## 3. `noShowMinutes` —— 来源、暴露面、语义

**语义** `[文档明确]`：**`planStartAt + noShowMinutes` 到达即判爽约**（右开，不含该时刻）。

- `API:1129`：窗口右端点 `planStartAt + reservation.noShowMinutes`（半开区间，该时刻已不可「开始使用」）。
- `REQ:166`：「超过 `planStartAt + reservation.noShowMinutes` 未开始使用 → 定时任务置 `NOSHOW`（爽约）→ **自动扣分**（联动 4.8）→ 释放格口；」
- `API:1353`：「爽约扫描（每 1min，`smart-locker.reservation.no-show-interval-ms` 可配）：`PENDING` 且到/过 `planStartAt + noShowMinutes` → `NOSHOW` + 按 `score.noShowDeduct` 自动扣分（`AUTO`，留痕带预约号）+ 释放格口，幂等可重跑」
- `REQ:355`：「`| 5 | 预约爽约扫描 | 每 1min | 超过 `noShowMinutes` 未开始使用 → `NOSHOW` + 扣分 + 释放格口 |`」

**取值来源**：系统参数 `reservation.noShowMinutes`，默认 **30**。

- `IMPL:enums/SysParamKey.java:25-26`：
  ```
  RESERVATION_NO_SHOW_MINUTES(SysParamGroup.RESERVATION, "noShowMinutes", "爽约判定",
          SysParamType.NUMBER, "30", "超过 planStartAt 多少分钟未开始使用判定爽约", null),
  ```
- `REQ:303`：`| reservation | reservation.noShowMinutes | 超过 planStartAt 多少分钟未开始使用判定爽约 | 30 |`
- 读取点：`IMPL:ReservationServiceImpl.java:168`（`use` 窗口判定）与 `:197`（爽约扫描）

**扫描实现（到达 `planStartAt + noShowMinutes` 后到底发生什么）**：

- 任务：`IMPL:task/NoShowReservationTask.java:25` — `@Scheduled(fixedDelayString = "${smart-locker.reservation.no-show-interval-ms:60000}")`，即**每 60 秒**（可配）。
- `IMPL:ReservationServiceImpl.java:196-220` `scanNoShow(now)`：
  1. `:199-203` 取 `PENDING` 且 `planStartAt ≤ now − noShowMinutes`（阈值函数 `IMPL:ReservationRule.java:56-58`，与 `noShowDeadline` 互为逆，`:50-51` 注释）并 `FOR UPDATE`；
  2. `:210` `releaseReservedCell(cellId)` → `IMPL:ReservationServiceImpl.java:307-309` `cellMapper.releaseToFree(cellId, CellStatus.RESERVED)`（**条件更新，不覆盖并发的 `FAULT/DISABLED`**，`:306` 注释）；
  3. `:211-214` 预约 `status = NOSHOW`；
  4. `:208,216-217` `creditService.deduct(userId, noShowDeduct, ReservationRule.noShowReason(resvNo))`，原因文案 `IMPL:ReservationRule.java:64-65`：`"预约爽约（" + resvNo + "）"`。
- `IMPL:ReservationServiceImpl.java:198` 注释明确右开边界：「候选 = PENDING 且已到/过爽约截止（窗口右开：**恰在 planStartAt + noShowMinutes 即不可再用**）；行锁与开始使用串行化」。
- 单测锁定边界：`IMPL:src/test/java/com/zhichu/domain/ReservationRuleTest.java:95-100`。

**是否暴露给 C 端？→ `[明确答复：否，完全没有任何暴露]`**

- 13.13 列表项无该字段（`API:1110-1113`，`IMPL:vo/AppReservationListItemVO.java:11-23`）。
- 无 C 端参数端点（见 §2）。
- **13.13 列表中 `NOSHOW` 只是一个 status 枚举值**（`API:1103`），C 端能看到「已爽约」这个结果，但**看不到判定时刻、也看不到宽限分钟数**。`[未答复]`：C 端 UI 想显示「请在 10:30 前开始使用」这类倒计时，文档未提供任何可用字段。

---

## 4. 爽约扣分规则与黑名单阈值

### 4.1 扣多少分

`[文档明确]`：

- `REQ:227`（4.8 触发点全表）：`| 预约爽约（NOSHOW 生成时） | score.noShowDeduct | − | 自动 |`
- `REQ:310`：`| score | score.noShowDeduct | 爽约扣分 | 10 |`
- `API:1353`：「`NOSHOW` + 按 `score.noShowDeduct` 自动扣分（`AUTO`，留痕带预约号）」

`[实现事实]` 默认值 **10**：

- `IMPL:enums/SysParamKey.java:44-45`：
  ```
  SCORE_NO_SHOW_DEDUCT(SysParamGroup.SCORE, "noShowDeduct", "爽约扣分",
          SysParamType.NUMBER, "10", "预约爽约扣减的积分", null),
  ```
- 扣分调用：`IMPL:ReservationServiceImpl.java:208,216-217`。

**是否在 C 端响应里？→ `[否]`**。13.13 列表项无该字段；无 C 端参数端点。C 端**唯一**的间接痕迹是积分明细：`GET /api/app/v1/score-logs`（`API:1133`，「查询参数：`page`、`pageSize`。响应结构同管理端 9.3（仅本人数据）」），其结构（`API:588-596`）为：

```json
{ "id": 1, "delta": -10, "reason": "预约爽约", "type": "AUTO",
  "operatorName": null, "createdAt": "2025-03-20T08:00:00+08:00" }
```

`type`：`AUTO`（规则触发）/ `MANUAL`（人工调整）— `API:597`。即 C 端能**事后**从 `delta` 反推扣了多少，但**事前不知道规则数值**。注意：`API:590` 的示例 `reason` 写的是 `"预约爽约"`，而实现写入的是 `"预约爽约（预约单号）"`（`IMPL:ReservationRule.java:64-65`）——**示例与实现的文案粒度不一致**（`API:1353` 侧写的是「留痕带预约号」）。

### 4.2 触发限制/黑名单的阈值（`5004`）

`[文档明确]`：

- `REQ:228`（4.8 表下正文）：「初始积分 = `score.max`（默认 100）；**调整后 < `score.blacklistThreshold`（默认 60）→ 自动进入黑名单**（AUTO，积分明细与管理端响应 `autoBlacklisted` 均体现）；黑名单满 `score.autoRemoveDays`（默认 30 天）→ 定时任务自动移出」
- `REQ:312`：`| score | score.blacklistThreshold | 黑名单阈值 | 60 |`
- `API:1351`：「积分变动后低于 `score.blacklistThreshold` 且当前非黑名单 → 自动进入黑名单（`AUTO`、`operatorName` 为空、原因「积分低于黑名单阈值（N）」）；**人工调整与自动扣分共用同一判定**」
- `API:64`：「黑名单用户允许登录与查询，但下单/预约/开始使用被拦截（`5004`）。」
- `API:1295`：`| 5004 | 黑名单用户禁止该操作 | 用户端下单/创建预约/开始使用 |`
- `API:939`（`R1:434` 转述）：黑名单用户**允许登录**，但下单/创建预约/开始使用被 `5004` 拦截。

`[实现事实]` 阈值默认 **60**：`IMPL:enums/SysParamKey.java:48-49`（`SCORE_BLACKLIST_THRESHOLD`，默认 `"60"`）；`IMPL:sysParamKey` 另见 `IMPL:enums/SysParamKey.java:50-55`（`min`=0、`max`=100、`autoRemoveDays`=30）。

`[实现事实]` 自动扣分下限为 **0**：`API:1351`④「自动扣分（供超时/爽约调用）以 **0** 为下限（需求 §4.8 明文，不随 `score.min` 上移）：已达下限不扣减、不报错，仍在积分明细留痕说明（`delta` 为实际扣减量），并同样触发低于阈值自动拉黑。」

**阈值是否暴露给 C 端？→ `[阈值本身：否；但当前积分与黑名单状态：是]`**

- **阈值 `60` 不暴露**：无 C 端参数端点（§2）；13.13/13.16 均无该字段。C 端拿不到阈值数值。
- **但 `GET /api/app/v1/profile`（13.4）暴露了当前积分与黑名单状态**（`[文档明确]` `API:954-955`）：
  ```json
  { "id": 88, "nickname": "小明", "avatar": "https://...", "phone": "13900000000",
    "score": 95, "status": "NORMAL",
    "blacklistRecord": null }
  ```
  `API:957`：「黑名单用户 `blacklistRecord` 返回 `{ reason, createdAt, auto }`，前端据此展示禁用提示。」
  `[实现事实]` `IMPL:vo/AppProfileVO.java:13-25`：`id, nickname, avatar, phone, score(Integer), status(UserStatus), blacklistRecord(BlacklistRecordVO)`；`:8` 注释：「`blacklistRecord` 仅黑名单用户非空（进入原因/时间/是否自动），前端据此展示禁用提示。」
- → **C 端可拿到 `score` 与 `status`（`NORMAL`/`BLACKLISTED`）**，但**拿不到阈值 60**，故无法计算「距黑名单还剩几分」，也无法在扣分前预警。`API:939`（`R1:434` 转述）：黑名单用户**允许登录**，但下单/创建预约/开始使用被 `5004` 拦截。

`[未答复]`：两个源都没有规定 C 端应在何处、以何种方式告知用户「爽约会扣 10 分」或「低于 60 分会进黑名单」。这是 C 端自决项。

---

## 5. 预约状态枚举与合法迁移

`[文档明确]` `API:1103`（13.13 查询参数）：`status`（`PENDING|USED|CANCELLED|NOSHOW|EXPIRED`，可空）。同一枚举亦见 `API:525`（管理端 8.1）。

`[实现事实]` `IMPL:enums/ReservationStatus.java:7-13`：

```java
public enum ReservationStatus {
    PENDING, USED, CANCELLED, NOSHOW, EXPIRED
}
```

类注释 `IMPL:enums/ReservationStatus.java:3-6`：「预约状态机（需求 §4.3、API 13.13）：`PENDING` 待使用 → 转单 `USED`（终态，不可逆）| 取消 `CANCELLED` | 爽约 `NOSHOW` | 故障失效 `EXPIRED`。」

**合法迁移**（由 `REQ:162-171` §4.3 六条 + `API:1353` 派生；实现为唯一写路径）：

| 起点 | 终点 | 触发 | 引用 |
|---|---|---|---|
| （无） | `PENDING` | 创建成功 | `API:1097`；`IMPL:ReservationServiceImpl.java:114` |
| `PENDING` | `USED` | 13.15 开始使用转单，**终态不可逆** | `API:1131`；`IMPL:ReservationServiceImpl.java:186`；`REQ:171`「**转单不可逆**：预约「开始使用」置 `USED` 终态后，即使关联订单被取消（`CANCELLED`）预约也不回退，用户需重新预约。」 |
| `PENDING` | `CANCELLED` | 用户取消（13.14）/ 管理端取消（8.3） | `API:1123`、`API:552`；`IMPL:ReservationServiceImpl.java:285-297` |
| `PENDING` | `NOSHOW` | 爽约扫描（每 1min） | `API:1353`⑤；`IMPL:ReservationServiceImpl.java:211-214` |
| `PENDING` | `EXPIRED` | 柜机/格口故障（系统失效，`cancelSource=SYSTEM`） | `API:1353`⑤；`IMPL:ReservationServiceImpl.java:242-250`；`REQ:168`「柜机/格口故障导致预约无法履约 → 系统取消置 `EXPIRED`（不扣分）」 |

**终态**：`USED`（`API:1353`：「预约置 `USED` 终态并回填 `actualStartAt/orderId`……`USED` **不可逆**（关联订单取消不回退，管理端 8.3 亦不可取消 `USED`）」）；`CANCELLED`/`NOSHOW`/`EXPIRED` 均为终态（实现中无任何从这三态出发的迁移；`requireStatus(..., PENDING)` 是取消与开始使用的唯一准入，`IMPL:ReservationServiceImpl.java:299-304`）。

**`[未答复]`**：源文**未以「状态迁移表」形式显式列出合法迁移**，上表是从 `REQ:162-171` + `API:1353` 的散落描述派生。**没有**「`EXPIRED` → 其他」「`NOSHOW` → 其他」等回退路径的任何表述，也没有 `PENDING` 超时未爽约（如 `planEndAt` 已过但未达 `noShowMinutes`）的额外终态。

---

## 6. 取消预约（13.14）— 错误码与前置条件

**端点**：`POST /api/app/v1/reservations/:id/cancel`（`API:1119`；`IMPL:AppReservationController.java:45`）

**请求体**（`API:1121`）：`{ "reason": "行程有变" }`（可选）。

- 实现：`IMPL:dto/CancelReservationRequest.java:12-13` — `@Size(max = 255) private String reason;`（可空）。
- 控制器 `@RequestBody(required = false)`（`IMPL:AppReservationController.java:47`）→ **可不传 body**。
- 留痕：`IMPL:ReservationServiceImpl.java:293-295`，仅当 `StringUtils.hasText(reason)` 才写入 `cancelReason`。

**响应 `data`**：`null`（`API:1123`；`IMPL:AppReservationController.java:49` `Result.ok()` → `Result<Void>`）。

**取消不允许时的错误码 = `6202`**（问题所指的 map 项，已证实）：

- `[文档明确]` `API:1123`：「规则：仅本人 → `8003`；**仅 `PENDING` 可取消 → `6202`**；成功后释放格口（`RESERVED → FREE`），不扣分。响应 `data`: `null`。」
- `API:1302`：`| 6202 | 预约状态不允许该操作 | 非待使用状态取消/开始使用 |`
- `IMPL:common/api/ErrorCode.java:55`：`RESERVATION_STATE_NOT_ALLOWED(6202, "预约状态不允许该操作"),`

**确切前置条件**：

1. **仅 `PENDING` 可取消** → 否则 `6202`。`IMPL:ReservationServiceImpl.java:285-287`（`cancel` 首行 `requireStatus(reservation, ReservationStatus.PENDING)`）；准入函数 `:299-304`。
2. **仅本人** → `8003`。`IMPL:ReservationServiceImpl.java:315-326` `lockOwned`：`:319-321` 不存在 → **`6201`**；`:322-324` 非本人 → `8003`（`IMPL:ErrorCode.java` 侧 `NOT_OWNER`）。`API:1123` 只写 `8003`，**`6201` 是 `R1:299` 标为 `[推断]` 对称于 13.15 的**；实现**确实**返回 `6201`（`IMPL:ReservationServiceImpl.java:320`，`IMPL:ErrorCode.java:54` `RESERVATION_NOT_FOUND(6201, "预约不存在")`）——即 `R1` 的 `[推断]` 现已有实现证据。
3. **成功后副作用**：释放格口 `RESERVED → FREE`（`IMPL:ReservationServiceImpl.java:288`→`:307-309`），状态 → `CANCELLED`，`cancelSource = USER`，**不扣分**（`API:1123`）。
4. **行锁串行化**：`IMPL:ReservationServiceImpl.java:316-318`（`FOR UPDATE`），与爽约扫描/开始使用串行化（`:311-314` 注释）。

**`[未答复]`**：文档未规定取消是否有时间限制（如「开始前 X 分钟内不可取消」）、是否限制取消次数——实现中也无此校验。**取消在 `PENDING` 期间任何时刻都允许**（含窗口已打开、甚至已过 `planStartAt` 但未到 `noShowMinutes` 时）。

---

## 7. 预约列表端点（13.13）

**存在**：`GET /api/app/v1/reservations`（`API:1101`；`IMPL:AppReservationController.java:37`）。

**查询参数**（`API:1103`）：`status`（`PENDING|USED|CANCELLED|NOSHOW|EXPIRED`，**可空**）、`page`、`pageSize`。

- 实现默认值：`IMPL:AppReservationController.java:40-41` — `page` 缺省 `1`，`pageSize` 缺省 `PageSupport.DEFAULT_PAGE_SIZE`。
- **`pageSize` 默认 = 20，上限 = 100**：`IMPL:common/api/PageSupport.java:12-13`（`DEFAULT_PAGE_SIZE = 20`、`MAX_PAGE_SIZE = 100`）；钳制规则 `IMPL:PageSupport.java:8` 注释：「page 越界取末页，pageSize 上限 100，**不报错**」，实现 `:18-28`。
- **非法 `status` 枚举** → 实现会抛错（`IMPL:ReservationServiceImpl.java:334-336` 经 `EnumParamParser.parse(ReservationStatus.class, status, "预约状态")`），具体码未在文档规定。`R1:281` 标 `[推断] 1001`。
- **排序**：`[实现事实]` `IMPL:ReservationServiceImpl.java:128` — `.orderByDesc(Reservation::getId)`，即**按预约 ID 倒序（最新创建的在前）**。**文档 §13.13 未规定排序** → `[未答复]`（文档层面）。

**响应 `data`**（`API:1105-1117`）：`{ list: [...], total: number }`（统一分页结构 `IMPL:vo/PageResult.java:8` — `record PageResult<T>(List<T> list, long total)`；`API` §1.2 登记）。

`list[]` 字段（`API:1110-1113`，逐字对应 `IMPL:vo/AppReservationListItemVO.java:11-23`）：

```json
{ "id": 301, "resvNo": "R20250401001", "lockerId": 11, "lockerNo": "WD-01",
  "siteName": "万达广场店", "cellNo": "M05", "cellType": "MEDIUM",
  "planStartAt": "...", "planEndAt": "...", "actualStartAt": null,
  "status": "PENDING", "orderId": null }
```

| 字段 | 类型 | 可空 | 语义 | 引用 |
|---|---|---|---|---|
| `id` | number | 否 | 预约 ID（路径参数用） | `API:1110`；`IMPL:AppReservationListItemVO.java:12` |
| `resvNo` | string | 否 | 预约单号 `R…` | `API:1110`；`:13` |
| `lockerId` | number | 否 | | `API:1110`；`:14` |
| `lockerNo` | string | 否 | 柜机编号（取自 `locker.code`） | `API:1110`；`:15`；`IMPL:converter/ReservationConverter.java:37` |
| `siteName` | string | 否 | 站点名（取自 `site.name`） | `API:1111`；`:16`；`IMPL:ReservationConverter.java:38` |
| `cellNo` | string | 否 | 分配格口编号 | `API:1111`；`:17`；`IMPL:ReservationConverter.java:39` |
| `cellType` | enum | 否 | `SMALL\|MEDIUM\|LARGE` | `API:1111`；`:18` |
| `planStartAt` | datetime string | 否 | 计划开始 | `API:1112`；`:19` |
| `planEndAt` | datetime string | 否 | 计划结束 | `API:1112`；`:20` |
| `actualStartAt` | datetime string | **可空** | 实际开始（未转单 = `null`） | `API:1112`；`:21` |
| `status` | enum | 否 | 五态 | `API:1113`；`:22` |
| `orderId` | number | **可空** | 转单后的订单 ID（未转单 = `null`） | `API:1113`；`:23` |

**`createdAt` 是否在 C 端列表？→ `[明确答复：否]`**。`AppReservationListItemVO`（`IMPL:vo/AppReservationListItemVO.java:11-23`）**没有** `createdAt`；`API:1110-1113` 的 JSON 示例也没有。
**对比**：管理端 8.2 详情**有** `createdAt` —— `API:546`：「`reservation` 块含 `cancelReason`/`cancelSource`（`USER|ADMIN|SYSTEM`）/`expireReason`/**`createdAt`**」；实现 `IMPL:vo/AdminReservationVO.java:31`（`LocalDateTime createdAt`）。→ **「预约创建时间」在管理端可见、在 C 端不可见。**

**同样缺失的 C 端字段**（管理端 8.2 有、C 端 13.13 无）：`userId`、`cellId`、`cancelReason`、`cancelSource`、`expireReason`、`createdAt`（对比 `API:546` 与 `API:1110-1113`；`IMPL:AdminReservationVO.java:15-31` vs `IMPL:AppReservationListItemVO.java:11-23`）。

**`[未答复]`**：
- 文档未规定列表排序（实现按 `id DESC`）。
- 文档未提供 C 端预约**详情**端点（只有列表 13.13）；13.13 的字段集就是 C 端可得的全部。若 UI 要区分「用户取消」vs「系统故障失效」，C 端**拿不到 `cancelReason`/`expireReason`**，只能凭 `status` 区分 `CANCELLED` 与 `EXPIRED`。
- 文档未规定 `list` 是否分页返回「历史全部」还是「仅近期」——无时间窗参数（`R1:270` 同口径）。

---

## 8. 预约 → 订单转换（13.15 `POST /reservations/:id/use`）

**端点**：`POST /api/app/v1/reservations/:id/use`（`API:1125`；`IMPL:AppReservationController.java:53`）

**请求体**：**无**。`[文档明确]` `IMPL:AppReservationController.java:52` 注释：「开始使用：无需请求体（格口与订单均由服务端依预约决定）」；实现签名为 `use(@PathVariable Long id)`（`:54`）。`R1:304`：「**请求体**：无。来源：:1125-1127」。→ **`POST` 无 body，路径参数 `:id` 即预约 ID。**

**响应 `data`**（`API:1127`）：

```json
{ "orderId": 2002, "orderNo": "20250401002", "cellNo": "M05" }
```

| 字段 | 类型 | 引用 |
|---|---|---|
| `orderId` | number | `API:1127`；`IMPL:vo/UseReservationVO.java:6` |
| `orderNo` | string | `API:1127`；`IMPL:vo/UseReservationVO.java:6` |
| `cellNo` | string | `API:1127`；`IMPL:vo/UseReservationVO.java:6` |

→ **是的，返回结果订单 ID（`orderId`）**，同时返回 `orderNo` 与 `cellNo`。

**规则（事务内）** `[文档明确]` `API:1129`：

> 黑名单 `5004`（需求 §4.8：开始使用同受拦截）；仅本人 `8003`；预约不存在 `6201`；仅 `PENDING` → `6202`；当前时间须 ∈ `[planStartAt − reservation.holdMinutes, planStartAt + reservation.noShowMinutes)`，否则 `6202`；柜机不可用 → `4004`。

**判定顺序** `[文档明确]` `API:1353`：「需求 §4.8「黑名单拦截开始使用」**在归属校验前**判定 → `5004`」。实现一致：`IMPL:ReservationServiceImpl.java:162`（先 `requireNotBlacklisted`）→ `:163`（`lockOwned`：6201/8003）→ `:164`（`requireStatus` → 6202）→ `:167-174`（窗口 → 6202）→ `:176-179`（`4004`）。

**成功后的落库** `[文档明确]` `API:1131`：

> 成功：创建订单（`IN_PROGRESS`，`startAt=null`，关联 `reservationId`）→ 预约置 `USED` 并回填 `orderId` → 生成开门指令（`USER_DROP`）。后续存入/取件与 13.7/13.11 同链路。

`[实现事实]`：

- `IMPL:ReservationServiceImpl.java:181` — `appOrderService.placeReservedOrder(principal.id(), locker, cell, reservation.getId())`；实现于 `IMPL:service/impl/AppOrderServiceImpl.java:113-118`，落单 `:246-255`（`:255` `order.setReservationId(reservationId)`）。
- `IMPL:ReservationServiceImpl.java:183-189` — 预约置 `USED`，回填 `actualStartAt = now` 与 `orderId = order.getId()`。`:183` 注释：「**USED 终态回填**：实际开始时间与关联订单同事务落库，此后任何路径都不回退（需求 §4.3 #6）」。
- **同格口**：`API:1353`「成功后**同格口**转存件订单」；实现复用 `reservation.getCellId()`（`IMPL:ReservationServiceImpl.java:180`），不重新分配。
- 开门指令 `OPEN_CELL(USER_DROP)`（`API:1131`）。

**预约记录的后续命运**：

- **状态变为 `USED`**（终态，不可逆）——`API:1131`、`API:1353`（「预约置 `USED` 终态并回填 `actualStartAt/orderId`……`USED` **不可逆**（关联订单取消不回退，管理端 8.3 亦不可取消 `USED`）」）；`REQ:171`（同义）。
- **是否从预约列表消失？→ `[明确答复：不消失]`**。13.13 无 `status` 过滤时返回**全部**（`API:1103` `status` 可空；`IMPL:ReservationServiceImpl.java:127` `.eq(statusFilter != null, ...)` — 为空则不过滤），`USED` 记录仍在 `list` 中，其 `status="USED"`、`orderId` 非空、`actualStartAt` 非空（`API:1113`、`API:1112`）。**只有显式传 `status=PENDING` 才会隐藏。**
- **重复调用（幂等性）**：`[推断]` 非幂等，`USED` 后再调 → `6202`（`requireStatus` 拒绝，`IMPL:ReservationServiceImpl.java:164`）。`R1:318` 同结论，标 `[推断]`。

**`[未答复]`**：文档未规定 `use` 的请求体是否应带任何确认字段（实现为无 body）；未规定同一预约并发 `use` 的行为（实现靠 `FOR UPDATE` 串行化，`IMPL:ReservationServiceImpl.java:316-318`，但文档未描述）。

---

## 9. 订单取消前置条件（对比，13.10）

`[文档明确]` `API`（13.10 节，行 `:1049-1053`）：

> ### 13.10 取消未开门订单 `POST /api/app/v1/orders/:id/cancel`
> 请求体：`{ "reason": "不想存了" }`（可选）。
> 规则：**仅「未完成存入」（`IN_PROGRESS` 且 `startAt` 为空）可取消 → 否则 `3002`；取消前置校验：开门指令已回执 `DONE`（设备已确认开门）→ `3002`（提示「柜门已开启，请放入物品后关门，或联系客服」）；** 成功后订单 → `CANCELLED`、格口释放（`RESERVED → FREE`），无费用流水。响应 `data`: `null`。错误：`3001`/`8003`/`3002`。【取消前置分支为契约补充，见第 16 章 #9】

契约增量登记 `API:1337`：

> `| 9 | 用户端 13.10 取消响应补充错误分支：开门指令已回执 `DONE` 时取消返回 `3002`（原契约未定义该分支） | 错误分支补充 | 前端提示语适配 |`

实现登记 `API:1346`（#18③）：「13.10 取消：仅未存入且开门指令未回执 `DONE`，否则 `3002`（含「柜门已开启」文案）。」

**对比要点（供设计对照，不做裁决）**：

| 维度 | 订单取消（13.10） | 预约取消（13.14） |
|---|---|---|
| 错误码 | `3002`（未存入 / 已回执 `DONE`）/ `3001` / `8003` | `6202`（非 `PENDING`）/ `6201` / `8003` |
| 前置条件 | 「未存入」= `IN_PROGRESS` **且** `startAt` 为空；**且** 开门指令**未**回执 `DONE` | 仅 `status == PENDING` |
| 是否有「已产生物理动作则不可取消」分支 | **有**（`DONE` 已开门 → 拒绝，含专用文案） | **无**（无任何物理动作检查） |
| 请求体 | `{ reason? }` 可选 | `{ reason? }` 可选 |
| 响应 | `data: null` | `data: null` |
| 副作用 | 订单 → `CANCELLED`，格口 `RESERVED → FREE`，无费用流水 | 预约 → `CANCELLED`，格口 `RESERVED → FREE`，**不扣分** |
| 幂等性 | 重复取消 → `3002` | 重复取消 → `6202` |

---

## 10. 预约与订单列表的关系（13.8）

**13.8 端点**：`GET /api/app/v1/orders`（`API:1000`），查询参数 `status`（同管理端 7.1 枚举，可空=全部）、`page`、`pageSize`（`API:1002`；实现 `IMPL:AppOrderController.java:38-44`）。

**响应 `data`**（`API:1006-1017`）：

```json
{ "id": 2001, "orderNo": "20250401001", "lockerId": 11, "lockerNo": "WD-01",
  "siteName": "万达广场店", "cellNo": "S03", "cellType": "MEDIUM",
  "startAt": "2025-04-01T09:00:00+08:00", "endAt": null,
  "status": "IN_PROGRESS", "payAmount": null,
  "estimatedAmount": 1800, "pickupCode": "385214" }
```

外层的 `total` 与 `list` 包装同上（`API:1015`）。

**逐字段**（`IMPL:vo/AppOrderListItemVO.java:14-27`）：`id`(Long)、`orderNo`(String)、`lockerId`(Long)、`lockerNo`(String)、`siteName`(String)、`cellNo`(String)、`cellType`(CellType)、`startAt`(LocalDateTime)、`endAt`(LocalDateTime)、`status`(OrderStatus)、`payAmount`(Long)、`estimatedAmount`(Long)、`pickupCode`(String)。共 **13** 个字段。

**是否包含预约衍生的订单？→ `[明确答复：是的]`**，但为**实现事实 + 文档侧间接**：

- 13.15 转单产生的订单被**明确规定为「存件订单」并走同一链路**：`API:1131`「创建订单（`IN_PROGRESS`，`startAt=null`，关联 `reservationId`）……**后续存入/取件与 13.7/13.11 同链路**」；`API:1353`「成功后**同格口**转存件订单（`startAt` 为空、关联 `reservationId`）……后续存入/取件与 13.7/13.11 同链路」。
- 实现：转单订单与 13.7 下单**共用同一落单机制**——`IMPL:ReservationServiceImpl.java:58` 注释：「落单复用 `AppOrderService#placeReservedOrder`（**与 13.7 下单同一机制**），预约侧只负责置位回填。」；`IMPL:AppOrderServiceImpl.java:113-118`、`:246-255`。
- 13.8 的查询实现按**当前用户**过滤（`IMPL:service/impl/AppOrderServiceImpl.java` 的 `list`），不按来源区分；`AppOrderListItemVO` 中无来源字段。→ **预约衍生的订单与 13.7 直接下单的订单在 13.8 中形状完全一致、无法从响应区分。**
- **订单实体的确存了来源**：`IMPL:entity/Order.java:72` — `private Long reservationId;`，类注释 `:18`：「`reservationId`/`settleMode` 等字段由预约/人工干预链路（ticket 15/16）回填。」

**是否有字段把订单链回其来源预约？→ `[明确答复：C 端没有]`**

- `AppOrderListItemVO`（`IMPL:vo/AppOrderListItemVO.java:14-27`）**不含 `reservationId`**；`API:1009-1013` 的 13.8 JSON 示例也**不含**。
- 13.9 订单详情 `GET /api/app/v1/orders/:id`（`API:1027`）——`API:1046` 描述其 `order` 块含「支付成功时定格的费用构成（`baseFee/overtimeFee/discount/payAmount`）与 `estimatedAmount`……`payments` 为订单支付单列表」——**`API:1046` 未提 `reservationId`**。`[实现事实-已核实]`：13.9 详情的订单块 `IMPL:vo/AppOrderVO.java:13-24` 共 11 字段（`id, orderNo, status, baseFee, overtimeFee, discount, payAmount, startAt, endAt, estimatedAmount, pickupCode`）——**无 `reservationId`**；外层 `IMPL:vo/AppOrderDetailVO.java:9-13`（`order, locker, timeline, payments`）亦无。→ **13.9 详情同样不暴露订单来源预约。**
- **反向链接存在且可用**：C 端可从**预约列表**的 `orderId`（`API:1113`）单向跳到订单；`IMPL:vo/AppReservationListItemVO.java:23`。→ **预约 → 订单 有链接；订单 → 预约 在 13.8 列表无链接。**

**`[未答复]`**：C 端 UI 若想在订单详情标出「此单来自预约」，**13.8 无法支撑**；13.9 是否支撑需补核。

---

## 11. 提前预约 / 最早可预约（lead time）

**结论：`[未答复 —— 两个源都没有规定任何提前量约束]`。**

逐项核对：

| 可能的约束 | 文档 | 实现 |
|---|---|---|
| 最小提前量（必须 > now + X） | **无任何 X**。仅 `API:1097`「开始时间过早（`planStartAt` 不晚于当前时刻）」 | `IMPL:ReservationRule.java:35-37` — `!planStartAt.isAfter(now)`，**仅比较当前时刻，无 X 分钟缓冲**；调用点 `IMPL:ReservationServiceImpl.java:266-269` |
| 最大提前量（最多提前 N 天） | **不存在任何表述** | `IMPL:ReservationServiceImpl.java:257-270` `validatePeriod` 三条检查中**无**上限检查；`IMPL:ReservationRule.java` 全文件亦无 |
| 时间粒度 / 整刻对齐 | **不存在任何表述** | 无 |
| 最长时长 | `reservation.maxHours`，默认 24（`API:1097`、`IMPL:SysParamKey.java:27-28`） | `IMPL:ReservationRule.java:26-29` |
| 最短时长 | **不存在**（除 `end > start` 外无下限） | 无 |

`REQ:165` 仅写「`planStartAt` 前 `reservation.holdMinutes`（提前宽限）起即可「开始使用」」，描述的是**使用窗口**，不是**预约创建的最早/最晚时间**。

→ **「是否能预约下周/下个月的时段」「是否必须整点」「是否至少提前多久」全部是 C 端/产品自决项，后端契约当前不拦（除「必须晚于此刻」外）。** 设计 UI 若要限制，需自行在前端实现，或推动后端补参数。

---

## 12. 与 `R1-api-mapping` 分支底稿的交叉核对

文件存在：`git -C /home/fantasywy/codes/WeChatProjects/smart-locker-app show research/r1-api-mapping:docs/research/R1-api-mapping.md`（535 行）。其预约章节位于该文档 §13.12–13.15（本地导出 `/tmp/r1-api-mapping.md:246-318`）、时序 C/D（`:382-418`）、枚举汇总表（`:456`）、黑名单（`:434`）。

**一致项（R1 与本次核对结论相同）**：

| 主题 | R1 行 | 与本次核对 |
|---|---|---|
| 4 个预约端点 + 方法与路径 | `R1:26-29` | ✅ 一致 |
| 13.12 请求/响应字段与必填性 | `R1:249-255` | ✅ 一致（含 `planEndAt` 必填、`defaultOccupancyHours` 已移除） |
| 校验序 `5004→4004→8002→8006→8007` | `R1:257-263`、`R1:385` | ✅ 一致，且与实现 `Discovery:ReservationServiceImpl.java:85-99` 吻合 |
| 使用窗口半开区间 | `R1:315` | ✅ 一致 |
| `USED` 终态不可逆 | `R1:317`、`R1:400` | ✅ 一致 |
| 13.13 列表全 12 字段 | `R1:272-286` | ✅ 一致（逐字段比对无出入） |
| 13.14 `6202` = 仅 `PENDING` 可取消 | `R1:298` | ✅ 一致 |
| 13.15 响应 `{orderId, orderNo, cellNo}`、无请求体 | `R1:305-306` | ✅ 一致 |
| 枚举 `PENDING\|USED\|CANCELLED\|NOSHOW\|EXPIRED` | `R1:456` | ✅ 一致 |
| 爽约扫描 1min + 扣分 + 释放格口 | `R1:397` | ✅ 一致；本报告补充了扣分默认值 10 与扫描实现位置 |

**本报告相对 R1 的**新增**事实（R1 未覆盖或标注为未明确）**：

1. `holdMinutes` **默认 15** 与 `noShowMinutes` **默认 30** 的**具体数值来源**：`IMPL:enums/SysParamKey.java:23-26`；`REQ:302-303`。R1 只引用了 `:1129` 的公式，**未展开两个参数的默认值与读取实现**。
2. 爽约扣分默认 **10**：`IMPL:SysParamKey.java:44-45`、`REQ:227,310`。
3. 黑名单阈值默认 **60**（低于即拉黑）：`IMPL:SysParamKey.java:48-49`、`REQ:228,312`。
4. **这些参数均不出现在任何 C 端响应中**，且 C 端**无参数查询端点**（`IMPL:controller/app/` 零 `SysParam` 引用）—— R1 未就此下判断。
5. **13.13 C 端列表无 `createdAt`**（管理端 8.2 有）—— R1 的字段表（`R1:272-286`）已如实列出 12 字段（故隐含一致），但**未点出与管理端的这一差异**。
6. **13.13 排序 = `id DESC`**（`IMPL:ReservationServiceImpl.java:128`）—— R1 未提排序。
7. **`6201` 从「`[推断]`」升级为事实**：`R1:299` 标 `[推断]`，实现证据 `IMPL:ReservationServiceImpl.java:319-321` + `IMPL:ErrorCode.java:54`。
8. 取消**无任何时间限制**（`PENDING` 期间随时可取消）—— R1 未讨论。
9. 「无 lead time / 无最大提前量 / 无时间粒度」的**逐条否定** —— R1 未列此项。

**R1 明确标注的开放项中，与预约相关的**：`R1:480-484` 的缺口清单**不含预约项**（只有 13.3 登出鉴权、13.16 形状、登录码、refresh 并发）；`R1:481` 的 13.16 缺口已在 `R1:517-529` 自我更正为「不是缺口，形状就在 §9.3」。→ **R1 认为预约链路的契约形状是完备的**；本报告的「C 端拿不到 `holdMinutes`/`noShowMinutes`/扣分/阈值」属于**契约未定义 C 端读取渠道**，R1 未将其登记为缺口。

---

## 13. 「源未答复」清单（C 端必须自决）

按问题编号汇总，**这些都是两个源都没有写的**：

| # | 未答复项 | 影响面 |
|---|---|---|
| 1 | `planStartAt`/`planEndAt` 的**时间粒度**约束（是否必须整点/15 分钟对齐） | 选择器交互（自由选择 vs 步进选择） |
| 1 | **最小提前量**（是否必须提前 X 分钟/小时） | 默认时间、禁用过去的时段 |
| 1 | **最大提前量**（最多可预约未来多久） | 可选择日期范围 |
| 1 | `planStartAt` 带 `+08:00` 时区字符串如何被 `LocalDateTime` 解析/归一 | 前端序列化格式 |
| 1 | 13.12 是否存在其它错误码（如 `1001` 参数校验）—— `R1:262` 标 `[推断]` | 错误处理分支 |
| 2 | C 端**如何获得 `holdMinutes`** 的实际值（无响应字段、无参数端点） | 无法在前端展示「可提前 15 分钟」文案 |
| 3 | C 端**如何获得 `noShowMinutes`**（同上），无法展示「请在 X 前开始使用」倒计时 | 爽约风险提示 UI |
| 4 | C 端**如何获知扣分值 `noShowDeduct=10`** 与**阈值 `blacklistThreshold=60`** | 事前告知用户违约成本 |
| 4 | C 端没有任何「距黑名单还剩几分」的字段 | 信用提示 UI |
| 4 | ~~profile 是否含积分~~ **已核实：含 `score` 与 `status`，但不含阈值** | 已闭合 |
| 5 | 状态迁移**没有显式表**（本报告自 `REQ:162-171` 派生） | 状态文案映射 |
| 5 | `PENDING` 且已过 `planEndAt`（但未过 `noShowMinutes`）如何处理 — 无表述 | 边界展示 |
| 6 | 取消是否受时间限制（如开始前 X 分钟内禁止） | 取消按钮可用性 |
| 7 | 13.13 **排序规则**（实现为 `id DESC`，文档未定） | 列表顺序预期 |
| 7 | 13.13 无 `cancelReason`/`cancelSource`/`expireReason`/`createdAt` | 无法在 C 端展示取消原因与创建时间 |
| 7 | C 端**无预约详情端点** | 详情页需复用列表项 |
| 7 | 非法 `status` 查询参数返回什么码 | 错误处理 |
| 8 | 13.15 是否需要请求体确认字段（实现为无需） | 调用方式 |
| 10 | ~~13.9 是否含 `reservationId`~~ **已核实：13.9 详情与 13.8 列表均不含** | 已闭合；C 端无法从订单侧显示来源 |
| 11 | 全部 lead time / 最早最晚可预约 —— 后端完全不拦 | 前端需自建约束 |

---

## 附：一页速查（字段与格式）

**13.12 创建** `POST /api/app/v1/reservations`
- 入：`lockerId`(num,必) `cellType`(`SMALL|MEDIUM|LARGE`,必) `planStartAt`(ISO8601,必) `planEndAt`(ISO8601,必)
- 出 `data`：`reservationId`(num) `resvNo`(str `R+yyyyMMdd+5位`) `cellNo`(str)
- 错：`5004` `4004` `8002` `8006`(`start≥end` / >`maxHours`(默认24h) / `planStartAt`≤now) `8007`
- 副作用：格口 `FREE→RESERVED`，预约 `PENDING`

**13.13 列表** `GET /api/app/v1/reservations?status=&page=1&pageSize=20`
- 出 `data`：`{ list[], total }`；`list[]` 12 字段：`id, resvNo, lockerId, lockerNo, siteName, cellNo, cellType, planStartAt, planEndAt, actualStartAt, status, orderId`
- 排序 `id DESC`（实现）；`pageSize` ≤100，越界钳制不报错

**13.14 取消** `POST /api/app/v1/reservations/:id/cancel` body `{reason?}`(≤255)
- 出 `data`：`null`；错：`8003` `6202`(非 `PENDING`) `6201`
- 副作用：预约 `CANCELLED`，格口 `RESERVED→FREE`，**不扣分**

**13.15 使用/转单** `POST /api/app/v1/reservations/:id/use`（**无 body**）
- 窗口 `[planStartAt − 15min, planStartAt + 30min)`（默认值）→ 外则 `6202`
- 出 `data`：`orderId`(num) `orderNo`(str) `cellNo`(str)
- 错：`5004` `8003` `6201` `6202` `4004`
- 副作用：新订单 `IN_PROGRESS`(`startAt=null`, 关联 `reservationId`)，预约 `USED`+`actualStartAt`+`orderId`，`OPEN_CELL(USER_DROP)`

**服务端参数（C 端均不可见）**：`reservation.holdMinutes=15` `reservation.noShowMinutes=30` `reservation.maxHours=24` `score.noShowDeduct=10` `score.blacklistThreshold=60` `score.min=0` `score.max=100` `score.autoRemoveDays=30`
来源：`IMPL:enums/SysParamKey.java:23-55`、`REQ:302-312`。
