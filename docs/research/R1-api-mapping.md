# R1 — C 端接口映射底稿（用户端 `/api/app/v1`）

> 调研性质：**只读事实基线 + 可行性判断**。本文件只复述后端文档的明确规定，并对不明确/冲突处显式标注。
> 凡「文档明确写了」直接陈述；凡「推断 / 文档未定 / 冲突」一律加 `[推断]` / `[未明确]` / `[冲突]` 标记。
> 不提供任何交互设计裁决（如「小程序应显示几位取件码」属人类决策）。
>
> 主要事实源：`/home/fantasywy/codes/java/smart-locker/docs/API设计文档.md`（以下简称 **API 文档**）。
> 补充源：`需求分析文档.md`、 `/home/fantasywy/codes/java/smart-locker/CONTEXT.md`（领域术语）。
> 行号引用均为 API 文档（v1.0）行号，便于回查。

## 0. 总览映射表（动作 → 端点 → 鉴权 → 触发时机）

| # | 用户动作 | 端点 | 鉴权 | 触发时机 |
|---|---|---|---|---|
| 13.1 | 微信登录/首登注册 | `POST /api/app/v1/auth/login` | 无（body 带 `code`） | 小程序启动/进入需登录流程时 |
| 13.2 | 刷新 access | `POST /api/app/v1/auth/refresh` | refresh（`X-Refresh-Token`） | access 失效（401+2001）时静默刷新 |
| 13.3 | 登出 | `POST /api/app/v1/auth/logout` | `[未明确]` 见 13.3 节 | 用户主动退出 |
| 13.4 | 查看个人信息 | `GET /api/app/v1/profile` | access | 个人中心 |
| 13.5 | 修改个人信息 | `PUT /api/app/v1/profile` | access | 编辑昵称/头像 |
| 13.6 | 扫码查柜机 | `GET /api/app/v1/lockers/by-code?code=` | **access** —— §13 总则 :917；§16 #29 :1359 明写「需登录态」〔原标 `[冲突]`，已更正，见文末更正段〕 | 扫码/输入柜机 code 选柜 |
| 13.7 | 创建存件订单 | `POST /api/app/v1/orders` | access | 选定柜机+格口类型，点「存件」 |
| 13.8 | 我的订单列表 | `GET /api/app/v1/orders` | access | 订单页/列表 |
| 13.9 | 订单详情 | `GET /api/app/v1/orders/:id` | access | 点开某订单 |
| 13.10 | 取消未开门订单 | `POST /api/app/v1/orders/:id/cancel` | access | 未存入前取消 |
| 13.11 | 支付（模拟） | `POST /api/app/v1/orders/:id/pay` | access | 已存入待支付/取件前 |
| 13.12 | 创建预约 | `POST /api/app/v1/reservations` | access | 选时段预约 |
| 13.13 | 我的预约列表 | `GET /api/app/v1/reservations` | access | 预约页 |
| 13.14 | 取消预约 | `POST /api/app/v1/reservations/:id/cancel` | access | 取消待使用预约 |
| 13.15 | 开始使用预约（转单） | `POST /api/app/v1/reservations/:id/use` | access | 到使用窗口内点「开始使用」 |
| 13.16 | 积分明细 | `GET /api/app/v1/score-logs` | access | 积分/信用页 |

**全局约定（必读）**
- 金额单位一律为**分**（整数）。来源：API 文档:917「金额单位分」。
- 业务错误统一 `HTTP 200 + code ≠ 0`；认证/权限错误用 `HTTP 401/403`。来源：API 文档:1319、:44。
- 错误码表为全量共享（管理端/用户端/设备端同表），用户端特有码在 `8xxx`。来源：API 文档:917、:1267-1318。
- 分页越界**钳制**到最后一页、`pageSize` 超上限钳制 100，**不报 1001**（仅真正非法参数才 1001）。来源：API 文档:1374。
- 所有 `:id` 为用户**本人**资源，越权统一 `8003`。来源：各端点规则。

---

## 1. 逐端点详解（16 个）

> 标注法：`必填` / `可选` / `[可空]`（响应字段可为 null）/`[推断]`（文档未明说，按常识或同构推断）/`[冲突]`（文档内部矛盾）。

### 13.1 登录 `POST /api/app/v1/auth/login`
- **鉴权**：无。来源：API 文档:919、:25（`/auth/*` 为例外）。
- **请求字段**
  | 字段 | 类型 | 必填 | 约束 | 来源 |
  |---|---|---|---|---|
  | `code` | string | 必填 | `wx.login` 的 code | :924 |
  | `nickname` | string | 可选 | 小程序授权资料，首登落库 | :927 |
  | `avatar` | string(url) | 可选 | 同上 | :927 |
  | `phone` | string | 可选 | 同上 | :927 |
- **响应 `data`**
  | 字段 | 类型 | 可空 | 说明 | 来源 |
  |---|---|---|---|---|
  | `accessToken` | string | 否 | | :933 |
  | `refreshToken` | string | 否 | | :933 |
  | `expiresIn` | number | 否 | `7200`（秒） | :933 |
  | `user.id` | number | 否 | | :934 |
  | `user.nickname` | string | `[可空]` | 未授权则为空/null | :934 |
  | `user.avatar` | string | `[可空]` | | :934 |
  | `user.phone` | string | `[可空]` | | :934 |
  | `user.score` | number | 否 | 初始 `score.max` | :934,:939 |
  | `user.status` | enum | 否 | `NORMAL` 或 `BLACKLISTED` | :934,:939 |
- **错误码**
  | code | HTTP | 触发条件 | 来源 |
  |---|---|---|---|
  | `8001` | 200 | `code` 无效或微信侧错误（微信登录失败） | :939,:1307 |
  | `2001` | 401 | `[推断]` 极端情况下令牌通道异常（常规登录不走 token） | :1307 |
