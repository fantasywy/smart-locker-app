// **订单卡** —— 订单列表的 `active` / `history` 变体与首页的 `home` 变体（#66 / spec §6）。
//
// ## 一张卡，三种变体
//
// | 变体 | 用在哪 | 不画什么 |
// |---|---|---|
// | `home` | 首页进行中订单区（#67） | 金额、主行动 |
// | `active` | 订单列表「进行中」组 | —— |
// | `history` | 订单列表「已结束」组 | 主行动 |
//
// 状态标签与色档**只从 `utils/order-status.ts` 取**（九行判定 + 三档色）。
// 卡片自己的职责只剩「按状态决定画哪些字段」——那张矩阵是 spec §6 的逐行契约：
//
//   • 待存入：`cellNo`（无时间）、无取件码、无金额、主行动「继续等待关门」；
//   • 已存入未支付：`cellNo · 存入时间`、取件码、参考金额、主行动「取件开门」；
//   • 已存入已支付：同上，金额词改成「实付」；
//   • 已超时：`cellNo · 存入时间`、取件码、参考金额、主行动「取件开门」；
//   • 已完成 / 超时结束 / 已结束：`cellNo · 取件时间`、无取件码、实付（超时结束用「已付」）、无行动；
//   • 已退款：不显示金额（13.9 不下发退款额，把 `payAmount` 写成「实付」等于说钱没退）；
//   • 已取消：不显示 `cellNo` 与时间（格口已释放，写了会指向一扇不属于他的门）。
//
// ## 三条边界
//
// 1. **组件不导航**：整卡点击只发 `tap`，卡内主行动只发 `action`。去向由宿主决定
//    （列表卡进详情 / 等待页 / 打开共享取件层），组件不知道当前页面栈。
// 2. **主行动 `catchtap`**：不冒泡到整卡，否则点「取件开门」会先跳详情。
// 3. **不搬 `orderNo` / `payNo` / `channel`**：这些字段在 DTO 里如实存在，
//    但卡片 `data` 一个都不接 —— 少搬一个字段就少一条上屏的路。
//
// ⚠️ 本组件是纯展示 + 两个事件：不读 storage、不发请求、不碰 `wx.*`。

import { ORDER_COPY, PICKUP_SHEET_COPY } from '../../startup/copy'
import { formatOrderTime, formatOrderTimeInProgress } from '../../utils/datetime'
import { formatMoney } from '../../utils/money'
import { resolveOrderStatus } from '../../utils/order-status'
import type { OrderStatusBadge } from '../../utils/order-status'
import type { OrderCardOrder } from '../../types/orders'

/** 三种版式 —— 只描述用途，不携带数据。 */
type OrderCardVariant = 'home' | 'active' | 'history'

/** 格口行里 `cellNo` 与时刻之间的分隔符 —— 标点不是文案。 */
const CELL_SEPARATOR = ' · '

interface OrderCardData {
  /** 站点名 —— 三种变体的首行都显示它。 */
  siteName: string
  statusLabel: string
  statusTone: string

  /** 第二行：`cellNo` / `cellNo · 时间`；已取消为空串。 */
  cellLine: string

  /** 取件码块。 */
  showPickupCode: boolean
  pickupCodeLabel: string
  pickupCode: string

  /** 金额块。 */
  showAmount: boolean
  amountLabel: string
  amount: string

  /** 主行动 —— 只有 `active` 变体、且状态有 CTA 时出现。 */
  showAction: boolean
  actionLabel: string
}

interface OrderCardInstance {
  data: OrderCardData & { order?: unknown; variant?: string }
  setData(patch: Partial<OrderCardData>): void
  triggerEvent(name: string, detail?: Record<string, unknown>): void
}

/** 实例 → 当前订单。属性观察者落一次，事件就不依赖 `data.order` 的副本。 */
const currentOrders = new WeakMap<OrderCardInstance, OrderCardOrder>()

/** 运行时守卫：属性来自外部，形状不可信。 */
function isOrderCardOrder(value: unknown): value is OrderCardOrder {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['id'] === 'number' && typeof candidate['status'] === 'number'
}

/** 变体收敛 —— 未知值按 `active` 处理（列表语境下最保守）。 */
function variantOf(value: unknown): OrderCardVariant {
  return value === 'home' ? 'home' : value === 'history' ? 'history' : 'active'
}

/** 第二行 —— 只有时间与格口都确定时才拼接，避免渲染出一个悬空的「·」。 */
function cellLineOf(order: OrderCardOrder, status: OrderStatusBadge): string {
  if (status.key === 'cancelled') return ''

  const cellNo = order.cellNo
  if (status.key === 'waitingDrop' || status.key === 'pendingPayment') return cellNo

  if (status.key === 'stored' || status.key === 'timeout') {
    if (order.startAt === null) return cellNo
    const time = formatOrderTimeInProgress(order.startAt)
    return time === '' ? cellNo : `${cellNo}${CELL_SEPARATOR}${time}`
  }

  if (order.endAt === null) return cellNo
  const time = formatOrderTime(order.endAt)
  return time === '' ? cellNo : `${cellNo}${CELL_SEPARATOR}${time}`
}

/** 取件码块 —— 只出现在「已存入未取件」；首页变体只要响应里有值就画。 */
function showPickupCodeOf(
  order: OrderCardOrder,
  status: OrderStatusBadge,
  variant: OrderCardVariant,
): boolean {
  if (order.pickupCode === null || order.pickupCode === '') return false
  if (variant === 'home') return true
  return status.key === 'stored' || status.key === 'timeout'
}

