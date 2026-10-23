// **内容端点（`GET /contents/{key}`）的验收** —— issue #68 / spec #57 §13。
//
// 本文件守两件在页面上测不到的事：
//   1. **免鉴权是硬要求**：`failure-exit` 的计费 / 常见问题必须在登录链失败时也能打开。
//      因此请求既不读 storage 里的 access，也不会在 401 时去跑登录恢复链。
//   2. **未知 key 如实失败**：契约是 `404 + 1002`，本层只搬运，不把它洗成成功。

import { describe, expect, it } from 'vitest'
import { installWxStub, jsonResponse, seedStorage } from '../helpers/wx'
import { requestsTo, sentRequests } from '../helpers/http'
import type { ContentKey } from '../../miniprogram/types/content'
import { BASE_URL, CONTENTS_PATH } from '../../miniprogram/request/config'
import { request } from '../../miniprogram/request'
import { getContent } from '../../miniprogram/api/contents'

/** 装桩并让下一次 `wx.request` 回一份固定响应。 */
function stubResponse(
  body: unknown,
  statusCode = 200,
): ReturnType<typeof installWxStub> {
  const wx = installWxStub()
  wx.request.mockImplementation((options) => {
    queueMicrotask(() => options.success?.(jsonResponse(body, statusCode)))
  })
  return wx
}

/** 一份契约形状的内容响应体。 */
function contentBody(key: ContentKey): Record<string, unknown> {
  return {
    code: 0,
    message: 'ok',
    data: {
      key,
      title: '忽略：导航栏标题来自 PAGE_TITLES',
      updatedAt: '2026-10-23T12:00:00+08:00',
      blocks: [
        { type: 'heading', text: '规则' },
        { type: 'paragraph', text: '内容由服务端维护' },
        { type: 'qa', question: '怎么用？', answer: '看这里' },
      ],
    },
  }
}

describe('#68 内容端点 · 免鉴权', () => {
  it('⚠️ 没有 token 也能取内容 —— 不调 wx.login、不带 Authorization', async () => {
    // 这条对应「登录链失败时 failure-exit 仍能打开内容页」：新装桩的 storage 是空的，
    // 若请求层试图走登录链，`wx.login` 是未编排桩会当场抛错。
    const wx = stubResponse(contentBody('billing'))

    const result = await getContent('billing')

    expect(result.ok).toBe(true)
    expect(wx.login).not.toHaveBeenCalled()
    const [sent] = sentRequests(wx.request)
    expect(sent.url).toBe(`${BASE_URL}${CONTENTS_PATH}/billing`)
    expect(sent.header.Authorization).toBeUndefined()
  })

  it('⚠️ 即使 storage 里有 access，内容请求也不带头（豁免名单兜底）', async () => {
    // 请求层有两条免鉴权闸门：调用点显式走 requestWithoutAuth，以及 config 的豁免名单。
    // 这条验的是后者 —— 后来者用 request() 直接调内容端点时也不会带上旧 token。
    const wx = stubResponse(contentBody('faq'))
    seedStorage('auth.accessToken', 'ACCESS-EXISTS')

    await request(`${CONTENTS_PATH}/faq`)

    const [sent] = sentRequests(wx.request)
    expect(sent.header.Authorization).toBeUndefined()
    expect(wx.login).not.toHaveBeenCalled()
  })

  it('⚠️ key 进入 URL，响应 DTO 原样交给调用方（api/ 只搬运）', async () => {
    const wx = stubResponse(contentBody('faq'))

    const result = await getContent('faq')

    expect(sentRequests(wx.request)[0]?.url).toBe(`${BASE_URL}${CONTENTS_PATH}/faq`)
    expect(result).toEqual({
      ok: true,
      data: {
        key: 'faq',
        title: '忽略：导航栏标题来自 PAGE_TITLES',
        updatedAt: '2026-10-23T12:00:00+08:00',
        blocks: [
          { type: 'heading', text: '规则' },
          { type: 'paragraph', text: '内容由服务端维护' },
          { type: 'qa', question: '怎么用？', answer: '看这里' },
        ],
      },
    })
  })
})

describe('#68 内容端点 · 未知 key 与网络失败', () => {
  it('未知 key（404 + 1002）→ 如实返回失败，不进登录恢复链', async () => {
    const wx = stubResponse({ code: 1002, message: '内容不存在', data: null }, 404)

    // 运行时 key 来自内容层的固定常量；这里显式验「服务端说未知」这一支，
    // 防止 api/ 把它当成成功把 `data: null` 交给页面。
    const result = await getContent('missing' as ContentKey)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('未知 key 不应成功')
    expect(result.error.httpStatus).toBe(404)
    expect(result.error.code).toBe(1002)
    expect(wx.login).not.toHaveBeenCalled()
    expect(requestsTo(sentRequests(wx.request), `${BASE_URL}${CONTENTS_PATH}/missing`)).toHaveLength(1)
  })

  it('网络失败 → 返回 network 分类，页面据此页内重试', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation((options) => {
      queueMicrotask(() => options.fail?.({ errMsg: 'request:fail timeout' }))
    })

    const result = await getContent('billing')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('网络失败不应成功')
    expect(result.error.kind).toBe('network')
    expect(wx.login).not.toHaveBeenCalled()
  })
})
