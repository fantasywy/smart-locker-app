// **附近柜机页** —— 只读站点目录：搜索、城市、定位降级、服务端分页（spec #57 §8）。
//
// ## 这一页不做什么
//
// 不产生 `lockerId`、不下单、不预约、不出站到柜机页。响应里没有柜机 ID / 柜机码，
// 卡内唯一动作是「导航」（`wx.openLocation`，GCJ-02，不依赖定位授权）。
//
// ## 定位是增强，不是前置
//
// 进入页面**不自动请求定位**，也不读授权设置。只有用户点「开启定位」才调
// `wx.getLocation({type:'gcj02'})`。拒绝 / 类目未批 / 系统不可用统一落 `denied`：
// 顶部横幅「未定位 · 按站点名排序」+「开启定位」，列表与搜索照常可用，
// 距离整体隐藏（服务端即使回传也不上屏）。拒绝后再点「开启定位」才 `wx.openSetting`，
// 不自动弹第二次授权。
//
// ## 两条数据流
//
// - **列表流**：排序与分页完全归服务端；客户端不重排，翻页按 `siteId` 去重，`pageSize=20`。
// - **地图流**：spec §8 的 `pageSize=100` 一次取，只供 206px 地图带与全屏地图使用；
//   不追加、不翻页。地图流失败不影响列表（退回列表已加载的站点垫着）。
// - 半径默认 3000，已定位时可扩到 10000；**未定位时不发半径**（没有中心点的半径没有意义），
//   此时地图带的「扩大到 10 公里」也不出现。
// - 端点失败**只对 network**自动重试一次；成功结果进 30 秒内存缓存，
//   下拉刷新绕过缓存。不落 storage、不跨会话。
// - **只有城市字符串允许落 storage**（`nearby.city`），业务数据一律不落。
//
// ⚠️ 文案全部来自 `startup/copy.ts`；本页不写用户可见字面量。

import {
  listNearbyCities,
  listNearbySites,
} from '../../api/nearby'
import type { NearbySitesQuery } from '../../api/nearby'
import {
  NEARBY_COPY,
  PAGE_TITLES,
} from '../../startup/copy'
import { showToast } from '../../utils/feedback'
import {
  NEARBY_AVAILABILITY,
  formatNearbyDistance,
  hasSiteCoordinates,
} from '../../utils/nearby'
import type { PageOf } from '../../utils/pagination'
import { PAGE_SIZE } from '../../utils/pagination'
import type { NearbyAvailability, NearbyCity, NearbySite } from '../../types/nearby'

/** 默认半径 / 扩大后的半径 —— 客户端只发这两档。 */
const DEFAULT_RADIUS_METERS = 3000
const EXPANDED_RADIUS_METERS = 10000

/**
 * 地图流的页大小 —— spec §8 逐字：「地图页按 `pageSize=100` 一次取」。
 *
 * ⚠️ 地图与列表是**两条流**：列表按 20 分页（上拉追加），地图要一次拿到半径内
 * 的全部站点（206px 地图带与全屏地图都只用这一份）。用列表已加载的 20 条画 marker，
 * 等于让地图谎报「附近只有这些柜机」—— spec 的 100 上限正是为此写的。
 */
const MAP_PAGE_SIZE = 100

/** 成功结果的内存缓存时长 —— 不写 storage，不跨会话。 */
const CACHE_TTL_MS = 30_000

/** 附近页唯一允许持久化的数据：城市名字符串。 */
const CITY_STORAGE_KEY = 'nearby.city'

/** 地图看门狗 —— spec §8 的 3–5 秒；取中值 4 秒，既不像 3 秒那样误伤弱网首屏，也不拖过 5 秒。 */
const MAP_WATCHDOG_MS = 4000

/** 地图默认缩放：3 km 半径 14；扩大到 10 km 时 12（spec §8）。 */
const MAP_SCALE_NEAR = 14
const MAP_SCALE_FAR = 12

/** marker 尺寸（px）—— 选中态放大一档；marker 上不压字，名字只走 callout。 */
const MAP_MARKER_SIZE = 24
const MAP_MARKER_SIZE_SELECTED = 34

/** 城市/站点都不可用时的地图中心 —— 只用于让 `<map>` 有合法经纬度，不上屏。 */
const MAP_DEFAULT_CENTER = { lat: 39.9042, lng: 116.4074 }

/**
 * callout 的白底与 ink 文字。
 *
 * ⚠️⚠️ **这是全仓唯一允许出现裸 hex 的地方之一，且是有意的例外**：`<map>` 的
 * `marker.callout` 是**原生属性**（走 setData 传给原生地图层），既不吃 CSS 变量、
 * 也不吃 SCSS token —— 只能给字面量。
 *
 * 例外的代价用一条测试兜住：`test/pages/nearby-map.test.ts` 把这两个值与
 * `styles/_variables.scss` 的 `$color-bg-card` / `$color-text-main` 对齐断言 ——
 * token 改了而这里没改的那天，测试会红，而不是等用户看到一块颜色不对的气泡。
 */
const MAP_CALLOUT_BG = '#ffffff'
const MAP_CALLOUT_INK = '#1f2329'

/**
 * 可用状态 → marker 图标。
 *
 * 颜色在构建期写进 PNG（`pnpm icons:build`），运行时只查文件名；
 * 接口不区分离线与故障，所以只有三张图，没有第四种「故障 marker」。
 */
export const NEARBY_MARKER_ICONS = {
  1: '/assets/map/marker-available.png',
  2: '/assets/map/marker-full.png',
  3: '/assets/map/marker-unavailable.png',
} as const satisfies Record<NearbyAvailability, string>

/** 页面态 —— 四类空态各有自己的分支。 */
type NearbyPhase = 'loading' | 'ready' | 'empty' | 'noresult' | 'neterr' | 'citypick'

/** 定位态 —— 初始未定位、被拒、已定位。 */
type LocationState = 'idle' | 'denied' | 'located'

