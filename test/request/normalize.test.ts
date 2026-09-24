// 请求层的**归一化**验收 —— issue #18 的第一组 Acceptance criteria。
//
// 断言风格承 `scripts/verify-visual-tokens.mjs` 与 `test/types/auth.test.ts`：
// **把 spec 里的每条事实落成一条可执行断言、失败时打印出违反的是哪一条**。
//
// 本文件测的是**外部行为**（#15 Testing Decisions 原文）：
//   「发出了什么请求（URL / 方法 / 头 / body）」与「调用方拿到了什么（DTO 或异常对象的 kind/code）」。
// **不测**内部实现 —— 不测归一化函数的分支结构、不测私有函数的调用次数。
// 因此请求层内部重写时本文件不该碎。
//
// ⚠️ 归一化分类表的每条边都单独成断言，因为 `07` §4.2 的这张表**只看一边都是错的**：
// 契约是 `HTTP 200 + code ≠ 0` 承载业务错误（`API:1319`），只有认证/权限用真 `401/403`
// （`API:44`）。只判 HTTP 状态码会漏掉全部业务错误；只判 `code` 会把 403 误当业务错误。

import { describe, expect, it } from 'vitest'
import { installWxStub, jsonResponse, networkFailure } from '../helpers/wx'
import type { WxRequestSuccessResult } from '../helpers/wx'
import { request } from '../../miniprogram/request'
import { installFakeTimers } from '../helpers/timers'

/** 编排 `wx.request` 依次返回给定的响应，然后发一条请求，返回调用方拿到的东西。 */
async function callWith(
  responses: readonly (WxRequestSuccessResult | { errMsg: string })[],
): Promise<unknown> {
  const wx = installWxStub()
  let index = 0
  wx.request.mockImplementation((options) => {
    const result = responses[index]
    index += 1
    if (result === undefined) throw new Error(`只编排了 ${responses.length} 个响应，但发生了第 ${index} 次请求`)
    queueMicrotask(() => {
      if ('statusCode' in result) options.success?.(result)
      else options.fail?.(result)
    })
  })
  // storage 预置一个 access —— 本组用例验的是归一化，不该被「没登录」干扰。
  wx.getStorageSync.mockReturnValue('ACCESS')
  return request('/api/app/v1/orders')
}

/** 取失败分支的统一异常对象；拿到成功分支说明断言前提就不成立。 */
function errorOf(result: unknown): { httpStatus: number | null; code: number | null; message: string | null; kind: string } {
  const r = result as { ok: boolean; error?: Record<string, unknown> }
  expect(r.ok, '期望这是一条失败结果，但请求层返回了成功').toBe(false)
  expect(r.error, '失败结果必须带统一异常对象').toBeDefined()
  return r.error as { httpStatus: number | null; code: number | null; message: string | null; kind: string }
}

describe('#18 请求层归一化：业务错误走 HTTP 200 + code ≠ 0', () => {
  it('HTTP 200 + code === 0 → 正常返回 DTO，不被误判为异常', async () => {
    const result = (await callWith([
      jsonResponse({ code: 0, message: 'ok', data: { id: 7, code: 'WD-01' } }),
    ])) as { ok: boolean; data?: unknown }

    expect(result.ok).toBe(true)
    // `data` 是契约响应体里 `data` 字段的**原样** DTO —— 请求层不加工它（`07` §4.1）。
    expect(result.data).toEqual({ id: 7, code: 'WD-01' })
  })

  it('HTTP 200 + code !== 0（非 5004）→ kind 为 business，message 按服务端原文携带', async () => {
    // 服务端 message 刻意用一句**不像任何模板**的话：请求层若硬编码文案（`R1:435` 禁止），
    // 这条会立刻红。
    const serverMessage = '该规格格口已满，请换一台柜机'
    const result = await callWith([jsonResponse({ code: 8002, message: serverMessage, data: null })])
    const error = errorOf(result)

    expect(error.kind).toBe('business')
    expect(error.code).toBe(8002)
    expect(error.httpStatus).toBe(200)
    expect(error.message).toBe(serverMessage)
  })

  it('HTTP 200 + code === 5004 → kind 为 restricted，且服务端 message 不透出', async () => {
    // `07` §4.2 的**唯一特判**：`5004` 走 `04` §4 受限卡，**不展示服务端 message**
    // （它既不解释原因也不给出路）。本票只负责归成 `restricted` 并**不透出** message；
    // 卡片形态归 `04` §4 与后续「我的」页票。
    const result = await callWith([
      jsonResponse({ code: 5004, message: '账号已被限制，原因：违规占用', data: null }),
    ])
    const error = errorOf(result)

    expect(error.kind).toBe('restricted')
    expect(error.code).toBe(5004)
    expect(error.message, '5004 的服务端 message 不得透出给调用方').toBeNull()
  })

  it('HTTP 200 + 非 JSON 响应 → kind 为 network，code 为 null', async () => {
    // 「非 JSON 响应」是 `network` 的第三个触发（`07` §4.2）—— 网关回了 HTML 错误页时
    // 连 `code` 都读不出来，必须归 `network` 而不是 `business`。
    const result = await callWith([jsonResponse('<html>502 Bad Gateway</html>')])
    const error = errorOf(result)

    expect(error.kind).toBe('network')
    expect(error.code).toBeNull()
  })

  it('HTTP 200 + body 是无 code 字段的 JSON 对象 → 同样归 network（读不出业务码）', async () => {
    const result = await callWith([jsonResponse({ message: '嗯？' })])
    expect(errorOf(result).kind).toBe('network')
  })
})

