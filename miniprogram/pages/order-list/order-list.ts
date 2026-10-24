// **订单列表页** —— 订单的家：进行中置顶、已结束在下（spec #57 §6）。
//
// ## 两条数据流（零后端改动）
//
// 1. **进行中**：`GET /orders?status=2&pageSize=20` + `GET /orders?status=4&pageSize=20`
//    各取一页 → 丢掉 `status=4 && endAt != null` → 合并、按 `id` 去重、按
//    「已超时 → 待存入 → 已存入」+ 同档 `id` 倒序排序。任一查询 `total > 20`
//    时底部出现「还有更多进行中订单」，点击翻有更多的那些状态的下一页。
// 2. **已结束**：`GET /orders?pageSize=10&page=N`（不带 `status`）→ 只留终局单、
//    丢掉已出现在进行中的 `id` → 渲染。第一页若因重叠凑不够 10 条，会继续翻页；
//    触底加载同样连续跳过，直到凑够 10 条或服务端已无更多。
//
// ⚠️ **`total` 不是用户可见数量**：两条流都不显示条数；`total` 只用来判断
// 「还能不能翻页」。
//
// ## 五类状态互不混淆
//
//   • 首屏 `loading`：列表形状骨架；
//   • 首屏失败：页内「订单加载失败 / 重试」，**不是**整页失败出口；
//   • 下拉刷新失败：toast 一句，**保留旧数据**；
//   • 加载更多失败：列表底部「加载失败，点击重试」，**保留已加载项**；
//   • 两组都空：`EMPTY_STATES.orders` 空态，主行动跑与首页相同的扫码链路。
//
// ## 卡片接线
//
// 整卡 → 订单详情（`navigateTo`）；待存入 → 等待页（`navigateTo`，`mode=drop`）；
// 已存入 / 已超时 → 打开共享 `pickup-sheet`。本页**不画支付界面**、不调 `13.11`；
// 取件成功后由本页 `navigateTo` 等待页（列表是 tab 页，`redirectTo` 会把它拆掉）。
//
// ⚠️ 列表非空时**没有**常驻扫码入口：空态自带，非空时用户回首页 tab（spec §6）。
// ⚠️ 不缓存业务数据：每次 `onShow` / 下拉刷新都重置两条流，从 `api/` 重新取。

import { getOrders } from '../../api/orders'
import { EMPTY_STATES, ORDER_LIST_COPY, PAGE_TITLES } from '../../startup/copy'
import { showToast } from '../../utils/feedback'
import { mergeActiveOrders } from '../../utils/order-active'
import { cardOrderOf } from '../../utils/order-card'
import { isEndedOrder, resolveOrderStatus } from '../../utils/order-status'
import { ORDER_DETAIL_PATH, WAITING_PATH } from '../../utils/routes'
import { scanToLocker } from '../../utils/scan-locker'
import type { PageOf } from '../../utils/pagination'
import type { OrderCardOrder, OrderSummary, PickupOrder } from '../../types/orders'

/** 进行中两条查询的页大小 —— 契约要求的固定值。 */
const ACTIVE_PAGE_SIZE = 20

/** 历史流的页大小 —— 契约要求的固定值。 */
const HISTORY_PAGE_SIZE = 10

/** 历史流一次最多补齐的条数 —— 「凑够 10 条」的 10。 */
const HISTORY_FILL = 10

/** 页面态 —— 首屏骨架 / 正常 / 页内失败。 */
type ListPhase = 'loading' | 'ready' | 'loadFailed'

/** 一次读取是首屏、静默刷新、下拉刷新，还是失败后的页内重试。 */
type LoadSource = 'initial' | 'refresh' | 'pull' | 'retry'

/** 一条进行中状态流 —— 页码是**已请求到第几页**，不是条数推算出来的。 */
interface ActiveStream {
  items: OrderSummary[]
  total: number
  page: number
}

