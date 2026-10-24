// **`api/files.ts`** 的验收 —— issue #74：只做搬运（不判状态、不给文案）。
//
// 端点形状的事实源：后端契约 §3.1 / §3.2。
//   • 上传 `POST /api/app/v1/files`：唯一 part `file`（`name: 'file'`），无 `formData`、
//     不设 `timeout`。
//   • 读 `GET /api/app/v1/files/{id}`：直写目标文件（缓存模块给 `{fileId}.part`）。

import { describe, expect, it, vi } from 'vitest'
import { installWxStub, seedStorage } from '../helpers/wx'
import { BASE_URL } from '../../miniprogram/request/config'
import { downloadAvatar, uploadAvatar } from '../../miniprogram/api/files'

const FILES_URL = `${BASE_URL}/api/app/v1/files`

describe('#74 api/files：端点与调用形状只做搬运', () => {
  it('uploadAvatar 只带 file part、无 formData / timeout，并把 DTO 原样交回', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-1')
    wx.uploadFile.mockImplementation((options) => {
      queueMicrotask(() => {
        options.success?.({
          statusCode: 200,
          data: JSON.stringify({
            code: 0,
            message: 'ok',
            data: { id: 42, url: '/api/app/v1/files/42', size: 1024, mime: 'image/jpeg', width: 1080, height: 1080 },
          }),
          errMsg: 'uploadFile:ok',
        })
      })
      return { abort: vi.fn() }
    })

    const result = await uploadAvatar('/USER_DATA/upload/avatar')

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.data.url).toBe('/api/app/v1/files/42')
    const [sent] = wx.uploadFile.mock.calls.map(([options]) => options)
    expect(sent?.url).toBe(FILES_URL)
    expect(sent?.filePath).toBe('/USER_DATA/upload/avatar')
    expect(sent?.name).toBe('file')
    expect(sent?.formData).toBeUndefined()
    expect(sent?.timeout).toBeUndefined()
  })

  it('downloadAvatar 用 fileId 拼读地址，直写调用方给的目标文件', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-1')
    wx.downloadFile.mockImplementation((options) => {
      queueMicrotask(() => {
        options.success?.({
          statusCode: 200,
          filePath: '/USER_DATA/avatar/42.part',
          tempFilePath: '/tmp/42',
          errMsg: 'downloadFile:ok',
        })
      })
      return { abort: vi.fn() }
    })

    const result = await downloadAvatar('42', '/USER_DATA/avatar/42.part')

    expect(result).toEqual({ ok: true, filePath: '/USER_DATA/avatar/42.part' })
    const [sent] = wx.downloadFile.mock.calls.map(([options]) => options)
    expect(sent?.url).toBe(`${FILES_URL}/42`)
    expect(sent?.filePath).toBe('/USER_DATA/avatar/42.part')
  })

  it('uploadAvatar 的业务错误只交回统一异常对象（不在这里判 / 给文案）', async () => {
    const wx = installWxStub()
    seedStorage('auth.accessToken', 'ACCESS-1')
    wx.uploadFile.mockImplementation((options) => {
      queueMicrotask(() => {
        options.success?.({
          statusCode: 200,
          data: JSON.stringify({ code: 8008, message: '操作过于频繁，请稍后再试', data: null }),
          errMsg: 'uploadFile:ok',
        })
      })
      return { abort: vi.fn() }
    })

    const result = await uploadAvatar('/USER_DATA/upload/avatar')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind, '8008 是业务错误，页面按 message 直出').toBe('business')
    expect(result.error.code).toBe(8008)
  })
})