describe('#18 请求层归一化：认证 / 权限走真 HTTP 状态码', () => {
  it('401 + 2001 → kind 为 unauthorized（本票只分类，处理归 #19）', async () => {
    const result = await callWith([jsonResponse({ code: 2001, message: '未登录或登录已过期' }, 401)])
    const error = errorOf(result)

    expect(error.kind).toBe('unauthorized')
    expect(error.code).toBe(2001)
    expect(error.httpStatus).toBe(401)
    expect(error.message).toBe('未登录或登录已过期')
  })

  it('401 + 2005 → kind 为 unauthorized', async () => {
    const result = await callWith([jsonResponse({ code: 2005, message: '刷新令牌已失效' }, 401)])
    const error = errorOf(result)

    expect(error.kind).toBe('unauthorized')
    expect(error.code).toBe(2005)
  })

  it('403 → kind 为 forbidden', async () => {
    const result = await callWith([jsonResponse({ code: 3003, message: '无权访问' }, 403)])
    const error = errorOf(result)

    expect(error.kind).toBe('forbidden')
    expect(error.httpStatus).toBe(403)
    expect(error.message).toBe('无权访问')
  })

  it('13.1 返回 8001（HTTP 200）→ kind 为 business，不是 unauthorized', async () => {
    // issue #17 在 `LoginRequest.code` 上写死的陷阱：`code` 为空或无效由**换取通道**判为
    // `8001`（HTTP 200、业务错误），**不是** `1001` 参数校验错、更**不是** `401`。
    // 若归一化只看「哪个端点」或把登录失败当认证失败，全局失败出口会被误导成「重新登录」。
    const result = await callWith([jsonResponse({ code: 8001, message: '微信登录凭证无效', data: null })])
    const error = errorOf(result)

    expect(error.kind).toBe('business')
    expect(error.kind).not.toBe('unauthorized')
    expect(error.code).toBe(8001)
    expect(error.httpStatus).toBe(200)
    expect(error.message).toBe('微信登录凭证无效')
  })
})

describe('#18 请求层归一化：网络失败与超时', () => {
  it('请求 fail（网络不通 / 超时）→ kind 为 network，code 为 null', async () => {
    const result = await callWith([networkFailure('request:fail timeout')])
    const error = errorOf(result)

    expect(error.kind).toBe('network')
    expect(error.code).toBeNull()
    // 网络失败没有 HTTP 状态码 —— 不假装有。
    expect(error.httpStatus).toBeNull()
  })

  it('真实超时（响应永不回来、计时器到点）→ kind 为 network', async () => {
    // 与上一条的差别：上一条是桩直接给 fail，这条是**请求发出去后没有任何回话**。
    // 请求层自己不做超时兜底（`wx.request` 的 timeout 选项负责），所以这里验的是
    // 「fail 回调被触发时」的归一化 —— 用 fake timer 驱动的正是这条路径。
    const timers = installFakeTimers()
    const wx = installWxStub()
    wx.request.mockImplementation((options) => {
      setTimeout(() => options.fail?.({ errMsg: 'request:fail timeout' }), 60_000)
    })
    wx.getStorageSync.mockReturnValue('ACCESS')

    const pending = request('/api/app/v1/orders')
    await timers.tick(60_000)
    const error = errorOf(await pending)

    expect(error.kind).toBe('network')
    expect(error.code).toBeNull()
  })
})

