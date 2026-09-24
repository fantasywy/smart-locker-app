// `13.x` 认证端点的请求形状 —— 手写请求函数，**只做搬运**（`07` §3 硬规则 2）。
//
// 契约出处：API设计文档.md §13.1 `POST /api/app/v1/auth/login` (:919-939)、
// §13.2 `POST /api/app/v1/auth/refresh` (:941-943)；`docs/spec/07-engineering-form.md`
// §4.3 硬约束 5、§4.4（token 口径）。
//
// ⚠️ **`api/` 不含业务分支**（`07` §3 硬规则 2）：本模块只做「入参 → 请求 → 出参 DTO」的搬运。
// 状态判断、文案、跳转全在页面（或页面共享的组件）里 —— 这样同一个端点在订单列表与详情页
// 被用到时不会长出两套语义。
//
// ⚠️ 本模块的两个函数**都走免鉴权出口**（`requestWithoutAuth`）：`13.1` / `13.2` 是
// `WebMvcConfig.java:46-47` 唯二排除在 `AppAuthInterceptor` 之外的端点（`07` §4.3 硬约束 5）。
// 登录链因此**不依赖登录态** —— 这是防递归的第一道，也是最重要的一道。

import type { LoginRequest, LoginResponse, RefreshResponse } from '../types/auth'
import type { RequestResult } from '../request/types'
import { requestWithoutAuth } from '../request'
// ⚠️ 路径从 `request/config.ts` import，**不在这里再写一遍字面量**：同一个字符串存在两处
// 就有漂移空间，而「豁免名单对不上真实请求路径」就是鉴权缺口（`07` §4.3 硬约束 5）。
import { LOGIN_PATH, REFRESH_PATH } from '../request/config'

/**
 * `13.1` 登录 / 首登自动注册 —— `POST /api/app/v1/auth/login`。
 *
 * 契约：API设计文档.md §13.1 (:919-939)
 *
 * 用 `wx.login` 拿到的临时 `code` 换双 token。openid **首次出现自动注册**
 * （初始信用分 `score.max`、状态 `NORMAL`，§13.1 :939）。
 *
 * ⚠️ **黑名单用户允许登录** —— 响应里的 `user.status` 可能是 `BLACKLISTED` 而**登录照样成功**
 * （§13.1 :939）。⚠️ 上面引的「黑名单」是**后端契约原文**，照引不误；但**用户可见文案里不出
 * 这个词**，一律说「受限」（`09` §8 禁用词表、`CONTEXT.md`「受限」）。
 * 本函数**不做任何基于 `status` 的阻断**（`04` §5「拦截权只能属于服务端」）
 * —— 它把 `status` 作为字段原样交给调用方，「只读、不判断」（见 `types/auth.ts` 的说明）。
 *
 * ⚠️ `code` 无效 / 微信侧错误 → `8001`（**HTTP 200**、业务错误，§15 :1307），
 * 归一化成 `kind: 'business'`，**不是** `unauthorized`。调用方据此走全局失败出口
 * （`01` §4），而不是去刷新 token。
 *
 * @returns 成功时 `{ ok: true, data }`，`data` 即 `LoginResponse`（`accessToken` /
 *          `refreshToken` / `expiresIn` / `user`）；失败时统一异常对象。
 *          ⚠️ **本函数不写 storage** —— 落盘是调用方（登录链）的决定，见 `api/auth/session.ts`。
 */
export function login(payload: LoginRequest): Promise<RequestResult<LoginResponse>> {
  return requestWithoutAuth<LoginResponse>(LOGIN_PATH, { method: 'POST', data: payload })
}

/**
 * `13.2` 刷新 access —— `POST /api/app/v1/auth/refresh`。
 *
 * 契约：API设计文档.md §13.2 (:941-943)
 *
 * ⚠️⚠️ **用 `X-Refresh-Token` 头，不是 Bearer access**（§13.2 :943、`R1` §13.2）。
 * refresh 的入参是请求头，请求体为空。
 *
 * ⚠️ 响应**只有** `{ accessToken, expiresIn }` —— **没有 `refreshToken`**（§13.2 :943）。
 * 调用方**只更新 access、refresh 原值保留**：`13.2` 是续期 access、**不轮换 refresh**。
 * 若写成「整个响应覆盖回 token 结构」，refresh 会变成 `undefined`，下一次请求提前撞上
 * `401 + 2005` 而被迫重登 —— 把一个 30 天的会话缩成一次刷新。
 * `request/token.ts` 的 `setAccessToken()` 只接一个参数，正是为了让那种写法**在类型上写不出来**。
 *
 * @returns 成功时 `{ ok: true, data }`，`data` 即 `RefreshResponse`。
 *          ⚠️ **本函数不写 storage**（同上，落盘归登录链）。
 */
export function refresh(refreshToken: string): Promise<RequestResult<RefreshResponse>> {
  return requestWithoutAuth<RefreshResponse>(REFRESH_PATH, {
    method: 'POST',
    header: { 'X-Refresh-Token': refreshToken },
  })
}
