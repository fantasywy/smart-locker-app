// **401 单一飞行 + 全局排队重放**的验收 —— issue #19（`07` §4.3 的四条硬约束）。
//
// ⚠️ 断言的对象**只有外部行为**（#15 Testing Decisions，本票 acceptance criteria 也明写）：
//   • 「发出了什么请求」—— URL / 方法 / 头 / body / **到达顺序** / **总次数**
//   • 「调用方拿到了什么」—— DTO 或统一异常对象
//   • 「storage 里留下了什么」—— 只在它是可观察结果时（如 refresh 原值不变）
// **不测**内部实现 —— 不测队列的数据结构、不测私有函数被调用了几次、不测「转段」是怎么实现的。
//
// ⚠️ 本文件里的断言全部建立在**一个 URL 被请求了几次**之上：
//   「`13.2` 恰好一次」= `requestsTo(sent, REFRESH_URL)` 长度为 1。
// 这正是「刷新风暴」在外部唯一可见的形态。
//
// 覆盖的 acceptance criteria（逐条对应 issue #19 正文）：
//   1. M 个并发请求同时撞 401 → `13.2` 恰好一次，M 个请求各自重放成功
//   2. 刷新进行中新到的 401 请求加入同一队列，不触发第二次刷新
//   3. 重放时携带**新的** access token
//   4. `401 + 2005` → 清登录态 → `wx.login` → `13.1` 恰好一次 → 重放原请求
//   5. `2001` 刷新失败 → 转 `2005` 路径，不是直接放弃
//   6. 重登也失败 → 原请求被丢弃、不后台补发（此后没有任何新请求）
//   7. `13.2` 响应不轮换 refreshToken —— storage 里 refresh 原值不变
//   8. POST 请求撞 401 后同样被重放（写请求重放安全）
//   9. `13.1` / `13.2` 自身撞 401 不触发刷新逻辑（递归防护）
//  10. 重放保持原有请求的 method / URL / body 不变
//  11. 全部断言只针对外部行为 —— 本文件的断言只有四种：**发出了什么请求**（URL / 方法 /
//      头 / body / 到达顺序 / 总次数）、**调用方拿到了什么**、**`wx.*` 被调了几次**、
//      **storage 里留下了什么**。没有一条读队列的数据结构或私有函数。
//  12. 新代码过 strict TS，无 `any` 逃逸 —— 由 `pnpm typecheck` 保证，不在本文件里。
//
// ⚠️ 另有几条**反面守卫**，它们不属于上面任何一条 AC，但没有它们本票的核心断言会退化成
// 假通过（#19 的 code review 用变异测试逐条验过，两条曾经真空着的都在下面标了 ⚠️）：
//   • 「重放回来还是 401」不得再触发一轮恢复（各修一次，不递归）
//   • 一轮恢复结束后飞行位必须清空（否则第二个 401 永远修不好）
//   • ⚠️ 清态发生在重登**之前**（删掉 `clearTokens()` 曾让整套测试全绿）
//   • 重登失败的四种成因都要如实交回、且都不补发

import { describe, expect, it } from 'vitest'
import { installWxStub, jsonResponse, reply, seedStorage } from '../helpers/wx'
import type { WxRequestSuccessResult } from '../helpers/wx'
import { requestsTo, sentRequests, urlsOf } from '../helpers/http'
import type { SentRequest } from '../helpers/http'
import { request } from '../../miniprogram/request'
import { getAccessToken, getRefreshToken } from '../../miniprogram/request/token'
import { BASE_URL } from '../../miniprogram/request/config'

const ORDERS_URL = `${BASE_URL}/api/app/v1/orders`
const PROFILE_URL = `${BASE_URL}/api/app/v1/profile`
const LOGIN_URL = `${BASE_URL}/api/app/v1/auth/login`
const REFRESH_URL = `${BASE_URL}/api/app/v1/auth/refresh`

/**
 * 造一份 `401 + code` 的失败响应。
 *
 * ⚠️ 两个码的分工是契约事实（`01` §3.3、`07` §4.3）：`2001` = access 失效（去刷新）；
 * `2005` = refresh 失效（清态重登，跳过刷新）。测试里**不要**混用 —— 用错码就等于
 * 在验另一条分支。
 */
function unauthorized(code: 2001 | 2005, message = '登录态已失效'): WxRequestSuccessResult {
  return jsonResponse({ code, message, data: null }, 401)
}

