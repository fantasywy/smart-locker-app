// **附近站点的共享展示规则** —— 站点卡与地图卡片浮层共用。
//
// 为什么单独一层：同一站点在列表卡与全屏地图卡片里必须说同一句话。
// 可用状态标签、距离格式、坐标判定各写一份时，两处会慢慢分叉
// （「已满」在一处变「满载」、距离舍入一处 10 m 一处 1 m）。
//
// ⚠️ 本模块只做**展示格式**：不重算可用状态（服务端派生）、不排序、不碰 `wx.*`。

import { NEARBY_COPY } from '../startup/copy'
import type { NearbyAvailability, NearbySite } from '../types/nearby'

/** 可用状态的三档渲染结果 —— 文案来自 `NEARBY_COPY`，色档由调用方映射到 class。 */
export interface NearbyAvailabilityBadge {
  label: string
  tone: 'ok' | 'warn' | 'muted'
}

/**
 * 服务端码 → 固定文案 / 色档。
 *
 * ⚠️ 接口不区分离线与故障（两者都归「暂不可用」），这里也不多做一种档位。
 */
export const NEARBY_AVAILABILITY: Record<NearbyAvailability, NearbyAvailabilityBadge> = {
  1: { label: NEARBY_COPY.statusAvailable, tone: 'ok' },
  2: { label: NEARBY_COPY.statusFull, tone: 'warn' },
  3: { label: NEARBY_COPY.statusUnavailable, tone: 'muted' },
}

/** 坐标是否可用 —— 缺任何一轴都不出 marker、距离与导航。 */
export function hasSiteCoordinates(
  site: NearbySite,
): site is NearbySite & { lng: number; lat: number } {
  return (
    typeof site.lng === 'number' &&
    Number.isFinite(site.lng) &&
    typeof site.lat === 'number' &&
    Number.isFinite(site.lat)
  )
}

/**
 * 距离格式 —— 服务端只给整数米。
 *
 * <1 km：取整到 10 m 的米数；≥1 km：一位小数 + km。不加「步行」。
 * `0` 是合法距离，不能因为 falsy 被吃掉。
 */
export function formatNearbyDistance(meters: number | null): string {
  if (meters === null || !Number.isFinite(meters) || meters < 0) return ''
  if (meters < 1000) {
    const rounded = Math.round(meters / 10) * 10
    // ⚠️ 替换值走**函数形式**：字符串形式会把值里的 `$&` / `$'` 当成替换模式展开 ——
  // 关键字 / 站点名是用户与服务端给的任意文本，那种展开是实打实的注入面。
  return NEARBY_COPY.distanceMeters.replace('{value}', () => String(rounded))
  }
  return NEARBY_COPY.distanceKilometers.replace('{value}', () => (meters / 1000).toFixed(1))
}
