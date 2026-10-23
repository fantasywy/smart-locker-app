// **支付取件确认层** —— 详情底栏与订单列表卡共享的底部弹层（#65 / spec #57 §5）。
//
// ## 它是什么，不是什么
//
// 它只做「确认取件」，**不是支付页**：金额的最终确认在服务端，弹层里没有充值、
// 没有支付方式、没有订单号。宿主只负责打开它、以及成功后的去向；`13.11` 的调用
// 与它内部的状态机都归本组件 —— 这样详情页（`redirectTo`）与列表页（`navigateTo`）
// 用的是同一套支付取件逻辑，而不是各画一份。
//
// ## 三种金额分支（spec §5 表，逐字）
//
//   • `status=2` 且 `payAmount=null`：参考金额 + 首次支付说明 + 取件开门；
//   • `status=2` 且 `payAmount!=null`：实付 + 无需再次支付说明 + 取件开门（幂等重开）；
//   • `status=4` 且 `endAt=null`：参考金额 + 已付（有值时）+ 超时补缴说明 + 补缴并开门。
//
// `estimatedAmount=null` 时参考金额整行不渲染 —— **不写「暂不可用」**，点下去由
// `6001` 兜底。顶行固定是 `站点名 · 柜机码 · 格口`，永远不是订单号。
//
// ## 状态机（spec §5）
//
//     idle → paying → success / failed / reconciling
//     reconciling → success / failed
//
// 支付中：按钮「支付中…」、遮罩不可点、防连点只挡同一次请求在飞（不对「已付过」
// 做任何本地判断，服务端幂等）。成功：必须由用户点「知道了」离开，**不自动跳转**。
//
// ## 网络超时：先核对一次 `13.9`，不让用户重复付
//
// `13.11` 网络失败时没有支付回执，直接让用户再点一次可能导致「付了两次」的错觉
// （服务端幂等，但用户不知道）。⇒ 进 `reconciling`，只查一次 `13.9`：
//   • 已支付且未取件 → 成功态，但**没有 `13.11` 响应，不得把 `13.9` 的 `payAmount`
//     说成「本次支付」**，成功副行省略金额；
//   • 已终局 → 关闭并刷新来源页；
//   • 没有支付 → 「没有查询到支付结果，请重试」，停留，可重试。
//
// ## 宿主边界
//
// 组件**不导航**：成功后只 `triggerEvent('success')`，由宿主决定 `redirectTo` /
// `navigateTo`。`dismiss` 只表示用户用遮罩关掉了空闲态；`refresh` 表示来源页应刷新
// （`detail.missing=true` 时来源页应回列表，例如 `3001` / `8003`）。
//
// `paid` / `openCommandIssued` 在本文件零引用 —— 支付成功 ≠ 订单完成，判态只用
// `status` / `startAt` / `endAt` / `payAmount` / `estimatedAmount`。

import { getOrderDetail, payOrder } from '../../api/orders'
import { PICKUP_SHEET_COPY } from '../../startup/copy'
import { showToast } from '../../utils/feedback'
import { formatMoney } from '../../utils/money'
import type { OrderDetailOrder, PickupOrder } from '../../types/orders'

/** `13.11` 失败：订单状态已变化 / 开门指令已回执（契约 §13.11）。 */
const ORDER_STATE_CHANGED = 3002

/** `13.11` 失败：暂时无法计算费用（契约 §13.11）。 */
const FEES_UNAVAILABLE = 6001

/** `13.11` 失败：订单不存在（契约 §13.9 / §13.11）。 */
const ORDER_NOT_FOUND = 3001

/** `13.11` 失败：非本人订单（契约 §13.9 / §13.11）。 */
const ORDER_FORBIDDEN = 8003

/** 取件层状态机 —— 与 spec §5 的五个节点一一对应。 */
type PickupPhase = 'idle' | 'paying' | 'success' | 'failed' | 'reconciling'

/** 支付前的三种金额分支 —— 成功文案与金额展示都由它决定。 */
type PickupBranch = 'first' | 'reopen' | 'topup'

interface PickupSheetData {
  /** `order` 有值即打开；宿主清空 `order` 即关闭。 */
  visible: boolean
  phase: PickupPhase

  /** 顶行：站点名 · 柜机码 · 格口（无订单号）。 */
  locationLine: string

  /** 金额块。 */
  showEstimated: boolean
  estimatedLabel: string
  estimatedAmount: string
  showPaid: boolean
  paidLabel: string
  paidAmount: string
  note: string

  /** 主按钮。 */
  actionLabel: string
  actionDisabled: boolean

