// **订单端点**（`13.7` 建单 / `13.9` 详情 / `13.10` 取消 / `13.11` 支付）的手写 DTO ——
// 只做形状，没有行为。
//
// 契约：API设计文档.md §13.7 (:1105-1124) / §13.9 (:1178-1197) /
//       §13.10 (:1200-1204) / §13.11 (:1206-1235)
//
// ⚠️ 本模块遵守**类型层与请求层分离**的硬规则（「`types/` 与 `api/` 一一对应 ——
// 一个端点模块配一个 DTO」）。对应的端点函数在同名的
// `api/` 模块里，**两者一一对应**：
//
//     types/orders.ts   ← 形状（本文件，纯类型，编译后不产出可执行代码）
//     api/orders.ts     ← 搬运（入参 → 请求 → 出参 DTO）
//
// ⚠️ 本模块遵守类型层的五条规则：不发明字段、不改字段名、不合并语义不同的字段、
// 可空显式标 `| null`、枚举值与后端逐字一致、**找不到契约依据的字段不写**。
// 中文映射属文案层，**不进类型层**。

/**
 * 格口类型 —— **后端数字码 `1 | 2 | 3 | 4`**（1 小 / 2 中 / 3 大 / 4 特大）。
 *
 * 契约：API设计文档.md §13.7 (:1110 请求体示例 `"cellType": 2`)
 *
 * ⚠️⚠️ **这里曾是 `'SMALL' | 'MEDIUM' | 'LARGE'` 三档字符串枚举，已按
 * spec #57 §3「实现前置（契约漂移）」删除。** 后端 `/v3/api-docs` 的 `cellType`
 * 就是数字码；字符串枚举续命会让请求体在运行时是一个服务端认不出的值，
 * 而 TS 仍然全绿（形状是我们自己声明的）。
 *
 * ⚠️ 它与 `13.6` 的 `cellAvailability` 阶名（`small` / `medium` / `large` / `extraLarge`）
 * **不是同一套写法**。数字码 ↔ 余位键 ↔ 中文档名的对应关系只允许存在于
 * 柜机页的**一张档位表**里；类型层在这里如实保留后端的数字码，不做「顺手归一」。
 *
 * ⚠️ 中文显示（小格口 / 中格口 / 大格口 / 特大格口）属文案层。
 */
export type CellType = 1 | 2 | 3 | 4

/**
 * `13.7` 请求体 —— `POST /api/app/v1/orders`。
 *
 * 契约：API设计文档.md §13.7 (:1107-1111)
 *
 * ```json
 * { "lockerId": 11, "cellType": 2 }
 * ```
 *
 * ⚠️ 只有两个字段，**一个都不多**：契约里没有「备注」「数量」「预约时长」之类。
 * 柜机页四档入口各发一次这个请求，用户选的是**规格**，不是格口 ——
 * 具体分配哪个格口由服务端在事务里做（`FREE → RESERVED`，`:1121`）。
 */
export interface CreateOrderRequest {
  /**
   * 柜机 ID —— **只能来自 `13.6` 的响应**（它是 `lockerId` 的唯一来源）。
   *
   * ⚠️ 客户端**不得**从任何别处编一个：ADR-0001 已裁决 C 端不做柜机浏览，
   * `lockerId` 的长相（自增主键）客户端无从推导，猜一个等于把订单下到别的柜机上。
   */
  lockerId: number

  /**
   * 格口规格 —— 用户点的是**哪一档**（1 小 / 2 中 / 3 大 / 4 特大）。
   *
   * ⚠️ 用户看到的档名由文案层定，发出去的是后端数字码。
   */
  cellType: CellType
}

/**
 * `13.7` 响应 `data` —— 建单成功后的订单摘要。
 *
 * 契约：API设计文档.md §13.7 (:1113-1117)
 *
 * ```json
 * { "orderId": 1001, "orderNo": "20250401001", "cellNo": "M05", "openTimeoutMinutes": 10 }
 * ```
 */
export interface CreateOrderResponse {
  /**
   * 订单 ID —— **等待态的入参**（等待态的三条入口一律携带它）。
   *
   * ⚠️ `number` 是对 Java `Long` 的有意收窄，理由同 `types/auth.ts` 的 `LoginUser.id`。
   */
  orderId: number

  /**
   * 订单号（如 `20250401001`）。契约 §13.7 (:1116)。
   *
   * ⚠️ **本页不用它**，等待态也不用（等待态不倒计时、不展示单号）。
   */
  orderNo: string

