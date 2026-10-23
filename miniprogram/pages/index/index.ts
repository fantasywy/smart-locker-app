// 首页 —— **启动闸门的承载页 + 唯一主行动（扫码存件）**。
//
// ## 本页的两件事
//
// 1. **闸门**：登录链跑完之前画首页同构骨架；登录失败落全局失败出口；成功后进首页。
//    闸门的形态是 #20 的交付物，本票（#61）**不改它的行为**，只把 ready 的占位
//    换成真正的首页版式。
// 2. **扫码主行动**：`wx.scanCode` → `resolveLockerCode()` → 柜机页。
//    四种结果各走各的路（spec §2）：
//       • 解析出柜机码 → `navigateTo` 柜机页，带 `code`；
//       • 非柜机码     → 留在首页，一句提示，可立刻重扫；
//       • 用户取消     → 静默；
//       • 其他失败     → 一句「扫码没成功，请重试」，不按成因分叉。
//
// ## 三条纪律
//
// 1. **页面不持有登录态**：登录态只在请求层与闸门内部，页面只读 `phase`。
// 2. **不做本地业务数据缓存**：页面没有任何 `storage` 读写。
// 3. **失败态不在页面数据区里再写一份**：失败落到 `components/failure-exit/`，
//    页面只负责把它 `wx:if` 出来 —— 「唯一」由那个组件承担。
//
// ## 本票刻意不做的事
//
// - **不做相机权限探测 / 引导**（spec §2 末段）：`wx.scanCode` 不写 `authSetting`，
//   `wx.getSetting()` 无法区分「未请求」与「被拒绝」，任何「请开启相机权限」都是假归因。
// - **不做进行中订单区与附近入口**：订单区在本票仍是占位，由 #67 接手；附近入口
//   随 #72 的同一次发版露出。提前做一个假入口会违反「不造假入口」。
// - **不写页面路径字面量**：柜机页路径来自 `utils/routes.ts` 的 `LOCKER_PATH`。
//   `wx.*To` 拿到不存在的路径是**静默失败** —— 与「点了没反应」同一个症状。
//
// ⚠️ 用的是 `Component()` 而不是 `Page()` —— 全端 10 个页面都按这一形态落地
// （出处是 quickstart 的既有写法，`pages/logs` 那处残留已由 #22 删除），
// 且 `Component` 的 `lifetimes` 让「订阅在 `attached`、退订在 `detached`」这件事
// 有明确的挂载点。

import { createStartupGate } from '../../startup/gate'
import type { StartupGate, StartupState } from '../../startup/gate'
import { HOME_PAGE_COPY } from '../../startup/copy'
import { showToast } from '../../utils/feedback'
import { resolveLockerCode } from '../../utils/locker-code'
import { LOCKER_PATH } from '../../utils/routes'

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
 * 这与 `App.globalData` 仅承载请求层自身需要的少量值这一点，是同一性质。
 */
let gate: StartupGate | null = null

/**
 * 当前订阅的退订函数 —— 页面 `detached` 时用它，避免监听器泄漏。
 *
 * ⚠️ **它挂在页面实例上，不是模块级变量**（第一版是模块级的，review 的变异测试
 * 顺带暴露了它的后果）：
 *   • 模块级时，两个实例会**争同一个槽位** —— 第二个 `attached` 覆盖第一个的退订句柄，
 *     于是第一个实例 `detached` 时拿到的可能是**别人的**退订函数（或 `null`），
 *     真正的泄漏反而被掩盖。
 *   • 挂在实例上，「谁订的、谁退」这条对应关系就是显然的，
 *     且 `detached` 的退订变成一个**可观测**的行为（测试能验它）。
 *
 * 类型上它是页面实例的一个私有字段 —— 小程序 `Component` 没有为「实例私有字段」
 * 提供官方位置，所以挂在这里并由 `applyState` / `attached` / `detached` 读写。
 */
