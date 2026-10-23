// **柜机页（四档）** —— 扫码落地页，两条扫码通道的汇聚点，也是「存件」主链的起点。
//
// 柜机上下文只能来自扫码（`docs/adr/0001-c-end-no-locker-browsing.md`）。
//
// ## 这个页面的四件事
//
// 1. **四档格口**：数字码 `1|2|3|4`（小 / 中 / 大 / 特大），逐档余位独立。
//    后端契约里同一个概念有三套写法（`cellType` 数字码、`cellAvailability` 小写阶名、
//    中文档名），它们只在下面的 `CELL_TYPES` 一张表里对应一次。
// 2. **正常响应与错误的边界**：`online = false` 与某档余位 0 都是**正常响应**，
//    停留在 `ready`，靠置灰 + 页内原因呈现；只有解析失败 / `1002` / 网络失败
//    才进入异常分支（且 1002 与解析失败共用同一个入口失效页）。
// 3. **一次建单**：点 CTA 先开二次确认弹层，确认后才调 `13.7`；成功**必须**
//    `redirectTo` 等待页 —— 用 `navigateTo` 的话返回键会退回一个已经建过单的页面。
// 4. **零 storage**：上下文 = 页面参数，`lockerId` 只来自本页 `13.6` 的响应。
//
// ## 为什么 `13.6` 不防抖、`13.7` 必须防抖
//
// `13.6` 是 GET、天然幂等；`13.7` **不幂等**（每调一次多一张订单 + 一个预留格口），
// 所以 `submitting` 是「请求进行中的技术性防抖」这一唯一例外在本页的落点。
// 提交中保留选中态、卡片不可点、遮罩不可关 —— 都是为了不给第二次 `13.7` 留入口。

import { getLockerByCode } from '../../api/lockers'
import { createOrder } from '../../api/orders'
import type { CellAvailability, LockerByCode } from '../../types/lockers'
import type { CellType } from '../../types/orders'
import { resolveLockerCode } from '../../utils/locker-code'
import { LOCKER_PAGE_COPY, ORDER_LIST_PATH, PAGE_TITLES, RETRY_LABEL } from '../../startup/copy'
import { RESERVATION_CREATE_PATH, WAITING_PATH } from '../../utils/routes'

/** `1002` —— 柜机不存在 / 已软删（契约 §13.6 :1101）。入口失效页的第二种来源。 */
const LOCKER_NOT_FOUND = 1002

/**
 * 四档规格的**唯一挂载点** —— 数字码 ↔ 余位键 ↔ 中文档名只在这里对应一次。
 *
 * ⚠️⚠️ 这是 spec §3 的硬约束：后端的三套写法（数字码 `1|2|3|4`、小写阶名
 * `small/medium/large/extraLarge`、中文档名）**只能**在这张表里发生关系。
 * 任何一处 `[type]` / `toUpperCase()` / 字符串枚举的「顺手转换」都绕过它：
 * 绕过的那次会在某个档位上静默取到 `undefined`（`undefined === 0` 为 false），
 * 于是**该灰的不灰**，用户点下去才撞 `8002`。
 *
 * ⚠️ 顺序固定为小 / 中 / 大 / 特大 —— 2×2 网格的视觉顺序由数组顺序决定。
 */
const CELL_TYPES = [
  { type: 1, availabilityKey: 'small', label: LOCKER_PAGE_COPY.cellTypeLabels[1] },
  { type: 2, availabilityKey: 'medium', label: LOCKER_PAGE_COPY.cellTypeLabels[2] },
  { type: 3, availabilityKey: 'large', label: LOCKER_PAGE_COPY.cellTypeLabels[3] },
  { type: 4, availabilityKey: 'extraLarge', label: LOCKER_PAGE_COPY.cellTypeLabels[4] },
] as const satisfies readonly {
  type: CellType
  availabilityKey: keyof CellAvailability
  label: string
}[]

