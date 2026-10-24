// **头像缓存**的验收 —— issue #74（`utils/avatar-cache.ts`）。
//
// 这块缓存是「可永久信任」的：`fileId` 的内容永不变（后端台账只增不改），所以
// 命中就同步返回、永不设过期。本文件把票面的每条判据落成外部行为：
//   • 地址判别只认 `^/api/app/v1/files/(\d+)$`，其余零网络请求；
//   • 命中 → 0 次 `downloadFile`；未命中 → 1 次（并发也只 1 次）；
//   • 只有 `.part` → 视为无缓存并重下（两段式落盘，只有最终名算数）；
//   • `404` 后本次运行期不再请求；其余失败下次再试；
//   • 写缓存前校验目标 id 仍是当前头像 id（防 stale write）；
//   • 清理后 `avatar/` 只剩当前 `fileId` 一个文件、`upload/` 清空；
//   • 上传成功后 pending 直接 rename 进缓存，**不下载**。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWxStub } from '../helpers/wx'
import type {
  InstalledWxStub,
  WxDownloadFileOptions,
  WxDownloadFileSuccessResult,
  WxFileSystemManager,
} from '../helpers/wx'

const USER_DATA = '/USER_DATA'
const AVATAR_DIR = `${USER_DATA}/avatar`
const UPLOAD_DIR = `${USER_DATA}/upload`
const AVATAR_42 = `${AVATAR_DIR}/42`
const PART_42 = `${AVATAR_DIR}/42.part`
const PENDING = `${UPLOAD_DIR}/avatar`

/** 一个极小的内存盘 —— 断言「落盘后磁盘上剩下什么」而不是只看调用记录。 */
interface MemoryDisk {
  files: Map<string, string>
  dirs: Set<string>
  fs: WxFileSystemManager
}

function installDisk(
  wx: InstalledWxStub,
  initialFiles: Record<string, string> = {},
  initialDirs: readonly string[] = [AVATAR_DIR, UPLOAD_DIR],
): MemoryDisk {
  const files = new Map(Object.entries(initialFiles))
  const dirs = new Set(initialDirs)

  const childrenOf = (dirPath: string): string[] => {
    const prefix = `${dirPath}/`
    return [...files.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
      .filter((name) => !name.includes('/'))
  }

  const fs: WxFileSystemManager = {
    access: vi.fn(({ path, success, fail }) => {
      queueMicrotask(() => {
        if (files.has(path) || dirs.has(path)) success?.()
        else fail?.({ errMsg: `fail no such file or directory ${path}` })
      })
    }),
    accessSync: vi.fn((path: string) => {
      if (!files.has(path)) throw new Error(`fail no such file or directory ${path}`)
    }),
    rename: vi.fn(({ oldPath, newPath, success, fail }) => {
      queueMicrotask(() => {
        const content = files.get(oldPath)
        if (content === undefined) {
          fail?.({ errMsg: `fail no such file or directory ${oldPath}` })
          return
        }
        files.delete(oldPath)
        files.set(newPath, content)
        success?.()
      })
    }),
    renameSync: vi.fn((oldPath: string, newPath: string) => {
      const content = files.get(oldPath)
      if (content === undefined) throw new Error(`fail no such file or directory ${oldPath}`)
      files.delete(oldPath)
      files.set(newPath, content)
    }),
    copyFile: vi.fn(({ srcPath, destPath, success, fail }) => {
      queueMicrotask(() => {
        const content = files.get(srcPath)
        if (content === undefined) {
          fail?.({ errMsg: `fail no such file or directory ${srcPath}` })
          return
        }
        files.set(destPath, content)
        success?.()
      })
    }),
    mkdir: vi.fn(({ dirPath, success }) => {
      queueMicrotask(() => {
        dirs.add(dirPath)
        success?.()
      })
    }),
    unlink: vi.fn(({ filePath, success, fail }) => {
      queueMicrotask(() => {
        if (!files.delete(filePath)) {
          fail?.({ errMsg: `fail no such file or directory ${filePath}` })
          return
        }
        success?.()
      })
    }),
    readdir: vi.fn(({ dirPath, success, fail }) => {
      queueMicrotask(() => {
        if (!dirs.has(dirPath)) {
          fail?.({ errMsg: `fail no such file or directory ${dirPath}` })
          return
        }
        success?.({ files: childrenOf(dirPath), errMsg: 'readdir:ok' })
      })
    }),
    stat: vi.fn(({ path, success, fail }) => {
      queueMicrotask(() => {
        const content = files.get(path)
        if (content === undefined) {
          fail?.({ errMsg: `fail no such file or directory ${path}` })
          return
        }
        success?.({ stats: { size: Buffer.byteLength(content) }, errMsg: 'stat:ok' })
      })
    }),
    statSync: vi.fn((path: string) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`fail no such file or directory ${path}`)
      return { size: Buffer.byteLength(content) }
    }),
  }

  wx.getFileSystemManager.mockReturnValue(fs)
  return { files, dirs, fs }
}