- **规则/生命周期**：`code` 换 openid；openid **首次出现自动注册**（初始积分 `score.max`、状态 `NORMAL`）；**黑名单用户允许登录**，`status` 返回 `BLACKLISTED`，下单等操作另行拦截 `5004`。来源：:939。
- **幂等性**：无（每次调用换取/注册）。首登自动注册属副作用，重复相同 openid 不会新建用户（按 openid 唯一，来源 CONTEXT.md:111-113 `[推断]` 复用既有用户）。`[推断]`

### 13.2 刷新 `POST /api/app/v1/auth/refresh`
- **鉴权**：refresh token，请求头 `X-Refresh-Token: <refreshToken>`（**非** Bearer access）。来源：:943、:63。
- **请求体**：无（不需要 access）。
- **响应 `data`**：`{ "accessToken": string, "expiresIn": number(7200) }`。来源：:943。
- **错误码**
  | code | HTTP | 触发条件 | 来源 |
  |---|---|---|---|
  | `2005` | 401 | refresh token 失效（过期 30 天/已作废） | :943,:1280 |
- **幂等性**：可重复调用（每次发新 access），无副作用累积。来源：`[推断]` 同管理端刷新机制（API 文档:56）。

### 13.3 登出 `POST /api/app/v1/auth/logout`
- **鉴权**：`[未明确]`。该端点路径属 `/auth/*`（§1 例外项，API 文档:25），但动作语义是「作废本用户 refreshToken」，必须能定位用户。`[推断]` 需要 `Authorization: Bearer <accessToken>`（或同时携带 refresh）。**文档未明文说明，建议联调前向主 agent 确认。** 来源：:945、:25 例外清单。
- **请求体**：无。
- **响应 `data`**：`null`。来源：:947。
- **错误码**：`[推断]` `2001`（未登录/无法定位用户）可能返回，文档未列。
- **规则**：作废 refresh token。来源：:947。
- **幂等性**：重复登出无副作用（refresh 已作废则无效）。`[推断]`

### 13.4 个人信息 `GET /api/app/v1/profile`
- **鉴权**：access。来源：:917（除 13.1/13.2 外需 Bearer）。
- **响应 `data`**
  | 字段 | 类型 | 可空 | 说明 | 来源 |
  |---|---|---|---|---|
  | `id` | number | 否 | | :954 |
  | `nickname` | string | `[可空]` | | :954 |
  | `avatar` | string | `[可空]` | | :954 |
  | `phone` | string | `[可空]` | | :954 |
  | `score` | number | 否 | 当前信用分 | :955 |
  | `status` | enum | 否 | `NORMAL`/`BLACKLISTED` | :955 |
  | `blacklistRecord` | object\|null | 是 | 非黑名单=`null`；黑名单=`{ reason, createdAt, auto }` | :956,:959 |
- **错误码**：`2001`（401，未登录/access 失效）。来源：:1307-1308 `[推断]`。
- **幂等性**：GET，天然幂等。

### 13.5 更新个人信息 `PUT /api/app/v1/profile`
- **鉴权**：access。来源：:917。
- **请求字段**
  | 字段 | 类型 | 必填 | 约束 | 来源 |
  |---|---|---|---|---|
  | `nickname` | string | 可选 | | :963 |
  | `avatar` | string(url) | 可选 | | :963 |
- **响应 `data`**：`null`。来源：:963。
- **错误码**：`2001`（401）；`[推断]` `1001`（字段格式非法）。来源：`[推断]` 全局参数约定 :1272。
- **幂等性**：可重复 PUT，后写覆盖前写。

### 13.6 扫码查柜机 `GET /api/app/v1/lockers/by-code?code=WD-01`
- **鉴权**：`access`。〔**2026-09-20 更正**：原文记为 `[冲突]` 并推荐「免 access」，是误读 —— 见文末更正段。〕来源：:917、:1359。
- **请求参数**：`code`（string，必填，柜机编号如 `WD-01`）。来源：:965。
- **响应 `data`**
  | 字段 | 类型 | 可空 | 说明 | 来源 |
  |---|---|---|---|---|
  | `id` | number | 否 | | :970 |
  | `code` | string | 否 | | :970 |
  | `siteId` | number | 否 | | :970 |
  | `siteName` | string | 否 | 站点 `DISABLED` 仍返回名（不拦查询） | :970,:977 |
  | `position` | string | 否 | 位置描述 | :971 |
  | `online` | boolean | 否 | `= locker.status == ONLINE` | :971,:977 |
  | `status` | enum | 否 | `ONLINE/OFFLINE/FAULT/MAINTAINING` | :971 |
  | `cellAvailability` | object | 否 | `{ small, medium, large }` 各为**空闲**格口计数 | :972,:977 |
- **关键规则**：
  - 柜机不存在 / 已软删 → `1002`（同归）。来源：:975,:977。
  - 离线/故障/维护中：仍正常返回，但 `online=false`、`status` 相应值、三项余位**恒为 0**（且不查库、不报错）。来源：:975,:977。→ 前端据此**禁用下单入口**，这是正常响应非错误。
  - 站点 `DISABLED` **不拦查询**（需求 §3.1「停用不挡营业」）。来源：:977。
  - `cellAvailability` 口径 = `status=FREE` 的格口按 `cellType` 计数；`RESERVED/IN_USE/DISABLED/FAULT` 均非余位。来源：:977。
- **错误码**：`1002`（柜机不存在/已软删）。来源：:975。
- **幂等性**：GET，天然幂等。

### 13.7 创建存件订单 `POST /api/app/v1/orders`
- **鉴权**：access。来源：:917。
- **请求字段**
  | 字段 | 类型 | 必填 | 约束 | 来源 |
  |---|---|---|---|---|
  | `lockerId` | number | 必填 | 柜机 ID | :984 |
  | `cellType` | enum | 必填 | 格口类型（`SMALL`/`MEDIUM`/`LARGE`，示例用 `MEDIUM`） | :984 |
- **响应 `data`**
  | 字段 | 类型 | 可空 | 说明 | 来源 |
  |---|---|---|---|---|
  | `orderId` | number | 否 | | :990 |
  | `orderNo` | string | 否 | 如 `20250401001` | :990 |
  | `cellNo` | string | 否 | 分配格口号，如 `M05` | :990 |
  | `openTimeoutMinutes` | number | 否 | 须在此分钟内完成存入关门，超时订单自动取消；取 `order.openTimeoutMinutes`（缺省 10） | :990,:998 |