/** 历史流 —— 同样显式记住页码（末页不满是常态）。 */
interface HistoryStream {
  items: OrderSummary[]
  total: number
  page: number
}

interface OrderListRuntime {
  /** 真实运行时 `onShow` 在首次进入后立刻触发；用它区分首屏与静默刷新。 */
  started: boolean
  active2: ActiveStream
  active4: ActiveStream
  history: HistoryStream
  /** 刷新是否在飞 —— 挡住 onShow / 下拉刷新的重入。 */
  inFlight: boolean
  /** 加载更多是否在飞 —— 与刷新分开，触底与底部按钮共用一个门。 */
  loadingMore: boolean
  /** 最近一次加载更多失败的是哪条流 —— 底部重试据此选目标。 */
  lastLoadMore: 'active' | 'history' | null
  /** 加载更多失败是否仍在屏上（成功一次即清掉）。 */
  loadMoreFailed: boolean
}

interface OrderListPageData {
  title: string
  phase: ListPhase

  /** 两组卡片 —— 页面只传卡片需要的子集（不含 orderNo）。 */
  activeOrders: OrderCardOrder[]
  historyOrders: OrderCardOrder[]

  /** 组标题只在组非空时出现；两组都空才整页空态。 */
  showActiveGroup: boolean
  showHistoryGroup: boolean
  isEmpty: boolean
  activeGroupTitle: string
  historyGroupTitle: string

  /** 空态文案与主行动。 */
  emptyTitle: string
  emptyHint: string
  emptyActionLabel: string
  showEmptyAction: boolean

  /** 进行中流「还有更多」入口。 */
  showMoreActive: boolean
  moreActiveLabel: string

  /** 加载更多失败。 */
  showLoadMoreFailed: boolean
  loadMoreFailedLabel: string

  /** 首屏失败。 */
  loadFailedTitle: string
  retryLabel: string

  /** 取件层 —— 有值即打开；宿主只负责装配订单视图。 */
  pickupOrder: PickupOrder | null
}

interface OrderListPageInstance {
  data: OrderListPageData
  setData(patch: Partial<OrderListPageData>): void
}

/** 页面实例 → 运行时。WeakMap 不缓存业务数据，只挂两条流与飞行态。 */
const runtimes = new WeakMap<OrderListPageInstance, OrderListRuntime>()

function runtimeOf(page: OrderListPageInstance): OrderListRuntime {
  let runtime = runtimes.get(page)
  if (runtime === undefined) {
    runtime = {
      started: false,
      active2: { items: [], total: 0, page: 0 },
      active4: { items: [], total: 0, page: 0 },
      history: { items: [], total: 0, page: 0 },
      inFlight: false,
      loadingMore: false,
      lastLoadMore: null,
      loadMoreFailed: false,
    }
    runtimes.set(page, runtime)
  }
  return runtime
}

/**
 * 终局判定 —— 与首页进行中组是同一件事的两面。
 *
 * ⚠️ 实现**不在这里**：`isEndedOrder` 就是 `isActiveOrder` 的补集，唯一家在
 * `utils/order-status.ts`。本页只消费它，不再抄一遍 `3 / 5 / 6 / 7 /（4 且 endAt 有值）`。
 */

/** 同一组内按 `id` 去重，保留首个。 */
function dedupe(orders: readonly OrderSummary[]): OrderSummary[] {
  const byId = new Map<number, OrderSummary>()
  for (const order of orders) {
    if (!byId.has(order.id)) byId.set(order.id, order)
  }
  return [...byId.values()]
}

/**
 * 合并两条进行中流 —— 过滤、去重、排序；同档按 id 倒序。
 *
 * ⚠️ **判定与排序不在本页**：首页进行中区用的是同一段 `mergeActiveOrders()`
 * （`utils/order-active.ts`）。两处各写一遍的后果是同一张单在两个页面上分组不同。
 */
