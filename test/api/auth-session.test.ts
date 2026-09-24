// `api/auth` 的两个端点函数 + **冷启动登录链**的验收 —— issue #18 的第三、四组 criteria。
//
// ⚠️ 断言落在**外部行为**上（#15 Testing Decisions）：
//   • 「发出了什么请求」—— URL / 方法 / 头 / body（`api/auth` 的搬运正确性）
//   • 「调用方拿到了什么」—— DTO 或统一异常对象的 kind/code，以及 storage 里落了什么
// **不测**内部实现 —— 不测登录链内部怎么分叉、不测私有函数被调用几次。

import { describe, expect, it } from 'vitest'
import { installWxStub, jsonResponse, reply } from '../helpers/wx'
import type { WxRequestSuccessResult } from '../helpers/wx'
import { requestsTo, respondInOrder, sentRequests } from '../helpers/http'
import { login, refresh } from '../../miniprogram/api/auth'
import { ensureLoggedIn } from '../../miniprogram/api/session'
import type { LoginResponse } from '../../miniprogram/types/auth'
import { getAccessToken, getRefreshToken } from '../../miniprogram/request/token'

const LOGIN_URL = 'https://api.example.com/api/app/v1/auth/login'
const REFRESH_URL = 'https://api.example.com/api/app/v1/auth/refresh'

/** 一份契约形状的 `13.1` 成功响应体。 */
function loginBody(overrides: Partial<LoginResponse> = {}): Record<string, unknown> {
  return {
    code: 0,
    message: 'ok',
    data: {
      accessToken: 'ACCESS-NEW',
      refreshToken: 'REFRESH-NEW',
      expiresIn: 7200,
      user: { id: 88, nickname: null, avatar: null, phone: null, score: 100, status: 'NORMAL' },
      ...overrides,
    },
  }
}

/**
 * 让 `wx.request` 依次按编排回话，并让 `wx.login` 返回给定的 code。
 *
 * ⚠️ 请求侧的回话复用 `respondInOrder()`（`test/helpers/http.ts`）而**不在这里重写一遍**：
 * 那个 helper 的存在理由正是「按序回话」这件事不该在每条用例里各写一份
 * （见它的文件头）。这里的 `stubLoginFlow` 只加 `wx.login` 那一半编排。
 */
function stubLoginFlow(
  responses: readonly (WxRequestSuccessResult | { errMsg: string })[],
  loginCode = 'WX-CODE-1',
): ReturnType<typeof installWxStub> {
  const wx = installWxStub()
  wx.login.mockImplementation(reply({ code: loginCode, errMsg: 'login:ok' }))
  wx.request.mockImplementation(respondInOrder(responses))
  return wx
}

/**
 * 断言「storage 里没有这个 token」。
 *
 * ⚠️ **不要**用 `wx.getStorageSync.mockReturnValue(undefined)` 来表达「冷启动时 storage 是空的」——
 * 那会**整个替换掉**桩的内存实现，于是 `setStorageSync` 写进去的东西再也读不回来，
 * 「双 token 落 storage」这类断言会假失败。桩默认就是一个真的会读写的内存表
 * （见 `test/helpers/wx.ts` 的注释），新装的桩本来就是空的 —— 直接用即可。
 */
function assertNoToken(name: string, actual: string | null): void {
  expect(actual, `${name} 不该存在`).toBeNull()
}

