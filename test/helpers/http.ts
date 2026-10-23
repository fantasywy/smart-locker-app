// 请求断言辅助 —— 「断言一组请求的到达顺序」与「按 URL 提问」。
//
// 为什么单独一层：请求层的核心断言全是「**恰好一次**」与「**按序**」——「一个 401 只触发
// 一次刷新」「排队请求在续期成功后按原样重放」。直接翻 `wxStub.request.mock.calls` 会把
// 「第几个参数、options 里哪一层」这些噪音散到每个用例里，且一旦桩的形状变了就全线碎掉。
//
// ⚠️ 这里只读**一个** mock 的调用记录，不碰内部实现 —— 断言的对象是「发出了什么请求」，
// 不是「请求层内部怎么排队」。
//
// 这条口径的出处是 **issue #15 的 Testing Decisions**
// （「只断言外部行为……不断言内部实现：不测拦截器链表形状、不测队列的内部数据结构」），
// 连同「引入 Vitest」的裁决（#15 decision 22）也在那里。
// ⚠️ 容易引错，别再引回去：
//   • **不是** #16 —— #16 是那张**执行**票（「测试载体 + wx.* 桩」），
//     只承接 #15 已定的裁决，正文里没有 Testing Decisions 一节。

import type { Mock } from 'vitest'
import type { WxRequestOptions, WxRequestSuccessResult } from './wx'

/** 一条已发出的请求，压平成测试关心的四个字段。 */
export interface SentRequest {
  url: string
  method: string
  header: Record<string, string>
  data: unknown
}

/** 把 `wxStub.request` 的调用记录压平成请求列表（按发出顺序）。 */
export function sentRequests(requestMock: Mock<(options: WxRequestOptions) => void>): SentRequest[] {
  return requestMock.mock.calls.map(([options]) => ({
    url: options.url,
    // 微信侧不传 method 时默认 GET。
    method: (options.method ?? 'GET').toUpperCase(),
    header: options.header ?? {},
    data: options.data,
  }))
}

/** 把请求列表压成 URL 序列 —— 「到达顺序」断言读起来最直接的形式。 */
export function urlsOf(requests: SentRequest[]): string[] {
  return requests.map((r) => r.url)
}

/** 指向某个 URL 的请求（可能有多个）。 */
export function requestsTo(requests: SentRequest[], url: string): SentRequest[] {
  return requests.filter((r) => r.url === url)
}

/**
 * 让一个已编排好返回值的 `wx.request` 桩真正「回话」。
 *
 * 桩本身是 `vi.fn`，`mockResolvedValueOnce` 只是让它返回一个 Promise —— 而 `wx.request`
 * 是**回调式** API，请求层等的是 `options.success(...)`。这个函数把两者接起来：
 * 每次调用按顺序取一个已编排的返回值，走 success / fail 回调。
 *
 * ```ts
 * wxStub.request.mockImplementation(respondInOrder([
 *   jsonResponse({ code: 0, data: null, message: 'ok' }),
 *   networkFailure(),
 * ]))
 * ```
 */
export function respondInOrder(
  results: readonly (WxRequestSuccessResult | { errMsg: string })[],
): (options: WxRequestOptions) => void {
  let index = 0
  return (options: WxRequestOptions) => {
    const result = results[index]
    index += 1
    if (result === undefined) {
      throw new Error(
        `wx.request 第 ${index} 次被调用，但只编排了 ${results.length} 个响应。\n` +
          `    → 用 respondInOrder([...]) 补齐，或断言这次调用本不该发生。`,
      )
    }
    // 用 queueMicrotask 投递，保持微信侧「回调不在同一个 tick 里同步触发」的时序特征。
    queueMicrotask(() => {
      if ('statusCode' in result) options.success?.(result)
      else options.fail?.(result)
    })
  }
}

/** 一条按 URL 特征分流的响应队列。 */
export interface ResponseRoute {
  /** 这条流处理哪些请求。 */
  match: (options: WxRequestOptions) => boolean
  results: readonly (WxRequestSuccessResult | { errMsg: string })[]
}

/**
 * 让 `wx.request` 桩按**请求分流**回话，每条流各自按顺序消耗自己的响应。
 *
 * ## 为什么需要它（而不是继续用 `respondInOrder`）
 *
 * 一个页面同时持有**两条独立的流**时（附近页：列表流 `pageSize=20` + 地图流
 * `pageSize=100`），按「到达顺序」编排响应会让每个用例的数组都变成
 * `[列表1, 地图1, 列表2, 地图2, ...]` 的交错写法 —— 既难读，又会在某次实现调整
 * （比如地图流改成延后一发）时**整片红**，而每一处的失败都不是行为变化。
 *
 * 按 URL 分流后，用例只需要说「列表流依次回这几个、地图流依次回这几个」，
 * 与两条流各自的业务顺序一一对应。
 *
 * ⚠️ 没有匹配到任何一条流的请求会**立刻抛错** —— 与「未编排即失败」同一取向：
 * 新增一条流却忘了编排，会在这里现形，而不是静默拿到一个错响应。
 */
export function respondByRoute(
  routes: readonly ResponseRoute[],
): (options: WxRequestOptions) => void {
  const indices = routes.map(() => 0)
  return (options: WxRequestOptions) => {
    const routeIndex = routes.findIndex((route) => route.match(options))
    if (routeIndex === -1) {
      throw new Error(
        `wx.request 发向了没有编排的流：${options.url}\n` +
          `    → 用 respondByRoute([...]) 补一条 match，或断言这次调用本不该发生。`,
      )
    }
    const route = routes[routeIndex] as ResponseRoute
    const index = indices[routeIndex] as number
    indices[routeIndex] = index + 1
    const result = route.results[index]
    if (result === undefined) {
      throw new Error(
        `某条流第 ${index + 1} 次被调用，但只编排了 ${route.results.length} 个响应。\n` +
          `    → 补齐这条流的响应，或断言这次调用本不该发生。`,
      )
    }
    queueMicrotask(() => {
      if ('statusCode' in result) options.success?.(result)
      else options.fail?.(result)
    })
  }
}
