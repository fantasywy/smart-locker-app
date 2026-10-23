// **等待关门页** —— 存取件两条主链在「按下开门之后、关门落定之前」的会合点。
//
// ## 这一页唯一可以说出口的事实
//
// 用户看到「已发出开门指令」—— 陈述的是**我们刚请服务端生成了一条开门指令**，
// 不是「门已开」。指令有没有送达、门有没有真的打开、用户关没关门，C 端一概看不见。
// 因此页面**不显示**倒计时 / 分钟数 / 指令状态 / 进度条；`openTimeoutMinutes`
// 只作为页面参数被接收，本文件不读、不算、不展示它。
//
// ## 页面态从哪来
//
// 全部由 `13.9` 的 `status` / `startAt` / `endAt` / `payAmount` 派生：
//
//   status=7                      → cancelled（订单已取消）
//   status=3                      → picked（已完成取件 + 实付）
//   status=4 且 endAt != null     → timeoutEnd（已完成取件 + 超时结束 + 已付）
//   status=5 / 6                  → ended（已结束 / 已退款）
//   status=2 且 startAt != null   → stored（已存入 + 取件码）
//   其余（含 status=4 且 endAt=null → 取件等待）→ waiting
//
// `paid` / `openCommandIssued` **不参与任何判断**（支付成功 ≠ 订单完成）。
// `mode` 只决定首屏「下一步」文案；`mode` 缺失时按 `startAt == null → 存入` 回显判断。
//
// ## 轮询硬约束（spec §4）
//
//   • 前台每 3 秒一次、最多 20 次（60 秒）→ stalled 停表；
//   • `onHide` / `onUnload` 停表；每次 `onShow` 重开一个 20 次窗口；
//   • 检测到终局立即停表；**永不自动跳转**，终局也由用户点按钮离开；
//   • 单次核对失败静默；连续 2 次失败 → trouble（网络提示）并继续轮询；
//   • 手动核对是一次性请求：仍无变化 → 一句提示后留在 stalled。
//
// ## 取消与重新开门
//
//   • 取消只在「存入等待」（status=2 且 startAt=null、且方向为存入）出现；
//     二次确认 → `13.10`；成功 toast + 切 cancelled；`3002` 用契约逐字弹窗。
//     存入路径**没有重试** —— 失败不自动重发。
//   • 取件停滞的「重新开门」二次确认后重发 `13.11`（幂等）；
//     成功 toast「已重新发出开门指令」并重新等待，失败「没收到结果，请稍后重试」。

import { cancelOrder, getOrderDetail, payOrder } from '../../api/orders'
import type { OrderDetailOrder, OrderDetailResponse } from '../../types/orders'
import {
  HOME_PAGE_COPY,
  ORDER_LIST_PATH,
  PAGE_TITLES,
  WAITING_PAGE_COPY,
} from '../../startup/copy'
import { alert, confirm, showToast } from '../../utils/feedback'
import { resolveLockerCode } from '../../utils/locker-code'
import { formatMoney } from '../../utils/money'
import { LOCKER_PATH } from '../../utils/routes'

/** 轮询间隔 —— spec §4 逐字：每 3 秒一次。 */
const POLL_INTERVAL_MS = 3000

/** 轮询上限 —— spec §4 逐字：最多 20 次（60 秒）。 */
const POLL_LIMIT = 20

/** 「暂时没有更新」轻提示的展示时长 —— spec §4 逐字：3 秒后消失。 */
const NO_UPDATE_TOAST_MS = 3000

/** `13.9` 订单不存在（契约 §13.9 :1197）。 */
const ORDER_NOT_FOUND = 3001

/** `13.9` 非本人订单（契约 §13.9 :1197）。 */
const ORDER_FORBIDDEN = 8003

/** `13.10` 取消被拒：订单状态已变化 / 开门指令已回执（契约 §13.10 :1204）。 */
const ORDER_STATE_CHANGED = 3002

/** 等待页的页面态 —— 前四个是进行中，其余是终局 / 不存在。 */
type WaitingPhase =
  | 'waiting'
  | 'checking'
  | 'stalled'
  | 'trouble'
  | 'stored'
  | 'picked'
  | 'timeoutEnd'
  | 'cancelled'
  | 'ended'
  | 'missing'

