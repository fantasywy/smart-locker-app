// **订单端点**（`13.7` 建单 / `13.9` 详情 / `13.10` 取消 / `13.11` 支付）——
// 手写 DTO + 请求函数，**只做搬运**。
//
// 契约：API设计文档.md §13.7 (:1105-1124) / §13.9 (:1178-1197) /
//       §13.10 (:1200-1204) / §13.11 (:1206-1235)
//
// ⚠️ **`api/` 不含业务分支**。「`4004` 该说什么」「`8002` 该说什么」
// 是文案层的裁决，落在页面；本模块只把异常对象交出去。
//
// ⚠️⚠️ **`13.7` 不幂等**（契约逐字：
// 「**不幂等** —— 每次调用创建新订单 + 新预留格口。前端须防止重复提交」）。
// 这是本端点与 `13.11`（幂等，可安全重试）的**根本差别**，也是页面必须有
// 技术性防抖的原因 —— 而那条防抖是既定交互口径明确允许的**唯一两种禁用态之一**
// （「请求进行中的技术性防抖」）。

import type {
  CancelOrderResponse,
  CreateOrderRequest,
  CreateOrderResponse,
  OrderDetailResponse,
  OrderListResponse,
  OrderStatus,
  OrderSummary,
  PayOrderResponse,
} from '../types/orders'
import type { RequestResult } from '../request/types'
import type { PageOf } from '../utils/pagination'
import { API_PREFIX } from '../request/config'
import { request } from '../request/index'

/** `13.7` 的路径 —— `POST /api/app/v1/orders`（契约 §13.7 :1105）。 */
export const CREATE_ORDER_PATH = `${API_PREFIX}/orders`

// ⚠️ **DTO 在 `../types/orders.ts`**，不在本文件（「`types/` 与 `api/`
// 一一对应」）。本模块只做搬运 —— 「`13.7` 不幂等 ⇒ 调用方必须自己防
// 重复提交」那条硬口径与各字段的契约出处，随 DTO 一起搬去了 `types/orders.ts`。
/**
 * `13.7` 创建存件订单 —— 分配一个空闲格口并生成开门指令。
 *
 * @param body `lockerId`（来自 `13.6`）+ `cellType`（用户点的那一档，数字码 1–4）
 * @returns 成功时订单摘要（含 `orderId` 与 `openTimeoutMinutes`）；失败时统一异常对象
 *
 * ⚠️ **失败码归因在页面**（本模块只搬运异常，不翻译文案）：
 *   • `4004` → 页面取 `LOCKER_PAGE_COPY.lockerUnavailableReason`
 *   • `8002` → 页面取 `LOCKER_PAGE_COPY.cellTypeFullReason`
 *   • `5004` → 走受限卡（请求层的**唯一特判**，已归一成 `kind: 'restricted'`）
 *
 * ⚠️ 请求体里的 `cellType` 是**后端数字码 1–4**（spec #57 §3 契约漂移修复）。
 * 页面只允许从自己的档位表取值，不得在这里做任何字符串 ↔ 数字转换。
 *
 * ⚠️ **本函数不幂等**：它每被调用一次就多一张订单 + 一个预留格口（见文件头）。
 * 调用方必须自己防重复提交。
 */
export function createOrder(
  body: CreateOrderRequest,
): Promise<RequestResult<CreateOrderResponse>> {
  return request<CreateOrderResponse>(CREATE_ORDER_PATH, {
    method: 'POST',
    data: body,
  })
}

/**
 * `13.9` 的路径 —— `GET /api/app/v1/orders/:id`（契约 §13.9 :1178）。
 *
 * ⚠️ 订单路径只有一个基座（`CREATE_ORDER_PATH`）：`/orders` 下的三个端点
 * （建单 / 详情 / 取消 / 支付）在这里拼一次，页面不碰 URL。
 */
function orderPath(orderId: number): string {
  return `${CREATE_ORDER_PATH}/${orderId}`
}

