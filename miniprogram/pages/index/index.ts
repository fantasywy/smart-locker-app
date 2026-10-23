// 首页 —— **启动闸门的承载页 + 唯一主行动（扫码存件）+ 进行中订单区**。
//
// ## 本页的三件事
//
// 1. **闸门**：登录链跑完之前画首页同构骨架；登录失败落全局失败出口；成功后进首页。
//    闸门的形态是 #20 的交付物，本票（#61 / #67）**不改它的行为**。
// 2. **扫码主行动**：`wx.scanCode` → `resolveLockerCode()` → 柜机页。
//    四种结果各走各的路（spec §2）：
//       • 解析出柜机码 → `navigateTo` 柜机页，带 `code`；
//       • 非柜机码     → 留在首页，一句提示，可立刻重扫；
//       • 用户取消     → 静默；
//       • 其他失败     → 一句「扫码没成功，请重试」，不按成因分叉。
// 3. **进行中订单区**（#67）：两条流 `status=2` / `status=4`（各 `pageSize=100`）取数，
//    过滤后合并去重，按「已超时 → 待存入 → 已存入」+ id 倒序排序；前两张上卡，
//    `N > 2` 时给「查看全部 N 个」切到订单 tab。
//
// ## 四条纪律
//
// 1. **页面不持有登录态**：登录态只在请求层与闸门内部，页面只读 `phase`。
// 2. **不做本地业务数据缓存**：页面没有任何 `storage` 读写；每次 `onShow` 都重新取数。
// 3. **失败态不在页面数据区里再写一份**：登录失败落到 `components/failure-exit/`；
//    订单区自己的失败是**页内重试块**，不把扫码按钮拖下水。
// 4. **订单区与订单列表同一口径**：候选集合与排序只来自 `utils/order-active.ts`，
//    不在本页另写一遍 `status` / `endAt` 判断。
//
// ## 本票刻意不做的事
//
// - **不做相机权限探测 / 引导**（spec §2 末段）：`wx.scanCode` 不写 `authSetting`，
//   `wx.getSetting()` 无法区分「未请求」与「被拒绝」，任何「请开启相机权限」都是假归因。
// - **附近入口只指路**：它已随 #72 与附近 tab 同一次发版露出；入口条不带距离 / 余位 /
//   任何动态数据，点击只 `switchTab`。
// - **不写页面路径字面量**：柜机页 / 详情页 / 订单 tab / 附近 tab 的路径都来自
//   `utils/routes.ts` 与 `startup/copy.ts`。`wx.*To` 拿到不存在的路径是**静默失败**。
//
// ⚠️ 用的是 `Component()` 而不是 `Page()` —— 全端页面都按这一形态落地，
// 且 `Component` 的 `lifetimes` 让「订阅在 `attached`、退订在 `detached`」这件事
// 有明确的挂载点。

import { getOrders } from '../../api/orders'
import { createStartupGate } from '../../startup/gate'
import type { StartupGate, StartupState } from '../../startup/gate'
import { HOME_PAGE_COPY, NEARBY_PATH, ORDER_LIST_PATH } from '../../startup/copy'
import { showToast } from '../../utils/feedback'
import { mergeActiveOrders } from '../../utils/order-active'
import { cardOrderOf } from '../../utils/order-card'
import { ORDER_DETAIL_PATH, STATIC_EXIT_PATHS } from '../../utils/routes'
import { scanToLocker } from '../../utils/scan-locker'
import type { OrderCardOrder, OrderSummary } from '../../types/orders'

/**
 * 闸门实例 —— **模块级的单例**，不是 `data` 里的一员。
 *
 * ⚠️ 为什么放模块级而不是 `this.data`：闸门持有登录链的飞行态（`inFlight`），
 * 而页面会被重建（`detached` → 再次进入）。把它塞进 `data` 会随页面一起被丢掉，
 * 于是「冷启动登录链还在飞、页面被重建」时**会又起一条链** —— 而这正是
 * 单一飞行要防的那类重复。
 *
 * ⚠️ 它**不等于引入 store**（这条禁令针对的是业务状态的集中存放）。闸门里只有
 * 「登录到哪一步了」这一个变量，**没有任何业务数据** —— 页面依然从 `api/` 拿数据。
 */