/** 让挂起的微任务链走完（下载 / rename / unlink 都是回调 + Promise 驱动）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve()
}

/** 一份下载成功响应。 */
function downloadOk(filePath: string): WxDownloadFileSuccessResult {
  return { statusCode: 200, filePath, tempFilePath: `${filePath}.tmp`, errMsg: 'downloadFile:ok' }
}

/** 按调用序号回话；成功时**先写盘**（真实 `downloadFile` 就是这么做的）。 */
function arrangeDownloads(
  wx: InstalledWxStub,
  disk: MemoryDisk,
  results: readonly (WxDownloadFileSuccessResult | { errMsg: string })[],
): void {
  let index = 0
  wx.downloadFile.mockImplementation((options) => {
    const result = results[index]
    index += 1
    if (result === undefined) throw new Error(`wx.downloadFile 第 ${index} 次被调用，但只编排了 ${results.length} 个响应`)
    if ('statusCode' in result) disk.files.set(options.filePath ?? '', `bytes-${index}`)
    queueMicrotask(() => {
      if ('statusCode' in result) options.success?.(result)
      else options.fail?.(result)
    })
    return { abort: vi.fn() }
  })
}

let wx: InstalledWxStub

beforeEach(() => {
  wx = installWxStub()
})

/** 每次重新 import：模块里的「当前 id / 在飞下载 / 404 记死」都是运行期状态。 */
async function loadCache(): Promise<typeof import('../../miniprogram/utils/avatar-cache')> {
  vi.resetModules()
  return import('../../miniprogram/utils/avatar-cache')
}

describe('#74 地址判别：只认本站文件路径', () => {
  it('合法地址解析出 fileId；其余（null / 外链 / 空串 / 非数字）一律 null', async () => {
    const { parseAvatarFileId } = await loadCache()

    expect(parseAvatarFileId('/api/app/v1/files/42')).toBe('42')
    expect(parseAvatarFileId('/api/app/v1/files/0')).toBe('0')

    for (const invalid of [
      null,
      '',
      'https://wx.qlogo.cn/mmopen/abc/0',
      '/api/app/v1/files/abc',
      '/api/app/v1/files/42/extra',
      '/api/v1/files/42',
      ' /api/app/v1/files/42',
    ]) {
      expect(parseAvatarFileId(invalid), `不应认作头像地址：${String(invalid)}`).toBeNull()
    }
  })

  it('null / https 外链 / 空串 → 返回 null，且**零网络请求**', async () => {
    const { resolveAvatar } = await loadCache()
    installDisk(wx)

    expect(resolveAvatar(null)).toBeNull()
    expect(resolveAvatar('https://wx.qlogo.cn/mmopen/abc/0')).toBeNull()
    expect(resolveAvatar('')).toBeNull()
    expect(wx.downloadFile, '失配地址必须零请求').not.toHaveBeenCalled()
    expect(wx.getFileSystemManager, '连文件系统都不该碰').not.toHaveBeenCalled()
  })
})