function mergedActive(runtime: OrderListRuntime): OrderSummary[] {
  return mergeActiveOrders(runtime.active2.items, runtime.active4.items)
}

/** 服务端的一页 → 某条进行中流的一页（过滤掉不属于该流的状态）。 */
function activeStreamOf(page: PageOf<OrderSummary>, status: 2 | 4): ActiveStream {
  const items = page.records.filter((order) =>
    status === 2
      ? // `status=1` 一期不产生；若服务端意外回显，按进行中兜底（spec §6）。
        order.status === 1 || order.status === 2
      : order.status === 4 && order.endAt === null,
  )
  return { items: dedupe(items), total: page.total, page: 1 }
}

/** 取件层入参 —— 列表行天然满足 `PickupOrder`，只做子集裁剪（不含取件码）。 */
function pickupOrderOf(order: OrderCardOrder): PickupOrder {
  return {
    id: order.id,
    status: order.status,
    startAt: order.startAt,
    endAt: order.endAt,
    payAmount: order.payAmount,
    estimatedAmount: order.estimatedAmount,
    siteName: order.siteName,
    lockerNo: order.lockerNo,
    cellNo: order.cellNo,
  }
}

/**
 * 把两条流画到界面上。
 *
 * ⚠️ 组标题与空态都由**渲染后的条数**决定，不看 `total`：
 * 一条进行中单被过滤后，`total` 仍可能大于 0 —— 拿它画标题会画出空组。
 */
function render(page: OrderListPageInstance, runtime: OrderListRuntime): void {
  const activeOrders = mergedActive(runtime).map(cardOrderOf)
  // 历史组按 id 倒序 —— 服务端契约如此，但组内排序是本页的职责，不能靠响应顺序。
  const historyOrders = [...runtime.history.items]
    .sort((left, right) => right.id - left.id)
    .map(cardOrderOf)
  const isEmpty = activeOrders.length === 0 && historyOrders.length === 0
  const activeHasMore =
    runtime.active2.page * ACTIVE_PAGE_SIZE < runtime.active2.total ||
    runtime.active4.page * ACTIVE_PAGE_SIZE < runtime.active4.total

  page.setData({
    phase: 'ready',
    activeOrders,
    historyOrders,
    showActiveGroup: activeOrders.length > 0,
    showHistoryGroup: historyOrders.length > 0,
    isEmpty,
    showEmptyAction: isEmpty,
    showMoreActive: activeHasMore && !runtime.loadMoreFailed,
    showLoadMoreFailed: runtime.loadMoreFailed,
  })
}

/** 页内失败 —— 首屏 / 重试走整块重试，下拉刷新只 toast，静默刷新什么都不说。 */
function handleLoadFailure(page: OrderListPageInstance, source: LoadSource): void {
  if (source === 'initial' || source === 'retry') {
    page.setData({
      phase: 'loadFailed',
      loadFailedTitle: ORDER_LIST_COPY.loadFailed,
      retryLabel: ORDER_LIST_COPY.retry,
    })
    return
  }
  if (source === 'pull') showToast(ORDER_LIST_COPY.refreshFailed)
}

/**
 * 历史流的一批 —— 从 `startPage` 起连续翻页，直到凑够 `minimum` 条新记录
 * 或服务端已无更多。
 *
 * ⚠️ **跳过的是「已出现过」的 id**（进行中 + 本批之前已收的历史），
 * 并按 `page * pageSize >= total` 终止 —— 服务端分页越界会钳制到末页，
 * 「按空数组判断」会无限重复末页（`utils/pagination.ts` 的既有裁决）。
 */
