// **自绘导航栏** —— 全站 12 页共用，内部换成 Vant `van-nav-bar`。
//
// ## 这一版（#59）的契约：四个入参、三个事件，各做一件事
//
// | 入参 | 语义 | 缺省行为 |
// |---|---|---|
// | `title` | 页面标题 | —— |
// | `back` | 栈深 > 1 时的返回箭头 | `wx.navigateBack()` |
// | `homeButton` | 栈深 1 时的「首页」出口 | `wx.switchTab(HOME_PATH)` |
// | `ordersButton` | 右侧「我的订单」出口 | `wx.switchTab(ORDER_LIST_PATH)` |
//
// ⚠️ **`home()` 与 `orders()` 都必须自己完成跳转，不能只 `triggerEvent`。**
// 柜机页冷启动是栈深 1 的非 tab 页：系统返回 = 直接退出小程序、底部 tabBar 不显示，
// 导航栏上这两个出口就是屏幕上仅有的回程。若跳转交给页面、而 10 个页面里任何一个漏接
// `bind:home` / `bind:orders`，那个出口就又变成**死按钮**了（#23 修过一次同类缺陷）。
// ⇒ **缺省行为必须可用，事件只是可选的附加通知口。**
//
// ⚠️ **`home()` 与 `orders()` 的目标是常量，不是本文件里的字面量。**
// `wx.switchTab` 的 url 必须是 `app.json` 的 `tabBar.list[].pagePath` 之一，
// 差一个字符就是**静默失败**（不跳转、不报错）—— 与死按钮同一个用户症状，只是更难查。
// 两个目标在 #66 之前恰好都指向 `pages/index/index`，现在已分开：
// `HOME_PATH` 是「首页」，`ORDER_LIST_PATH` 是独立的订单 tab；改路径只改对应常量。
//
// ⚠️ **颜色 / 背景入参已删除。** 导航栏的颜色只从 token 写死（`navigation-bar.scss`），
// 页面传入任意色值会让主题层出现第二个事实源，且 AA 对比度不再受 token 守卫保护。
// 其余 weui 骨架时代的透传（extClass / loading / show / animated / delta）一并删除 ——
// 「零 `van-*` prop 透传」是 spec §11 的硬约束。
//
// ⚠️ 视觉上仍有胶囊避让：`van-nav-bar` 本身不会避让微信右上角的胶囊按钮，
// 所以 `attached` 用 `wx.getMenuButtonBoundingClientRect()` 算出需要预留的右侧宽度，
// 由模板里的内层容器用 `padding-right` 让开。标题因此在剩余宽度里居中（略偏左），
// 这是为了不压住胶囊而接受的代价。

import { NAVIGATION_COPY, ORDER_LIST_PATH } from '../../startup/copy'
import { HOME_PATH } from '../../utils/routes'

Component({
  options: {
    multipleSlots: true,
  },

  properties: {
    /** 页面标题 —— 由页面从 `copy.ts` 的 `PAGE_TITLES` 取。 */
    title: {
      type: String,
      value: '',
    },
    /** 返回上一页。栈深 > 1 时使用；点击缺省 `wx.navigateBack()`。 */
    back: {
      type: Boolean,
      value: true,
    },
    /** 左侧「首页」出口。栈深 1 时使用；点击缺省 `wx.switchTab(HOME_PATH)`。 */
    homeButton: {
      type: Boolean,
      value: false,
    },
    /** 右侧「我的订单」出口；点击缺省 `wx.switchTab(ORDER_LIST_PATH)`。 */
    ordersButton: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    homeLabel: NAVIGATION_COPY.home,
    ordersLabel: NAVIGATION_COPY.orders,
    backLabel: NAVIGATION_COPY.back,
    /**
     * 右侧胶囊需要预留的宽度（px）—— 0 表示还没有量到。
     *
     * ⚠️ 单位是 px：`getMenuButtonBoundingClientRect()` 返回的就是 px，
     * 与 `van-nav-bar` 的 px 几何同一坐标系。用 rpx 换算反而会引入一次误差。
     */
    capsuleSafeWidth: 0,
  },

  lifetimes: {
    attached() {
      // ⚠️ 量不到就保持 0：宁可标题偏右一点也不让导航栏整体塌掉。
      // 这里不抛错 —— 几何失败是环境问题，不该让整页白屏。
      try {
        const rect = wx.getMenuButtonBoundingClientRect()
        const system = wx.getSystemInfoSync()
        const width = system.windowWidth - rect.left
        this.setData({ capsuleSafeWidth: width > 0 ? width : 0 })
      } catch {
        this.setData({ capsuleSafeWidth: 0 })
      }
    },
  },

  methods: {
    /**
     * 返回上一页 —— **只做一件事：返回**。
     *
     * ⚠️ 事件是可选通知口（页面接不接都能用），不带参数：返回没有「去哪」这个变量。
     */
    back() {
      wx.navigateBack({})
      this.triggerEvent('back', {}, {})
    },

    /**
     * 回首页 —— **只做一件事：`wx.switchTab(HOME_PATH)`**。
     *
     * ⚠️ 必须是 `switchTab`：首页是 tabBar 页，`navigateTo` / `redirectTo` 对 tabBar 页
     * 会**静默失败**。`switchTab` 同时关闭全部非 tab 页 —— 从柜机页回首页正是要这个效果。
     */
    home() {
      wx.switchTab({
        url: `/${HOME_PATH}`,
      })
      this.triggerEvent('home', {}, {})
    },

    /**
     * 回订单列表 —— **只做一件事：`wx.switchTab(ORDER_LIST_PATH)`**。
     *
     * ⚠️ 与 `home()` 分开命名、分开目标：柜机页顶部同时需要「首页」与「我的订单」
     * 两个不同方向的出口，一个 `homeButton` 装不下（spec §11 的补充裁决）。
     */
    orders() {
      wx.switchTab({
        url: `/${ORDER_LIST_PATH}`,
      })
      this.triggerEvent('orders', {}, {})
    },
  },
})