- **错误码（事务内，校验序固定 `5004 → 4004 → 8002`，来源 #18① :1346）**
  | code | HTTP | 触发条件 | 来源 |
  |---|---|---|---|
  | `5004` | 200 | 黑名单用户 | :994,:1346 |
  | `4004` | 200 | 柜机不可用（离线/故障/维护中）；软删柜机同归此码 | :994,:1346 |
  | `8002` | 200 | 该类型无空闲格口 | :994,:1346 |
  | `1001` | 200 | `[推断]` `lockerId` 缺失/格式非法 | :1272 |
  | `1002` | 200 | `[推断]` `lockerId` 对应柜机不存在（但 #18 把"不存在"并入 4004，需确认；见陷阱表） | :1346 |
- **规则**：分配空闲格口 `FREE → RESERVED`；创建订单 `IN_PROGRESS`（`startAt=null`）；生成开门指令 `OPEN_CELL`（reason=`USER_DROP`），由柜机拉取执行（14.2/14.3）。来源：:995-996。
- **幂等性**：**不幂等**——每次调用创建新订单 + 新预留格口。前端须防止重复提交（如按钮 loading/本地去重）。`[推断]`

### 13.8 我的订单列表 `GET /api/app/v1/orders`
- **鉴权**：access。来源：:917。
- **查询参数**：`status`（可选，枚举同管理端 7.1，可空=全部）、`page`、`pageSize`。来源：:1002。
- **响应 `data`**：`{ list: [...], total: number }`。
  `list[]` 字段：
  | 字段 | 类型 | 可空 | 说明 | 来源 |
  |---|---|---|---|---|
  | `id` | number | 否 | | :1009 |
  | `orderNo` | string | 否 | | :1009 |
  | `lockerId` | number | 否 | | :1009 |
  | `lockerNo` | string | 否 | 柜机 code | :1009 |
  | `siteName` | string | 否 | | :1010 |
  | `cellNo` | string | 否 | | :1010 |
  | `cellType` | enum | 否 | | :1010 |
  | `startAt` | string(ISO8601) | `[可空]` | 未存入=null | :1011 |
  | `endAt` | string | `[可空]` | 未终局=null | :1011 |
  | `status` | enum | 否 | 订单状态 | :1011 |
  | `payAmount` | number(分) | `[可空]` | 未支付=null | :1012 |
  | `estimatedAmount` | number(分) | `[可空]` | **仅「已存入且未结算」**非空，其余 null；5 分钟粒度参考快照，**禁渲染为锁定价** | :1013,:1019-1025 |
  | `pickupCode` | string | `[可空]` | **仅「已存入且未取件」**返回，否则 null | :1013,:1019 |
- **错误码**：`2001`（401）；`[推断]` `1001`（非法 `status` 枚举/分页非法，但分页越界不报 1001，见全局约定）。来源：`[推断]`。
- **幂等性**：GET，天然幂等。

### 13.9 订单详情 `GET /api/app/v1/orders/:id`
- **鉴权**：access。来源：:917。
- **响应 `data`**：
  - `order`：`{ id, orderNo, status, baseFee, overtimeFee, discount, payAmount, startAt, endAt, estimatedAmount, pickupCode }`（各金额可空，口径同 13.8；`baseFee/overtimeFee/discount/payAmount` 为支付成功时定格的费用构成）。来源：:1032-1036,:1045。
  - `locker`：`{ id, lockerNo, siteName, cellNo, cellType }`。来源：:1036。
  - `timeline`：`[{ event, title, at }]`，`event ∈ CREATED/OPENED/FINISHED/CANCELLED/FORCE_ENDED/REFUNDED`（#6 :1334）。来源：:1037-1038,:1334。
  - `payments`：`[{ payNo, amount, channel, status, paidAt }]`，按发生顺序；未支付=`[]`。来源：:1039,:1046。
- **错误码**
  | code | HTTP | 触发条件 | 来源 |
  |---|---|---|---|
  | `3001` | 200 | 订单不存在 | :1043 |
  | `8003` | 200 | 非本人订单 | :1043 |
  | `2001` | 401 | 未登录 | `[推断]` |
- **规则**：支付成功 ≠ 订单完成，结算由取件关门（14.4 规则2）驱动。来源：:1047。
- **幂等性**：GET，天然幂等。
- **注意**：C 端 13.9 **不返回** `openedNotClosed` 字段（该字段是管理端 7.2 详情专属，见 §16 #12）。`[冲突/澄清]` 见陷阱表。

### 13.10 取消未开门订单 `POST /api/app/v1/orders/:id/cancel`
- **鉴权**：access。来源：:917。
- **请求字段**：`reason`（string，可选）。来源：:1051。
- **响应 `data`**：`null`。来源：:1053。
- **错误码**
  | code | HTTP | 触发条件 | 来源 |
  |---|---|---|---|
  | `3001` | 200 | 订单不存在 | :1053 |
  | `8003` | 200 | 非本人 | :1053 |
  | `3002` | 200 | ① 非「未完成存入」（`IN_PROGRESS` 且 `startAt` 空）不可取消；② **开门指令已回执 `DONE`**（柜门已开）→ 同样 `3002`，提示「柜门已开启…」 | :1053,:1346③ |
- **规则**：仅「未完成存入」可取消 → `CANCELLED`、格口释放 `RESERVED → FREE`，**无费用流水**。来源：:1053。
  - 已存入（`startAt` 非空，含 `TIMEOUT`）→ `3002`，**不能走此取消**；须支付补缴取件或管理端强制结束。`[推断]` 关键约束。
- **幂等性**：对已 `CANCELLED` 订单重复取消 → `3002`（终态不可再取消）。`[推断]`

