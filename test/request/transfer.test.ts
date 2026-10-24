// **传输层两个新出口**的验收 —— issue #74（`request/transfer.ts`）。
//
// 断言只落在**外部行为**：发出了什么请求（URL / filePath / name / 头 / 总次数）、
// 调用方拿到了什么、以及 `wx.*` 被调了几次。不测内部的 Promise 包装方式。
//
// 覆盖的 acceptance criteria：
//   • `upload` 归一化：`200 + code 0` → DTO；`200 + code ≠ 0` → `business`；
//     `401` → 恢复后重放一次；重放仍 401 → 如实返回。
//   • `download` 归一化：`200` → `{ filePath }`；`404` / `500` →
//     `{ httpStatus, code: null, message: null, kind: 'network' }`。
//   • 两条通道都**不解析** `2001/2005`：401 统一「先刷（失败转重登）→ 重放一次」。
//   • 上传只带一个 `file` part（`name: 'file'`），无 `formData`、无 `timeout`。

import { describe, expect, it, vi } from 'vitest'
import { installWxStub, jsonResponse, seedStorage } from '../helpers/wx'
import type {
  InstalledWxStub,
  WxDownloadFileSuccessResult,
  WxUploadFileSuccessResult,
} from '../helpers/wx'
import { BASE_URL } from '../../miniprogram/request/config'
import { request } from '../../miniprogram/request'
import { download, upload } from '../../miniprogram/request/transfer'

const FILES_URL = `${BASE_URL}/api/app/v1/files`
const FILE_URL = `${FILES_URL}/42`
const REFRESH_URL = `${BASE_URL}/api/app/v1/auth/refresh`

/** 一份 `wx.uploadFile` 的成功结果（`data` 是 JSON **字符串**，不是对象）。 */
function uploadBody(body: unknown, statusCode = 200): WxUploadFileSuccessResult {
  return { statusCode, data: JSON.stringify(body), errMsg: 'uploadFile:ok' }
}

/** 一份 `wx.downloadFile` 的成功结果（401/404 等也走 success）。 */
function downloadResult(statusCode: number, filePath: string): WxDownloadFileSuccessResult {
  return { statusCode, filePath, tempFilePath: `${filePath}.tmp`, errMsg: 'downloadFile:ok' }
}

/** 让 `wx.uploadFile` 按序回话，并返回一个可丢弃的 UploadTask。 */
function replyUploads(
  wx: InstalledWxStub,
  results: readonly (WxUploadFileSuccessResult | { errMsg: string })[],
): void {
  let index = 0
  wx.uploadFile.mockImplementation((options) => {
    const result = results[index]
    index += 1
    if (result === undefined) {
      throw new Error(`wx.uploadFile 第 ${index} 次被调用，但只编排了 ${results.length} 个响应`)
    }
    queueMicrotask(() => {
      if ('statusCode' in result) options.success?.(result)
      else options.fail?.(result)
    })
    return { abort: vi.fn() }
  })
}

/** 让 `wx.downloadFile` 按序回话，并返回一个可丢弃的 DownloadTask。 */
function replyDownloads(
  wx: InstalledWxStub,
  results: readonly (WxDownloadFileSuccessResult | { errMsg: string })[],
): void {
  let index = 0
  wx.downloadFile.mockImplementation((options) => {
    const result = results[index]
    index += 1
    if (result === undefined) {
      throw new Error(`wx.downloadFile 第 ${index} 次被调用，但只编排了 ${results.length} 个响应`)
    }
    queueMicrotask(() => {
      if ('statusCode' in result) options.success?.(result)
      else options.fail?.(result)
    })
    return { abort: vi.fn() }
  })
}

/** 一份契约形状的 `13.2` 刷新响应。 */
function refreshResponse(accessToken: string): ReturnType<typeof jsonResponse> {
  return jsonResponse({ code: 0, message: 'ok', data: { accessToken, expiresIn: 7200 } })
}

/** 让 `wx.request`（恢复链）按序回话。 */
function replyRefreshRequests(
  wx: InstalledWxStub,
  results: readonly ReturnType<typeof jsonResponse>[],
): void {
  let index = 0
  wx.request.mockImplementation((options) => {
    const result = results[index]
    index += 1
    if (result === undefined) {
      throw new Error(`wx.request 第 ${index} 次被调用，但只编排了 ${results.length} 个响应`)
    }
    queueMicrotask(() => options.success?.(result))
  })
}