/**
 * 页面的四个相位。
 *
 * ⚠️ `'entryFailed'` **覆盖两种情况**（解析不出 code + `13.6` → `1002`）：
 * 它们**必须是同一个页面**，只换文案。拆成两个相位就等于在类型上承认
 * 「它们可以长成两个页面」。
 *
 * ⚠️ **没有「柜机不可用」相位** —— `online = false` 与四档全满都是正常响应，
 * 留在 `'ready'` 上，靠 `cells[].state` / `reserveEnabled` 呈现。
 */
type LockerPhase = 'loading' | 'ready' | 'entryFailed' | 'loadFailed'

/** 一格在界面上的三种正常状态。售罄 / 离线不是错误。 */
type CellState = 'normal' | 'soldout' | 'offline'

/** 一档规格在界面上的全部信息。 */
interface CellRow {
  /** 数字码（`13.7` 请求体直接用它）。 */
  type: CellType
  /** 中文档名（数字码 → 中文的唯一映射来自 `CELL_TYPES`）。 */
  label: string
  /** 该档空闲数（`13.6` 回显）。 */
  available: number
  /** `normal` / `soldout` / `offline`。 */
  state: CellState
  /** 是否是当前选中档。 */
  selected: boolean
}

interface LockerPageData {
  title: string
  phase: LockerPhase
  entryFailedTitle: string
  entryFailedDetail: string
  loadFailedDetail: string
  retryLabel: string
  rescanLabel: string
  myOrdersLabel: string

  siteName: string
  position: string
  lockerUsable: boolean
  lockerReason: string
  offlinePill: string

  cells: CellRow[]
  selectedType: CellType | null
  selectedLabel: string
  selectedAvailable: number

  /** 吸底行动条的两行文案。 */
  barTitle: string
  barHint: string
  ctaLabel: string
  ctaEnabled: boolean
  ctaLoading: boolean
  /** `13.7` 进行中 —— 技术性防抖（唯一允许的禁用态之一）。 */
  submitting: boolean
  /** 提交失败的就地解释（底栏上方一行）。 */
  submitError: string

  reserveLabel: string
  reserveEnabled: boolean
  reserveReason: string

  factCellAssigned: string
  factPaymentLater: string

  /** 确认弹层 —— 站点 / 档位 / 余位三行。 */
  confirmVisible: boolean
  confirmTitle: string
  confirmSiteLabel: string
  confirmSiteName: string
  confirmCellLabel: string
  confirmCellValue: string
  confirmRemainingLabel: string
  confirmRemainingValue: string
  confirmActionLabel: string
  cancelLabel: string
  /** 提交中遮罩不可关 —— Vant popup 的 `close-on-click-overlay` 读它。 */
  confirmOverlayClosable: boolean

  /** 导航栏三出口的开关 —— 冷启动栈深 1 是「首页」+「我的订单」。 */
  navBack: boolean
  navHome: boolean
  navOrders: boolean

  /** 加载骨架的四个占位块（纯图形、无文字）。 */
  loadingCards: number[]
}

interface LockerPageInstance {
  data: LockerPageData
  setData(patch: Partial<LockerPageData>): void
  loadLocker?: (code: string) => Promise<void>
  applyBar?: () => void
  lockerCode?: string | null
  locker?: LockerByCode | null
}

interface LockerPageMethods {
  [name: string]: (...args: never[]) => unknown
  onLoad(options: Record<string, string | undefined>): void
  loadLocker(code: string): Promise<void>
  renderLocker(locker: LockerByCode): void
  applyBar(): void
  onSelectCell(event: { detail: { type?: CellType } }): void
  onPrimary(): void
  onCancelSheet(): void
  onConfirmCreate(): Promise<void>
  onReserve(): void
  onMyOrders(): void
  onRescan(): void
  onRetryLoad(): void
}

/** 余位模板的唯一格式化入口（copy 层给 `余 {count} 个`）。 */
function remainingText(count: number): string {
  return LOCKER_PAGE_COPY.remaining.replace('{count}', () => String(count))
}