/** 金额块 —— 逐状态矩阵；`home` 变体永远不画金额。 */
function amountOf(
  order: OrderCardOrder,
  status: OrderStatusBadge,
  variant: OrderCardVariant,
): { showAmount: boolean; amountLabel: string; amount: string } {
  const none = { showAmount: false, amountLabel: '', amount: '' }
  if (variant === 'home') return none

  if (status.key === 'stored') {
    if (order.payAmount !== null) {
      return {
        showAmount: true,
        amountLabel: ORDER_COPY.paidLabel,
        amount: formatMoney(order.payAmount),
      }
    }
    if (order.estimatedAmount !== null) {
      return {
        showAmount: true,
        amountLabel: ORDER_COPY.referenceLabel,
        amount: formatMoney(order.estimatedAmount),
      }
    }
    return none
  }

  if (status.key === 'timeout') {
    if (order.estimatedAmount === null) return none
    return {
      showAmount: true,
      amountLabel: ORDER_COPY.referenceLabel,
      amount: formatMoney(order.estimatedAmount),
    }
  }

  if (order.payAmount === null) return none
  if (status.key === 'timeoutEnd') {
    return {
      showAmount: true,
      amountLabel: ORDER_COPY.timeoutPaidLabel,
      amount: formatMoney(order.payAmount),
    }
  }
  if (status.key === 'completed' || status.key === 'ended') {
    return {
      showAmount: true,
      amountLabel: ORDER_COPY.paidLabel,
      amount: formatMoney(order.payAmount),
    }
  }
  return none
}

/** 主行动 —— 只给 `active` 变体；`status=1` 兜底与历史单都没有 CTA。 */
function actionOf(
  status: OrderStatusBadge,
  variant: OrderCardVariant,
): { showAction: boolean; actionLabel: string } {
  if (variant !== 'active') return { showAction: false, actionLabel: '' }
  if (status.key === 'waitingDrop') {
    return { showAction: true, actionLabel: ORDER_COPY.continueWaiting }
  }
  if (status.key === 'stored' || status.key === 'timeout') {
    return { showAction: true, actionLabel: PICKUP_SHEET_COPY.pickupAction }
  }
  return { showAction: false, actionLabel: '' }
}

/** 把一行 `13.8` 订单落成渲染模型。 */
function viewOf(order: OrderCardOrder, variant: OrderCardVariant): Partial<OrderCardData> {
  const status = resolveOrderStatus(order.status, order.startAt, order.endAt)
  const amount = amountOf(order, status, variant)
  const action = actionOf(status, variant)

  return {
    siteName: order.siteName,
    statusLabel: status.label,
    statusTone: status.tone,
    cellLine: cellLineOf(order, status),
    showPickupCode: showPickupCodeOf(order, status, variant),
    pickupCodeLabel: ORDER_COPY.pickupCodeLabel,
    pickupCode: order.pickupCode ?? '',
    ...amount,
    ...action,
  }
}

/** 观察者共用：`order` / `variant` 任一变化都重画一次。 */
function refresh(
  instance: OrderCardInstance,
  order: unknown,
  variant: unknown,
): void {
  const currentOrder = order === undefined ? instance.data.order : order
  const currentVariant = variant === undefined ? instance.data.variant : variant
  if (!isOrderCardOrder(currentOrder)) {
    currentOrders.delete(instance)
    instance.setData({
      siteName: '',
      statusLabel: '',
      statusTone: '',
      cellLine: '',
      showPickupCode: false,
      pickupCode: '',
      showAmount: false,
      amountLabel: '',
      amount: '',
      showAction: false,
      actionLabel: '',
    })
    return
  }
  currentOrders.set(instance, currentOrder)
  instance.setData(viewOf(currentOrder, variantOf(currentVariant)))
}

/** 两个事件共用：只带订单 id，不带任何业务内容。 */
function emit(instance: OrderCardInstance, name: 'tap' | 'action'): void {
  const order = currentOrders.get(instance) ?? instance.data.order
  if (!isOrderCardOrder(order)) return
  instance.triggerEvent(name, { id: order.id })
}

Component({
  properties: {
    /** `13.8` 的一行（首页卡也用它）—— 唯一的数据来源。 */
    order: {
      type: Object,
      value: {},
    },
    /** 版式：`home` / `active` / `history`。 */
    variant: {
      type: String,
      value: 'active',
    },
  },

  data: {
    siteName: '',
    statusLabel: '',
    statusTone: '',
    cellLine: '',
    showPickupCode: false,
    pickupCodeLabel: ORDER_COPY.pickupCodeLabel,
    pickupCode: '',
    showAmount: false,
    amountLabel: '',
    amount: '',
    showAction: false,
    actionLabel: '',
  } as OrderCardData,

  observers: {
    order(order: unknown): void {
      refresh(this as unknown as OrderCardInstance, order, undefined)
    },
    variant(variant: unknown): void {
      refresh(this as unknown as OrderCardInstance, undefined, variant)
    },
  },

  lifetimes: {
    attached(): void {
      // 属性默认值不触发 observer 的兜底：挂载时把当前 `order` 补落一次。
      const instance = this as unknown as OrderCardInstance
      const current = instance.data.order
      if (!isOrderCardOrder(current)) return
      currentOrders.set(instance, current)
      instance.setData(viewOf(current, variantOf(instance.data.variant)))
    },
  },

  methods: {
    /** 整卡点击 —— 只发事件；宿主决定进详情。 */
    onCardTap(): void {
      emit(this as unknown as OrderCardInstance, 'tap')
    },

    /** 卡内主行动 —— `catchtap` 已挡住冒泡；只发事件，宿主决定去等待页还是开取件层。 */
    onCardAction(): void {
      emit(this as unknown as OrderCardInstance, 'action')
    },
  },
})

// 显式标记为模块：测试用动态 import 读取 `Component()` 定义。
export {}