  /** 失败态：停留并允许重试。 */
  showFailure: boolean
  failureMessage: string

  /** 成功态：必须由用户点「知道了」离开。 */
  showSuccess: boolean
  successTitle: string
  showSuccessAmount: boolean
  successAmountLabel: string
  successAmount: string
  successHint: string
  knowLabel: string

  /** 核对中：只展示「正在核对支付结果…」，不提供按钮。 */
  showReconciling: boolean
  reconcilingLabel: string

  /** Vant popup 的 `close-on-click-overlay` —— 支付中 / 成功 / 核对中不可关。 */
  overlayClosable: boolean
}

interface PickupSheetInstance {
  data: PickupSheetData & { order?: unknown }
  setData(patch: Partial<PickupSheetData>): void
  triggerEvent(name: string, detail?: Record<string, unknown>): void
}

/** 一次弹层的私有运行时 —— 不进 `data`。 */
interface PickupRuntime {
  order: PickupOrder | null
}

/** 实例 → 运行时。WeakMap 不缓存业务数据，只挂当前这一单的引用。 */
const runtimes = new WeakMap<PickupSheetInstance, PickupRuntime>()

function runtimeOf(instance: PickupSheetInstance): PickupRuntime {
  let runtime = runtimes.get(instance)
  if (runtime === undefined) {
    runtime = { order: null }
    runtimes.set(instance, runtime)
  }
  return runtime
}

/** 入口谓词 —— 与详情页 / 列表卡的 `canPickup` 同一口径（spec §5 / §6）。 */
function isPickupEligible(order: PickupOrder): boolean {
  return (
    (order.status === 2 || order.status === 4) &&
    order.startAt !== null &&
    order.endAt === null
  )
}

/** 支付前的金额分支 —— 只看 `status` / `endAt` / `payAmount`，不猜服务端金额。 */
function branchOf(order: PickupOrder): PickupBranch {
  if (order.status === 4 && order.endAt === null) return 'topup'
  if (order.status === 2 && order.payAmount === null) return 'first'
  return 'reopen'
}

/** 顶行三段之间的分隔符 —— 标点不是文案，且详情页的格口行已使用同一形态。 */
const LOCATION_SEPARATOR = ' · '

/** 顶行三段 —— 站点名 · 柜机码 · 格口；不拼订单号。 */
function locationLineOf(order: PickupOrder): string {
  return `${order.siteName}${LOCATION_SEPARATOR}${order.lockerNo}${LOCATION_SEPARATOR}${order.cellNo}`
}

/** `order` 属性是不是一份可用的取件订单视图（运行时防御，不信任外部形状）。 */
function isPickupOrder(value: unknown): value is PickupOrder {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['id'] === 'number' && typeof candidate['status'] === 'number'
}

/** 把 `order` 属性落成空闲态渲染模型；同时清掉上一次弹层的成功 / 失败残留。 */
function idleViewOf(order: PickupOrder): Partial<PickupSheetData> {
  const branch = branchOf(order)
  const showEstimated = branch !== 'reopen' && order.estimatedAmount !== null
  const showPaid = order.payAmount !== null
  const note =
    branch === 'first'
      ? PICKUP_SHEET_COPY.firstNote
      : branch === 'reopen'
        ? PICKUP_SHEET_COPY.reopenNote
        : PICKUP_SHEET_COPY.topUpNote

  return {
    visible: true,
    phase: 'idle',
    locationLine: locationLineOf(order),
    showEstimated,
    estimatedLabel: PICKUP_SHEET_COPY.referenceLabel,
    estimatedAmount:
      order.estimatedAmount === null ? '' : formatMoney(order.estimatedAmount),
    showPaid,
    paidLabel: branch === 'reopen' ? PICKUP_SHEET_COPY.actualPaidLabel : PICKUP_SHEET_COPY.paidLabel,
    paidAmount: order.payAmount === null ? '' : formatMoney(order.payAmount),
    note,
    actionLabel:
      branch === 'topup' ? PICKUP_SHEET_COPY.topUpAction : PICKUP_SHEET_COPY.pickupAction,
    actionDisabled: false,
    showFailure: false,
    failureMessage: '',
    showSuccess: false,
    successTitle: '',
    showSuccessAmount: false,
    successAmountLabel: '',
    successAmount: '',
    successHint: '',
    knowLabel: PICKUP_SHEET_COPY.know,
    showReconciling: false,
    reconcilingLabel: PICKUP_SHEET_COPY.reconciling,
    overlayClosable: true,
  }
}

