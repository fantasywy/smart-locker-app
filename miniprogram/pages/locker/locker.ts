// **柜机页** —— 扫码落地页，两条扫码通道的汇聚点，也是「存件」这条主链的起点。
//
// 柜机上下文只能来自扫码（`docs/adr/0001-c-end-no-locker-browsing.md`）。
//
// ## 这个页面的全部难点在「同一个页面的四种长相」
//
// 它是**唯一同时要处理两种进入方式**的页面：通道 A（微信「扫一扫」直达）是冷启动、
// 栈深 1；通道 B（小程序内 `wx.scanCode`）是热启动、叠在当前栈上。两条通道表现必须一致 ——
// 而「一致」的实现方式**不是**「记得让两个分支长得一样」，
// 是让它们在收敛之后**根本不存在**（`resolveLockerCode()` 把来源吃掉）。
//
// 之后的四种非正常进入，**两种是错误、两种不是**：
//
// | 情况 | 性质 | 本页怎么呈现 |
// |---|---|---|
// | 解析不出 `code` | **入口失效** | `phase = 'entryFailed'` + 「这个码没用」 |
// | `13.6` → `1002` | **入口失效** | **同一个 `phase`**，只换文案（`entryFailedTitle`） |
// | `online = false` | **正常响应** | `phase = 'ready'`，完整渲染 + 逐档置灰 + 页内原因 |
// | 余位 0 | **正常响应** | 同上，只灰该档 |
//
// ⚠️⚠️ **后两种做成错误弹窗是本票最容易犯、也最像「功能正常」的错**（`§16 #29` 逐字：
// 它们是正常响应而非错误，后端自己建议「按 `online` / `cellAvailability` 置灰入口」）。
// 把它们做成弹窗，用户会以为**自己扫错了**；而「拿到数据」意味着用户能看见
// 「确实有这么台柜机、只是现在不能用」—— 这是有效信息。
// ⇒ 本页**一次 `wx.showModal` / `wx.showToast` 都不调**（测试里这两个桩未编排即抛错）。
//
// ## 三条形态裁决
//
// 1. **上下文 = 页面参数，不进 storage**（ADR-0001）。
//    解析出的 `code` 就是全部上下文，`lockerId` 也只活在本实例上。
//    ⚠️ 禁止隐式记住上次柜机：最坏结果是用户在**另一台**柜机前被带上别的柜机上下文，
//    **下单成功而门在别处开了**。省一次扫码的收益与开错柜门的风险严重不对称。
//    ⇒ 本文件里**没有任何 `wx.*Storage*` 调用**，且它不读不写 token（那归请求层）。
//
// 2. **四种非正常进入由 `phase` 一个变量驱动**，不是四个布尔。
//    入口失效那两种情况**共用同一个 `phase`** —— 因为它们**必须是**
//    「**同一个页面**，文案换为…」。用两个状态写，就为「将来它们长成两个页面」
//    留了门；而票面的验收恰恰是那条「同一个」。
//
// 3. **`13.7` 的入口带技术性防抖，`13.6` 不带。** `13.7` 不幂等（每调一次多一张订单
//    + 一个预留格口），所以必须有防重复提交；而 `13.6` 是 GET、
//    天然幂等，给它加防抖只会让用户重进页面时无谓地卡在骨架屏上。这条区分是
//    「请求进行中的技术性防抖」这一例外在页面上的落点。

import { getLockerByCode } from '../../api/lockers'
import { createOrder } from '../../api/orders'
// ⚠️ DTO 从 `types/` 引，**不是**从 `api/`：`types/` 与 `api/` 一一对应。
import type { CellAvailability, LockerByCode } from '../../types/lockers'
import type { CellType } from '../../types/orders'
import { resolveLockerCode } from '../../utils/locker-code'
import { LOCKER_PAGE_COPY, ORDER_LIST_PATH, PAGE_TITLES, RETRY_LABEL } from '../../startup/copy'
import { RESERVATION_CREATE_PATH, WAITING_PATH } from '../../utils/routes'

