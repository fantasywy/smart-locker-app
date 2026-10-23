// **我的预约页** —— 待使用 / 已结束两组、五种状态、两个行内动作（spec #57 §10）。
//
// ## 边界（这一页最容易做错的三件事）
//
// 1. **`6202` 不猜窗口。** 使用窗口 = `[planStartAt − holdMinutes, planStartAt + noShowMinutes)`，
//    两个端点都**不在 C 端契约里**。⇒ 页面不显示分钟数、不按窗口置灰「开始使用」、
//    不做倒计时；服务端拒绝时只在动作点说一句「现在还不能开始使用，请在预约时段前后再试」
//    并刷新列表。按钮始终可见可点。
// 2. **爽约与失效归因分开。** `NOSHOW` = 用户没去（已扣信用分）；`EXPIRED` = 柜机故障
//    （不扣信用分）。两句说明必须不同 —— 这是 spec §10 的验收事实。
// 3. **不做本地缓存。** 预约状态会在用户没打开 App 时变（定时任务置爽约 / 柜机故障置失效），
//    列表每次进入 / 刷新都从 `api/` 取；页面零 storage。
//
// ## 数据来源
//
// 一次 `13.13` 返回 `{list,total}`，`api/` 已映射成 `PageOf.records`。分组与组内排序
// 是**展示层**的职责（端点只给单值 `status`，既要待使用又要已结束 ⇒ 不能服务端过滤）。
// 排序只作用于**已加载的条目**：分页仍是服务端顺序，触底只追加。
//
// ⚠️ 中文档名 / 状态标签 / 按钮文案全部来自 `startup/copy.ts`；本页不写用户可见字面量。

import { cancelReservation, listReservations, useReservation } from '../../api/reservations'
import type { Reservation } from '../../types/reservations'
import {
  EMPTY_STATES,
  HOME_PAGE_COPY,
  LOCKER_PAGE_COPY,
  PAGE_TITLES,
  PROFILE_COPY,
  RESERVATION_LIST_COPY,
} from '../../startup/copy'
import { formatReservationRange } from '../../utils/datetime'
import { confirm, showToast } from '../../utils/feedback'
import {
  appendPage,
  applyFirstPage,
  canLoadMore,
  createPagedList,
  nextPage,
} from '../../utils/pagination'
import type { PagedList } from '../../utils/pagination'
import { isPendingReservation, resolveReservationStatus } from '../../utils/reservation-status'
import { resolveLockerCode } from '../../utils/locker-code'
import { LOCKER_PATH, ORDER_DETAIL_PATH, WAITING_PATH } from '../../utils/routes'

/** 每页条数 —— spec §10 逐字：每页 10。 */
const RESERVATION_PAGE_SIZE = 10

/** `13.15` 使用窗口外 / 状态已变（契约 §13.15）。 */
const RESERVATION_STATE_REJECTED = 6202

/** `13.15` 所约柜机现在不可用（契约 §13.15）。 */
const LOCKER_UNAVAILABLE = 4004

/**
 * 动作失败的最小形状 —— 页面**不认识**请求层类型（`pages/` 不得直接 import `request/`，
 * 分层守卫会拦）。这里只声明页面真正读的三个字段；来源仍是 `RequestResult.error`。
 */
interface ActionFailure {
  code: number | null
  kind: string
  message: string | null
}

/** 页面态 —— 首屏骨架 / 列表 / 页内失败。 */
type ReservationListPhase = 'loading' | 'ready' | 'failed'

/** 卡片上的一条预约 —— 全部字段都是渲染模型，不是缓存。 */
interface ReservationCardView {
  id: number
  /** `USED` 且有关联订单时的订单 ID；其余为 null。 */
  orderId: number | null
  siteName: string
  lockerNo: string
  /** 档名 + cellNo（如「中格口 · M05」）——只作行内定位辅助。 */
  cellText: string
  /** `MM-DD HH:mm – HH:mm`（同日只写一次日期）。 */
  timeRange: string
  statusLabel: string
  /** 与 `tone-chip` / `tone-card` 的档名一一对应。 */
  statusTone: string
  /** `NOSHOW` / `EXPIRED` 的卡内说明；其余为空。 */
  note: string
  showNote: boolean
  showStart: boolean
  showCancel: boolean
  showViewOrder: boolean
}

/** 一组（待使用 / 已结束）—— 空组不进入 `groups`，wxml 因此不会画空组头。 */
interface ReservationGroupView {
  key: 'pending' | 'ended'
  title: string
  cards: ReservationCardView[]
}

