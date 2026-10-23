// **附近柜机页**的验收 —— ticket #72 / spec #57 §8、§13。
//
// 断言只落在外部行为：页面 `data` 画了什么、发出了什么请求、平台被调了什么
// （`wx.getLocation` / `wx.openSetting` / `wx.openLocation` / storage）。
//
// 四条边界贯穿本文件：
//   1. 定位不自动请求；拒绝后列表与搜索照常可用，距离整体隐藏。
//   2. 搜索提交后才发请求、必须带城市；清除回到当前城市 + 半径。
//   3. 排序与分页归服务端，客户端不重排、按 siteId 去重。
//   4. 四类空态分开；无 lockerId / 柜机码 / 出站柜机页 / 下单 / 预约。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWxStub, jsonResponse, networkFailure, seedStorage } from '../helpers/wx'
import { respondByRoute, sentRequests } from '../helpers/http'
import { installFakeTimers } from '../helpers/timers'
import type { InstalledWxStub, WxRequestSuccessResult } from '../helpers/wx'
import { BASE_URL } from '../../miniprogram/request/config'
import {
  NEARBY_CITIES_ENDPOINT,
  NEARBY_SITES_ENDPOINT,
} from '../../miniprogram/api/nearby'
import {
  NEARBY_COPY,
  NEARBY_PATH,
  PAGE_TITLES,
} from '../../miniprogram/startup/copy'
import type { NearbySite } from '../../miniprogram/types/nearby'

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
}))