describe('#74 upload：成功与业务错误都走现有归一化', () => {
  it('200 + code 0 → 返回 DTO；只带 file part、无 formData / timeout', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-1')
    replyUploads(wx, [
      uploadBody({
        code: 0,
        message: 'ok',
        data: { id: 42, url: '/api/app/v1/files/42', size: 18324, mime: 'image/png', width: 1080, height: 1080 },
      }),
    ])

    const result = await upload('/api/app/v1/files', { filePath: '/USER_DATA/upload/avatar', name: 'file' })

    expect(result).toEqual({
      ok: true,
      data: { id: 42, url: '/api/app/v1/files/42', size: 18324, mime: 'image/png', width: 1080, height: 1080 },
    })
    const [sent] = wx.uploadFile.mock.calls.map(([options]) => options)
    expect(sent).toMatchObject({
      url: FILES_URL,
      filePath: '/USER_DATA/upload/avatar',
      name: 'file',
      header: { Authorization: 'Bearer ACCESS-1' },
    })
    expect(sent?.formData, '上传不得带 formData（purpose 由服务端固定）').toBeUndefined()
    expect(sent?.timeout, '上传不得设 timeout（沿用平台默认）').toBeUndefined()
  })

  it('HTTP 200 + code ≠ 0 → kind business，message 按服务端原文携带', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-1')
    replyUploads(wx, [
      uploadBody({ code: 8008, message: '操作过于频繁，请稍后再试', data: null }),
    ])

    const result = await upload('/api/app/v1/files', { filePath: '/USER_DATA/upload/avatar', name: 'file' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toEqual({
      httpStatus: 200,
      code: 8008,
      message: '操作过于频繁，请稍后再试',
      kind: 'business',
    })
  })

  it('非 JSON 的 200 响应 → kind network（不得把字符串当 DTO）', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-1')
    replyUploads(wx, [{ statusCode: 200, data: '<html>200</html>', errMsg: 'uploadFile:ok' }])

    const result = await upload('/api/app/v1/files', { filePath: '/USER_DATA/upload/avatar', name: 'file' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('network')
    expect(result.error.code).toBeNull()
  })

  it('网络失败 → kind network，code / httpStatus 都为 null', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-1')
    replyUploads(wx, [{ errMsg: 'uploadFile:fail timeout' }])

    const result = await upload('/api/app/v1/files', { filePath: '/USER_DATA/upload/avatar', name: 'file' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toEqual({
      httpStatus: null,
      code: null,
      message: 'uploadFile:fail timeout',
      kind: 'network',
    })
  })
})

describe('#74 upload：401 先刷（失败转重登）→ 重放一次', () => {
  it('401 → 13.2 一次 → 原样重放，重放成功后拿 DTO', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyUploads(wx, [
      uploadBody({ code: 2001, message: '登录已过期', data: null }, 401),
      uploadBody({ code: 0, message: 'ok', data: { id: 42, url: '/api/app/v1/files/42' } }),
    ])
    replyRefreshRequests(wx, [refreshResponse('ACCESS-NEW')])

    const result = await upload('/api/app/v1/files', { filePath: '/USER_DATA/upload/avatar', name: 'file' })

    expect(result.ok).toBe(true)
    expect(wx.request, '13.2 恰好一次').toHaveBeenCalledTimes(1)
    expect(wx.request.mock.calls[0]?.[0].url).toBe(REFRESH_URL)
    const sent = wx.uploadFile.mock.calls.map(([options]) => options)
    expect(sent, '原请求 + 一次重放').toHaveLength(2)
    expect(sent[0]?.header?.Authorization).toBe('Bearer ACCESS-OLD')
    expect(sent[1]?.header?.Authorization, '重放必须带刷新后的新 access').toBe('Bearer ACCESS-NEW')
    expect(sent[1]?.filePath, '重放保持原 filePath').toBe('/USER_DATA/upload/avatar')
    expect(sent[1]?.name, '重放保持原 part 名').toBe('file')
  })

  it('⚠️ 401 的错误体不是 JSON 也照样恢复 —— 传输层不读契约码', async () => {
    // 下载的错误体已经落盘、上传的 data 只是字符串；若 401 的 body 是网关页面，
    // 「读 code」会把它误判成 network 而**不恢复**。传输层的判据只有 statusCode。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyUploads(wx, [
      { statusCode: 401, data: '<html>401</html>', errMsg: 'uploadFile:ok' },
      uploadBody({ code: 0, message: 'ok', data: { id: 42, url: '/api/app/v1/files/42' } }),
    ])
    replyRefreshRequests(wx, [refreshResponse('ACCESS-NEW')])

    const result = await upload('/api/app/v1/files', { filePath: '/USER_DATA/upload/avatar', name: 'file' })

    expect(result.ok).toBe(true)
    expect(wx.uploadFile, '一次原请求 + 一次重放').toHaveBeenCalledTimes(2)
    expect(wx.request, '401 即使读不出 code 也要恢复').toHaveBeenCalledTimes(1)
  })

  it('⚠️ 401 + 2005 也先走刷新 —— 传输层不解析 2001/2005', async () => {
    // 下载的错误体已经落盘、上传的 data 是字符串 —— 读一个错误码要额外读盘 / 解析。
    // 传输层统一「先刷 → 失败转重登」，净行为与按码分支一致，且两条通道行为一致。
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyUploads(wx, [
      uploadBody({ code: 2005, message: '刷新令牌已失效', data: null }, 401),
      uploadBody({ code: 0, message: 'ok', data: { id: 42, url: '/api/app/v1/files/42' } }),
    ])
    replyRefreshRequests(wx, [refreshResponse('ACCESS-NEW')])

    await upload('/api/app/v1/files', { filePath: '/USER_DATA/upload/avatar', name: 'file' })

    expect(wx.request, '即使是 2005，传输层也先刷一次（不解析契约码）').toHaveBeenCalledTimes(1)
    expect(wx.login, '刷新成功就不该重登').not.toHaveBeenCalled()
  })

  it('重建后仍 401 → 只重放一次、不再恢复，如实返回 unauthorized', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyUploads(wx, [
      uploadBody({ code: 2001, message: '登录已过期', data: null }, 401),
      uploadBody({ code: 2001, message: '又过期了', data: null }, 401),
    ])
    replyRefreshRequests(wx, [refreshResponse('ACCESS-NEW')])

    const result = await upload('/api/app/v1/files', { filePath: '/USER_DATA/upload/avatar', name: 'file' })

    expect(wx.uploadFile, '只发一次 + 重放一次').toHaveBeenCalledTimes(2)
    expect(wx.request, '重放的 401 不得触发第二轮恢复').toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('unauthorized')
    expect(result.error.httpStatus).toBe(401)
  })
})