/**
 * `1002` —— **柜机不存在 / 已软删**（契约 `:1101`）。
 *
 * ⚠️ 它是 `13.6` **唯一**可预期的业务失败码，也是本页唯一据业务码分叉的地方。
 * 单独提成常量（而不是在 `loadLocker` 里写 `1002` 字面量）：这个数字的含义
 * 只在一处声明。
 *
 * ⚠️ 它与「解析不出 `code`」**走同一个页面、只换文案**。
 */
const LOCKER_NOT_FOUND = 1002

/**
 * 三档规格的**唯一挂载点** —— 把三套写法扣在一起的那一处。
 *
 * ⚠️⚠️ 契约里同一件事有**三套写法**，它们都不一样：
 *
 * | 出处 | 形状 | 例 |
 * |---|---|---|
 * | `13.6` 响应的阶名 | **小写** | `cellAvailability.small` |
 * | `13.7` 请求体的枚举 | **大写** | `cellType: 'SMALL'` |
 * | 用户看到的字 | 中文 | 「小」 |
 *
 * ⇒ 这个数组是**唯一**能把三者对应起来的地方。任何一处 `[type]` 或 `.toUpperCase()`
 * 的「顺手转换」都绕过它，而绕过的那次会在某个档位上静默取到 `undefined`
 * （`availability['SMALL']` 不报错，它是 `undefined`；`undefined === 0` 为 `false`
 * —— 于是**该灰的不灰**，用户点下去才撞 `8002`）。
 */
const CELL_TYPES = [
  { type: 'SMALL', availabilityKey: 'small', label: LOCKER_PAGE_COPY.cellTypeLabels.SMALL },
  { type: 'MEDIUM', availabilityKey: 'medium', label: LOCKER_PAGE_COPY.cellTypeLabels.MEDIUM },
  { type: 'LARGE', availabilityKey: 'large', label: LOCKER_PAGE_COPY.cellTypeLabels.LARGE },
] as const satisfies readonly {
  type: CellType
  availabilityKey: keyof CellAvailability
  label: string
}[]

/**
 * 页面的三个状态 —— **只有这三个**。
 *
 * ⚠️ `'entryFailed'` **覆盖两种情况**（解析不出 `code` + `13.6` → `1002`）：
 * 两者**必须是**「**同一个页面**，文案换为…」，所以它们共用这一个相位，
 * 差别只在 `entryFailedTitle` / `entryFailedDetail` 两个文案字段上。
 * 拆成两个相位就等于在类型上承认「它们可以长成两个页面」。
 *
 * ⚠️ **没有「柜机不可用」这个相位** —— `online = false` 与余位 0 是**正常响应**，
 * 它们停留在 `'ready'` 上，靠 `cells[].enabled` 呈现。
 * 一个 `'unavailable'` 相位就是「正常响应被当成错误处理」的代码形态。
 */
type LockerPhase = 'loading' | 'ready' | 'entryFailed' | 'loadFailed'

/** 一档规格在界面上的全部信息。 */
interface CellRow {
  /** `13.7` 请求体的枚举值（大写）。 */
  type: CellType
  /** 用户看到的中文档名（枚举名不进文案）。 */
  label: string
  /** 该档空闲数（服务端回显）。 */
  available: number
  /** 该档入口是否可点。 */
  enabled: boolean
  /** 该档置灰的原因 —— 空串表示可点（不渲染说明）。 */
  reason: string
}

