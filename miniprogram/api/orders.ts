// `13.7` 创建存件订单 —— 手写 DTO + 请求函数，**只做搬运**（`07` §3 硬规则 2）。
//
// 契约：API设计文档.md §13.7 `POST /api/app/v1/orders` (:979-998)
// 出处底稿：`docs/research/R1-api-mapping.md` §1「13.7 · 请求字段 / 响应 data / 错误码」
// 消费方：`docs/spec/01-entry-and-identity.md` §6（柜机页的「开始存件」）、
//         `docs/spec/08-waiting-state.md` §2（移交进等待态的唯一合法入参来源）。
//
// ⚠️ **`api/` 不含业务分支**（`07` §3 硬规则 2）。「`4004` 该说什么」「`8002` 该说什么」
// 是 `04` §9 的文案裁决，落在页面；本模块只把异常对象交出去。
//
// ⚠️⚠️ **`13.7` 不幂等**（`R1` §1「13.7 · 幂等性」逐字：
// 「**不幂等** —— 每次调用创建新订单 + 新预留格口。前端须防止重复提交」）。
// 这是本端点与 `13.11`（幂等，可安全重试）的**根本差别**，也是页面必须有
// 技术性防抖的原因 —— 而那条防抖是 `09` §5.8 硬规则 5 明确允许的**唯一两种禁用之一**
// （「请求进行中的技术性防抖」）。

import type { CreateOrderRequest, CreateOrderResponse } from '../types/orders'
import type { RequestResult } from '../request/types'
import { API_PREFIX } from '../request/config'
import { request } from '../request/index'

/** `13.7` 的路径 —— `POST /api/app/v1/orders`（契约 §13.7 :979）。 */
export const CREATE_ORDER_PATH = `${API_PREFIX}/orders`

// ⚠️ **DTO 在 `../types/orders.ts`**，不在本文件（`07` §3 硬规则 3：「`types/` 与 `api/`
// 一一对应」）。本模块只做搬运（§3 硬规则 2）—— 「`13.7` 不幂等 ⇒ 调用方必须自己防
// 重复提交」那条硬口径与各字段的契约出处，随 DTO 一起搬去了 `types/orders.ts`。
/**
 * `13.7` 创建存件订单 —— 分配一个空闲格口并生成开门指令。
 *
 * @param body `lockerId`（来自 `13.6`）+ `cellType`（用户点的那一档）
 * @returns 成功时订单摘要（含 `orderId` 与 `openTimeoutMinutes`）；失败时统一异常对象
 *
 * ⚠️ **失败码归因在页面**（`04` §9 / `09` §7.2）：
 *   • `4004` → 「这台柜机暂时不可用，请换一台或稍后再试」（`04` §9 逐字）
 *   • `8002` → 「该类型格口已满，换一种类型或换一台柜机」（`04` §9 逐字）
 *   • `5004` → 走受限卡（`07` §4.2 的**唯一特判**，请求层已归一成 `kind: 'restricted'`）
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