/** 一份契约形状的 `13.2` 成功响应体（**注意：没有 `refreshToken` 字段**）。 */
function refreshBody(accessToken: string): WxRequestSuccessResult {
  return jsonResponse({ code: 0, message: 'ok', data: { accessToken, expiresIn: 7200 } })
}

/** 一份契约形状的 `13.1` 成功响应体。 */
function loginBody(accessToken: string, refreshToken: string): WxRequestSuccessResult {
  return jsonResponse({
    code: 0,
    message: 'ok',
    data: {
      accessToken,
      refreshToken,
      expiresIn: 7200,
      user: { id: 88, nickname: null, avatar: null, phone: null, score: 100, status: 'NORMAL' },
    },
  })
}

/** 一份成功的业务响应。 */
function okBody(data: unknown = null): WxRequestSuccessResult {
  return jsonResponse({ code: 0, message: 'ok', data })
}

/**
 * 把「哪次请求回什么话」写成一张表，并让桩每次回话时**记录下这次请求的请求号**。
 *
 * 为什么需要「按请求号回话」而不是 `respondInOrder`：本票的核心断言是
 * 「第 N 次发出的请求带的是**新的** access」—— 而重放发生在令牌更新**之后**，
 * 所以「第 1 次 / 第 2 次分别回什么」这种**按序**编排本身就依赖实现是否已经正确。
 * 按请求号编排则把「回什么话」与「实现怎么排」解耦。
 *
 * ⚠️ 回话走 `queueMicrotask`，保持微信侧「回调不在同一个 tick 里同步触发」的时序特征
 * （与 `test/helpers/http.ts` 的 `respondInOrder` 同一取向）。
 */
function replyByCall(
  wx: ReturnType<typeof installWxStub>,
  responses: readonly (WxRequestSuccessResult | { errMsg: string } | undefined)[],
): void {
  wx.request.mockImplementation((options) => {
    const index = wx.request.mock.calls.length - 1
    const result = responses[index]
    if (result === undefined) {
      throw new Error(
        `wx.request 第 ${index + 1} 次被调用，但只编排了 ${responses.length} 个响应。\n` +
          `    → 补齐编排表，或断言这次调用本不该发生（本票里「不该有第 N 次请求」本身就是断言）。`,
      )
    }
    queueMicrotask(() => {
      if ('statusCode' in result) options.success?.(result)
      else options.fail?.(result)
    })
  })
}

/** 读一条请求的 `Authorization` 头 —— 断言「重放带的是哪个 access」。 */
function bearerOf(sent: SentRequest): string | undefined {
  return sent.header.Authorization
}