async function fetchHistoryBatch(
  shownIds: Set<number>,
  startPage: number,
  minimum: number,
): Promise<{ ok: true; items: OrderSummary[]; total: number; page: number } | { ok: false }> {
  const items: OrderSummary[] = []
  let total = 0
  let page = startPage

  for (;;) {
    const result = await getOrders({ pageSize: HISTORY_PAGE_SIZE, page })
    if (!result.ok) return { ok: false }

    total = result.data.total
    for (const order of result.data.records) {
      if (!isEndedOrder(order)) continue
      if (shownIds.has(order.id)) continue
      shownIds.add(order.id)
      items.push(order)
    }
    page += 1

    if (items.length >= minimum) break
    if ((page - 1) * HISTORY_PAGE_SIZE >= total) break
  }

  return { ok: true, items, total, page: page - 1 }
}

/**
 * 重置并重取两条流。
 *
 * ⚠️ **事务式替换**：新数据全部拿到之前不动运行时与界面 —— 刷新失败时
 * 用户看到的仍是上一份成功数据（spec §6「刷新失败保留旧数据」）。
 */
async function refreshAll(page: OrderListPageInstance, source: LoadSource): Promise<void> {
  const runtime = runtimeOf(page)
  if (runtime.inFlight) return
  runtime.inFlight = true

  if (source === 'initial' || source === 'retry') page.setData({ phase: 'loading' })

  const [status2, status4] = await Promise.all([
    getOrders({ status: 2, pageSize: ACTIVE_PAGE_SIZE }),
    getOrders({ status: 4, pageSize: ACTIVE_PAGE_SIZE }),
  ])

  if (!status2.ok || !status4.ok) {
    runtime.inFlight = false
    handleLoadFailure(page, source)
    return
  }

  const active2 = activeStreamOf(status2.data, 2)
  const active4 = activeStreamOf(status4.data, 4)
  const shownIds = new Set<number>([...active2.items, ...active4.items].map((order) => order.id))
  const history = await fetchHistoryBatch(shownIds, 1, HISTORY_FILL)
  runtime.inFlight = false
  if (!history.ok) {
    handleLoadFailure(page, source)
    return
  }

  runtime.active2 = active2
  runtime.active4 = active4
  runtime.history = { items: history.items, total: history.total, page: history.page }
  runtime.lastLoadMore = null
  runtime.loadMoreFailed = false
  render(page, runtime)
}

/** 进行中流还有下一页的状态 —— 逐个状态翻，不把两条流的页码混在一起。 */
function activeStreamsWithMore(runtime: OrderListRuntime): Array<{ stream: ActiveStream; status: 2 | 4 }> {
  const result: Array<{ stream: ActiveStream; status: 2 | 4 }> = []
  if (runtime.active2.page * ACTIVE_PAGE_SIZE < runtime.active2.total) {
    result.push({ stream: runtime.active2, status: 2 })
  }
  if (runtime.active4.page * ACTIVE_PAGE_SIZE < runtime.active4.total) {
    result.push({ stream: runtime.active4, status: 4 })
  }
  return result
}

/** 加载更多 —— 进行中按「有更多的那些状态」各翻一页；历史连续补齐。 */
async function loadMore(page: OrderListPageInstance, target: 'active' | 'history'): Promise<void> {
  const runtime = runtimeOf(page)
  if (runtime.inFlight || runtime.loadingMore) return
  runtime.loadingMore = true
  runtime.lastLoadMore = target
  runtime.loadMoreFailed = false
  page.setData({ showLoadMoreFailed: false })

  if (target === 'active') {
    const targets = activeStreamsWithMore(runtime)
    if (targets.length === 0) {
      runtime.loadingMore = false
      render(page, runtime)
      return
    }

    const results = await Promise.all(
      targets.map(async (item) => ({
        status: item.status,
        result: await getOrders({
          status: item.status,
          pageSize: ACTIVE_PAGE_SIZE,
          page: item.stream.page + 1,
        }),
      })),
    )

    if (results.some((item) => !item.result.ok)) {
      runtime.loadingMore = false
      runtime.loadMoreFailed = true
      render(page, runtime)
      return
    }

    for (const item of results) {
      if (!item.result.ok) continue
      const next = activeStreamOf(item.result.data, item.status)
      const current = item.status === 2 ? runtime.active2 : runtime.active4
      current.items = dedupe([...current.items, ...next.items])
      current.total = next.total
      current.page += 1
    }
    runtime.loadingMore = false
    render(page, runtime)
    return
  }

  const shownIds = new Set<number>(
    [...mergedActive(runtime), ...runtime.history.items].map((order) => order.id),
  )
  const batch = await fetchHistoryBatch(shownIds, runtime.history.page + 1, HISTORY_FILL)
  if (!batch.ok) {
    runtime.loadingMore = false
    runtime.loadMoreFailed = true
    render(page, runtime)
    return
  }

  runtime.history.items = dedupe([...runtime.history.items, ...batch.items])
  runtime.history.total = batch.total
  runtime.history.page = batch.page
  runtime.loadingMore = false
  render(page, runtime)
}

