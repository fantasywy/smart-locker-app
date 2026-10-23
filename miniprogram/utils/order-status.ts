// **订单状态** —— 后端数字码 + 两个时刻 → 标签 / 色档。全站唯一的一处判定。
//
// ## 为什么需要一个模块
//
// spec §6 的状态标签表是**九行**，而判定条件里有两个时刻参与：
//
//   • `2` 且 `startAt` 为空 → 待存入；`startAt` 有值 → 已存入；
//   • `4` 且 `endAt` 为空 → 已超时；`endAt` 有值 → 超时结束。
//
// 订单列表卡、首页卡与订单详情页都要说同一句话。若三处各写一遍 `if`，
// 第一次改动（比如把 `4` 闭单叫法从「已超时」改成「超时结束」）只会落在其中一处，
// 于是同一张订单在首页是「已超时」、在详情却是「超时结束」。
// ⇒ 判定收进这里，`startup/copy.ts` 的 `ORDER_STATUS_LABELS` 只负责**字**。
//
// ## 两条边界
//
// 1. **色档是样式决策，不是文案。** 它不参与 `copy.ts`（那里只有用户能读到的字），
//    但必须与 `tone-chip` 的档名一致：`ok`（主色）/ `warn`（警示）/ `muted`（中性）。
// 2. **`status == 1` 按进行中兜底**：一期不产生这个状态，但它若出现，标签是
//    「待支付」、**不给任何 CTA**（spec §6）。本模块只负责标签，不负责 CTA。
//
// ⚠️ 本模块是纯函数，不碰 `wx.*`、不读当前时间 —— 与 `utils/datetime.ts` 同一纪律。

import { ORDER_STATUS_LABELS } from '../startup/copy'
import type { OrderStatusKey } from '../startup/copy'
import type { OrderStatus } from '../types/orders'

/**
 * 状态标签的色档 —— 直接对应 `styles/_mixins.scss` 的 `tone-chip` 三档。
 *
 * ⚠️ 三档而不是五档：订单状态只说「正常在途 / 需要注意 / 已结束」三类。
 * 引入 `info` / `danger` 会让同一屏出现四种颜色，而颜色本身不承载更多信息。
 */
export type OrderStatusTone = 'ok' | 'warn' | 'muted'

/** 状态摘要 —— 页面只消费这两个字段（外加时刻，由页面决定取哪个）。 */
export interface OrderStatusBadge {
  /** 语义键 —— 测试与样式选择器用；不直接上屏。 */
  key: OrderStatusKey
  /** 用户看到的标签（逐字来自 `ORDER_STATUS_LABELS`）。 */
  label: string
  /** 标签色档。 */
  tone: OrderStatusTone
}

/**
 * 把 `13.9` 的 `status` + `startAt` / `endAt` 收敛成状态标签。
 *
 * 判定顺序与 spec §6 的表逐行对应：先看 `status`，只有 `2` / `4` 才继续看时刻。
 * 未列出的组合（理论上不存在）按「已结束」兜底 —— 中性档，不假装还在进行中。
 */
export function resolveOrderStatus(
  status: OrderStatus,
  startAt: string | null,
  endAt: string | null,
): OrderStatusBadge {
  if (status === 1) return badge('pendingPayment', 'warn')
  if (status === 2) return badge(startAt === null ? 'waitingDrop' : 'stored', 'ok')
  if (status === 3) return badge('completed', 'muted')
  if (status === 4) {
    const closed = endAt !== null
    return badge(closed ? 'timeoutEnd' : 'timeout', closed ? 'muted' : 'warn')
  }
  if (status === 5) return badge('ended', 'muted')
  if (status === 6) return badge('refunded', 'muted')
  return badge('cancelled', 'muted')
}

function badge(key: OrderStatusKey, tone: OrderStatusTone): OrderStatusBadge {
  return { key, label: ORDER_STATUS_LABELS[key], tone }
}