interface ReservationListData {
  title: string
  phase: ReservationListPhase
  groups: ReservationGroupView[]
  /** 拉过且一条都没有 —— 与「还没拉」由 `phase` 区分。 */
  isEmpty: boolean
  loadFailed: string
  retryLabel: string
  emptyTitle: string
  emptyHint: string
  emptyActionLabel: string
  startActionLabel: string
  cancelActionLabel: string
  viewOrderLabel: string
}

interface ReservationListInstance {
  data: ReservationListData
  setData(patch: Partial<ReservationListData>): void
}

/** 页面会话的私有运行时 —— 分页推进与并发守卫不进 `data`。 */
interface ReservationListRuntime {
  paged: PagedList<Reservation>
  loading: boolean
  /** 只为忽略迟到的旧响应（刷新会递增它）。 */
  requestSeq: number
  /** 触底返回的整页都是已知 id —— 再拉也不会增长，停止。 */
  exhausted: boolean
  /** 动作请求飞行中 —— 防连点（技术性防抖，允许的禁用态之一）。 */
  actionInFlight: boolean
}

const runtimes = new WeakMap<ReservationListInstance, ReservationListRuntime>()

function runtimeOf(page: ReservationListInstance): ReservationListRuntime {
  let runtime = runtimes.get(page)
  if (runtime === undefined) {
    runtime = {
      paged: createPagedList<Reservation>(),
      loading: false,
      requestSeq: 0,
      exhausted: false,
      actionInFlight: false,
    }
    runtimes.set(page, runtime)
  }
  return runtime
}

/** 按 id 去重 —— 分页越界会重复末页，重复行不能真的画两遍。 */
function uniqueById(items: readonly Reservation[]): Reservation[] {
  const seen = new Set<number>()
  const unique: Reservation[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    unique.push(item)
  }
  return unique
}

/** `planStartAt` 升序 —— 待使用组：最近的先到。 */
function byPlanStartAsc(left: Reservation, right: Reservation): number {
  return left.planStartAt.localeCompare(right.planStartAt)
}

/** `planStartAt` 降序 —— 已结束组：最近发生的在前。 */
function byPlanStartDesc(left: Reservation, right: Reservation): number {
  return right.planStartAt.localeCompare(left.planStartAt)
}

/** 一条 `13.13` 行 → 卡片渲染模型。 */
function cardOf(item: Reservation): ReservationCardView {
  const badge = resolveReservationStatus(item.status)
  const note =
    item.status === 4
      ? RESERVATION_LIST_COPY.noshowNote
      : item.status === 5
        ? RESERVATION_LIST_COPY.expiredNote
        : ''

  return {
    id: item.id,
    orderId: item.orderId,
    siteName: item.siteName,
    lockerNo: item.lockerNo,
    cellText: `${LOCKER_PAGE_COPY.cellTypeLabels[item.cellType]} · ${item.cellNo}`,
    timeRange: formatReservationRange(item.planStartAt, item.planEndAt),
    statusLabel: badge.label,
    statusTone: badge.tone,
    note,
    showNote: note !== '',
    showStart: isPendingReservation(item.status),
    showCancel: isPendingReservation(item.status),
    showViewOrder: item.status === 2 && item.orderId !== null,
  }
}

/** 把已加载的条目重组成两组；空组不出现。 */
function groupsOf(items: readonly Reservation[]): ReservationGroupView[] {
  const pending = items
    .filter((item) => isPendingReservation(item.status))
    .slice()
    .sort(byPlanStartAsc)
  const ended = items
    .filter((item) => !isPendingReservation(item.status))
    .slice()
    .sort(byPlanStartDesc)

  const groups: ReservationGroupView[] = []
  if (pending.length > 0) {
    groups.push({
      key: 'pending',
      title: RESERVATION_LIST_COPY.groupPending,
      cards: pending.map(cardOf),
    })
  }
  if (ended.length > 0) {
    groups.push({
      key: 'ended',
      title: RESERVATION_LIST_COPY.groupEnded,
      cards: ended.map(cardOf),
    })
  }
  return groups
}

/** 把运行时状态刷到 `data` —— 所有成功路径共用这一处。 */
function render(page: ReservationListInstance): void {
  const runtime = runtimeOf(page)
  page.setData({
    phase: 'ready',
    groups: groupsOf(runtime.paged.items),
    isEmpty: runtime.paged.loaded && runtime.paged.items.length === 0,
  })
}

/**
 * 取第一页（首屏 / 刷新共用）—— **替换**已加载内容，不保留陈旧后续页。
 *
 * @param silent 成功后不闪骨架（取消 / `6202` 的刷新走它）
 */
