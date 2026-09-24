// `13.1` / `13.2` 的**请求形状** —— 登录失效处理自己的两个调用口。
//
// 契约出处：API设计文档.md §13.1 `POST /api/app/v1/auth/login` (:919-939)、
// §13.2 `POST /api/app/v1/auth/refresh` (:941-943)；`docs/spec/07-engineering-form.md`
// §4.3（硬约束 4 / 5）、§4.4（token 口径）。
//
// ⚠️ **为什么这两个函数在 `request/` 里，而不在 `api/` 里。**
//
// `07` §4 开头写着「请求层是唯一的 HTTP 出口，**也是登录失效处理的唯一场所**」。
// 而登录失效处理必须**自己**去调 `13.1` / `13.2` —— 于是产生一个导入方向的矛盾：
//
//     api/auth.ts  ──import──▶  request/index.ts     （端点函数用请求出口，天经地义）
//     request/index.ts ──import──▶  api/auth.ts      （恢复逻辑要调 13.1 / 13.2）
//
// 两行同时存在就是**模块循环**。循环不会在类型上报错，也不一定立刻炸 —— 只有当某一方
// 在**模块求值期**（顶层常量、装饰器、立即执行的表达式）用到另一方时，才会拿到 `undefined`。
// 今天是「碰巧没事」，而这正是最坏的一类债：它在未来某次无害的重构里突然显形，
// 且症状（`login is not a function`）与改动毫无关系。
//
// **⇒ 依赖必须单向。** `api/` 依赖 `request/`，`request/` 绝不依赖 `api/` —— 因此
// 「请求层自己要用的两个端点形状」放在这里，`api/auth.ts` 再把它们**导出给页面用**。
// 分成两个文件而不是塞进 `index.ts`：`index.ts` 的主题是「出口 + 失效处理」，
// 端点的 URL / 方法 / 头是另一件事（`Divergent Change`）。
//
// ⚠️ 这里**不是** `api/` 的一部分，也**不违背** `07` §3 硬规则 2：「`api/` 不含业务分支」
// 约束的是**搬运层的语义**（不判状态、不给文案、不跳转）。本模块与 `api/auth.ts` 一样
// 只做搬运，一个业务分支都没有 —— 它只是**被请求层自己消费**的那一份。

import type { LoginRequest, LoginResponse, RefreshResponse } from '../types/auth'
import type { RequestResult } from './types'
import { requestWithoutAuth } from './index'
// ⚠️ 路径从 `config.ts` import，**不在这里再写一遍字面量**：同一个字符串存在两处
// 就有漂移空间，而「豁免名单对不上真实请求路径」就是鉴权缺口（`07` §4.3 硬约束 5）。
import { LOGIN_PATH, REFRESH_PATH } from './config'

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
 *          ⚠️ **本函数不写 storage** —— 落盘是调用方（登录链 / 清态重登）的决定，
 *          见 `api/auth/session.ts` 与 `request/index.ts` 的 `relogin()`。
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
 * `token.ts` 的 `setAccessToken()` 只接一个参数，正是为了让那种写法**在类型上写不出来**。
 *
 * @returns 成功时 `{ ok: true, data }`，`data` 即 `RefreshResponse`。
 *          ⚠️ **本函数不写 storage**（同上，落盘归调用方）。
 */
export function refresh(refreshToken: string): Promise<RequestResult<RefreshResponse>> {
  return requestWithoutAuth<RefreshResponse>(REFRESH_PATH, {
    method: 'POST',
    header: { 'X-Refresh-Token': refreshToken },
  })
}
