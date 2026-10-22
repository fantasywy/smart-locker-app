// 测试载体的自证 —— issue #16 的验收标准：
//
// > 一条演示性断言证明上述能力可用（例如：编排 `wx.request` 返回非 JSON → 断言得到预期的
// > 归一化结果），且该断言**不是**业务逻辑测试。
//
// ⚠️ 这个文件**不测请求层**。请求层还不存在（它是 `#18`/`#19` 的交付物）。这里测的是
// **载体本身**：桩能不能逐次编排、计时器能不能被驱动、请求顺序能不能被断言、隔离是不是真的。
//
// 方法：在测试里**现写一个最小的归一化函数**（`normalize`），用它把桩编排出的响应走一遍。
// 这样既演示了票面要求的那条断言形态（非 JSON → `network`），又不会把任何还不存在的
// 业务逻辑偷偷定义在测试里。`normalize` 实现完之后，`#18` 的请求层才是它的真身。

import { describe, expect, it } from 'vitest'
import { installWxStub, jsonResponse, networkFailure } from './helpers/wx'
import type { WxRequestSuccessResult } from './helpers/wx'
import { installFakeTimers } from './helpers/timers'
import { requestsTo, respondInOrder, sentRequests, urlsOf } from './helpers/http'

// ---------- 演示用的最小归一化（不是业务逻辑，只服务本文件的断言） ----------
// 形状承 `07` §4.2 的统一异常对象四字段。刻意只写演示所需的分支。
interface NormalizedError {
  httpStatus: number | null
  code: number | null
  message: string | null
  kind: 'network' | 'business' | 'unauthorized'
}

type Normalized = { ok: true; data: unknown } | { ok: false; error: NormalizedError }

function normalize(result: WxRequestSuccessResult | { errMsg: string }): Normalized {
  if (!('statusCode' in result)) {
    return { ok: false, error: { httpStatus: null, code: null, message: null, kind: 'network' } }
  }
  const body = result.data
  // 非 JSON 响应 = 连 code 都读不出来 —— 这是 `network` 的第三个触发（`07` §4.2）。
  if (typeof body !== 'object' || body === null || !('code' in body)) {
    return { ok: false, error: { httpStatus: result.statusCode, code: null, message: null, kind: 'network' } }
  }
  const { code, message, data } = body as { code: number; message?: string; data: unknown }
  if (result.statusCode === 401) {
    return { ok: false, error: { httpStatus: 401, code, message: message ?? null, kind: 'unauthorized' } }
  }
  if (code === 0) return { ok: true, data }
  return { ok: false, error: { httpStatus: result.statusCode, code, message: message ?? null, kind: 'business' } }
}