### 13.11 支付（模拟） `POST /api/app/v1/orders/:id/pay`
- **鉴权**：access。来源：:917。
- **请求体**：`{}`（**空，金额服务端计算，不信任前端传参**）。来源：:1057。
- **响应 `data`**
  | 字段 | 类型 | 可空 | 说明 | 来源 |
  |---|---|---|---|---|
  | `payNo` | string | 否 | 支付单号 `P+yyyyMMdd+5位序列` | :1062,:1084 |
  | `payAmount` | number(分) | 否 | 本次支付金额（已定格） | :1062 |
  | `channel` | enum | 否 | 一期=`MOCK_WECHAT`；`WECHAT`/`SYSTEM` 预留（#2 :1331） | :1062,:1331 |
  | `paidAt` | string(ISO8601) | 否 | 支付成功时刻 | :1063 |
  | `orderStatus` | enum | 否 | **返回当前实际状态** `IN_PROGRESS`/`TIMEOUT`，**非** `COMPLETED` | :1063,:1074 |
  | `paid` | boolean | 否 | `true`=已支付待取件（派生语义） | :1063,:1074 |
  | `openCommandIssued` | boolean | 否 | 是否已下发开门指令 `OPEN_CELL(USER_PICKUP)` | :1063 |
- **错误码（事务内）**
  | code | HTTP | 触发条件 | 来源 |
  |---|---|---|---|
  | `3002` | 200 | ① 仅 `IN_PROGRESS|TIMEOUT` 且已存入（`startAt` 非空）可支付；未存入/`CANCELLED/COMPLETED/FORCE_ENDED/REFUNDED`/`endAt` 非空（已取件）→ `3002` | :1067,:1082 |
  | `8003` | 200 | 非本人 | :1067,:1082 |
  | `3001` | 200 | 订单不存在 | :1082 |
  | `6001` | 200 | 费率未配置（两级皆未覆盖该时刻） | :1025,:1082 |
  | `8004` | 200 | `[推断]` 异常支付单状态（正常重复支付由幂等吸收，#4 :1310） | :1310 |
- **规则（事务内）**：计费现算 `baseFee+overtimeFee−discount`（下限 0，**按订单时刻解析费率**，高峰取 `general.peakPeriods`，优惠取最大者不叠加）→ 创建支付单 `SUCCESS` → `INCOME` 流水 → 生成开门指令 `OPEN_CELL(reason=USER_PICKUP)`。结算落账由**关门事件 14.4 规则2** 驱动：`IN_PROGRESS → COMPLETED`。来源：:1069-1070,:1076-1084。
  - **支付即定额**：成功即把费用构成定格到订单，关门事件只落账不改价（ADR-0001）。来源：:1079。
  - 全免单（应付 0）仍落 0 元 `SUCCESS` 支付单 + 0 元 `INCOME` 流水（否则「已支付待取件」无从判定）。来源：:1083。
- **幂等性**：**幂等**——已支付且未取件 → 不重复扣费、重发 `OPEN_CELL(USER_PICKUP)`、返回**首次**支付信息；`TIMEOUT` 单按支付时刻现算差额补缴（累计应收−已付，下限 0）；已取件 → `3002`。来源：:1068,:1080-1081。
- **二期预留**：`/api/app/v1/pay/notify` 回调（鉴权豁免+验签），一期不实现。来源：:1072。

### 13.12 创建预约 `POST /api/app/v1/reservations`
- **鉴权**：access。来源：:917。
- **请求字段**
  | 字段 | 类型 | 必填 | 约束 | 来源 |
  |---|---|---|---|---|
  | `lockerId` | number | 必填 | | :1091 |
  | `cellType` | enum | 必填 | `SMALL`/`MEDIUM`/`LARGE` | :1091 |
  | `planStartAt` | string(ISO8601) | 必填 | 开始时间 | :1092 |
  | `planEndAt` | string(ISO8601) | **必填** | 结束时间（契约冻结必填；`general.defaultOccupancyHours` 已移除，#10 :1338） | :1092,:1099 |
- **响应 `data`**：`{ reservationId, resvNo(如 R20250401001), cellNo }`。来源：:1095。
- **错误码（校验序固定 `5004 → 4004 → 8002 → 8006 → 8007`，#25① :1353）**
  | code | HTTP | 触发条件 | 来源 |
  |---|---|---|---|
  | `5004` | 200 | 黑名单 | :1097,:1353 |
  | `4004` | 200 | 柜机不可用 | :1097,:1353 |
  | `8002` | 200 | 无空闲格口（余位先于时段判定） | :1097,:1353 |
  | `8006` | 200 | 时段非法：`start≥end` / 时长超 `reservation.maxHours` / `planStartAt` 不晚于当前时刻（应走 13.7 立即寄存） | :1097,:1353,:1339 |
  | `8007` | 200 | 同用户同时段已有 `PENDING` 预约（半开区间相交，首尾相接不算冲突） | :1097,:1353 |
  | `1001` | 200 | `[推断]` 必填缺失/格式非法 | :1272 |
- **规则**：分配格口 `FREE → RESERVED` → 预约 `PENDING`。来源：:1097。失败整体回滚、不留半成品占用。来源：#25① :1353。
- **幂等性**：不幂等（每次创建新预约）。`[推断]`

### 13.13 我的预约列表 `GET /api/app/v1/reservations`
- **鉴权**：access。来源：:917。
- **查询参数**：`status`（`PENDING|USED|CANCELLED|NOSHOW|EXPIRED`，可选）、`page`、`pageSize`。来源：:1103。
- **响应 `data`**：`{ list: [...], total: number }`。
  `list[]` 字段：
  | 字段 | 类型 | 可空 | 说明 | 来源 |
  |---|---|---|---|---|
  | `id` | number | 否 | | :1110 |
  | `resvNo` | string | 否 | | :1110 |
  | `lockerId` | number | 否 | | :1110 |
  | `lockerNo` | string | 否 | | :1110 |
  | `siteName` | string | 否 | | :1111 |
  | `cellNo` | string | 否 | | :1111 |
  | `cellType` | enum | 否 | | :1111 |
  | `planStartAt` | string | 否 | | :1112 |
  | `planEndAt` | string | 否 | | :1112 |
  | `actualStartAt` | string | `[可空]` | 未转单=null | :1112 |
  | `status` | enum | 否 | | :1113 |
  | `orderId` | number | `[可空]` | 未转单=null | :1113 |
