// **头像选图 / 压缩流水线** —— 选图后唯一合法的输入是**已经落盘的 pending 文件**。
//
// 为什么第一步是 `copyFile`：`chooseAvatar` 给的是临时路径，平台可能在任意时刻回收；
// 而上传失败后「重试不重选」要求文件还在。⇒ 先把它复制到
// `USER_DATA_PATH/upload/{槽位}`，后续每一步（getImageInfo / compressImage / stat）
// 都以这个 pending 为输入，临时路径不再参与。
//
// 上限与后端 `smart-locker.file.avatar-max-bytes` 是**同一个数**（2,097,152），
// 客户端写死、不做配置项。长边上限 1080，依赖基础库 2.26.0 的
// `compressedWidth` / `compressedHeight`（项目 `libVersion` 2.32.3 已满足）。
//
// ⚠️ `quality` 对 png / webp 无效（iOS 只压 JPG）⇒ png 截图只能靠尺寸缩放。
// 若真机实测缩到 1080 仍超限，属于 map 的「Not yet specified」——**不在这里编造
// 第四轮策略**（没有 cropImage；二期）。
//
// ⚠️ 本模块**没有任何用户可见文案**：结果里的 `reason` 是机器可读的判别键，
// 「图片过大，请换一张」由页面从文案层取。这样「文案只有一个家」不因压缩失败而破例。

/** 后端 `avatar-max-bytes` 的同一个数 —— 客户端写死。 */
export const AVATAR_MAX_BYTES = 2_097_152

/** 长边上限 —— 只缩长边，短边由 `compressedWidth/Height` 按比例推导。 */
export const AVATAR_MAX_EDGE = 1080

/** 压缩质量的三轮 —— 80 → 60 → 40，最多三次 `compressImage`。 */
const AVATAR_QUALITIES = [80, 60, 40] as const

/** pending 的槽位名 —— 本票只有头像一个用途；将来有第二个用途再谈参数化。 */
const AVATAR_SLOT = 'avatar'

/**
 * pending 的绝对路径 —— `prepareAvatar()` 的落点，也是上传成功后被
 * `avatar-cache.promotePendingAvatar()` 直接 rename 进缓存的源文件。
 *
 * ⚠️ 路径只在**调用时**拼：`wx.env.USER_DATA_PATH` 在模块求值期可能还不可用（测试桩
 * 的安装顺序），而常量化的路径会把这个顺序变成隐式依赖。
 */
export function avatarPendingPath(): string {
  return `${wx.env.USER_DATA_PATH}/upload/${AVATAR_SLOT}`
}

/** 流水线结果 —— 成功给出 pending 路径；失败只给机器可读原因。 */
export type PrepareAvatarResult =
  | { ok: true; filePath: string }
  | { ok: false; reason: 'too-large' | 'failed' }

/**
 * 选图 → 复制到 pending → 按需压缩 → 量字节。
 *
 * @param tempPath `bindchooseavatar` 给的临时路径
 * @returns 成功：pending 的本地路径（**上传用它**）；失败：`too-large`（三轮后仍超限）
 *          或 `failed`（复制 / 读图 / 压缩 / 量字节任一步失败）
 *
 * ⚠️ 不抛异常：页面拿到的是判别联合，失败分支由页面决定怎么说。
 */
export async function prepareAvatar(tempPath: string): Promise<PrepareAvatarResult> {
  const pendingPath = avatarPendingPath()

  if (!(await ensureDir(`${wx.env.USER_DATA_PATH}/upload`))) {
    return { ok: false, reason: 'failed' }
  }
  if (!(await copyFile(tempPath, pendingPath))) {
    return { ok: false, reason: 'failed' }
  }

  const info = await readImageInfo(pendingPath)
  if (info === null) return { ok: false, reason: 'failed' }

  const initialSize = await statSize(pendingPath)
  if (initialSize === null) return { ok: false, reason: 'failed' }

  const longEdge = Math.max(info.width, info.height)
  if (longEdge <= AVATAR_MAX_EDGE && initialSize <= AVATAR_MAX_BYTES) {
    return { ok: true, filePath: pendingPath }
  }

  // ⚠️ 尺寸超限 ⇒ 至少压缩一轮；文件超限 ⇒ 最多三轮质量递减。
  // 两者合并成同一个 80 → 60 → 40 序列：**最多三次 compressImage**（票面验收逐字）。
  for (const quality of AVATAR_QUALITIES) {
    const compressed = await compressImage(pendingPath, info, quality, longEdge > AVATAR_MAX_EDGE)
    if (compressed === null) return { ok: false, reason: 'failed' }

    // 压缩产物是临时路径 —— 立刻覆盖回 pending，保持「后续只认 pending」这条纪律。
    if (!(await copyFile(compressed, pendingPath))) {
      return { ok: false, reason: 'failed' }
    }

    const size = await statSize(pendingPath)
    if (size === null) return { ok: false, reason: 'failed' }
    if (size <= AVATAR_MAX_BYTES) return { ok: true, filePath: pendingPath }
  }

  return { ok: false, reason: 'too-large' }
}

/** `compressImage` 的入参 —— 补上 2.26.0 的 `compressedWidth/Height`（SDK 类型未收录）。 */
interface CompressAvatarOptions extends WechatMiniprogram.CompressImageOption {
  compressedWidth?: number
  compressedHeight?: number
}

/**
 * 压缩一次 —— **只传长边那一侧**的尺寸。
 *
 * 传两边会把短边也钉成 1080（比例失真）；只传长边，微信按原比例缩。
 */
function compressImage(
  src: string,
  info: { width: number; height: number },
  quality: number,
  resize: boolean,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const options: CompressAvatarOptions = { src, quality }
    // 尺寸没超限时只做质量压缩 —— 不能顺手把短边也钉成 1080。
    if (resize) {
      if (info.width >= info.height) options.compressedWidth = AVATAR_MAX_EDGE
      else options.compressedHeight = AVATAR_MAX_EDGE
    }

    wx.compressImage({
      ...options,
      success: (res) => resolve(res.tempFilePath),
      fail: () => resolve(null),
    })
  })
}

/** 读像素尺寸 —— 失败返回 `null`（不编造尺寸）。 */
function readImageInfo(src: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    wx.getImageInfo({
      src,
      success: (res) => resolve({ width: res.width, height: res.height }),
      fail: () => resolve(null),
    })
  })
}

/**
 * 量字节 —— 失败返回 `null`。
 *
 * ⚠️ 绝不能把「量不出来」当成 `0`：那会把一个未知大小的文件当成合格品上传，
 * 然后由服务端在最后一步拒绝 —— 用户的感受是「明明选好了却说失败」。
 */
function statSize(path: string): Promise<number | null> {
  return new Promise((resolve) => {
    wx.getFileSystemManager().stat({
      path,
      success: (res) => {
        const size = (res.stats as { size?: unknown }).size
        resolve(typeof size === 'number' ? size : null)
      },
      fail: () => resolve(null),
    })
  })
}

/** `copyFile` 的 Promise 包装 —— 失败返回 `false`，不抛。 */
function copyFile(srcPath: string, destPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    wx.getFileSystemManager().copyFile({
      srcPath,
      destPath,
      success: () => resolve(true),
      fail: () => resolve(false),
    })
  })
}

/**
 * 确保目录存在 —— 先 `access`，不存在再 `mkdir(recursive)`。
 *
 * ⚠️ 不直接 `mkdir` 然后吞掉「已存在」错误：那会把权限错误也一起吞掉。
 */
function ensureDir(dirPath: string): Promise<boolean> {
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
