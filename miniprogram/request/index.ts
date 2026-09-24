// 请求层的**唯一出口** —— 全端只有这里碰 `wx.request`（`07` §3 硬规则 1）。
//
// 契约出处：`docs/spec/07-engineering-form.md` §4（请求层逐条已定）、§4.1（只归一化、不弹窗）、
// §4.2（必须同时看 HTTP 状态码与 body `code`）、§4.3 硬约束 5（唯二免鉴权豁免）、§4.4（token 口径）。
// 上游：`docs/spec/01-entry-and-identity.md` §3（登录链）。
//
// ⚠️ 本票（#18）交付的是**归一化 + 冷启动登录链**。401 的单一飞行与排队重放属 #19，
// 启动闸门与全局失败出口属 #20 —— 所以本文件里**不存在**队列、不存在刷新重试，
// 唯一与 401 有关的行为是「**如实把它归一化成 `unauthorized` 并交给调用方**」。
//
// 职责边界（`07` §4.1，刻意收窄）：
//   负责：附加 token → 发请求 → 判 HTTP 状态 + body `code` → 归一化成统一异常对象 → 交给调用方。
//   不负责：弹 toast、弹 modal、决定跳哪儿、决定置灰谁。**一行 UI 副作用都没有。**

import type { RequestOptions, RequestResult } from './types'
import { classifyFailure, classifyResponse } from './normalize'
import { getAccessToken } from './token'
import { BASE_URL, isAuthExempt } from './config'

/**
 * 发一条 HTTP 请求 —— **全端唯一的 `wx.request` 调用点**。
 *
 * @param path 端点路径（如 `/api/app/v1/orders`），**不含** baseUrl
 * @param options 方法 / 请求体 / 额外头
 * @returns 成功时 `{ ok: true, data }`（`data` 是契约响应体里 `data` 字段的原样 DTO）；
 *          失败时 `{ ok: false, error }`（统一异常对象四字段，`07` §4.2）
 *
 * ⚠️ **不抛异常、不弹窗**。异常以 `{ ok: false, error }` 的形式**返回**给调用方 ——
 * 这是 `07` §4.1 的落地：页面拿到的永远是异常对象，由页面决定怎么讲人话
 * （toast / 受限卡 / 就地行内说明）。
 *
 * 为什么是判别联合而不是 `throw`：`04` §3 的「点击后解释」与 `06` §4.4 的就地解释要求
 * 调用点自己选形态；`throw` 会诱导出「到处 try/catch 然后弹 toast」的写法，而那正是
 * `07` §4.1 明令禁止的（互相覆盖的 toast 会把受限卡提前弹掉）。判别联合还让 strict TS
 * 强迫调用方处理失败分支 —— 漏了就是编译错。
 */
export function request<T>(path: string, options: RequestOptions = {}): Promise<RequestResult<T>> {
  return send<T>(path, options, true)
}

/**
 * 发一条**免鉴权**请求 —— 不带 `Authorization`，且**不读** storage 里的 access。
 *
 * 只给 `13.1` 与 `13.2` 用（`WebMvcConfig.java:46-47`，见 `config.ts` 的豁免名单）。
 *
 * ⚠️ 为什么不靠「url 命中豁免名单就不加头」一条路走完：那样 `13.1` / `13.2` 仍会去读
 * storage 里的 access，一旦 storage 桩未被编排，就会在登录链路上炸出一个与登录无关的错。
 * 显式分成两条路，让「登录链不依赖登录态」这件事在**调用形状上**就成立。
 */
export function requestWithoutAuth<T>(
  path: string,
  options: RequestOptions = {},
): Promise<RequestResult<T>> {
  return send<T>(path, options, false)
}

function send<T>(
  path: string,
  options: RequestOptions,
  withAuth: boolean,
): Promise<RequestResult<T>> {
  const header: Record<string, string> = { 'content-type': 'application/json' }
  for (const [key, value] of Object.entries(options.header ?? {})) header[key] = value

  // ⚠️ 免鉴权端点**硬编码豁免**（`07` §4.3 硬约束 5）：契约里只有 `/auth/login` 与
  // `/auth/refresh` 两个。两道闸门都必须放行才附加头 —— `withAuth` 是调用点的显式声明，
  // `isAuthExempt` 是名单兜底。后者防的是「有人用 `request()` 直接调 13.1」，
  // 那会让登录链自己可能触发登录态逻辑（#19 会在这上面挂刷新队列）。
  if (withAuth && !isAuthExempt(path)) {
    const access = getAccessToken()
    if (access !== null) header.Authorization = `Bearer ${access}`
  }

  return dispatch<T>(`${BASE_URL}${path}`, options, header)
}

/** `wx.request` 的一次调用 —— 包成 Promise，把原始事实交给归一化。 */
function dispatch<T>(
  url: string,
  options: RequestOptions,
  header: Record<string, string>,
): Promise<RequestResult<T>> {
  return new Promise<RequestResult<T>>((resolve) => {
    wx.request({
      url,
      method: options.method ?? 'GET',
      data: options.data,
      header,
      success: (res) => {
        resolve(classifyResponse<T>(res.statusCode, res.data))
      },
      // ⚠️ 网络不通与超时在微信侧**都是 fail**（`07` §4.2 的 `network` 前两个触发）。
      // 两者在客户端无法区分，也不该假装能区分 —— 都归 `network`。
      fail: (err) => {
        resolve(classifyFailure(err.errMsg))
      },
    })
  })
}