type LoadSource =
  | 'initial'
  | 'show'
  | 'search'
  | 'clear'
  | 'expand'
  | 'city'
  | 'locate'
  | 'retry'
  | 'pull'

interface NearbyPageData {
  title: string
  phase: NearbyPhase

  /** 定位横幅 / 文案；位于列表上方，不是空页。 */
  locationState: LocationState
  showLocationBanner: boolean
  locationBanner: string
  locationAction: string

  /** 城市 + 搜索 —— 城市永远在搜索框里，搜索必须带城市。 */
  city: string
  radiusMeters: number
  keywordDraft: string
  activeKeyword: string
  showClear: boolean
  searchPlaceholder: string
  searchHint: string
  searchAction: string
  clearSearchLabel: string

  /** 列表。 */
  sites: NearbySite[]
  page: number
  listHeader: string
  selectedSiteId: number

  /**
   * 地图带 —— 与列表同一屏，无「地图 / 列表」切换。
   *
   * `mapFailed` 独立于页面 `phase`：地图坏了，列表/搜索/分页都不受影响。
   */
  showMapBand: boolean
  mapFailed: boolean
  mapFailTitle: string
  mapFailHint: string
  mapFullscreenLabel: string
  mapExitLabel: string
  mapLatitude: number
  mapLongitude: number
  mapScale: number
  markers: NearbyMapMarker[]
  showFullscreenMap: boolean

  /** 全屏卡片浮层 —— 只渲染选中站点；无选中时是空对象。 */
  selectedCard: NearbySelectedCard

  /** 城市选择器。 */
  showCityPicker: boolean
  cities: string[]
  cityPickerTitle: string
  cityPickerCancel: string
  cityPickerDismissable: boolean

  /** 四类空态 / 失败态的文案。 */
  emptyTitle: string
  emptyHint: string
  emptyActionLabel: string
  switchCityLabel: string
  noResultTitle: string
  noResultHint: string
  networkTitle: string
  networkDetail: string
  retryLabel: string
}

interface NearbyMapCallout {
  content: string
  color: string
  bgColor: string
  fontSize: number
  borderRadius: number
  padding: number
  display: 'ALWAYS'
  textAlign: 'center'
}

/**
 * `<map>` marker 的最小渲染形状。
 *
 * ⚠️ `id` 用 `siteId`：选中同步只靠这一个数字，marker 与列表卡不会各存一份身份。
 * `callout` 只挂在**当前选中**的 marker 上 —— 这是「同屏只有一个 callout」的实现方式。
 */
interface NearbyMapMarker {
  id: number
  latitude: number
  longitude: number
  iconPath: string
  width: number
  height: number
  zIndex: number
  callout?: NearbyMapCallout
}

/** 全屏地图卡片浮层的数据 —— 由同层渲染的普通 `view` 承载，只放短文本。 */
interface NearbySelectedCard {
  siteId: number
  name: string
  statusLabel: string
  statusTone: string
  distanceText: string
  showDistance: boolean
  address: string
  showAddress: boolean
  showNavigate: boolean
  navigateLabel: string
  footer: string
}

interface NearbyPageInstance {
  data: NearbyPageData
  setData(patch: Partial<NearbyPageData>): void
}

interface MapCenter {
  lat: number
  lng: number
}

interface NearbyRuntime {
  started: boolean
  city: string
  coords: { lat: number; lng: number } | null
  activeKeyword: string
  radiusMeters: number
  sites: NearbySite[]
  total: number
  page: number
  exhausted: boolean
  inFlight: boolean
  loadingMore: boolean
  requestSeq: number
  locationState: LocationState
  cities: NearbyCity[]

  /**
   * 地图流 —— 与列表流分开（`pageSize=100` 一次取，不追加）。
   *
   * ⚠️ `mapLoaded` 区分「还没取过」（此时先用列表已加载的站点垫着，地图不至于空白）
   * 与「取过了，就是这些」（哪怕服务端回了空列表）。由长度反推会在这两态上撞车。
   */
  mapSites: NearbySite[]
  mapLoaded: boolean

  /** 地图中心 / 是否被用户固定（选中 / 拖动 / 定位后不再自动跟随首条结果）。 */
  mapCenter: MapCenter | null
  mapCenterFixed: boolean
  mapReady: boolean
  mapFailure: boolean
  mapTimer: ReturnType<typeof setTimeout> | null

  /** 列表与地图共享的选中站点。 */
  selectedSiteId: number
  fullscreen: boolean
}

/** 30 秒内存缓存 —— 模块级、不落 storage；页面重建可复用一次会话内的结果。 */
const sitesCache = new Map<string, { at: number; value: PageOf<NearbySite> }>()
let citiesCache: { at: number; value: NearbyCity[] } | null = null

/** 页面实例 → 运行时会话。WeakMap 不持有业务数据的额外副本。 */
const runtimes = new WeakMap<NearbyPageInstance, NearbyRuntime>()

function runtimeOf(page: NearbyPageInstance): NearbyRuntime {
  let runtime = runtimes.get(page)
  if (runtime === undefined) {
    runtime = {
      started: false,
      city: '',
      coords: null,
      activeKeyword: '',
      radiusMeters: DEFAULT_RADIUS_METERS,
      sites: [],
      total: 0,
      page: 0,
      exhausted: false,
      inFlight: false,
      loadingMore: false,
      requestSeq: 0,
      locationState: 'idle',
      cities: [],
      mapSites: [],
      mapLoaded: false,
      mapCenter: null,
      mapCenterFixed: false,
      mapReady: false,
      mapFailure: false,
      mapTimer: null,
      selectedSiteId: 0,
      fullscreen: false,
    }
    runtimes.set(page, runtime)
  }
  return runtime
}

