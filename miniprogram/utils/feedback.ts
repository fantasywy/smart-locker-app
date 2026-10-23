// **反馈适配层** —— 全站轻提示与确认弹窗的唯一出口（spec §14.10）。
//
// ## 为什么必须有这一层
//
// Vant 的 Toast / Dialog 是**函数式 API**：调用时要先找到页面里的宿主组件
// （`<van-toast id="van-toast" />` / `<van-dialog id="van-dialog" />`），
// 组件内调用还要传 `context: this`。如果每个页面各自 `import` Vant 的反馈模块：
//   • 页面的 import 成了一组**隐式契约**（少一个宿主就静默不弹）；
//   • 文案、按钮词与禁用词散落在页面里，改一处漏一处；
//   • 测试要么去 mock Vant 内部，要么根本测不到「用户看到什么」。
//
// ⇒ 收进这里：页面只调 `showToast()` / `confirm()`，拿到的只有「一句话」与
// 「确认了吗」这一个二值结果。Vant 的宿主与 `context` 仍由页面提供（页面决定
// 把宿主放在哪），但页面**不 import** Vant 的反馈模块。
//
// ⚠️ **本文件不写任何用户可见文案**：按钮的兜底词来自 `startup/copy.ts`
// 的 `CONFIRM_COPY`；提示语与弹窗标题 / 说明句由调用方从 `copy.ts` 传入。
// 这样「用户可见的每个字归文案层」在反馈链路上也成立。
//
// ⚠️ **不覆盖 Vant 的过渡时长**：本文件不传 `duration`（Toast 的展示时长除外，
// 那是业务参数不是动效参数）—— 弹层的 300ms 内建过渡属于动效白名单第 ① 条。

import Dialog from '@vant/weapp/dialog/dialog'
import Toast from '@vant/weapp/toast/toast'
import { CONFIRM_COPY } from '../startup/copy'

/** Vant 函数式 API 需要的页面 / 组件实例 —— 页面在自定义组件内调用时传 `this`。 */
export type FeedbackContext =
  | WechatMiniprogram.Component.TrivialInstance
  | WechatMiniprogram.Page.TrivialInstance

/** 轻提示参数 —— 文案必填，展示时长可选（毫秒，不传走 Vant 默认）。 */
export interface ToastOptions {
  message: string
  duration?: number
  context?: FeedbackContext
}

/** 确认弹窗参数 —— 标题 / 说明句由调用方从 `copy.ts` 传入，按钮文案可覆盖。 */
export interface ConfirmOptions {
  title?: string
  message: string
  /** 确认按钮的**动作词**（如「取消订单」「开始使用」）；不传用 `CONFIRM_COPY.confirm`。 */
  confirmText?: string
  /** 取消按钮的动作词（如「再想想」）；不传用 `CONFIRM_COPY.cancel`。 */
  cancelText?: string
  context?: FeedbackContext
}

/** 告知弹窗参数 —— 只有一个「知道了」出口，不需要用户做决定。 */
export interface AlertOptions {
  title?: string
  message: string
  /** 关闭按钮的动作词；不传用 `CONFIRM_COPY.confirm`。 */
  confirmText?: string
  context?: FeedbackContext
}

/**
 * 轻提示 —— 只有一句话，**没有图标类型参数**。
 *
 * ⚠️ 产品不允许「成功 / 失败」各配一个图标把语义放大：轻提示只说事实
 * （「订单已取消」），不替用户判断这件事是好是坏。需要用户做决定时用 `confirm()`。
 */
export function showToast(options: ToastOptions | string): void {
  const message = typeof options === 'string' ? options : options.message
  const duration = typeof options === 'string' ? undefined : options.duration
  const context = typeof options === 'string' ? undefined : options.context

  Toast({
    message,
    // ⚠️ 只传**有值**的字段：显式传 `undefined` 会覆盖 Vant 的默认值
    // （比如 duration 变成 undefined ⇒ 提示永不自动消失）。
    ...(duration === undefined ? {} : { duration }),
    ...(context === undefined ? {} : { context }),
  })
}

/**
 * 确认弹窗 —— 返回「用户确认了吗」这一个二值结果。
 *
 * ⚠️ Vant 的 `Dialog.confirm` 在取消 / 点遮罩 / 关闭时 **reject**；对页面来说
 * 那三种都是「没有确认」，不该被迫写三层 catch。这里统一收敛成 `false`。
 * 真正的业务失败（请求失败等）不归这里 —— 弹窗只负责收集意图。
 *
 * ⚠️ 按钮文案默认取 `CONFIRM_COPY`，**不依赖 Vant 的默认值**（那是第二文案源，
 * 且「确认」与产品动作词不一定一致）。动作专属词由调用方逐字传入。
 */
export async function confirm(options: ConfirmOptions): Promise<boolean> {
  try {
    await Dialog.confirm({
      ...(options.title === undefined ? {} : { title: options.title }),
      message: options.message,
      confirmButtonText: options.confirmText ?? CONFIRM_COPY.confirm,
      cancelButtonText: options.cancelText ?? CONFIRM_COPY.cancel,
      // 确认弹窗必须给用户「不」的出口；Vant 的 Dialog.confirm 也会加，
      // 这里显式写出来是为了让契约在参数对象里可见，不靠函数名暗示。
      showCancelButton: true,
      ...(options.context === undefined ? {} : { context: options.context }),
    })
    return true
  } catch {
    return false
  }
}

/**
 * 告知弹窗 —— 只陈述一句事实，**没有取消按钮**。
 *
 * 用于「动作被服务端拒绝，但用户不需要再做选择」的场合（例：取消订单时服务端
 * 回 `3002`，页面必须把契约逐字告诉用户）。与 `confirm()` 的分界是**有没有二值选择**：
 * 有选择用 `confirm`，只是告知用 `alert`。两者都走同一个 Vant Dialog 宿主，
 * 页面仍然不 import 任何 Vant 反馈模块。
 */
export async function alert(options: AlertOptions): Promise<void> {
  await Dialog.alert({
    ...(options.title === undefined ? {} : { title: options.title }),
    message: options.message,
    confirmButtonText: options.confirmText ?? CONFIRM_COPY.confirm,
    ...(options.context === undefined ? {} : { context: options.context }),
  })
}
