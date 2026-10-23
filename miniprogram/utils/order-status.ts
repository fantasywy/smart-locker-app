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

/**
 * **订单谓词的入参形状** —— 只有这三个字段参与判定，凡是带着它们的 DTO 都能直接传进来
 * （`OrderSummary` / `OrderDetailOrder` / `PickupOrder` / `OrderCardOrder` 都满足）。
 *
 * ⚠️ 刻意不要求 `id` / `payAmount` 之类的字段：谓词只回答「这张单在状态机的哪一格」，
 * 多要一个字段就等于把「订单是什么」这一层知识抄进判定层。
 */
export interface OrderStatusFields {
  status: OrderStatus
  startAt: string | null
  endAt: string | null
}

/**
 * **是否还在办**（进行中）。
 *
 * ## 为什么多个页面必须共用这一条谓词
 *
 * 首页进行中区、订单列表的「进行中 / 已结束」分组、订单详情的「历史单」出口、
 * 等待页的终局识别，问的是**同一个问题**。各写一遍 `status === 2 || ...` 的后果
 * 不是重复三行，而是**同一张订单在首页是「进行中」、在列表却落到「已结束」** ——
 * 用户会拿这个矛盾去对客服。
 *
 * ## 口径
 *
 *   • 候选：`status == 2`，或（`status == 4` 且 `endAt == null`）；
 *   • `status == 1` 按进行中兜底：一期不产生，但若服务端意外回显，
 *     它仍进进行中组、标签「待支付」、不给任何 CTA（spec §6）。
 */
export function isActiveOrder(order: OrderStatusFields): boolean {
  return (
    order.status === 1 ||
    order.status === 2 ||
    (order.status === 4 && order.endAt === null)
  )
}

/**
 * **是否已经结束**（历史 / 终局分组）。
 *
 * ⚠️ 它就是 `isActiveOrder` 的补集 —— 不另写一份 `3 / 5 / 6 / 7 /（4 且 endAt 有值）`：
 * 同一件事的正反两份写法，正是它们迟早对不上的原因（改了一处漏了另一处）。
 */
export function isEndedOrder(order: OrderStatusFields): boolean {
  return !isActiveOrder(order)
}

/**
 * **能不能取件** —— 已存入 / 已超时未取件，两个入口（详情主行动、共享取件层）同一口径。
 *
 * 判据：`status ∈ {2, 4}` 且**已经存入**（`startAt` 有值）且**还没取走**（`endAt` 为空）。
 * `endAt` 有值说明这一单已经结束，取件层没有存在的理由。
 */
export function canPickupOrder(order: OrderStatusFields): boolean {
  return (
    (order.status === 2 || order.status === 4) &&
    order.startAt !== null &&
    order.endAt === null
  )
}

/**
 * **`13.9` 回显是否已经终局** —— 取件层网络核对时的唯一判据。
 *
 * ⚠️ 它与 `isEndedOrder` **不是**同一条谓词，别合并：
 *   • `isEndedOrder` 回答「这条单该进列表的哪一组」，`status == 4` 且 `endAt` 为空时仍是进行中；
 *   • 本谓词回答「支付结果还有没有意义」，只要 `endAt` 有值（哪怕 `status` 还是 `2` / `4`）
 *     就说明柜门已经关好、订单已落定，再重发支付只会白跑一趟。
 *
 * 所以它是 `isEndedOrder` 的**超集**：终局那四个状态码，加上「任何 `endAt` 有值的单」。
 */
export function isTerminalOrder(order: OrderStatusFields): boolean {
  return (
    order.endAt !== null ||
    order.status === 3 ||
    order.status === 5 ||
    order.status === 6 ||
    order.status === 7
  )
}
