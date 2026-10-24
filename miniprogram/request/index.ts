// 请求层的**唯一 HTTP 出口目录** —— 三条通道，同一套鉴权与归一化。
//
// | 通道 | 文件 | 职责 |
// |---|---|---|
// | `wx.request` | `request/index.ts`（本文件） | JSON 端点 |
// | `wx.uploadFile` / `wx.downloadFile` | `request/transfer.ts` | 文件上传 / 下载 |
//
// 三条通道共用 `request/recovery.ts` 的 Bearer 拼装与 401 恢复 —— 那是**全端唯一**的
// 恢复队列（上传撞 401 与普通请求撞 401 必须挂到同一次恢复上，否则冷启动会打出刷新风暴）。
//
// 职责边界（刻意收窄）：
//   负责：附加 token → 发请求 → 判 HTTP 状态 + body `code` → 归一化成统一异常对象 → 交给调用方。
//   不负责：弹 toast、弹 modal、决定跳哪儿、决定置灰谁。**一行 UI 副作用都没有。**
//
// ⚠️ 唯一的例外是登录失效处理 —— 它确实是全局的，所以它**在请求层内部被消费**，
// 页面完全不用管（「登录失效怎么办 → 不用管，请求层已处理」）。
// 即便如此，请求层也**不弹窗、不跳转**：它只负责「修好登录态然后重放」；修不好就把失败的
// 成因如实返回，呈现交给 #20 的启动闸门 / 全局失败出口。

import type { RequestOptions, RequestResult } from './types'
import { classifyFailure, classifyResponse } from './normalize'
import { BASE_URL, isAuthExempt } from './config'
import { withAuthHeader, withLoginRecovery } from './recovery'

/**
 * 发一条 HTTP 请求 —— **全端唯一的 `wx.request` 调用点**。
 *
 * @param path 端点路径（如 `/api/app/v1/orders`），**不含** baseUrl
 * @param options 方法 / 请求体 / 额外头
 * @returns 成功时 `{ ok: true, data }`（`data` 是契约响应体里 `data` 字段的原样 DTO）；
 *          失败时 `{ ok: false, error }`（统一异常对象四字段）
 *
 * ⚠️ **不抛异常、不弹窗**。异常以 `{ ok: false, error }` 的形式**返回**给调用方 ——
 * 这是请求层职责边界的落地：页面拿到的永远是异常对象，由页面决定怎么讲人话
 * （toast / 受限卡 / 就地行内说明）。
 *
 * 为什么是判别联合而不是 `throw`：「点击后解释」与「就地解释」都要求由调用点
 * 自己选形态；`throw` 会诱导出「到处 try/catch 然后弹 toast」的写法，而那正是
 * 要避免的（互相覆盖的 toast 会把受限卡提前弹掉）。判别联合还让 strict TS
 * 强迫调用方处理失败分支 —— 漏了就是编译错。
 * `401` **不会**从这里漏出去给页面：它由 `withLoginRecovery` 在内部消费掉。
 * 页面能拿到的失败只有「恢复登录态这件事本身失败了」那一类。
 *
 * ⚠️ **豁免名单内的路径不挂恢复逻辑**（这是递归防护的第二道闸门）。`auth-endpoints.ts` 走的是
 * `requestWithoutAuth`（第一道），但后来者用 `request()` 直接调 `13.1` / `13.2` 是很自然的
 * 写法（它「也是个端点」）—— 那时若照常挂上恢复，一次刷新失败会去刷新「这次刷新」，
 * 立刻打出无限递归。两道闸门都要能独立挡住。内容端点同理：它免税、也必须在登录链坏掉时可用，
 * 挂恢复只会让「退路」跟着登录态一起失败。
 */
export function request<T>(path: string, options: RequestOptions = {}): Promise<RequestResult<T>> {
  const attempt = (): Promise<RequestResult<T>> => send<T>(path, options, true)
  return isAuthExempt(path) ? attempt() : withLoginRecovery<T>(attempt)
}

/**
 * 发一条**免鉴权**请求 —— 不带 `Authorization`，且**不读** storage 里的 access。
 *
 * 给三处用：`13.1` 登录、`13.2` 刷新（`WebMvcConfig.java:46-47`），以及
 * `GET /contents/{key}`（spec #57 §13 的免鉴权新端点）。内容页走这条路的理由同样硬：
 * 登录链失败时 `failure-exit` 必须还能打开计费 / FAQ —— 退路不能依赖它要绕开的那条链。
 *
 * ⚠️ 为什么不靠「url 命中豁免名单就不加头」一条路走完：那样 `13.1` / `13.2` 仍会去读
 * storage 里的 access，一旦 storage 桩未被编排，就会在登录链路上炸出一个与登录无关的错。
 * 显式分成两条路，让「登录链不依赖登录态」这件事在**调用形状上**就成立。
 *
 * ⚠️ 它也**不挂**登录失效处理 —— 这正是递归防护的落地。
 * 若 `13.2` 也走那套逻辑，一次刷新失败会去刷新「这次刷新」，立刻打出无限递归。
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

  // ⚠️ 免鉴权端点**硬编码豁免**：登录 / 刷新两条固定路径，加上内容端点的路径前缀。
  // 两道闸门都必须放行才附加头 —— `withAuth` 是调用点的显式声明，
  // `isAuthExempt`（在 `withAuthHeader` 内）是名单兜底（第二道用在 `request()` 上，见那里的注释）。
  //
  // ⚠️ 这条拼装与 `transfer.ts` 共用 `recovery.ts` 的 `withAuthHeader()`：
  // 三条通道的 Bearer 只有一个来源。
  if (withAuth) withAuthHeader(path, header)

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
      // ⚠️ `{ ...header }` **必须复制一份**，不能把 `send()` 手里那个对象直接交出去。
      // 重放走的是同一个 `send()`，它会往同一个对象上再写一次 `Authorization`
      // —— 于是「第一次请求」交出去的那个引用会被后来的重放就地改写：
      // 记录里第一次请求带着的是**刷新后**的新令牌（测试据此断言「重放带新 access」会看到
      // 两个请求带的是同一个值，从而永远测不出令牌有没有真的换掉），
      // 更糟的是「第一次请求发了什么」这个事实在测试里被永久污染。
      // 一行复制换来「一次 `wx.request` 的入参在发出后不再变化」这个不变量。
      header: { ...header },
      success: (res) => {
        resolve(classifyResponse<T>(res.statusCode, res.data))
      },
      // ⚠️ 网络不通与超时在微信侧**都是 fail**（`network` 的前两个触发）。
      // 两者在客户端无法区分，也不该假装能区分 —— 都归 `network`。
      fail: (err) => {
        resolve(classifyFailure(err.errMsg))
      },
    })
  })
}