async function loadFirst(page: ReservationListInstance, silent = false): Promise<void> {
  const runtime = runtimeOf(page)
  const seq = runtime.requestSeq + 1
  runtime.requestSeq = seq
  runtime.loading = true
  if (!silent && !runtime.paged.loaded) page.setData({ phase: 'loading' })

  const result = await listReservations(1, RESERVATION_PAGE_SIZE)
  if (seq !== runtime.requestSeq) return
  runtime.loading = false

  if (!result.ok) {
    if (!runtime.paged.loaded) {
      page.setData({ phase: 'failed', groups: [], isEmpty: false })
    } else {
      // 已有内容时刷新失败：保留屏上的真实旧数据，只提示这一次刷新没成功。
      showToast(RESERVATION_LIST_COPY.loadFailed)
    }
    return
  }

  runtime.paged = applyFirstPage({
    records: uniqueById(result.data.records),
    total: result.data.total,
  })
  runtime.exhausted = false
  render(page)
}

/** 触底加载下一页（只追加；重复 id 丢弃）。 */
async function loadMore(page: ReservationListInstance): Promise<void> {
  const runtime = runtimeOf(page)
  if (page.data.phase !== 'ready' || runtime.loading || runtime.exhausted) return
  if (!canLoadMore(runtime.paged)) return

  const seq = runtime.requestSeq
  runtime.loading = true
  const result = await listReservations(nextPage(runtime.paged), RESERVATION_PAGE_SIZE)
  if (seq !== runtime.requestSeq) return
  runtime.loading = false

  if (!result.ok) {
    // 追加失败不动已有列表 —— 用户还能继续看已经拿到的真实数据。
    showToast(RESERVATION_LIST_COPY.loadFailed)
    return
  }

  const known = new Set(runtime.paged.items.map((item) => item.id))
  const records = result.data.records.filter((item) => !known.has(item.id))
  if (records.length === 0) {
    // 服务端越界会钳制到末页：整页都是已知 id ⇒ 再拉也不会增长。
    runtime.exhausted = true
    return
  }

  runtime.paged = appendPage(runtime.paged, { records, total: result.data.total })
  render(page)
}

/** 动作失败的归因 —— 已知码说人话，其余按服务端 message，最后兜底。 */
function failureMessageOf(error: ActionFailure): string {
  if (error.kind === 'restricted') return PROFILE_COPY.restrictedBody
  if (error.code === LOCKER_UNAVAILABLE) return RESERVATION_LIST_COPY.lockerUnavailable
  if (error.message !== null && error.message !== '') return error.message
  return RESERVATION_LIST_COPY.actionFailed
}

/** 从已加载条目里取一条**待使用**预约；非 PENDING 一律不动（防旧模板事件）。 */
function pendingItemOf(page: ReservationListInstance, id: number): Reservation | null {
  const item = runtimeOf(page).paged.items.find((candidate) => candidate.id === id)
  if (item === undefined || !isPendingReservation(item.status)) return null
  return item
}

/** 「开始使用」—— 二次确认 → `13.15` → 替换进等待页。 */
async function startUse(page: ReservationListInstance, id: number): Promise<void> {
  const runtime = runtimeOf(page)
  if (runtime.actionInFlight || pendingItemOf(page, id) === null) return

  const confirmed = await confirm({
    title: RESERVATION_LIST_COPY.startTitle,
    message: RESERVATION_LIST_COPY.startMessage,
    cancelText: RESERVATION_LIST_COPY.startDismiss,
    confirmText: RESERVATION_LIST_COPY.startConfirm,
  })
  if (!confirmed) return

  runtime.actionInFlight = true
  const result = await useReservation(id)
  runtime.actionInFlight = false

  if (!result.ok) {
    if (result.error.code === RESERVATION_STATE_REJECTED) {
      // 窗口外 / 状态已变：**动作点提示 + 刷新**，不猜分钟、不置灰。
      showToast(RESERVATION_LIST_COPY.windowRejected)
      await loadFirst(page, true)
      return
    }
    showToast(failureMessageOf(result.error))
    return
  }

  // 转单成功：同事务已生成开门指令。等待页只接收 orderId 与方向，
  // `13.15` 没有 `openTimeoutMinutes`（也不需要 —— 等待页不倒计时）。
  wx.redirectTo({
    url: `/${WAITING_PATH}?orderId=${result.data.orderId}&mode=drop`,
  })
}

