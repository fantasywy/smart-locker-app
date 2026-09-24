// **全局失败出口** —— 全端**唯一**的一处「登录链失败」呈现（`01` §4）。
//
// 契约出处：`docs/spec/01-entry-and-identity.md` §4（全局唯一失败出口）、§5（静态出口三件套）；
// `docs/spec/09-copy-and-status.md` §7.2（文案**逐字**定稿）。
//
// ## 为什么它是一个组件，而不是每个页面里的一段 wxml
//
// `01` §4 的原文是「**只有一个**，由启动态驱动，**不下放到各页面的数据区**。否则同一分支
// 被复制 N 次，且会出现『有的页能重试、有的页不能』的不一致」。做成组件是那句话在代码层的
// 落地：**「唯一」这件事由一个可被守卫断言的文件来承担**，而不是靠每个页面作者的自觉。
//
// ⚠️ 一个组件当然可以被引用两次 —— 所以「唯一」的守卫（`test/startup/conventions.test.ts`）
// 断言的是**失败出口的形态只在这里定义**：文案常量只从 `startup/copy.ts` 来、
// 静态出口只有这一处三件套、不出现第二种失败措辞。
//
// ⚠️ 它**只服务于登录链失败**（三要素：说明 + 重试 + 静态出口）。业务错误**不走这里** ——
// 它们在动作点就地解释（`07` §4.2）。本组件因此**不接** `UnifiedError`：
// 它拿不到错误码，也就画不出错误码 —— 这比「记得别画」可靠。
//
// ⚠️ 触发条件是 `retry` 事件，**由页面**接到闸门的 `start()` 上。组件自己不调登录链 ——
// 那样它就得知道 `startup/gate` 的存在，而闸门的状态归页面持有（一个组件的 `properties`
// 里不放状态机）。

import {
  CONTACT_EXIT_ID,
  FAILURE_DETAIL,
  FAILURE_TITLE,
  RETRY_LABEL,
  STATIC_EXITS,
} from '../../startup/copy'

Component({
  /**
   * 组件不持有任何状态 —— 它是一次纯粹的重绘。
   *
   * ⚠️ 刻意**没有** `data`：失败出口没有「正在重试」这个状态。
   * 重试期间的画面是**骨架屏**（闸门回到 `loading`，页面切走本组件），
   * 而不是本组件上的一个 spinner —— 后者会让「骨架屏 + 失败页」同时存在于设计里，
   * 而 `01` §3.2 的冷启动表现只有「骨架 → 内容 / 骨架 → 失败」两条路。
   */
  data: {
    // ⚠️ 文案从 `startup/copy.ts` 来，**不在 wxml 里写字面量**：
    // `09` §7.2 那一行是定稿逐字，拆进标签里之后「有没有照抄」就只能靠眼睛看。
    title: FAILURE_TITLE,
    detail: FAILURE_DETAIL,
    retryLabel: RETRY_LABEL,
    // 静态出口三件套 —— `01` §4 与 §5 是**同一份内容**，所以与「我的」页共用同一份常量。
    staticExits: STATIC_EXITS,
    /**
     * 客服那一件的 id —— 模板据它决定渲染 `open-type="contact"` 的按钮。
     *
     * ⚠️ **模板不得自己比对文案**（`wx:if="{{ item.label === '联系客服' }}"`）：
     * 那是拿措辞当行为选择器，改词就会让客服按钮静默退化成一个没反应的 `<view>`
     * （`04` §8 明令不做降级，所以没有兜底）。见 `copy.ts` 的 `STATIC_EXITS`。
     */
    contactExitId: CONTACT_EXIT_ID,
  },

  methods: {
    /** 重试 —— 只把动作交回页面（页面接到闸门的 `start()`，重跑整条启动链）。 */
    onRetry(): void {
      this.triggerEvent('retry')
    },

    /**
     * 静态出口三件套的点击。
     *
     * ⚠️ **一期只有「联系客服」有实现**（`04` §8：`open-type="contact"` 一个按钮）。
     * 「计费说明」/「常见问题」是**本地内容页**，归属 `07` §5 页面清单里的静态页，
     * **不在本票**（本票不实现任何业务页面）—— 所以这里如实什么都不做，
     * 由页面 `bind` 决定去哪。**不假装跳转、不弹 toast 说「敬请期待」**
     * （后者是一句文案，而文案归 `09`，且本票没有为它定稿）。
     *
     * ⚠️ 「联系客服」**刻意不走这里**：它是 `open-type="contact"` 的按钮，
     * 由微信原生承载，wxml 里直接就是 `<button open-type="contact">`。
     * 走 `triggerEvent` 再由页面去组一个 `contact` 按钮，等于把原生能力翻译一遍 ——
     * 且 `04` §8 明令不做运行时降级、不做电话双出口，所以没有需要翻译的东西。
     */
    onStaticExit(event: WechatMiniprogram.CustomEvent<{ label: string }>): void {
      this.triggerEvent('staticexit', event.currentTarget.dataset)
    },
  },
})