describe('#19 单一飞行：并发 401 只触发一次登录失效处理', () => {
  it('M 个并发请求同时撞 401 → 13.2 恰好一次，M 个请求各自重放成功', async () => {
    // 冷启动时 5 个页面同时发请求是常态（`07` §4.3 硬约束 1）。没有单一飞行，
    // 这里会打出 M 次刷新 —— 也就是「刷新风暴」，本票要防的正是它。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyByCall(wx, [
      // ① 两个业务请求各自撞 401 + 2001（access 失效）
      unauthorized(2001),
      unauthorized(2001),
      // ② 队首请求触发的那**一次**刷新
      refreshBody('ACCESS-NEW'),
      // ③ 两个请求按序重放
      okBody({ id: 1 }),
      okBody({ id: 2 }),
    ])

    const [a, b] = await Promise.all([request('/api/app/v1/orders'), request('/api/app/v1/profile')])

    const sent = sentRequests(wx.request)
    expect(requestsTo(sent, REFRESH_URL), '13.2 必须恰好被调用一次').toHaveLength(1)
    expect(urlsOf(sent)).toEqual([ORDERS_URL, PROFILE_URL, REFRESH_URL, ORDERS_URL, PROFILE_URL])
    expect(a.ok, '第一个请求重放后应成功').toBe(true)
    expect(b.ok, '第二个请求重放后应成功').toBe(true)
  })

  it('⚠️ 刷新进行中新到的 401 请求加入同一队列，不触发第二次刷新', async () => {
    // 这条与上一条**不是**重复，而且它曾经是一条**假通过**的测试 —— 值得记下来。
    //
    // 关键在时序：必须让**刷新已经在飞**的时候，**另一个请求才撞上 401**。
    // 早先这版只发了「一个请求撞 401 → 起刷新」，然后才补第二个请求 —— 那时刷新虽然
    // 还没回话，但**没有任何别的请求处在「已经 401、等待恢复」的状态**，
    // 于是「谁去起第二次刷新」这件事根本没被问到。
    // 实测：把单一飞行整个删掉（`??=` 改成 `=`），这条测试**照样通过**。
    //
    // 现在这样写才成立：先让**两个**请求都撞完 401 并进入等待，再放行刷新。
    // 此时任何「按端点各起一次刷新」的写法都会打出第二次 `13.2`。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')

    let refreshGate: (() => void) | undefined
    // ⚠️ 按**次序 + URL** 编排，而不是只按次序：重放与首次请求打的是同一个 URL，
    // 但「这是第几次打它」才是断言关心的东西。用计数器表达，读起来与断言的意图一致。
    let ordersCalls = 0
    let profileCalls = 0
    wx.request.mockImplementation((options) => {
      const isOrders = options.url === ORDERS_URL
      const isProfile = options.url === PROFILE_URL
      const reply = (result: WxRequestSuccessResult | { errMsg: string }): void => {
        queueMicrotask(() => {
          if ('statusCode' in result) options.success?.(result)
          else options.fail?.(result)
        })
      }

      if (options.url === REFRESH_URL) {
        // ③ 刷新请求：**挂住不回话**，让「刷新进行中」成为可观察的一段
        refreshGate = () => reply(refreshBody('ACCESS-NEW'))
        return
      }
      if (isOrders) {
        ordersCalls += 1
        // ① 首次撞 401；④ 重放成功
        reply(ordersCalls === 1 ? unauthorized(2001) : okBody({ id: 1 }))
        return
      }
      if (isProfile) {
        profileCalls += 1
        // ② 首次撞 401；⑤ 重放成功
        reply(profileCalls === 1 ? unauthorized(2001) : okBody({ id: 2 }))
        return
      }
      throw new Error(`未编排的请求：${options.url}`)
    })

    // ① 两个请求并发发出，各自撞上 401 —— 都进入「等待恢复」
    const first = request('/api/app/v1/orders')
    const second = request('/api/app/v1/profile')
    // 让两条请求都跑完「发出 → 收到 401 → 入队」
    for (let i = 0; i < 6; i += 1) await Promise.resolve()

    const before = sentRequests(wx.request)
    expect(urlsOf(before), '两个请求都已发出并撞上 401，且刷新已起飞').toEqual([
      ORDERS_URL,
      PROFILE_URL,
      REFRESH_URL,
    ])
    // ⚠️ 此刻正是硬约束 1 要防的那个瞬间：**两个**请求都在等恢复，而恢复在飞。
    expect(requestsTo(before, REFRESH_URL), '两个 401 只能触发一次刷新').toHaveLength(1)

    // ② 放行刷新
    refreshGate?.()
    const [a, b] = await Promise.all([first, second])

    const sent = sentRequests(wx.request)
    expect(requestsTo(sent, REFRESH_URL), '刷新进行中新到的 401 不得触发第二次刷新').toHaveLength(1)
    expect(urlsOf(sent)).toEqual([ORDERS_URL, PROFILE_URL, REFRESH_URL, ORDERS_URL, PROFILE_URL])
    expect(a.ok && b.ok, '两个请求都应重放成功').toBe(true)
  })

  it('重放时携带新的 access token', async () => {
    // 「刷新成功」这件事在外部唯一可见的证据，就是重放请求上换了一个 Bearer。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyByCall(wx, [unauthorized(2001), refreshBody('ACCESS-NEW'), okBody()])

    await request('/api/app/v1/orders')

    const sent = sentRequests(wx.request)
    expect(bearerOf(sent[0]!), '首个请求带的是旧 access').toBe('Bearer ACCESS-OLD')
    expect(bearerOf(sent[2]!), '重放必须带刷新后的新 access').toBe('Bearer ACCESS-NEW')
    expect(getAccessToken(), '新 access 也应落进 storage').toBe('ACCESS-NEW')
  })
})

