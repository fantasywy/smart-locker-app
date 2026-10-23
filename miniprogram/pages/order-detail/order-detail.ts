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
// ## 主行动：待存入 → 等待页；已存入 / 已超时 → 共享取件层
//
// 待存入 → `redirectTo` 等待页（`mode=drop`）。
// 已存入 / 已超时（`canPickup`）→ 打开共享的 `pickup-sheet`（#65）：
//   • 本页**不画支付界面**，也不自己调 `13.11`；支付取件请求与状态机都在组件里；
//   • 组件成功后发 `success`，本页才 `redirectTo` 等待页（`mode=pickup`）——
//     成功后的去向由宿主决定（列表入口将来用 `navigateTo`，组件不知道这件事）。
//
// ## 取消只在本页出现
//
// 待存入（`status === 2 && startAt === null`）可取消。弹窗文案与等待页**同一套**
// （`ORDER_CANCEL_COPY`）；`3002` 用契约逐字；成功后 toast + 回订单列表。
// ⚠️ 订单列表是 tab 页，它的 `onShow` 自己会刷新 —— 详情页不做跨页缓存 / 事件总线
// （业务数据不落 storage 是全站硬约束）。

import { cancelOrder, getOrderDetail } from '../../api/orders'
import {
  LOCKER_PAGE_COPY,
  ORDER_CANCEL_COPY,
  ORDER_COPY,
  ORDER_LIST_PATH,
  PAGE_TITLES,
  PICKUP_SHEET_COPY,
} from '../../startup/copy'
import { alert, confirm, showToast } from '../../utils/feedback'
import { formatFullTime, formatOrderTime } from '../../utils/datetime'
import { formatMoney } from '../../utils/money'
import { canPickupOrder, isEndedOrder, resolveOrderStatus } from '../../utils/order-status'
import { WAITING_PATH } from '../../utils/routes'
import { scanToLocker } from '../../utils/scan-locker'
import type {
  OrderDetailOrder,
  OrderDetailResponse,
  OrderTimelineEvent,
  PickupOrder,
} from '../../types/orders'

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
  /** 主行动的种类 —— 决定点击后是去等待页还是打开取件层（不靠按钮文案判分支）。 */
  primaryAction: 'waiting' | 'pickup' | ''
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

  /** #65 取件层 —— `canPickup` 是入口谓词；`pickupOrder` 有值即打开弹层。 */
  canPickup: boolean
  pickupOrder: PickupOrder | null
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
  /** 最近一次 `13.9` 的回显 —— 打开取件层时用它拼 `PickupOrder`（不落 storage）。 */
  detail: OrderDetailResponse | null
}

/** 页面实例 → 运行时。`WeakMap` 不缓存业务数据，只挂时序状态。 */
const runtimes = new WeakMap<OrderDetailPageInstance, DetailRuntime>()