describe('#18 api/auth：13.1 登录只做搬运，不含业务分支', () => {
  it('发出的请求：POST /api/app/v1/auth/login，body 只带 code', async () => {
    const wx = stubLoginFlow([jsonResponse(loginBody())])

    await login({ code: 'CODE-1' })

    const [sent] = sentRequests(wx.request)
    expect(sent.url).toBe(LOGIN_URL)
    expect(sent.method).toBe('POST')
    expect(sent.data).toEqual({ code: 'CODE-1' })
  })

  it('13.1 成功 → 原样交出 LoginResponse（双 token + expiresIn + user）', async () => {
    stubLoginFlow([jsonResponse(loginBody())])

    const result = await login({ code: 'CODE-1' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.data.accessToken).toBe('ACCESS-NEW')
    expect(result.data.refreshToken).toBe('REFRESH-NEW')
    expect(result.data.expiresIn).toBe(7200)
    expect(result.data.user.id).toBe(88)
  })

  it('⚠️ api/auth 自身不写 storage —— 落盘是登录链的决定（07 §3 硬规则 2）', async () => {
    // `api/` 只做「入参 → 请求 → 出参 DTO」的搬运。若它顺手落盘，两个调用点就会各自
    // 落一次，或者页面只调 `login()` 却以为 token 已经存好了。
    const wx = stubLoginFlow([jsonResponse(loginBody())])

    await login({ code: 'CODE-1' })

    expect(wx.setStorageSync, 'api/auth 不得写 storage').not.toHaveBeenCalled()
  })

  it('13.1 返回 8001（HTTP 200）→ kind 为 business 且 message 原样（落全局失败出口用）', async () => {
    stubLoginFlow([jsonResponse({ code: 8001, message: '微信登录凭证无效', data: null })])

    const result = await login({ code: 'BAD' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('business')
    expect(result.error.kind).not.toBe('unauthorized')
    expect(result.error.code).toBe(8001)
    expect(result.error.message).toBe('微信登录凭证无效')
  })
})

describe('#18 api/auth：13.2 用 X-Refresh-Token 头，且响应不轮换 refresh', () => {
  it('发出的请求：POST /api/app/v1/auth/refresh，头带 X-Refresh-Token，无 body', async () => {
    // ⚠️ `13.2` 用 `X-Refresh-Token` 头，**不是** Bearer access（`R1` §13.2、`API:943`）。
    const wx = stubLoginFlow([
      jsonResponse({ code: 0, message: 'ok', data: { accessToken: 'A2', expiresIn: 7200 } }),
    ])

    await refresh('REFRESH-1')

    const [sent] = sentRequests(wx.request)
    expect(sent.url).toBe(REFRESH_URL)
    expect(sent.method).toBe('POST')
    expect(sent.header['X-Refresh-Token']).toBe('REFRESH-1')
    expect(sent.header.Authorization, '13.2 不得带 Bearer access').toBeUndefined()
    expect(sent.data, '13.2 请求体为空').toBeUndefined()
  })

  it('13.2 响应只有 { accessToken, expiresIn }，原样交出', async () => {
    stubLoginFlow([jsonResponse({ code: 0, message: 'ok', data: { accessToken: 'A2', expiresIn: 7200 } })])

    const result = await refresh('REFRESH-1')

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.data.accessToken).toBe('A2')
    expect(result.data.expiresIn).toBe(7200)
  })
})

describe('#18 冷启动登录链：无 refresh token → wx.login → 13.1 → 双 token 落 storage', () => {
  it('无 refresh token 时：调 wx.login 取 code，再用它调 13.1', async () => {
    const wx = stubLoginFlow([jsonResponse(loginBody())], 'WX-CODE-FRESH')

    const result = await ensureLoggedIn()

    expect(result.ok).toBe(true)
    expect(wx.login).toHaveBeenCalledTimes(1)
    const [sent] = sentRequests(wx.request)
    expect(sent.url).toBe(LOGIN_URL)
    expect(sent.data).toEqual({ code: 'WX-CODE-FRESH' })
  })

  it('双 token 落 storage —— access 与 refresh 都持久化（07 §4.4 定案）', async () => {
    stubLoginFlow([jsonResponse(loginBody())])

    await ensureLoggedIn()

    expect(getAccessToken()).toBe('ACCESS-NEW')
    expect(getRefreshToken()).toBe('REFRESH-NEW')
  })

  it('⚠️ 冷启动有 refresh token 时：**直接**放行，不发任何请求、不因本地时间预判过期', async () => {
    // `01` §3.4 状态机的另一个分叉，也是 `07` §4.4「不预判」最容易被违反的地方：
    // 后来者很容易在这里加一句「access 快过期了，先刷一下」或「没有 access 就先登录」。
    // 两者都是错的 —— 刷新只由 401 驱动（#19），本地时间不可信。
    const wx = installWxStub()
    // storage 里**只有** refresh、没有 access：这正是一个「可能已过期」的真实形态。
    wx.getStorageSync.mockImplementation((key: string) =>
      key === 'auth.refreshToken' ? 'REFRESH-EXISTING' : undefined,
    )

    const result = await ensureLoggedIn()

    expect(result.ok).toBe(true)
    expect(wx.request, '有 refresh 时不得发任何请求').not.toHaveBeenCalled()
    expect(wx.login, '有 refresh 时不得重新 wx.login').not.toHaveBeenCalled()
    // 免请求路径上没有新的用户信息 —— 如实为 null，不编一个。
    if (!result.ok) throw new Error('unreachable')
    expect(result.data).toBeNull()
  })

  it('⚠️ 13.1 返回 user.status = BLACKLISTED → 登录成功、不阻断（承 02 带住的陷阱）', async () => {
    // `01` §1.4 / `13.1` :939：**黑名单用户允许登录**。`04` §5 明令客户端不得据此做任何
    // 事前阻断 —— 拦截权只能属于服务端（本地快照会造出双源真相，还会把已解禁用户挡在门外）。
    stubLoginFlow([
      jsonResponse(
        loginBody({
          user: { id: 88, nickname: null, avatar: null, phone: null, score: 40, status: 'BLACKLISTED' },
        }),
      ),
    ])

    const result = await ensureLoggedIn()

    expect(result.ok, 'BLACKLISTED 用户登录必须成功，不得阻断').toBe(true)
    // 而且 token 照常落盘 —— 受限状态不影响「登录身份已建立」这件事。
    expect(getAccessToken()).toBe('ACCESS-NEW')
    if (!result.ok) throw new Error('unreachable')
    expect(result.data?.user.status).toBe('BLACKLISTED')
  })

  it('wx.login 失败 → kind 为 network（落全局失败出口），不抛裸错误', async () => {
    const wx = installWxStub()
    // ⚠️ 失败载荷仍须是 `WxLoginOptions['fail']` 认得的东西 —— 桩的回调是
    // `(res: WxLoginSuccessResult)`，直接塞一个 `{ errMsg }` 会 TS2345。
    wx.login.mockImplementation(reply({ code: '', errMsg: 'login:fail network error' }, false))

    const result = await ensureLoggedIn()

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('network')
    // 拿不到 code 就压根不该发请求。
    expect(wx.request).not.toHaveBeenCalled()
  })

  it('13.1 失败（8001）→ 透传 business 异常，且**不落任何 token**', async () => {
    // ⚠️ 「失败不落盘」是一条真要守的行为：若先落了个 undefined 再报错，下一次冷启动
    // 会因为「有 refresh」而直接放行，把用户永久卡在一个假登录态里。
    stubLoginFlow([jsonResponse({ code: 8001, message: '微信登录凭证无效', data: null })])

    const result = await ensureLoggedIn()

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('business')
    assertNoToken('access token', getAccessToken())
    assertNoToken('refresh token', getRefreshToken())
  })

  it('13.1 收到非 JSON 响应 → kind 为 network，不落 token（不放行假登录态）', async () => {
    stubLoginFlow([jsonResponse('<html>502</html>')])

    const result = await ensureLoggedIn()

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('network')
    assertNoToken('refresh token', getRefreshToken())
  })
})

describe('#18 冷启动登录链：13.1 / 13.2 不被附加 access 头（防递归）', () => {
  it('storage 里已有 access 时，冷启动重登路径发出的 13.1 仍不带鉴权头', async () => {
    // 「有 refresh 就直接放行」意味着重登路径在正常流程下不会被走到；但 #19 的
    // `401 + 2005` 清态重登会走到它，那时 storage 里可能还残留着旧 access。
    // 这条锁住：重登请求**不**带旧 access（免鉴权豁免对登录链的每一条路都成立）。
    const wx = stubLoginFlow([jsonResponse(loginBody())])
    wx.getStorageSync.mockImplementation((key: string) =>
      key === 'auth.accessToken' ? 'STALE-ACCESS' : undefined,
    )

    await ensureLoggedIn()

    const sent = requestsTo(sentRequests(wx.request), LOGIN_URL)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.header.Authorization).toBeUndefined()
  })
})