describe('#19 清态重登：401 + 2005 与「刷新失败转重登」', () => {
  it('401 + 2005 → 清登录态 → wx.login → 13.1 恰好一次 → 重放原请求', async () => {
    // `2005` = refresh 失效。这条路**跳过刷新**，直接清态重登（`07` §4.3）。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-DEAD')
    wx.login.mockImplementation(reply({ code: 'WX-CODE-RELOGIN', errMsg: 'login:ok' }))
    replyByCall(wx, [
      unauthorized(2005), // ① 业务请求：refresh 失效
      loginBody('ACCESS-RELGOIN', 'REFRESH-RELGOIN'), // ② 13.1 重登
      okBody({ id: 1 }), // ③ 重放
    ])

    const result = await request('/api/app/v1/orders')

    const sent = sentRequests(wx.request)
    expect(wx.login, '重登必须走 wx.login 取新 code').toHaveBeenCalledTimes(1)
    expect(requestsTo(sent, LOGIN_URL), '13.1 必须恰好一次').toHaveLength(1)
    expect(requestsTo(sent, REFRESH_URL), '2005 路径不得去调 13.2（refresh 已经失效）').toHaveLength(0)
    expect(sent[1]!.data, '13.1 的 body 是新拿到的 code').toEqual({ code: 'WX-CODE-RELOGIN' })
    expect(bearerOf(sent[2]!), '重放带上重登后的新 access').toBe('Bearer ACCESS-RELGOIN')
    expect(result.ok, '重放成功后调用方拿到数据').toBe(true)
  })

  it('⚠️ 清态发生在重登之前 —— 13.1 发出时 storage 里的 token 已经被清掉', async () => {
    // `07` §4.3 / `01` §3.4：「[清态重登] = 清登录态 → wx.login → 13.1」——**清态在前**。
    //
    // ⚠️ 这条断言曾经整个缺失，而它是**有承载**的（删掉 `relogin()` 里的 `clearTokens()`
    // 曾有 95 条测试全绿）。承载它的后果在 `relogin` 的注释里写着：若不清态，
    // 重登失败后会留下一个「refresh 看起来还在、其实已经失效」的假登录态 ——
    // `api/session.ts` 的冷启动分叉会因此直接放行，用户被永久卡在每次都 401 的死循环。
    //
    // 怎么**从外部**观察「清态已发生」：storage 是公开状态（`getAccessToken()` /
    // `getRefreshToken()` 都是模块的公开出口）。在 `wx.login` 被调用的**那一刻**读它 ——
    // 那正是「清态之后、重登之前」这个窗口，也正是状态机规定的顺序。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-DEAD')

    let tokensAtLoginTime: { access: string | null; refresh: string | null } | null = null
    wx.login.mockImplementation((options) => {
      // ⚠️ 在 wx.login 内部读取，而不是在它之后 —— 后者只能证明「最终清过」，
      // 不能证明「清在重登之前」。顺序正是这条断言的全部内容。
      tokensAtLoginTime = { access: getAccessToken(), refresh: getRefreshToken() }
      queueMicrotask(() => options.success?.({ code: 'WX-C', errMsg: 'login:ok' }))
    })
    replyByCall(wx, [
      unauthorized(2005), // ① refresh 失效
      loginBody('ACCESS-N', 'REFRESH-N'), // ② 13.1 重登
      okBody(), // ③ 重放
    ])

    await request('/api/app/v1/orders')

    expect(tokensAtLoginTime, 'wx.login 必须被调用过').not.toBeNull()
    expect(tokensAtLoginTime!.access, '重登前 access 必须已被清掉').toBeNull()
    expect(tokensAtLoginTime!.refresh, '重登前 refresh 必须已被清掉').toBeNull()
    // 重登成功后是**一整套新令牌**（与「13.2 不轮换 refresh」那一对）。
    expect(getAccessToken()).toBe('ACCESS-N')
    expect(getRefreshToken()).toBe('REFRESH-N')
  })

  it('⚠️ 重登失败后 storage 保持**清空** —— 不留假登录态', async () => {
    // 上面那条的失败分支，也是清态真正的收益所在：`api/session.ts` 判「有没有 refresh」
    // 来决定冷启动是放行还是静默登录。重登失败却留着旧 refresh ⇒ 下次冷启动被直接放行，
    // 然后每次请求都 401 —— 用户看到的是一个永远修不好的小程序。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-DEAD')
    wx.login.mockImplementation(reply({ code: 'WX-C', errMsg: 'login:ok' }))
    replyByCall(wx, [
      unauthorized(2005), // ① refresh 失效
      { errMsg: 'request:fail timeout' }, // ② 13.1 失败 —— 重登失败
    ])

    const result = await request('/api/app/v1/orders')

    expect(result.ok).toBe(false)
    expect(getAccessToken(), '失败的旧 access 必须已被清掉').toBeNull()
    expect(getRefreshToken(), '失效的 refresh 绝不能留下（否则冷启动会放行假登录态）').toBeNull()
  })

  it('2001 刷新失败 → 转 2005 路径（清态重登），不是直接放弃', async () => {    // ⚠️ 这是 `07` §4.3 状态机里最容易被实现成「刷新失败就报错」的一格：
    // 「刷新失败」不等于「登录身份没了」—— refresh 可能只是过期了，重登一次往往就能恢复。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-EXPIRED')
    wx.login.mockImplementation(reply({ code: 'WX-CODE-2', errMsg: 'login:ok' }))
    replyByCall(wx, [
      unauthorized(2001), // ① 业务请求：access 失效
      unauthorized(2005, '刷新令牌已过期'), // ② 13.2 也失败 —— 转清态重登
      loginBody('ACCESS-VIA-RELOGIN', 'REFRESH-VIA-RELOGIN'), // ③ 13.1 重登
      okBody({ id: 1 }), // ④ 重放
    ])

    const result = await request('/api/app/v1/orders')

    const sent = sentRequests(wx.request)
    expect(requestsTo(sent, REFRESH_URL), '13.2 被调了一次（然后失败）').toHaveLength(1)
    expect(requestsTo(sent, LOGIN_URL), '刷新失败后应转清态重登').toHaveLength(1)
    expect(bearerOf(sent[3]!), '重放带重登后的 access').toBe('Bearer ACCESS-VIA-RELOGIN')
    expect(result.ok, '转段成功后原请求照常重放').toBe(true)
  })

  it('重登也失败 → 原请求被丢弃、不后台补发 —— 此后没有任何新请求发出', async () => {
    // 硬约束 3（`07` §4.3）：否则会出现「用户点了支付 → 网络断 → 离开 → 半小时后自动扣款」。
    // 断言的是**此后一个请求都没有** —— 包括**没有重放**。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-DEAD')
    wx.login.mockImplementation(reply({ code: 'WX-CODE-FAIL', errMsg: 'login:ok' }))
    replyByCall(wx, [
      unauthorized(2005), // ① 业务请求撞 2005
      { errMsg: 'request:fail timeout' }, // ② 13.1 网络失败 —— 重登失败
    ])

    const result = await request('/api/app/v1/orders')

    const sent = sentRequests(wx.request)
    expect(urlsOf(sent), '重登失败后不得有任何补发（包括不重放原请求）').toEqual([ORDERS_URL, LOGIN_URL])
    expect(result.ok, '原动作被丢弃，调用方拿到失败').toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind, '如实交出重登失败的成因（网络失败），而不是伪造一个 unauthorized').toBe('network')
  })

  it('重登失败的另一形态：13.1 返回 8001 → 成因如实交回，且**仍不补发**', async () => {
    // `01` §4 把登录失败的成因**穷举**为四类（网络不通 / `wx.login` 失败 / `13.1` 返回 `8001` /
    // 后端 5xx）。上面那条只验了「网络不通」一种 —— 而 `8001` 是完全不同的一条路：
    // 它走 `HTTP 200 + code ≠ 0`，归一化成 `kind: 'business'`，且 message 按服务端原文携带。
    // 这正是 `readLoginCode()` 取不到 code 时兜空串所依赖的那条契约分支
    // （`13.1` 把「code 为空或无效」判为 `8001`，见 `types/auth.ts` 的 `LoginRequest.code`）。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-DEAD')
    // ⚠️ `wx.login` 拿不到 code —— 恢复路径必须仍去发一次 `13.1`（用空 code 走契约的 8001），
    // 而不是在这里另造一个错误对象。失败成因从**契约**里读出来。
    wx.login.mockImplementation(reply({ code: '', errMsg: 'login:fail network error' }, false))
    replyByCall(wx, [
      unauthorized(2005), // ① refresh 失效
      jsonResponse({ code: 8001, message: '微信登录凭证无效', data: null }), // ② 13.1 → 8001
    ])

    const result = await request('/api/app/v1/orders')

    const sent = sentRequests(wx.request)
    expect(urlsOf(sent), 'wx.login 失败后仍发 13.1（空 code），且此后不得有任何补发').toEqual([
      ORDERS_URL,
      LOGIN_URL,
    ])
    expect(sent[1]!.data, 'code 取不到时按契约兜空串').toEqual({ code: '' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind, '8001 是业务错误（HTTP 200），不是 unauthorized').toBe('business')
    expect(result.error.code).toBe(8001)
    expect(result.error.message, 'message 按服务端原文携带').toBe('微信登录凭证无效')
  })

  it('重登失败的另一形态：13.1 撞 5xx → 成因如实交回，且**仍不补发**', async () => {
    // 四类成因里的最后一类（后端 5xx）。它归 `network`（`07` §4.2：5xx 的 message 是
    // 框架/网关话术，没有业务语义，不该拿去解释给用户）。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-DEAD')
    wx.login.mockImplementation(reply({ code: 'WX-C', errMsg: 'login:ok' }))
    replyByCall(wx, [
      unauthorized(2005),
      jsonResponse({ code: 0, message: 'ok', data: null }, 502), // ② 网关 502
    ])

    const result = await request('/api/app/v1/orders')

    expect(urlsOf(sentRequests(wx.request)), '5xx 之后不得有任何重放 / 补发').toEqual([ORDERS_URL, LOGIN_URL])
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('network')
    expect(result.error.httpStatus).toBe(502)
  })
})

