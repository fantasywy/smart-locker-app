// **信用分明细端点（`13.16`）** —— 手写 DTO + 请求函数，**只做搬运**。
//
// 契约：API设计文档.md §13.16 `GET /api/app/v1/score-logs`
//（响应结构同管理端 §9.3，仅本人数据）。
//
// ⚠️ **`api/` 不含业务分支**：失败时页面怎么提示、每行怎么排版，都是页面 / 文案层
// 的裁决。本模块只把契约 DTO 与统一异常对象交出去。
//
// ⚠️ 响应的外层是 `{list,total}`，而 `utils/pagination.ts` 只认识
// `PageOf.records`。**`list → records` 只在这里映射一次** —— 页面不写
// `list` 这个字段名，列表页不会各映射一遍（那种重复迟早漂移成两种形状）。
//
// ⚠️ 本端点需要登录态（§13 总则：除 13.1/13.2 外均需 Bearer），走普通 `request()`。

import type { PageOf } from '../utils/pagination'
import type { ScoreLog, ScoreLogListResponse } from '../types/score'
import type { RequestResult } from '../request/types'
import { API_PREFIX } from '../request/config'
import { request } from '../request/index'

/** `13.16` 的路径 —— 页面不碰 URL。 */
export const SCORE_LOGS_ENDPOINT = `${API_PREFIX}/score-logs`

/**
 * `13.16` 读取当前登录用户的信用分明细。
 *
 * @param page 页码（服务端从 1 开始）
 * @param pageSize 每页条数（spec §10：每页 10）
 * @returns 成功时 `{records,total}`（已把契约的 `list` 映射成 `records`）
 */
export async function listScoreLogs(
  page: number,
  pageSize: number,
): Promise<RequestResult<PageOf<ScoreLog>>> {
  const result = await request<ScoreLogListResponse>(
    `${SCORE_LOGS_ENDPOINT}?page=${page}&pageSize=${pageSize}`,
  )
  if (!result.ok) return result
  return {
    ok: true,
    data: { records: result.data.list, total: result.data.total },
  }
}