/** 终局态（一旦进入就停表，不再接受轮询结果）。 */
type TerminalPhase = Extract<
  WaitingPhase,
  'stored' | 'picked' | 'timeoutEnd' | 'cancelled' | 'ended' | 'missing'
>

/** 路径方向 —— `mode` 只影响首屏下一步文案，不影响终局。 */
type WaitingDirection = 'drop' | 'pickup'

/** 一次核对是自动轮询、手动核对，还是进页首查。 */
type CheckSource = 'initial' | 'auto' | 'manual'

interface WaitingPageData {
  /** 自绘导航栏标题。 */
  title: string
  phase: WaitingPhase

  /** 主陈述与下一步 —— 等待期唯一能说的两句话。 */
  mainStatement: string
  nextStep: string
  autoUpdate: string
  showAutoUpdate: boolean

  /** 停滞 / 网络提示。 */
  stalledHint: string
  networkHint: string

  /** 手动核对按钮。 */
  manualCheckLabel: string
  manualCheckDisabled: boolean
  showManualCheck: boolean

  /** 存入等待的取消。 */
  cancelActionLabel: string
  cancelDisabled: boolean
  showCancel: boolean

  /** 取件停滞的重新开门。 */
  reopenLabel: string
  reopenDisabled: boolean
  showReopen: boolean

  /** 固定出口。 */
  backToOrdersLabel: string
  rescanLabel: string

  /** 终局文案。 */
  terminalTitle: string
  terminalHint: string
  terminalChip: string
  terminalIcon: string

  /** 存入终局的取件码块 —— 有值时**常驻**。 */
  pickupCodeLabel: string
  pickupCode: string
  showPickupCode: boolean

  /** 取件终局的金额块 —— 只有实付 / 已付两个词。 */
  amountLabel: string
  amountText: string
  showAmount: boolean

  /** 取消终局额外的「重新扫码」出口。 */
  showRescan: boolean
}

interface WaitingPageInstance {
  data: WaitingPageData
  setData(patch: Partial<WaitingPageData>): void
}

/** 一次页面会话的私有运行时 —— 不进 `data`，因为它是时序状态而不是渲染模型。 */
interface WaitingRuntime {
  orderId: number | null
  /** 入口带来的 `mode`；缺失时按 `13.9` 回显推断一次。 */
  mode: WaitingDirection | null
  direction: WaitingDirection | null
  /** 当前 20 次窗口里已经发过几次轮询。 */
  attempts: number
  timer: ReturnType<typeof setTimeout> | null
  foreground: boolean
  /** 是否已经收到过第一次 `onShow`（真实运行时 onLoad 后紧跟 onShow）。 */
  started: boolean
  terminal: boolean
  destroyed: boolean
  inFlight: boolean
  consecutiveFailures: number
  /** 当前这次核对开始前的页面态 —— 用于失败后恢复 / 判断是否从停滞发起。 */
  previousPhase: WaitingPhase | null
  /** 手动核对按钮是否属于当前这一屏（自动轮询不应凭空把它亮出来）。 */
  manualVisible: boolean
  canCancel: boolean
  cancelling: boolean
  reopening: boolean
}

/** 页面实例 → 运行时。`WeakMap` 不缓存业务数据，只把时序状态挂在实例上。 */
const runtimes = new WeakMap<WaitingPageInstance, WaitingRuntime>()

function runtimeOf(page: WaitingPageInstance): WaitingRuntime {
  let runtime = runtimes.get(page)
  if (runtime === undefined) {
    runtime = {
      orderId: null,
      mode: null,
      direction: null,
      attempts: 0,
      timer: null,
      foreground: true,
      started: false,
      terminal: false,
      destroyed: false,
      inFlight: false,
      consecutiveFailures: 0,
      previousPhase: null,
      manualVisible: false,
      canCancel: false,
      cancelling: false,
      reopening: false,
    }
    runtimes.set(page, runtime)
  }
  return runtime
}

/** 清掉当前计时器 —— 停表只有这一个入口，避免三处各写一遍 `clearTimeout`。 */
function clearTimer(runtime: WaitingRuntime): void {
  if (runtime.timer !== null) {
    clearTimeout(runtime.timer)
    runtime.timer = null
  }
}

