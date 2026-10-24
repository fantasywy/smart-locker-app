// **`utils/avatar-image.ts`** 的验收 —— issue #74 的压缩流水线。
//
// 判据全部来自票面：
//   • `copyFile` 到 `USER_DATA_PATH/upload/{槽位}`（pending）；
//   • `getImageInfo` 判长边 > 1080 → `compressImage`，**只传长边那一侧**的
//     `compressedWidth` / `compressedHeight`，quality 80；
//   • `stat` 量字节，超 2,097,152 则 quality 80 → 60 → 40 重试、最多 3 轮；
//   • 仍超 → 返回「过大」（reason 是机器可读的 `too-large`，文案由页面层负责）。
//
// ⚠️ 断言的是**平台 API 的调用序与入参**（外部可观察），不是内部循环写法。

import { describe, expect, it, vi } from 'vitest'
import { installWxStub } from '../helpers/wx'
import type { InstalledWxStub, WxFileSystemManager, WxGetImageInfoSuccessResult } from '../helpers/wx'
import { prepareAvatar } from '../../miniprogram/utils/avatar-image'

const USER_DATA = '/USER_DATA'
const PENDING = `${USER_DATA}/upload/avatar`
const MAX_BYTES = 2_097_152

/** 一个「哪次 stat 返回多少字节」的队列；用完之后一律返回最后一个值。 */
function installFileSystem(
  wx: InstalledWxStub,
  sizes: readonly number[],
  options: { accessFails?: boolean; statFails?: boolean } = {},
): WxFileSystemManager {
  let statIndex = 0
  const fs: WxFileSystemManager = {
    access: vi.fn(({ success, fail }) => {
      queueMicrotask(() => {
        if (options.accessFails === true) fail?.({ errMsg: 'fail no such file or directory' })
        else success?.()
      })
    }),
    accessSync: vi.fn(),
    rename: vi.fn(),
    renameSync: vi.fn(),
    copyFile: vi.fn(({ success }) => {
      queueMicrotask(() => success?.())
    }),
    mkdir: vi.fn(({ success }) => {
      queueMicrotask(() => success?.())
    }),
    unlink: vi.fn(({ success }) => {
      queueMicrotask(() => success?.())
    }),
    readdir: vi.fn(),
    stat: vi.fn(({ success, fail }) => {
      const size = sizes[Math.min(statIndex, sizes.length - 1)]
      statIndex += 1
      queueMicrotask(() => {
        if (options.statFails === true) fail?.({ errMsg: 'fail no such file or directory' })
        else success?.({ stats: { size: size ?? 0 }, errMsg: 'stat:ok' })
      })
    }),
    statSync: vi.fn(() => ({ size: 0 })),
  }
  wx.getFileSystemManager.mockReturnValue(fs)
  return fs
}

/** 编排 `getImageInfo` 的尺寸。 */
function imageInfo(wx: InstalledWxStub, width: number, height: number): void {
  const info: WxGetImageInfoSuccessResult = {
    width,
    height,
    path: PENDING,
    type: 'jpg',
    orientation: 'up',
    errMsg: 'getImageInfo:ok',
  }
  wx.getImageInfo.mockImplementation((options) => {
    queueMicrotask(() => options.success?.(info))
  })
}

/** 编排 `compressImage`：每次回一个不同的临时路径。 */
function compressImage(wx: InstalledWxStub): void {
  let index = 0
  wx.compressImage.mockImplementation((options) => {
    index += 1
    queueMicrotask(() => options.success?.({ tempFilePath: `/tmp/compressed-${index}.jpg`, errMsg: 'compressImage:ok' }))
  })
}

