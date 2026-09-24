// 请求层的**鉴权头与豁免**验收 —— issue #18 的第二组 Acceptance criteria。
//
// 断言的对象是「**发出了什么请求**」（#15 Testing Decisions），不是请求层内部怎么拼头。
// 读法用 `test/helpers/http.ts` 的 `sentRequests()` / `requestsTo()`。

import { describe, expect, it } from 'vitest'
import { installWxStub, jsonResponse, seedStorage } from '../helpers/wx'
import type { WxRequestSuccessResult } from '../helpers/wx'
import { requestsTo, sentRequests } from '../helpers/http'
import { request, requestWithoutAuth } from '../../miniprogram/request'
import { BASE_URL } from '../../miniprogram/request/config'

/** 装桩、编排固定响应、让 `wx.request` 下次调用即回话；返回桩本身供断言。 */
function stubOk(data: unknown = null): ReturnType<typeof installWxStub> {
  const wx = installWxStub()
  const ok: WxRequestSuccessResult = jsonResponse({ code: 0, message: 'ok', data })
  wx.request.mockImplementation((options) => {
    queueMicrotask(() => options.success?.(ok))
  })
  return wx
}

describe('#18 鉴权头：需鉴权的请求携带 Authorization: Bearer <access>', () => {
  it('storage 里有 access → 请求头带 Bearer access', async () => {
    const wx = stubOk()
    seedStorage('auth.accessToken', 'ACCESS-1')

    await request('/api/app/v1/orders')

    const [sent] = sentRequests(wx.request)
    expect(sent.header.Authorization).toBe('Bearer ACCESS-1')
  })

  it('storage 里没有 access → 不带 Authorization 头（而不是 Bearer undefined）', async () => {
    // ⚠️ 这条防的是「没登录也硬拼一个 Bearer 」的写法：那会发出
    // `Authorization: Bearer undefined`，后端回一个与真实原因无关的错误码，
    // 排查时会被误导到别处。没 token 就不带这个头，让服务端如实回 2001。
    const wx = stubOk()
    // 空的 storage 就是新装桩的默认状态 —— 不再覆盖读取实现（见 wx.ts 的 seedStorage 注释）

    await request('/api/app/v1/orders')

    const [sent] = sentRequests(wx.request)
    expect(sent.header.Authorization).toBeUndefined()
  })

  it('storage 里存的是非空字符串以外的值（对象 / 空串）→ 视为没有 token', async () => {
    // 微信 storage 能存任何东西：历史版本、别的模块、手工写坏的值都可能是 `{}` / `''`。
    // 把它们当 token 会发出 `Bearer [object Object]` —— 与「没登录」是同一件事，
    // 就该走同一条路。
    for (const bogus of [{}, '', 0]) {
      const wx = stubOk()
      seedStorage('auth.accessToken', bogus)

      await request('/api/app/v1/orders')

      const [sent] = sentRequests(wx.request)
      expect(sent.header.Authorization, `storage 里是 ${JSON.stringify(bogus)} 时不该带鉴权头`).toBeUndefined()
      wx.uninstall()
    }
  })
})

describe('#18 免鉴权豁免：13.1 与 13.2 不被附加 access 头', () => {
  it('13.1 /auth/login 即使 storage 里有 access 也不带头', async () => {
    // 唯二豁免端点的硬编码依据：`WebMvcConfig.java:46-47` 的 `excludePathPatterns`
    // （`/api/app/v1/auth/login`、`/api/app/v1/auth/refresh`）—— **只有这两个**（`07` §4.3 硬约束 5）。
    const wx = stubOk()
    seedStorage('auth.accessToken', 'ACCESS-EXISTS')

    await requestWithoutAuth('/api/app/v1/auth/login', { method: 'POST', data: { code: 'C1' } })

    const [sent] = sentRequests(wx.request)
    expect(sent.header.Authorization, '13.1 免鉴权，不得附加 access 头').toBeUndefined()
  })

  it('13.2 /auth/refresh 即使 storage 里有 access 也不带头', async () => {
    const wx = stubOk()
    seedStorage('auth.accessToken', 'ACCESS-EXISTS')

    await requestWithoutAuth('/api/app/v1/auth/refresh', {
      method: 'POST',
      header: { 'X-Refresh-Token': 'REFRESH-1' },
    })

    const [sent] = sentRequests(wx.request)
    expect(sent.header.Authorization, '13.2 免鉴权，不得附加 access 头').toBeUndefined()
  })

  it('⚠️ 用 request() 误调 13.1 / 13.2 时，豁免名单兜底仍然生效', async () => {
    // 上两条测的是 `requestWithoutAuth` 这条**显式**的路。但豁免名单本身也必须成立 ——
    // 否则后来者用 `request()` 直接调 13.1（很自然，因为它「也是个端点」）就会让
    // 登录链带上 access，进而在 #19 的刷新队列上长出递归。
    // 两道闸门都要能独立挡住，这条验的是名单那道。
    const wx = stubOk()
    seedStorage('auth.accessToken', 'ACCESS-EXISTS')

    await request('/api/app/v1/auth/login', { method: 'POST', data: { code: 'C1' } })
    await request('/api/app/v1/auth/refresh', { method: 'POST' })

    for (const sent of sentRequests(wx.request)) {
      expect(sent.header.Authorization, `${sent.url} 属豁免名单，不该带鉴权头`).toBeUndefined()
    }
  })

  it('豁免名单只有这两个 —— 别的 /auth/* 路径照常带 access', async () => {
    // 反面守卫：豁免名单不能被写成「路径含 /auth/ 就免鉴权」。
    // `13.3 logout` 在用户端**不在**豁免名单里（`WebMvcConfig` 的 app 拦截器那两行只排除了
    // login / refresh），而 `/profile` 这类更明显。
    const wx = stubOk()
    seedStorage('auth.accessToken', 'ACCESS-1')

    await request('/api/app/v1/auth/logout', { method: 'POST' })
    await request('/api/app/v1/profile')

    const calls = sentRequests(wx.request)
    expect(requestsTo(calls, `${BASE_URL}/api/app/v1/auth/logout`)[0]?.header.Authorization).toBe(
      'Bearer ACCESS-1',
    )
    expect(requestsTo(calls, `${BASE_URL}/api/app/v1/profile`)[0]?.header.Authorization).toBe(
      'Bearer ACCESS-1',
    )
  })
})

describe('#18 请求出口：URL / 方法 / 请求体按调用方的入参发出', () => {
  it('GET 请求：URL 是 baseUrl + path，方法为 GET，无请求体', async () => {
    const wx = stubOk()

    await request('/api/app/v1/orders')

    const [sent] = sentRequests(wx.request)
    expect(sent.url).toBe(`${BASE_URL}/api/app/v1/orders`)
    expect(sent.method).toBe('GET')
  })

  it('POST 请求：方法与请求体原样送出', async () => {
    const wx = stubOk()

    await request('/api/app/v1/auth/login', { method: 'POST', data: { code: 'CODE-1' } })

    const [sent] = sentRequests(wx.request)
    expect(sent.method).toBe('POST')
    expect(sent.data).toEqual({ code: 'CODE-1' })
  })

  it('调用方给的额外头被保留（与请求层自己的头合并）', async () => {
    const wx = stubOk()

    await request('/api/app/v1/orders', { header: { 'X-Trace-Id': 'T-1' } })

    const [sent] = sentRequests(wx.request)
    expect(sent.header['X-Trace-Id']).toBe('T-1')
    expect(sent.header['content-type']).toBe('application/json')
  })
})
