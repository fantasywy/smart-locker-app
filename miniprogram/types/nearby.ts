// `GET /nearby/sites` / `GET /nearby/cities` 的**手写 DTO** —— 只有形状，没有行为。
//
// 契约：spec #57 §8 / §13（后端待建）。
//
// ⚠️ 本模块遵守类型层五条规则：不发明字段、不改字段名、可空显式标 `| null`、
// 枚举值与契约逐字一致、**找不到契约依据的字段不写**。
//
// ⚠️⚠️ **这里没有 `lockerId`、`lockers[].id`、`lockers[].code`，也没有 `site.status`。**
// 这不是遗漏：附近是只读站点目录（ADR-0003），响应形状本身就不给写动作留上下文。
// 柜机明细只有 `position + status`；站点的后台停用状态不下发，更不能被当成营业状态。
//
// ⚠️ 中文映射属文案层：`availability` / `lockers[].status` 的数字码不在这里翻译。

/**
 * 站点可用状态 —— 服务端派生，客户端**只做码→固定文案映射**。
 *
 * `1` 可存件 / `2` 已满 / `3` 暂不可用。
 * 派生规则（服务端唯一实现）：至少一台在线且四档合计 > 0 → 1；至少一台在线但合计 0 → 2；
 * 没有在线柜机（含零柜机）→ 3。客户端不重算，也不拿站点后台状态猜。
 */
export type NearbyAvailability = 1 | 2 | 3

/** 柜机状态 —— 1 在线 / 2 离线 / 3 故障 / 4 维护中。 */
export type NearbyLockerStatus = 1 | 2 | 3 | 4

/** 站内柜机明细 —— **只有位置与状态**，没有任何可用于查柜机页的标识。 */
export interface NearbyLocker {
  /** 柜机在站点内的落地描述；可空。 */
  position: string | null

  /** 柜机状态数字码。仅用于契约如实性；卡面不展示状态枚举。 */
  status: NearbyLockerStatus
}

/** 四档余位 —— 只统计**在线柜机**，四键恒齐全，0 也合法。 */
export interface NearbyCellAvailability {
  small: number
  medium: number
  large: number
  extraLarge: number
}

/**
 * 附近站点行。
 *
 * 契约字段：`siteId / name / city / address / lng / lat / distanceMeters /
 * businessHours / availability / cellAvailability / lockers`。
 *
 * ⚠️ `siteId` 是站点标识，用于分页去重与未来地图选中态 —— **不是 `lockerId`**。
 * ⚠️ 没有坐标 → `distanceMeters` 为 `null`；卡面不显示距离与导航。
 */
export interface NearbySite {
  siteId: number
  name: string
  city: string | null
  address: string | null
  lng: number | null
  lat: number | null
  distanceMeters: number | null
  businessHours: string | null
  availability: NearbyAvailability
  cellAvailability: NearbyCellAvailability
  lockers: NearbyLocker[]
}

/** `GET /nearby/sites` 响应 `data` —— `{list,total}`。 */
export interface NearbySitesResponse {
  list: NearbySite[]
  total: number
}

/** 城市清单项 —— `{city, siteCount}`。 */
export interface NearbyCity {
  city: string
  siteCount: number
}

/** `GET /nearby/cities` 响应 `data` —— `{list}`，不分页。 */
export interface NearbyCitiesResponse {
  list: NearbyCity[]
}