/**
 * 成功态渲染模型。
 *
 * @param amount `13.11` 响应的 `payAmount`；只在**支付前 `payAmount == null`** 时
 *               才允许显示为「本次支付」。网络核对路径传 `null` —— 没有回执，
 *               就不能把 `13.9` 的累计实收说成本次支付。
 */
function successViewOf(
  order: PickupOrder,
  branch: PickupBranch,
  amount: number | null,
): Partial<PickupSheetData> {
  const showAmount = branch === 'first' && amount !== null
  return {
    visible: true,
    phase: 'success',
    locationLine: locationLineOf(order),
    showSuccess: true,
    successTitle:
      branch === 'reopen'
        ? PICKUP_SHEET_COPY.reopenSuccessTitle
        : PICKUP_SHEET_COPY.successTitle,
    showSuccessAmount: showAmount,
    successAmountLabel: showAmount ? PICKUP_SHEET_COPY.successAmountLabel : '',
    successAmount: showAmount ? formatMoney(amount) : '',
    successHint: PICKUP_SHEET_COPY.successHint,
    knowLabel: PICKUP_SHEET_COPY.know,
    showReconciling: false,
    showFailure: false,
    failureMessage: '',
    overlayClosable: false,
    actionDisabled: true,
  }
}

/** 失败态渲染模型 —— 停留、保留金额块、允许用原主按钮重试。 */
function failedViewOf(order: PickupOrder, message: string): Partial<PickupSheetData> {
  const idle = idleViewOf(order)
  return {
    ...idle,
    phase: 'failed',
    showFailure: true,
    failureMessage: message,
    actionDisabled: false,
    overlayClosable: true,
  }
}

/** 核对中渲染模型 —— 支付回执缺席时唯一能说的一句话。 */
function reconcilingViewOf(order: PickupOrder): Partial<PickupSheetData> {
  const idle = idleViewOf(order)
  return {
    ...idle,
    phase: 'reconciling',
    showReconciling: true,
    actionDisabled: true,
    overlayClosable: false,
  }
}

/** 来源页需要刷新；`missing=true` 时宿主应回列表（`3001` / `8003`）。 */
function closeAndRefresh(instance: PickupSheetInstance, missing: boolean): void {
  instance.setData({ visible: false, phase: 'idle' })
  instance.triggerEvent('refresh', { missing })
}

/** `13.9` 显示订单已终局 —— 支付结果已无关紧要，关掉弹层让来源页刷新。 */
function isTerminal(order: OrderDetailOrder): boolean {
  return (
    order.endAt !== null ||
    order.status === 3 ||
    order.status === 5 ||
    order.status === 6 ||
    order.status === 7
  )
}

/** `13.9` 显示「已支付且未取件」—— 网络核对成功态的唯一判据。 */
function isPaidNotPicked(order: OrderDetailOrder): boolean {
  return (
    order.payAmount !== null &&
    order.endAt === null &&
    order.startAt !== null &&
    (order.status === 2 || order.status === 4)
  )
}

/**
 * 网络不确定时的核对 —— `13.11` 的回执没拿到，先查一次 `13.9`。
 *
 * ⚠️ 只查一次，不自动重发支付：重发由用户在失败态点主按钮触发。
 */
async function reconcile(
  instance: PickupSheetInstance,
  order: PickupOrder,
  branch: PickupBranch,
): Promise<void> {
  instance.setData(reconcilingViewOf(order))

  const result = await getOrderDetail(order.id)
  if (!result.ok) {
    instance.setData(failedViewOf(order, PICKUP_SHEET_COPY.noPayment))
    return
  }

  const current = result.data.order
  if (isTerminal(current)) {
    closeAndRefresh(instance, false)
    return
  }
  if (isPaidNotPicked(current)) {
    // ⚠️ 这里**没有** `13.11` 响应 → 传 `null`，成功副行省略金额。
    instance.setData(successViewOf(order, branch, null))
    return
  }
  instance.setData(failedViewOf(order, PICKUP_SHEET_COPY.noPayment))
}

/** 支付失败归因 —— 五类分支各自决定「关不关、刷新不刷新」。 */
function applyFailure(
  instance: PickupSheetInstance,
  order: PickupOrder,
  branch: PickupBranch,
  error: { kind: string; code: number | null; message: string | null },
): Promise<void> | void {
  // 网络超时 / 无 code（请求层统一归 `network`）：先核对，不直接让用户再付。
  if (error.kind === 'network') {
    return reconcile(instance, order, branch)
  }

  if (error.code === ORDER_STATE_CHANGED) {
    showToast(PICKUP_SHEET_COPY.stateChanged)
    closeAndRefresh(instance, false)
    return
  }

  if (error.code === FEES_UNAVAILABLE) {
    instance.setData(failedViewOf(order, PICKUP_SHEET_COPY.feeUnavailable))
    return
  }

  if (error.code === ORDER_NOT_FOUND || error.code === ORDER_FORBIDDEN) {
    showToast(PICKUP_SHEET_COPY.missing)
    closeAndRefresh(instance, true)
    return
  }

  // 其他业务码：服务端 message 直出；没有 message 才用兜底句。
  const message =
    error.message !== null && error.message !== '' ? error.message : PICKUP_SHEET_COPY.fallback
  instance.setData(failedViewOf(order, message))
}