/**
 * 按页面态重算「这一屏允许出现哪些动作」。
 *
 * ⚠️ 把这些开关集中在这里，是因为它们之间**互斥且有优先级**：
 * 终局绝不能残留取消 / 重新开门按钮；核对中必须禁用动作；停滞态才出现手动核对。
 * 散在 wxml 里的 `wx:if` 一旦漏一个，用户就会在一个已经结束的订单上看到可点的取消。
 */
function syncChrome(
  page: WaitingPageInstance,
  phase: WaitingPhase,
  patch: Partial<WaitingPageData> = {},
): void {
  const runtime = runtimeOf(page)
  const inProgress =
    phase === 'waiting' || phase === 'checking' || phase === 'stalled' || phase === 'trouble'
  const checking = phase === 'checking'
  page.setData({
    phase,
    showAutoUpdate:
      phase === 'waiting' ||
      phase === 'trouble' ||
      (checking && runtime.previousPhase !== 'stalled'),
    showManualCheck:
      phase === 'stalled' ||
      phase === 'trouble' ||
      (checking && runtime.manualVisible),
    manualCheckDisabled: checking,
    manualCheckLabel: checking ? WAITING_PAGE_COPY.checking : WAITING_PAGE_COPY.manualCheck,
    showCancel: inProgress && runtime.canCancel,
    cancelDisabled: checking || runtime.cancelling,
    showReopen: phase === 'stalled' && runtime.direction === 'pickup',
    reopenDisabled: runtime.reopening,
    ...patch,
  })
}

/** 把 `13.9` 的方向回显写成首屏下一步文案。 */
function applyDirection(page: WaitingPageInstance, order: OrderDetailOrder): void {
  const runtime = runtimeOf(page)
  if (runtime.mode !== null) {
    runtime.direction = runtime.mode
  } else if (runtime.direction === null) {
    runtime.direction = order.startAt === null ? 'drop' : 'pickup'
  }
  page.setData({
    nextStep:
      runtime.direction === 'drop' ? WAITING_PAGE_COPY.dropNext : WAITING_PAGE_COPY.pickupNext,
  })
}

interface TerminalSpec {
  phase: TerminalPhase
  title: string
  hint: string
  icon: string
  chip?: string
  pickupCode?: string
  amountLabel?: string
  amountText?: string
  rescan?: boolean
}

/** 进入终局 —— 先停表，再落文案；终局一旦进入不再接受任何轮询结果。 */
function enterTerminal(page: WaitingPageInstance, spec: TerminalSpec): void {
  const runtime = runtimeOf(page)
  runtime.terminal = true
  runtime.canCancel = false
  runtime.manualVisible = false
  runtime.cancelling = false
  runtime.reopening = false
  clearTimer(runtime)

  const pickupCode = spec.pickupCode ?? ''
  const amountText = spec.amountText ?? ''
  syncChrome(page, spec.phase, {
    terminalTitle: spec.title,
    terminalHint: spec.hint,
    terminalChip: spec.chip ?? '',
    terminalIcon: spec.icon,
    pickupCode,
    showPickupCode: pickupCode !== '',
    amountLabel: spec.amountLabel ?? '',
    amountText,
    showAmount: amountText !== '',
    showRescan: spec.rescan === true,
  })
}

/** 订单不存在 / 非本人 / 已删除 —— 三种来源统一一句话，没有第二种说法。 */
function enterMissing(page: WaitingPageInstance): void {
  enterTerminal(page, {
    phase: 'missing',
    title: WAITING_PAGE_COPY.missingTitle,
    hint: '',
    icon: 'status.cancelled',
  })
}

/** 取件终局的金额块 —— 只有 `payAmount` 有值时才渲染。 */
function amountOf(
  order: OrderDetailOrder,
  label: string,
): { amountLabel: string; amountText: string } {
  return {
    amountLabel: label,
    amountText: order.payAmount === null ? '' : formatMoney(order.payAmount),
  }
}

/**
 * 把 `13.9` 的回显落成页面态。
 *
 * @param source 这次核对的来源 —— 手动核对从停滞发起时，「仍无变化」要留在停滞并提示
 * @param previousPhase 核对开始前的页面态 —— 区分「从停滞手动核对」与「自动轮询」
 */