/** 卡片主行动 —— 待存入去等待页，已存入 / 已超时打开共享取件层。 */
function onCardAction(page: OrderListPageInstance, event: { detail?: { id?: number } }): void {
  const id = event.detail?.id
  if (typeof id !== 'number') return
  const order = [...page.data.activeOrders, ...page.data.historyOrders].find((item) => item.id === id)
  if (order === undefined) return

  const status = resolveOrderStatus(order.status, order.startAt, order.endAt)
  if (status.key === 'waitingDrop') {
    wx.navigateTo({ url: `/${WAITING_PATH}?orderId=${order.id}&mode=drop` })
    return
  }
  if (status.key === 'stored' || status.key === 'timeout') {
    page.setData({ pickupOrder: pickupOrderOf(order) })
  }
}

/** 空态主行动 —— 与首页完全相同的扫码链路。 */
function scanEntry(): void {
  scanToLocker('navigate')
}

interface OrderListPageMethods {
  [name: string]: (...args: never[]) => unknown
  onShow(): void
  onPullDownRefresh(): void
  onReachBottom(): void
  onRetry(): void
  onMoreActive(): void
  onLoadMoreRetry(): void
  onEmptyAction(): void
  onCardTap(event: { detail?: { id?: number } }): void
  onCardAction(event: { detail?: { id?: number } }): void
  onPickupSuccess(event: { detail?: { orderId?: number | null } }): void
  onPickupDismiss(): void
  onPickupRefresh(event: { detail?: { missing?: boolean } }): void
}

