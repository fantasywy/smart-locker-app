// **预约端点**（`13.12` 创建 / `13.13` 我的预约列表 / `13.14` 取消 / `13.15` 开始使用）
// 的手写 DTO —— 只做形状，没有行为。
//
// 契约：API设计文档.md §13.12–§13.15
//
// ⚠️ 本模块遵守**类型层与请求层分离**的硬规则（「`types/` 与 `api/` 一一对应」）：
//
//     types/reservations.ts  ← 形状（本文件，纯类型）
//     api/reservations.ts    ← 搬运（入参 → 请求 → 出参 DTO）
//
// ⚠️ 本模块遵守类型层的五条规则：不发明字段、不改字段名、不合并语义不同的字段、
// 可空显式标 `| null`、枚举值与后端逐字一致、**找不到契约依据的字段不写**。
// 中文映射属文案层（`startup/copy.ts`），**不进类型层**。

import type { CellType } from './orders'

/**
 * 预约状态 —— **后端数字码 `1 | 2 | 3 | 4 | 5`**。
 *
 * 契约：API设计文档.md §13.13（`status`：`1`(PENDING)`|2`(USED)`|3`(CANCELLED)`
 * `|4`(NOSHOW)`|5`(EXPIRED)`）。
 *
 * ⚠️ 与 `OrderStatus` 同理，数字码是后端的值域；`PENDING` / `USED` 这些英文名
 * 只活在文档与注释里，**不成为第二套运行时值**。中文显示（待使用 / 已使用 /
 * 已取消 / 已爽约 / 已失效）只在文案层。
 */
export type ReservationStatus = 1 | 2 | 3 | 4 | 5

/**
 * `13.12` 创建预约请求体 —— `POST /api/app/v1/reservations`。
 *
 * 契约：API设计文档.md §13.12
 *
 * ```json
 * { "lockerId": 11, "cellType": 2,
 *   "planStartAt": "2025-04-01T10:00:00+08:00", "planEndAt": "2025-04-01T12:00:00+08:00" }
 * ```
 *
 * ⚠️ 只有这四个字段，**一个都不多**：契约里没有备注 / 数量 / 价格之类。
 * 「预计价格」不在契约里 ⇒ 本仓库不预造（spec §10 明确禁止）。
 *
 * ⚠️ **时间字段的时区口径与响应不对称**（repo 既有事实，`utils/datetime.ts`
 * 的 `formatReservationRange` 注释已登记）：请求用**无偏移本地 ISO**
 * （`2026-09-22T15:00:00`，后端 `LocalDateTime`），响应带 `+08:00`。
 * 契约示例里的 `+08:00` 是文档漂移，按实现口径发无偏移本地时间。
 */
export interface CreateReservationRequest {
  /**
   * 柜机 ID —— **只能来自 `13.6` 的响应**（ADR-0001：预约同样必须扫码创建）。
   *
   * ⚠️ 本页是唯一入口：柜机页「预约」带 `lockerId` 进来；不得从任何本地缓存补一个。
   */
  lockerId: number

  /** 格口规格 —— 后端数字码 1–4（1 小 / 2 中 / 3 大 / 4 特大）。 */
  cellType: CellType

  /** 预约开始时刻 —— **无偏移**本地 ISO（见接口头说明）。 */
  planStartAt: string

  /** 预约结束时刻 —— **无偏移**本地 ISO；必须晚于 `planStartAt`（契约 `8006`）。 */
  planEndAt: string
}

/**
 * `13.12` 响应 `data` —— 创建成功后的预约摘要。
 *
 * 契约：API设计文档.md §13.12
 *
 * ```json
 * { "reservationId": 301, "resvNo": "R20250401001", "cellNo": "M05" }
 * ```
 *
 * ⚠️ `resvNo` / `cellNo` 只做结果回执：列表页不展示预约单号（spec §14.5 的
 * 同类口径）；`cellNo` 的展示价值在列表卡里，而不是创建成功那一刻。
 */
export interface CreateReservationResponse {
  /** 预约 ID —— 后续 `13.14` / `13.15` 的路径参数。 */
  reservationId: number
  /** 预约单号（如 `R20250401001`）—— 不上屏。 */
  resvNo: string
  /** 服务端分配的格口号（如 `M05`）—— 只作行内定位辅助。 */
  cellNo: string
}

/**
 * `13.13` 列表行 —— 我的预约列表的**全部可得信息**（C 端没有预约详情端点）。
 *
 * 契约：API设计文档.md §13.13
 *
 * ```json
 * { "id": 301, "resvNo": "R20250401001", "lockerId": 11, "lockerNo": "WD-01",
 *   "siteName": "万达广场店", "cellNo": "M05", "cellType": 2,
 *   "planStartAt": "...", "planEndAt": "...", "actualStartAt": null,
 *   "status": 1, "orderId": null }
 * ```
 *
 * ⚠️ **没有 `createdAt` / `cancelSource` / `expireReason`**：C 端说不出谁取消的、
 * 也说不具体原因；卡片只按 `status` 说五句显示态，不猜归因。
 * `actualStartAt` 不单独展示（对用户没有下一步价值）。
 */
export interface Reservation {
  /** 预约 ID（`number` 是对 Java `Long` 的有意收窄）。 */
  id: number
  /** 预约单号 —— 不上屏。 */
  resvNo: string
  /** 柜机 ID —— 只用于定位，不展示。 */
  lockerId: number
  /** 柜机码（如 `WD-01`）—— 用户到现场要认的字符串。 */
  lockerNo: string
  /** 站点名。 */
  siteName: string
  /** 具体格口号 —— 只作行内定位辅助，不给它中文名（spec §14.6）。 */
  cellNo: string
  /** 格口档位 —— 数字码 1–4；中文档名在文案层。 */
  cellType: CellType
  /** 预约开始时刻 —— 响应带 `+08:00`。 */
  planStartAt: string
  /** 预约结束时刻 —— 响应带 `+08:00`。 */
  planEndAt: string
  /** 实际开始时刻 —— `USED` 后有值；列表不单独展示。 */
  actualStartAt: string | null
  /** 状态数字码，见 `ReservationStatus`。 */
  status: ReservationStatus
  /** 转单后的订单 ID —— `USED` 且有订单时用于「查看订单」。 */
  orderId: number | null
}

/**
 * `13.13` 响应 `data` —— `{list,total}`。
 *
 * ⚠️ 页面只认识 `PageOf.records`；`list → records` 的映射在 `api/reservations.ts`
 * 一处完成（repo 的分页口径：不在每个页面各写一遍）。
 */
export interface ReservationListResponse {
  list: Reservation[]
  total: number
}

/** `13.14` 取消预约 —— 成功响应 `data` 为 `null`。 */
export type CancelReservationResponse = null

/**
 * `13.15` 开始使用预约响应 `data`。
 *
 * 契约：API设计文档.md §13.15
 *
 * ```json
 * { "orderId": 2002, "orderNo": "20250401002", "cellNo": "M05" }
 * ```
 *
 * ⚠️ 同事务已生成开门指令；页面唯一正确的去向是 `redirectTo` 等待页
 * （`orderId`、`mode=drop`）。`orderNo` 不上屏。
 */
export interface UseReservationResponse {
  orderId: number
  orderNo: string
  cellNo: string
}
