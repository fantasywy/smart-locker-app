// **订单详情页** —— 一页看清一笔订单的状态、取件码、费用与每一笔支付（spec §7）。
//
// ## 六块，自上而下
//
//   ① 状态摘要：状态标签（与订单列表同一张表）+ 关键时间；
//   ② 取件码：有值时常驻、不折叠；
//   ③ 柜机信息：站点名 / 柜机码 / 档位 + `cellNo`；
//   ④ 费用：未支付只有参考金额 + 一句说明；已支付才画明细；
//   ⑤ 时间轴：只读 `event` 码，后端 `title` 一律不上屏；
//   ⑥ 支付记录：`payments.length > 0` 才出现，只写「本次支付」+ 时间。
//
// ## 三条不可见的约束（它们决定这一页「能说什么」）
//
// 1. **不展示订单号 / 支付单号 / 渠道 / 手机号**（spec §14.5）。这些字段在 DTO 里
//    如实存在，但本页一个都不搬进 `data` —— 少搬一个字段，就少一条上屏的路。
// 2. **金额四词各归各位**：参考金额永远带「参考」；普通单写「实付」；`TIMEOUT` 单
//    写「已付」；支付记录写「本次支付」。页面**不写 `/100`**，只调 `formatMoney()`。
// 3. **每次 `onShow` 静默刷新**：从等待页 / 支付层回来后必须看到最新状态。
//    首屏用骨架屏，后续刷新**不切回骨架**（否则每次回前台整页闪一下）。
//
// ## 主行动：本票只做「待存入」那一条
//
// 待存入 → `redirectTo` 等待页（`mode=drop`）。已存入 / 已超时确实该有「取件开门」，
// 但那要等 `pickup-sheet`（#65）——**本票不画一个点下去没反应的假按钮**。
// 因此底栏只在「有真实 CTA」时渲染；`canPickup` 作为数据位留在页面上，
// #65 接进来时只补文案与点击去向，不必推翻这里的判断。
//
// ## 取消只在本页出现
//
// 待存入（`status === 2 && startAt === null`）可取消。弹窗文案与等待页**同一套**
// （`ORDER_CANCEL_COPY`）；`3002` 用契约逐字；成功后 toast + 回订单列表。
// ⚠️ 订单列表是 tab 页，它的 `onShow` 自己会刷新 —— 详情页不做跨页缓存 / 事件总线
// （业务数据不落 storage 是全站硬约束）。

import { cancelOrder, getOrderDetail } from '../../api/orders'
import {
  HOME_PAGE_COPY,
  LOCKER_PAGE_COPY,
  ORDER_CANCEL_COPY,
  ORDER_COPY,
  ORDER_LIST_PATH,
  PAGE_TITLES,
} from '../../startup/copy'
import { alert, confirm, showToast } from '../../utils/feedback'
import { formatFullTime } from '../../utils/datetime'
import { resolveLockerCode } from '../../utils/locker-code'
import { formatMoney } from '../../utils/money'
import { resolveOrderStatus } from '../../utils/order-status'
import { LOCKER_PATH, WAITING_PATH } from '../../utils/routes'
import type { OrderDetailOrder, OrderDetailResponse, OrderTimelineEvent } from '../../types/orders'

/** `13.9` 订单不存在（契约 §13.9 :1197）。 */
const ORDER_NOT_FOUND = 3001

/** `13.9` 非本人订单（契约 §13.9 :1197）。 */
const ORDER_FORBIDDEN = 8003

/** `13.10` 取消被拒：订单状态已变化 / 开门指令已回执（契约 §13.10 :1204）。 */
const ORDER_STATE_CHANGED = 3002

/** 页面态 —— 首屏骨架 / 正常 / 不存在 / 页内失败。 */
type DetailPhase = 'loading' | 'ready' | 'missing' | 'loadFailed'

/** 一次读取是首屏、静默刷新，还是失败后的页内重试。 */
type LoadSource = 'initial' | 'refresh' | 'retry'

interface FeeRow {
  label: string
  amount: string
}

interface TimelineRow {
  label: string
  time: string
}

interface PaymentRow {
  label: string
  amount: string
  time: string
}

interface OrderDetailPageData {
  title: string
  phase: DetailPhase

  /** ① 状态摘要。 */
  statusLabel: string
  statusTone: string
  statusTime: string

  /** ② 取件码。 */
  pickupCodeLabel: string
  pickupCode: string
  showPickupCode: boolean