/** 当前页面栈深 —— 冷启动直达柜机页时是 1（没有可返回的上一页）。 */
function pageDepth(): number {
  if (typeof getCurrentPages !== 'function') return 1
  const pages = getCurrentPages()
  return Array.isArray(pages) && pages.length > 0 ? pages.length : 1
}

Component<LockerPageData, Record<string, never>, LockerPageMethods, Record<string, never>, true>({
  data: {
    title: PAGE_TITLES['pages/locker/locker'],
    phase: 'loading' as LockerPhase,

    entryFailedTitle: LOCKER_PAGE_COPY.unusableCodeTitle,
    entryFailedDetail: LOCKER_PAGE_COPY.unusableCodeDetail,
    loadFailedDetail: LOCKER_PAGE_COPY.loadFailedDetail,
    retryLabel: RETRY_LABEL,
    rescanLabel: LOCKER_PAGE_COPY.rescan,
    myOrdersLabel: LOCKER_PAGE_COPY.myOrders,

    siteName: '',
    position: '',
    lockerUsable: false,
    lockerReason: '',
    offlinePill: LOCKER_PAGE_COPY.offlinePill,

    cells: CELL_TYPES.map((cell) => ({
      type: cell.type,
      label: cell.label,
      available: 0,
      state: 'normal' as CellState,
      selected: false,
    })),
    selectedType: null,
    selectedLabel: '',
    selectedAvailable: 0,

    barTitle: LOCKER_PAGE_COPY.loadingBarTitle,
    barHint: LOCKER_PAGE_COPY.loadingBarHint,
    ctaLabel: LOCKER_PAGE_COPY.cta,
    ctaEnabled: false,
    ctaLoading: false,
    submitting: false,
    submitError: '',

    reserveLabel: LOCKER_PAGE_COPY.reserve,
    reserveEnabled: false,
    reserveReason: '',

    factCellAssigned: LOCKER_PAGE_COPY.factCellAssigned,
    factPaymentLater: LOCKER_PAGE_COPY.factPaymentLater,

    confirmVisible: false,
    confirmTitle: LOCKER_PAGE_COPY.confirmTitle,
    confirmSiteLabel: LOCKER_PAGE_COPY.confirmSiteLabel,
    confirmSiteName: '',
    confirmCellLabel: LOCKER_PAGE_COPY.confirmCellLabel,
    confirmCellValue: '',
    confirmRemainingLabel: LOCKER_PAGE_COPY.confirmRemainingLabel,
    confirmRemainingValue: '',
    confirmActionLabel: LOCKER_PAGE_COPY.confirmAction,
    cancelLabel: LOCKER_PAGE_COPY.cancel,
    confirmOverlayClosable: true,

    navBack: false,
    navHome: true,
    navOrders: true,

    loadingCards: [0, 1, 2, 3],
  } as LockerPageData,

  lifetimes: {
    attached(): void {
      // 有意为空 —— 页面参数只在 onLoad 里拿得到（见下）。
    },
  },

  methods: {
    /**
     * 页面生命周期 —— 收敛扫码参数、决定导航出口，然后查柜机。
     *
     * ⚠️ 三条来源（`q` / `code` / `scanResult`）经 `resolveLockerCode()` 收敛之后
     * **不存在来源差异**；下面整段没有一处 `if (通道 A)`。
     */
    onLoad(options: Record<string, string | undefined>): void {
      const page = this as unknown as LockerPageInstance
      const depth = pageDepth()
      page.setData({
        navBack: depth > 1,
        navHome: depth <= 1,
        navOrders: true,
      })

      const code = resolveLockerCode({
        q: options['q'],
        code: options['code'],
        scanResult: options['scanResult'],
        scancode_time: options['scancode_time'],
      })
      page.lockerCode = code

      if (code === null) {
        // 解析不出 ⇒ 入口失效，**且不发请求**。拿空码去查会让服务端的 `1002`
        // 掩盖真正的「解析失败」—— 两者文案不同。
        page.setData({
          phase: 'entryFailed',
          entryFailedTitle: LOCKER_PAGE_COPY.unusableCodeTitle,
          entryFailedDetail: LOCKER_PAGE_COPY.unusableCodeDetail,
        })
        return
      }

      void this.loadLocker(code)
    },

    /**
     * 查柜机并按结果落态 —— `13.6` 需要 access，登录链由请求层处理。
     *
     * ⚠️ 不防抖：GET 天然幂等，页面也没有刷新入口（重扫 = 重新进入）。
     */
    async loadLocker(code: string): Promise<void> {
      const page = this as unknown as LockerPageInstance
      const result = await getLockerByCode(code)

      if (!result.ok) {
        if (result.error.code === LOCKER_NOT_FOUND) {
          page.setData({
            phase: 'entryFailed',
            entryFailedTitle: LOCKER_PAGE_COPY.staleStickerTitle,
            entryFailedDetail: LOCKER_PAGE_COPY.staleStickerDetail,
          })
          return
        }

        // ⚠️ 其余失败 → **页内重试**，不停在骨架屏：请求已经回来并失败了，
        // 骨架屏在语义上说的却是「还在加载」，用户会永远等下去。
        page.setData({ phase: 'loadFailed' })
        page.applyBar?.()
        return
      }

      page.locker = result.data
      this.renderLocker(result.data)
    },

    /**
     * 把 `13.6` 的回显画成界面 —— 这一屏的全部内容。
     *
     * ⚠️ 置灰的两个来源（都是正常响应）在这里合流，优先级明确：
     *   • 柜机整体不可用（`online = false`）⇒ **四档全灰**，原因说柜机不可用；
     *   • 柜机可用但某档余位 0 ⇒ **该档灰**，原因说该规格已满。
     * 前者优先：离线时四档余位恒为 0，若让余位判断先跑，用户会看到「该规格已满」——
     * 而真相是整台机器都不可用，那句话会把他推向「换一种规格」，而那条路同样走不通。
     */
    renderLocker(locker: LockerByCode): void {
      const page = this as unknown as LockerPageInstance
      const usable = locker.online

      const cells: CellRow[] = CELL_TYPES.map((cell) => {
        const available = locker.cellAvailability[cell.availabilityKey]
        const state: CellState = !usable ? 'offline' : available === 0 ? 'soldout' : 'normal'
        return {
          type: cell.type,
          label: cell.label,
          available,
          state,
          selected: false,
        }
      })

      const anyAvailable = cells.some((cell) => cell.available > 0)
      const reserveEnabled = usable && anyAvailable

      page.setData({
        phase: 'ready',
        siteName: locker.siteName,
        position: locker.position,
        lockerUsable: usable,
        lockerReason: usable ? '' : LOCKER_PAGE_COPY.lockerUnavailableReason,
        cells,
        selectedType: null,
        selectedLabel: '',
        selectedAvailable: 0,
        submitError: '',
        reserveEnabled,
        reserveReason: !usable
          ? LOCKER_PAGE_COPY.lockerUnavailableReason
          : anyAvailable
            ? ''
            : LOCKER_PAGE_COPY.allSoldOutReserveReason,
      })
      page.applyBar?.()
    },

    /**
     * 按当前相位 / 可用性 / 选中态刷新吸底行动条。
     *
     * ⚠️ 优先级与 `renderLocker` 一致：loading → loadFailed → offline →
     * 四档全满 → 未选中 → 已选中。提交中不覆盖底栏左侧的选中信息，
     * 只把 CTA 换成「正在下单…」并打开 spinner。
     */
    applyBar(): void {
      const page = this as unknown as LockerPageInstance
      const { phase, lockerUsable, cells, selectedType, submitting } = page.data
      const selected =
        selectedType === null ? undefined : cells.find((cell) => cell.type === selectedType)

      let barTitle: string = LOCKER_PAGE_COPY.chooseCell
      let barHint: string = LOCKER_PAGE_COPY.allCellsAvailable

      if (phase === 'loading') {
        barTitle = LOCKER_PAGE_COPY.loadingBarTitle
        barHint = LOCKER_PAGE_COPY.loadingBarHint
      } else if (phase === 'loadFailed') {
        barTitle = LOCKER_PAGE_COPY.loadFailedBarTitle
        barHint = LOCKER_PAGE_COPY.loadFailedBarHint
      } else if (!lockerUsable) {
        barTitle = LOCKER_PAGE_COPY.offlineBarTitle
        barHint = LOCKER_PAGE_COPY.offlineBarHint
      } else if (!cells.some((cell) => cell.available > 0)) {
        barTitle = LOCKER_PAGE_COPY.allSoldOutBarTitle
        barHint = LOCKER_PAGE_COPY.allSoldOutBarHint
      } else if (selected !== undefined) {
        barTitle = LOCKER_PAGE_COPY.selectedCell.replace('{label}', () => selected.label)
        barHint = remainingText(selected.available)
      }

      page.setData({
        barTitle,
        barHint,
        ctaLabel: submitting ? LOCKER_PAGE_COPY.submitting : LOCKER_PAGE_COPY.cta,
        ctaEnabled: !submitting && selected !== undefined && selected.state === 'normal',
        ctaLoading: submitting,
      })
    },

    /**
     * 选中一格 —— 只接受 `normal` 档；提交中不接受任何选择变化。
     *
     * ⚠️ 首屏无预选是硬要求：用户必须自己点一档，不能默认替他选。
     */
    onSelectCell(event: { detail: { type?: CellType } }): void {
      const page = this as unknown as LockerPageInstance
      if (page.data.submitting) return

      const type = event.detail.type
      const row = page.data.cells.find((cell) => cell.type === type)
      if (row === undefined || row.state !== 'normal') return

      page.setData({
        selectedType: type ?? null,
        selectedLabel: row.label,
        selectedAvailable: row.available,
        cells: page.data.cells.map((cell) => ({
          ...cell,
          selected: cell.type === type,
        })),
      })
      page.applyBar?.()
    },

    /**
     * 点主 CTA —— 只开二次确认弹层，**不直接建单**。
     *
     * ⚠️ 二次确认是 spec §3 的逐字要求：用户要再看到站点 / 档位 / 余位
     * 才按「确认存件」，避免误下单。
     */
    onPrimary(): void {
      const page = this as unknown as LockerPageInstance
      if (page.data.submitting || !page.data.ctaEnabled) return

      const selectedType = page.data.selectedType
      const row =
        selectedType === null
          ? undefined
          : page.data.cells.find((cell) => cell.type === selectedType)
      if (row === undefined || row.state !== 'normal') return

      page.setData({
        confirmVisible: true,
        confirmSiteName: page.data.siteName,
        confirmCellValue: row.label,
        confirmRemainingValue: remainingText(row.available),
        confirmOverlayClosable: true,
        submitError: '',
      })
    },

    /** 取消确认 —— 提交中不可关（遮罩同理由 `confirmOverlayClosable` 挡住）。 */
    onCancelSheet(): void {
      const page = this as unknown as LockerPageInstance
      if (page.data.submitting) return
      page.setData({ confirmVisible: false })
    },

    /**
     * 二次确认 → `13.7` 建单。
     *
     * ⚠️⚠️ **成功必须 `redirectTo`，不是 `navigateTo`**：用 `navigateTo` 时
     * 返回键会退回柜机页，而那时用户手里已经有一个开了门的订单 ——
     * 再点一次就是**又开一次门**（`13.7` 不幂等）。`redirectTo` 让那个状态
     * **物理上不存在**。
     *
     * ⚠️ 提交中不重置 `submitting`（成功后页面马上被替换）——
     * 解开防抖会让用户在跳转发生前那一帧再点一次，而那是新的 `13.7`。
     */
    async onConfirmCreate(): Promise<void> {
      const page = this as unknown as LockerPageInstance
      if (page.data.submitting) return

      const locker = page.locker
      const selectedType = page.data.selectedType
      const row =
        selectedType === null
          ? undefined
          : page.data.cells.find((cell) => cell.type === selectedType)
      if (locker === null || locker === undefined || row === undefined) return
      if (row.state !== 'normal') return

      page.setData({
        submitting: true,
        submitError: '',
        confirmOverlayClosable: false,
      })
      page.applyBar?.()

      const result = await createOrder({ lockerId: locker.id, cellType: row.type })

      if (!result.ok) {
        // ⚠️ 失败就地解释、保留选择、不跳转。4004 / 8002 的含义恰好就是
        // 页面上的两句置灰原因；其余归「下单失败，请重试」。
        const submitError =
          result.error.code === 4004
            ? LOCKER_PAGE_COPY.lockerUnavailableReason
            : result.error.code === 8002
              ? LOCKER_PAGE_COPY.cellTypeFullReason
              : LOCKER_PAGE_COPY.submitFailed
        page.setData({
          submitting: false,
          submitError,
          confirmVisible: false,
          confirmOverlayClosable: true,
        })
        page.applyBar?.()
        return
      }

      const query = [
        `orderId=${result.data.orderId}`,
        `openTimeoutMinutes=${result.data.openTimeoutMinutes}`,
        'mode=drop',
      ].join('&')
      wx.redirectTo({ url: `/${WAITING_PATH}?${query}` })
    },

    /**
     * 「预约」—— `navigateTo` 进预约创建页，带 `lockerId`。
     *
     * ⚠️ 守卫与 `onPrimary` 对称地写在这里：模板的 `bindtap` 是渲染层保证，
     * 处理函数自己也要拒绝置灰入口（事件绑定 / 无障碍触发都绕得过模板）。
     */
    onReserve(): void {
      const page = this as unknown as LockerPageInstance
      const locker = page.locker
      if (locker === null || locker === undefined) return
      if (!page.data.reserveEnabled) return
      wx.navigateTo({ url: `/${RESERVATION_CREATE_PATH}?lockerId=${locker.id}` })
    },

    /** 入口失效页的「我的订单」—— 订单列表是 tab 页，只能 switchTab。 */
    onMyOrders(): void {
      wx.switchTab({ url: `/${ORDER_LIST_PATH}` })
    },

    /**
     * 「重新扫码」—— 入口失效页的出路。
     *
     * 扫到的结果走**同一个收敛函数**与**同一段查询逻辑**，不在本方法里另起一套。
     */
    onRescan(): void {
      const page = this as unknown as LockerPageInstance
      wx.scanCode({
        success: (res) => {
          const code = resolveLockerCode({ scanResult: res.result })
          page.lockerCode = code
          if (code === null) {
            page.setData({
              phase: 'entryFailed',
              entryFailedTitle: LOCKER_PAGE_COPY.unusableCodeTitle,
              entryFailedDetail: LOCKER_PAGE_COPY.unusableCodeDetail,
            })
            return
          }
          page.setData({
            phase: 'loading',
            selectedType: null,
            selectedLabel: '',
            selectedAvailable: 0,
            cells: page.data.cells.map((cell) => ({ ...cell, selected: false })),
            submitError: '',
          })
          page.applyBar?.()
          void page.loadLocker?.(code)
        },
        // 取消扫码是用户主动放弃，不是错误 —— 什么都不做。
        fail: () => {},
      })
    },

    /**
     * 「重试」—— 真的重发 `13.6`（不是本地翻状态）。
     *
     * 复用 `lockerCode` 而不是回头解析页面参数：重扫之后页面参数已是旧快照，
     * 重试要用的是**当前这一次**的码。
     */
    onRetryLoad(): void {
      const page = this as unknown as LockerPageInstance
      const code = page.lockerCode
      if (code === null || code === undefined) return
      page.setData({
        phase: 'loading',
        selectedType: null,
        selectedLabel: '',
        selectedAvailable: 0,
        cells: page.data.cells.map((cell) => ({ ...cell, selected: false })),
        submitError: '',
      })
      page.applyBar?.()
      void page.loadLocker?.(code)
    },
  },
})