/** 「取消预约」—— 二次确认 → `13.14` → 刷新（成功后释放格口，不扣分）。 */
async function cancel(page: ReservationListInstance, id: number): Promise<void> {
  const runtime = runtimeOf(page)
  if (runtime.actionInFlight || pendingItemOf(page, id) === null) return

  const confirmed = await confirm({
    title: RESERVATION_LIST_COPY.cancelTitle,
    message: RESERVATION_LIST_COPY.cancelMessage,
    cancelText: RESERVATION_LIST_COPY.cancelDismiss,
    confirmText: RESERVATION_LIST_COPY.cancelConfirm,
  })
  if (!confirmed) return

  runtime.actionInFlight = true
  const result = await cancelReservation(id)
  runtime.actionInFlight = false

  if (!result.ok) {
    // 失败也要刷新：状态可能已被定时任务 / 柜机故障改掉，本地旧行不能再当真相。
    showToast(failureMessageOf(result.error))
  }
  await loadFirst(page, true)
}

/** 「查看订单」—— `USED` 行带 `orderId` 时才有这个入口。 */
function viewOrder(orderId: number): void {
  wx.navigateTo({ url: `/${ORDER_DETAIL_PATH}?id=${orderId}` })
}

/**
 * 空态出口「扫码存件」—— 与首页同一条链路：扫码 → 解析柜机码 → 柜机页。
 *
 * ⚠️ 预约空态**不能**给「新建预约」入口：创建预约的唯一入口在柜机页
 * （`lockerId` 的唯一来源是 `13.6`）。
 */
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

/** 从事件 dataset 里取正整数 id —— 模板事件不可信，非法值直接忽略。 */
function idOf(event: { currentTarget: { dataset: Record<string, unknown> } }): number | null {
  const raw = event.currentTarget.dataset['id']
  const id = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(id) || id <= 0) return null
  return id
}

interface ReservationListMethods {
  [name: string]: (...args: never[]) => unknown
  onShow(): void
  onReachBottom(): void
  onRetry(): void
  onStartUse(event: { currentTarget: { dataset: Record<string, unknown> } }): void
  onCancel(event: { currentTarget: { dataset: Record<string, unknown> } }): void
  onViewOrder(event: { currentTarget: { dataset: Record<string, unknown> } }): void
  onScan(): void
}

Component<
  ReservationListData,
  Record<string, never>,
  ReservationListMethods,
  Record<string, never>,
  true
>({
  data: {
    title: PAGE_TITLES['pages/reservation-list/reservation-list'],
    phase: 'loading' as ReservationListPhase,
    groups: [],
    isEmpty: false,
    loadFailed: RESERVATION_LIST_COPY.loadFailed,
    retryLabel: RESERVATION_LIST_COPY.retry,
    emptyTitle: EMPTY_STATES.reservations.title,
    emptyHint: EMPTY_STATES.reservations.hint,
    emptyActionLabel: EMPTY_STATES.reservations.actionLabel,
    startActionLabel: RESERVATION_LIST_COPY.startAction,
    cancelActionLabel: RESERVATION_LIST_COPY.cancelAction,
    viewOrderLabel: RESERVATION_LIST_COPY.viewOrderAction,
  } as ReservationListData,

  lifetimes: {
    attached(): void {
      // 有意为空 —— 页面没有需要订阅的外部状态。
    },
  },

  methods: {
    /** 每次回到前台静默刷新并重置回第一页（不保留陈旧后续页）。 */
    onShow(): void {
      const page = this as unknown as ReservationListInstance
      const runtime = runtimeOf(page)
      if (runtime.loading) return
      void loadFirst(page, true)
    },

    /** 触底加载下一页（终止条件由 `utils/pagination.ts` 唯一决定）。 */
    onReachBottom(): void {
      const page = this as unknown as ReservationListInstance
      void loadMore(page)
    },

    /** 页内「重试」—— 首屏失败后的唯一动作。 */
    onRetry(): void {
      const page = this as unknown as ReservationListInstance
      if (page.data.phase !== 'failed') return
      void loadFirst(page)
    },

    onStartUse(event: { currentTarget: { dataset: Record<string, unknown> } }): void {
      const page = this as unknown as ReservationListInstance
      const id = idOf(event)
      if (id === null) return
      void startUse(page, id)
    },

    onCancel(event: { currentTarget: { dataset: Record<string, unknown> } }): void {
      const page = this as unknown as ReservationListInstance
      const id = idOf(event)
      if (id === null) return
      void cancel(page, id)
    },

    onViewOrder(event: { currentTarget: { dataset: Record<string, unknown> } }): void {
      const id = idOf(event)
      if (id === null) return
      viewOrder(id)
    },

    onScan(): void {
      scanEntry()
    },
  },
})