function renderDetail(
  page: WaitingPageInstance,
  detail: OrderDetailResponse,
  source: CheckSource,
  previousPhase: WaitingPhase | null,
): void {
  const runtime = runtimeOf(page)
  const order = detail.order
  applyDirection(page, order)
  runtime.canCancel =
    order.status === 2 && order.startAt === null && runtime.direction === 'drop'

  if (order.status === 7) {
    enterTerminal(page, {
      phase: 'cancelled',
      title: WAITING_PAGE_COPY.cancelledTitle,
      hint: WAITING_PAGE_COPY.cancelledHint,
      icon: 'status.cancelled',
      rescan: true,
    })
    return
  }

  if (order.status === 3) {
    const amount = amountOf(order, WAITING_PAGE_COPY.paidLabel)
    enterTerminal(page, {
      phase: 'picked',
      title: WAITING_PAGE_COPY.pickedTitle,
      hint: '',
      icon: 'status.completed',
      ...amount,
    })
    return
  }

  if (order.status === 4 && order.endAt !== null) {
    const amount = amountOf(order, WAITING_PAGE_COPY.timeoutPaidLabel)
    enterTerminal(page, {
      phase: 'timeoutEnd',
      title: WAITING_PAGE_COPY.pickedTitle,
      hint: '',
      icon: 'status.completed',
      chip: WAITING_PAGE_COPY.timeoutChip,
      ...amount,
    })
    return
  }

  if (order.status === 5 || order.status === 6) {
    const refunded = order.status === 6
    enterTerminal(page, {
      phase: 'ended',
      title: refunded ? WAITING_PAGE_COPY.refundedTitle : WAITING_PAGE_COPY.endedTitle,
      hint: WAITING_PAGE_COPY.endedHint,
      icon: refunded ? 'status.refunded' : 'status.forcedEnd',
    })
    return
  }

  if (order.status === 2 && order.startAt !== null) {
    enterTerminal(page, {
      phase: 'stored',
      title: WAITING_PAGE_COPY.storedTitle,
      hint: WAITING_PAGE_COPY.storedHint,
      icon: 'status.completed',
      pickupCode: order.pickupCode ?? '',
    })
    return
  }

  // 手动核对仍无变化 —— 一句提示后**留在停滞**，不假装页面还在自动更新。
  if (source === 'manual' && previousPhase === 'stalled') {
    showToast({ message: WAITING_PAGE_COPY.noUpdate, duration: NO_UPDATE_TOAST_MS })
    runtime.manualVisible = false
    syncChrome(page, 'stalled')
    return
  }

  runtime.manualVisible = false
  syncChrome(page, 'waiting')
  scheduleNext(page)
}

/** 60 秒未终局 —— 停表进停滞，手动核对常驻。 */
function enterStalled(page: WaitingPageInstance): void {
  const runtime = runtimeOf(page)
  runtime.manualVisible = false
  clearTimer(runtime)
  syncChrome(page, 'stalled')
}

/**
 * 排下一次轮询。
 *
 * ⚠️ 用 `setTimeout` 链而不是 `setInterval`：每一次都要等上一次请求回来再排下一次，
 * 否则慢网络下会叠出多个在飞的 `13.9`，20 次的「窗口」也就失真了。
 */
function scheduleNext(page: WaitingPageInstance): void {
  const runtime = runtimeOf(page)
  if (
    runtime.timer !== null ||
    runtime.terminal ||
    runtime.destroyed ||
    !runtime.foreground ||
    runtime.orderId === null
  ) {
    return
  }
  if (runtime.attempts >= POLL_LIMIT) {
    enterStalled(page)
    return
  }

  runtime.timer = setTimeout(() => {
    runtime.timer = null
    if (runtime.destroyed || runtime.terminal || !runtime.foreground) return
    if (runtime.inFlight) {
      scheduleNext(page)
      return
    }
    if (runtime.attempts >= POLL_LIMIT) {
      enterStalled(page)
      return
    }
    runtime.attempts += 1
    void check(page, 'auto')
  }, POLL_INTERVAL_MS)
}