/** 本页 `data` 的形状（wxml 读的就是这些键）。 */
interface LockerPageData {
  title: string
  phase: LockerPhase
  /** 入口失效页的标题 —— 「这个码没用」或「这个码可能来自旧贴纸」。 */
  entryFailedTitle: string
  /** 入口失效页的说明句。 */
  entryFailedDetail: string
  /** 加载失败页的说明句（「加载失败，请重试」）。 */
  loadFailedDetail: string
  /** 加载失败页的重试按钮（与全局失败出口同一个词）。 */
  retryLabel: string
  /** 「重新扫码」按钮。 */
  rescanLabel: string
  /** 「我的订单」按钮。 */
  myOrdersLabel: string
  /** 「预约」按钮。 */
  reserveLabel: string
  /** 站名（`13.6` 的 `siteName`）。 */
  siteName: string
  /** 位置描述（`13.6` 的 `position`）。 */
  position: string
  /** 柜机整体是否可用 —— 只看 `13.6` 的 `online`。 */
  lockerUsable: boolean
  /** 柜机不可用时的原因（页内一行说明，**不是弹窗**）。 */
  lockerReason: string
  /** 三档规格的渲染行 —— 顺序与 `CELL_TYPES` 一致。 */
  cells: CellRow[]
  /** 预约入口是否可点。⚠️ 柜机不可用时与「开始存件」同等置灰。 */
  reserveEnabled: boolean
  /** 预约入口置灰的原因。 */
  reserveReason: string
  /** `13.7` 进行中 —— 技术性防抖（两种被允许的禁用之一）。 */
  submitting: boolean
}

/**
 * 页面实例上的私有字段 —— 小程序 `Component` 没有为它们提供官方位置。
 *
 * ⚠️ **柜机上下文只活在这里**（上下文 = 页面参数，不持久化、
 * 不跨页共享）。它不是 `data`（不参与渲染），也不是模块级变量
 * （那会跨页面实例共享 —— 正是 ADR-0001 禁止的「隐式记住上次柜机」）。
 */
interface LockerPageInstance {
  data: LockerPageData
  setData(patch: Partial<LockerPageData>): void
  loadLocker?: (code: string) => Promise<void>
  /** 本实例解析出的柜机码。 */
  lockerCode?: string | null
  /** 本实例查到的柜机 —— `lockerId` 的唯一来源。 */
  locker?: LockerByCode | null
}

/** 本页的 `methods` 形状 —— 供 `Component` 的泛型参数使用（`MethodOption` 要求）。 */
interface LockerPageMethods {
  /** ⚠️ 索引签名是 `MethodOption` 的约束要求的（`type MethodOption = Record<string, (...args: any[]) => any>`）。 */
  [name: string]: (...args: never[]) => unknown
  onLoad(options: Record<string, string | undefined>): void
  loadLocker(code: string): Promise<void>
  renderLocker(locker: LockerByCode): void
  onStartStoring(event: { currentTarget: { dataset: { cellType?: CellType } } }): Promise<void>
  onReserve(): void
  onMyOrders(): void
  onRescan(): void
  onRetryLoad(): void
}