/**
 * `13.9` 订单详情 —— 等待页**唯一**的事实来源。
 *
 * @param orderId 订单 ID（`13.7` / `13.15` / `13.11` 的响应或页面参数）
 * @returns 成功时四块详情；失败时统一异常对象
 *
 * ⚠️ **等待页的页面态全部由本响应派生**：`status` / `startAt` / `endAt` / `payAmount`。
 * 用户说「门关好了」不算事实，`paid` / `openCommandIssued` 也不算 —— 只有这四项能落态。
 *
 * ⚠️ 业务失败 `3001`（不存在）/ `8003`（非本人）由页面统一收敛成
 * 「订单不存在或已删除」；本模块只搬运异常。
 */
export function getOrderDetail(orderId: number): Promise<RequestResult<OrderDetailResponse>> {
  return request<OrderDetailResponse>(orderPath(orderId))
}

/**
 * `13.10` 取消未开门订单 —— **仅存入等待**（`status=2 && startAt==null`）可取消。
 *
 * @param orderId 订单 ID
 * @returns 成功时 `null`；失败时统一异常对象
 *
 * ⚠️ 失败 `3002` 的两种成因（状态已变 / 开门指令已回执）在等待页有**两种不同**的呈现：
 * 前者用契约逐字「柜门已开启，请放入物品后关门，或联系客服」。归因在页面。
 * ⚠️ **本端点不是重试路径**：取消失败后不自动重发（存入路径没有重试）。
 */
export function cancelOrder(orderId: number): Promise<RequestResult<CancelOrderResponse>> {
  return request<CancelOrderResponse>(`${orderPath(orderId)}/cancel`, {
    method: 'POST',
  })
}

/**
 * `13.11` 支付（模拟）—— **幂等**，等待页在取件停滞时用它重新开门。
 *
 * @param orderId 订单 ID
 * @returns 成功时支付回执；失败时统一异常对象
 *
 * ⚠️ **幂等是它和 `13.7` 的根本差别**：已支付且未取件时不会重复扣费，
 * 只重发开门指令并返回首次支付信息。因此「重新开门」可以安全地再调一次；
 * 而 `13.7` 每调一次都会多一张订单，绝不能重试。
 *
 * ⚠️ 响应里的 `paid` / `openCommandIssued` **不得进入等待页判断**（见 DTO 注释）。
 */
export function payOrder(orderId: number): Promise<RequestResult<PayOrderResponse>> {
  return request<PayOrderResponse>(`${orderPath(orderId)}/pay`, {
    method: 'POST',
  })
}

/**
 * `13.8` 我的订单列表的查询参数 —— 只列契约里有的三个。
 *
 * ⚠️ 订单列表的两条流各有固定用法：
 *   • 进行中：`{ status: 2, pageSize: 20 }` 与 `{ status: 4, pageSize: 20 }`；
 *   • 历史：`{ pageSize: 10, page: N }`（**不带 status**）。
 * 调用方只传这三个字段，不在这里拼业务分支。
 */
export interface OrderListQuery {
  status?: OrderStatus
  pageSize?: number
  page?: number
}

/**
 * `13.8` 我的订单列表 —— `GET /api/app/v1/orders`。
 *
 * 服务端返回 `{ list, total }`，而全站列表推进工具统一吃 `PageOf.records`。
 * ⚠️ **`list` → `records` 的映射只在这里做一次**（repo-map §7 的裁决）：
 * 让每个页面各映射一遍，就是同一形状在两个地方各有一个家。
 *
 * ⚠️ `total` 如实带回给调用方，但**页面不得把它当用户可见数量**
 * （spec §6 的硬约束；首页「查看全部 N 个」按过滤后条数计，不走这个字段）。
 */
export async function getOrders(
  query: OrderListQuery = {},
): Promise<RequestResult<PageOf<OrderSummary>>> {
  const params: string[] = []
  if (query.status !== undefined) params.push(`status=${query.status}`)
  if (query.pageSize !== undefined) params.push(`pageSize=${query.pageSize}`)
  if (query.page !== undefined) params.push(`page=${query.page}`)
  const suffix = params.length === 0 ? '' : `?${params.join('&')}`

  const result = await request<OrderListResponse>(`${CREATE_ORDER_PATH}${suffix}`)
  if (!result.ok) return result
  return { ok: true, data: { records: result.data.list, total: result.data.total } }
}