describe('测试载体自证', () => {
  it('桩能逐次编排返回值：同一个方法先后返回不同结果', async () => {
    const wx = installWxStub()
    wx.getStorageSync.mockReturnValueOnce('first').mockReturnValueOnce('second')

    expect(wx.getStorageSync('k')).toBe('first')
    expect(wx.getStorageSync('k')).toBe('second')
    expect(wx.getStorageSync).toHaveBeenCalledTimes(2)
  })

  it('未编排的调用立刻失败，而不是静默成功', () => {
    const wx = installWxStub()
    // 这条断言防的是「忘了编排 → 假通过」。桩必须自己喊出来。
    expect(() => wx.login({ success: () => undefined })).toThrowError(/没有编排它的返回值/)
  })

  it('演示性断言：wx.request 返回非 JSON → 归一化为 network，code 为 null', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation(
      respondInOrder([
        // 典型形态：网关 502 吐了一页 HTML，而不是 JSON。
        { statusCode: 502, data: '<html>502 Bad Gateway</html>', errMsg: 'request:ok' },
      ]),
    )

    const result = await new Promise<Normalized>((resolve) => {
      wx.request({
        url: 'https://example.test/api/app/v1/orders',
        method: 'GET',
        success: (res) => resolve(normalize(res)),
        fail: (err) => resolve(normalize(err)),
      })
    })

    expect(result).toEqual({
      ok: false,
      error: { httpStatus: 502, code: null, message: null, kind: 'network' },
    })
    // 顺带证明「发出了什么请求」是可断言的 —— 断言的对象是外部行为，不是内部实现。
    expect(urlsOf(sentRequests(wx.request))).toEqual(['https://example.test/api/app/v1/orders'])
  })

  it('演示性断言：200 + code 0 不被误判为异常', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation(respondInOrder([jsonResponse({ code: 0, data: { id: 7 }, message: 'ok' })]))

    const result = await new Promise<Normalized>((resolve) => {
      wx.request({ url: '/x', success: (res) => resolve(normalize(res)), fail: (err) => resolve(normalize(err)) })
    })

    expect(result).toEqual({ ok: true, data: { id: 7 } })
  })

  it('fake timer 能驱动超时，而不真的等待', async () => {
    const wx = installWxStub()
    const timers = installFakeTimers()

    // 没编排响应 ⇒ 请求永远不会回话，只有超时这条路会走到。
    wx.request.mockImplementation(() => undefined)

    // 模拟请求层的超时口径：wx.request 迟迟不回调 → 自己掐表判超时。
    const outcome = new Promise<Normalized>((resolve) => {
      const timer = setTimeout(() => {
        resolve(normalize(networkFailure('request:fail timeout')))
      }, 60_000)
      wx.request({
        url: '/slow',
        success: (res) => {
          clearTimeout(timer)
          resolve(normalize(res))
        },
        fail: (err) => {
          clearTimeout(timer)
          resolve(normalize(err))
        },
      })
    })

    const startedAt = timers.now()
    await timers.tick(60_000)

    expect(await outcome).toEqual({
      ok: false,
      error: { httpStatus: null, code: null, message: null, kind: 'network' },
    })
    expect(timers.now() - startedAt).toBe(60_000) // 时钟真的前进了 60s，而挂钟只过了几毫秒
  })

  it('fake timer 能驱动延迟响应：闸门未开时请求确实还没回来', async () => {
    const wx = installWxStub()
    const timers = installFakeTimers()

    let settled: Normalized | null = null
    wx.request.mockImplementationOnce((options) => {
      // 刻意延迟 500ms 才回话 —— 模拟「刷新还在飞」的那个窗口。
      setTimeout(() => options.success?.(jsonResponse({ code: 0, data: 'late', message: 'ok' })), 500)
    })

    const pending = new Promise<Normalized>((resolve) => {
      wx.request({ url: '/delayed', success: (res) => resolve(normalize(res)), fail: (err) => resolve(normalize(err)) })
    }).then((r) => {
      settled = r
      return r
    })

    await timers.settle()
    expect(settled).toBeNull() // 还没到点

    await timers.tick(500)
    expect(await pending).toEqual({ ok: true, data: 'late' })
  })

  it('能断言一组请求的到达顺序', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation(respondInOrder([jsonResponse({ code: 0, data: null }), jsonResponse({ code: 0, data: null })]))

    wx.request({ url: '/api/app/v1/auth/refresh', method: 'POST' })
    wx.request({ url: '/api/app/v1/orders', method: 'GET' })

    const sent = sentRequests(wx.request)
    expect(urlsOf(sent)).toEqual(['/api/app/v1/auth/refresh', '/api/app/v1/orders'])
    expect(requestsTo(sent, '/api/app/v1/auth/refresh')[0]?.method).toBe('POST')
  })
})

describe('桩的隔离', () => {
  // ⚠️ 每个用例开始时全局必须是干净的 —— 这才是真正的「进入测试时的状态」。
  // 上一版把「设进去」和「已经没了」拆成两个用例，于是第二半**静默依赖执行顺序**：
  // 谁在中间插一个用例，第二半就变成为「它」写的断言，坏了还看不出原因。
  // 改成「先自己弄脏、再断言别人弄脏的没留下」，顺序依赖消失。
  it('进入测试时全局是干净的', () => {
    expect((globalThis as unknown as Record<string, unknown>).wx).toBeUndefined()
  })

  it('本用例装的桩与调用记录，下一个用例看不到（自己弄脏 → 交给清理 → 下个用例验）', () => {
    const host = globalThis as unknown as Record<string, unknown>
    const wx = installWxStub()
    wx.getStorageSync.mockReturnValueOnce('dirty')
    expect(wx.getStorageSync('k')).toBe('dirty')
    expect(wx.getStorageSync).toHaveBeenCalledTimes(1)
    expect(host.wx).toBeDefined()
  })

  it('上一个用例装的桩没有留下（wx 必须没了）', () => {
    const host = globalThis as unknown as Record<string, unknown>
    // 若 setup 的 afterEach 没跑，这里会撞见上一个用例装的那个桩。
    // ⚠️ 只断言 `wx` —— 那是**载体拥有**的全局。用例随手塞的其它全局不归它管，
    // 断言那些等于要求 setup 去清理它根本不认识的东西。
    expect(host.wx).toBeUndefined()
  })

  it('上一个用例推进过的 fake timer 不泄漏到这里', () => {
    // ⚠️ 这条断言的是「计时器是真货」。若 setup 忘了 vi.useRealTimers()，本用例会跑在
    // fake 时钟下 —— 除非有人手动推进，setTimeout(…, 0) 永不触发，value 停在 0；
    // 而真实时钟下它会到 1。所以「等到 1」证明用的是真计时器。
    // 用 await + 真实 0ms 计时器：代价可以忽略，换来的是不依赖执行顺序的自证。
    let value = 0
    setTimeout(() => {
      value = 1
    }, 0)
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(value).toBe(1)
        resolve()
      }, 5)
    })
  })
})
