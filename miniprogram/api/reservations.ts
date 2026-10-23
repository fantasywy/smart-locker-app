// **预约端点**（`13.12` 建预约 / `13.13` 我的预约 / `13.14` 取消 / `13.15` 开始使用）——
// 手写 DTO + 请求函数，**只做搬运**。
//
// 契约：API设计文档.md §13.12–§13.15
//
// ⚠️ **`api/` 不含业务分支**。「`6202` 该说什么」「`8002` 该说什么」是文案层的裁决，
// 落在页面；本模块只把异常对象交出去。
//
// ⚠️ `13.13` 的响应外层是 `{list,total}`，而 `utils/pagination.ts` 只认识
// `PageOf.records`。**`list → records` 只在这里映射一次** —— 页面不写
// `list` 这个字段名，三个列表页也不会各映射一遍（那种重复迟早漂移成两种形状）。

import type { PageOf } from '../utils/pagination'
import type {
  CancelReservationResponse,
  CreateReservationRequest,
  CreateReservationResponse,
  Reservation,
  ReservationListResponse,
  UseReservationResponse,
} from '../types/reservations'
import type { RequestResult } from '../request/types'
import { API_PREFIX } from '../request/config'
import { request } from '../request/index'

/** `13.12`–`13.15` 的共同基座 —— `POST/GET /api/app/v1/reservations`。 */
export const RESERVATIONS_PATH = `${API_PREFIX}/reservations`

/** 单条预约路径 —— `13.14` / `13.15` 共用；页面不碰 URL。 */
function reservationPath(id: number): string {
  return `${RESERVATIONS_PATH}/${id}`
}

/**
 * `13.12` 创建预约 —— 锁住未来一个时段的格口。
 *
 * @param body `lockerId`（来自 `13.6`）+ `cellType`（数字码 1–4）+ 无偏移本地时段的起止
 * @returns 成功时预约摘要；失败时统一异常对象（归因在页面）
 *
 * ⚠️ **本端点不幂等**：每调用一次就多一条预约 + 一个 `RESERVED` 格口。
 * 页面必须自己防重复提交（技术性防抖是允许的禁用态之一）。
 *
 * ⚠️ 业务失败码（页面按白名单归因）：
 *   • `5004` → 受限（请求层归一成 `kind: 'restricted'`，不展示服务端 message）
 *   • `4004` → 柜机不可用
 *   • `8002` → 该档位无空闲
 *   • `8006` → 时段非法（正常路径不可达，竞态兜底，按 message 直出）
 *   • `8007` → 同时段已有 `PENDING` 预约
 */
export function createReservation(
  body: CreateReservationRequest,
): Promise<RequestResult<CreateReservationResponse>> {
  return request<CreateReservationResponse>(RESERVATIONS_PATH, {
    method: 'POST',
    data: body,
  })
}

/**
 * `13.13` 我的预约列表 —— 不传 `status`（两份分组都在客户端按状态归并）。
 *
 * @param page 页码（服务端从 1 开始）
 * @param pageSize 每页条数（spec §10：每页 10）
 * @returns 成功时 `{records,total}`（已把契约的 `list` 映射成 `records`）
 *
 * ⚠️ **不传 `status`**：预约列表要同时显示待使用与已结束；单值 `status` 过滤会让
 * 其中一组凭空消失。分组是**展示层**的事，不是筛选。
 */
export async function listReservations(
  page: number,
  pageSize: number,
): Promise<RequestResult<PageOf<Reservation>>> {
  const result = await request<ReservationListResponse>(
    `${RESERVATIONS_PATH}?page=${page}&pageSize=${pageSize}`,
  )
  if (!result.ok) return result
  return {
    ok: true,
    data: { records: result.data.list, total: result.data.total },
  }
}

/**
 * `13.14` 取消预约 —— 仅 `PENDING` 可取消；成功后释放格口，不扣分。
 *
 * @returns 成功时 `null`；`6202`（状态已变）等失败原样交给页面
 *
 * ⚠️ 请求体里的可选 `reason` 本端不发送：C 端界面没有让用户填理由的入口，
 * 编一个假理由比不传更糟（契约里它是可选）。
 */
export function cancelReservation(
  id: number,
): Promise<RequestResult<CancelReservationResponse>> {
  return request<CancelReservationResponse>(`${reservationPath(id)}/cancel`, {
    method: 'POST',
  })
}

/**
 * `13.15` 开始使用预约 —— 转成存件订单并生成开门指令。
 *
 * @returns 成功时 `orderId` 等回执；`6202`（窗口外 / 状态已变）由页面归因
 *
 * ⚠️ 成功后的落点是**等待页**（`redirectTo`，带 `orderId` 与 `mode=drop`）；
 * 本模块不决定去向。
 */
export function useReservation(id: number): Promise<RequestResult<UseReservationResponse>> {
  return request<UseReservationResponse>(`${reservationPath(id)}/use`, {
    method: 'POST',
  })
}