/** 核对失败 —— `3001` / `8003` 直接终局；其余按连续失败次数决定是否给网络提示。 */
function handleCheckFailure(
  page: WaitingPageInstance,
  code: number | null,
  source: CheckSource,
  previousPhase: WaitingPhase | null,
): void {
  if (code === ORDER_NOT_FOUND || code === ORDER_FORBIDDEN) {
    enterMissing(page)
    return
  }

  const runtime = runtimeOf(page)
  runtime.consecutiveFailures += 1
  runtime.manualVisible = source === 'manual'
  const fromStalled = previousPhase === 'stalled'

  if (runtime.consecutiveFailures >= 2) {
    // 连续两次失败 —— 提示网络不顺，但**不改主陈述**，轮询继续。
    syncChrome(page, 'trouble')
    if (fromStalled) {
      // 停滞后的手动核对连续失败：按「正在重试」重新开一个窗口。
      runtime.attempts = 0
    }
    scheduleNext(page)
    return
  }

  syncChrome(page, fromStalled ? 'stalled' : 'waiting')
  if (!fromStalled) scheduleNext(page)
}

/**
 * 核对一次 `13.9` —— 自动 / 手动 / 进页首查共用这一条链路。
 *
 * ⚠️ `inFlight` 是技术性防抖：手动核对与自动轮询不能同时打两个 `13.9`，
 * 否则后回来的旧响应会把新页面态覆盖回去。
 */
async function check(page: WaitingPageInstance, source: CheckSource): Promise<void> {
  const runtime = runtimeOf(page)
  if (
    runtime.orderId === null ||
    runtime.destroyed ||
    runtime.terminal ||
    runtime.inFlight
  ) {
    return
  }

  const orderId = runtime.orderId
  const previousPhase = page.data.phase
  runtime.previousPhase = previousPhase
  runtime.inFlight = true
  // 手动核对一定显示按钮；trouble 里的自动核对也应保持按钮可见（只是禁用），
  // 否则「正在重试」这一屏上的手动入口会每 3 秒闪一次。
  if (source === 'manual' || previousPhase === 'trouble') runtime.manualVisible = true
  syncChrome(page, 'checking')

  const result = await getOrderDetail(orderId)
  runtime.inFlight = false
  if (runtime.destroyed || runtime.terminal) return

  if (!result.ok) {
    handleCheckFailure(page, result.error.code, source, previousPhase)
    return
  }

  runtime.consecutiveFailures = 0
  renderDetail(page, result.data, source, previousPhase)
}

/** 手动核对 —— 只在停滞 / 网络提示态出现，一次性请求。 */
function manualCheck(page: WaitingPageInstance): void {
  if (page.data.phase !== 'stalled' && page.data.phase !== 'trouble') return
  void check(page, 'manual')
}

/** 打开「取消这单？」二次确认，确认后调 `13.10`。 */
async function cancel(page: WaitingPageInstance): Promise<void> {
  const runtime = runtimeOf(page)
  if (
    runtime.orderId === null ||
    runtime.terminal ||
    runtime.cancelling ||
    page.data.phase === 'checking' ||
    !page.data.showCancel
  ) {
    return
  }

  const confirmed = await confirm({
    title: WAITING_PAGE_COPY.cancelTitle,
    message: WAITING_PAGE_COPY.cancelMessage,
    cancelText: WAITING_PAGE_COPY.cancelDismiss,
    confirmText: WAITING_PAGE_COPY.cancelAction,
  })
  if (!confirmed || runtime.destroyed || runtime.terminal) return

  const orderId = runtime.orderId
  const phaseBefore = page.data.phase
  runtime.cancelling = true
  clearTimer(runtime)
  syncChrome(page, phaseBefore)

  const result = await cancelOrder(orderId)
  runtime.cancelling = false
  if (runtime.destroyed || runtime.terminal) return

  if (!result.ok) {
    if (result.error.code === ORDER_STATE_CHANGED) {
      syncChrome(page, phaseBefore)
      // 取消没发生，订单仍在等待 —— 轮询要继续（刚才为发请求暂停过）；
      // 但从停滞发起时轮询本来就是停的，不能被这次失败重新拉起来。
      if (phaseBefore !== 'stalled') scheduleNext(page)
      await alert({
        title: WAITING_PAGE_COPY.cancelTitle,
        message: WAITING_PAGE_COPY.cancelRejected,
      })
      return
    }
    if (result.error.code === ORDER_NOT_FOUND || result.error.code === ORDER_FORBIDDEN) {
      enterMissing(page)
      return
    }
    // 存入路径**没有重试**：只把事实告诉用户，不自动重发 `13.10`。
    syncChrome(page, phaseBefore)
    if (phaseBefore !== 'stalled') scheduleNext(page)
    showToast(WAITING_PAGE_COPY.reopenFailed)
    return
  }

  showToast(WAITING_PAGE_COPY.cancelSuccess)
  enterTerminal(page, {
    phase: 'cancelled',
    title: WAITING_PAGE_COPY.cancelledTitle,
    hint: WAITING_PAGE_COPY.cancelledHint,
    icon: 'status.cancelled',
    rescan: true,
  })
}