describe('#74 三条通道共用同一套恢复', () => {
  it('普通请求与上传并发撞 401 → 只刷新一次（单一飞行跨通道）', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')

    const ordersUrl = `${BASE_URL}/api/app/v1/orders`
    let ordersCalls = 0
    let refreshCalls = 0
    wx.request.mockImplementation((options) => {
      if (options.url === ordersUrl) {
        ordersCalls += 1
        queueMicrotask(() => {
          options.success?.(
            ordersCalls === 1
              ? jsonResponse({ code: 2001, message: '登录已过期', data: null }, 401)
              : jsonResponse({ code: 0, message: 'ok', data: { id: 1 } }),
          )
        })
        return
      }
      if (options.url === REFRESH_URL) {
        refreshCalls += 1
        queueMicrotask(() => options.success?.(refreshResponse('ACCESS-NEW')))
        return
      }
      throw new Error(`未编排的 wx.request：${options.url}`)
    })

    let uploadCalls = 0
    wx.uploadFile.mockImplementation((options) => {
      uploadCalls += 1
      queueMicrotask(() => {
        options.success?.(
          uploadCalls === 1
            ? uploadBody({ code: 2001, message: '登录已过期', data: null }, 401)
            : uploadBody({ code: 0, message: 'ok', data: { id: 42, url: '/api/app/v1/files/42' } }),
        )
      })
      return { abort: vi.fn() }
    })

    const [probe, uploaded] = await Promise.all([
      request('/api/app/v1/orders'),
      upload('/api/app/v1/files', { filePath: '/USER_DATA/upload/avatar', name: 'file' }),
    ])

    expect(refreshCalls, '两条通道必须共用同一个恢复队列').toBe(1)
    expect(probe.ok && uploaded.ok).toBe(true)
    expect(uploadCalls).toBe(2)
  })
})

describe('#74 download：statusCode 自判，非 200 且非 401 归 network', () => {
  it('200 → { ok: true, filePath }；直写调用方给的目标路径', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-1')
    replyDownloads(wx, [downloadResult(200, '/USER_DATA/avatar/42.part')])

    const result = await download('/api/app/v1/files/42', { filePath: '/USER_DATA/avatar/42.part' })

    expect(result).toEqual({ ok: true, filePath: '/USER_DATA/avatar/42.part' })
    const [sent] = wx.downloadFile.mock.calls.map(([options]) => options)
    expect(sent).toMatchObject({
      url: FILE_URL,
      filePath: '/USER_DATA/avatar/42.part',
      header: { Authorization: 'Bearer ACCESS-1' },
    })
  })

  it('404（越权与不存在同形）→ httpStatus 404 / code null / kind network', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-1')
    replyDownloads(wx, [downloadResult(404, '/USER_DATA/avatar/42.part')])

    const result = await download('/api/app/v1/files/42', { filePath: '/USER_DATA/avatar/42.part' })

    expect(result).toEqual({
      ok: false,
      error: { httpStatus: 404, code: null, message: null, kind: 'network' },
    })
  })

  it('500 → 同形 network（code / message 都是 null）', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-1')
    replyDownloads(wx, [downloadResult(500, '/USER_DATA/avatar/42.part')])

    const result = await download('/api/app/v1/files/42', { filePath: '/USER_DATA/avatar/42.part' })

    expect(result).toEqual({
      ok: false,
      error: { httpStatus: 500, code: null, message: null, kind: 'network' },
    })
  })

  it('网络失败 → network / httpStatus null / message 是诊断串', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-1')
    replyDownloads(wx, [{ errMsg: 'downloadFile:fail timeout' }])

    const result = await download('/api/app/v1/files/42', { filePath: '/USER_DATA/avatar/42.part' })

    expect(result).toEqual({
      ok: false,
      error: { httpStatus: null, code: null, message: 'downloadFile:fail timeout', kind: 'network' },
    })
  })
})