/**
 * 拼请求参数。
 *
 * ⚠️ `radiusMeters` **只在有坐标时发**：没有中心点的半径没有意义，
 * 契约也说得明白 ——「无坐标时必须传 `city`」（城市列表不带半径）。
 * 关键词模式忽略半径（关键词搜索一定是城内搜索）。
 */
function queryFor(
  runtime: NearbyRuntime,
  page: number,
  pageSize: number = PAGE_SIZE,
): NearbySitesQuery {
  const query: NearbySitesQuery = {
    city: runtime.city,
    page,
    pageSize,
  }
  if (runtime.coords !== null) {
    query.lat = runtime.coords.lat
    query.lng = runtime.coords.lng
  }
  if (runtime.activeKeyword !== '') {
    query.keyword = runtime.activeKeyword
  } else if (runtime.coords !== null) {
    query.radiusMeters = runtime.radiusMeters
  }
  return query
}

/** 只对 network 失败自动重试一次。 */
type NearbySitesResult = Awaited<ReturnType<typeof listNearbySites>>
type NearbyCitiesResult = Awaited<ReturnType<typeof listNearbyCities>>

async function fetchSitesWithRetry(
  query: NearbySitesQuery,
  bypassCache: boolean,
): Promise<NearbySitesResult> {
  const key = JSON.stringify(query)
  const cached = sitesCache.get(key)
  if (!bypassCache && cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ok: true, data: cached.value }
  }

  let result = await listNearbySites(query)
  if (!result.ok && result.error.kind === 'network') {
    result = await listNearbySites(query)
  }
  if (result.ok) sitesCache.set(key, { at: Date.now(), value: result.data })
  return result
}

/** 城市清单同样只对 network 自动重试一次；城市清单也进内存缓存。 */
async function fetchCitiesWithRetry(
  bypassCache: boolean,
): Promise<NearbyCitiesResult> {
  if (
    !bypassCache &&
    citiesCache !== null &&
    Date.now() - citiesCache.at < CACHE_TTL_MS
  ) {
    return { ok: true, data: citiesCache.value }
  }

  let result = await listNearbyCities()
  if (!result.ok && result.error.kind === 'network') {
    result = await listNearbyCities()
  }
  if (result.ok) citiesCache = { at: Date.now(), value: result.data }
  return result
}

/** 按 siteId 去重，保留首次出现的位置 —— 不改变服务端顺序。 */
function dedupeBySiteId(sites: readonly NearbySite[]): NearbySite[] {
  const seen = new Set<number>()
  const unique: NearbySite[] = []
  for (const site of sites) {
    if (seen.has(site.siteId)) continue
    seen.add(site.siteId)
    unique.push(site)
  }
  return unique
}

/**
 * 地图流的当前内容。
 *
 * ⚠️ 地图流回来之前先用列表已加载的站点垫着（首屏不会是一块空地图）；
 * 一旦地图流到手，**只认它** —— 否则「地图只画了前 20 个」这个缺陷会以
 * 「列表翻到第 3 页后 marker 变多」的形式回来。
 */
function mapSourceOf(runtime: NearbyRuntime): readonly NearbySite[] {
  return runtime.mapLoaded ? runtime.mapSites : runtime.sites
}

/** 按 `siteId` 找站点 —— 地图交互的站点可能还没进列表（地图流是 100，列表是 20）。 */
function siteById(runtime: NearbyRuntime, siteId: number): NearbySite | undefined {
  return (
    runtime.mapSites.find((site) => site.siteId === siteId) ??
    runtime.sites.find((site) => site.siteId === siteId)
  )
}

/**
 * 拉地图流 —— spec §8 的 `pageSize=100` 一次取。
 *
 * ⚠️ **只在第一页 / 换查询时拉**：地图流不追加、不翻页（100 是上限，超了再议 bbox）。
 * `seq` 与列表流共用同一个请求序号：用户换城市 / 改关键词时，迟到的旧地图响应
 * 必须被丢弃，否则地图会画上一个查询的站点。
 */
async function loadMapSites(page: NearbyPageInstance, seq: number): Promise<void> {
  const runtime = runtimeOf(page)
  const result = await fetchSitesWithRetry(queryFor(runtime, 1, MAP_PAGE_SIZE), false)
  if (seq !== runtime.requestSeq) return

  if (!result.ok) {
    // 地图流失败**不影响列表**：地图带继续用列表垫着的那份（或上一次成功的地图流）。
    return
  }
  runtime.mapSites = dedupeBySiteId(result.data.records)
  runtime.mapLoaded = true
  render(page)
}

/**
 * 模板替换 —— 文案模板的占位符只在页面替换一次。
 *
 * ⚠️ 替换值走**函数形式**（`() => value`）：字符串形式会把值里的 `$&` / `$'`
 * 当成替换模式展开，而这里填进去的是**城市名 / 关键词**（用户输入）——
 * 那种展开是实打实的注入面（与 `utils/datetime.ts` / `utils/nearby.ts` 同一纪律）。
 */
function fill(template: string, key: string, value: string): string {
  return template.replace(`{${key}}`, () => value)
}

/**
 * 只把契约字段搬进渲染模型 —— 即便服务端误带了 `lockerId` / 柜机码 / `site.status`，
 * 页面 data 与站点卡也拿不到它们。少搬一个字段，就少一条上屏的路。
 */
function displaySiteOf(site: NearbySite, located: boolean): NearbySite {
  return {
    siteId: site.siteId,
    name: site.name,
    city: site.city,
    address: site.address,
    lng: site.lng,
    lat: site.lat,
    distanceMeters: located ? site.distanceMeters : null,
    businessHours: site.businessHours,
    availability: site.availability,
    cellAvailability: {
      small: site.cellAvailability.small,
      medium: site.cellAvailability.medium,
      large: site.cellAvailability.large,
      extraLarge: site.cellAvailability.extraLarge,
    },
    lockers: site.lockers.map((locker) => ({
      position: locker.position,
      status: locker.status,
    })),
  }
}