- **错误码**：`2001`（401）；`[推断]` `1001`（非法 status 枚举）。
- **幂等性**：GET，天然幂等。

### 13.14 取消预约 `POST /api/app/v1/reservations/:id/cancel`
- **鉴权**：access。来源：:917。
- **请求字段**：`reason`（string，可选）。来源：:1121。
- **响应 `data`**：`null`。来源：:1123。
- **错误码**
  | code | HTTP | 触发条件 | 来源 |
  |---|---|---|---|
  | `8003` | 200 | 非本人 | :1123 |
  | `6202` | 200 | 仅 `PENDING` 可取消（已 `USED`/`CANCELLED`/`NOSHOW`/`EXPIRED` → `6202`） | :1123 |
  | `6201` | 200 | 预约不存在 | `[推断]` 对称于 13.15 :1129 |
- **规则**：成功后释放格口 `RESERVED → FREE`，**不扣分**。来源：:1123。
- **幂等性**：已非 `PENDING` 重复取消 → `6202`。`[推断]`

### 13.15 开始使用预约（转单） `POST /api/app/v1/reservations/:id/use`
- **鉴权**：access。来源：:917。
- **请求体**：无。来源：:1125-1127（响应直接给 `orderId`）。
- **响应 `data`**：`{ orderId, orderNo, cellNo }`。来源：:1127。
- **错误码（校验序：归属校验前先判黑名单，#25② :1353）**
  | code | HTTP | 触发条件 | 来源 |
  |---|---|---|---|
  | `5004` | 200 | 黑名单（需求 §4.8 开始使用同受拦截） | :1129 |
  | `8003` | 200 | 非本人 | :1129 |
  | `6201` | 200 | 预约不存在 | :1129 |
  | `6202` | 200 | 仅 `PENDING`，或当前时间 ∉ 使用窗口 | :1129 |
  | `4004` | 200 | 柜机不可用 | :1129 |
- **使用窗口**（关键）：`[planStartAt − reservation.holdMinutes, planStartAt + reservation.noShowMinutes)`，**半开区间**（含下界、不含上界）。窗口外 → `6202`。来源：:1129,:1353②。
- **规则（事务内）**：创建订单 `IN_PROGRESS`（`startAt=null`，关联 `reservationId`）→ 预约置 `USED`（**终态不可逆**，回填 `actualStartAt`/`orderId`）→ 生成开门指令 `OPEN_CELL(USER_DROP)`。后续存入/取件与 13.7/13.11 同链路。来源：:1131。
  - `USED` 不可逆：关联订单取消**不回退**预约（管理端亦不可取消 `USED`）。来源：CONTEXT.md:26、#25② :1353。
- **幂等性**：`USED` 终态，重复调用 → `6202`。`[推断]`（已转单后 status≠PENDING）

### 13.16 积分明细 `GET /api/app/v1/score-logs`
- **鉴权**：access。来源：:917。
- **查询参数**：`page`、`pageSize`。来源：:1135。
- **响应 `data`**：结构同管理端 9.3（仅本人数据）。`[未明确]` 文档未贴出字段形状，仅指向管理端 9.3。**建议联调前向主 agent 要管理端 9.3 的准确字段（至少含 `delta`/`reason`/`createdAt`/累计分等）。** 来源：:1135。
- **错误码**：`2001`（401）；`[推断]` `1001`（分页非法，但越界钳制不报）。
- **幂等性**：GET，天然幂等。

---

## 2. 四类关键时序（端到端链路 + 关键字段流转）

> 关键事实（来源 CONTEXT.md:14、:63-64、API 文档:1199、:1212-1217、:1372）：
> - 后端语境里**只有 `DOOR_CLOSED` 驱动订单状态与计时起点**；`OPEN_CELL` 开门指令**不改订单状态**。
> - 指令生命周期 `PENDING → SENT → DONE/FAILED`；`SENT` 超 5 分钟无回执 → `EXPIRED`；**`FAILED`/`EXPIRED` 不自动重发**，由用户重试动作重新生成。
> - 计费口径：`DOOR_CLOSED`（存入）落定 `startAt`；支付时刻现算并定格（支付即定额）；取件 `DOOR_CLOSED`（规则2）结算落账、释放格口、核销取件码。

### 时序 A：建存件单 → 开门 → 关门 → 取件码生成 → 取件核销
```
[C 端] POST /orders (lockerId, cellType)
        → 13.7 事务：分配格口 FREE→RESERVED；建单 IN_PROGRESS(startAt=null)
        → 同事务生成指令 OPEN_CELL(USER_DROP)，状态 PENDING
        ← { orderId, orderNo, cellNo, openTimeoutMinutes }
        （务必在 openTimeoutMinutes 内完成存入，否则 1min 任务扫描自动取消 #19① :1347）

[设备] GET /commands/pull  → 指令 PENDING→SENT(sentAt=服务器时间)
       POST /commands/:id/ack {success:true} → 指令 SENT→DONE（柜门物理开启）
       （若 SENT 超 5min 无 ack → EXPIRED，不自动重发；用户须重试动作）

[用户] 放入物品 → 关柜门
[设备] POST /cell-events [{cellNo, type:DOOR_CLOSED, orderNo}]
        → 14.4 规则1：匹配未存入订单(IN_PROGRESS & startAt=null)
        → startAt = 服务器接收时间；格口 RESERVED→IN_USE；生成 6 位取件码(同柜机唯一)
        ← {accepted:1}
        （订单仍 IN_PROGRESS；此时 13.8/13.9 才返回 pickupCode 与 estimatedAmount）

[C 端] POST /orders/:id/pay {}   (取件前支付)
        → 13.11 事务：计费现算并定格；建支付单 SUCCESS；INCOME 流水；
          生成 OPEN_CELL(USER_PICKUP)，状态 PENDING；orderStatus=IN_PROGRESS, paid=true
        ← { payNo, payAmount, channel, paidAt, orderStatus, paid, openCommandIssued }

[设备] pull/ack 同上前 → 开门；用户取走物品 → 关柜门
[设备] POST /cell-events [{type:DOOR_CLOSED}]
        → 14.4 规则2：匹配已支付待取件(IN_PROGRESS|TIMEOUT & startAt非空 & endAt空)
        → IN_PROGRESS→COMPLETED（TIMEOUT 补录 endAt）；格口 IN_USE→FREE；取件码核销
```
**要点**：`OPEN_CELL` 任何阶段都不改订单状态；状态跃迁完全由 `DOOR_CLOSED` 驱动。取件码在「存入关门」生成、「取件关门」核销。