Component<OrderListPageData, Record<string, never>, OrderListPageMethods, [], Record<string, never>, true>({
  data: {
    title: PAGE_TITLES['pages/order-list/order-list'],
    phase: 'loading',

    activeOrders: [],
    historyOrders: [],
    showActiveGroup: false,
    showHistoryGroup: false,
    isEmpty: false,
    activeGroupTitle: ORDER_LIST_COPY.activeGroup,
    historyGroupTitle: ORDER_LIST_COPY.historyGroup,

    emptyTitle: EMPTY_STATES.orders.title,
    emptyHint: EMPTY_STATES.orders.hint,
    emptyActionLabel: EMPTY_STATES.orders.actionLabel,
    showEmptyAction: false,

    showMoreActive: false,
    moreActiveLabel: ORDER_LIST_COPY.moreActive,

    showLoadMoreFailed: false,
    loadMoreFailedLabel: ORDER_LIST_COPY.loadMoreFailed,

    loadFailedTitle: ORDER_LIST_COPY.loadFailed,
    retryLabel: ORDER_LIST_COPY.retry,

    pickupOrder: null,
  } as OrderListPageData,

  methods: {
    /**
     * 首屏首查 + 之后每次回前台静默刷新。
     *
     * ⚠️ 首查放在 `onShow`：真实运行时 `onLoad` 后紧跟 `onShow`，之后从详情 /
     * 等待页 / 取件层返回时也走这里 —— 这是「看到最新状态」的唯一时机。
     */
    onShow(): void {
      const page = this as unknown as OrderListPageInstance
      const runtime = runtimeOf(page)
      const source: LoadSource = runtime.started ? 'refresh' : 'initial'
      runtime.started = true
      void refreshAll(page, source)
    },

    /** 下拉刷新 —— 与 onShow 一样重置两条流；失败只 toast，旧数据保留。 */
    onPullDownRefresh(): void {
      const page = this as unknown as OrderListPageInstance
      void refreshAll(page, 'pull').finally(() => {
        wx.stopPullDownRefresh()
      })
    },

    /** 触底只翻历史流（spec §6）；进行中有独立的「还有更多」入口。 */
    onReachBottom(): void {
      const page = this as unknown as OrderListPageInstance
      const runtime = runtimeOf(page)
      if (page.data.phase !== 'ready' || runtime.inFlight || runtime.loadingMore) return
      if (runtime.history.page * HISTORY_PAGE_SIZE >= runtime.history.total) return
      void loadMore(page, 'history')
    },

    /** 首屏失败的页内重试。 */
    onRetry(): void {
      const page = this as unknown as OrderListPageInstance
      if (page.data.phase !== 'loadFailed') return
      void refreshAll(page, 'retry')
    },

    /** 「还有更多进行中订单」—— 翻有更多的状态下一页。 */
    onMoreActive(): void {
      const page = this as unknown as OrderListPageInstance
      if (page.data.phase !== 'ready') return
      void loadMore(page, 'active')
    },

    /** 加载更多失败后的重试 —— 按上次失败的那条流继续。 */
    onLoadMoreRetry(): void {
      const page = this as unknown as OrderListPageInstance
      const runtime = runtimeOf(page)
      if (!runtime.loadMoreFailed || runtime.lastLoadMore === null) return
      void loadMore(page, runtime.lastLoadMore)
    },

    /** 空态主行动 —— 扫码存件。 */
    onEmptyAction(): void {
      if (!(this as unknown as OrderListPageInstance).data.isEmpty) return
      scanEntry()
    },

    /** 整卡点击 → 订单详情（navigateTo，带 id）。 */
    onCardTap(event: { detail?: { id?: number } }): void {
      const id = event.detail?.id
      if (typeof id !== 'number') return
      wx.navigateTo({ url: `/${ORDER_DETAIL_PATH}?id=${id}` })
    },

    /** 卡内主行动 —— 待存入 → 等待页；已存入 / 已超时 → 共享取件层。 */
    onCardAction(event: { detail?: { id?: number } }): void {
      onCardAction(this as unknown as OrderListPageInstance, event)
    },

    /** 取件成功 —— 列表是 tab 页，只能 `navigateTo` 等待页。 */
    onPickupSuccess(event: { detail?: { orderId?: number | null } }): void {
      const page = this as unknown as OrderListPageInstance
      const fallback = page.data.pickupOrder?.id
      const orderId = event.detail?.orderId ?? fallback
      page.setData({ pickupOrder: null })
      if (typeof orderId !== 'number') return
      wx.navigateTo({ url: `/${WAITING_PATH}?orderId=${orderId}&mode=pickup` })
    },

    /** 用户关掉空闲 / 失败态弹层 —— 只收起。 */
    onPickupDismiss(): void {
      ;(this as unknown as OrderListPageInstance).setData({ pickupOrder: null })
    },

    /**
     * 取件层要求来源页刷新。
     *
     * 列表本身就是订单的家：`missing`（3001 / 8003）也只需收起并重取 ——
     * 组件已把「订单不存在或已删除」告诉用户，这里不做第二次跳转。
     */
    onPickupRefresh(): void {
      const page = this as unknown as OrderListPageInstance
      page.setData({ pickupOrder: null })
      void refreshAll(page, 'refresh')
    },
  },
})