describe('#18 请求层归一化：非 2xx 的失败不得被当成成功', () => {
  it('⚠️ HTTP 500 + code 0 → 不得返回成功（服务端错误不能靠 body 的 code 洗白）', async () => {
    // 这条是**必须先红的边界**：契约规定业务错误走 `200 + code ≠ 0`、认证走真 `401/403`，
    // 但网关 5xx、后端未捕获异常、反向代理改写的响应都可能带着一个 body ——
    // 若 `code === 0` 就无条件当成功，`500 + code 0` 会把一个假 DTO 交给调用方，
    // 页面于是渲染出「没数据」而不是「出错了」。这是最坏的一类失败：静默且方向相反。
    const result = await callWith([jsonResponse({ code: 0, message: 'ok', data: { boom: true } }, 500)])
    const error = errorOf(result)

    expect(error.kind, 'HTTP 500 是服务端错误，不是成功').toBe('network')
    expect(error.httpStatus).toBe(500)
  })

  it('HTTP 502 + code 0 → 同样不得返回成功', async () => {
    const result = await callWith([jsonResponse({ code: 0, message: 'ok', data: null }, 502)])
    expect(errorOf(result).kind).toBe('network')
  })

  it('HTTP 500 + code ≠ 0 → 归 network 而不是 business（那不是契约的业务错误形态）', async () => {
    // 契约的业务错误形态是 `200 + code ≠ 0`（`API:1319`）。500 上的 code 不是那套语义 ——
    // 它多半是框架的兜底错误对象，把它当 business 会让页面按「业务原因」解释一句框架话术。
    const result = await callWith([jsonResponse({ code: 8001, message: '内部错误', data: null }, 500)])
    const error = errorOf(result)

    expect(error.kind).toBe('network')
    expect(error.httpStatus).toBe(500)
  })
})

describe('#18 请求层归一化：5004 的判定只看 code（07 §4.2 原表）', () => {
  it('⚠️ 401 上带 code 5004 → 仍归 restricted，且不透出 message', async () => {
    // `07` §4.2 的触发行写的是「`code === 5004`」—— **只看业务码**，不附带状态码前提。
    // 而 `5004` 的语义是**账号级受限**（`04` §3），与「HTTP 状态码是多少」无关：
    // 后端若把受限用户的动作在鉴权层就挡掉，返回的是 403 + `5004`，而不是 200 + `5004`。
    //
    // 若 401/403 分支先返回，这种组合会归成 `forbidden` 并**把服务端 message 透传出去** ——
    // 而 5004 的 message 恰恰是唯一不许透传的那条（`04` §3：它既不解释原因也不给出路）。
    // 「只有 5004 特判」这句话因此必须在**任何状态码上**都成立。
    const result = await callWith([jsonResponse({ code: 5004, message: '账号已被限制', data: null }, 403)])
    const error = errorOf(result)

    expect(error.kind, '403 + code 5004 仍应归 restricted').toBe('restricted')
    expect(error.code).toBe(5004)
    expect(error.httpStatus, '状态码原样保留 —— 特判只改 kind 与 message').toBe(403)
    expect(error.message, '5004 在任何状态码上都不许透出 message').toBeNull()
  })

  it('403 + code 5004 → restricted（同上，另一条真实路径）', async () => {
    const result = await callWith([jsonResponse({ code: 5004, message: '受限', data: null }, 403)])
    expect(errorOf(result).kind).toBe('restricted')
  })

  it('401 + code 5004 → restricted，而不是 unauthorized', async () => {
    // ⚠️ 这条最容易被写成 unauthorized：401 的直觉就是「登录失效」。但 `5004` 是**账号受限**，
    // 归 `unauthorized` 会让 #19 的失效处理去刷新 token —— 刷完还是受限，
    // 用户看到的是「反复重试无果」而不是「你被限制了」。
    const result = await callWith([jsonResponse({ code: 5004, message: '受限', data: null }, 401)])
    const error = errorOf(result)

    expect(error.kind).toBe('restricted')
    expect(error.message).toBeNull()
  })

  it('反面：401 + code 2001（非 5004）仍归 unauthorized，message 照常透传', async () => {
    // 守卫的边界：修 5004 的顺序不能把 401 的常规语义一起改掉。
    const result = await callWith([jsonResponse({ code: 2001, message: '登录已过期', data: null }, 401)])
    const error = errorOf(result)

    expect(error.kind).toBe('unauthorized')
    expect(error.message, '2001 不是特判，message 应照常携带').toBe('登录已过期')
  })
})
