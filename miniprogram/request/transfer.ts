// **文件传输通道** —— `wx.uploadFile` / `wx.downloadFile` 的唯一出口。
//
// 三条通道、一个目录、一套纪律（#74）：
//   • JSON 端点       → `request/index.ts`（`wx.request`）
//   • 上传 / 下载     → 本文件（`wx.uploadFile` / `wx.downloadFile`）
// 三条通道共用 `recovery.ts` 的 Bearer 拼装与 401 恢复（**全端唯一**的恢复队列）。
//
// ⚠️ **两条通道都不解析 `2001/2005`**：上传的 `data` 是字符串、下载的错误体已落盘，
// 「读一个错误码」要额外读盘 / 解析；而两条通道统一走「先刷（失败转重登）→ 重放一次 →
// 仍 401 就如实返回」，净行为与按码分支完全一致。**两条通道必须行为一致** ——
// 同一个 401 在两处走不同分支是最难查的一类不一致。
//
// ⚠️ 本模块只做「发请求 + 归一化」，**不判业务状态、不给文案**：
// `404` 不被这里解释成「文件没了」（那是调用方的缓存策略），`8008` 也只是 `business`。

import type { RequestResult, UnifiedError } from './types'
import { classifyFailure, classifyResponse } from './normalize'
import { BASE_URL } from './config'
import { withAuthHeader, withLoginRecovery } from './recovery'

/** `upload()` 的入参 —— 只有「哪个本地文件」与「part 名」。 */
export interface UploadOptions {
  /** 要上传的本地文件路径（`USER_DATA_PATH/upload/{槽位}`）。 */
  filePath: string
  /** multipart part 名 —— 后端契约唯一 part 叫 `file`。 */
  name: string
  /**
   * 可选：把本次 `wx.uploadFile` 返回的 task 交给调用方。
   *
   * ⚠️ 401 恢复会**重放**，因此一次 `upload()` 可能回调多次：每次都是当次
   * `wx.uploadFile` 的返回对象。调用方若只想 abort「当前那一次」，保存最后一次即可；
   * 已结束的 task 再 abort 是无害的。
   */
  onTask?: (task: WechatMiniprogram.UploadTask) => void
}

/** `download()` 的入参 —— 直写目标文件。 */
export interface DownloadOptions {
  /** 下载目标路径（缓存模块给的是 `{fileId}.part`，成功后才 rename 成最终名）。 */
  filePath: string
}

/** 下载结果 —— 成功只承诺「目标文件已写好」，不承诺文件内容（200 才算成功）。 */
export type DownloadResult =
  | { ok: true; filePath: string }
  | { ok: false; error: UnifiedError }

/**
 * 上传一个本地文件到 `path`。
 *
 * @param path 端点路径（如 `/api/app/v1/files`），**不含** baseUrl
 * @returns 成功时 `{ ok: true, data }`（`data` 是上传响应 `data` 字段的原样 DTO）；
 *          失败时统一异常对象
 *
 * 归一化：`wx.uploadFile` 的 `data` 是 **JSON 字符串**，解析后交给 `classifyResponse()`
 * 走与 `wx.request` **同一条**归一化（`200 + code 0` → DTO；`200 + code ≠ 0` → `business`）。
 * 解析失败（网关 HTML、空串）归 `network` —— 与「非 JSON 响应」同一条口径。
 *
 * ⚠️ 只带 `filePath` / `name` / `header`：**无 `formData`**（`purpose` 由服务端固定），
 * **不设 `timeout`**（沿用平台默认）。
 */
export function upload<T>(path: string, options: UploadOptions): Promise<RequestResult<T>> {
  // 传输层的 401 不读契约码：恒定先刷（失败会自动转重登）。
  return withLoginRecovery<T>(() => dispatchUpload<T>(path, options), true)
}

/**
 * 下载 `path` 到调用方指定的 `filePath`。
 *
 * `wx.downloadFile` 的 `success` 回调**只要服务器有响应就会触发** —— `401` / `404` / `500`
 * 的错误体也会被写进目标文件。因此本函数**自判 `statusCode`**：
 *   • `200`        → `{ ok: true, filePath }`
 *   • `401`        → 进入统一恢复（先刷 → 失败转重登 → 重放一次）
 *   • 其余非 200   → `{ httpStatus, code: null, message: null, kind: 'network' }`
 *
 * 失败时**本函数不删文件**：目标路径由调用方（缓存模块）持有，它知道 `.part` 的清理时机。
 */