/** 打开「重新开门？」二次确认，确认后重发幂等的 `13.11`。 */
async function reopen(page: WaitingPageInstance): Promise<void> {
  const runtime = runtimeOf(page)
  if (
    runtime.orderId === null ||
    runtime.terminal ||
    runtime.reopening ||
    page.data.phase !== 'stalled' ||
    runtime.direction !== 'pickup'
  ) {
    return
  }

  const confirmed = await confirm({
    title: WAITING_PAGE_COPY.reopenTitle,
    message: WAITING_PAGE_COPY.reopenMessage,
    cancelText: WAITING_PAGE_COPY.reopenCancel,
    confirmText: WAITING_PAGE_COPY.reopenAction,
  })
  if (!confirmed || runtime.destroyed || runtime.terminal) return

  const orderId = runtime.orderId
  runtime.reopening = true
  syncChrome(page, 'stalled')

  const result = await payOrder(orderId)
  runtime.reopening = false
  if (runtime.destroyed || runtime.terminal) return

  if (!result.ok) {
    if (result.error.code === ORDER_NOT_FOUND || result.error.code === ORDER_FORBIDDEN) {
      enterMissing(page)
      return
    }
    syncChrome(page, 'stalled')
    showToast(WAITING_PAGE_COPY.reopenFailed)
    return
  }

  // 指令已重新发出 —— 回到等待并重新开一个 20 次窗口（不自动跳转）。
  runtime.consecutiveFailures = 0
  runtime.attempts = 0
  clearTimer(runtime)
  syncChrome(page, 'waiting')
  showToast(WAITING_PAGE_COPY.reopenSuccess)
  scheduleNext(page)
}

/** 终局的「重新扫码」—— 与首页同一条解析链路，但用 `redirectTo` 替换等待页。 */
function rescan(page: WaitingPageInstance): void {
  if (page.data.phase !== 'cancelled') return
  wx.scanCode({
    success: (result) => {
      const code = resolveLockerCode({ scanResult: result.result })
      if (code === null) {
        showToast(HOME_PAGE_COPY.notLockerCode)
        return
      }
      wx.redirectTo({ url: `/${LOCKER_PATH}?code=${encodeURIComponent(code)}` })
    },
    fail: (error) => {
      // 用户主动取消不是失败；其余成因不按成因分叉。
      if (error.errMsg.includes('cancel')) return
      showToast(HOME_PAGE_COPY.scanFailed)
    },
  })
}

/** 固定的「回订单列表」出口 —— 订单列表是 tab 页，只能 `switchTab`。 */
function backToOrders(): void {
  wx.switchTab({ url: `/${ORDER_LIST_PATH}` })
}

/** 进页 —— 收敛参数，决定首屏方向，然后开始第一次核对。 */
function enterPage(page: WaitingPageInstance, options: Record<string, string | undefined>): void {
  const runtime = runtimeOf(page)
  runtime.foreground = true

  const rawOrderId = options['orderId']
  const orderId = rawOrderId === undefined ? Number.NaN : Number(rawOrderId)
  if (!Number.isInteger(orderId) || orderId <= 0) {
    enterMissing(page)
    return
  }
  runtime.orderId = orderId

  const mode = options['mode']
  if (mode === 'drop' || mode === 'pickup') {
    runtime.mode = mode
    runtime.direction = mode
    page.setData({
      nextStep: mode === 'drop' ? WAITING_PAGE_COPY.dropNext : WAITING_PAGE_COPY.pickupNext,
    })
  }

  void check(page, 'initial')
}

