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
// ## 数据纪律
//
// - 排序与分页完全归服务端；客户端不重排，翻页按 `siteId` 去重。
// - 半径默认 3000，空态可扩到 10000；列表 `pageSize=20`。
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
import type { PageOf } from '../../utils/pagination'
import type { NearbyCity, NearbySite } from '../../types/nearby'

/** 默认半径 / 扩大后的半径 —— 客户端只发这两档。 */
const DEFAULT_RADIUS_METERS = 3000
const EXPANDED_RADIUS_METERS = 10000

/** 列表每页条数 —— 契约缺省 20。 */
const PAGE_SIZE = 20

/** 成功结果的内存缓存时长 —— 不写 storage，不跨会话。 */
const CACHE_TTL_MS = 30_000

/** 附近页唯一允许持久化的数据：城市名字符串。 */
const CITY_STORAGE_KEY = 'nearby.city'

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

interface NearbyPageInstance {
  data: NearbyPageData
  setData(patch: Partial<NearbyPageData>): void
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
    }
    runtimes.set(page, runtime)
  }
  return runtime
}

/** 拼请求参数 —— 关键词模式忽略半径；坐标只在成功定位后成对出现。 */
function queryFor(runtime: NearbyRuntime, page: number): NearbySitesQuery {
  const query: NearbySitesQuery = {
    city: runtime.city,
    page,
    pageSize: PAGE_SIZE,
  }
  if (runtime.coords !== null) {
    query.lat = runtime.coords.lat
    query.lng = runtime.coords.lng
  }
  if (runtime.activeKeyword !== '') {
    query.keyword = runtime.activeKeyword
  } else {
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

/** 模板替换 —— 文案模板的占位符只在页面替换一次。 */
function fill(template: string, key: string, value: string): string {
  return template.replace(`{${key}}`, value)
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
    emptyActionLabel:
      runtime.radiusMeters < EXPANDED_RADIUS_METERS ? NEARBY_COPY.expandRadius : '',
    noResultTitle: fill(NEARBY_COPY.noResultTitle, 'keyword', keyword),
  })
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
    page.setData({ phase: 'neterr' })
    return
  }

  const records = dedupeBySiteId(result.data.records)
  runtime.sites = records
  runtime.total = result.data.total
  runtime.page = 1
  runtime.exhausted = records.length >= result.data.total

  const phase: NearbyPhase =
    records.length === 0
      ? runtime.activeKeyword !== ''
        ? 'noresult'
        : 'empty'
      : 'ready'
  page.setData({ phase })
  render(page)
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
      page.setData({ showCityPicker: false, phase: 'neterr' })
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

    showCityPicker: false,
    cities: [],
    cityPickerTitle: NEARBY_COPY.cityPickerTitle,
    cityPickerCancel: NEARBY_COPY.cityPickerCancel,
    cityPickerDismissable: false,

    emptyTitle: NEARBY_COPY.emptyTitle,
    emptyHint: NEARBY_COPY.emptyHint,
    emptyActionLabel: NEARBY_COPY.expandRadius,
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
      const site = runtimeOf(page).sites.find((entry) => entry.siteId === siteId)
      if (site === undefined || site.lng === null || site.lat === null) return

      wx.openLocation({
        latitude: site.lat,
        longitude: site.lng,
        scale: 18,
        name: site.name,
        ...(site.address === null ? {} : { address: site.address }),
      })
    },

    /** 站点卡选中 —— 供 #73 地图与列表共享选中态；本票没有可见副作用。 */
    onSiteSelect(event: WechatMiniprogram.CustomEvent<{ siteId?: number }>): void {
      const page = this as unknown as NearbyPageInstance
      const siteId = event.detail?.siteId
      if (typeof siteId !== 'number') return
      page.setData({ selectedSiteId: siteId })
    },
  },
})

export {}
