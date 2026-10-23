// **附近柜机页 · 地图带与全屏地图**的验收 —— ticket #73 / spec #57 §8。
//
// 断言只落在外部行为：页面 `data` 画出的 marker / 选中态 / 地图失败态、
// 平台调用（`wx.pageScrollTo` / `wx.openLocation` / storage）与模板结构。
//
// 五条边界：
//   1. marker 只落有坐标站点；颜色 = 可用状态（可存件绿 / 已满琥珀 / 暂不可用灰）。
//   2. 列表卡与 marker 是同一个选中态：点卡 → marker 高亮并居中；点 marker → 滚到卡。
//   3. 全屏地图是同一页的次级入口；返回保持中心与选中站点；浮层是 cover-view。
//   4. 地图失败（渲染错误 / 看门狗）→ 64px 提示行，列表照常，可手动重试。
//   5. 定位失败不影响地图与列表；全程不落 storage、不出站到柜机页。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWxStub, jsonResponse, seedStorage } from '../helpers/wx'
import { respondByRoute, sentRequests } from '../helpers/http'
import { installFakeTimers } from '../helpers/timers'
import { decodePng, opaqueColors } from '../helpers/png'
import type { InstalledWxStub, WxRequestSuccessResult } from '../helpers/wx'
import { NEARBY_COPY, NEARBY_PATH } from '../../miniprogram/startup/copy'
import { BASE_URL } from '../../miniprogram/request/config'
import { NEARBY_SITES_ENDPOINT } from '../../miniprogram/api/nearby'
import type { NearbySite } from '../../miniprogram/types/nearby'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const pageDir = join(repoRoot, 'miniprogram', 'pages', 'nearby')
const pageSource = (): string =>
  readFileSync(join(pageDir, 'nearby.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
const pageWxml = (): string =>
  readFileSync(join(pageDir, 'nearby.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
const pageScss = (): string =>
  readFileSync(join(pageDir, 'nearby.scss'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

function token(name: string): string {
  const scss = readFileSync(join(repoRoot, 'miniprogram', 'styles', '_variables.scss'), 'utf8')
  const match = new RegExp(`^\\s*\\$${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`, 'm').exec(scss)
  if (!match?.[1]) throw new Error(`token ${name} not found`)
  return match[1].toLowerCase()
}

function marker(overrides: Partial<NearbySite> = {}): NearbySite {
  return {
    siteId: 1,
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

function body(items: readonly NearbySite[], total = items.length): WxRequestSuccessResult {
  return jsonResponse({ code: 0, message: 'ok', data: { list: items, total } })
}

let definition: Record<string, unknown> | null = null

beforeEach(() => {
  definition = null
  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (def: Record<string, unknown>): void => {
    definition = def
  }
})

interface MapMarkerData {
  id: number
  latitude: number
  longitude: number
  iconPath: string
  width: number
  height: number
  callout?: {
    content?: string
    color?: string
    bgColor?: string
    display?: string
  }
}

interface PageInstance {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
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
  } as PageInstance
  for (const [name, fn] of Object.entries((def.methods as Record<string, unknown>) ?? {})) {
    instance[name] = (fn as (...args: unknown[]) => unknown).bind(instance)
  }
  return instance
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve()
}

/** 地图流的请求特征 —— spec §8 的 `pageSize=100`。 */
const MAP_QUERY = 'pageSize=100'

const isMapRequest = (url: string): boolean => url.includes(MAP_QUERY)

function mapUrls(wx: InstalledWxStub): string[] {
  return sentRequests(wx.request)
    .map((request) => request.url)
    .filter(isMapRequest)
}

/**
 * 挂载页面。
 *
 * ⚠️ 本页有**两条流**（列表 20 / 地图 100），所以响应按 URL 分流：
 * `list` 依次回列表 / 城市的请求，`map` 依次回地图的请求。
 * `map` 缺省时用 `list[0]`（首屏那一批站点）—— 地图带与列表首屏画的是同一批柜机，
 * 这正是多数用例要的形状。
 */
async function mount(
  list: Parameters<typeof respondByRoute>[0][number]['results'],
  map?: Parameters<typeof respondByRoute>[0][number]['results'],
): Promise<{ wx: InstalledWxStub; page: PageInstance }> {
  const wx = installWxStub()
  seedStorage('nearby.city', '北京')
  const first = list[0]
  wx.request.mockImplementation(
    respondByRoute([
      {
        match: (options) => isMapRequest(options.url),
        results: map ?? (first === undefined ? [] : [first]),
      },
      { match: () => true, results: list },
    ]),
  )
  const def = await loadPage()
  const page = instantiate(def)
  ;(page.onShow as () => void)()
  await settle()
  return { wx, page }
}

function markersOf(page: PageInstance): MapMarkerData[] {
  return (page.data.markers as MapMarkerData[] | undefined) ?? []
}

function markerOf(page: PageInstance, siteId: number): MapMarkerData | undefined {
  return markersOf(page).find((entry) => entry.id === siteId)
}

function call(page: PageInstance, name: string, event?: unknown): void {
  const method = page[name] as ((event?: unknown) => void) | undefined
  if (method === undefined) throw new Error(`页面缺少方法 ${name}`)
  method(event)
}

/** 列表 / 城市流的请求数（不含地图流）。 */
function requestCount(wx: InstalledWxStub): number {
  return sentRequests(wx.request).length - mapUrls(wx).length
}

describe('#73 附近页 · 地图 marker', () => {
  it('⚠️ marker 只落有坐标站点；三色 = 可存件绿 / 已满琥珀 / 暂不可用灰', async () => {
    const sites = [
      marker({ siteId: 1, name: '可存件站', availability: 1 }),
      marker({ siteId: 2, name: '已满站', availability: 2, lng: 116.49, lat: 39.995 }),
      marker({ siteId: 3, name: '暂不可用站', availability: 3, lng: 116.5, lat: 39.99 }),
      marker({ siteId: 4, name: '无坐标站', lng: null, lat: null, distanceMeters: null }),
    ]
    const { page } = await mount([body(sites)])

    expect(page.data.phase).toBe('ready')
    expect(markersOf(page).map((entry) => entry.id)).toEqual([1, 2, 3])
    expect(markersOf(page).map((entry) => entry.iconPath)).toEqual([
      '/assets/map/marker-available.png',
      '/assets/map/marker-full.png',
      '/assets/map/marker-unavailable.png',
    ])

    // 颜色不是「三个不同文件名」就算数：逐个解码 PNG，断言填充色确实是状态 token。
    const expectedTokens = [
      ['marker-available.png', 'color-primary'],
      ['marker-full.png', 'color-warning'],
      ['marker-unavailable.png', 'color-info'],
    ] as const
    for (const [file, tokenName] of expectedTokens) {
      const png = decodePng(
        readFileSync(join(repoRoot, 'miniprogram', 'assets', 'map', file)),
      )
      expect(png.width, `${file} 宽度`).toBe(48)
      expect(png.height, `${file} 高度`).toBe(48)
      expect(opaqueColors(png), `${file} 不是状态 token 色`).toContain(token(tokenName))
    }

    // 无坐标站点仍在列表，只是没有 marker；默认也没有任何 callout。
    expect(page.data.sites).toHaveLength(4)
    expect(markerOf(page, 4)).toBeUndefined()
    expect(markersOf(page).every((entry) => entry.callout === undefined)).toBe(true)
  })

  it('⚠️ 加载中地图仍在版式里，但没有任何 marker', async () => {
    const wx = installWxStub()
    seedStorage('nearby.city', '北京')
    const gate: { release: (() => void) | null } = { release: null }
    wx.request.mockImplementation((options) => {
      gate.release = () => options.success?.(body([marker()]))
    })
    const def = await loadPage()
    const page = instantiate(def)
    ;(page.onShow as () => void)()
    await settle()

    expect(page.data.phase).toBe('loading')
    expect(page.data.showMapBand).toBe(true)
    expect(markersOf(page)).toEqual([])

    gate.release?.()
    await settle()
    expect(page.data.phase).toBe('ready')
    expect(markersOf(page)).toHaveLength(1)
  })

  it('⚠️ 选中一个站点后只有它的 marker 放大并带白色 callout（ink 文字）', async () => {
    const sites = [
      marker({ siteId: 1, name: '可存件站', availability: 1 }),
      marker({ siteId: 2, name: '已满站', availability: 2, lng: 116.49, lat: 39.995 }),
    ]
    const { page } = await mount([body(sites)])

    call(page, 'onSiteSelect', { detail: { siteId: 2 } })

    expect(page.data.selectedSiteId).toBe(2)
    const selected = markerOf(page, 2)
    const other = markerOf(page, 1)
    expect(selected?.callout).toMatchObject({
      content: '已满站',
      display: 'ALWAYS',
    })
    // ⚠️ callout 的两色是**原生 map API 唯一接受字面色值**的地方（不吃 CSS 变量、
    // 不吃 SCSS token），所以它们在 `nearby.ts` 里是一对具名字面量。
    // 判据不写死 hex，而是把它们**表到 token 上** —— token 改了、marker 没跟着改的那天
    // 这里会红，而不是等用户看到一块与设计稿不同的气泡。
    expect(selected?.callout?.bgColor).toBe(token('color-bg-card'))
    expect(selected?.callout?.color).toBe(token('color-text-main'))
    expect(other?.callout).toBeUndefined()
    expect(selected?.width ?? 0).toBeGreaterThan(other?.width ?? 0)
    // 列表卡 → 地图居中到该站点。
    expect(page.data.mapLatitude).toBe(39.995)
    expect(page.data.mapLongitude).toBe(116.49)
  })
})

describe('#73 附近页 · 列表与地图共享选中态', () => {
  it('⚠️ 点 marker → 选中该站点并滚动到对应列表卡；两边都不出站', async () => {
    const { wx, page } = await mount([
      body([
        marker({ siteId: 1, name: '可存件站' }),
        marker({ siteId: 2, name: '已满站', lng: 116.49, lat: 39.995 }),
      ]),
    ])
    wx.pageScrollTo.mockImplementation(() => {})

    call(page, 'onMarkerTap', { detail: { markerId: 2 } })

    expect(page.data.selectedSiteId).toBe(2)
    expect(wx.pageScrollTo).toHaveBeenCalledTimes(1)
    expect(wx.pageScrollTo.mock.calls[0]?.[0]).toMatchObject({
      selector: '#nearby-site-2',
      duration: 0,
    })
    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(wx.redirectTo).not.toHaveBeenCalled()
    expect(wx.switchTab).not.toHaveBeenCalled()
  })

  it('⚠️ 点列表卡 → 同一个选中态，marker 高亮并居中；不产生任何跳转', async () => {
    const { wx, page } = await mount([
      body([
        marker({ siteId: 1, name: '可存件站' }),
        marker({ siteId: 2, name: '已满站', lng: 116.49, lat: 39.995 }),
      ]),
    ])

    call(page, 'onSiteSelect', { detail: { siteId: 2 } })

    expect(page.data.selectedSiteId).toBe(2)
    expect(markerOf(page, 2)?.callout?.content).toBe('已满站')
    expect(page.data.mapLatitude).toBe(39.995)
    expect(page.data.mapLongitude).toBe(116.49)
    expect(wx.pageScrollTo).not.toHaveBeenCalled()
    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(wx.redirectTo).not.toHaveBeenCalled()
    expect(wx.switchTab).not.toHaveBeenCalled()
  })
})

describe('#73 附近页 · 全屏地图', () => {
  it('⚠️ 全屏是同页次级入口，复用同一套 marker 与卡片浮层；返回保持中心与选中站点', async () => {
    const { wx, page } = await mount([
      body([
        marker({ siteId: 1, name: '可存件站' }),
        marker({ siteId: 2, name: '已满站', lng: 116.49, lat: 39.995 }),
      ]),
    ])
    call(page, 'onSiteSelect', { detail: { siteId: 2 } })
    const markersBefore = markersOf(page)

    call(page, 'onOpenFullscreen')
    expect(page.data.showFullscreenMap).toBe(true)
    expect(page.data.markers).toEqual(markersBefore)
    expect((page.data.selectedCard as { siteId?: number }).siteId).toBe(2)

    // 用户在全屏里把地图拖到另一个中心；返回后必须保持。
    call(page, 'onRegionChange', {
      detail: {
        type: 'end',
        centerLocation: { latitude: 31.23, longitude: 121.47 },
      },
    })
    call(page, 'onCloseFullscreen')

    expect(page.data.showFullscreenMap).toBe(false)
    expect(page.data.mapLatitude).toBe(31.23)
    expect(page.data.mapLongitude).toBe(121.47)
    expect(page.data.selectedSiteId).toBe(2)
    // 页面栈内状态：不写 storage、不新增路由。
    expect(wx.setStorageSync).not.toHaveBeenCalled()
    expect(wx.navigateTo).not.toHaveBeenCalled()

    const appJson = JSON.parse(
      readFileSync(join(repoRoot, 'miniprogram', 'app.json'), 'utf8'),
    ) as { pages: string[] }
    expect(appJson.pages.filter((path) => path.includes('nearby'))).toEqual([NEARBY_PATH])
  })

  it('⚠️ 全屏卡片浮层必须是 cover-view —— 原生 map 会盖住普通 view', () => {
    const wxml = pageWxml()
    const fullscreen = /<map[^>]*id="nearby-fullscreen-map"[\s\S]*?<\/map>/.exec(wxml)?.[0]
    expect(fullscreen, '缺少全屏地图').toBeTruthy()
    expect(fullscreen).toContain('<cover-view')
    expect(fullscreen).not.toMatch(/<view\b/)
    expect(fullscreen).toContain('markers="{{ markers }}"')
    expect(wxml).toContain('bindrendererror="onMapRenderError"')
    expect(wxml).toContain('bindmarkertap="onMarkerTap"')
    expect(wxml).toContain('bindregionchange="onRegionChange"')
  })
})

describe('#73 附近页 · 地图失败降级', () => {
  it('⚠️ bindrendererror → 地图带塌成提示行，列表仍可用，手动重试可恢复', async () => {
    const { wx, page } = await mount([body([marker()])])
    wx.openLocation.mockImplementation(() => {})

    call(page, 'onMapRenderError')

    expect(page.data.mapFailed).toBe(true)
    expect(page.data.mapFailTitle).toBe(NEARBY_COPY.mapFailTitle)
    expect(page.data.mapFailHint).toBe(NEARBY_COPY.mapFailHint)
    expect(page.data.phase).toBe('ready')
    expect(page.data.sites).toHaveLength(1)
    expect(requestCount(wx)).toBe(1)

    // 列表原地可用：导航照常，且不会因为地图失败被禁用。
    call(page, 'onSiteNavigate', { detail: { siteId: 1 } })
    expect(wx.openLocation).toHaveBeenCalledTimes(1)

    call(page, 'onMapRetry')
    expect(page.data.mapFailed).toBe(false)
    expect(requestCount(wx)).toBe(1)
  })

  it('⚠️ 3–5 秒看门狗：没有 bindupdated 就降级；updated 取消；重试重新计时', async () => {
    const timers = installFakeTimers()
    const { page } = await mount([body([marker()])])

    expect(page.data.mapFailed).toBe(false)
    await timers.tick(4000)
    await timers.settle()
    expect(page.data.mapFailed).toBe(true)
    expect(page.data.phase).toBe('ready')
    expect(page.data.sites).toHaveLength(1)

    call(page, 'onMapRetry')
    expect(page.data.mapFailed).toBe(false)
    call(page, 'onMapUpdated')
    await timers.tick(10_000)
    await timers.settle()
    expect(page.data.mapFailed).toBe(false)
  })

  it('⚠️ 定位失败不影响地图与列表：marker 仍在、地图不塌', async () => {
    const { wx, page } = await mount([body([marker()])])
    wx.getLocation.mockImplementation((options) => {
      options.fail?.({ errMsg: 'getLocation:fail auth deny' })
    })

    call(page, 'onLocate')
    await settle()

    expect(page.data.locationState).toBe('denied')
    expect(page.data.mapFailed).toBe(false)
    expect(markersOf(page)).toHaveLength(1)
    expect(page.data.phase).toBe('ready')
  })

  it('⚠️ 样式口径：地图带 206px、失败行 64px', () => {
    const scss = pageScss()
    expect(scss).toMatch(/\.nearby__map-band\s*\{[^}]*height:\s*206px/)
    expect(scss).toMatch(/\.nearby__map-fail\s*\{[^}]*height:\s*64px/)
  })

  it('⚠️ 能力边界：无 lockerId / 出站柜机页 / 下单 / 预约', () => {
    const source = pageSource() + pageWxml()
    expect(source).not.toMatch(/lockerId|lockers?\[\]\.code|柜机码|柜机 ID/i)
    expect(source).not.toMatch(/LOCKER_PATH|pages\/locker|navigateTo|redirectTo|switchTab/)
    expect(source).not.toMatch(/createOrder|reservation|预约|下单/)
    expect(source).not.toContain('查看柜机')
  })
})

describe('#73 附近页 · 地图流按 pageSize=100 单独取（spec §8）', () => {
  /** 20 条列表站点 —— 列表分页的形状。 */
  function listSites(): NearbySite[] {
    return Array.from({ length: 20 }, (_, index) =>
      marker({ siteId: index + 1, name: `站点 ${index + 1}`, lng: 116.4 + index / 100, lat: 39.9 }),
    )
  }

  it('⚠️ 地图带一次取 100 条：marker 覆盖全量，列表仍是 20 条那一页', async () => {
    const mapSites = Array.from({ length: 100 }, (_, index) =>
      marker({ siteId: index + 1, name: `站点 ${index + 1}`, lng: 116.4 + index / 100, lat: 39.9 }),
    )
    const { wx, page } = await mount(
      [body(listSites(), 100)],
      [body(mapSites, 100)],
    )

    // 列表：仍然是第一页 20 条（`pageSize=20` 的分页不动）。
    expect(page.data.sites).toHaveLength(20)
    expect(page.data.page).toBe(1)
    expect(page.data.listHeader).toBe(NEARBY_COPY.listHeader.replace('{count}', '100'))
    // 地图：100 个 marker 全在（此前只看得到列表已加载的 20 个）。
    expect(markersOf(page)).toHaveLength(100)
    expect(markersOf(page).map((entry) => entry.id)).toEqual(
      mapSites.map((entry) => entry.siteId),
    )
    // 地图流是单独一发，且带着 spec §8 的 pageSize=100。
    expect(mapUrls(wx)).toEqual([
      `${BASE_URL}${NEARBY_SITES_ENDPOINT}?city=%E5%8C%97%E4%BA%AC&page=1&pageSize=100`,
    ])
    // 只发了两次请求：列表首屏 + 地图流（未定位不带半径）。
    expect(sentRequests(wx.request)).toHaveLength(2)
  })

  it('⚠️ 地图流按 siteId 去重、保持服务端顺序、不重排', async () => {
    const { page } = await mount(
      [body([marker({ siteId: 1 })], 3)],
      [
        body([
          marker({ siteId: 5, name: '五号' }),
          marker({ siteId: 3, name: '三号' }),
          marker({ siteId: 5, name: '五号重复' }),
          marker({ siteId: 9, name: '九号' }),
        ]),
      ],
    )

    // 服务端顺序原样保留（5 → 3 → 9），重复的 siteId 只留第一次出现的那条。
    expect(markersOf(page).map((entry) => entry.id)).toEqual([5, 3, 9])
    expect(markersOf(page).map((entry) => entry.callout?.content ?? '')).toEqual(['', '', ''])
    // 列表只有一条：地图流不会把条目灌进列表（列表分页归服务端）。
    expect(page.data.sites).toHaveLength(1)
  })

  it('⚠️ 列表之外的站点（第 50 个）也能点选并出现在全屏浮层里', async () => {
    const mapSites = Array.from({ length: 100 }, (_, index) =>
      marker({
        siteId: index + 1,
        name: `站点 ${index + 1}`,
        lng: 116.4 + index / 100,
        lat: 39.9,
      }),
    )
    const { wx, page } = await mount([body(listSites(), 100)], [body(mapSites, 100)])
    wx.pageScrollTo.mockImplementation(() => {})

    call(page, 'onMarkerTap', { detail: { markerId: 50 } })

    expect(page.data.selectedSiteId).toBe(50)
    expect(markerOf(page, 50)?.callout?.content).toBe('站点 50')
    expect((page.data.selectedCard as { name: string }).name).toBe('站点 50')
  })

  it('⚠️ 地图流失败不影响列表：地图带用列表已加载的站点垫着', async () => {
    const { page } = await mount([
      body([marker({ siteId: 1, name: '可存件站' })], 1),
      { errMsg: 'request:fail timeout' },
      { errMsg: 'request:fail timeout' },
    ])

    expect(page.data.phase).toBe('ready')
    expect(page.data.sites).toHaveLength(1)
    expect(page.data.mapFailed).toBe(false)
    // 地图流两次都失败（自动重试一次）→ 退回列表那一份，而不是空白。
    expect(markersOf(page).map((entry) => entry.id)).toEqual([1])
  })
})