  /**
   * 服务端分配的格口号（如 `M05`）。契约 §13.7 (:1116)。
   *
   * ⚠️ **本页与等待态都不展示它**：格口号在订单行里才有定位价值。
   */
  cellNo: string

  /**
   * 开门超时分钟数 —— **`openTimeoutMinutes` 唯一的合法来源**（契约逐字：
   * 「只在 `13.7` 建单响应里」；转单与支付路径都拿不到它）。
   *
   * ⚠️⚠️ **两条硬约束同时落在这个字段上**：
   *
   * 1. **不硬编码、不猜。** 缺省值 10 是**后端的**缺省，运营可以在后台改它。
   * 2. **它唯一合法的去向是作为页面参数传给等待态**（`redirectTo` 的 query）。
   *    它**没有任何合法的展示位置**（「绝不倒计时、绝不显示分钟数」）。
   */
  openTimeoutMinutes: number
}

/**
 * 订单状态 —— **后端数字码 1–7**（与 `/v3/api-docs` 一致）。
 *
 * 契约：API设计文档.md §7.1（管理端订单列表）/ §13.9（订单详情回显）
 *
 * | 码 | 含义 |
 * |---|---|
 * | 1 | `PENDING_PAYMENT` 待支付 |
 * | 2 | `IN_PROGRESS` 进行中（未存入 / 已存入未取件） |
 * | 3 | `COMPLETED` 已完成 |
 * | 4 | `TIMEOUT` 已超时（`endAt` 为空时仍未取件；补缴取件关门后 `endAt` 有值） |
 * | 5 | `FORCE_ENDED` 已强制结束 |
 * | 6 | `REFUNDED` 已退款 |
 * | 7 | `CANCELLED` 已取消 |
 *
 * ⚠️ **等待页只能从 `status` / `startAt` / `endAt` / `payAmount` 派生页面态。**
 * `paid` / `openCommandIssued` 是支付端点的回执字段，**不参与等待页判断**：
 * 前者证明不了门开没开，后者只说明指令生成过。两个字段在本仓库的页面上零引用。
 */
export type OrderStatus = 1 | 2 | 3 | 4 | 5 | 6 | 7

/**
 * `13.9` 订单详情响应 `data` —— 四个块由后端装配，客户端只读。
 *
 * 契约：API设计文档.md §13.9 (:1178-1197)
 *
 * ```json
 * {
 *   "order": { ... },
 *   "locker": { ... },
 *   "timeline": [ ... ],
 *   "payments": [ ... ]
 * }
 * ```
 *
 * ⚠️ 等待页只消费 `order` 块；`locker` / `timeline` / `payments` 仍在 DTO 里如实保留 ——
 * 形状归类型层，页面用不用是另一件事（订单详情页会消费其余三块）。
 */
export interface OrderDetailResponse {
  order: OrderDetailOrder
  locker: OrderDetailLocker
  /** 时间轴 —— 由后端统一装配；等待页不展示。 */
  timeline: OrderTimelineEvent[]
  /** 支付流水 —— 未支付时为 `[]`；等待页不展示。 */
  payments: OrderPayment[]
}

/**
 * `13.9` 的 `order` 块。
 *
 * 契约：API设计文档.md §13.9 (:1184)
 *
 * ⚠️ 费用三项与 `payAmount` 在未支付时为 `null`；`payAmount` 是**累计实收**
 * （分），不是某一次支付额。等待页只在终局把 `payAmount` 渲染成「实付 / 已付」。
 */
export interface OrderDetailOrder {
  /** 订单 ID（`number` 是对 Java `Long` 的有意收窄）。 */
  id: number
  /** 订单号 —— 等待页不展示（spec §14.5）。 */
  orderNo: string
  status: OrderStatus
  /** 基础费（分）；未支付为 null。 */
  baseFee: number | null
  /** 超时费（分）；未支付为 null。 */
  overtimeFee: number | null
  /** 优惠（分）；未支付为 null。 */
  discount: number | null
  /** 累计实收（分）；未支付为 null。 */
  payAmount: number | null
  /** 存入时刻 —— **关门落定**后才有值；为空表示还没存入。 */
  startAt: string | null
  /** 结束时刻 —— 取件关门 / 强制结束 / 退款后才有值。 */
  endAt: string | null
  /** 当前时长预估（分）；等待页**不渲染**（非终局不出现金额）。 */
  estimatedAmount: number | null
  /** 6 位取件码 —— 只在已存入未取件时返回。 */
  pickupCode: string | null
}