describe('#74 缓存命中与两段式落盘', () => {
  it('命中 → 同步返回本地路径，0 次 downloadFile', async () => {
    const { resolveAvatar } = await loadCache()
    installDisk(wx, { [AVATAR_42]: 'cached' })

    expect(resolveAvatar('/api/app/v1/files/42')).toBe(AVATAR_42)
    expect(wx.downloadFile).not.toHaveBeenCalled()
  })

  it('未命中 → 后台下载 1 次；成功后才 rename 成最终名，回调拿到本地路径', async () => {
    const { resolveAvatar } = await loadCache()
    const disk = installDisk(wx)
    arrangeDownloads(wx, disk, [downloadOk(PART_42)])

    let readyPath: string | null = null
    expect(resolveAvatar('/api/app/v1/files/42', (path) => (readyPath = path))).toBeNull()
    await settle()

    expect(wx.downloadFile).toHaveBeenCalledTimes(1)
    expect(disk.fs.rename).toHaveBeenCalledWith(
      expect.objectContaining({ oldPath: PART_42, newPath: AVATAR_42 }),
    )
    expect(disk.files.has(AVATAR_42)).toBe(true)
    expect(disk.files.has(PART_42)).toBe(false)
    expect(readyPath).toBe(AVATAR_42)
  })

  it('⚠️ 只有 `.part` 没有最终名 → 视为无缓存并重下', async () => {
    const { resolveAvatar } = await loadCache()
    const disk = installDisk(wx, { [PART_42]: 'half-downloaded' })
    arrangeDownloads(wx, disk, [downloadOk(PART_42)])

    expect(resolveAvatar('/api/app/v1/files/42')).toBeNull()
    await settle()

    expect(wx.downloadFile, '半截文件不能当缓存').toHaveBeenCalledTimes(1)
    expect(disk.files.has(AVATAR_42)).toBe(true)
  })

  it('同一 fileId 并发进入 → 只下载 1 次（单一飞行）', async () => {
    const { resolveAvatar } = await loadCache()
    const disk = installDisk(wx)
    arrangeDownloads(wx, disk, [downloadOk(PART_42)])

    const ready: string[] = []
    resolveAvatar('/api/app/v1/files/42', (path) => ready.push(path))
    resolveAvatar('/api/app/v1/files/42', (path) => ready.push(path))
    await settle()

    expect(wx.downloadFile).toHaveBeenCalledTimes(1)
    expect(ready).toEqual([AVATAR_42, AVATAR_42])
  })

  it('404 → 本次运行期记死；第二次进入不再请求', async () => {
    const { resolveAvatar } = await loadCache()
    const disk = installDisk(wx)
    arrangeDownloads(wx, disk, [{ ...downloadOk(PART_42), statusCode: 404 }])

    expect(resolveAvatar('/api/app/v1/files/42')).toBeNull()
    await settle()
    expect(resolveAvatar('/api/app/v1/files/42')).toBeNull()
    await settle()

    expect(wx.downloadFile, '404 后本运行期不得再试').toHaveBeenCalledTimes(1)
    expect(disk.files.has(PART_42), '错误体必须从 .part 清掉').toBe(false)
  })

  it('非 404 失败 → 下次进入再试（不记死）', async () => {
    const { resolveAvatar } = await loadCache()
    const disk = installDisk(wx)
    arrangeDownloads(wx, disk, [
      { ...downloadOk(PART_42), statusCode: 500 },
      downloadOk(PART_42),
    ])

    expect(resolveAvatar('/api/app/v1/files/42')).toBeNull()
    await settle()
    expect(resolveAvatar('/api/app/v1/files/42')).toBeNull()
    await settle()

    expect(wx.downloadFile, '5xx 不是「文件没了」，下次要再试').toHaveBeenCalledTimes(2)
    expect(disk.files.has(AVATAR_42)).toBe(true)
  })

  it('⚠️ stale write：下载完成时目标 id 已变 → 不落最终名、不回调', async () => {
    const { resolveAvatar } = await loadCache()
    const disk = installDisk(wx)
    const pendingDownloads: WxDownloadFileOptions[] = []
    wx.downloadFile.mockImplementation((options) => {
      pendingDownloads.push(options)
      return { abort: vi.fn() }
    })

    let ready42 = false
    resolveAvatar('/api/app/v1/files/42', () => (ready42 = true))
    resolveAvatar('/api/app/v1/files/43', () => undefined)
    // 让两个下载真正起飞（`ensureDir` 是异步的，downloadFile 不在同一个 tick 里）。
    await settle()
    expect(pendingDownloads).toHaveLength(2)

    // 先完成旧的 42 —— 此时当前 id 已经是 43。
    disk.files.set(PART_42, 'bytes')
    pendingDownloads[0]?.success?.(downloadOk(PART_42))
    await settle()

    expect(disk.files.has(AVATAR_42), '过期下载不得写进缓存').toBe(false)
    expect(disk.files.has(PART_42), '过期下载的 .part 必须清掉').toBe(false)
    expect(ready42, '过期下载不得回调换图').toBe(false)
  })
})

describe('#74 上传成功：pending 直接转正，不下载', () => {
  it('promotePendingAvatar 把 upload/avatar rename 成 avatar/{fileId}', async () => {
    const { promotePendingAvatar } = await loadCache()
    const disk = installDisk(wx, { [PENDING]: 'uploaded-bytes' })

    const ok = await promotePendingAvatar('42')

    expect(ok).toBe(true)
    expect(disk.files.get(AVATAR_42)).toBe('uploaded-bytes')
    expect(disk.files.has(PENDING)).toBe(false)
    expect(wx.downloadFile, '上传成功不得再下载').not.toHaveBeenCalled()
  })

  it('pending 不存在 → 返回 false（调用方可回退到下载兜底）', async () => {
    const { promotePendingAvatar } = await loadCache()
    installDisk(wx)

    expect(await promotePendingAvatar('42')).toBe(false)
  })
})

describe('#74 清理：只留当前 id', () => {
  it('删 ≠ 当前 id 的最终文件、删 .part、清空 upload/', async () => {
    const { cleanupAvatarCache } = await loadCache()
    const disk = installDisk(wx, {
      [`${AVATAR_DIR}/41`]: 'old',
      [AVATAR_42]: 'current',
      [`${AVATAR_DIR}/43.part`]: 'partial',
      [PENDING]: 'pending',
    })

    await cleanupAvatarCache('42')

    expect([...disk.files.keys()].sort()).toEqual([AVATAR_42])
    expect(disk.files.get(AVATAR_42)).toBe('current')
  })

  it('当前 id 为 null → 删光全部最终文件与 .part', async () => {
    const { cleanupAvatarCache } = await loadCache()
    const disk = installDisk(wx, {
      [`${AVATAR_DIR}/41`]: 'old',
      [AVATAR_42]: 'current',
      [`${AVATAR_DIR}/43.part`]: 'partial',
    })

    await cleanupAvatarCache(null)

    expect(disk.files.size).toBe(0)
  })
})