  /** ③ 柜机信息。 */
  siteName: string
  lockerNoLabel: string
  lockerNo: string
  cellLabel: string
  cellText: string
  showCell: boolean

  /** ④ 费用。 */
  showFee: boolean
  showFeeDetail: boolean
  feeRows: FeeRow[]
  referenceLabel: string
  referenceAmount: string
  showReference: boolean
  referenceNote: string
  paidLabel: string
  paidAmount: string
  showPaid: boolean

  /** ⑤ 时间轴。 */
  showTimeline: boolean
  timelineRows: TimelineRow[]

  /** ⑥ 支付记录。 */
  showPayments: boolean
  paymentRows: PaymentRow[]

  /** 主行动 / 取消 / 历史单扫码出口。 */
  showActionBar: boolean
  primaryActionLabel: string
  showCancel: boolean
  cancelActionLabel: string
  cancelDisabled: boolean
  showScanEntry: boolean
  scanEntryLabel: string

  /** 失败出口。 */
  missingTitle: string
  backToOrdersLabel: string
  loadFailedDetail: string
  retryLabel: string

  /** #65 的接线位 —— 本票不渲染取件按钮，但先把「够不够格取件」算出来。 */
  canPickup: boolean
}

interface OrderDetailPageInstance {
  data: OrderDetailPageData
  setData(patch: Partial<OrderDetailPageData>): void
}

/** 一次页面会话的私有运行时 —— 不进 `data`。 */
interface DetailRuntime {
  orderId: number | null
  /** 是否已经收到过第一次 `onShow`（真实运行时 onLoad 后紧跟 onShow）。 */
  started: boolean
  cancelling: boolean
}

/** 页面实例 → 运行时。`WeakMap` 不缓存业务数据，只挂时序状态。 */
const runtimes = new WeakMap<OrderDetailPageInstance, DetailRuntime>()

function runtimeOf(page: OrderDetailPageInstance): DetailRuntime {
  let runtime = runtimes.get(page)
  if (runtime === undefined) {
    runtime = { orderId: null, started: false, cancelling: false }
    runtimes.set(page, runtime)
  }
  return runtime
}

/**
 * 关键时间 —— 状态摘要里唯一的时间。
 *
 *   • 待存入 / 待支付：没有可展示的时刻（还没有发生任何事）；
 *   • 已存入 / 已超时未取件：存入时刻；
 *   • 历史单：取件时刻。
 *
 * ⚠️ 只用服务端回显的时刻，不读客户端时钟（`utils/datetime.ts` 的纪律）。
 */
function keyTimeOf(order: OrderDetailOrder): string {
  if (order.status === 1) return ''
  if (order.status === 2) {
    return order.startAt === null ? '' : formatFullTime(order.startAt)
  }
  if (order.status === 4 && order.endAt === null) {
    return order.startAt === null ? '' : formatFullTime(order.startAt)
  }
  return order.endAt === null ? '' : formatFullTime(order.endAt)
}

/** ③ 柜机信息 —— 已取消订单不显示格口（格口已释放，spec §14.6）。 */
function lockerViewOf(detail: OrderDetailResponse): Partial<OrderDetailPageData> {
  const locker = detail.locker
  const cellTypeLabel = LOCKER_PAGE_COPY.cellTypeLabels[locker.cellType]
  // 已取消：格口已释放，连数据位都不留 —— 「不显示」比「渲染了但藏起来」更难被绕过。
  const showCell = detail.order.status !== 7
  return {
    siteName: locker.siteName,
    lockerNoLabel: ORDER_COPY.lockerNoLabel,
    lockerNo: locker.lockerNo,
    cellLabel: ORDER_COPY.cellLabel,
    cellText: showCell ? `${cellTypeLabel} · ${locker.cellNo}` : '',
    showCell,
  }
}

/**
 * ④ 费用 —— spec §7 的费用矩阵，五个分支一个不少。
 *
 * ⚠️ `payAmount` 是「有没有支付」的唯一事实：未支付时三个明细字段都是 `null`，
 * 此时画明细行等于凭空造账。`TIMEOUT` 单已支付时金额词是「已付」，普通单是「实付」。
 *
 * ⚠️ **不显示「还需支付」**：补缴差额客户端不自算、也不上屏（spec §14.2）。
 *
 * ⚠️ 已取消整块不渲染 —— 取消不产生费用，留一块空表只会让人以为有账没结。
 */
