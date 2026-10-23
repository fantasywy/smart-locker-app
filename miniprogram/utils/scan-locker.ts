// **扫码 → 柜机码 → 柜机页** —— 这条链路只写一次。
//
// ## 为什么需要一个模块
//
// 首页的主行动、订单列表 / 订单详情的空态与历史单出口、等待页取消终局的「重新扫码」，
// 走的是**同一条链路**：`wx.scanCode` → `resolveLockerCode()` → 柜机页。五个调用点各写
// 一遍的后果不是重复十几行，而是**四条失败路径会分叉**：某一页记得「取消静默」、
// 另一页把用户主动返回说成事故；某一页漏了「非柜机码」的提示，用户点了没反应。
//
// ⇒ 链路本体（`scanToLocker`）与两个回落点（`handleScanResult` / `handleScanFailure`）
// 收在这里；页面只回答一个问题：**柜机页该怎么叠上来**（`ScanNavigation`）。
//
// ## 两种导航方式都是真实的
//
//   • `navigate` —— 首页 / 订单列表 / 订单详情 / 预约列表：柜机页**叠在**当前页上，
//     返回键回到用户原来那一屏；
//   • `redirect` —— 等待页的取消终局：等待页已经结束了，**替换**它而不是叠加
//     （spec §4 逐字：「解析出 `code` 后 **`redirectTo`** 柜机页（替换等待页，不叠加）」）。
//
// 这个差别是**宿主的去向**，不是链路的一部分 —— 所以它是入参，而不是两份实现。
//
// ⚠️ 文案来自 `SCAN_COPY`（两句反馈的唯一家）；本模块不写任何用户可见字面量。
// ⚠️ 与 `utils/locker-code.ts` 的分工：那边是**纯函数**（解析），这边是**适配层**
// （`wx.*` + toast）。解析规则照着纯函数测，链路行为照 wx 桩测。

import { SCAN_COPY } from '../startup/copy'
import { showToast } from './feedback'
import { resolveLockerCode } from './locker-code'
import { LOCKER_PATH } from './routes'

/**
 * 柜机页怎么叠上来。
 *
 * ⚠️ 只有这两个值：`switchTab` 到柜机页是错的（它不是 tab 页），
 * `reLaunch` 会把整个页面栈清掉（用户会丢失上下文）。两个已裁决的形态写死成联合类型，
 * 调用方选错在编译期就报错。
 */
export type ScanNavigation = 'navigate' | 'redirect'

/** 柜机页 URL —— `code` 做一次编码，避免柜机码里的保留字符破坏查询串。 */
function lockerUrlOf(code: string): string {
  return `/${LOCKER_PATH}?code=${encodeURIComponent(code)}`
}

/**
 * 扫到了东西 —— 收敛成柜机码，然后按宿主要求的导航方式打开柜机页。
 *
 * ⚠️ **解析不出就留在原地**（不跳柜机页的入口失效页）：入口失效页是给
 * 「从冷启动通道带着一个坏码进来」的用户的；正在扫码的用户就站在这儿，
 * 让他重扫一次比把他带到一个「这个码没用」的页面更直接。
 */
export function handleScanResult(result: string, navigation: ScanNavigation): void {
  const code = resolveLockerCode({ scanResult: result })
  if (code === null) {
    showToast(SCAN_COPY.notLockerCode)
    return
  }
  const url = lockerUrlOf(code)
  if (navigation === 'redirect') wx.redirectTo({ url })
  else wx.navigateTo({ url })
}

/**
 * 扫码失败 —— **取消静默，其余一句提示**。
 *
 * ⚠️ 用户主动取消不是失败：弹一句「扫码没成功」会把用户的主动返回说成事故。
 * 其余成因（相机不可用 / 系统错误 / 权限被拒）**不按成因分叉** —— 用户对成因
 * 无能为力，一句「请重试」就是全部可行动信息。
 */
export function handleScanFailure(errMsg: string): void {
  if (errMsg.includes('cancel')) return
  showToast(SCAN_COPY.scanFailed)
}

/**
 * 扫一次码并打开柜机页 —— 四页共用的唯一入口。
 *
 * ⚠️ **不传 `onlyFromCamera`**：spec §2 要求默认允许相册选码。
 * 相机权限不做任何探测或引导（`SCAN_COPY` 的说明里有理由）。
 */
export function scanToLocker(navigation: ScanNavigation): void {
  wx.scanCode({
    success: (result) => {
      handleScanResult(result.result, navigation)
    },
    fail: (error) => {
      handleScanFailure(error.errMsg)
    },
  })
}
