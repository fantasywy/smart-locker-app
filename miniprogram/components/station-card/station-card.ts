// **附近站点卡** —— 只读站点目录的呈现单元（ticket #72 / spec #57 §8、§11）。
//
// ## 一张卡画什么
//
// 站点名 / 可用状态 / 距离（有则）/ 营业时间（缺则整行不渲染）/ 地址 /
// 四档余位（0 也渲染）/ 柜机位置（>2 台折叠）/ 导航（有坐标才出现）/
// 卡底只读说明。四档只写档名与数量，不写尺寸或示例物品。
//
// ## 三条边界
//
// 1. **组件不导航**：导航只发 `navigate`，`wx.openLocation` 归宿主。
//    整卡点击发 `select`，供 #73 的地图与列表共享选中态。
// 2. **可用状态只做码→固定文案映射**：服务端按柜机聚合后下发 1 / 2 / 3；
//    客户端不重算、不读站点后台状态（响应里根本没有 `site.status`），也不重排。
// 3. **无 `lockerId` / 柜机码 / 查看柜机 / 下单 / 预约**：柜机明细只有位置，
//    导航靠站点经纬度，不需要任何柜机标识。
//
// ⚠️ 本组件是纯展示 + 两个事件：不读 storage、不发请求、不碰任何 `wx.*`。

import { NEARBY_COPY } from '../../startup/copy'
import {
  NEARBY_AVAILABILITY,
  formatNearbyDistance,
  hasSiteCoordinates,
} from '../../utils/nearby'
import type { NearbyCellAvailability, NearbySite } from '../../types/nearby'

/** 四档余位的一行 —— 档名 + 数量。 */
interface CellRow {
  key: keyof NearbyCellAvailability
  label: string
  count: number
}

interface StationCardData {
  siteId: number
  name: string
  statusLabel: string
  statusTone: string
  distanceText: string
  showDistance: boolean
  businessHours: string
  showBusinessHours: boolean
  address: string
  showAddress: boolean
  cellRows: CellRow[]
  lockerPositions: string[]
  showLockers: boolean
  showLockerMore: boolean
  lockerMoreText: string
  lockerPositionLabel: string
  showNavigate: boolean
  navigateLabel: string
  footer: string
}

interface StationCardInstance {
  data: StationCardData & { site?: unknown }
  setData(patch: Partial<StationCardData>): void
  triggerEvent(name: string, detail?: Record<string, unknown>): void
}

/** 实例 → 当前站点。事件只带 `siteId`，不把 DTO 整个抛出去。 */
const currentSites = new WeakMap<StationCardInstance, NearbySite>()

/** 运行时守卫：属性来自外部，形状不可信。 */
function isNearbySite(value: unknown): value is NearbySite {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['siteId'] === 'number' && typeof candidate['name'] === 'string'
}

/** 四档余位 —— 顺序固定，0 也保留。 */
function cellRowsOf(cells: NearbyCellAvailability): CellRow[] {
  return [
    { key: 'small', label: NEARBY_COPY.cellLabels.small, count: cells.small },
    { key: 'medium', label: NEARBY_COPY.cellLabels.medium, count: cells.medium },
    { key: 'large', label: NEARBY_COPY.cellLabels.large, count: cells.large },
    {
      key: 'extraLarge',
      label: NEARBY_COPY.cellLabels.extraLarge,
      count: cells.extraLarge,
    },
  ]
}

/** 柜机位置 —— 空位置不占行；>2 台只展示前两条并折叠计数。 */
function lockerPositionsOf(site: NearbySite): string[] {
  return site.lockers
    .map((locker) => locker.position)
    .filter((position): position is string => typeof position === 'string' && position !== '')
}

