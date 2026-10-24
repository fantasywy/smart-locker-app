// **头像缓存** —— 按 `fileId` 落 `USER_DATA_PATH`，可永久信任。
//
// 正确性前提（后端 §5）：`file_object` 行只增不改不删、对象只增不删 ⇒ 同一 `fileId`
// 的内容**永不变**。所以本模块**不设过期、不需要 ETag**：最终名存在就是可用缓存。
//
// 目录布局：
//
//     USER_DATA_PATH/avatar/{fileId}        最终名 —— **只有它存在才算有缓存**
//     USER_DATA_PATH/avatar/{fileId}.part   下载中 —— 两段式落盘的中转名
//     USER_DATA_PATH/upload/{槽位}          pending —— 选图 / 上传的产物
//
// 为什么必须两段式：`access()` 只判「存在」。若直接写最终名，中断会留下半截文件，
// 而它会被**永久**当成「有缓存」—— 一张永远修不好的破图。
//
// 加载时序：地址判别（只认 `^/api/app/v1/files/(\d+)$`）→ 命中同步返回本地路径
// （一次 `setData`，不闪）→ 未命中才后台下载，成功再回调。
//
// 失败：静默回默认图；`404` 本次运行期记死不再重试，其余失败下次再试。
// 写缓存前校验「目标 id 仍是当前头像 id」—— 迟到的旧下载不得盖掉新头像。

import { FILES_PATH } from '../request/config'
import { downloadAvatar } from '../api/files'
import { avatarPendingPath } from './avatar-image'
import { ensureDir, unlinkQuiet } from './avatar-fs'

/**
 * 头像地址的**唯一判据**。
 *
 * ⚠️ 只认本站文件地址：`null` / `https://…` 微信外链 / 空串 / 任意其它形态一律 null。
 * 失配时调用方走本地默认图、**零网络请求** —— 既避开 `<image>` 加载外链的域名问题，
 * 也避免为历史外链白打一次必然 404 的下载。
 */
const AVATAR_ADDRESS = new RegExp(`^${FILES_PATH}/(\\d+)$`)

/** 本次运行期已确认「文件没了」的 id —— 不再重试（下次冷启动会重新判断）。 */
const notFound = new Set<string>()

/** 在飞的下载 —— `fileId → Promise<最终路径 | null>`，全模块单一飞行。 */
const inFlight = new Map<string, Promise<string | null>>()

/**
 * 当前头像的 `fileId` —— 由最近一次 `resolveAvatar()` 决定。
 *
 * 它不是 UI 状态，而是**防 stale write 的判据**：下载完成时若它已经变了，
 * 说明用户在看另一张头像，这次下载的结果必须丢弃。
 */
let currentFileId: string | null = null

/**
 * 从头像地址解析 `fileId` —— 只认 `^/api/app/v1/files/(\d+)$`。
 *
 * @returns 数字 id 的字符串形式；失配返回 `null`
 */
export function parseAvatarFileId(address: string | null): string | null {
  if (address === null) return null
  return AVATAR_ADDRESS.exec(address)?.[1] ?? null
}

/**
 * 解析并加载一张头像。
 *
 * @param address 服务端 `profile.avatar` 原值（可能为 null / 历史外链）
 * @param onReady 后台下载成功后的回调 —— 参数是**最终缓存的本地路径**
 * @returns **同步**可用的本地路径（命中缓存时）；未命中 / 失配 / 已记死时返回 `null`
 *
 * ⚠️ 未命中时本函数**立即返回 null 并后台下载**，不返回 Promise：页面先画默认图，
 * 下载成功后由 `onReady` 换图。这样头像位永远有图，且不会出现「先白一下」。
 */
export function resolveAvatar(
  address: string | null,
  onReady?: (localPath: string) => void,
): string | null {
  const fileId = parseAvatarFileId(address)
  currentFileId = fileId
  if (fileId === null) return null

  const finalPath = avatarPath(fileId)
  if (existsSync(finalPath)) return finalPath
  if (notFound.has(fileId)) return null

  let task = inFlight.get(fileId)
  if (task === undefined) {
    task = downloadToCache(fileId)
    inFlight.set(fileId, task)
    // 结算后清空飞行位：失败也要清，否则「下次再试」永远挂在一个已结束的 Promise 上。
    void task.finally(() => {
      inFlight.delete(fileId)
    })
  }

  void task.then((localPath) => {
    // 双重校验：写盘前已在 `downloadToCache()` 里校验过一次；这里再挡住
    // 「下载完成到回调之间用户又换了头像」的最后一段窗口。
    if (localPath !== null && currentFileId === fileId) onReady?.(localPath)
  })
  return null
}

/**
 * 上传成功后把 pending **直接转正**为缓存 —— 不额外下载。
 *
 * 服务端原样存字节 ⇒ pending 的内容就是服务端的那张，省一次往返。
 *
 * @param fileId 从上传响应的 `url` 解析出的 id
 * @returns 是否转正成功；pending 不存在 / rename 失败时返回 `false`
 *          （调用方可回退到 `resolveAvatar()` 的下载兜底）
 *
 * ⚠️ 本函数不校验「当前 id」：调用时机由页面掌握（上传成功、且用户确认使用这张图）。
 * 它是一次显式的「采纳」，不是后台竞态。
 */