/**
 * 提交支付取件。
 *
 * ⚠️ 防连点只保护**同一次请求在飞**：`paying` / `reconciling` / `success` 三个态
 * 一律拒绝再次进入。失败态允许重试（`failed → paying`）。
 */
async function submit(instance: PickupSheetInstance): Promise<void> {
  const runtime = runtimeOf(instance)
  const order = runtime.order
  if (order === null) return
  if (
    instance.data.phase === 'paying' ||
    instance.data.phase === 'reconciling' ||
    instance.data.phase === 'success'
  ) {
    return
  }

  const branch = branchOf(order)
  instance.setData({
    phase: 'paying',
    actionLabel: PICKUP_SHEET_COPY.paying,
    actionDisabled: true,
    showFailure: false,
    failureMessage: '',
    overlayClosable: false,
  })

  const result = await payOrder(order.id)
  if (!result.ok) {
    await applyFailure(instance, order, branch, result.error)
    return
  }

  // ⚠️ `13.11` 的 `payAmount` 只在支付前 `payAmount == null` 时才能叫「本次支付」；
  // 幂等重试返回首笔金额、补缴返回差额，都不能冒充本次。
  instance.setData(successViewOf(order, branch, result.data.payAmount))
}

Component({
  properties: {
    /**
     * 取件订单视图 —— **有值即打开弹层**，宿主清空即关闭。
     *
     * 详情页由 `13.9` 的 `order` + `locker` 拼成，列表页直接用 `13.8` 的行。
     */
    order: {
      type: Object,
      value: {},
    },
  },

  data: {
    visible: false,
    phase: 'idle',
    locationLine: '',
    showEstimated: false,
    estimatedLabel: '',
    estimatedAmount: '',
    showPaid: false,
    paidLabel: '',
    paidAmount: '',
    note: '',
    actionLabel: '',
    actionDisabled: false,
    showFailure: false,
    failureMessage: '',
    showSuccess: false,
    successTitle: '',
    showSuccessAmount: false,
    successAmountLabel: '',
    successAmount: '',
    successHint: '',
    knowLabel: '',
    showReconciling: false,
    reconcilingLabel: '',
    overlayClosable: false,
  } as PickupSheetData,

  observers: {
    order(value: unknown) {
      const instance = this as unknown as PickupSheetInstance
      const runtime = runtimeOf(instance)

      if (!isPickupOrder(value) || !isPickupEligible(value)) {
        runtime.order = null
        instance.setData({ visible: false, phase: 'idle' })
        return
      }

      runtime.order = value
      instance.setData(idleViewOf(value))
    },
  },

  lifetimes: {
    attached() {
      // 属性默认值不触发 observer 的兜底：挂载时把当前 `order` 补落一次。
      const instance = this as unknown as PickupSheetInstance
      const current = instance.data.order
      const runtime = runtimeOf(instance)
      if (!isPickupOrder(current) || !isPickupEligible(current)) return
      runtime.order = current
      instance.setData(idleViewOf(current))
    },
  },

  methods: {
    /** 主按钮 —— 空闲 / 失败态都从这里进支付（失败态即「重试」）。 */
    onSubmit(): void {
      void submit(this as unknown as PickupSheetInstance)
    },

    /** 成功态的唯一出口 —— 只发事件，跳转归宿主。 */
    onKnow(): void {
      const instance = this as unknown as PickupSheetInstance
      if (instance.data.phase !== 'success') return
      const order = runtimeOf(instance).order
      instance.setData({ visible: false, phase: 'idle' })
      instance.triggerEvent('success', { orderId: order?.id ?? null })
    },

    /** 遮罩点击 —— 只允许空闲 / 失败态关闭；支付中 / 成功 / 核对中不可关。 */
    onDismiss(): void {
      const instance = this as unknown as PickupSheetInstance
      if (!instance.data.overlayClosable) return
      instance.setData({ visible: false, phase: 'idle' })
      instance.triggerEvent('dismiss')
    },
  },
})

// 显式标记为模块：本文件没有 export，但测试用动态 import 读取 Component() 定义。
export {}
