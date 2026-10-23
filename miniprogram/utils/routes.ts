// **页面路径常量** —— `wx.*To` 的 url 目标，一个路径一个家。
//
// 各路径的**用途**逐条标在常量上。
//
// ## 为什么路径值得一个模块（而不是写在调用点）
//
// ⚠️⚠️ **跳转 API 写错路径是静默失败**：`wx.navigateTo` / `redirectTo` / `switchTab`
// 拿到一个不存在的（或不匹配的）路径时，**不跳转、不报错、不返回失败** ——
// 按钮点下去什么都不发生。这与 `#23` 修的那个「死按钮」是**同一个用户症状**，
// 只是更难查：调用发生了、控制台干净的、画面没动。
//
// 路径在 `app.json`（原生 JSON，**引不到 TS**）里有一份，在调用点又各有一份 ——
// 漂移空间是真实存在的，而且漂移之后**没有任何东西会报错**。
// 集中到这里，至少让「有哪些页面被跳转过」这件事在一处可查。
//
// ## 本模块只放「被跳转的路径」
//
// ⚠️ 不是把所有页面路径都搬过来。别的页面通过 `startup/copy.ts` 的 `PAGE_TITLES`
// 用页面自己的路径当键查标题 —— 那是**查表**，不是**跳转目标**，两者不该混。
// 这里只放**代码里主动跳过去**的那几个，因为只有它们有写错即静默失败的风险。
//
// ⚠️ 本模块**只有常量，没有行为**（克制取向：不编不存在的需求）。
// 页面自己的逻辑不长在这里。

import type { PagePath, StaticExitId } from '../startup/copy'

/**
 * 等待态的页面路径 —— `app.json` 已注册（`#22` 一次配齐 10 个页面）。
 *
 * 用途：等待态的**三条入口**（建单 `13.7` / 转单 `13.15` / 支付 `13.11`）一律
 * **`redirectTo`** 进这一页。⚠️ 三条入口在同一页上汇合，所以这个串出现在三处代码里 ——
 * 这正是它必须是常量而不是字面量的理由。
 *
 * ⚠️ 跳转时必须拼成 `/${WAITING_PATH}`（`wx.*To` 的 url 要**以 `/` 开头**，
 * 否则微信按**相对当前页面**解析 —— 另一类静默失败）。
 */
export const WAITING_PATH = 'pages/waiting/waiting'

/**
 * **柜机页**的页面路径 —— 首页扫码通道 B 的落点。
 *
 * 用途：首页 `wx.scanCode` 解析出柜机码后，`wx.navigateTo` 叠到当前栈上并带 `code`。
 * ⚠️ 必须是 **`navigateTo`**，不是 `redirectTo` / `switchTab`：柜机页不是 tabBar 页，
 * 而用户从首页出发，返回键应当回到首页（而不是退出小程序）。通道 A（微信扫一扫
 * 冷启动直达）由平台负责，不走这个常量。
 *
 * ⚠️ 与其它路径同样，不在页面里写字面量 —— `wx.*To` 拿到不存在的路径是**静默失败**，
 * 与「点了没反应」是同一个用户症状。`app.json` 里的注册由测试比对。
 */
export const LOCKER_PATH = 'pages/locker/locker'

/**
 * 预约创建页的页面路径 —— `app.json` 已注册。
 *
 * 用途：柜机页的「预约」次要入口（「创建入口**只在柜机页**」——
 * `lockerId` 的唯一来源是 `13.6`，所以这个页面只有一个入口，且它带 `lockerId`）。
 *
 * ⚠️ 它与 `WAITING_PATH` 同为「被主动跳过去的路径」，因此同住本模块 ——
 * 而不是在柜机页里写一个字面量。柜机页里写死过一个（review 抓到的），
 * 那时本模块的注释正在为完全相同的理由解释 `WAITING_PATH` 为什么不能是字面量。
 */
export const RESERVATION_CREATE_PATH = 'pages/reservation-create/reservation-create'

/**
 * **首页**的页面路径 —— 导航栏栈深 1 时左侧「首页」出口的目标。
 *
 * ⚠️ 与 `ORDER_LIST_PATH` 分开命名：`#66` 之前两者恰好都指向 `pages/index/index`
 * （首页暂时承载订单列表）；`#66` 之后订单列表迁到独立 tab，两者会分开。
 * 现在就把语义分开，`home()` 与 `orders()` 才不会在迁移时被一起改错 ——
 * `wx.switchTab` 的目标写错是**静默失败**，正是本模块存在的理由。
 *
 * ⚠️ 必须保持为 `app.json` 的 `tabBar.list[].pagePath` 之一；守卫见
 * `test/components/navigation-bar.test.ts`。
 */
export const HOME_PATH: PagePath = 'pages/index/index'

/**
 * **计费说明页**的路径 —— 失败出口静态出口之一（issue #68）。
 *
 * 用途：首页的全局失败出口（登录链失败）里，「计费说明」必须真的能打开 ——
 * 它是用户在「连不上」时仍可查看的规则页；内容端点免鉴权正是为这条路服务的。
 *
 * ⚠️ 用 `navigateTo`（不是 `switchTab`）：它不是 tab 页；从首页出发，返回键应回首页。
 * ⚠️ 类型写成 `PagePath`：`PAGE_TITLES` 的键就是 `app.json` 注册表，
 * 这条类型让「路径写错 / 页面没注册」在编译期就报错，而不是变成一次静默失败。
 */
export const BILLING_INFO_PATH: PagePath = 'pages/billing-info/billing-info'

/**
 * **常见问题页**的路径 —— 失败出口静态出口之二（issue #68）。
 *
 * 用途与 `BILLING_INFO_PATH` 相同：登录链失败时也要能打开。
 */
export const FAQ_PATH: PagePath = 'pages/faq/faq'

/**
 * **信用分明细页**的路径 —— 「我的」页信用分卡「明细 ›」的目标（issue #69）。
 *
 * ⚠️ 用 `navigateTo`（不是 `switchTab`）：它不是 tab 页；从「我的」出发，返回键应回「我的」。
 * 与其它路径同理，写成常量而不是在页面里写 `pages/...` 字面量 —— 路径写错是静默失败。
 */
export const SCORE_LOGS_PATH: PagePath = 'pages/score-logs/score-logs'

/**
 * **我的预约页**的路径 —— 「我的」页「我的服务 → 我的预约」的目标（issue #69）。
 *
 * ⚠️ 用 `navigateTo`：它不是 tab 页；从「我的」出发，返回键应回「我的」。
 * 创建预约的唯一入口仍在柜机页，本页只是列表出口，不提供「新建预约」。
 */
export const RESERVATION_LIST_PATH: PagePath = 'pages/reservation-list/reservation-list'

/**
 * 静态出口的**行为 id → 路由**映射 —— 首页失败出口与「我的」页共用同一张表。
 *
 * ⚠️ 键是 `STATIC_EXITS` 的 `id`，**不是 label**：`STATIC_EXITS` 把「行为」与「措辞」解耦；
 * 按文案选目标会在改词那天让入口静默失效。`contact` 不在这张表里 —— 它由
 * `open-type="contact"` 原生承载，页面不做任何降级。
 *
 * ⚠️ 两页共用本表（而不是各自写一份两行 map）：同一组出口的目标必须只有一个家。
 */
export const STATIC_EXIT_PATHS: Partial<Record<StaticExitId, PagePath>> = {
  billing: BILLING_INFO_PATH,
  faq: FAQ_PATH,
}