describe('#74 prepareAvatar：尺寸缩放与 quality 三轮', () => {
  it('4000×3000 + 最终 3MB → 长边 1080 的 80 / 60 / 40 三轮后返回 too-large', async () => {
    const wx = installWxStub()
    installFileSystem(wx, [MAX_BYTES + 1])
    imageInfo(wx, 4000, 3000)
    compressImage(wx)

    const result = await prepareAvatar('/tmp/choose-avatar.jpg')

    expect(result).toEqual({ ok: false, reason: 'too-large' })
    const calls = wx.compressImage.mock.calls.map(([options]) => options)
    expect(calls, '最多 3 轮').toHaveLength(3)
    expect(calls.map((call) => call.quality)).toEqual([80, 60, 40])
    for (const call of calls) {
      expect(call.src, '压缩输入是已经落盘的 pending 文件').toBe(PENDING)
      // 「只传长边那一侧」：宽是长边 ⇒ 只传 compressedWidth，不传 compressedHeight。
      expect(call.compressedWidth).toBe(1080)
      expect(call).not.toHaveProperty('compressedHeight')
    }
    // pending 本身是第一次 copyFile 的产物。
    expect(wx.getFileSystemManager().copyFile.mock.calls[0]?.[0]).toMatchObject({
      srcPath: '/tmp/choose-avatar.jpg',
      destPath: PENDING,
    })
  })

  it('长边是高度（3000×4000）→ 只传 compressedHeight: 1080', async () => {
    const wx = installWxStub()
    installFileSystem(wx, [1024])
    imageInfo(wx, 3000, 4000)
    compressImage(wx)

    const result = await prepareAvatar('/tmp/choose-avatar.jpg')

    expect(result).toEqual({ ok: true, filePath: PENDING })
    const calls = wx.compressImage.mock.calls.map(([options]) => options)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.compressedHeight).toBe(1080)
    expect(calls[0]).not.toHaveProperty('compressedWidth')
  })

  it('长边 ≤ 1080 且 ≤ 2MB → 不压缩，直接返回 pending', async () => {
    const wx = installWxStub()
    installFileSystem(wx, [1024 * 1024])
    imageInfo(wx, 800, 600)

    const result = await prepareAvatar('/tmp/choose-avatar.jpg')

    expect(result).toEqual({ ok: true, filePath: PENDING })
    expect(wx.compressImage, '不需要压缩时一次都不该调').not.toHaveBeenCalled()
  })

  it('长边 ≤ 1080 但文件 > 2MB → 仍走 80 / 60 / 40 质量轮（不传尺寸）', async () => {
    const wx = installWxStub()
    installFileSystem(wx, [MAX_BYTES + 1])
    imageInfo(wx, 800, 600)
    compressImage(wx)

    const result = await prepareAvatar('/tmp/choose-avatar.jpg')

    expect(result).toEqual({ ok: false, reason: 'too-large' })
    const calls = wx.compressImage.mock.calls.map(([options]) => options)
    expect(calls.map((call) => call.quality)).toEqual([80, 60, 40])
    for (const call of calls) {
      expect(call).not.toHaveProperty('compressedWidth')
      expect(call).not.toHaveProperty('compressedHeight')
    }
  })

  it('第二轮就降到 2MB 以内 → 返回成功，不再打第三轮', async () => {
    const wx = installWxStub()
    // 初始 3MB（进入压缩）→ 第一轮 3MB（超）→ 第二轮 1.5MB（成功）
    installFileSystem(wx, [MAX_BYTES + 1, MAX_BYTES + 1, 1_500_000])
    imageInfo(wx, 4000, 3000)
    compressImage(wx)

    const result = await prepareAvatar('/tmp/choose-avatar.jpg')

    expect(result).toEqual({ ok: true, filePath: PENDING })
    expect(wx.compressImage.mock.calls.map(([options]) => options.quality)).toEqual([80, 60])
  })

  it('恰好 2,097,152 字节 → 视为未超限', async () => {
    const wx = installWxStub()
    installFileSystem(wx, [MAX_BYTES])
    imageInfo(wx, 800, 600)

    const result = await prepareAvatar('/tmp/choose-avatar.jpg')

    expect(result).toEqual({ ok: true, filePath: PENDING })
  })

  it('copyFile / getImageInfo 失败 → reason failed（不抛异常）', async () => {
    const wx = installWxStub()
    installFileSystem(wx, [1024])
    imageInfo(wx, 800, 600)
    wx.getFileSystemManager().copyFile.mockImplementation(({ fail }) => {
      queueMicrotask(() => fail?.({ errMsg: 'fail no such file or directory' }))
    })

    expect(await prepareAvatar('/tmp/missing.jpg')).toEqual({ ok: false, reason: 'failed' })
  })

  it('stat 失败 → reason failed（不把未知大小当成 0）', async () => {
    const wx = installWxStub()
    installFileSystem(wx, [1024], { statFails: true })
    imageInfo(wx, 800, 600)

    expect(await prepareAvatar('/tmp/choose-avatar.jpg')).toEqual({ ok: false, reason: 'failed' })
  })
})

describe('#75 discardPendingAvatar：只删 pending，不碰缓存', () => {
  it('删掉 upload/avatar，缓存目录原样保留', async () => {
    const wx = installWxStub()
    const files = new Map<string, string>([
      [PENDING, 'pending-bytes'],
      [`${USER_DATA}/avatar/42`, 'cached-bytes'],
    ])
    const fs = installFileSystem(wx, [1024])
    fs.unlink.mockImplementation(({ filePath, success, fail }) => {
      queueMicrotask(() => {
        if (files.delete(filePath)) success?.()
        else fail?.({ errMsg: `fail no such file or directory ${filePath}` })
      })
    })

    const { discardPendingAvatar } = await import('../../miniprogram/utils/avatar-image')
    await discardPendingAvatar()

    expect(files.has(PENDING)).toBe(false)
    expect(files.get(`${USER_DATA}/avatar/42`)).toBe('cached-bytes')
    expect(fs.unlink).toHaveBeenCalledWith(expect.objectContaining({ filePath: PENDING }))
  })

  it('pending 不存在时静默 resolve（关闭弹层是尽力清理）', async () => {
    const wx = installWxStub()
    const fs = installFileSystem(wx, [1024])
    fs.unlink.mockImplementation(({ fail }) => {
      queueMicrotask(() => fail?.({ errMsg: 'fail no such file or directory' }))
    })

    const { discardPendingAvatar } = await import('../../miniprogram/utils/avatar-image')
    await expect(discardPendingAvatar()).resolves.toBeUndefined()
  })
})