export async function promotePendingAvatar(fileId: string): Promise<boolean> {
  if (!/^\d+$/.test(fileId)) return false
  if (!(await ensureDir(avatarDir()))) return false

  const finalPath = avatarPath(fileId)
  // 覆盖旧文件：rename 在同名目标存在时的行为平台间不一致，先删干净。
  await unlinkQuiet(finalPath)
  return renameFile(avatarPendingPath(), finalPath)
}

/** `cleanupAvatarCache()` 的选项。 */
export interface CleanupAvatarCacheOptions {
  /**
   * 保留 `upload/` 里的 pending —— 弹层正开着、草稿可能还在时传 `true`。
   *
   * ⚠️ 这不是「永不清理 pending」：关闭弹层仍由 `closeEditor()` / `discardPendingAvatar()`
   * 负责删除。`onShow` 若把失败 / `8008` 的 pending 删掉，用户再点保存就会去上传一个
   * 不存在的路径，而「重试不重选」承诺的正是这个文件还在。
   */
  keepPending?: boolean
}

/**
 * 清理缓存 —— 由调用方传入**当前头像 id**（我的页 `onShow` 拿到 profile 之后）。
 *
 * 规则：删 ≠ 当前 id 的最终文件、删所有 `.part`；默认再清空 `upload/`。
 * `currentFileId === null` 表示当前没有可用头像 ⇒ 删光全部最终文件。
 *
 * ⚠️ 不要放进 `app.onLaunch`：那时还没有 profile，扫一次等于先删掉将要用到的缓存。
 * ⚠️ 必须在 `resolveAvatar()`（applyProfile）**之前**跑：否则刚起飞的下载 `.part`
 *    会被这里当成过期文件删掉，下载成功也 rename 不回来。
 */
export async function cleanupAvatarCache(
  currentId: string | null,
  options: CleanupAvatarCacheOptions = {},
): Promise<void> {
  const entries = await readdirFiles(avatarDir())
  if (entries !== null) {
    for (const name of entries) {
      if (name.endsWith('.part') || name !== currentId) {
        await unlinkQuiet(`${avatarDir()}/${name}`)
      }
    }
  }

  // pending 默认清空 —— 上传成功已转正、失败 / 放弃的都不该留到下次启动。
  // 但弹层开着时它是活草稿：删掉就等于撕毁「重试不重选」的承诺，交给 closeEditor 收盘。
  if (options.keepPending === true) return

  const pendingFiles = await readdirFiles(uploadDir())
  if (pendingFiles !== null) {
    for (const name of pendingFiles) {
      await unlinkQuiet(`${uploadDir()}/${name}`)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 路径与文件系统
// ─────────────────────────────────────────────────────────────────────────────

function avatarDir(): string {
  return `${wx.env.USER_DATA_PATH}/avatar`
}

function uploadDir(): string {
  return `${wx.env.USER_DATA_PATH}/upload`
}

function avatarPath(fileId: string): string {
  return `${avatarDir()}/${fileId}`
}

function partPath(fileId: string): string {
  return `${avatarPath(fileId)}.part`
}

/** 下载一次并两段式落盘 —— 永远 resolve（失败给 null），不把异常抛给调用方。 */
async function downloadToCache(fileId: string): Promise<string | null> {
  if (!(await ensureDir(avatarDir()))) return null

  const part = partPath(fileId)
  const finalPath = avatarPath(fileId)
  const result = await downloadAvatar(fileId, part)

  if (!result.ok) {
    // 错误体（401/404/500）也被 wx.downloadFile 写进了目标文件 —— 必须清掉。
    await unlinkQuiet(part)
    if (result.error.httpStatus === 404) notFound.add(fileId)
    return null
  }

  // ⚠️ 写前校验目标 id 仍是当前头像 id —— 迟到的旧下载不得盖掉新头像。
  if (currentFileId !== fileId) {
    await unlinkQuiet(part)
    return null
  }

  if (!(await renameFile(part, finalPath))) {
    await unlinkQuiet(part)
    return null
  }
  return finalPath
}

/** 同步判存在 —— 命中必须同步返回，否则头像位会先闪一下默认图。 */
function existsSync(path: string): boolean {
  try {
    wx.getFileSystemManager().accessSync(path)
    return true
  } catch {
    return false
  }
}

/** `rename` 的 Promise 包装 —— 失败返回 `false`。 */
function renameFile(oldPath: string, newPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    wx.getFileSystemManager().rename({
      oldPath,
      newPath,
      success: () => resolve(true),
      fail: () => resolve(false),
    })
  })
}

/** 读目录 —— 目录不存在返回 `null`（首次启动的正常状态）。 */
function readdirFiles(dirPath: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    wx.getFileSystemManager().readdir({
      dirPath,
      success: (res) => resolve(res.files),
      fail: () => resolve(null),
    })
  })
}