let gate: StartupGate | null = null

/** 进行中两条查询的页大小 —— spec §2 的上限值（超过 100 的极端情况不做）。 */
const ACTIVE_PAGE_SIZE = 100

/** 首页订单区最多渲染几张卡；超过这个数才出现「查看全部」。 */
const HOME_ORDER_LIMIT = 2

/** 订单区自己的状态 —— 与启动闸门的 `phase` 相互独立。 */
type OrdersPhase = 'loading' | 'ready' | 'loadFailed'

/** 一次订单读取是首屏 / 回前台静默刷新 / 下拉刷新 / 失败后的页内重试。 */
type OrdersSource = 'initial' | 'refresh' | 'pull' | 'retry'

/**
 * 当前订阅的退订函数 —— 页面 `detached` 时用它，避免监听器泄漏。
 *
 * ⚠️ **它挂在页面实例上，不是模块级变量**：模块级时两个实例会争同一个槽位，
 * 第二个 `attached` 覆盖第一个的退订句柄，真正的泄漏反而被掩盖。
 */
interface IndexPageData {
  phase: StartupState['phase']
  wordmark: string
  tagline: string
  scanLabel: string

  /** 进行中订单区 —— 组标题、状态与卡片。 */
  ordersTitle: string
  ordersPhase: OrdersPhase
  /** 全部进行中单（合并排序后的完整集合）—— N 就是它的长度。 */
  activeOrders: OrderCardOrder[]
  /** 首页实际渲染的前两张卡。 */
  homeOrders: OrderCardOrder[]
  orderCount: number
  showOrders: boolean
  showOrdersTitle: boolean
  showViewAll: boolean
  viewAllLabel: string
  ordersLoadFailedTitle: string
  ordersRetryLabel: string

  /** 附近入口条的唯一一句文案 —— 无距离 / 余位等动态数据。 */
  nearbyLabel: string
}

interface IndexPageInstance {
  /** 本实例的退订函数 —— `attached` 里写入，`detached` 里消费。 */
  unsubscribeFromGate?: (() => void) | null
  data: IndexPageData
  setData(patch: Partial<IndexPageData>): void
}

/** 页面实例 → 订单区的运行时（不缓存业务数据，只挂「是否已经展示过」与飞行态）。 */
interface OrdersRuntime {
  /** `onShow` 是否已经发生过 —— 首查由可见生命周期触发。 */
  shown: boolean
  /** 首查是否已经起过 —— 决定下一次 `onShow` 是 initial 还是 refresh。 */
  started: boolean
  /** 是否有读取在飞 —— 挡住 `onShow` / 下拉刷新 / 重试的重入。 */
  inFlight: boolean
}

const runtimes = new WeakMap<IndexPageInstance, OrdersRuntime>()

function runtimeOf(page: IndexPageInstance): OrdersRuntime {
  let runtime = runtimes.get(page)
  if (runtime === undefined) {
    runtime = { shown: false, started: false, inFlight: false }
    runtimes.set(page, runtime)
  }
  return runtime
}

/** 把过滤后的条数填进「查看全部」模板 —— N 不是两次查询 `total` 的合计。 */
function viewAllLabelOf(count: number): string {
  return HOME_PAGE_COPY.viewAll.replace('{count}', () => String(count))
}

/**
 * 把合并后的进行中单画到界面上。
 *
 * ⚠️ **`N = 0` 时整区（含标题）不渲染**：`showOrders` / `showOrdersTitle` 同时为 false。
 * `N > 2` 时只把前两张交给 `order-card`，`orderCount` 仍是真实过滤后条数。
 */
function renderOrders(page: IndexPageInstance, orders: readonly OrderSummary[]): void {
  const cards = orders.map(cardOrderOf)
  const count = orders.length
  page.setData({
    ordersPhase: 'ready',
    activeOrders: cards,
    homeOrders: cards.slice(0, HOME_ORDER_LIMIT),
    orderCount: count,
    showOrders: count > 0,
    showOrdersTitle: count > 0,
    showViewAll: count > HOME_ORDER_LIMIT,
    viewAllLabel: count > HOME_ORDER_LIMIT ? viewAllLabelOf(count) : '',
  })
}