/** 每次回到前台重开一个 20 次窗口（首次 onShow 紧跟 onLoad，不重置刚发出的首查）。 */
function showPage(page: WaitingPageInstance): void {
  const runtime = runtimeOf(page)
  runtime.foreground = true
  if (runtime.orderId === null || runtime.terminal || runtime.destroyed) return
  if (!runtime.started) {
    runtime.started = true
    return
  }

  runtime.attempts = 0
  runtime.consecutiveFailures = 0
  clearTimer(runtime)
  if (page.data.phase === 'stalled') syncChrome(page, 'waiting')
  scheduleNext(page)
}

/** 离开前台 —— 停表，但保留页面态；回来时由 `showPage` 重开窗口。 */
function hidePage(page: WaitingPageInstance): void {
  const runtime = runtimeOf(page)
  runtime.foreground = false
  clearTimer(runtime)
}

/** 卸载 —— 停表并阻止任何迟到的响应再 `setData`。 */
function unloadPage(page: WaitingPageInstance): void {
  const runtime = runtimeOf(page)
  runtime.destroyed = true
  runtime.foreground = false
  clearTimer(runtime)
}

/** 页面方法 —— 与 `Component()` 的第三个泛型一一对应。 */
interface WaitingPageMethods {
  [name: string]: (...args: never[]) => unknown
  onLoad(options: Record<string, string | undefined>): void
  onShow(): void
  onHide(): void
  onUnload(): void
  onManualCheck(): void
  onCancel(): void
  onReopen(): void
  onRescan(): void
  onBackToOrders(): void
}

Component<WaitingPageData, Record<string, never>, WaitingPageMethods, Record<string, never>, true>({
  data: {
    title: PAGE_TITLES['pages/waiting/waiting'],
    phase: 'waiting',

    mainStatement: WAITING_PAGE_COPY.mainStatement,
    nextStep: '',
    autoUpdate: WAITING_PAGE_COPY.autoUpdate,
    showAutoUpdate: true,

    stalledHint: WAITING_PAGE_COPY.stalledHint,
    networkHint: WAITING_PAGE_COPY.networkHint,

    manualCheckLabel: WAITING_PAGE_COPY.manualCheck,
    manualCheckDisabled: false,
    showManualCheck: false,

    cancelActionLabel: WAITING_PAGE_COPY.cancelAction,
    cancelDisabled: false,
    showCancel: false,

    reopenLabel: WAITING_PAGE_COPY.reopenLink,
    reopenDisabled: false,
    showReopen: false,

    backToOrdersLabel: WAITING_PAGE_COPY.backToOrders,
    rescanLabel: WAITING_PAGE_COPY.rescan,

    terminalTitle: '',
    terminalHint: '',
    terminalChip: '',
    terminalIcon: '',

    pickupCodeLabel: WAITING_PAGE_COPY.pickupCodeLabel,
    pickupCode: '',
    showPickupCode: false,

    amountLabel: '',
    amountText: '',
    showAmount: false,

    showRescan: false,
  } as WaitingPageData,

  lifetimes: {
    attached(): void {
      // 有意为空 —— 页面参数只在 onLoad 里拿得到。
    },
  },

  methods: {
    onLoad(options: Record<string, string | undefined>): void {
      enterPage(this as unknown as WaitingPageInstance, options)
    },

    onShow(): void {
      showPage(this as unknown as WaitingPageInstance)
    },

    onHide(): void {
      hidePage(this as unknown as WaitingPageInstance)
    },

    onUnload(): void {
      unloadPage(this as unknown as WaitingPageInstance)
    },

    onManualCheck(): void {
      manualCheck(this as unknown as WaitingPageInstance)
    },

    onCancel(): void {
      void cancel(this as unknown as WaitingPageInstance)
    },

    onReopen(): void {
      void reopen(this as unknown as WaitingPageInstance)
    },

    onRescan(): void {
      rescan(this as unknown as WaitingPageInstance)
    },

    onBackToOrders(): void {
      backToOrders()
    },
  },
})