describe('#19 13.2 不轮换 refresh：只更新 access', () => {
  it('刷新处理完后 storage 里的 refresh 原值不变', async () => {
    // ⚠️ 契约里 `13.2` 的响应**没有** `refreshToken`（只有 `accessToken` / `expiresIn`）。
    // 常见实现会习惯性地「把响应整个覆盖回 token 结构」—— 那会把 refresh 写成 `undefined`，
    // 下一次请求就会提前撞上 `2005` 而被迫重登，**把一个 30 天的会话缩成一次刷新**。
    // 本票的 acceptance criteria 明写要有这一条测试。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-MUST-SURVIVE')
    replyByCall(wx, [unauthorized(2001), refreshBody('ACCESS-FRESH'), okBody()])

    await request('/api/app/v1/orders')

    expect(getAccessToken(), 'access 被更新').toBe('ACCESS-FRESH')
    expect(getRefreshToken(), 'refresh 原值必须原样保留（13.2 不轮换 refresh）').toBe('REFRESH-MUST-SURVIVE')
    // 反面守卫：refresh 不能变成 `undefined` / 空串这类「看起来存在其实没了」的值。
    expect(getRefreshToken()).not.toBeUndefined()
  })
})

describe('#19 重放对写请求也安全', () => {
  it('POST 请求撞 401 后被重放，且 method / URL / body 原样不变', async () => {
    // 硬约束 2（`07` §4.3）：`AppAuthInterceptor.preHandle` 在控制器**之前**抛异常
    // （`AppAuthInterceptor.java:27-37`）⇒ 401 意味着请求**未被业务执行**，重放不构成重复提交。
    // 源码核实，非推断 —— 这也是「重放」这条策略敢用在建单 / 支付上的唯一理由。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyByCall(wx, [unauthorized(2001), refreshBody('ACCESS-NEW'), okBody({ orderId: 7 })])

    const payload = { lockerId: 3, cellId: 12 }
    const result = await request('/api/app/v1/orders', { method: 'POST', data: payload })

    const sent = sentRequests(wx.request)
    expect(sent, '写请求也要重放').toHaveLength(3)
    const original = sent[0]!
    const replay = sent[2]!
    expect(replay.method, '重放的 method 不变').toBe(original.method)
    expect(replay.method).toBe('POST')
    expect(replay.url, '重放的 URL 不变').toBe(original.url)
    expect(replay.data, '重放的 body 不变').toEqual(payload)
    // ⚠️ 只换令牌，不换别的东西：调用方给的额外头也必须跟着重放。
    expect(bearerOf(replay)).toBe('Bearer ACCESS-NEW')
    expect(result.ok).toBe(true)
  })

  it('重放保留调用方给的额外请求头', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyByCall(wx, [unauthorized(2001), refreshBody('ACCESS-NEW'), okBody()])

    await request('/api/app/v1/orders', { header: { 'X-Trace-Id': 'T-9' } })

    const replay = sentRequests(wx.request)[2]!
    expect(replay.header['X-Trace-Id'], '调用方的头必须跟着重放').toBe('T-9')
    expect(replay.header['content-type']).toBe('application/json')
  })
})

