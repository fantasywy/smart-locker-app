// 请求断言辅助 —— 「断言一组请求的到达顺序」与「按 URL 提问」。
//
// 为什么单独一层：`07` §4.3 的核心断言全是「**恰好一次**」与「**按序**」——「一个 401 只触发
// 一次刷新」「排队请求在续期成功后按原样重放」。直接翻 `wxStub.request.mock.calls` 会把
// 「第几个参数、options 里哪一层」这些噪音散到每个用例里，且一旦桩的形状变了就全线碎掉。
//
// ⚠️ 这里只读**一个** mock 的调用记录，不碰内部实现 —— 与 `07` §7 的「测试只断言外部行为」
// 一致：断言的对象是「发出了什么请求」，不是「请求层内部怎么排队」。

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