interface IndexPageInstance {
  /** 本实例的退订函数 —— `attached` 里写入，`detached` 里消费。 */
  unsubscribeFromGate?: (() => void) | null
  data: { phase: StartupState['phase'] }
  setData(patch: Record<string, unknown>): void
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
     * 订单区占位文案 —— ⚠️ **过渡期的债**，随 #67 的进行中订单区落地一起删。
     *
     * 本票的票面明确「页内订单区仍是占位，由后续票接手」。保留它，是为了让
     * 「闸门通了、首页真的渲染出来了」在真机上一眼可见；它**不是**订单卡，
     * 也不承载任何业务数据。
     */
    ordersPlaceholderTitle: HOME_PAGE_COPY.ordersPlaceholderTitle,
    ordersPlaceholderHint: HOME_PAGE_COPY.ordersPlaceholderHint,
  },

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
     * 把闸门状态画到界面上。
     *
     * ⚠️ 只取 `phase` 一个字段：`'failed'` 携带的 `UnifiedError` **不进界面**
     * （失败出口的文案是逐字定稿，不含错误码）。
     * 少搬一个字段，就少一条「把错误码画到屏幕上」的路。
     */
    applyState(state: StartupState): void {
      if (this.data.phase === state.phase) return
      this.setData({ phase: state.phase })
    },

    /** 失败出口的「重试」—— **重跑启动链**。 */
    onRetry(): void {
      void gate?.start()
    },

    /**
     * 静态出口里「计费说明」/「常见问题」的点击。
     *
     * ⚠️ **一期没有这两个页面**（本地内容页不在本票范围）。
     * 这里**刻意什么都不做** —— 不假装跳转、不弹「敬请期待」
     * （后者是一句文案，而文案层还没有为它定稿）。
     * 「联系客服」不走这里：它是 `open-type="contact"`，由微信原生承载
     * （不做运行时降级、不做电话双出口）。
     */
    onStaticExit(): void {
      // 有意为空 —— 见方法的注释。
    },

    /**
     * 扫码主行动 —— **唯一入口**。
     *
     * ⚠️ **不传 `onlyFromCamera`**：spec §2 要求默认允许相册选码。
     * 相机权限不做任何探测或引导（见文件头）。
     *
     * ⚠️ 回调里只做「收敛 → 分流」两件事，不在这里写任何文案字面量；
     * 提示语从 `HOME_PAGE_COPY` 来，走统一的反馈适配层。
     */
    onScan(): void {
      wx.scanCode({
        success: (res) => {
          this.handleScanResult(res.result)
        },
        fail: (err) => {
          this.handleScanFailure(err.errMsg)
        },
      })
    },

    /**
     * 扫到了东西 —— 用 `resolveLockerCode()` 收敛成柜机码。
     *
     * ⚠️ **解析不出就留在首页**（不跳柜机页的入口失效页）：入口失效页是给
     * 「从冷启动通道带着一个坏码进来」的用户的；首页扫码的用户就站在这里，
     * 让他重扫一次比把他带到一个「这个码没用」的页面更直接。
     */
    handleScanResult(result: string): void {
      const code = resolveLockerCode({ scanResult: result })
      if (code === null) {
        showToast(HOME_PAGE_COPY.notLockerCode)
        return
      }

      wx.navigateTo({
        // ⚠️ 路径来自常量；`code` 做一次编码，避免柜机码里的保留字符破坏查询串。
        url: `/${LOCKER_PATH}?code=${encodeURIComponent(code)}`,
      })
    },

    /**
     * 扫码失败 —— **取消静默，其余一句提示**。
     *
     * ⚠️ 用户主动取消不是失败：弹一句「扫码没成功」会把用户的主动返回说成事故。
     * 其余成因（相机不可用 / 系统错误 / 权限被拒）**不按成因分叉** —— 用户对成因
     * 无能为力，一句「请重试」就是全部可行动信息。
     */
    handleScanFailure(errMsg: string): void {
      if (errMsg.includes('cancel')) return
      showToast(HOME_PAGE_COPY.scanFailed)
    },
  },
})
