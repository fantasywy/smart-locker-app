// **内存盘** —— 页面 / 缓存测试共用的 `wx.getFileSystemManager()` 替身。
//
// 为什么需要它：我的页现在真的会读本地缓存、删 pending。只用「未编排即抛错」的
// `getFileSystemManager` 桩会让每个用例都先花十几行拼一个假盘；而只断言调用记录
// 又看不见「文件到底还在不在」。这里把两者合起来：调用记录是真的 `vi.fn`，
// 落盘结果也能直接查 `files`。
//
// ⚠️ 语义只覆盖本仓库用到的成员（access / rename / copyFile / mkdir / unlink /
// readdir / stat）。行为与真实 `FileSystemManager` 保持同一取向：所有回调都异步投递，
// 失败返回 `fail` 而不是抛异常。

import { vi } from 'vitest'
import type {
  InstalledWxStub,
  WxDownloadFileSuccessResult,
  WxFileSystemManager,
} from './wx'

export const USER_DATA = '/USER_DATA'
export const AVATAR_DIR = `${USER_DATA}/avatar`
export const UPLOAD_DIR = `${USER_DATA}/upload`

export interface MemoryDisk {
  files: Map<string, string>
  dirs: Set<string>
  fs: WxFileSystemManager
}

/** 装一个内存盘；默认认为 `avatar/` 与 `upload/` 两个目录已经存在。 */
export function installMemoryDisk(
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

/** 一份下载成功响应。 */
export function downloadOk(filePath: string): WxDownloadFileSuccessResult {
  return { statusCode: 200, filePath, tempFilePath: `${filePath}.tmp`, errMsg: 'downloadFile:ok' }
}

/** 按调用序号回话；成功时先写盘（真实 `downloadFile` 就是这么做的）。 */
export function arrangeDownloads(
  wx: InstalledWxStub,
  disk: MemoryDisk,
  results: readonly (WxDownloadFileSuccessResult | { errMsg: string })[],
): void {
  let index = 0
  wx.downloadFile.mockImplementation((options) => {
    const result = results[index]
    index += 1
    if (result === undefined) {
      throw new Error(
        `wx.downloadFile 第 ${index} 次被调用，但只编排了 ${results.length} 个响应`,
      )
    }
    if ('statusCode' in result) disk.files.set(options.filePath ?? '', `bytes-${index}`)
    queueMicrotask(() => {
      if ('statusCode' in result) options.success?.(result)
      else options.fail?.(result)
    })
    return { abort: vi.fn() }
  })
}
