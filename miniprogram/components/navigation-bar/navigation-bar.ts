// **自绘导航栏** —— 全端统一（`07` §5:138），weui 骨架留下的组件。
//
// 契约出处：`docs/spec/07-engineering-form.md` §5（导航栏维持 `custom`、统一自绘；
// 柜机页的「我的订单」出口只有自绘导航栏能承载）、`docs/spec/01-entry-and-identity.md`
// §2.4:55-59（柜机页出口**走 `wx.switchTab` 到订单 tab**）。
//
// ## 本票（#23）在这里修的是什么
//
// `homeButton` 属性一旦使用，渲染出来的是个**点了没反应的死按钮** ——
// `wxml:26` 绑了 `bindtap="home"`，而 `methods` 里**只有 `_showChange` 与 `back`**，
// `home` 根本没实现。这不是新功能，是**照 spec 补完**：`01` §2.4 逐字要求柜机页顶部固定
// 一个「我的订单」出口，而柜机页是冷启动、栈深 1 的非 tab 页，底部 tabBar 不显示
// ⇒ 那是屏幕上**唯一**通往订单列表的可见路径，一个死按钮等于把用户关在柜机页里。
//
// ## 两条裁决
//
// 1. **`home()` 自己 `wx.switchTab`，而不是只 `triggerEvent` 让页面去跳。**
//    `back()` 的形态是 `wx.navigateBack()` **加** `triggerEvent('back')` —— 页面接不接都能用。
//    `home()` 照抄这个形态：`wx.switchTab` 是**缺省行为**，事件是**可选的通知口**。
//    ⚠️ 反过来做（只 triggerEvent、跳转交给页面）的后果是**又一次死按钮**：
//    10 个页面里任何一个漏接 `bind:home` 就又点不动了，而那正是本次要修的缺陷本身。
//    组件的**缺省行为**必须是可用的，页面只负责可选的附加反应。
//
// 2. **目标是 `ORDER_LIST_PATH` 常量，不是本文件里的字面量。**
//    `wx.switchTab` 的 url 必须是 `app.json` 的 `tabBar.list[].pagePath` 之一，
//    差一个字符就是**静默失败** —— 与本次要修的症状一模一样，只是更难查。
//    理由与守卫见 `startup/copy.ts` 里那条常量的说明。
//
// ⚠️ **本组件是 weui 骨架留下的，改动必须真机/模拟器验渲染**（`10` §11 已登记过
// 「未实测」类问题）。判据是**画面**：柜机页顶部出现房子图标、点一下真的切到订单 tab。

import { ORDER_LIST_PATH } from '../../startup/copy'

Component({
  options: {
    multipleSlots: true // 在组件定义时的选项中启用多slot支持
  },
  /**
   * 组件的属性列表
   */
  properties: {
    extClass: {
      type: String,
      value: ''
    },
    title: {
      type: String,
      value: ''
    },
    background: {
      type: String,
      value: ''
    },
    color: {
      type: String,
      value: ''
    },
    back: {
      type: Boolean,
      value: true
    },
    loading: {
      type: Boolean,
      value: false
    },
    homeButton: {
      type: Boolean,
      value: false,
    },
    animated: {
      // 显示隐藏的时候opacity动画效果
      type: Boolean,
      value: true
    },
    show: {
      // 显示隐藏导航，隐藏的时候navigation-bar的高度占位还在
      type: Boolean,
      value: true,
      observer: '_showChange'
    },
    // back为true的时候，返回的页面深度
    delta: {
      type: Number,
      value: 1
    },
  },
  /**
   * 组件的初始数据
   */
  data: {
    displayStyle: ''
  },
  lifetimes: {
    attached() {
      const rect = wx.getMenuButtonBoundingClientRect()
      wx.getSystemInfo({
        success: (res) => {
          const isAndroid = res.platform === 'android'
          const isDevtools = res.platform === 'devtools'
          this.setData({
            ios: !isAndroid,
            innerPaddingRight: `padding-right: ${res.windowWidth - rect.left}px`,
            leftWidth: `width: ${res.windowWidth - rect.left }px`,
            safeAreaTop: isDevtools || isAndroid ? `height: calc(var(--height) + ${res.safeArea.top}px); padding-top: ${res.safeArea.top}px` : ``
          })
        }
      })
    },
  },
  /**
   * 组件的方法列表
   */
  methods: {
    _showChange(show: boolean) {
      const animated = this.data.animated
      let displayStyle = ''
      if (animated) {
        displayStyle = `opacity: ${
          show ? '1' : '0'
        };transition:opacity 0.5s;`
      } else {
        displayStyle = `display: ${show ? '' : 'none'}`
      }
      this.setData({
        displayStyle
      })
    },
    back() {
      const data = this.data
      if (data.delta) {
        wx.navigateBack({
          delta: data.delta
        })
      }
      this.triggerEvent('back', { delta: data.delta }, {})
    },
    /**
     * 返回订单列表 —— **柜机页顶部那个「我的订单」出口**（`01` §2.4:55-59）。
     *
     * ⚠️ **必须用 `wx.switchTab`，不能用 `wx.navigateTo` / `wx.redirectTo`。**
     * 订单列表是 tabBar 页（`01` §2.3），而 `navigateTo` 对 tabBar 页会**静默失败**
     * （照样不跳转、不报错）—— 那就等于没修这个死按钮。`01` §2.4 逐字也是 `wx.switchTab`。
     *
     * ⚠️ 柜机页是**栈深 1** 的（通道 A 冷启动，`01` §2.2），`switchTab` 会**关闭全部
     * 非 tab 页**并把订单 tab 设为当前页 —— 这正是要的：用户从柜机页去订单列表，
     * 不该能靠系统返回退回柜机页（那只会让他再扫一次码）。
     *
     * 事件名用 `home`（与 `back` 对称），**不带参数** —— 目标由常量钉死，
     * 没有「跳去哪」这个变量可传。页面接不接都能用（见文件头的裁决 1）。
     */
    home() {
      wx.switchTab({
        url: `/${ORDER_LIST_PATH}`
      })
      this.triggerEvent('home', {}, {})
    }
  },
})