vi.mock('../../miniprogram/utils/feedback', () => ({
  showToast: mocks.showToast,
}))

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const pageDir = join(repoRoot, 'miniprogram', 'pages', 'nearby')
const pageSource = (): string =>
  readFileSync(join(pageDir, 'nearby.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
const pageWxml = (): string =>
  readFileSync(join(pageDir, 'nearby.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
const pageJson = (): string => readFileSync(join(pageDir, 'nearby.json'), 'utf8')

/** 一份契约形状的站点行。 */
function site(overrides: Partial<NearbySite> = {}): NearbySite {
  return {
    siteId: 12,
    name: '望京 SOHO T1',
    city: '北京',
    address: '朝阳区望京街 10 号',
    lng: 116.481,
    lat: 39.996,
    distanceMeters: 420,
    businessHours: '08:00-22:00',
    availability: 1,
    cellAvailability: { small: 4, medium: 2, large: 0, extraLarge: 1 },
    lockers: [{ position: 'B1 层 3 号电梯口', status: 1 }],
    ...overrides,
  }
}

function siteBody(items: readonly NearbySite[], total = items.length): WxRequestSuccessResult {
  return jsonResponse({ code: 0, message: 'ok', data: { list: items, total } })
}

function citiesBody(cities: readonly string[]): WxRequestSuccessResult {
  return jsonResponse({
    code: 0,
    message: 'ok',
    data: { list: cities.map((city, index) => ({ city, siteCount: index + 1 })) },
  })
}

function siteUrl(query: string): string {
  return `${BASE_URL}${NEARBY_SITES_ENDPOINT}?${query}`
}

/**
 * 地图流的请求特征 —— spec §8 的 `pageSize=100`。
 *
 * ⚠️ 本页有**两条流**：列表（`pageSize=20`，可上拉追加）与地图（`pageSize=100`，一次取）。
 * 下面把两条流分开看，各自按自己的顺序断言 —— 混在一起数「第几次请求」会在
 * 任何一次流的调整上假失败。
 */
const MAP_QUERY = 'pageSize=100'

/** 列表 / 城市流的 URL（按发出顺序）。 */
function requestUrls(wx: InstalledWxStub): string[] {
  return sentRequests(wx.request)
    .map((request) => request.url)
    .filter((url) => !url.includes(MAP_QUERY))
}

/** 地图流的 URL（按发出顺序）—— 需要时（如断言只发了一发）直接用它。 */
function mapUrls(wx: InstalledWxStub): string[] {
  return sentRequests(wx.request)
    .map((request) => request.url)
    .filter((url) => url.includes(MAP_QUERY))
}

/**
 * 两条流的响应编排。
 *
 * ⚠️ 地图流的**默认**是「每次列表取数都回一份空地图」：它只是为了让「列表 / 城市」
 * 用例不必逐条补地图响应（地图流自己的行为在下面那条用例与 `nearby-map.test.ts` 里验）。
 * 需要地图内容的用例显式传第二个参数。
 */
function routes(
  list: Parameters<typeof respondByRoute>[0][number]['results'],
  map?: Parameters<typeof respondByRoute>[0][number]['results'],
): ReturnType<typeof respondByRoute> {
  return respondByRoute([
    {
      match: (options) => options.url.includes(MAP_QUERY),
      results: map ?? list.map(() => siteBody([])),
    },
    { match: () => true, results: list },
  ])
}

let definition: Record<string, unknown> | null = null

beforeEach(() => {
  definition = null
  mocks.showToast.mockReset()
  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (def: Record<string, unknown>): void => {
    definition = def
  }
})

interface PageInstance {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  triggerEvent: () => void
  onShow?: () => void
  onKeywordInput?: (event: unknown) => void
  onSearch?: (event?: unknown) => void
  onClearSearch?: () => void
  onExpandRadius?: () => void
  onOpenCityPicker?: () => void
  onCityPickerClose?: () => void
  onCitySelect?: (event: unknown) => void
  onLocate?: () => void
  onRetry?: () => void
  onReachBottom?: () => void
  onPullDownRefresh?: () => Promise<void> | void
  onSiteNavigate?: (event: unknown) => void
  onSiteSelect?: (event: unknown) => void
  [name: string]: unknown
}

async function loadPage(): Promise<Record<string, unknown>> {
  vi.resetModules()
  await import('../../miniprogram/pages/nearby/nearby')
  if (definition === null) throw new Error('nearby.ts 没有调用 Component()')
  return definition
}

function instantiate(def: Record<string, unknown>): PageInstance {
  const instance = {
    data: { ...((def.data as Record<string, unknown>) ?? {}) },
    setData(patch: Record<string, unknown>): void {
      Object.assign(instance.data, patch)
    },
    triggerEvent(): void {},
  } as PageInstance
  for (const [name, fn] of Object.entries((def.methods as Record<string, unknown>) ?? {})) {
    instance[name] = (fn as (...args: unknown[]) => unknown).bind(instance)
  }
  return instance
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve()
}

async function mount(
  responses: Parameters<typeof respondByRoute>[0][number]["results"],
  city: string | null = '北京',
): Promise<{ wx: InstalledWxStub; page: PageInstance }> {
  const wx = installWxStub()
  if (city !== null) seedStorage('nearby.city', city)
  wx.request.mockImplementation(routes(responses))
  const def = await loadPage()
  const page = instantiate(def)
  page.onShow?.()
  await settle()
  return { wx, page }
}

function cityTap(city: string): unknown {
  return { currentTarget: { dataset: { city } } }
}

interface PageSite {
  siteId: number
  name: string
  distanceMeters: number | null
  availability: number
  cellAvailability: Record<string, number>
  lockers: unknown[]
}

function sitesOf(page: PageInstance): PageSite[] {
  return (page.data.sites as PageSite[] | undefined) ?? []
}

describe('#72 附近页 · 定位', () => {
  it('⚠️ 进入页面不自动请求定位 / 不读授权设置，只按城市 + 半径取站点', async () => {
    const { wx, page } = await mount([siteBody([site()])])

    expect(wx.getLocation).not.toHaveBeenCalled()
    expect(wx.getSetting).not.toHaveBeenCalled()
    expect(wx.openSetting).not.toHaveBeenCalled()
    expect(page.data.phase).toBe('ready')
    expect(page.data.showLocationBanner).toBe(true)
    expect(page.data.locationBanner).toBe(NEARBY_COPY.locationBanner)
    expect(page.data.locationAction).toBe(NEARBY_COPY.enableLocation)
    expect(requestUrls(wx)).toEqual([
      // ⚠️ 没有坐标就不发半径（城市列表没有中心点）—— spec §8 的参数口径。
      siteUrl('city=%E5%8C%97%E4%BA%AC&page=1&pageSize=20'),
    ])
    // 地图流是另一发，按 spec §8 取满 100 条。
    expect(mapUrls(wx)).toEqual([siteUrl('city=%E5%8C%97%E4%BA%AC&page=1&pageSize=100')])
    // 未定位时服务端即使回了距离也不上屏。
    expect(sitesOf(page)[0]?.distanceMeters).toBeNull()
  })

  it('点「开启定位」才调 getLocation(gcj02)；成功后带坐标重取并显示距离', async () => {
    const { wx, page } = await mount([
      siteBody([site()]),
      siteBody([site({ distanceMeters: 426 })]),
    ])
    wx.getLocation.mockImplementation((options) => {
      options.success?.({ latitude: 39.996, longitude: 116.481, errMsg: 'getLocation:ok' })
    })

    page.onLocate?.()
    await settle()

    expect(wx.getLocation).toHaveBeenCalledTimes(1)
    expect(wx.getLocation.mock.calls[0]?.[0]).toMatchObject({ type: 'gcj02' })
    expect(page.data.locationState).toBe('located')
    expect(page.data.showLocationBanner).toBe(false)
    expect(requestUrls(wx)[1]).toBe(
      siteUrl('lat=39.996&lng=116.481&radiusMeters=3000&city=%E5%8C%97%E4%BA%AC&page=1&pageSize=20'),
    )
    expect(sitesOf(page)[0]?.distanceMeters).toBe(426)
  })

  it('拒绝 / 类目未批 / 系统不可用 → denied：列表照常、距离隐藏、不自动二次授权', async () => {
    const { wx, page } = await mount([siteBody([site({ distanceMeters: 420 })])])
    wx.getLocation.mockImplementation((options) => {
      options.fail?.({ errMsg: 'getLocation:fail auth deny' })
    })
    wx.openSetting.mockImplementation(() => {})

    page.onLocate?.()
    await settle()
    page.onLocate?.()
    await settle()

    // 第一次是用户点的定位请求；拒绝后不再自动调用 getLocation。
    expect(wx.getLocation).toHaveBeenCalledTimes(1)
    expect(page.data.phase).toBe('ready')
    expect(page.data.locationState).toBe('denied')
    expect(page.data.showLocationBanner).toBe(true)
    expect(sitesOf(page)[0]?.distanceMeters).toBeNull()
    // 第二次点击才走 openSetting —— 不再是自动授权。
    expect(wx.openSetting).toHaveBeenCalledTimes(1)
  })

  it('denied 后「开启定位」只在点击时 wx.openSetting；授权成功才继续取定位', async () => {
    const { wx, page } = await mount([siteBody([site()])])
    wx.getLocation
      .mockImplementationOnce((options) => {
        options.fail?.({ errMsg: 'getLocation:fail auth deny' })
      })
      .mockImplementationOnce((options) => {
        options.success?.({ latitude: 39.996, longitude: 116.481 })
      })
    // 第二次 getLocation 成功后要重取列表。
    wx.request.mockImplementation((options) => {
      const url = options.url
      if (url.includes('page=1&pageSize=20') && !url.includes('lat=')) {
        queueMicrotask(() => options.success?.(siteBody([site()])))
      } else {
        queueMicrotask(() => options.success?.(siteBody([site({ distanceMeters: 300 })])))
      }
    })
    wx.openSetting.mockImplementation((options) => {
      options?.success?.({ authSetting: { 'scope.userLocation': true } })
    })

    page.onLocate?.()
    await settle()
    expect(page.data.locationState).toBe('denied')

    page.onLocate?.()
    await settle()

    expect(wx.openSetting).toHaveBeenCalledTimes(1)
    expect(wx.getLocation).toHaveBeenCalledTimes(2)
    expect(page.data.locationState).toBe('located')
    expect(sitesOf(page)[0]?.distanceMeters).toBe(300)
  })
})

describe('#72 附近页 · 城市', () => {
  it('⚠️ 首次无城市记录 → 先拉城市端点并停在 citypick，不请求站点', async () => {
    const { wx, page } = await mount([citiesBody(['北京', '上海'])], null)

    expect(page.data.phase).toBe('citypick')
    expect(page.data.showCityPicker).toBe(true)
    expect(page.data.cities).toEqual(['北京', '上海'])
    expect(requestUrls(wx)).toEqual([`${BASE_URL}${NEARBY_CITIES_ENDPOINT}`])
  })

  it('选城市后：只把城市名落 storage，再按城市取站点', async () => {
    const { wx, page } = await mount(
      [citiesBody(['北京', '上海']), siteBody([site({ city: '上海' })])],
      null,
    )

    page.onCitySelect?.(cityTap('上海'))
    await settle()

    expect(wx.setStorageSync).toHaveBeenCalledTimes(1)
    expect(wx.setStorageSync).toHaveBeenCalledWith('nearby.city', '上海')
    expect(page.data.city).toBe('上海')
    expect(page.data.showCityPicker).toBe(false)
    expect(page.data.phase).toBe('ready')
    expect(requestUrls(wx)[1]).toBe(
      siteUrl('city=%E4%B8%8A%E6%B5%B7&page=1&pageSize=20'),
    )
  })

  it('城市选择器数据来自城市端点；打开选择器不改站点请求', async () => {
    const { wx, page } = await mount([
      siteBody([site()]),
      citiesBody(['北京', '上海']),
    ])

    page.onOpenCityPicker?.()
    await settle()

    expect(page.data.showCityPicker).toBe(true)
    expect(page.data.cities).toEqual(['北京', '上海'])
    expect(requestUrls(wx)[1]).toBe(`${BASE_URL}${NEARBY_CITIES_ENDPOINT}`)
  })
})

describe('#72 附近页 · 搜索', () => {
  it('⚠️ 输入不搜索；提交后才发请求，且必带城市、不带半径', async () => {
    const { wx, page } = await mount([
      siteBody([site()]),
      siteBody([site({ name: '嘉里中心', siteId: 21 })]),
    ])

    page.onKeywordInput?.({ detail: { value: '嘉里' } })
    await settle()
    expect(requestUrls(wx)).toHaveLength(1)

    page.onSearch?.({ detail: { value: '嘉里' } })
    await settle()

    expect(page.data.activeKeyword).toBe('嘉里')
    expect(requestUrls(wx)[1]).toBe(
      siteUrl(
        'city=%E5%8C%97%E4%BA%AC&keyword=%E5%98%89%E9%87%8C&page=1&pageSize=20',
      ),
    )
    expect(requestUrls(wx)[1]).not.toContain('radiusMeters')
    expect(sitesOf(page)[0]?.name).toBe('嘉里中心')
  })

  it('清除后回到当前城市 + 半径结果', async () => {
    const { wx, page } = await mount([
      siteBody([site()]),
      siteBody([site({ name: '嘉里中心', siteId: 21 })]),
      siteBody([site()]),
    ])

    page.onKeywordInput?.({ detail: { value: '嘉里' } })
    page.onSearch?.({ detail: { value: '嘉里' } })
    await settle()
    page.onClearSearch?.()
    await settle()

    expect(page.data.keywordDraft).toBe('')
    expect(page.data.activeKeyword).toBe('')
    expect(page.data.showClear).toBe(false)
    expect(requestUrls(wx)[2]).toBe(
      siteUrl('city=%E5%8C%97%E4%BA%AC&page=1&pageSize=20'),
    )
  })

  it('搜索无结果与附近无柜机是两种不同空态', async () => {
    const { wx, page } = await mount([
      siteBody([site()]),
      siteBody([], 0),
    ])

    page.onSearch?.({ detail: { value: '不存在' } })
    await settle()

    expect(page.data.phase).toBe('noresult')
    expect(page.data.noResultTitle).toBe('没有找到「不存在」')
    expect(page.data.noResultHint).toBe(NEARBY_COPY.noResultHint)
    // 附近空态标题不应出现。
    expect(page.data.emptyTitle).toBe(NEARBY_COPY.emptyTitle)
    expect(requestUrls(wx)).toHaveLength(2)
  })
})

describe('#72 附近页 · 空态 / 网络失败', () => {
  it('附近无站点 → empty；未定位时不给「扩大到 10 公里」（没有中心点的半径没有意义）', async () => {
    const { wx, page } = await mount([siteBody([], 0)])

    expect(page.data.phase).toBe('empty')
    expect(page.data.emptyTitle).toBe(NEARBY_COPY.emptyTitle)
    expect(page.data.emptyHint).toBe(NEARBY_COPY.emptyHint)
    expect(page.data.emptyActionLabel).toBe('')

    page.onExpandRadius?.()
    await settle()

    // ⚠️ 未定位时半径**不进请求**（spec §8：城市列表没有中心点），所以扩大也不重取。
    expect(requestUrls(wx)).toHaveLength(1)
    expect(requestUrls(wx).every((url) => !url.includes('radiusMeters'))).toBe(true)
  })

  it('已定位且附近无站点 → 给「扩大到 10 公里」，点后按 10000 重取', async () => {
    const { wx, page } = await mount([
      siteBody([], 0),
      siteBody([], 0),
      siteBody([site({ distanceMeters: 8200 })]),
    ])
    wx.getLocation.mockImplementation((options) => {
      options.success?.({ latitude: 39.996, longitude: 116.481, errMsg: 'getLocation:ok' })
    })

    page.onLocate?.()
    await settle()

    expect(page.data.phase).toBe('empty')
    expect(page.data.emptyActionLabel).toBe(NEARBY_COPY.expandRadius)
    expect(requestUrls(wx)[1]).toBe(
      siteUrl('lat=39.996&lng=116.481&radiusMeters=3000&city=%E5%8C%97%E4%BA%AC&page=1&pageSize=20'),
    )

    page.onExpandRadius?.()
    await settle()

    expect(page.data.radiusMeters).toBe(10000)
    expect(requestUrls(wx)[2]).toBe(
      siteUrl('lat=39.996&lng=116.481&radiusMeters=10000&city=%E5%8C%97%E4%BA%AC&page=1&pageSize=20'),
    )
    expect(page.data.phase).toBe('ready')
  })

  it('⚠️ 网络失败自动重试一次；手动重试再发并恢复', async () => {
    const { wx, page } = await mount([
      networkFailure(),
      networkFailure(),
      siteBody([site()]),
    ])

    expect(page.data.phase).toBe('neterr')
    expect(page.data.networkTitle).toBe(NEARBY_COPY.networkTitle)
    expect(page.data.networkDetail).toBe(NEARBY_COPY.networkDetail)
    expect(requestUrls(wx)).toHaveLength(2)

    page.onRetry?.()
    await settle()

    expect(requestUrls(wx)).toHaveLength(3)
    expect(page.data.phase).toBe('ready')
    expect(mocks.showToast).not.toHaveBeenCalled()
  })

  it('业务失败不自动重试（只网络失败重试一次）', async () => {
    const { wx, page } = await mount([
      jsonResponse({ code: 1004, message: '服务端异常', data: null }),
    ])

    expect(page.data.phase).toBe('neterr')
    expect(requestUrls(wx)).toHaveLength(1)
  })

  it('⚠️ 四类空态各有独立的模板分支 / 文案来源', () => {
    const wxml = pageWxml()
    for (const marker of [
      "phase === 'empty'",
      "phase === 'noresult'",
      "phase === 'neterr'",
      'showLocationBanner',
    ]) {
      expect(wxml, `模板缺少 ${marker} 分支`).toContain(marker)
    }
    expect(NEARBY_COPY.locationBanner).toBeTruthy()
    expect(NEARBY_COPY.noResultHint).toBeTruthy()
  })
})

describe('#72 附近页 · 分页', () => {
  it('服务端顺序原样保留；翻页按 siteId 去重，不重排', async () => {
    const first = [
      site({ siteId: 1, name: 'Zulu 站', distanceMeters: 900 }),
      site({ siteId: 2, name: 'Alpha 站', distanceMeters: 300 }),
    ]
    const second = [
      site({ siteId: 3, name: 'Beta 站', distanceMeters: 500 }),
      site({ siteId: 2, name: 'Alpha 重复', distanceMeters: 300 }),
      site({ siteId: 4, name: 'Charlie 站', distanceMeters: 700 }),
    ]
    const { wx, page } = await mount([siteBody(first, 5), siteBody(second, 5)])

    expect(sitesOf(page).map((entry) => entry.siteId)).toEqual([1, 2])

    page.onReachBottom?.()
    await settle()

    expect(page.data.page).toBe(2)
    expect(sitesOf(page).map((entry) => entry.siteId)).toEqual([1, 2, 3, 4])
    expect(requestUrls(wx)[1]).toBe(
      siteUrl('city=%E5%8C%97%E4%BA%AC&page=2&pageSize=20'),
    )
  })
})

describe('#72 附近页 · 缓存与刷新', () => {
  it('30 秒内存缓存：重复 onShow 不重发；过期后重取；下拉刷新绕过缓存', async () => {
    const timers = installFakeTimers()
    timers.setNow(1_700_000_000_000)
    const { wx, page } = await mount([
      siteBody([site()]),
      siteBody([site({ siteId: 2 })]),
      siteBody([site({ siteId: 3 })]),
    ])
    wx.stopPullDownRefresh.mockImplementation(() => {})

    expect(requestUrls(wx)).toHaveLength(1)
    page.onShow?.()
    await timers.settle()
    expect(requestUrls(wx)).toHaveLength(1)

    timers.setNow(1_700_000_030_001)
    page.onShow?.()
    await timers.settle()
    expect(requestUrls(wx)).toHaveLength(2)

    await page.onPullDownRefresh?.()
    await timers.settle()
    expect(requestUrls(wx)).toHaveLength(3)
    expect(wx.stopPullDownRefresh).toHaveBeenCalledTimes(1)
  })
})

describe('#72 附近页 · 导航与能力边界', () => {
  it('导航只对站点坐标调 wx.openLocation（gcj02 / scale 18），不依赖定位授权', async () => {
    const { wx, page } = await mount([siteBody([site()])])
    wx.openLocation.mockImplementation(() => {})

    page.onSiteNavigate?.({ detail: { siteId: 12 } })

    expect(wx.openLocation).toHaveBeenCalledTimes(1)
    expect(wx.openLocation.mock.calls[0]?.[0]).toMatchObject({
      latitude: 39.996,
      longitude: 116.481,
      name: '望京 SOHO T1',
      address: '朝阳区望京街 10 号',
      scale: 18,
    })
    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(wx.switchTab).not.toHaveBeenCalled()
  })

  it('无坐标站点不发导航 —— 列表仍在，只是没有 wx.openLocation', async () => {
    const { wx, page } = await mount([
      siteBody([site({ lng: null, lat: null, distanceMeters: null })]),
    ])
    wx.openLocation.mockImplementation(() => {})

    page.onSiteNavigate?.({ detail: { siteId: 12 } })

    expect(wx.openLocation).not.toHaveBeenCalled()
    expect(sitesOf(page)).toHaveLength(1)
  })

  it('⚠️ 即使响应误带 lockerId / 柜机码，渲染模型也只搬契约字段', async () => {
    const dirty = {
      ...site(),
      lockerId: 99,
      code: 'WD-01',
      status: 2,
      lockers: [{ position: '大堂', status: 1, id: 99, code: 'WD-01' }],
    } as unknown as NearbySite
    const { page } = await mount([siteBody([dirty])])

    const first = page.data.sites as Array<Record<string, unknown>>
    expect(first[0]).not.toHaveProperty('lockerId')
    expect(first[0]).not.toHaveProperty('code')
    expect(first[0]).not.toHaveProperty('status')
    expect(JSON.stringify(page.data)).not.toMatch(/lockerId|WD-01|"status":2/)

    // 柜机明细同样只保留 position / status，不带 id / code。
    expect(first[0]?.lockers).toEqual([{ position: '大堂', status: 1 }])
  })

  it('⚠️ 页面 / 类型 / 模板没有 lockerId / 柜机码 / 出站柜机页 / 下单 / 预约', () => {
    const source = pageSource() + pageWxml() + pageJson()
    expect(source).not.toMatch(/lockerId|lockers?\[\]\.code|柜机码|柜机 ID/i)
    expect(source).not.toMatch(/LOCKER_PATH|pages\/locker|navigateTo|redirectTo|switchTab/)
    expect(source).not.toMatch(/createOrder|reservation|预约|下单/)
    expect(source).not.toContain('查看柜机')

    const types = readFileSync(
      join(repoRoot, 'miniprogram', 'types', 'nearby.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    expect(types).not.toMatch(/\blockerId\b|lockers?\[\]\.code|柜机码/)
  })

  it('⚠️ 配置 / 文案接线：title、tab 路径、权限声明都在', () => {
    expect(PAGE_TITLES['pages/nearby/nearby']).toBe('附近柜机')
    expect(NEARBY_PATH).toBe('pages/nearby/nearby')
    const appJson = JSON.parse(
      readFileSync(join(repoRoot, 'miniprogram', 'app.json'), 'utf8'),
    ) as {
      pages: string[]
      requiredPrivateInfos?: string[]
      permission?: Record<string, { desc?: string }>
      tabBar: { list: { pagePath: string; text: string }[] }
    }
    expect(appJson.pages).toContain(NEARBY_PATH)
    expect(appJson.tabBar.list.map((item) => item.text)).toEqual([
      '首页',
      '订单',
      '附近',
      '我的',
    ])
    expect(appJson.tabBar.list[2]?.pagePath).toBe(NEARBY_PATH)
    expect(appJson.requiredPrivateInfos).toEqual(['getLocation'])
    expect(appJson.permission?.['scope.userLocation']?.desc).toBeTruthy()
  })

  it('⚠️ storage 只写城市名；页面源码没有别的业务缓存', async () => {
    const { wx, page } = await mount(
      [citiesBody(['北京', '上海']), siteBody([site()])],
      null,
    )
    page.onCitySelect?.(cityTap('上海'))
    await settle()

    expect(wx.setStorageSync).toHaveBeenCalledTimes(1)
    expect(wx.setStorageSync.mock.calls[0]?.[0]).toBe('nearby.city')
    expect(typeof wx.setStorageSync.mock.calls[0]?.[1]).toBe('string')
    expect(wx.setStorageSync.mock.calls[0]?.[1]).toBe('上海')

    const source = pageSource()
    expect(source).not.toMatch(/wx\.removeStorageSync|wx\.clearStorage/)
    expect(source.match(/wx\.setStorageSync/g) ?? []).toHaveLength(1)
  })
})