// ⚠️ **`Component<..., true>` 的最后一个类型参数是 `TIsPage`** —— 它必须为 `true`，
// 本页才拿得到页面生命周期（`onLoad(options)`）。
//
// ⚠️ 为什么不是 `Page({...})`：仓库里 10 个页面全部用 `Component()` 落地
// （`#22` 定的骨架，理由在空壳页的注释里），本页不为了一个 `onLoad` 换形态。
// 而 `Component` 写法下页面参数**只有** `onLoad` 收得到（`attached` 不带参数）——
// 所以那个 `true` 不是装饰，是「这确实是个页面而不是组件」的声明。
// 忘了它时 `pnpm typecheck` 会明确报 `'onLoad' does not exist in type 'Options<...>'`。
Component<LockerPageData, Record<string, never>, LockerPageMethods, Record<string, never>, true>({
  data: {
    /** 自绘导航栏标题 —— 唯一的家是 `startup/copy.ts` 的 `PAGE_TITLES`。 */
    title: PAGE_TITLES['pages/locker/locker'],

    /** 首帧 = 骨架屏（页面结构先出现，数据区等 token）。 */
    phase: 'loading' as LockerPhase,

    // 入口失效页的两个文案字段 —— 初值给「这个码没用」那一套。
    // ⚠️ 初值是**取值**而不是「未设置」：`1002` 那条路只会覆盖它们，
    // 不会出现「某个字段还是空的」这种半成品状态。
    entryFailedTitle: LOCKER_PAGE_COPY.unusableCodeTitle,
    entryFailedDetail: LOCKER_PAGE_COPY.unusableCodeDetail,
    loadFailedDetail: LOCKER_PAGE_COPY.loadFailedDetail,
    // ⚠️ 复用 `RETRY_LABEL`（「重试」）而不是在 `LOCKER_PAGE_COPY`
    // 里再写一个同名的字面量 —— 「同一个动作在全局只能有一个名字」。
    // 两个「重试」各自维护一份，改一处漏一处的那天就是同一个动作有两个名字的那天。
    retryLabel: RETRY_LABEL,

    // 三个按钮的文案 —— 全部来自 `LOCKER_PAGE_COPY`。⚠️ 挂在 `data` 上而不是在 wxml 里
    // 写死：用户可见的每个字归文案层，且这四个词在本页的不同
    // 分支里都要用到（入口失效页的「我的订单」与导航栏那个是同一个动作、同一句话）。
    rescanLabel: LOCKER_PAGE_COPY.rescan,
    myOrdersLabel: LOCKER_PAGE_COPY.myOrders,
    reserveLabel: LOCKER_PAGE_COPY.reserve,

    siteName: '',
    position: '',
    lockerUsable: false,
    lockerReason: '',

    // ⚠️ 三档逐个写出来（不是空数组）—— wxml 在首帧就要能读到 `cells`，
    // 且「有哪三档」这件事在这里一眼可见（显式优于隐式）。
    cells: CELL_TYPES.map((cell) => ({
      type: cell.type,
      label: cell.label,
      available: 0,
      enabled: false,
      reason: '',
    })) as CellRow[],

    reserveEnabled: false,
    reserveReason: '',
    submitting: false,
  } as LockerPageData,

  lifetimes: {
    /**
     * 挂载点 —— 只做**不依赖页面参数**的首帧准备。
     *
     * ⚠️ 页面参数**不在这里**：`q` / `code` / `scanResult` 由 `onLoad(options)` 送达
     * （那是小程序页面生命周期里唯一带参数的钩子）。本函数因此刻意是空的 ——
     * 与其在这里猜参数在哪，不如把它放在唯一正确的那个钩子里。
     */
    attached(): void {
      // 有意为空 —— 见本函数的注释。业务起点是 `onLoad`。
    },
  },

  methods: {
  /**
   * 页面生命周期 —— **只有 `Component` 写法的页面能同时拿到它和 `lifetimes`**。
   *
   * ⚠️ 参数形状是 `Record<string, string | undefined>` 而不是 `Record<string, string>`：
   * 微信给的是**只含实际出现的键**的字典，`options.q` 在通道 B 上根本不存在。
   * 写成 `string` 会诱导实现者相信「这三个键一定都有」，
   * 而 `resolveLockerCode` 的整个入参设计（全部可选）正是为了不这么相信。
   */
  onLoad(options: Record<string, string | undefined>): void {
    const page = this as unknown as LockerPageInstance

    // ⚠️ **第一个动作是收敛，且收敛之后就再也见不到「来源」了**。
    // 下面整段代码里没有一处 `if (通道 A)` —— 那正是这个函数存在的意义。
    const code = resolveLockerCode({
      q: options['q'],
      code: options['code'],
      scanResult: options['scanResult'],
      scancode_time: options['scancode_time'],
    })
    page.lockerCode = code

    // 解析不出 ⇒ 入口失效，**且不发请求**。
    // 拿空码去查柜机会让服务端的 `1002` 掩盖真正的「解析失败」——
    // 两者文案不同，混在一起用户就看不到「请用微信扫柜机上的二维码」这句正确的指引。
    if (code === null) {
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
     * 查柜机并按结果落态 —— `13.6` 需要 access，登录链已由请求层处理。
     *
     * ⚠️ **`13.6` 不需要防抖**：它是 GET、天然幂等，且本页没有刷新入口
     * （重启一次 = 重扫一次码）。给它加一个 `loading` 守卫只会让「用户在慢网络下
     * 重进页面」时卡在骨架屏上。
     */
    async loadLocker(code: string): Promise<void> {
      const page = this as unknown as LockerPageInstance
      const result = await getLockerByCode(code)

      if (!result.ok) {
        // ⚠️ `1002`（柜机不存在 / 已软删）是**入口失效**，与「解析不出 code」**同一个
        // 页面**，只换文案。
        //
        // ⚠️ 但只有 `1002` 是。其余失败（网络不通、5xx、别的业务码）**不能**冒充
        // 「这个码没用」—— 那会把一次网络抖动说成「你扫的码是废的」，
        // 用户于是走开去换一张贴纸，而真正该做的是重试。
        if (result.error.code === LOCKER_NOT_FOUND) {
          page.setData({
            phase: 'entryFailed',
            entryFailedTitle: LOCKER_PAGE_COPY.staleStickerTitle,
            entryFailedDetail: LOCKER_PAGE_COPY.staleStickerDetail,
          })
          return
        }

        // ⚠️⚠️ 其余失败 → **加载失败页**（「加载失败，请重试」）。
        //
        // **本分支第一版写的是 `setData({ phase: 'loading' })`（停在骨架屏），那是错的。**
        // 它当时说服自己的理由是「不编一个错误页」—— 但骨架屏在语义上是**「还在加载」**，
        // 而此刻请求已经回来了、并且失败了。结果是一屏永远不动的占位：
        // 用户既不知道出了什么事，也**没有重试的入口**（这一行的出路就是「重试」）。
        //
        // ⇒ 「不编错误页」这条纪律的正确读法是「**不自己造文案**」，
        //   而不是「不给用户任何反馈」。文案取既有的那一行，就不是自编。
        //
        // ⚠️ 仍然**不弹窗**（请求层不弹窗，页面也不该在这里造一个通用失败态）——
        // 它是一屏页内内容，与「这个码没用」同一形态。
        page.setData({ phase: 'loadFailed' })
        return
      }

      page.locker = result.data
      this.renderLocker(result.data)
    },

    /**
     * 把 `13.6` 的回显画成界面 —— **这一屏的全部内容**。
     *
     * ⚠️⚠️ **这里是「正常响应」与「错误」的分界线，也是本票最要紧的一段。**
     * `online = false` 与余位 0 **都走这条路**（完整渲染 + 逐档置灰 + 页内原因），
     * 而不是任何失败分支（`§16 #29`）。
     *
     * 置灰的**两个来源**（两种正常响应）在这里合流，且优先级是明确的：
     *   • 柜机整体不可用（`online = false`）⇒ **三档全灰**，原因说柜机不可用；
     *   • 柜机可用但某档余位 0 ⇒ **该档灰**，原因说该规格已满。
     * 前者优先：柜机离线时三档余位**恒为 0**，若让余位判断先跑，
     * 用户会看到「该规格已满」—— 而真相是**整台机器都不可用**，
     * 那句话会把他推向「换一种规格试试」，而那条路同样走不通。
     */
    renderLocker(locker: LockerByCode): void {
      const page = this as unknown as LockerPageInstance
      // ⚠️ 可用性**只读 `online`**，不对 `status` 做集合判断。
      //
      // ⚠️⚠️ 这一条看起来像「少实现了一半」，所以理由必须写清 ——
      // 条件本身包含**两个子句**：
      // 「`online = false` **或** `status` 非 `ONLINE`」。但这两个子句**是同一件事**：
      // 口径是「`online`｜`locker.status == ONLINE`（已按优先级链收敛）」。
      // 也就是说 `online` 就是服务端替我们算好的那个布尔，`status` 只是它的原料。
      //
      // ⇒ 自己再对 `status` 做一次集合判断，等于**把后端的收敛逻辑抄一份到客户端**：
      //   抄的那份会在后端新增一个状态（比如 `DECOMMISSIONED`）时静默过期 ——
      //   届时 `online` 已经是 `false`（后端认了），而客户端的清单里没有那个新枚举，
      //   于是入口**照样可点**。少写一个判断，换来「后端说了算」这件事在代码上成立。
      //
      // ⚠️ 这不是「没实现 `status` 那一半」，而是**两个子句本来就同义**，
      // 实现取那个权威的、收敛过的。`LockerStatus` 类型仍然完整保留（类型层如实反映
      // 后端形状），只是**不参与判断**。
      const usable = locker.online

      const cells: CellRow[] = CELL_TYPES.map((cell) => {
        const available = locker.cellAvailability[cell.availabilityKey]
        if (!usable) {
          // 柜机整体不可用 —— 三档全灰，原因统一。
          return {
            type: cell.type,
            label: cell.label,
            available,
            enabled: false,
            reason: LOCKER_PAGE_COPY.lockerUnavailableReason,
          }
        }
        if (available === 0) {
          // ⚠️ 余位 0 是**正常响应**，对应建单会 `8002`。
          // ⚠️ **不得引导「去预约」**：预约同样只认 `FREE` 格口
          // （`13.12` 无空闲 → `8002`），唯一真出口是「换一台柜机」。
          return {
            type: cell.type,
            label: cell.label,
            available,
            enabled: false,
            reason: LOCKER_PAGE_COPY.cellTypeFullReason,
          }
        }
        return { type: cell.type, label: cell.label, available, enabled: true, reason: '' }
      })

      // 预约入口与「开始存件」**同等地**置灰 —— 两个触发条件都算。
      //
      // ⚠️⚠️ **本段的第一版是错的，且错得很有代表性。** 它只把预约入口挂在 `online` 上，
      // 并给自己编了一条理由：「预约要的是以后有格口，此刻满不代表预约时段也满」。
      // 那个推理听起来合理 —— 而它**恰好是被明确排除的那一个**：
      //
      // > **余位 0 时不得引导「去预约」** —— 预约同样只认 `FREE` 格口
      // > （`13.12` 无空闲 → `8002`），唯一真出口是「换一台柜机」。
      // > **该结论没有例外**：`cellAvailability[type] === 0` 时，柜机页的「预约」入口
      // > **与「开始存件」同样置灰**并写明「该规格已满」。
      //
      // ⇒ 判据是**两个条件的或**，且原因按**哪个条件先成立**来选：
      //   ① 柜机整体不可用 → 那句说柜机不可用；
      //   ② 柜机可用但**任一档**余位为 0 → 那句说该规格已满。
      // ①优先，与 `cells` 的优先级一致（同一个理由：柜机离线时余位恒为 0，
      // 说「该规格已满」会把用户推向「换一种规格试试」，而那条路同样走不通）。
      //
      // ⚠️ ②说的是「**任一档**为 0」而不是「三档全为 0」：预约入口在本页只有**一个**，
      // 而判据是 `cellAvailability[type] === 0`（某规格为 0 即置灰）——
      // 预约创建本身要选规格，任一档满就可能选不中，而既有裁决已经替我们选了保守方向。
      const anyCellFull = cells.some((cell) => cell.available === 0)

      page.setData({
        phase: 'ready',
        siteName: locker.siteName,
        position: locker.position,
        lockerUsable: usable,
        lockerReason: usable ? '' : LOCKER_PAGE_COPY.lockerUnavailableReason,
        cells,
        reserveEnabled: usable && !anyCellFull,
        reserveReason: !usable
          ? LOCKER_PAGE_COPY.lockerUnavailableReason
          : anyCellFull
            ? LOCKER_PAGE_COPY.cellTypeFullReason
            : '',
      })
    },

    /**
     * 「开始存件」—— `13.7` 建单，成功后 `redirectTo` 等待态。
     *
     * ⚠️⚠️ **必须是 `redirectTo`，不是 `navigateTo`**。
     * 理由与门口那个页面无关，与**返回键**有关：用 `navigateTo` 时用户按返回键会退回
     * 柜机页，而那时他手里已经有一个**已开门的订单** —— 再点一次「开始存件」
     * 就是**又开一次门**（`13.7` 不幂等）。`redirectTo` 让那个状态
     * **物理上不存在**。
     *
     * ⚠️ **入参只有两个**：`orderId` 与 `openTimeoutMinutes`。
     * 特别是**不传**「我来存件还是取件」—— 落点由服务端回显决定，不由入口决定。
     * 而 `openTimeoutMinutes` 是**唯一**从 `13.7` 响应取的地方，
     * **不硬编码**：缺省值 10 是**后端的**缺省，运营改了它，写死的客户端就开始撒谎。
     */
    async onStartStoring(event: {
      currentTarget: { dataset: { cellType?: CellType } }
    }): Promise<void> {
      const page = this as unknown as LockerPageInstance
      const locker = page.locker
      const cellType = event.currentTarget.dataset.cellType

      // ⚠️ **进行中防抖**（两种被允许的禁用之一）。
      // `13.7` **不幂等**：每调一次多一张订单 + 一个新预留格口。
      // 连点两次不是「重复提交被吸收」，是真的抢走两个格口。
      if (page.data.submitting) return

      if (locker === null || locker === undefined || cellType === undefined) return

      // 置灰的入口点了什么都不做 —— 界面既然已经说了「该规格已满」，照着点一下
      // 不该真的去打一次注定 `8002` 的请求（而 `13.7` 不幂等，多发的那次同样会抢格口）。
      //
      // ⚠️ 这里**不是**对「绝不事前阻断」的违反：
      // 本条正是那条原则列出的例外 —— **`13.6` 回显驱动的入口置灰，那是服务端说的**。
      const row = page.data.cells.find((cell) => cell.type === cellType)
      if (row === undefined || !row.enabled) return

      page.setData({ submitting: true })
      const result = await createOrder({ lockerId: locker.id, cellType })

      if (!result.ok) {
        // ⚠️ **失败就留在本页**（请求层不弹窗，呈现归调用方）。
        // 两个准入类失败码（`4004` / `8002`）的含义恰好就是页面上
        // 已经写着的那两句置灰原因 —— 所以这里只需要把防抖解开。
        //
        // ⚠️ **不跳转是本条最要紧的一半**：若失败还跳进等待态，用户会站在柜机前
        // 等一个**从没开过的门**，而屏幕上写着「已发出开门指令」—— 这正是要禁止的。
        page.setData({ submitting: false })
        return
      }

      // ⚠️ 成功后**不重置 `submitting`**：本页马上要被 `redirectTo` **替换掉**。
      // 解开防抖会让用户在跳转发生前的那一帧里再点一次 —— 而那一次是新的 `13.7`。
      // 一个已经作废的页面状态不值得一次多余的渲染。
      const query = [
        `orderId=${result.data.orderId}`,
        `openTimeoutMinutes=${result.data.openTimeoutMinutes}`,
      ].join('&')
      wx.redirectTo({ url: `/${WAITING_PATH}?${query}` })
    },

    /**
     * 「预约」—— `navigateTo` 进预约创建页，带 `lockerId`。
     *
     * ⚠️ 用 **`navigateTo`** 而不是 `redirectTo`：预约创建**不是移交**，
     * 用户在那里取消后应当能退回柜机页继续存件。移交语义（`redirectTo`）
     * 只属于等待态那一条路。
     *
     * ⚠️⚠️ **守卫必须与 `onStartStoring` 对称地写在这里，不能只靠模板的 `disabled`。**
     * review 抓到过第一版：它对「开始存件」判了 `enabled`、对「预约」却只判了
     * `locker` 在不在 —— `reserveEnabled` 压根没读。
     * 模板上确实有 `disabled="{{ !reserveEnabled }}"`，所以手点不出来；
     * 但那是**渲染层**的保证，而那条纪律说的是「置灰的入口**点了什么都不做**」——
     * 一个由模板单独承担的守卫，会在事件绑定、无障碍触发、或把 `<button>` 换成
     * `<view bindtap>` 的任何一次改动里凭空消失，而**看一眼处理函数完全看不出来缺了什么**。
     */
    onReserve(): void {
      const page = this as unknown as LockerPageInstance
      const locker = page.locker
      if (locker === null || locker === undefined) return
      if (!page.data.reserveEnabled) return
      wx.navigateTo({ url: `/${RESERVATION_CREATE_PATH}?lockerId=${locker.id}` })
    },

    /**
     * 「我的订单」—— 顶部那个**唯一**通往订单列表的出口。
     *
     * ⚠️⚠️ **真实的主出口不在这里，在 `navigation-bar` 的 `home()` 里。**
     * 产品要求是「**顶部固定**一个『我的订单』出口」，而 `#23` 已把
     * `homeButton` 修成真按钮（组件自己 `wx.switchTab`，页面接不接都能用）。
     * ⇒ 正常态下用户点的是**导航栏那个房子图标**，本文件不重复实现它。
     *
     * ⚠️ 本方法服务于**入口失效页**上那个独立的「我的订单」出口
     * （〔重新扫码〕〔我的订单〕并列）—— 那一屏渲染的不是导航栏的
     * 内建按钮，而是页面自己的按钮（见 wxml 的注释）。它与导航栏那个是**同一个动作**，
     * 因此两处是**同一句文案**（`LOCKER_PAGE_COPY.myOrders`）。
     *
     * ⚠️ 仍然**必须是 `wx.switchTab`**：订单列表是 tabBar 页，`navigateTo` 对它
     * **静默失败**（这里也必须是 `switchTab`）。目标由 `ORDER_LIST_PATH`
     * 常量钉死 —— 写错一个字符就是同样的静默失败。
     */
    onMyOrders(): void {
      wx.switchTab({ url: `/${ORDER_LIST_PATH}` })
    },

    /**
     * 「重新扫码」—— 入口失效页的出路之一。
     *
     * 走 `wx.scanCode`（通道 B）而不是让用户退回微信再扫：此刻用户人就在柜机前，
     * 而他要扫的很可能就是**柜机上现在贴的那张**（`1002` 那条路正是为它写的）。
     * 让他退出小程序再进来，是把一次点击变成三次。
     *
     * ⚠️ 扫到的结果走**同一个收敛函数**（`resolveLockerCode`）与**同一段查询逻辑**
     * （`loadLocker`）—— 本方法不自己解析、也不自己发请求。任何「这里反正是二维码原文，
     * 直接用」的顺手写法都会让通道 B 在本页出现**第二个版本**，而那正是
     * 「两条通道表现必须一致」要防的。
     */
    onRescan(): void {
      const page = this as unknown as LockerPageInstance
      wx.scanCode({
        success: (res) => {
          const code = resolveLockerCode({ scanResult: res.result })
          page.lockerCode = code
          if (code === null) {
            // ⚠️ 连扫两次都是一堆没用的东西 ⇒ 停在同一个入口失效页上，**不换文案**：
            // 此时我们手里没有任何新事实（不知道它是旧贴纸、还是别的网站），
            // 而「这个码可能来自旧贴纸」那句只该由服务端的 `1002` 说出来（这是归因纪律）。
            page.setData({
              phase: 'entryFailed',
              entryFailedTitle: LOCKER_PAGE_COPY.unusableCodeTitle,
              entryFailedDetail: LOCKER_PAGE_COPY.unusableCodeDetail,
            })
            return
          }
          // 先回骨架屏再查 —— 重扫是一次新的取数，界面不该停在上一次的结论上。
          page.setData({ phase: 'loading' })
          void page.loadLocker?.(code)
        },
        // ⚠️ **取消扫码（`fail`）什么都不做**：用户主动放弃不是错误，页面保持原样
        // （他看到的还是那个入口失效页 + 重新扫码）。弹一个 toast 说「扫码失败」
        // 是替用户宣布一个他自己刚做的决定。
        fail: () => {},
      })
    },

    /**
     * 「重试」—— 重新查一次柜机（「加载失败，请重试」）。
     *
     * ⚠️ 它必须**真的重发 `13.6`**，而不是把 `phase` 翻回 `loading` 就了事：
     * 一个只改状态的假重试会让用户留在这一屏上反复点，而页面「看起来响应了」
     * （骨架屏闪一下又回到失败页）。测试因此断言请求数真的变成 2。
     *
     * ⚠️ 复用 `lockerCode`（本实例上那个已解析好的码）而不是回头再解析一次页面参数：
     * 页面参数是**进入时**的快照，`onRescan` 之后它会与 `lockerCode` 不一致 ——
     * 重试要用的是**当前这一次**的码。
     */
    onRetryLoad(): void {
      const page = this as unknown as LockerPageInstance
      const code = page.lockerCode
      if (code === null || code === undefined) return
      page.setData({ phase: 'loading' })
      void page.loadLocker?.(code)
    },
  },
})