function feeViewOf(order: OrderDetailOrder): Partial<OrderDetailPageData> {
  if (order.status === 7) {
    return {
      showFee: false,
      showFeeDetail: false,
      feeRows: [],
      showReference: false,
      referenceAmount: '',
      referenceNote: '',
      showPaid: false,
      paidLabel: '',
      paidAmount: '',
    }
  }

  if (order.payAmount !== null) {
    const feeRows: FeeRow[] = []
    if (order.baseFee !== null) {
      feeRows.push({ label: ORDER_COPY.baseFeeLabel, amount: formatMoney(order.baseFee) })
    }
    if (order.overtimeFee !== null) {
      feeRows.push({ label: ORDER_COPY.overtimeFeeLabel, amount: formatMoney(order.overtimeFee) })
    }
    // 优惠为 0 不渲染 —— 没有减免时多一行「优惠 ¥0.00」是在暗示用户本该有优惠。
    if (order.discount !== null && order.discount > 0) {
      feeRows.push({ label: ORDER_COPY.discountLabel, amount: formatMoney(order.discount) })
    }
    return {
      showFee: true,
      showFeeDetail: true,
      feeRows,
      showReference: false,
      referenceAmount: '',
      referenceNote: '',
      showPaid: true,
      paidLabel: order.status === 4 ? ORDER_COPY.timeoutPaidLabel : ORDER_COPY.paidLabel,
      paidAmount: formatMoney(order.payAmount),
    }
  }

  // 未支付：只有参考金额与说明。`estimatedAmount` 缺失时整行不渲染，
  // 但说明句仍然成立（取件时由服务端算）。
  return {
    showFee: true,
    showFeeDetail: false,
    feeRows: [],
    showReference: order.estimatedAmount !== null,
    referenceAmount:
      order.estimatedAmount === null ? '' : formatMoney(order.estimatedAmount),
    referenceNote: ORDER_COPY.referenceNote,
    showPaid: false,
    paidLabel: '',
    paidAmount: '',
  }
}

/** ⑤ 时间轴 —— 只认事件码；认不出的码整行丢弃，不回落成后端 `title`。 */
function timelineOf(events: OrderTimelineEvent[]): TimelineRow[] {
  const labels = ORDER_COPY.timeline as Record<string, string>
  const rows: TimelineRow[] = []
  for (const event of events) {
    const label = labels[event.event]
    if (label === undefined) continue
    rows.push({ label, time: formatFullTime(event.at) })
  }
  return rows
}

/** ⑥ 支付记录 —— 只有「本次支付」与时间；单号 / 渠道 / 状态一个都不上屏。 */
function paymentsOf(detail: OrderDetailResponse): PaymentRow[] {
  return detail.payments.map((payment) => ({
    label: ORDER_COPY.paymentLabel,
    amount: formatMoney(payment.amount),
    time: formatFullTime(payment.paidAt),
  }))
}

/** 主行动 / 取消 / 历史单出口 —— 三个布尔各自只由一个判定决定。 */
function actionsOf(order: OrderDetailOrder): Partial<OrderDetailPageData> {
  const canPickup =
    (order.status === 2 || order.status === 4) &&
    order.startAt !== null &&
    order.endAt === null
  const canCancel = order.status === 2 && order.startAt === null
  const isHistory =
    order.status === 3 ||
    order.status === 5 ||
    order.status === 6 ||
    order.status === 7 ||
    (order.status === 4 && order.endAt !== null)

  return {
    canPickup,
    // ⚠️ 本票只有待存入有真实 CTA；取件按钮等 #65（见文件头）。
    showActionBar: canCancel,
    primaryActionLabel: canCancel ? ORDER_COPY.continueWaiting : '',
    showCancel: canCancel,
    cancelActionLabel: ORDER_CANCEL_COPY.action,
    showScanEntry: isHistory,
    scanEntryLabel: ORDER_COPY.scanEntry,
  }
}