/** 地图带只在这些页面态出现；城市选择器 / 网络失败页不铺地图。 */
function mapBandVisible(page: NearbyPageInstance): boolean {
  const runtime = runtimeOf(page)
  const phase = page.data.phase
  return runtime.city !== '' && phase !== 'neterr' && phase !== 'citypick'
}

/** 第一条有坐标的站点 —— 无定位时的地图中心候选。 */
function firstLocatedSite(
  sites: readonly NearbySite[],
): (NearbySite & { lng: number; lat: number }) | null {
  for (const site of sites) {
    if (hasSiteCoordinates(site)) return site
  }
  return null
}

/**
 * 地图中心。
 *
 * 用户拖动 / 选中站点 / 定位成功后 `mapCenterFixed = true`，之后的列表刷新不再抢中心；
 * 否则跟随定位点或第一条有坐标的站点。全屏进出只读这份运行时状态，不落 storage。
 */
function mapCenterOf(runtime: NearbyRuntime): MapCenter {
  if (runtime.mapCenter === null || !runtime.mapCenterFixed) {
    if (runtime.coords !== null) {
      runtime.mapCenter = { lat: runtime.coords.lat, lng: runtime.coords.lng }
    } else {
      const site = firstLocatedSite(mapSourceOf(runtime))
      runtime.mapCenter =
        site === null
          ? { lat: MAP_DEFAULT_CENTER.lat, lng: MAP_DEFAULT_CENTER.lng }
          : { lat: site.lat, lng: site.lng }
    }
  }
  return runtime.mapCenter
}

/** 半径 → 缩放；城内搜索沿用近景（搜索结果通常集中在几个街区）。 */
function mapScaleOf(runtime: NearbyRuntime): number {
  if (runtime.activeKeyword !== '') return MAP_SCALE_NEAR
  return runtime.radiusMeters >= EXPANDED_RADIUS_METERS ? MAP_SCALE_FAR : MAP_SCALE_NEAR
}

/**
 * 站点 → marker。
 *
 * ⚠️ 只有 `phase === 'loading'` 时为空；缺坐标站点永远不产生 marker。
 * ⚠️ callout 只挂在选中 marker 上 —— 原生 callout 的 `ALWAYS` 会让每个 marker 常驻气泡，
 * 这里用「数组里最多一个 callout」保证同屏只有一个。
 */
function markersOf(runtime: NearbyRuntime, phase: NearbyPhase): NearbyMapMarker[] {
  if (phase === 'loading') return []
  const markers: NearbyMapMarker[] = []
  for (const site of mapSourceOf(runtime)) {
    if (!hasSiteCoordinates(site)) continue
    const selected = site.siteId === runtime.selectedSiteId
    const marker: NearbyMapMarker = {
      id: site.siteId,
      latitude: site.lat,
      longitude: site.lng,
      iconPath: NEARBY_MARKER_ICONS[site.availability] ?? NEARBY_MARKER_ICONS[3],
      width: selected ? MAP_MARKER_SIZE_SELECTED : MAP_MARKER_SIZE,
      height: selected ? MAP_MARKER_SIZE_SELECTED : MAP_MARKER_SIZE,
      zIndex: selected ? 2 : 1,
    }
    if (selected) {
      marker.callout = {
        content: site.name,
        color: MAP_CALLOUT_INK,
        bgColor: MAP_CALLOUT_BG,
        fontSize: 12,
        borderRadius: 8,
        padding: 8,
        display: 'ALWAYS',
        textAlign: 'center',
      }
    }
    markers.push(marker)
  }
  return markers
}

/** 空卡片 —— 全屏浮层在无选中时不渲染（wxml 用 siteId 判定）。 */
function emptySelectedCard(): NearbySelectedCard {
  return {
    siteId: 0,
    name: '',
    statusLabel: '',
    statusTone: '',
    distanceText: '',
    showDistance: false,
    address: '',
    showAddress: false,
    showNavigate: false,
    navigateLabel: NEARBY_COPY.navigate,
    footer: NEARBY_COPY.footer,
  }
}

/** 选中站点 → 全屏卡片浮层模型；距离与列表同一开关（未定位不显示）。 */
function selectedCardOf(runtime: NearbyRuntime, located: boolean): NearbySelectedCard {
  const site = siteById(runtime, runtime.selectedSiteId)
  if (site === undefined) return emptySelectedCard()
  const badge = NEARBY_AVAILABILITY[site.availability] ?? NEARBY_AVAILABILITY[3]
  const distanceText = located ? formatNearbyDistance(site.distanceMeters) : ''
  const address = site.address ?? ''
  return {
    siteId: site.siteId,
    name: site.name,
    statusLabel: badge.label,
    statusTone: badge.tone,
    distanceText,
    showDistance: distanceText !== '',
    address,
    showAddress: address !== '',
    showNavigate: hasSiteCoordinates(site),
    navigateLabel: NEARBY_COPY.navigate,
    footer: NEARBY_COPY.footer,
  }
}

function clearMapWatchdog(runtime: NearbyRuntime): void {
  if (runtime.mapTimer !== null) {
    clearTimeout(runtime.mapTimer)
    runtime.mapTimer = null
  }
}

/** 地图失败：只改地图带，不动 `phase` / `sites` / 分页。 */
function failMap(page: NearbyPageInstance): void {
  const runtime = runtimeOf(page)
  clearMapWatchdog(runtime)
  runtime.mapFailure = true
  runtime.mapReady = false
  runtime.fullscreen = false
  page.setData({ mapFailed: true, showFullscreenMap: false })
}

/**
 * 看门狗 —— `bindrendererror` 只覆盖同层渲染失败，瓦片/弱网白屏没有专用事件，
 * 所以地图挂载后等 `bindupdated`；4 秒内没等到就按失败处理（spec §8 的 3–5 秒）。
 */