/** 首屏 / 重试的订单区骨架 —— 一张卡骨架，标题等 N 确定后再出现。 */
function showOrdersSkeleton(page: IndexPageInstance): void {
  page.setData({
    ordersPhase: 'loading',
    activeOrders: [],
    homeOrders: [],
    orderCount: 0,
    showOrders: true,
    showOrdersTitle: false,
    showViewAll: false,
    viewAllLabel: '',
  })
}

/**
 * 订单区失败归因 —— 三类失败互不混淆：
 *   • 首屏 / 重试 → 页内「订单加载失败 / 重试」；
 *   • 下拉刷新   → toast「刷新失败，请稍后重试」，保留旧卡；
 *   • onShow     → 静默，保留旧卡（用户回到前台不应被一条历史失败打断）。
 */
function handleOrdersFailure(page: IndexPageInstance, source: OrdersSource): void {
  if (source === 'initial' || source === 'retry') {
    page.setData({
      ordersPhase: 'loadFailed',
      activeOrders: [],
      homeOrders: [],
      orderCount: 0,
      showOrders: true,
      showOrdersTitle: false,
      showViewAll: false,
      viewAllLabel: '',
      ordersLoadFailedTitle: HOME_PAGE_COPY.ordersLoadFailed,
      ordersRetryLabel: HOME_PAGE_COPY.ordersRetry,
    })
    return
  }
  if (source === 'pull') showToast(HOME_PAGE_COPY.refreshFailed)
}

/**
 * 取两条进行中流并合并。
 *
 * ⚠️ **事务式替换**：两条流都成功之前不动界面 —— 刷新失败时用户看到的仍是上一份
 * 成功数据。`Promise.all` 并行的原因：两条流互不依赖，串行只会让首屏多等一个往返。
 */
async function loadOrders(page: IndexPageInstance, source: OrdersSource): Promise<void> {
  const runtime = runtimeOf(page)
  if (runtime.inFlight) return
  runtime.inFlight = true
  runtime.started = true
  if (source === 'initial' || source === 'retry') showOrdersSkeleton(page)

  const [status2, status4] = await Promise.all([
    getOrders({ status: 2, pageSize: ACTIVE_PAGE_SIZE }),
    getOrders({ status: 4, pageSize: ACTIVE_PAGE_SIZE }),
  ])
  runtime.inFlight = false

  if (!status2.ok || !status4.ok) {
    handleOrdersFailure(page, source)
    return
  }

  renderOrders(page, mergeActiveOrders(status2.data.records, status4.data.records))
}

