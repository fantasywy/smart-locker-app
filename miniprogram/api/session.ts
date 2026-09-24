// **冷启动登录链** —— `wx.login` → `13.1` → 双 token 落 `storage`。
//
// 契约出处：`docs/spec/01-entry-and-identity.md` §3（登录链：§3.1 隐式前置登录、
// §3.2 冷启动表现、§3.4 登录态状态机）、`docs/spec/07-engineering-form.md`
// §4.3（硬约束 5）、§4.4（token 持久化定案）。
//
// 本模块是 `01` §3.4 状态机**冷启动那一半**的落地：
//
//     启动
//      └─ 有 refresh token？ ──无──→ [静默登录 wx.login → 13.1]
//                               └─有─→ 带 access 发请求
//
// ⚠️ 本票（#18）**只做分叉与「无 refresh」那条路**。有 refresh 时「带 access 发请求 →
// 撞 401 → 刷新 / 重登」属 #19，启动闸门与全局失败出口属 #20。
// 「有 refresh」在这里的正确行为就是**什么都不做**（直接放行）—— 见 `ensureLoggedIn`。
//
// ⚠️ **不在本地预判过期**（`07` §4.4 已定案）：本模块不读 `expiresIn`、不存 `expiresAt`、
// 不比本地时钟。access 对不对由服务端说了算 —— 本地时钟偏移会误刷或漏刷，而 401 才是权威
// 信号。所以「有 refresh 就直接发业务请求」，哪怕那个 access 可能早就过期了。
//
// ⚠️ **不做退出登录**（`01` §5 有意不做）：本模块不提供清态入口。已知副作用
// （token 长期存在 storage、App 内无清除入口）登记在 `07` §4.4，**不是缺陷**。

import type { LoginResponse } from '../types/auth'
import type { UnifiedError } from '../request/types'
import { login } from './auth'
import { getRefreshToken, saveTokens } from '../request/token'

/**
 * 确保登录态可用 —— **冷启动的登录链入口**。
 *
 * 行为（`01` §3.4 的第一个分叉）：
 *   • storage 里**有** refresh token → **直接返回成功，不发任何请求**。
 *     此时 access 可能已过期 —— 那由下一次业务请求的 401 驱动刷新（#19），
 *     **不在这里预判**（`07` §4.4）。
 *   • storage 里**没有** refresh token → `wx.login` 取 `code` → `13.1` → 双 token 落 storage。
 *
 * ⚠️ **不抛异常、不弹窗**（与请求层同一取向）。失败以 `{ ok: false, error }` 返回，
 * 由启动闸门（#20）决定怎么讲 —— 它会把这里的失败呈现为 `01` §4 的全局唯一失败出口。
 *
 * ⚠️ `user.status === 'BLACKLISTED'` 时**照样返回成功**：黑名单用户允许登录
 * （`01` §1.4、`13.1` :939）。本函数**不得**据此阻断 —— `04` §5 明令「拦截权只能属于服务端」，
 * 本地快照会造出双源真相，还会把已解禁用户挡在门外。`status` 由调用方只读、不判断。
 *
 * @returns 成功时 `{ ok: true, data }`：`data` 是**本次登录**的用户信息（`null` 表示
 *          走的是「已有 refresh」的免请求路径 —— 那时我们没有新的用户信息，**不编一个**）。
 */
export async function ensureLoggedIn(): Promise<EnsureLoggedInResult> {
  // ⚠️ 只判「**有没有** refresh token」，**不判它有没有过期**（`07` §4.4 不预判）。
  const existingRefresh = getRefreshToken()
  if (existingRefresh !== null) {
    // 已有刷新令牌 ⇒ 登录身份已存在。**直接放行**，不因本地时间跳过、也不预刷一次。
    return { ok: true, data: null }
  }

  const code = await readLoginCode()
  if (!code.ok) return code

  const result = await login({ code: code.data })
  if (!result.ok) return result

  // ⚠️ 落盘在**这里**，不在 `api/auth.ts` —— `api/` 只做搬运（`07` §3 硬规则 2），
  // 「双 token 持久化」是登录链的裁决（`07` §4.4），属于本模块。
  saveTokens(result.data.accessToken, result.data.refreshToken)

  return { ok: true, data: result.data }
}

/** `ensureLoggedIn` 的结果 —— 成功时携带本次登录的用户信息（免请求路径上为 `null`）。 */
export type EnsureLoggedInResult =
  | { ok: true; data: LoginResponse | null }
  | { ok: false; error: UnifiedError }

/**
 * `wx.login` 取临时 `code` —— 包成 Promise，并把失败归成 `network`。
 *
 * ⚠️ `wx.login` 也会失败（网络不通、微信侧异常）。它不是 HTTP 往返，因此没有状态码与
 * 业务码 —— 归 `network`（`07` §4.2 第一个触发），`message` 用微信侧 `errMsg` 原样承载
 * 作诊断信息。**不能**因为「拿不到 code」就抛一个裸错误上去：`01` §4 的失败成因可穷举，
 * 其中就有「`wx.login` 失败」这一条，它必须和别的失败长得一样。
 */
function readLoginCode(): Promise<{ ok: true; data: string } | { ok: false; error: UnifiedError }> {
  return new Promise((resolve) => {
    wx.login({
      success: (res) => {
        resolve({ ok: true, data: res.code })
      },
      fail: (err) => {
        resolve({
          ok: false,
          error: { httpStatus: null, code: null, message: err.errMsg, kind: 'network' },
        })
      },
    })
  })
}