describe('#19 递归防护：13.1 / 13.2 自身不触发登录失效处理', () => {
  it('13.2 自身收到 401 → 不因它去调一次 13.2（递归）', async () => {
    // 硬约束 4：`13.1` / `13.2` 是鉴权链的例外（`WebMvcConfig.java:46-47` 的豁免名单）。
    // 若它们也走这套逻辑，一次刷新失败会去刷新「这次刷新」，立刻打出无限递归。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyByCall(wx, [unauthorized(2001, '刷新令牌无效')])

    // 直接打免鉴权出口 —— 这正是 `api/auth.ts` 里 `refresh()` 的形状。
    const { requestWithoutAuth } = await import('../../miniprogram/request')
    const result = await requestWithoutAuth('/api/app/v1/auth/refresh', {
      method: 'POST',
      header: { 'X-Refresh-Token': 'REFRESH-1' },
    })

    expect(urlsOf(sentRequests(wx.request)), '13.2 撞 401 不得再调 13.2').toEqual([REFRESH_URL])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind, '失败的 13.2 如实交回 unauthorized 给调用方').toBe('unauthorized')
  })

  it('13.1 自身收到 401 → 不触发刷新 / 重登（不递归）', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyByCall(wx, [unauthorized(2001)])

    const { requestWithoutAuth } = await import('../../miniprogram/request')
    const result = await requestWithoutAuth('/api/app/v1/auth/login', {
      method: 'POST',
      data: { code: 'C1' },
    })

    expect(urlsOf(sentRequests(wx.request)), '13.1 撞 401 不得去刷新，也不得再登录一次').toEqual([LOGIN_URL])
    expect(wx.login, '13.1 撞 401 不得再 wx.login').not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
  })

  it('⚠️ 用 request() 误调 13.1 / 13.2 时，豁免名单兜底同样挡住刷新逻辑', async () => {
    // 上两条走的是 `requestWithoutAuth` 这条**显式**的路。但豁免名单本身也必须挡住 ——
    // 否则后来者用 `request()` 直接调 13.2（很自然，因为它「也是个端点」）就会长出递归。
    // #18 已锁住「不带 access 头」那一半，这条锁住「不触发登录失效处理」这一半。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyByCall(wx, [unauthorized(2001)])

    const result = await request('/api/app/v1/auth/refresh', { method: 'POST' })

    expect(urlsOf(sentRequests(wx.request)), '名单内的端点不得触发刷新').toEqual([REFRESH_URL])
    expect(result.ok).toBe(false)
  })

  it('其余 401 业务请求照常走刷新（防「一律放行」的过度豁免）', async () => {
    // 反面守卫：豁免名单只有两个端点。若有人把「401 就不处理」写得过宽，
    // 正常业务请求的续期能力会整个消失 —— 而它正是本票的主体。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyByCall(wx, [unauthorized(2001), refreshBody('ACCESS-NEW'), okBody()])

    const result = await request('/api/app/v1/auth/logout', { method: 'POST' })

    expect(urlsOf(sentRequests(wx.request)), '/auth/* 里只有 login / refresh 豁免').toEqual([
      `${BASE_URL}/api/app/v1/auth/logout`,
      REFRESH_URL,
      `${BASE_URL}/api/app/v1/auth/logout`,
    ])
    expect(result.ok).toBe(true)
  })
})