function runtimeOf(page: OrderDetailPageInstance): DetailRuntime {
  let runtime = runtimes.get(page)
  if (runtime === undefined) {
    runtime = { orderId: null, started: false, cancelling: false, detail: null }
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
 * ⚠️ 写法用**全站三档选择器**（spec §14.3：今天 / 当年 / 跨年），不是无条件的
 * `YYYY-MM-DD HH:mm` —— 后者会在「今天刚存的单」上凭空多出一个年份。
 * `now` 由调用方在渲染时传入，本页与格式化层都不读时钟（`utils/datetime.ts` 的纪律）。
 */
function keyTimeOf(order: OrderDetailOrder, now: Date): string {
  if (order.status === 1) return ''
  if (order.status === 2) {
    return order.startAt === null ? '' : formatOrderTime(order.startAt, now)
  }
  if (order.status === 4 && order.endAt === null) {
    return order.startAt === null ? '' : formatOrderTime(order.startAt, now)
  }
  return order.endAt === null ? '' : formatOrderTime(order.endAt, now)
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

/** 主行动 / 取消 / 历史单出口 —— 每个判定只算一次，避免「按钮文案」与「点击去向」分叉。 */
function actionsOf(order: OrderDetailOrder): Partial<OrderDetailPageData> {
  // ⚠️ 三个判定都来自 `utils/order-status.ts` 的唯一实现：取件入口与共享取件层同一条，
  // 「历史单」就是「不在进行中」（`isActiveOrder` 的补集），本页不再抄状态码。
  const canPickup = canPickupOrder(order)
  const canCancel = order.status === 2 && order.startAt === null
  const isHistory = isEndedOrder(order)

  // 取件入口只按「超时单 → 补缴 / 普通单 → 取件」分两档；两者打开同一个弹层。
  const primaryAction: OrderDetailPageData['primaryAction'] = canPickup
    ? 'pickup'
    : canCancel
      ? 'waiting'
      : ''
  const primaryActionLabel = canPickup
    ? order.status === 4
      ? PICKUP_SHEET_COPY.topUpAction
      : PICKUP_SHEET_COPY.pickupAction
    : canCancel
      ? ORDER_COPY.continueWaiting
      : ''

  return {
    canPickup,
    showActionBar: canPickup || canCancel,
    primaryAction,
    primaryActionLabel,
    showCancel: canCancel,
    cancelActionLabel: ORDER_CANCEL_COPY.action,
    showScanEntry: isHistory,
    scanEntryLabel: ORDER_COPY.scanEntry,
  }
}

/** `13.9` 的 `order` + `locker` → 取件层入参（共享组件不知道详情响应有两个块）。 */
function pickupOrderOf(detail: OrderDetailResponse): PickupOrder {
  const order = detail.order
  return {
    id: order.id,
    status: order.status,
    startAt: order.startAt,
    endAt: order.endAt,
    payAmount: order.payAmount,
    estimatedAmount: order.estimatedAmount,
    siteName: detail.locker.siteName,
    lockerNo: detail.locker.lockerNo,
    cellNo: detail.locker.cellNo,
  }
}

/** 把 `13.9` 的回显落成页面态。 */
function renderDetail(page: OrderDetailPageInstance, detail: OrderDetailResponse): void {
  const order = detail.order
  const status = resolveOrderStatus(order.status, order.startAt, order.endAt)
  const timelineRows = timelineOf(detail.timeline)
  const paymentRows = paymentsOf(detail)

  // 取件层打开时要拼 `PickupOrder`；存下这次回显，避免再发一次 `13.9`。
  runtimeOf(page).detail = detail

  page.setData({
    phase: 'ready',
    statusLabel: status.label,
    statusTone: status.tone,
    statusTime: keyTimeOf(order, new Date()),
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
  if (runtime.orderId === null || page.data.primaryAction !== 'waiting') return
  wx.redirectTo({ url: `/${WAITING_PATH}?orderId=${runtime.orderId}&mode=drop` })
}

/**
 * 已存入 / 已超时 —— 打开共享取件层。
 *
 * ⚠️ 页面只把 `PickupOrder` 塞进 `data`，弹层自己负责 `13.11` 与支付状态机。
 * 这里不画金额、不调支付接口、不判断「付没付过」。
 */
function openPickup(page: OrderDetailPageInstance): void {
  const runtime = runtimeOf(page)
  if (runtime.detail === null || !page.data.canPickup) return
  page.setData({ pickupOrder: pickupOrderOf(runtime.detail) })
}

/**
 * 取件层支付成功 —— 宿主的去向：详情入口 `redirectTo` 等待页（`mode=pickup`）。
 *
 * ⚠️ 不在详情页停留、不 toast「支付成功」：成功文案已在弹层里逐字呈现，
 * 用户点「知道了」之后应当直接看到「已发出开门指令」的等待页。
 */
function pickupSuccess(page: OrderDetailPageInstance): void {
  const runtime = runtimeOf(page)
  page.setData({ pickupOrder: null })
  if (runtime.orderId === null) return
  wx.redirectTo({ url: `/${WAITING_PATH}?orderId=${runtime.orderId}&mode=pickup` })
}

/** 用户关掉空闲 / 失败态弹层 —— 只收起，不刷新、不跳转。 */
function pickupDismiss(page: OrderDetailPageInstance): void {
  page.setData({ pickupOrder: null })
}

/**
 * 取件层要求来源页刷新。
 *
 * `missing=true` 是 `3001` / `8003`：订单不存在或非本人，来源页直接回列表
 * （详情页的「不存在」页也好、列表也好，都不该让用户继续在弹层里重试）。
 * 其余（`3002` / 网络核对终局）静默刷新 `13.9`，把最新状态画回来。
 */
function pickupRefresh(
  page: OrderDetailPageInstance,
  event: { detail?: { missing?: boolean } },
): void {
  page.setData({ pickupOrder: null })
  if (event.detail?.missing === true) {
    wx.switchTab({ url: `/${ORDER_LIST_PATH}` })
    return
  }
  void load(page, 'refresh')
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
  scanToLocker('navigate')
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
  onPickupSuccess(): void
  onPickupDismiss(): void
  onPickupRefresh(event: { detail?: { missing?: boolean } }): void
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
    primaryAction: '',
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
    pickupOrder: null,
  } as OrderDetailPageData,

  methods: {
    onLoad(options: Record<string, string | undefined>): void {
      enterPage(this as unknown as OrderDetailPageInstance, options)
    },

    onShow(): void {
      showPage(this as unknown as OrderDetailPageInstance)
    },

    onPrimaryAction(): void {
      const page = this as unknown as OrderDetailPageInstance
      if (page.data.primaryAction === 'pickup') {
        openPickup(page)
        return
      }
      continueWaiting(page)
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

    onPickupSuccess(): void {
      pickupSuccess(this as unknown as OrderDetailPageInstance)
    },

    onPickupDismiss(): void {
      pickupDismiss(this as unknown as OrderDetailPageInstance)
    },

    onPickupRefresh(event: { detail?: { missing?: boolean } }): void {
      pickupRefresh(this as unknown as OrderDetailPageInstance, event)
    },
  },
})