/** 一条站点 → 渲染模型。 */
function viewOf(site: NearbySite): Partial<StationCardData> {
  const hasLocation = hasSiteCoordinates(site)
  const distanceText = hasLocation ? formatNearbyDistance(site.distanceMeters) : ''
  const hours = site.businessHours ?? ''
  const address = site.address ?? ''
  const positions = lockerPositionsOf(site)
  const firstPositions = positions.slice(0, 2)
  // 「共 N 台」的 N 是站点柜机台数，不是位置文案条数 —— 空 position 也是一台柜机。
  const hasMore = site.lockers.length > 2
  // 契约保证 1/2/3；运行时多一道兜底，未知码按「暂不可用」呈现而不是崩卡。
  const badge = NEARBY_AVAILABILITY[site.availability] ?? NEARBY_AVAILABILITY[3]

  return {
    siteId: site.siteId,
    name: site.name,
    statusLabel: badge.label,
    statusTone: badge.tone,
    distanceText,
    showDistance: distanceText !== '',
    businessHours: hours,
    showBusinessHours: hours !== '',
    address,
    showAddress: address !== '',
    cellRows: cellRowsOf(site.cellAvailability),
    lockerPositions: firstPositions,
    showLockers: firstPositions.length > 0,
    showLockerMore: hasMore,
    lockerMoreText: hasMore
      ? NEARBY_COPY.lockerMore.replace('{count}', String(site.lockers.length))
      : '',
    lockerPositionLabel: NEARBY_COPY.lockerPositionLabel,
    // 导航只依赖站点坐标，不依赖定位授权 —— 定位被拒时仍可从列表导航。
    showNavigate: hasLocation,
    navigateLabel: NEARBY_COPY.navigate,
    footer: NEARBY_COPY.footer,
  }
}

/** 清空渲染模型 —— 属性缺失 / 形状不对时不留半张旧卡。 */
function emptyData(): Partial<StationCardData> {
  return {
    siteId: 0,
    name: '',
    statusLabel: '',
    statusTone: '',
    distanceText: '',
    showDistance: false,
    businessHours: '',
    showBusinessHours: false,
    address: '',
    showAddress: false,
    cellRows: [],
    lockerPositions: [],
    showLockers: false,
    showLockerMore: false,
    lockerMoreText: '',
    lockerPositionLabel: NEARBY_COPY.lockerPositionLabel,
    showNavigate: false,
    navigateLabel: NEARBY_COPY.navigate,
    footer: NEARBY_COPY.footer,
  }
}

function refresh(instance: StationCardInstance, value: unknown): void {
  if (!isNearbySite(value)) {
    currentSites.delete(instance)
    instance.setData(emptyData())
    return
  }
  currentSites.set(instance, value)
  instance.setData(viewOf(value))
}

Component({
  properties: {
    /** 契约形状的站点行（`types/nearby.ts`）。 */
    site: {
      type: Object,
    },
  },

  data: {
    siteId: 0,
    name: '',
    statusLabel: '',
    statusTone: '',
    distanceText: '',
    showDistance: false,
    businessHours: '',
    showBusinessHours: false,
    address: '',
    showAddress: false,
    cellRows: [],
    lockerPositions: [],
    showLockers: false,
    showLockerMore: false,
    lockerMoreText: '',
    lockerPositionLabel: NEARBY_COPY.lockerPositionLabel,
    showNavigate: false,
    navigateLabel: NEARBY_COPY.navigate,
    footer: NEARBY_COPY.footer,
  } as StationCardData,

  observers: {
    site(value: unknown) {
      refresh(this as unknown as StationCardInstance, value)
    },
  },

  lifetimes: {
    attached() {
      refresh(this as unknown as StationCardInstance, this.data.site)
    },
  },

  methods: {
    /** 整卡点击 —— 只发选中事件（#73 地图与列表共享同一个选中态）。 */
    onSelect(): void {
      const site = currentSites.get(this as unknown as StationCardInstance)
      if (site === undefined) return
      this.triggerEvent('select', { siteId: site.siteId })
    },

    /**
     * 导航 —— 只发事件，由宿主调 `wx.openLocation`。
     * 无坐标时按钮根本不渲染；这里再挡一次，避免迟到的属性把无坐标事件发出去。
     */
    onNavigate(): void {
      const site = currentSites.get(this as unknown as StationCardInstance)
      if (site === undefined || !hasSiteCoordinates(site)) return
      this.triggerEvent('navigate', { siteId: site.siteId })
    },
  },
})

export {}