export function download(path: string, options: DownloadOptions): Promise<DownloadResult> {
  return withLoginRecovery<DownloadPayload>(
    () => dispatchDownload(path, options),
    // 同上传：不解析 2001/2005，恒定先刷（失败自动转重登）。
    true,
  ).then((result) => (result.ok ? { ok: true, filePath: result.data.filePath } : result))
}

/** 下载成功时 `withLoginRecovery` 内部的载体 —— 只是把 `filePath` 传出来。 */
interface DownloadPayload {
  filePath: string
}

/** `wx.uploadFile` 的一次调用 —— 包成 Promise，把原始事实交给归一化。 */
function dispatchUpload<T>(path: string, options: UploadOptions): Promise<RequestResult<T>> {
  return new Promise<RequestResult<T>>((resolve) => {
    const task = wx.uploadFile({
      url: `${BASE_URL}${path}`,
      filePath: options.filePath,
      name: options.name,
      // ⚠️ 与 `index.ts` 一样复制一份头：重放走的是同一个闭包，不能把同一个对象
      // 交出去后被下一轮就地改写（否则「第一次请求带了什么」在测试里不可观察）。
      header: withAuthHeader(path, {}),
      success: (res) => {
        // ⚠️ 401 **只看 statusCode**：传输层不解析 `2001/2005`，也不要求错误体是 JSON。
        // 若把 401 交给 `classifyResponse`，一个网关 HTML 401 会被归成 `network` 而
        // **不触发恢复** —— 与「两条通道统一先刷」的口径相反。
        if (res.statusCode === 401) {
          resolve({ ok: false, error: unauthorizedError() })
          return
        }
        resolve(classifyResponse<T>(res.statusCode, parseJson(res.data)))
      },
      fail: (err) => {
        resolve(classifyFailure(err.errMsg))
      },
    })
    // 在 `wx.uploadFile()` 返回后立刻交出 task —— 页面要在响应回来之前就能 abort。
    options.onTask?.(task)
  })
}

/** `wx.downloadFile` 的一次调用 —— statusCode 自判，401 交给统一恢复。 */
function dispatchDownload(
  path: string,
  options: DownloadOptions,
): Promise<RequestResult<DownloadPayload>> {
  return new Promise<RequestResult<DownloadPayload>>((resolve) => {
    wx.downloadFile({
      url: `${BASE_URL}${path}`,
      filePath: options.filePath,
      header: withAuthHeader(path, {}),
      success: (res) => {
        if (res.statusCode === 200) {
          resolve({ ok: true, data: { filePath: res.filePath } })
          return
        }
        if (res.statusCode === 401) {
          // 401 的 body 已写进目标文件，这里**不读它**：契约码读不出来也无所谓，
          // 恢复路径恒定是「先刷（失败转重登）」。
          resolve({ ok: false, error: unauthorizedError() })
          return
        }
        // ⚠️ 非 200 且非 401：`code` / `message` **恒为 null**。错误体在文件里，
        // 本模块不读盘；编一个 code / message 出来就是撒谎。
        resolve({ ok: false, error: networkStatusError(res.statusCode) })
      },
      fail: (err) => {
        resolve(classifyFailure(err.errMsg))
      },
    })
  })
}

/**
 * 传输层最小的两个错误对象工厂 —— 上传与下载必须长得**逐字节一样**。
 *
 * 两条通道各自内联一份字面量时，最危险的是其中一份「顺手」带上 `code` / `message`：
 * 下载的错误体在文件里、上传的响应是字符串，两边都读不出业务码，凭空补一个就是撒谎。
 */
function unauthorizedError(): UnifiedError {
  return { httpStatus: 401, code: null, message: null, kind: 'unauthorized' }
}

function networkStatusError(httpStatus: number): UnifiedError {
  return { httpStatus, code: null, message: null, kind: 'network' }
}

/**
 * 把 `wx.uploadFile` 的 `data` 字符串解析成对象 —— 解析不了就把原串交回去。
 *
 * 交回原串而不是 `null`：`classifyResponse` 对「读不出 `code`」的判据是同一个，
 * 但保留原串让「非 JSON 响应」在归一化里仍是同一条分支，也便于将来调试。
 */
function parseJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown
  } catch {
    return data
  }
}