/** `13.9` 的 `locker` 块 —— 柜机与格口定位信息；等待页不展示。 */
export interface OrderDetailLocker {
  id: number
  lockerNo: string
  siteName: string
  /** 具体格口号 —— 只作行内定位辅助，不给它中文名（spec §14.6）。 */
  cellNo: string
  cellType: CellType
}

/**
 * `pickup-sheet` 需要的订单视图 —— **共享取件层的唯一入参**（spec §5 / §11）。
 *
 * 为什么需要这一层而不是直接把 `13.9` 的 `order` 块交给组件：
 *   • 顶行要 `站点名 · 柜机码 · 格口`，这三项在 `13.9` 里属于 `locker` 块；
 *   • 订单列表（`13.8`）的每一项天然带这三个字段，同一个组件必须两边都能用；
 *   • 组件不该知道「详情页有 locker 块、列表页没有」—— 那是宿主的装配差异。
 *
 * ⇒ 宿主负责把 `13.9` 的 `order` + `locker` 拼成本形状（`13.8` 的行直接满足）。
 * 这里**没有新增契约字段**：九个字段全部来自 `13.8` / `13.9` 的既有响应。
 *
 * ⚠️ **不含 `orderNo`**：取件层顶行只到格口，订单号全程不上屏（spec §14.5）。
 * ⚠️ **不含 `paid` / `openCommandIssued`**：组件判态只用
 * `status` / `startAt` / `endAt` / `payAmount` / `estimatedAmount`。
 */
export interface PickupOrder {
  id: number
  status: OrderStatus
  startAt: string | null
  endAt: string | null
  /** 累计实收（分）；未支付为 `null`。 */
  payAmount: number | null
  /** 当前时长预估（分）；缺少时取件层整行不渲染。 */
  estimatedAmount: number | null
  siteName: string
  lockerNo: string
  /** 具体格口号 —— 只作行内定位辅助，不给它中文名（spec §14.6）。 */
  cellNo: string
}

/**
 * `13.9` 的时间轴事件。
 *
 * 契约：§13.9 后端实现要点（事件值域）：
 * `CREATED` 恒有；`OPENED` 有 `startAt` 时；终局事件按状态取一个
 * （`FINISHED` / `CANCELLED` / `FORCE_ENDED` / `REFUNDED`）。
 *
 * ⚠️ `title` 是服务端下发的展示文案；等待页不使用它（页面不展示时间轴）。
 */
export interface OrderTimelineEvent {
  event: 'CREATED' | 'OPENED' | 'FINISHED' | 'CANCELLED' | 'FORCE_ENDED' | 'REFUNDED'
  title: string
  at: string
}

/**
 * `13.9` 的 `payments` 行 —— 订单支付单列表。
 *
 * 契约：API设计文档.md §13.9 (:1191)
 *
 * ⚠️ `amount` 单位是**分**；等待页不使用本块，支付记录归订单详情页。
 */
export interface OrderPayment {
  payNo: string
  amount: number
  /** 支付渠道数字码（一期模拟渠道为 `1`(MOCK_WECHAT)）。 */
  channel: number
  /** 支付单状态数字码（`2`(SUCCESS) 为成功）。 */
  status: number
  paidAt: string
}

/**
 * `13.10` 取消未开门订单 —— 成功响应 `data` 为 `null`。
 *
 * 契约：API设计文档.md §13.10 (:1200-1204)
 */
export type CancelOrderResponse = null

/**
 * `13.11` 支付（模拟）响应 `data`。
 *
 * 契约：API设计文档.md §13.11 (:1206-1235)
 *
 * ```json
 * { "payNo": "...", "payAmount": 1800, "channel": 1,
 *   "paidAt": "...", "orderStatus": 2, "paid": true, "openCommandIssued": true }
 * ```
 *
 * ⚠️ `paid` / `openCommandIssued` **只存在于 DTO**：等待页不得用它们判断状态，
 * 也不得把「已支付」写成终局（支付成功 ≠ 订单完成，结算由关门事件驱动）。
 */
export interface PayOrderResponse {
  payNo: string
  /** 本次支付额（分）。 */
  payAmount: number
  channel: number
  paidAt: string
  /** 支付后的**当前实际状态**（`2`(IN_PROGRESS)`|4`(TIMEOUT)`）。 */
  orderStatus: OrderStatus
  /** 是否已支付待取件 —— 派生语义，**等待页零引用**。 */
  paid: boolean
  /** 是否已生成开门指令 —— **等待页零引用**。 */
  openCommandIssued: boolean
}
