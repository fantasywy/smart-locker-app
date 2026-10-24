// `13.17` / `13.18` 文件端点的请求形状 —— 手写请求函数，**只做搬运**。
//
// 契约事实源（smart-locker#131）：
//   • `POST /api/app/v1/files`：唯一 part `file`（`name: 'file'`），不收 `purpose`；
//     返回 `url` 恒为 `/api/app/v1/files/{id}`；业务错误走 HTTP 200 + `code`。
//   • `GET /api/app/v1/files/{id}`：只认 app 令牌、只能读本人上传；错误**一律非 200**
//     （`401/400/404/500`），`404` = 不存在或非本人（同形，缓存据此「记死」）。
//
// ⚠️ **`api/` 不含业务分支**：本模块**不判状态、不给文案、不读错误体**。
// `8008` 只是 `business` 异常对象、`404` 只是 `httpStatus: 404` 的 `network` 异常对象，
// 如何解释（「操作太频繁」「文件没了」）由页面 / 缓存策略决定。
//
// ⚠️ 上传**只带 `file` part**：无 `formData`、不设 `timeout`（沿用平台默认）。
// 缓存命名从响应的 `url` 解析，`data.id` 不参与任何客户端逻辑。

import type { AppFile } from '../types/files'
import type { RequestResult } from '../request/types'
import type { DownloadResult } from '../request/transfer'
import { FILES_PATH } from '../request/config'
import { download, upload } from '../request/transfer'

/**
 * 上传头像文件（`POST /api/app/v1/files`）。
 *
 * @param filePath 压缩流水线产出的 pending 路径（`USER_DATA_PATH/upload/{槽位}`）
 * @returns 成功时 `AppFile` DTO；失败时统一异常对象（**不抛异常**）
 */
export function uploadAvatar(filePath: string): Promise<RequestResult<AppFile>> {
  return upload<AppFile>(FILES_PATH, { filePath, name: 'file' })
}

/**
 * 下载头像文件（`GET /api/app/v1/files/{id}`）到调用方给的目标路径。
 *
 * @param fileId 从头像地址解析出的数字 id（**字符串**，只拼路径、不做数值运算）
 * @param filePath 目标文件路径 —— 缓存模块给 `{fileId}.part`，成功后才转正
 * @returns 成功时 `{ ok: true, filePath }`；失败时统一异常对象
 *
 * ⚠️ 本函数**不清理**目标文件：失败时 `.part` 的删除归缓存模块（它持有路径语义）。
 */
export function downloadAvatar(fileId: string, filePath: string): Promise<DownloadResult> {
  return download(`${FILES_PATH}/${fileId}`, { filePath })
}

// ⚠️ 路径字面量 `FILES_PATH` 的唯一家是 `request/config.ts`：
// 本模块与 `utils/avatar-cache.ts` 都从那里取，避免「缓存判据 / 请求路径」两处漂移。