### 时序 B：待到支付 → 支付 → 生成取件指令
```
适用：已存入订单(IN_PROGRESS, startAt 非空) 或 TIMEOUT 单。
[C 端] POST /orders/:id/pay {}
        → 13.11 同事务：
           计费 = baseFee + overtimeFee − discount（下限0，按订单时刻解析费率）
           支付即定额：费用构成定格到订单
           建支付单 SUCCESS + INCOME 流水（全免单也落 0 元）
           生成 OPEN_CELL(USER_PICKUP) PENDING
        ← orderStatus=IN_PROGRESS|TIMEOUT, paid=true, openCommandIssued=true
        （幂等：已支付未取件重调 → 不重复扣费、重发指令、返回首次支付信息）
[设备] pull → SENT → ack DONE → 开门取件 → 关门 DOOR_CLOSED(规则2) → COMPLETED/释放/核销
```
**要点**：支付成功 ≠ 订单完成（`orderStatus` 仍 `IN_PROGRESS`/`TIMEOUT`，用 `paid` 判断「已支付待取件」）；结算由取件关门驱动。TIMEOUT 单补缴：按支付时刻现算差额（累计应收−已付，下限0）。

### 时序 C：预约 → 转单（窗口内）
```
[C 端] POST /reservations (lockerId, cellType, planStartAt, planEndAt)
        → 13.12 事务：校验 5004→4004→8002→8006→8007；分配格口 FREE→RESERVED；预约 PENDING
        ← { reservationId, resvNo, cellNo }

（等待至使用窗口 [planStartAt − holdMinutes, planStartAt + noShowMinutes) 半开区间）
[C 端] POST /reservations/:id/use
        → 13.15 事务：黑名单5004(归属前) → 仅本人8003 → 不存在6201 → 仅PENDING/窗口内6202 → 柜机4004
           建单 IN_PROGRESS(startAt=null, 关联 reservationId)
           预约置 USED（终态不可逆，回填 actualStartAt/orderId）
           生成 OPEN_CELL(USER_DROP) PENDING
        ← { orderId, orderNo, cellNo }
        （后续存入/取件/支付 完全复用 时序A/时序B 的 13.7/13.11 链路）

超时未使用：过 planStartAt + noShowMinutes → 1min 爽约扫描 → NOSHOW + 扣分 + 释放格口；
            柜机/格口故障 → 受影响 PENDING 预约 EXPIRED + 释放格口、不扣分（#25⑤ :1353）。
```
**要点**：转单窗口为半开区间；`USED` 不可逆，订单取消不回退预约。预约占用格口期间状态为 `RESERVED`，与存件单占用同源。

### 时序 D：取消（订单 / 预约 两条独立路径）
```
路径 D1 — 取消订单（仅未存入）：
[C 端] POST /orders/:id/cancel {reason?}
        → 13.10：仅 IN_PROGRESS & startAt=null 可取消
           成功 → CANCELLED + 格口 RESERVED→FREE，无费用流水
           开门指令已回执 DONE → 3002（「柜门已开启，请放入物品后关门，或联系客服」）
           已存入(startAt非空, 含TIMEOUT) → 3002（不能取消，须支付补缴取件/管理端强制结束）
           非本人 → 8003；不存在 → 3001

路径 D2 — 取消预约（仅 PENDING）：
[C 端] POST /reservations/:id/cancel {reason?}
        → 13.14：仅 PENDING 可取消
           成功 → 释放格口 RESERVED→FREE，不扣分
           非 PENDING(USED/CANCELLED/NOSHOW/EXPIRED) → 6202；非本人 → 8003
```
**两条路径独立**：预约 `USED` 后转出的订单，取消该订单**不回退**预约（预约已终态）；预约取消只释放其占用的 `RESERVED` 格口，与订单无耦合。

---

## 3. 令牌生命周期（C 端请求层地基）

来源：API 文档:60-64、:917、:1267-1319、§17.1 :1369、§1.3 :40-48。

- **有效期**：access **2h**（7200s，`expiresIn` 字段返回）；refresh **30d**。来源：:63,:1369。
- **登录链路**：`POST /auth/login` 带 `wx.login` 的 `code` → 换 openid → 首登自动注册（初始 `score.max`、`NORMAL`）；返回 `accessToken`+`refreshToken`。`code` 无效/微信侧错误 → `8001`（HTTP 200）。来源：:939,:1307。
- **刷新链路**：access 失效时，客户端用 `X-Refresh-Token` 头调 `POST /auth/refresh` → 返回新 `accessToken`+`expiresIn`。来源：:943,:63。
- **401 判定与刷新时机**（通用约定，来源 :45、:1307-1308）：
  - `HTTP 401 + code 2001`：**access 失效/未登录** → 客户端**静默刷新一次**（带 refresh 调 13.2）→ 成功则重放原请求；刷新失败才清登录态跳登录。
  - `HTTP 401 + code 2005`：**refresh 失效**（过期/已作废）→ **直接清登录态、跳登录**，不再重试。
  - `HTTP 401 + code 9001`：设备端签名失败（C 端不出现）。
