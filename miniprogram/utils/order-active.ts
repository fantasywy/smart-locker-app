// **进行中订单** —— 排序与合并的口径（spec #57 §2 / §6）；**判定**归 `utils/order-status.ts`。
//
// ## 为什么需要这个模块
//
// 首页进行中区与订单列表「进行中」组必须回答同一个问题：哪些单还在办、谁排前面。
// 两处各写一遍 `status === 2 || (status === 4 && endAt === null)` 的后果不是重复三行，
// 而是**同一张订单在首页是「进行中」、在列表却落到「已结束」** —— 用户会拿它去对客服。
// ⇒ 排序与合并只在这里有一份实现，两页都调用它。
//
// ⚠️ **判定（`isActiveOrder`）的唯一家在 `utils/order-status.ts`** —— 它与订单列表的
// 「已结束」分组是同一件事的两面，写在这里就等于那条谓词的第二份实现。本模块只转出它。
//
// ## 口径
//
//   • 候选：`status == 2`，或（`status == 4` 且 `endAt == null`）；
//     `status == 1` 按进行中兜底（一期不产生；若出现，列表与首页都进进行中组，
//     标签「待支付」、无 CTA —— 见 `utils/order-status.ts`）。
//   • 排序：已超时 → 待存入 → 已存入；同档按 `id` 倒序。
//
// ⚠️ 本模块是纯函数：不碰 `wx.*`、不读时钟、不写 storage。

import { isActiveOrder } from './order-status'
import type { OrderSummary } from '../types/orders'

/**
 * 是否属于「进行中」组 —— 转出 `utils/order-status.ts` 的唯一实现，方便本模块的消费方
 * 从同一个入口拿到「判定 + 排序」两件事。
 *
 * ⚠️ 这里**只有转发**，没有第二份实现：`status` 的语义判定全在 `order-status.ts`。
 */
export { isActiveOrder }

/**
 * 进行中组内的排序权重 —— 已超时（0）→ 待存入（1）→ 已存入（2）。
 *
 * `status == 1` 落最后一档：它只作为兜底出现，不该插到真实在途单前面。
 */
function activeRank(order: OrderSummary): number {
  if (order.status === 4 && order.endAt === null) return 0
  if (order.status === 2 && order.startAt === null) return 1
  if (order.status === 2) return 2
  return 3
}

/** 按 `id` 去重 —— 两条查询可能返回同一条（服务端状态恰好在两次请求之间变化）。 */
function dedupe(orders: readonly OrderSummary[]): OrderSummary[] {
  const byId = new Map<number, OrderSummary>()
  for (const order of orders) {
    if (!byId.has(order.id)) byId.set(order.id, order)
  }
  return [...byId.values()]
}

/**
 * 合并两条进行中流 —— 过滤 → 按 `id` 去重 → 排序。
 *
 * 入参是**服务端的原始页记录**（不是已过滤的流），所以调用方不需要自己再跑一遍
 * `isActiveOrder`。同 id 重复时保留**先出现**的那条（调用方按 `status=2` 在前、
 * `status=4` 在后的顺序传入，与订单列表两条流的顺序一致）。
 */
export function mergeActiveOrders(
  ...streams: ReadonlyArray<readonly OrderSummary[]>
): OrderSummary[] {
  const merged = dedupe(streams.flat().filter(isActiveOrder))
  return merged.sort((left, right) => {
    const rank = activeRank(left) - activeRank(right)
    if (rank !== 0) return rank
    return right.id - left.id
  })
}