function syncMapWatchdog(page: NearbyPageInstance): void {
  const runtime = runtimeOf(page)
  if (!mapBandVisible(page) || runtime.mapFailure || runtime.mapReady) {
    clearMapWatchdog(runtime)
    return
  }
  if (runtime.mapTimer !== null) return
  runtime.mapTimer = setTimeout(() => {
    runtime.mapTimer = null
    failMap(page)
  }, MAP_WATCHDOG_MS)
}

/** 地图点击平台调用 —— 与卡片导航共用同一份坐标判定。 */
function openSiteLocation(page: NearbyPageInstance, siteId: number): void {
  const site = siteById(runtimeOf(page), siteId)
  if (site === undefined || !hasSiteCoordinates(site)) return
  wx.openLocation({
    latitude: site.lat,
    longitude: site.lng,
    scale: 18,
    name: site.name,
    ...(site.address === null ? {} : { address: site.address }),
  })
}

/**
 * 选中站点 —— 列表卡与 marker 的唯一入口。
 *
 * `center: true` 是「点列表卡 → 地图居中」；`scroll: true` 是「点 marker → 滚到列表卡」。
 * 两个方向都只改同一份运行时选中态，然后整页重画一次。
 */
function selectSite(
  page: NearbyPageInstance,
  siteId: number,
  options: { center: boolean; scroll: boolean },
): void {
  const runtime = runtimeOf(page)
  const site = siteById(runtime, siteId)
  if (site === undefined) return

  runtime.selectedSiteId = siteId
  if (options.center && hasSiteCoordinates(site)) {
    runtime.mapCenter = { lat: site.lat, lng: site.lng }
    runtime.mapCenterFixed = true
  }
  render(page)

  if (options.scroll && page.data.phase === 'ready') {
    wx.pageScrollTo({ selector: `#nearby-site-${siteId}`, duration: 0 })
  }
}

/**
 * 把运行时状态画到 `data`。
 *
 * ⚠️ 距离只有一个开关：`locationState === 'located'` 时才把 DTO 的距离搬进渲染模型。
 * 未定位时一律置 `null`，即使服务端因缓存/契约漂移回了距离也不上屏。
 */
function render(page: NearbyPageInstance): void {
  const runtime = runtimeOf(page)
  const located = runtime.locationState === 'located' && runtime.coords !== null
  const keyword = runtime.activeKeyword
  const center = mapCenterOf(runtime)

  page.setData({
    locationState: runtime.locationState,
    showLocationBanner: runtime.locationState !== 'located',
    city: runtime.city,
    radiusMeters: runtime.radiusMeters,
    activeKeyword: keyword,
    showClear: page.data.keywordDraft !== '' || keyword !== '',
    searchHint: runtime.city === '' ? '' : fill(NEARBY_COPY.searchHint, 'city', runtime.city),
    sites: runtime.sites.map((site) => displaySiteOf(site, located)),
    page: runtime.page,
    listHeader: fill(NEARBY_COPY.listHeader, 'count', String(runtime.total)),
    cities: runtime.cities.map((entry) => entry.city),
    // ⚠️ 「扩大到 10 公里」只在**已定位**时出现：没有中心点的半径没有意义 ——
    // 未定位的查询里根本不带 `radiusMeters`（见 `queryFor`），给一个按下去
    // 什么都不会变的按钮比不给更糟。
    emptyActionLabel:
      runtime.coords === null || runtime.radiusMeters >= EXPANDED_RADIUS_METERS
        ? ''
        : NEARBY_COPY.expandRadius,
    noResultTitle: fill(NEARBY_COPY.noResultTitle, 'keyword', keyword),
    showMapBand: mapBandVisible(page),
    mapFailed: runtime.mapFailure,
    mapLatitude: center.lat,
    mapLongitude: center.lng,
    mapScale: mapScaleOf(runtime),
    markers: markersOf(runtime, page.data.phase),
    selectedSiteId: runtime.selectedSiteId,
    selectedCard: selectedCardOf(runtime, located),
    showFullscreenMap: runtime.fullscreen,
  })
  syncMapWatchdog(page)
}

/** 首屏 / 刷新 / 搜索 / 扩半径都用同一个入口：替换全部已加载内容。 */
async function loadFirst(
  page: NearbyPageInstance,
  source: LoadSource,
  bypassCache = false,
): Promise<void> {
  const runtime = runtimeOf(page)
  if (runtime.city === '') {
    void openCityPicker(page, true, bypassCache)
    return
  }
  // 静默刷新不叠加；用户显式动作（搜索 / 选城市 / 重试 / 下拉）可以打断在途请求，
  // 由 requestSeq 丢弃迟到响应。否则「加载中点搜索 / 换城市」会被 inFlight 静默吞掉。
  if (source === 'show' && runtime.inFlight) return

  runtime.inFlight = true
  const seq = runtime.requestSeq + 1
  runtime.requestSeq = seq
  if (source !== 'show' && source !== 'pull') {
    page.setData({ phase: 'loading' })
    // 加载中地图仍在版式里（无 marker），骨架卡在它下面；这样地图不会在结果回来时才「跳」出来。
    render(page)
  }

  const result = await fetchSitesWithRetry(queryFor(runtime, 1), bypassCache)

  if (seq !== runtime.requestSeq) return
  runtime.inFlight = false

  if (!result.ok) {
    // 静默刷新 / 下拉刷新失败：保留屏上的真实旧数据，不把整页打回网络失败态。
    if ((source === 'show' || source === 'pull') && runtime.sites.length > 0) {
      showToast(NEARBY_COPY.loadFailed)
      render(page)
      return
    }
    page.setData({ phase: 'neterr', showMapBand: false })
    clearMapWatchdog(runtime)
    return
  }

  const records = dedupeBySiteId(result.data.records)
  runtime.sites = records
  runtime.total = result.data.total
  runtime.page = 1
  runtime.exhausted = records.length >= result.data.total
  // 结果集变了：选中站点若已不在屏上，选中态一起清掉，避免全屏卡片指向旧站点。
  if (!records.some((site) => site.siteId === runtime.selectedSiteId)) {
    runtime.selectedSiteId = 0
  }

  const phase: NearbyPhase =
    records.length === 0
      ? runtime.activeKeyword !== ''
        ? 'noresult'
        : 'empty'
      : 'ready'
  page.setData({ phase })
  render(page)

  // ⚠️ 地图流与列表流并行：列表已画上屏，地图按 spec §8 的 `pageSize=100` 另取一份。
  // 不 await —— 地图是增强，列表不该等它（地图失败也不影响列表）。
  void loadMapSites(page, seq)
}

