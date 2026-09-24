// 首页 —— **启动闸门的承载页**。
//
// 契约出处：`docs/spec/01-entry-and-identity.md` §2.3（页面骨架：首页 = 订单列表）、
// §3.2（冷启动表现：结构先出现、数据区等 token）、§4（全局唯一失败出口）；
// `docs/spec/07-engineering-form.md` §6（不引 store）。
//
// ## 本票（#20）在这里做什么、不做什么
//
// 交付的是**闸门形态**：页面结构（骨架屏）先出现，业务数据区在登录完成前不渲染；
// 登录失败落全局失败出口；重试重跑启动链。
//
// ⚠️ **不实现订单列表本身**（订单列表归 `03` / D3）。所以「数据区」在这里是一个
// **显式的占位块**，而不是一个真的列表 —— 本票的验收标准是「业务数据区在登录完成前
// 不渲染」，那件事成立与否与数据区长什么样无关。
// 用占位块交付它，是为了让「闸门通了」这件事**在真机上可被看见、可被 demo**
// （本票 What to build 的原文），而不是一个只有测试知道的状态机。
//
// ## 三条纪律
//
// 1. **页面不持有登录态**（`07` §6）：登录态只在请求层与闸门内部，页面只读 `phase`。
// 2. **不做本地业务数据缓存**（`01` §3.2）：页面没有任何 `storage` 读写。
// 3. **失败态不在页面数据区里再写一份**（`01` §4）：失败落到 `components/failure-exit/`，
//    页面只负责把它 `wx:if` 出来 —— 「唯一」由那个组件承担。
//
// ⚠️ 用的是 `Component()` 而不是 `Page()` —— `07` §5 的全部 10 个页面都按这一形态落地
// （出处是 quickstart 的既有写法，`pages/logs` 那处残留已由 #22 删除），
// 且 `Component` 的 `lifetimes` 让「订阅在 `attached`、退订在 `detached`」这件事
// 有明确的挂载点。
//
// ⚠️ quickstart 骨架里的头像昵称示例（`getUserProfile` / `chooseAvatar`）**刻意删掉**：
// 那些能力的正确落点是「我的」页（`01` §5，入口只在那里，且不阻塞任何流程），
// 首页留一份会误导后来者以为首页要承担资料填写。它与 #18 删掉 quickstart 里那段
// 「取到 code 只 console.log」是同一取向 —— 入口文件不该存在一份错误的示范。

import { createStartupGate } from '../../startup/gate'
import type { StartupGate, StartupState } from '../../startup/gate'
import {
  DATA_AREA_PLACEHOLDER_HINT,
  DATA_AREA_PLACEHOLDER_TITLE,
  PAGE_TITLES,
} from '../../startup/copy'

/**
 * 闸门实例 —— **模块级的单例**，不是 `data` 里的一员。
 *
 * ⚠️ 为什么放模块级而不是 `this.data`：闸门持有登录链的飞行态（`inFlight`），
 * 而页面会被重建（`detached` → 再次进入）。把它塞进 `data` 会随页面一起被丢掉，
 * 于是「冷启动登录链还在飞、页面被重建」时**会又起一条链** —— 而这正是
 * `07` §4.3 单一飞行要防的那类重复。
 *
 * ⚠️ 它**不等于引入 store**（`07` §6 禁的是业务状态的集中存放）。闸门里只有
 * 「登录到哪一步了」这一个变量，**没有任何业务数据** —— 页面依然从 `api/` 拿数据。
 * 与 `07` §6 允许的 `App.globalData` 用途（请求层自身需要的少量值）是同一性质。
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
     * 自绘导航栏标题 —— 唯一的家是 `startup/copy.ts` 的 `PAGE_TITLES`。
     *
     * ⚠️ 与 9 个空壳页同一个形状。本页原先在 wxml 里写死「我的订单」字面量，
     * 而 `#22` 刚把这个字符串收进 `PAGE_TITLES` —— 于是同一个词有了两个家，
     * 且 `test/startup/conventions.test.ts` 的文案守卫**覆盖不到**（它反推的是
     * `USER_VISIBLE_COPY_LITERALS`，`PAGE_TITLES` 的值不在其中）。
     * review 抓到了这一点：收拢动作做了一半，等于没做。现已改为一处。
     */
    title: PAGE_TITLES['pages/index/index'],

    /**
     * 闸门状态 —— wxml 用它决定画骨架屏、数据区、还是失败出口。
     *
     * ⚠️ 与 `StartupState` 的判别键同名（`phase`），这样 `wx:if="{{phase === 'ready'}}"`
     * 与 TS 里的 `state.phase === 'ready'` 读起来是同一件事。
     * 三个取值：`'loading'`（骨架屏）/ `'ready'`（数据区）/ `'failed'`（失败出口）。
     */
    phase: 'loading' as StartupState['phase'],

    /**
     * 数据区占位文案 —— ⚠️ **过渡期的债**，随订单列表（`03` / D3）落地一起删。
     *
     * 从 `copy.ts` 来而不是写在 wxml 里：用户可见的每个字都归文案层
     * （`09` §0 硬规则 1）。本票的 review 抓到过第一版写在模板里的两句 ——
     * 其中一句还是「订单列表将在后续票中落地」这样的**开发者台词**。
     */
    dataAreaTitle: DATA_AREA_PLACEHOLDER_TITLE,
    dataAreaHint: DATA_AREA_PLACEHOLDER_HINT,
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
     * （失败出口的文案是 `09` §7.2 的定稿，不含错误码）。
     * 少搬一个字段，就少一条「把错误码画到屏幕上」的路。
     */
    applyState(state: StartupState): void {
      if (this.data.phase === state.phase) return
      this.setData({ phase: state.phase })
    },

    /** 失败出口的「重试」—— **重跑启动链**（`01` §4 / `09` §6 第 33 条）。 */
    onRetry(): void {
      void gate?.start()
    },

    /**
     * 静态出口里「计费说明」/「常见问题」的点击。
     *
     * ⚠️ **一期没有这两个页面**（本地内容页归属 `07` §5 的静态页清单，不在本票）。
     * 这里**刻意什么都不做** —— 不假装跳转、不弹「敬请期待」
     * （后者是一句文案，而文案归 `09`，且 `09` 没有为它定稿）。
     * 「联系客服」不走这里：它是 `open-type="contact"`，由微信原生承载
     * （`04` §8：不做运行时降级、不做电话双出口）。
     */
    onStaticExit(): void {
      // 有意为空 —— 见方法的注释。
    },
  },
})