Component({
  data: {
    /**
     * 闸门状态 —— wxml 用它决定画骨架屏、首页、还是失败出口。
     *
     * ⚠️ 与 `StartupState` 的判别键同名（`phase`），这样 `wx:if="{{phase === 'ready'}}"`
     * 与 TS 里的 `state.phase === 'ready'` 读起来是同一件事。
     */
    phase: 'loading' as StartupState['phase'],

    /**
     * 品牌区与扫码按钮的文案 —— 唯一的家是 `startup/copy.ts` 的 `HOME_PAGE_COPY`。
     *
     * ⚠️ **导航栏标题不在这里**：spec §2 要求首页标题留空（只留胶囊），
     * 但 `PAGE_TITLES['pages/index/index']` 仍登记「首页」，供文案守卫与分享等
     * 非渲染场景使用。把 `PAGE_TITLES` 绑到 `title` 上会让导航栏多出一行字。
     */
    wordmark: HOME_PAGE_COPY.wordmark,
    tagline: HOME_PAGE_COPY.tagline,
    scanLabel: HOME_PAGE_COPY.scanButton,

    /**
     * 进行中订单区 —— 默认展示一张卡骨架（闸门 ready、订单未回）。
     * `N = 0` 时 `showOrders` 会变成 false，整区（含标题）消失。
     */
    ordersTitle: HOME_PAGE_COPY.ordersTitle,
    ordersPhase: 'loading' as OrdersPhase,
    activeOrders: [] as OrderCardOrder[],
    homeOrders: [] as OrderCardOrder[],
    orderCount: 0,
    showOrders: true,
    showOrdersTitle: false,
    showViewAll: false,
    viewAllLabel: '',
    ordersLoadFailedTitle: HOME_PAGE_COPY.ordersLoadFailed,
    ordersRetryLabel: HOME_PAGE_COPY.ordersRetry,

    /**
     * 附近入口条的唯一一句文案 —— 没有距离 / 余位 / 动态数据。
     * 点击只做 `switchTab`，目标来自 `NEARBY_PATH`（tab 路径写错是静默失败）。
     */
    nearbyLabel: HOME_PAGE_COPY.nearbyEntry,
  } as IndexPageData,

  lifetimes: {
    attached() {
      // 闸门是单例：页面重建时复用同一个（登录链的飞行态因此不会丢）。
      gate ??= createStartupGate()
      const current = gate
      const page = this as unknown as IndexPageInstance

      // ⚠️ **先读一次当前态画首帧，再订阅** —— 订阅不补发（见 `gate.ts` 的
      // `subscribe`），所以顺序反过来会漏掉「已经 ready 了」这种快速路径。
      // 真实差别在**页面重建**：那时闸门早已 `ready`、不会再有通知过来，
      // 不读这一下页面会永远停在骨架屏（`page.test.ts` 有对应用例）。
      this.applyState(current.state)

      // 同一实例重复挂载的兜底（异常路径）：先退掉旧的再订，否则会被通知两次。
      page.unsubscribeFromGate?.()
      page.unsubscribeFromGate = current.subscribe((state) => {
        this.applyState(state)
      })

      // 冷启动：跑登录链。⚠️ **不 await** —— 页面不等它，状态变化经订阅回来
      // （这正是闸门存在的意义）。⚠️ 闸门 `ready` 时 `start()` 是空操作，
      // 所以页面重建不会重跑登录链（见 `gate.ts` 的 `start`）。
      void current.start()
    },

    detached() {
      // ⚠️ 退订的是**本实例**的订阅（见 `IndexPageInstance` 的说明）。
      const page = this as unknown as IndexPageInstance
      page.unsubscribeFromGate?.()
      page.unsubscribeFromGate = null
    },
  },

  methods: {
    /**
     * 把闸门状态画到界面上，并在 ready 且页面已展示时起订单首查。
     *
     * ⚠️ 只取 `phase` 一个字段：`'failed'` 携带的 `UnifiedError` **不进界面**
     * （失败出口的文案是逐字定稿，不含错误码）。
     * 少搬一个字段，就少一条「把错误码画到屏幕上」的路。
     */
    applyState(state: StartupState): void {
      if (this.data.phase !== state.phase) this.setData({ phase: state.phase })
      if (state.phase !== 'ready') return

      const page = this as unknown as IndexPageInstance
      const runtime = runtimeOf(page)
      // `onShow` 先到、闸门后到：这里补起首查；已经起过就不重复。
      if (runtime.shown && !runtime.started) void loadOrders(page, 'initial')
    },

    /**
     * 回前台 / 首次展示 —— **每次 onShow 都重新取数**，没有本地业务缓存。
     *
     * ⚠️ 首查放在这里而不是 `attached`：真实运行时 `onShow` 紧跟 `attached`，
     * 它才是「用户看到这一屏」的时间点；页面重建时也是如此。
     */
    onShow(): void {
      const page = this as unknown as IndexPageInstance
      const runtime = runtimeOf(page)
      runtime.shown = true
      if (page.data.phase !== 'ready') return
      void loadOrders(page, runtime.started ? 'refresh' : 'initial')
    },

    /** 离开前台 —— 闸门 ready 的通知不再触发首查，等下一次 onShow。 */
    onHide(): void {
      runtimeOf(this as unknown as IndexPageInstance).shown = false
    },

    /**
     * 下拉刷新 —— 与 onShow 一样重置两条流；失败只 toast，旧卡保留。
     * 无论成功失败都要结束转圈。
     */
    onPullDownRefresh(): void {
      const page = this as unknown as IndexPageInstance
      if (page.data.phase !== 'ready') {
        wx.stopPullDownRefresh()
        return
      }
      void loadOrders(page, 'pull').finally(() => {
        wx.stopPullDownRefresh()
      })
    },

    /** 订单区首屏失败的页内重试 —— 只重取订单，不重跑启动链。 */
    onOrdersRetry(): void {
      const page = this as unknown as IndexPageInstance
      if (page.data.phase !== 'ready' || page.data.ordersPhase !== 'loadFailed') return
      void loadOrders(page, 'retry')
    },

    /** 整卡点击 → 订单详情（navigateTo，带 id）。 */
    onOrderTap(event: { detail?: { id?: number } }): void {
      const id = event.detail?.id
      if (typeof id !== 'number') return
      wx.navigateTo({ url: `/${ORDER_DETAIL_PATH}?id=${id}` })
    },

    /** 与订单列表同名的卡片事件入口 —— 两页的宿主接线保持同一个动作名。 */
    onCardTap(event: { detail?: { id?: number } }): void {
      this.onOrderTap(event)
    },

    /** 「查看全部 N 个」→ 订单 tab（tab 页之间只 `switchTab`）。 */
    onViewAll(): void {
      const page = this as unknown as IndexPageInstance
      if (!page.data.showViewAll) return
      wx.switchTab({ url: `/${ORDER_LIST_PATH}` })
    },

    /**
     * 失败出口的「重试」—— **重跑启动链**。
     *
     * ⚠️ 订单区自己的页内重试走 `onOrdersRetry`；这里保留一个兜底：若闸门早已
     * ready、只是订单区在 `loadFailed`（比如外部直接把 `onRetry` 接到重试按钮上），
     * 就重取订单而不是空跑一次 `gate.start()`。
     */
    onRetry(): void {
      const page = this as unknown as IndexPageInstance
      if (page.data.phase === 'ready' && page.data.ordersPhase === 'loadFailed') {
        void loadOrders(page, 'retry')
        return
      }
      void gate?.start()
    },

    /**
     * 附近入口 —— 只 `switchTab` 到附近 tab。
     *
     * ⚠️ 入口条不承载任何动态数据：不发请求、不探测定位、不显示距离 / 余位。
     * 那是附近页自己的事；首页这里只负责“指路”。
     */
    onNearby(): void {
      wx.switchTab({ url: `/${NEARBY_PATH}` })
    },

    /**
     * 静态出口里「计费说明」/「常见问题」的点击。
     *
     * ✅ #68 起两页都已实现：按 `detail.exitId` 选路由常量，`navigateTo` 到内容页。
     * 内容端点**免鉴权**，所以即便此刻登录链是失败的，这两页也能真的打开。
     *
     * ⚠️ **按 id 选目标，不按 label**：`STATIC_EXITS` 的 id 是行为选择器；
     * 用文案当选择器会在改词那天让入口静默失效。
     * ⚠️ 「联系客服」不走这里：它是 `open-type="contact"`，由微信原生承载。
     */
    onStaticExit(event: WechatMiniprogram.CustomEvent<{ exitId?: string }>): void {
      const exitId = event.detail?.exitId
      if (exitId !== 'billing' && exitId !== 'faq') return
      const target = STATIC_EXIT_PATHS[exitId]
      if (target === undefined) return
      wx.navigateTo({ url: `/${target}` })
    },

    /**
     * 扫码主行动 —— **唯一入口**。
     *
     * ⚠️ 链路本体（`wx.scanCode` → 收敛 → 柜机页 + 两句反馈）在
     * `utils/scan-locker.ts`：首页、订单列表、订单详情、等待页、预约列表走的是
     * **同一条**，各写一遍必然出现「某一页忘了取消静默」这类分叉。
     * 本页只回答一个问题：柜机页**叠在首页上**（`navigate`）。
     */
    onScan(): void {
      scanToLocker('navigate')
    },
  },
})