describe('#74 download：401 也走同一套恢复', () => {
  it('401 → 13.2 一次 → 原样重放（同一 filePath）', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyDownloads(wx, [
      downloadResult(401, '/USER_DATA/avatar/42.part'),
      downloadResult(200, '/USER_DATA/avatar/42.part'),
    ])
    replyRefreshRequests(wx, [refreshResponse('ACCESS-NEW')])

    const result = await download('/api/app/v1/files/42', { filePath: '/USER_DATA/avatar/42.part' })

    expect(result).toEqual({ ok: true, filePath: '/USER_DATA/avatar/42.part' })
    expect(wx.request, '401 触发一次刷新').toHaveBeenCalledTimes(1)
    const sent = wx.downloadFile.mock.calls.map(([options]) => options)
    expect(sent).toHaveLength(2)
    expect(sent[0]?.header?.Authorization).toBe('Bearer ACCESS-OLD')
    expect(sent[1]?.header?.Authorization).toBe('Bearer ACCESS-NEW')
    expect(sent[1]?.filePath).toBe('/USER_DATA/avatar/42.part')
  })

  it('重放仍 401 → 如实返回 unauthorized（不再是 success 里的「文件」）', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    replyDownloads(wx, [
      downloadResult(401, '/USER_DATA/avatar/42.part'),
      downloadResult(401, '/USER_DATA/avatar/42.part'),
    ])
    replyRefreshRequests(wx, [refreshResponse('ACCESS-NEW')])

    const result = await download('/api/app/v1/files/42', { filePath: '/USER_DATA/avatar/42.part' })

    expect(wx.downloadFile, '只重放一次').toHaveBeenCalledTimes(2)
    expect(wx.request, '重放的 401 不得触发第二轮恢复').toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toEqual({
      httpStatus: 401,
      code: null,
      message: null,
      kind: 'unauthorized',
    })
  })
})

describe('#75 upload：可选 onTask 交出 wx.uploadFile 返回的 task', () => {
  it('首轮与 401 重放各回调一次，且回调的是 wx.uploadFile 当次返回的对象', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-OLD')
    seedStorage('auth.refreshToken', 'REFRESH-1')
    const tasks = [{ abort: vi.fn() }, { abort: vi.fn() }]
    let index = 0
    wx.uploadFile.mockImplementation((options) => {
      const task = tasks[index]
      index += 1
      queueMicrotask(() => {
        if (index === 1) {
          options.success?.(
            uploadBody({ code: 2001, message: '登录已过期', data: null }, 401),
          )
          return
        }
        options.success?.(uploadBody({ code: 0, message: 'ok', data: { id: 42, url: '/api/app/v1/files/42' } }))
      })
      return task as { abort: () => void }
    })
    replyRefreshRequests(wx, [refreshResponse('ACCESS-NEW')])

    const seen: unknown[] = []
    const result = await upload('/api/app/v1/files', {
      filePath: '/USER_DATA/upload/avatar',
      name: 'file',
      onTask: (task) => seen.push(task),
    })

    expect(result.ok).toBe(true)
    expect(wx.uploadFile).toHaveBeenCalledTimes(2)
    expect(seen).toEqual(tasks)
    expect(seen[0]).toBe(tasks[0])
    expect(seen[1]).toBe(tasks[1])
  })

  it('不传 onTask 时行为不变（不抛错）', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-1')
    replyUploads(wx, [
      uploadBody({ code: 0, message: 'ok', data: { id: 42, url: '/api/app/v1/files/42' } }),
    ])

    const result = await upload('/api/app/v1/files', { filePath: '/USER_DATA/upload/avatar', name: 'file' })

    expect(result.ok).toBe(true)
    expect(wx.uploadFile).toHaveBeenCalledTimes(1)
  })
})