describe('#19 非 401 的失败不进入这套逻辑', () => {
  it('403 照样直接交给调用方 —— 不刷新、不重登', async () => {
    // 只有 `kind === 'unauthorized'` 才进这套逻辑。`403` 是「按受限处理」（`07` §4.2），
    // 若被顺手也送进刷新，受限用户会看到「反复重试无果」而不是「你被限制了」。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyByCall(wx, [jsonResponse({ code: 5003, message: '无权限', data: null }, 403)])

    const result = await request('/api/app/v1/orders')

    expect(urlsOf(sentRequests(wx.request)), '403 不得触发刷新').toEqual([ORDERS_URL])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('forbidden')
  })

  it('5004 受限（即使带 403）交给调用方 —— 不刷新', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyByCall(wx, [jsonResponse({ code: 5004, message: '账号受限', data: null }, 403)])

    const result = await request('/api/app/v1/orders')

    expect(urlsOf(sentRequests(wx.request)), '5004 不得触发刷新').toEqual([ORDERS_URL])
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('restricted')
  })

  it('网络失败（非 401）直接交给调用方 —— 不刷新、不重放', async () => {
    // ⚠️ 这条是硬约束 5 的另一面（`01` §3.3 硬口径 1）：真正「可能已生效但响应丢失」的
    // 是网络超时，不是 401 —— 它靠读接口核对状态，**不靠重放**。若请求层在这里也重放，
    // 就正好造出了「用户点了支付 → 响应丢了 → 自动再扣一次」。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyByCall(wx, [{ errMsg: 'request:fail timeout' }])

    const result = await request('/api/app/v1/orders', { method: 'POST', data: { lockerId: 3 } })

    expect(urlsOf(sentRequests(wx.request)), '网络失败不得被重放').toEqual([ORDERS_URL])
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('network')
  })

  it('401 但没有业务码（非契约响应）→ 不猜分支，直接交给调用方', async () => {
    // `401` 的两个分支由 body 的 `2001` / `2005` 区分（`13.x` 的契约码）。收到一个
    // 读不出 code 的 401（网关页面、版本漂移）时，**如实交出**比替它猜一条路安全：
    // 猜错会白刷一次甚至误清登录态。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyByCall(wx, [jsonResponse('<html>401</html>', 401)])

    const result = await request('/api/app/v1/orders')

    expect(urlsOf(sentRequests(wx.request)), '读不出 code 的 401 不得触发刷新').toEqual([ORDERS_URL])
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('network')
  })
})

