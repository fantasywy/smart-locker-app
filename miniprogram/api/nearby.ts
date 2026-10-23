// **附近柜机端点** —— 手写 DTO + 请求函数，**只做搬运**。
//
// 契约：spec #57 §8 / §13（后端待建）：
//   GET /api/app/v1/nearby/sites
//   GET /api/app/v1/nearby/cities
//
// ⚠️ `api/` 不含业务分支：失败怎么提示、卡面怎么排版都在页面 / 文案层。
// ⚠️ 服务端排序唯一决定列表顺序，本层不改顺序；`list → records` 只在这里映射一次。
// ⚠️ 两个端点都需要登录态，走普通 `request()`。

import type { PageOf } from '../utils/pagination'
import type {
  NearbyCity,
  NearbyCitiesResponse,
  NearbySite,
  NearbySitesResponse,
} from '../types/nearby'
import type { RequestResult } from '../request/types'
import { API_PREFIX } from '../request/config'
import { request } from '../request/index'

/** `GET /api/app/v1/nearby/sites` —— 页面不碰 URL。 */
export const NEARBY_SITES_ENDPOINT = `${API_PREFIX}/nearby/sites`

/** `GET /api/app/v1/nearby/cities` —— 页面不碰 URL。 */
export const NEARBY_CITIES_ENDPOINT = `${API_PREFIX}/nearby/cities`

/**
 * 附近站点查询参数。
 *
 * ⚠️ `city` **必填**：无定位时它是唯一过滤条件；城内搜索也必须带城市。
 * `lat` / `lng` 只能成对出现 —— 这由本函数的入参结构保证（两个可选字段由调用方成对选择）。
 */
export interface NearbySitesQuery {
  /** 纬度（GCJ-02）。与 `lng` 成对。 */
  lat?: number
  /** 经度（GCJ-02）。与 `lat` 成对。 */
  lng?: number
  /** 半径：客户端只发 3000 / 10000；关键词非空时忽略。 */
  radiusMeters?: number
  /** 城市名（必填）。 */
  city: string
  /** 城内搜索关键词；空串视为不传。 */
  keyword?: string
  /** 页码，从 1 开始。 */
  page?: number
  /** 每页条数，默认 20、上限 100。 */
  pageSize?: number
}

/** 拼查询串 —— 只追加有值的参数，顺序固定，便于测试与排障。 */
function queryOf(query: NearbySitesQuery): string {
  const parts: string[] = []
  if (query.lat !== undefined && query.lng !== undefined) {
    parts.push(`lat=${query.lat}`, `lng=${query.lng}`)
  }
  if (query.keyword === undefined || query.keyword === '') {
    if (query.radiusMeters !== undefined) parts.push(`radiusMeters=${query.radiusMeters}`)
  }
  parts.push(`city=${encodeURIComponent(query.city)}`)
  if (query.keyword !== undefined && query.keyword !== '') {
    parts.push(`keyword=${encodeURIComponent(query.keyword)}`)
  }
  if (query.page !== undefined) parts.push(`page=${query.page}`)
  if (query.pageSize !== undefined) parts.push(`pageSize=${query.pageSize}`)
  return parts.join('&')
}

/**
 * 查询附近站点（按站点聚合）。
 *
 * @returns 成功时 `{records,total}`（已把契约的 `list` 映射成 `records`）；
 *          顺序是服务端给的顺序，本函数**不排序、不去重**。
 */
export async function listNearbySites(
  query: NearbySitesQuery,
): Promise<RequestResult<PageOf<NearbySite>>> {
  const result = await request<NearbySitesResponse>(
    `${NEARBY_SITES_ENDPOINT}?${queryOf(query)}`,
  )
  if (!result.ok) return result
  return {
    ok: true,
    data: { records: result.data.list, total: result.data.total },
  }
}

/** 查询城市清单（不分页）。 */
export async function listNearbyCities(): Promise<RequestResult<NearbyCity[]>> {
  const result = await request<NearbyCitiesResponse>(NEARBY_CITIES_ENDPOINT)
  if (!result.ok) return result
  return { ok: true, data: result.data.list }
}