- **登出**：`POST /auth/logout` 作废 refreshToken（鉴权要求见 13.3 节 `[未明确]`）。来源：:947。
- **黑名单与登录**：黑名单用户**允许登录**（`status=BLACKLISTED` 返回），但下单/创建预约/开始使用被 `5004` 拦截（不拦截登录与查看）。来源：:939,:64。→ C 端请求层**不应**在登录态失效时假定用户可操作，须对 `5004` 做禁用提示。
- **业务错误形态**：`HTTP 200 + code ≠ 0` 承载业务错误（如 `8001/3002/5004`…）；前端拦截器按 `code` 统一提示，**不硬编码文案**（按 `message` 展示）。来源：:1319。
- **拦截器建议**（实现参考，非文档裁决）：所有需 access 的请求带 `Authorization: Bearer <access>`；收到 401+2001 入队并发刷新一次、重放；收到 401+2005 清登录。`[推断]`

---

## 4. 字段陷阱表（易用错字段 + 禁止用法）

| 字段 | 所属端点 | 陷阱 / 禁止用法 | 来源 |
|---|---|---|---|
| `estimatedAmount` | 13.8 / 13.9 | **5 分钟粒度参考快照**，**禁止渲染为锁定价/实付**。仅「已存入且未结算」(`IN_PROGRESS|TIMEOUT` 且 `startAt` 非空) 非空，未存入与已终局一律 `null`；已支付定格正常单返回定格值（不再随时间增长）；费率未配置 `6001` 时为 `null`。实扣以支付时刻（13.11）现算为准。 | :1019-1025,:1021-1025 |
| `pickupCode` | 13.8 / 13.9 | **仅在「已存入且未取件」时返回**，其余为 `null`。禁止假设列表/详情恒有值；取件码 6 位、同柜机唯一、取件核销。 | :1013,:1019,:1371 |
| `openedNotClosed` | 管理端 7.2（**非 C 端**） | 「开门未闭」异常标记。§16 #12 给出的字段名 `order.openedNotClosed`（布尔、终局恒 `false`、格口保持 `RESERVED`）是**管理端详情字段**；**C 端 13.9 响应未含此字段**。任务简报称「后端 §16 只声明有异常提示未给字段名」——实际 #12 已给出 `openedNotClosed` 这一名称 `[冲突/澄清]`。C 端若需展示该异常，文档目前未给字段，**须新增契约或复用，禁止在 C 端 13.9 直接读取（会 undefined）**。 | :1340(#12),:1353(#25③) |
| `orderStatus`（支付响应） | 13.11 | 支付成功返回**当前实际状态** `IN_PROGRESS`/`TIMEOUT`，**不是** `COMPLETED`（旧契约有误，#8 修正）。**禁止**渲染「已完成」「支付成功即结束」。**用 `paid` 判断「已支付待取件」**。 | :1063,:1074,:1336(#8) |
| `paid` | 13.11 | 派生语义：`true` = 已支付待取件（支付成功 ≠ 订单完成，结算由取件关门驱动）。取件码屏校验 14.6 的 `paid` = 已付清。两者语义一致（均已付清/已定格）。 | :1074,:1251,:1264 |
| `payable` | 14.6（柜机屏，C 端不直接消费） | 5 分钟粒度**参考快照**，实际扣款以支付时刻（13.11）服务端现算为准。**禁止渲染为「应付锁定价」**（持续计费下金额随取件时间增长）。任务要求单列以防误用。 | :1245,:1253,:1262-1263 |
| `cellAvailability` | 13.6 | 柜机非 `ONLINE` 时三项**恒为 0 且不报错**（正常响应非错误）。**禁止**把 `0` 当异常；前端据此**禁用下单入口**即可。 | :975,:977 |
| `online` | 13.6 | 口径 = `locker.status == ONLINE`（已按优先级链收敛）。离线/故障/维护中非 ONLINE → `false`，仍正常返回。 | :971,:977 |
| `planEndAt` | 13.12 | **必填**（契约冻结）；`general.defaultOccupancyHours` 已从冻结参数表移除（无处生效）。**禁止**前端省略或代填默认值。 | :1092,:1099,:1338(#10) |
| `startAt` / `endAt` | 13.8 / 13.9 | 未存入 `startAt=null`；未终局 `endAt=null`。`estimatedAmount` 与 `pickupCode` 的可空性直接依赖 `startAt` 是否为空。**禁止**把 null 当 0 或当「1970」。 | :1011-1013,:1044 |
| `payAmount` | 13.8 / 13.9 | 未支付为 `null`；支付定格后为定格值（不再增长）。**禁止**把 `estimatedAmount` 当 `payAmount` 展示。 | :1012,:1034 |
| `status`（订单） | 13.8 / 13.9 | 含新增枚举 `CANCELLED`（下单未存入被取消）。注意**两侧费用口径差异**：管理端取消单费用按 0 返回（#19④ :1347），而 C 端 13.8/13.9 的未结算口径仍为 `null`——**不要**把 C 端 `null` 误当 0 计入金额。 | :1329(#1),:1347(#19④) |
| `status`（预约） | 13.13 | 枚举 `PENDING|USED|CANCELLED|NOSHOW|EXPIRED`。`USED` 为终态不可逆。 | :1103,:1353 |
| 分页 `page`/`pageSize` | 列表类 | 越界**钳制**到末页/上限 100，**不报 1001**（仅真正非法参数才 1001）。**禁止**把钳制后 `total` 当错误。 | :1374 |
| 金额单位 | 全局 | **所有金额字段单位为分（整数）**，非元。禁止前端直接当元展示（需 ÷100）。 | :917 |

---

## 5. 空缺点标注（C 端入口约束）

- **用户端没有「站点列表」端点**。§13（用户端接口，:915-1137）共 16 个端点，与 §1 路由表（:118「用户端 16 个端点」）一致；其中「柜机」类仅有 `GET /lockers/by-code`（13.6，按 `code` 反查），**不存在** `GET /sites`、`GET /sites/:id/lockers` 等站点浏览端点。来源：:915-1137、:118。
- **推论（C 端入口设计约束）**：C 端无法「浏览站点/柜机地图」，**只能凭柜机 `code` 反查单台柜机**（13.6）。即入口必须由「扫码」或「用户已知/历史记录的 code」驱动，不能做站点级列表/选择页。`[推断]` 基于文档无站点端点这一事实。
- **补充**：站点维度信息仅在 13.6 返回 `siteId`/`siteName`/`position`（反查结果的附带字段），以及订单/预约列表里的 `siteName`（历史关联），均非独立站点查询。来源：:970,:1010,:1111。
- **对实现的影响**：若产品需要「附近柜机」「站点列表」，文档当前未提供支撑端点，须作为缺口上报（人类决策），本底稿不臆造端点。

---

## 6. 文档与常识/预期的冲突 & 未说清处（供主 agent 决策）

### 已确认的文档内部冲突
1. ~~**13.6 鉴权冲突**：§13 总则（:917）「除 13.1/13.2 外均需 Bearer」 vs §1 路由例外（:25）把 `/lockers/by-code` 列为免 access 查询。→ 需确认扫码查柜机是否强制登录。~~ **【2026-09-20 已更正，不是冲突】** §1 例外清单（:25）是**命名风格例外**（动作型查询用子路径，该句紧接 :24 的 RESTful 风格说明），不是鉴权豁免；:917 总则与 §16 #29（:1359「**需登录态**」）一致。→ **13.6 需要 access**，无需向后端确认。详见文末更正段。
2. **`openedNotClosed` 字段名**：任务简报称「后端 §16 只声明有异常提示未给字段名」，但实际 §16 #12（:1340）已明确给出字段名 `order.openedNotClosed`（管理端）。且该字段**不在 C 端 13.9**。→ C 端如需展示异常须新增契约。
3. **13.11 `orderStatus` 语义修正**（#8 :1336）：旧契约返回 `COMPLETED` 有误，现返回实际状态。→ 前端不能按「支付即完成」实现。
4. **取消分支补充**（#9 :1337）：13.10 开门指令已 `DONE` 时返回 `3002` 为契约补充，旧契约未定义。

### 文档没说清 / 需联调确认（比结论更重要）
- **13.3 登出鉴权**：文档未说明是否需要 access/refresh 来定位用户作废 refreshToken（路径属 `/auth/*` 例外却又需识别用户）。`[未明确]`
- **13.16 积分明细响应形状**：仅写「结构同管理端 9.3」，但管理端 9.3 字段未在本文档贴出 → C 端 TS 类型缺准确定义。`[未明确]`
- **13.7 `lockerId` 不存在的码**：#18① 把「柜机不存在/不可用」统一归 `4004`，但错误码表 :1284 另有 `4001 柜机不存在`。两者是否同一场景？C 端应同时兜 `4001`/`4004` 以防歧义。`[推断/待确认]`
- **`code` 与 openid 映射失败的其他码**：登录仅列 `8001`，但微信侧限频/网络等是否返回其他码未定义。`[未明确]`
- **refresh 并发/多端**：refresh 30d 且可主动作废（登出），多端登录互踢策略未定义。`[未明确]`
- **`pickupCode` 长度/格式**：文档称 6 位纯数字（:1371），但 C 端展示位数属交互决策，底稿仅给「6 位、同柜机唯一」事实。
- **`cellType` 枚举全集**：示例仅 `MEDIUM`，文档未穷举 `SMALL/MEDIUM/LARGE` 三值是否完整（推测三值，CONTEXT.md:56 提格口类型）。`[推断]`
- **`status`（订单）完整枚举**：13.8 称「同管理端 7.1 枚举」，但未在用户端章节贴出全集；已知含 `IN_PROGRESS/TIMEOUT/COMPLETED/CANCELLED/FORCE_ENDED/REFUNDED`（来自 #1、#24 等）。C 端状态机字典应覆盖这些。`[推断]`

> 本底稿止于事实基线与可行性；所有 `[未明确]`/`[冲突]` 项请主 agent 在联调前与后端对齐，不在本文件中做裁决。

---

## 7. 更正（2026-09-20，D1 grilling 期间复核）

### 7.1 [`[冲突]` → 事实] 13.6 `GET /lockers/by-code` **需要 access**，不存在冲突

原文把 §13 总则与 §1 例外清单判为「两处矛盾」，并推荐按「免 access」实现。**这是误读**，原文漏引了决定性的一处：

| 出处 | 原文 | 性质 |
|---|---|---|
| `API设计文档.md:24-25` | 「RESTful 风格；资源小写复数（`GET /api/v1/orders`）；动作型操作用子路径（`POST /api/v1/orders/{id}/force-end`）。／例外：`/auth/*`（认证动作集合）、`/api/app/v1/lockers/by-code`（按编号查询的动作型查询）。」 | **命名风格例外**：:25 紧接 :24 的 RESTful 命名说明，讲的是「该路径用子路径表达动作」，**不是**鉴权豁免 |
| `API设计文档.md:917` | 「除 13.1/13.2 外均需 `Authorization: Bearer <accessToken>`」 | 鉴权总则 |
| `API设计文档.md:1359`（§16 增量 #29） | 「…**需登录态**（用户端通道，无额外权限码；路径为 §1.1 登记的按编号查询动作型查询例外）」 | **决定性**：既点名「需登录态」，又点名 :25 那条例外是「命名例外」 |

**结论：13.6 需要 access，与其余 14 个业务端点一致。** 不需要向后端确认。

**对下游的影响（已据此裁决）**：C 端**不存在「未登录扫码看柜机」这条路** —— 未登录时后端不提供任何业务数据（用户端只有 13.1 / 13.2 免鉴权）。这直接决定了 D1 的登录闸门形态：登录只能是**隐式前置**，不能做成「用户可见的按需动作」。

### 7.2 复核方式与范围

本节由 D1（#5）grilling 期间的主 agent 复核，**逐条对 `java/smart-locker/docs/API设计文档.md` 原文行号验证**，未使用二手转述。除本节外，本底稿的其余结论（16 端点契约、四类时序、令牌判定式、15 条字段陷阱）**未被推翻**。