describe('#19 恢复的边界：各一次，且不粘住', () => {
  it('⚠️ 重放回来还是 401 → 只重放一次，不无限递归', async () => {
    // `07` §4.3 的口径是「刷新 / 重登**各一次**」。重放回来又撞 401 意味着「刚修好的令牌
    // 立刻又失效了」—— 那时再修一次就是递归，而且大概率永远修不好（服务端在持续拒绝）。
    // 正确做法是如实把那个 401 交回调用方。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyByCall(wx, [
      unauthorized(2001),
      refreshBody('ACCESS-NEW'),
      unauthorized(2001, '又失效了'), // 重放仍然 401
    ])

    const result = await request('/api/app/v1/orders')

    expect(urlsOf(sentRequests(wx.request)), '重放的 401 不得再触发一轮恢复').toEqual([
      ORDERS_URL,
      REFRESH_URL,
      ORDERS_URL,
    ])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind, '修不好的 401 如实交给调用方').toBe('unauthorized')
  })

  it('⚠️ 一轮恢复结束后，下一次 401 开启**新一轮**恢复（飞行位必须清空）', async () => {
    // 反面守卫：`inFlightRecovery` 若不在恢复结束时清空，第一次恢复之后**所有**请求
    // 都会挂到一个已经结束的 Promise 上 —— 第二个 401 永远修不好，且症状只在
    // 「先失败一次、再正常用一会儿」之后才出现（测试里最容易漏掉的一种）。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyByCall(wx, [
      unauthorized(2001), // ① 第一次业务请求撞 401
      refreshBody('ACCESS-NEW'), // ② 第一轮刷新
      okBody(), // ③ 重放成功
      unauthorized(2001), // ④ 后来的第二次业务请求又撞 401
      refreshBody('ACCESS-NEWER'), // ⑤ 必须是**新的一轮**刷新
      okBody(), // ⑥ 重放成功
    ])

    const first = await request('/api/app/v1/orders')
    const second = await request('/api/app/v1/profile')

    const sent = sentRequests(wx.request)
    expect(requestsTo(sent, REFRESH_URL), '两轮各刷一次').toHaveLength(2)
    expect(bearerOf(sent[5]!), '第二轮重放带的是第二次刷新拿到的令牌').toBe('Bearer ACCESS-NEWER')
    expect(first.ok && second.ok).toBe(true)
  })

  it('storage 里没有 refresh token 时撞 2001 → 直接清态重登，不空刷一次 13.2', async () => {
    // `13.2` 的入参就是 refresh token。手里没有它时去调刷新，只会发出一个
    // `X-Refresh-Token: undefined` 的请求，然后必然失败 —— 白跑一趟还污染日志。
    // 这种状态下正确的路是直接清态重登。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    // 刻意**不**预置 refresh token
    wx.login.mockImplementation(reply({ code: 'WX-CODE-3', errMsg: 'login:ok' }))
    replyByCall(wx, [
      unauthorized(2001),
      loginBody('ACCESS-RELOGIN', 'REFRESH-RELOGIN'),
      okBody(),
    ])

    const result = await request('/api/app/v1/orders')

    expect(requestsTo(sentRequests(wx.request), REFRESH_URL), '没有 refresh 就不该去调 13.2').toHaveLength(0)
    expect(requestsTo(sentRequests(wx.request), LOGIN_URL), '直接走重登').toHaveLength(1)
    expect(result.ok).toBe(true)
  })

  it('重登成功后 refresh 也被换上新的（重登拿的是整套新令牌）', async () => {
    // 与「`13.2` 不轮换 refresh」是一对：`13.1` **会**给新的 refresh，所以清态重登之后
    // storage 里必须是一整套新令牌 —— 若只写了 access，下一个 30 天会话就断了。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-DEAD')
    wx.login.mockImplementation(reply({ code: 'WX-CODE-4', errMsg: 'login:ok' }))
    replyByCall(wx, [unauthorized(2005), loginBody('ACCESS-R', 'REFRESH-R'), okBody()])

    await request('/api/app/v1/orders')

    expect(getAccessToken()).toBe('ACCESS-R')
    expect(getRefreshToken()).toBe('REFRESH-R')
  })
})
