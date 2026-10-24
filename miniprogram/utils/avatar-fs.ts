// **头像文件系统原语** —— `avatar-cache.ts` 与 `avatar-image.ts` 共用的两条最小操作。
//
// 为什么单独成模块：`ensureDir()` 的「先 access、不存在再 mkdir(recursive)」顺序，
// 以及 `unlinkQuiet()` 的「尽力而为、永不 reject」语义，是两处都必须逐字一致的行为。
// 各抄一份，下一次「顺手优化」只会改到其中一份 —— 缓存清理与 pending 清理就此分叉。
//
// ⚠️ 只收真正共用的两条：`readdir` 仍留在缓存模块（它是缓存目录布局的知识，
// 不是通用原语）；不要把这个文件长成第二个 `FileSystemManager` 包装层。

/**
 * 确保目录存在 —— 先 `access`，不存在再 `mkdir(recursive)`。
 *
 * ⚠️ 不直接 `mkdir` 然后吞掉「已存在」错误：那会把权限错误也一起吞掉。
 */
export function ensureDir(dirPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const fs = wx.getFileSystemManager()
    fs.access({
      path: dirPath,
      success: () => resolve(true),
      fail: () => {
        fs.mkdir({
          dirPath,
          recursive: true,
          success: () => resolve(true),
          fail: () => resolve(false),
        })
      },
    })
  })
}

/** 删一个文件 —— 不存在 / 删不掉都静默（清理是尽力而为，不该把页面拖进失败态）。 */
export function unlinkQuiet(filePath: string): Promise<void> {
  return new Promise((resolve) => {
    wx.getFileSystemManager().unlink({
      filePath,
      success: () => resolve(),
      fail: () => resolve(),
    })
  })
}