/** 把 `13.9` 的回显落成页面态。 */
function renderDetail(page: OrderDetailPageInstance, detail: OrderDetailResponse): void {
  const order = detail.order
  const status = resolveOrderStatus(order.status, order.startAt, order.endAt)
  const timelineRows = timelineOf(detail.timeline)
  const paymentRows = paymentsOf(detail)

  page.setData({
    phase: 'ready',
    statusLabel: status.label,
    statusTone: status.tone,
    statusTime: keyTimeOf(order),
    pickupCodeLabel: ORDER_COPY.pickupCodeLabel,
    pickupCode: order.pickupCode ?? '',
    showPickupCode: order.pickupCode !== null,
    ...lockerViewOf(detail),
    ...feeViewOf(order),
    showTimeline: timelineRows.length > 0,
    timelineRows,
    showPayments: paymentRows.length > 0,
    paymentRows,
    ...actionsOf(order),
  })
}

/** 订单不存在 / 非本人 / 已删除 —— 统一一句话，没有第二种说法。 */
function enterMissing(page: OrderDetailPageInstance): void {
  page.setData({
    phase: 'missing',
    missingTitle: ORDER_COPY.missingTitle,
    backToOrdersLabel: ORDER_COPY.backToOrders,
  })
}

/** 其他失败 —— 页内重试块，不甩成全局失败出口。 */
function enterLoadFailed(page: OrderDetailPageInstance): void {
  page.setData({
    phase: 'loadFailed',
    loadFailedDetail: ORDER_COPY.loadFailed,
    retryLabel: ORDER_COPY.retry,
  })
}

/**
 * 读一次 `13.9`。
 *
 * ⚠️ 静默刷新失败**不改变已有内容**：用户从等待页回来时看到旧数据，
 * 比看到一整块「加载失败」要好；下一次 `onShow` / 重试会再取。
 */
async function load(page: OrderDetailPageInstance, source: LoadSource): Promise<void> {
  const runtime = runtimeOf(page)
  if (runtime.orderId === null) {
    enterMissing(page)
    return
  }

  const result = await getOrderDetail(runtime.orderId)
  if (!result.ok) {
    if (result.error.code === ORDER_NOT_FOUND || result.error.code === ORDER_FORBIDDEN) {
      enterMissing(page)
      return
    }
    if (source === 'refresh') return
    enterLoadFailed(page)
    return
  }

  renderDetail(page, result.data)
}

/** 待存入的主行动 —— `redirectTo` 等待页（详情页拿不到 `openTimeoutMinutes`，不传）。 */
function continueWaiting(page: OrderDetailPageInstance): void {
  const runtime = runtimeOf(page)
  if (runtime.orderId === null || page.data.primaryActionLabel === '') return
  wx.redirectTo({ url: `/${WAITING_PATH}?orderId=${runtime.orderId}&mode=drop` })
}

/** 取消 —— 只对待存入开放；成功后回订单列表（列表在 `onShow` 自己刷新）。 */
async function cancel(page: OrderDetailPageInstance): Promise<void> {
  const runtime = runtimeOf(page)
  if (runtime.orderId === null || !page.data.showCancel || runtime.cancelling) return

  const confirmed = await confirm({
    title: ORDER_CANCEL_COPY.title,
    message: ORDER_CANCEL_COPY.message,
    cancelText: ORDER_CANCEL_COPY.dismiss,
    confirmText: ORDER_CANCEL_COPY.action,
  })
  if (!confirmed) return

  const orderId = runtime.orderId
  runtime.cancelling = true
  page.setData({ cancelDisabled: true })

  const result = await cancelOrder(orderId)
  runtime.cancelling = false
  page.setData({ cancelDisabled: false })

  if (!result.ok) {
    if (result.error.code === ORDER_STATE_CHANGED) {
      // 服务端状态已变：契约逐字告知，再静默刷新一次把最新状态画回来。
      await alert({ title: ORDER_CANCEL_COPY.title, message: ORDER_CANCEL_COPY.rejected })
      await load(page, 'refresh')
      return
    }
    if (result.error.code === ORDER_NOT_FOUND || result.error.code === ORDER_FORBIDDEN) {
      enterMissing(page)
      return
    }
    showToast(ORDER_COPY.cancelFailed)
    return
  }

  showToast(ORDER_CANCEL_COPY.success)
  wx.switchTab({ url: `/${ORDER_LIST_PATH}` })
}

/** 历史单的次级出口 —— 与首页完全相同的扫码链路。 */
function scanEntry(): void {
  wx.scanCode({
    success: (result) => {
      const code = resolveLockerCode({ scanResult: result.result })
      if (code === null) {
        showToast(HOME_PAGE_COPY.notLockerCode)
        return
      }
      wx.navigateTo({ url: `/${LOCKER_PATH}?code=${encodeURIComponent(code)}` })
    },
    fail: (error) => {
      // 用户主动取消不是失败；其余成因不按成因分叉。
      if (error.errMsg.includes('cancel')) return
      showToast(HOME_PAGE_COPY.scanFailed)
    },
  })
}