/** 加载下一页 —— 只按服务端顺序追加，按 siteId 去重。 */
async function loadMore(page: NearbyPageInstance): Promise<void> {
  const runtime = runtimeOf(page)
  if (page.data.phase !== 'ready') return
  if (runtime.inFlight || runtime.loadingMore || runtime.exhausted) return
  if (runtime.sites.length >= runtime.total) {
    runtime.exhausted = true
    return
  }

  runtime.loadingMore = true
  const seq = runtime.requestSeq
  const next = runtime.page + 1
  const result = await fetchSitesWithRetry(queryFor(runtime, next), false)

  if (seq !== runtime.requestSeq) {
    runtime.loadingMore = false
    return
  }
  runtime.loadingMore = false

  if (!result.ok) {
    // 已加载项保留；一次失败不把列表清空。
    showToast(NEARBY_COPY.loadFailed)
    return
  }

  const known = new Set(runtime.sites.map((site) => site.siteId))
  const fresh = result.data.records.filter((site) => !known.has(site.siteId))
  runtime.page = next
  runtime.total = result.data.total
  if (fresh.length === 0) {
    // 服务端越界会钳制到末页：整页都是已知 id 时到此为止，避免无限重复末页。
    runtime.exhausted = true
    render(page)
    return
  }

  runtime.sites = [...runtime.sites, ...fresh]
  runtime.exhausted = runtime.sites.length >= runtime.total
  render(page)
}

/** 打开城市选择器；首次无城市时先拉清单，但不请求站点、不显示空列表。 */
async function openCityPicker(
  page: NearbyPageInstance,
  firstUse: boolean,
  bypassCache = false,
): Promise<void> {
  const runtime = runtimeOf(page)
  if (firstUse) page.setData({ phase: 'loading' })

  const result = await fetchCitiesWithRetry(bypassCache)
  if (!result.ok) {
    if (runtime.city === '') {
      page.setData({ showCityPicker: false, phase: 'neterr', showMapBand: false })
    } else {
      // 已有列表时城市清单失败：保留屏上的真实旧数据，只提示这次切换没成功。
      page.setData({ showCityPicker: false })
      showToast(NEARBY_COPY.loadFailed)
    }
    return
  }

  runtime.cities = result.data
  page.setData({
    showCityPicker: true,
    cities: result.data.map((entry) => entry.city),
    cityPickerDismissable: !firstUse && runtime.city !== '',
    ...(firstUse ? { phase: 'citypick' as NearbyPhase } : {}),
  })
}

/** 读城市 —— storage 里唯一被允许的附近数据。 */
function readStoredCity(): string {
  const stored = wx.getStorageSync(CITY_STORAGE_KEY)
  return typeof stored === 'string' ? stored.trim() : ''
}

/** 首次进入：有城市直接取列表；没有城市先选城市。 */
async function initialize(page: NearbyPageInstance): Promise<void> {
  const runtime = runtimeOf(page)
  const stored = readStoredCity()
  if (stored === '') {
    page.setData({ city: '', searchHint: '' })
    await openCityPicker(page, true)
    return
  }

  runtime.city = stored
  page.setData({ city: stored })
  await loadFirst(page, 'initial')
}

/**
 * 用户点击定位后的唯一请求入口。
 *
 * ⚠️ 这里不判断类目 / 授权状态：微信侧失败统统落到同一个 `denied`，不按成因分叉。
 */
function requestLocation(page: NearbyPageInstance): void {
  const runtime = runtimeOf(page)
  wx.getLocation({
    type: 'gcj02',
    success: (result) => {
      runtime.coords = { lat: result.latitude, lng: result.longitude }
      runtime.locationState = 'located'
      // 用户主动定位 = 明确要「以我为中心」，固定地图中心，后续刷新不抢。
      runtime.mapCenter = { lat: result.latitude, lng: result.longitude }
      runtime.mapCenterFixed = true
      render(page)
      void loadFirst(page, 'locate')
    },
    fail: () => {
      runtime.locationState = 'denied'
      runtime.coords = null
      render(page)
    },
  })
}

