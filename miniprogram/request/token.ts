// token 的**持久化** —— 全端唯一读写 access / refresh 的地方。
//
// 契约出处：`docs/spec/07-engineering-form.md` §4.4「token 存储与过期判定」（已定案）。
//
// 三条口径，逐条都是裁决而不是实现细节：
//
// 1. **access 与 refresh 都持久化到 `storage`**。理由：access 2h / refresh 30d
//    （`API:933,:941`）—— 若不持久化，两个有效期设置在 C 端毫无意义。微信 `storage`
//    无有效期限，与两者语义相合。
//
// 2. ⚠️ **不在本地预判过期、不记 `expiresIn`、不比对本地时钟，完全靠 401 驱动。**
//    理由：本地时钟偏移会导致误刷或漏刷，而 **401 才是权威信号**，且已有成熟处理链
//    （`07` §4.3）。少一份状态、少一处出错点。
//    ⇒ 本模块**刻意不导出**任何形如 `isAccessExpired()` 的函数，也不存 `expiresAt`。
//      `LoginResponse.expiresIn` 落进类型层只是为了如实反映后端形状，**不是**给人算过期的。
//
// 3. **唯一读写入口**。`07` §6 规定登录态是「只在请求层内部」的状态，不是 UI 状态
//    （页面从不读它）。集中在一处还有一个收益：将来若加「退出登录」（一期不做，
//    `01` §5 有意不做），只需改这一个文件。
//
//    ⚠️ 但**本票只提供当前真正被用到的读 / 写**：`getAccessToken` / `getRefreshToken` /
//    `saveTokens` / `setAccessToken`。清态（`clearTokens`）与刷新都属 #19，
//    等它们有调用点时再写进来 —— 不为了「读写面完整」而提前放一个无人调用的破坏性函数。
//
// ⚠️ 已知副作用（**有意接受，勿当缺陷修**，`07` §4.4 已登记）：
// token 持久化叠加「不做退出登录」⇒ **App 内没有任何清除登录身份的入口**，
// 用户唯一的「退出」方式是删除小程序或清微信存储。这是两条既有裁决的必然结果。

/** `storage` 的 key。加前缀避免与将来别的模块撞名。 */
const ACCESS_TOKEN_KEY = 'auth.accessToken'
const REFRESH_TOKEN_KEY = 'auth.refreshToken'

/**
 * 读 access token —— 没有则返回 `null`。
 *
 * ⚠️ 返回值**不判断有效性**。它可能早就过期了 —— 那由服务端的 401 告诉我们，
 * 不由本地时钟猜（`07` §4.4）。
 */
export function getAccessToken(): string | null {
  return readToken(ACCESS_TOKEN_KEY)
}

/**
 * 读 refresh token —— 没有则返回 `null`。
 *
 * 冷启动时「有没有 refresh token」就是 `01` §3.4 状态机的第一个分叉点：
 * 有 → 直接带 access 发业务请求；无 → `wx.login` → `13.1`。
 */
export function getRefreshToken(): string | null {
  return readToken(REFRESH_TOKEN_KEY)
}

/**
 * 落盘登录结果 —— access 与 refresh **一起**写。
 *
 * 只在 `13.1` 成功后调用。⚠️ 刷新（`13.2`）**不走这里**，见 `setAccessToken` 的注释。
 */
export function saveTokens(accessToken: string, refreshToken: string): void {
  wx.setStorageSync(ACCESS_TOKEN_KEY, accessToken)
  wx.setStorageSync(REFRESH_TOKEN_KEY, refreshToken)
}

/**
 * ⚠️ **只更新 access，refresh 原值保留。**
 *
 * `13.2` 的响应里**没有** `refreshToken`（只有 `{ accessToken, expiresIn }`，
 * 见 `types/auth.ts` 的 `RefreshResponse`）—— 它是**续期 access，不轮换 refresh**：
 * refresh 30 天有效、可主动作废（登出），与 access 是两套生命周期。
 *
 * 后来者最容易在这里写成「把响应整个覆盖回 token 结构」，那会把 refresh 写成 `undefined`，
 * 于是下一次请求提前撞上 `401 + 2005` 而被迫重登 —— **把一个 30 天的会话缩成一次刷新**。
 * 本函数只接一个参数，正是为了让那种写法**在类型上就写不出来**。
 */
export function setAccessToken(accessToken: string): void {
  wx.setStorageSync(ACCESS_TOKEN_KEY, accessToken)
}

/**
 * ⚠️ **刻意没有 `clearTokens()`。** 清登录态属 #19 的 `401 + 2005` 链路（清态重登），
 * 本票（#18）没有任何调用点。
 *
 * 早先这里有一个「为了读写面完整」而提前加上的 `clearTokens()` —— 那是 Speculative
 * Generality：**没有任何验收标准要求它**，而 #19 真要清态时，它会连同自己的测试一起
 * 写在这里（成本几乎为零）。提前放一个无人调用的破坏性函数，收益是零、风险是
 * 「后来者以为它已经在某处被用上了」。
 */

/**
 * 从 `storage` 读一个 token。
 *
 * ⚠️ 只有**非空字符串**才算读到了 token。微信 `storage` 能存任何东西，历史版本、
 * 别的模块、或手工写坏的值都可能是 `0` / `{}` / `''`；把它们当 token 用会发出
 * `Authorization: Bearer [object Object]` 这种请求，然后收到一个与真实原因无关的 401。
 * 判成「没有」让状态机走干净的 `wx.login` 重登路径。
 */
function readToken(key: string): string | null {
  const value: unknown = wx.getStorageSync(key)
  if (typeof value !== 'string' || value === '') return null
  return value
}