/** 固定的「返回订单列表」出口 —— 订单列表是 tab 页，只能 `switchTab`。 */
function backToOrders(): void {
  wx.switchTab({ url: `/${ORDER_LIST_PATH}` })
}

/** 进页 —— 参数只在 `onLoad` 里拿得到；首查由 `onShow` 驱动。 */
function enterPage(
  page: OrderDetailPageInstance,
  options: Record<string, string | undefined>,
): void {
  const runtime = runtimeOf(page)
  const rawId = options['id']
  const orderId = rawId === undefined ? Number.NaN : Number(rawId)
  if (!Number.isInteger(orderId) || orderId <= 0) {
    runtime.orderId = null
    enterMissing(page)
    return
  }
  runtime.orderId = orderId
}

/**
 * `onShow` —— 首屏首查，之后每次回前台静默刷新。
 *
 * ⚠️ 真实运行时 `onLoad` 后紧跟 `onShow`，所以把首查放在这里不会多打一次；
 * 而从等待页 / 支付层返回时，`onShow` 是唯一能保证「看到最新状态」的时机。
 */
function showPage(page: OrderDetailPageInstance): void {
  const runtime = runtimeOf(page)
  if (runtime.orderId === null) {
    enterMissing(page)
    return
  }
  const source: LoadSource = runtime.started ? 'refresh' : 'initial'
  runtime.started = true
  void load(page, source)
}

/** 页内重试 —— 重新发一次 `13.9`，成功后整页恢复。 */
function retry(page: OrderDetailPageInstance): void {
  if (page.data.phase !== 'loadFailed') return
  void load(page, 'retry')
}

interface OrderDetailPageMethods {
  [name: string]: (...args: never[]) => unknown
  onLoad(options: Record<string, string | undefined>): void
  onShow(): void
  onPrimaryAction(): void
  onCancel(): void
  onScanEntry(): void
  onBackToOrders(): void
  onRetry(): void
}

Component<OrderDetailPageData, Record<string, never>, OrderDetailPageMethods, Record<string, never>, true>({
  data: {
    title: PAGE_TITLES['pages/order-detail/order-detail'],
    phase: 'loading',

    statusLabel: '',
    statusTone: '',
    statusTime: '',

    pickupCodeLabel: ORDER_COPY.pickupCodeLabel,
    pickupCode: '',
    showPickupCode: false,

    siteName: '',
    lockerNoLabel: ORDER_COPY.lockerNoLabel,
    lockerNo: '',
    cellLabel: ORDER_COPY.cellLabel,
    cellText: '',
    showCell: true,

    showFee: false,
    showFeeDetail: false,
    feeRows: [],
    referenceLabel: ORDER_COPY.referenceLabel,
    referenceAmount: '',
    showReference: false,
    referenceNote: '',
    paidLabel: '',
    paidAmount: '',
    showPaid: false,

    showTimeline: false,
    timelineRows: [],

    showPayments: false,
    paymentRows: [],

    showActionBar: false,
    primaryActionLabel: '',
    showCancel: false,
    cancelActionLabel: ORDER_CANCEL_COPY.action,
    cancelDisabled: false,
    showScanEntry: false,
    scanEntryLabel: ORDER_COPY.scanEntry,

    missingTitle: ORDER_COPY.missingTitle,
    backToOrdersLabel: ORDER_COPY.backToOrders,
    loadFailedDetail: ORDER_COPY.loadFailed,
    retryLabel: ORDER_COPY.retry,

    canPickup: false,
  } as OrderDetailPageData,

  methods: {
    onLoad(options: Record<string, string | undefined>): void {
      enterPage(this as unknown as OrderDetailPageInstance, options)
    },

    onShow(): void {
      showPage(this as unknown as OrderDetailPageInstance)
    },

    onPrimaryAction(): void {
      continueWaiting(this as unknown as OrderDetailPageInstance)
    },

    onCancel(): void {
      void cancel(this as unknown as OrderDetailPageInstance)
    },

    onScanEntry(): void {
      scanEntry()
    },

    onBackToOrders(): void {
      backToOrders()
    },

    onRetry(): void {
      retry(this as unknown as OrderDetailPageInstance)
    },
  },
})