Component({
  data: {
    title: PAGE_TITLES['pages/nearby/nearby'],
    phase: 'loading' as NearbyPhase,

    locationState: 'idle' as LocationState,
    showLocationBanner: true,
    locationBanner: NEARBY_COPY.locationBanner,
    locationAction: NEARBY_COPY.enableLocation,

    city: '',
    radiusMeters: DEFAULT_RADIUS_METERS,
    keywordDraft: '',
    activeKeyword: '',
    showClear: false,
    searchPlaceholder: NEARBY_COPY.searchPlaceholder,
    searchHint: '',
    searchAction: NEARBY_COPY.searchAction,
    clearSearchLabel: NEARBY_COPY.clearSearch,

    sites: [],
    page: 0,
    listHeader: '',
    selectedSiteId: 0,

    showMapBand: false,
    mapFailed: false,
    mapFailTitle: NEARBY_COPY.mapFailTitle,
    mapFailHint: NEARBY_COPY.mapFailHint,
    mapFullscreenLabel: NEARBY_COPY.mapFullscreen,
    mapExitLabel: NEARBY_COPY.mapExit,
    mapLatitude: MAP_DEFAULT_CENTER.lat,
    mapLongitude: MAP_DEFAULT_CENTER.lng,
    mapScale: MAP_SCALE_NEAR,
    markers: [],
    showFullscreenMap: false,
    selectedCard: emptySelectedCard(),

    showCityPicker: false,
    cities: [],
    cityPickerTitle: NEARBY_COPY.cityPickerTitle,
    cityPickerCancel: NEARBY_COPY.cityPickerCancel,
    cityPickerDismissable: false,

    emptyTitle: NEARBY_COPY.emptyTitle,
    emptyHint: NEARBY_COPY.emptyHint,
    emptyActionLabel: '',
    switchCityLabel: NEARBY_COPY.switchCity,
    noResultTitle: '',
    noResultHint: NEARBY_COPY.noResultHint,
    networkTitle: NEARBY_COPY.networkTitle,
    networkDetail: NEARBY_COPY.networkDetail,
    retryLabel: NEARBY_COPY.retry,
  } as NearbyPageData,

  lifetimes: {
    attached(): void {
      // 有意为空 —— 首次进入的状态推进在 onShow，且不在这里碰定位。
    },
  },

  methods: {
    /**
     * 每次回到前台：
     *   • 第一次 → 初始化（有城市取列表，无城市先选城市）；
     *   • 之后 → 静默刷新第一页（命中 30 秒内存缓存时不会发请求）。
     * ⚠️ 搜索态不自动刷新，避免把用户正在看的搜索结果冲掉。
     */
    onShow(): void {
      const page = this as unknown as NearbyPageInstance
      const runtime = runtimeOf(page)
      if (!runtime.started) {
        runtime.started = true
        void initialize(page)
        return
      }
      if (runtime.city === '' || runtime.activeKeyword !== '') return
      if (page.data.phase === 'citypick') return
      void loadFirst(page, 'show')
    },

    /** 搜索输入 —— 只改草稿，不请求（提交后搜）。 */
    onKeywordInput(event: WechatMiniprogram.Input): void {
      const page = this as unknown as NearbyPageInstance
      const value = typeof event.detail.value === 'string' ? event.detail.value : ''
      page.setData({
        keywordDraft: value,
        showClear: value !== '' || runtimeOf(page).activeKeyword !== '',
      })
    },

    /** 提交搜索 —— 必须带城市；关键词为空则回到城市 + 半径结果。 */
    onSearch(event?: WechatMiniprogram.Input): void {
      const page = this as unknown as NearbyPageInstance
      const runtime = runtimeOf(page)
      const value =
        typeof event?.detail?.value === 'string' ? event.detail.value : page.data.keywordDraft
      const keyword = value.trim()

      if (runtime.city === '') {
        void openCityPicker(page, true)
        return
      }

      runtime.activeKeyword = keyword
      // 结果集变了，地图中心跟随新结果的第一条；用户随后拖动/选卡会重新固定。
      runtime.mapCenterFixed = false
      page.setData({
        keywordDraft: keyword,
        activeKeyword: keyword,
        showClear: keyword !== '',
      })
      void loadFirst(page, 'search')
    },

    /** 清除搜索 —— 回到当前城市 + 半径结果。 */
    onClearSearch(): void {
      const page = this as unknown as NearbyPageInstance
      const runtime = runtimeOf(page)
      runtime.activeKeyword = ''
      runtime.mapCenterFixed = false
      page.setData({ keywordDraft: '', activeKeyword: '', showClear: false })
      // 清除是用户显式回到半径结果：绕过缓存，避免把搜索前的旧快照当成「现在」。
      void loadFirst(page, 'clear', true)
    },

    /** 扩大到 10 km —— 只改半径，排序仍归服务端。 */
    onExpandRadius(): void {
      const page = this as unknown as NearbyPageInstance
      const runtime = runtimeOf(page)
      if (runtime.radiusMeters >= EXPANDED_RADIUS_METERS) return
      runtime.radiusMeters = EXPANDED_RADIUS_METERS
      runtime.mapCenterFixed = false
      page.setData({ radiusMeters: EXPANDED_RADIUS_METERS })
      void loadFirst(page, 'expand')
    },

    /** 打开城市选择器 —— 数据始终来自城市端点。 */
    onOpenCityPicker(): void {
      const page = this as unknown as NearbyPageInstance
      void openCityPicker(page, false)
    },

    /** 关闭选择器 —— 首次无城市时不能关（关了就无列表可看）。 */
    onCityPickerClose(): void {
      const page = this as unknown as NearbyPageInstance
      if (runtimeOf(page).city === '') return
      page.setData({ showCityPicker: false })
    },

    /** 选城市 —— 只把城市名写 storage，然后按新城市重取。 */
    onCitySelect(event: WechatMiniprogram.TouchEvent): void {
      const page = this as unknown as NearbyPageInstance
      const raw = event.currentTarget.dataset.city
      const city = typeof raw === 'string' ? raw.trim() : ''
      if (city === '') return

      const runtime = runtimeOf(page)
      wx.setStorageSync(CITY_STORAGE_KEY, city)
      runtime.city = city
      runtime.activeKeyword = ''
      runtime.selectedSiteId = 0
      runtime.mapCenter = null
      runtime.mapCenterFixed = false
      page.setData({
        city,
        showCityPicker: false,
        cityPickerDismissable: false,
        keywordDraft: '',
        activeKeyword: '',
        showClear: false,
      })
      void loadFirst(page, 'city')
    },

    /**
     * 定位按钮：
     *   • 初始 → 才发第一次 `wx.getLocation({type:'gcj02'})`；
     *   • 已拒绝 → 只在这次点击里 `wx.openSetting`，不自动二次授权；
     *   • 已定位 → 按钮已隐藏，忽略。
     */
    onLocate(): void {
      const page = this as unknown as NearbyPageInstance
      const runtime = runtimeOf(page)
      if (runtime.locationState === 'located') return

      if (runtime.locationState === 'denied') {
        wx.openSetting({
          success: (result) => {
            if (result.authSetting['scope.userLocation'] === true) {
              requestLocation(page)
            }
          },
        })
        return
      }

      requestLocation(page)
    },

    /** 页内手动重试 —— 首次无城市时重试城市清单，否则绕过缓存重取列表。 */
    onRetry(): void {
      const page = this as unknown as NearbyPageInstance
      if (runtimeOf(page).city === '') {
        void openCityPicker(page, true, true)
        return
      }
      void loadFirst(page, 'retry', true)
    },

    /** 触底加载下一页。 */
    onReachBottom(): void {
      const page = this as unknown as NearbyPageInstance
      void loadMore(page)
    },

    /** 下拉刷新 —— 同一查询绕过 30 秒缓存。 */
    async onPullDownRefresh(): Promise<void> {
      const page = this as unknown as NearbyPageInstance
      try {
        await loadFirst(page, 'pull', true)
      } finally {
        wx.stopPullDownRefresh({})
      }
    },

    /** 站点卡「导航」—— 唯一动作；无坐标的卡根本不会发这个事件。 */
    onSiteNavigate(event: WechatMiniprogram.CustomEvent<{ siteId?: number }>): void {
      const page = this as unknown as NearbyPageInstance
      const siteId = event.detail?.siteId
      if (typeof siteId !== 'number') return
      openSiteLocation(page, siteId)
    },

    /** 站点卡选中 —— 点列表卡 → marker 高亮并居中；列表不滚动。 */
    onSiteSelect(event: WechatMiniprogram.CustomEvent<{ siteId?: number }>): void {
      const page = this as unknown as NearbyPageInstance
      const siteId = event.detail?.siteId
      if (typeof siteId !== 'number') return
      selectSite(page, siteId, { center: true, scroll: false })
    },

    /** 点 marker → 选中并滚到对应列表卡；全屏里只更新卡片，不滚背后的列表。 */
    onMarkerTap(event: WechatMiniprogram.CustomEvent<{ markerId?: number }>): void {
      const page = this as unknown as NearbyPageInstance
      const raw = event.detail?.markerId
      const siteId = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(siteId)) return
      selectSite(page, siteId, { center: false, scroll: !runtimeOf(page).fullscreen })
    },

    /**
     * 地图拖动结束 → 记住中心。
     *
     * ⚠️ 只写运行时，不 `setData`：地图拖动过程中回写 latitude/longitude 会和手势抢控制；
     * 全屏进出时再由 `render` 一次性回填。
     */
    onRegionChange(
      event: WechatMiniprogram.CustomEvent<{
        type?: string
        centerLocation?: { latitude?: number; longitude?: number }
      }>,
    ): void {
      const page = this as unknown as NearbyPageInstance
      const runtime = runtimeOf(page)
      const detail = event.detail
      // 只忽略拖动开始；`end` 才有 `centerLocation`，缺 type 的测试/旧基础库也按结束处理。
      if (detail?.type === 'begin') return
      const latitude = detail.centerLocation?.latitude
      const longitude = detail.centerLocation?.longitude
      if (
        typeof latitude !== 'number' ||
        !Number.isFinite(latitude) ||
        typeof longitude !== 'number' ||
        !Number.isFinite(longitude)
      ) {
        return
      }
      runtime.mapCenter = { lat: latitude, lng: longitude }
      runtime.mapCenterFixed = true
    },

    /** 地图首次渲染完成 —— 看门狗解除；重复事件无副作用。 */
    onMapUpdated(): void {
      const runtime = runtimeOf(this as unknown as NearbyPageInstance)
      runtime.mapReady = true
      clearMapWatchdog(runtime)
    },

    /** 同层渲染失败 —— 官方建议的降级信号（spec §8 `maperr`）。 */
    onMapRenderError(): void {
      failMap(this as unknown as NearbyPageInstance)
    },

    /** 手动重试地图 —— 只重挂地图，不重发站点请求。 */
    onMapRetry(): void {
      const page = this as unknown as NearbyPageInstance
      const runtime = runtimeOf(page)
      runtime.mapFailure = false
      runtime.mapReady = false
      clearMapWatchdog(runtime)
      render(page)
    },

    /**
     * 进入全屏地图 —— 同一页的次级状态，不是新路由。
     *
     * 没有选中 / 选中的站点没有坐标时，选中第一条有坐标的站点，保证卡片浮层有内容。
     * 地图中心与选中站点都只存在页面运行时里，返回时原样保留。
     */
    onOpenFullscreen(): void {
      const page = this as unknown as NearbyPageInstance
      const runtime = runtimeOf(page)
      if (runtime.mapFailure) return
      const current = siteById(runtime, runtime.selectedSiteId)
      if (current === undefined || !hasSiteCoordinates(current)) {
        const first = firstLocatedSite(mapSourceOf(runtime))
        if (first !== null) runtime.selectedSiteId = first.siteId
      }
      runtime.fullscreen = true
      render(page)
    },

    /** 退出全屏 —— 地图中心与选中站点保持在页面栈内，不落 storage。 */
    onCloseFullscreen(): void {
      const page = this as unknown as NearbyPageInstance
      runtimeOf(page).fullscreen = false
      render(page)
    },

    /** 全屏卡片浮层的「导航」—— 与列表卡同一个平台调用。 */
    onFullscreenNavigate(): void {
      const page = this as unknown as NearbyPageInstance
      openSiteLocation(page, runtimeOf(page).selectedSiteId)
    },

    /** 页面隐藏 / 卸载时停掉看门狗，避免对已不可见的地图开罚单。 */
    onHide(): void {
      clearMapWatchdog(runtimeOf(this as unknown as NearbyPageInstance))
    },

    onUnload(): void {
      clearMapWatchdog(runtimeOf(this as unknown as NearbyPageInstance))
    },
  },
})

export {}
