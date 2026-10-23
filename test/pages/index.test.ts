// **首页扫码主行动** 的验收 —— issue #61（spec #57 §2）。
//
// 本文件守两半：
//   1. **行为**：四种扫码结果各走到哪里（进柜机页 / 留在首页提示 / 静默 / 提示）；
//   2. **形状**：闸门三态仍由 `phase` 驱动、按下反馈是 0ms 换色、路径只有一个家、
//      不探测相机权限、页面不碰 storage；#67 订单区与 #72 附近入口各自接线。
//
// ⚠️ 断言落在页面外部行为上：`wx.scanCode` 收到了什么、`wx.navigateTo` 去了哪里、
// `showToast` 说了哪句话。不测页面内部怎么组织方法。
//
// ⚠️ `showToast` 用 `vi.mock` 换掉反馈适配层：本文件验的是「页面让用户看到哪句话」，
// Vant 内部由 `test/utils/feedback.test.ts` 负责。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWxStub, jsonResponse, networkFailure, reply, seedStorage } from '../helpers/wx'
import { respondInOrder, sentRequests, urlsOf } from '../helpers/http'
import { BASE_URL } from '../../miniprogram/request/config'
import {
  HOME_PAGE_COPY,
  NEARBY_PATH,
  ORDER_LIST_PATH,
  PAGE_TITLES,
  SCAN_COPY,
} from '../../miniprogram/startup/copy'
import { LOCKER_PATH, ORDER_DETAIL_PATH } from '../../miniprogram/utils/routes'
import type { OrderSummary } from '../../miniprogram/types/orders'
import type { InstalledWxStub } from '../helpers/wx'

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('../../miniprogram/utils/feedback', () => ({
  showToast: mocks.showToast,
  confirm: mocks.confirm,
}))

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const indexDir = join(repoRoot, 'miniprogram', 'pages', 'index')
const indexSource = (): string => readFileSync(join(indexDir, 'index.ts'), 'utf8')
const indexWxml = (): string => readFileSync(join(indexDir, 'index.wxml'), 'utf8')
const indexScss = (): string => readFileSync(join(indexDir, 'index.scss'), 'utf8')

/** 一份契约形状的 `13.1` 成功响应体。 */
function loginBody(): Record<string, unknown> {
  return {
    code: 0,
    message: 'ok',
    data: {
      accessToken: 'ACCESS-1',
      refreshToken: 'REFRESH-1',
      expiresIn: 7200,
      user: { id: 88, nickname: null, avatar: null, phone: null, score: 100, status: 1 },
    },
  }
}

/** 剥掉注释后的源码 —— 结构断言读它（注释里讨论契约是必要的）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
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

/** 加载首页组件定义 —— `vi.resetModules()` 让模块级闸门单例每例都是新的。 */
async function loadPage(): Promise<Record<string, unknown>> {
  vi.resetModules()
  await import('../../miniprogram/pages/index/index')
  if (definition === null) throw new Error('index.ts 没有调用 Component()')
  return definition
}

interface PageInstance {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  triggerEvent: (name: string) => void
  attached?: () => void
  detached?: () => void
  [key: string]: unknown
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
  const lifetimes = def.lifetimes as Record<string, () => void> | undefined
  instance.attached = lifetimes?.['attached']?.bind(instance)
  instance.detached = lifetimes?.['detached']?.bind(instance)
  return instance
}

/** 让挂起的微任务链走完（登录链与两条进行中流都是纯微任务驱动的）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

const ORDERS_URL = `${BASE_URL}/api/app/v1/orders`
const ACTIVE_2 = `${ORDERS_URL}?status=2&pageSize=100`
const ACTIVE_4 = `${ORDERS_URL}?status=4&pageSize=100`

/** 一份 `13.8` 行形状的订单；每个用例只覆盖它要测的字段。 */
function order(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: 1001,
    orderNo: '20250401001',
    lockerId: 11,
    lockerNo: 'WD-01',
    siteName: '万达广场店',
    cellNo: 'S03',
    cellType: 2,
    startAt: null,
    endAt: null,
    status: 2,
    payAmount: null,
    estimatedAmount: null,
    pickupCode: null,
    ...overrides,
  }
}

function listBody(rows: OrderSummary[], total = rows.length): Record<string, unknown> {
  return { code: 0, message: 'ok', data: { list: rows, total } }
}

type ArrangedResponse = Record<string, unknown> | { errMsg: string }

/**
 * 进入首页并让进行中订单区完成首查。
 *
 * ⚠️ 预置 refresh token 让闸门走「已有登录态」的免请求路径 —— 本组用例要验的是
 * 订单区本身，登录链的时序已在 `test/startup/page.test.ts` 覆盖。这样 `wx.request`
 * 的编排里只剩两条进行中流，请求顺序断言不会被登录请求淹没。
 */
async function enter(
  responses: readonly ArrangedResponse[],
): Promise<{ wx: InstalledWxStub; page: PageInstance }> {
  const wx = installWxStub()
  seedStorage('auth.refreshToken', 'REFRESH-1')
  wx.request.mockImplementation(
    respondInOrder(
      responses.map((response) =>
        typeof response['errMsg'] === 'string'
          ? { errMsg: response['errMsg'] }
          : jsonResponse(response),
      ),
    ),
  )
  wx.navigateTo.mockImplementation(() => {})
  wx.switchTab.mockImplementation(() => {})
  wx.scanCode.mockImplementation(() => {})
  wx.stopPullDownRefresh.mockImplementation(() => {})

  const def = await loadPage()
  const page = instantiate(def)
  page.attached?.()
  // 真实运行时 onShow 紧跟 attached —— 首查由它触发（闸门 ready 后不再重复起一条）。
  ;(page.onShow as () => void)()
  await settle()
  return { wx, page }
}

/** 前两张实际渲染的卡。 */
function idsOf(page: PageInstance): number[] {
  return (page.data.homeOrders as OrderSummary[]).map((item) => item.id)
}

/** 合并排序后的完整进行中集合 —— N 由它决定。 */
function allIdsOf(page: PageInstance): number[] {
  return (page.data.activeOrders as OrderSummary[]).map((item) => item.id)
}

function renderedJson(page: PageInstance): string {
  return JSON.stringify(page.data)
}

/**
 * 装好扫码桩并加载页面。
 *
 * `wx.scanCode` 与 `wx.navigateTo` 都按「真实回话」编排 —— 未编排即抛错的桩会让
 * 「某条分支根本没调 API」以异常形式爆出来，而本文件要断言的正是「调没调」。
 */
async function scanWith(outcome: {
  result?: string
  errMsg?: string
}): Promise<{ wx: InstalledWxStub; page: PageInstance }> {
  const wx = installWxStub()
  wx.scanCode.mockImplementation((options) => {
    if (outcome.errMsg === undefined) {
      options.success?.({ result: outcome.result ?? '', errMsg: 'scanCode:ok' })
    } else {
      options.fail?.({ errMsg: outcome.errMsg })
    }
  })
  wx.navigateTo.mockImplementation(() => {})
  const def = await loadPage()
  const page = instantiate(def)
  ;(page.onScan as (() => void) | undefined)?.()
  return { wx, page }
}

describe('#61 首页 · 扫码四种结果', () => {
  it('⚠️ 扫到柜机码 → `navigateTo` 柜机页，并带上解析后的 `code`', async () => {
    const { wx } = await scanWith({ result: 'https://locker.example.com/l/WD-01' })

    expect(wx.scanCode).toHaveBeenCalledTimes(1)
    expect(wx.navigateTo).toHaveBeenCalledTimes(1)
    const url = (wx.navigateTo.mock.calls[0]?.[0] as { url: string } | undefined)?.url ?? ''
    expect(url).toBe(`/${LOCKER_PATH}?code=WD-01`)
    expect(mocks.showToast).not.toHaveBeenCalled()
  })

  it('⚠️ 非柜机码 → 留在首页给一句提示，绝不跳转', async () => {
    const { wx } = await scanWith({ result: 'https://example.com/not-a-locker' })

    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledTimes(1)
    expect(mocks.showToast).toHaveBeenCalledWith(SCAN_COPY.notLockerCode)
  })

  it('⚠️ 用户取消（`errMsg` 含 cancel）→ 静默，不提示也不跳转', async () => {
    const { wx } = await scanWith({ errMsg: 'scanCode:fail cancel' })

    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(mocks.showToast).not.toHaveBeenCalled()
  })

  it('⚠️ 其他失败 → 一句「扫码没成功，请重试」，不按成因分叉', async () => {
    const { wx } = await scanWith({ errMsg: 'scanCode:fail camera error' })

    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledTimes(1)
    expect(mocks.showToast).toHaveBeenCalledWith(SCAN_COPY.scanFailed)
  })

  it('⚠️ 不传 `onlyFromCamera` —— 默认允许从相册选码', async () => {
    const { wx } = await scanWith({ result: 'https://locker.example.com/l/WD-01' })

    const options = wx.scanCode.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(options).toBeDefined()
    expect(options).not.toHaveProperty('onlyFromCamera')
    expect(typeof options?.['success']).toBe('function')
    expect(typeof options?.['fail']).toBe('function')
  })
})

describe('#61 首页 · 闸门三态', () => {
  it('冷启动首帧是 loading（首页同构骨架），登录成功后 ready', async () => {
    const wx = installWxStub()
    wx.login.mockImplementation(reply({ code: 'WX-CODE', errMsg: 'login:ok' }))
    wx.request.mockImplementation(respondInOrder([jsonResponse(loginBody())]))

    const def = await loadPage()
    const page = instantiate(def)
    expect(page.data.phase).toBe('loading')
    page.attached?.()
    await settle()
    expect(page.data.phase).toBe('ready')
    expect(page.data.wordmark).toBe(HOME_PAGE_COPY.wordmark)
    expect(page.data.tagline).toBe(HOME_PAGE_COPY.tagline)
    expect(page.data.scanLabel).toBe(HOME_PAGE_COPY.scanButton)
  })

  it('登录失败 → failed（整页失败出口仍由启动态驱动）', async () => {
    const wx = installWxStub()
    wx.login.mockImplementation(reply({ code: 'WX-CODE', errMsg: 'login:ok' }))
    wx.request.mockImplementation(respondInOrder([{ errMsg: 'request:fail timeout' }]))

    const def = await loadPage()
    const page = instantiate(def)
    page.attached?.()
    await settle()
    expect(page.data.phase).toBe('failed')
  })

  it('⚠️ 模板按 phase 互斥渲染：loading → 首页骨架，ready → 首页，failed → 失败出口', () => {
    const wxml = stripComments(indexWxml())
    expect(wxml).toMatch(/<skeleton[^>]*wx:if="\{\{ phase === 'loading' \}\}"/)
    expect(wxml).toMatch(/<skeleton[^>]*variant="home"/)
    expect(wxml).toMatch(/wx:elif="\{\{ phase === 'ready' \}\}"/)
    expect(wxml).toMatch(/<failure-exit\b/)
  })
})

describe('#67 首页 · 进行中订单区', () => {
  it('⚠️ 两条流各取一页（pageSize=100）；N 取过滤后条数，排序与订单列表进行中组一致', async () => {
    const { wx, page } = await enter([
      listBody(
        [
          order({ id: 10, status: 2, startAt: '2026-10-23T09:00:00+08:00' }),
          order({ id: 20, status: 2, startAt: null }),
          order({ id: 30, status: 2, startAt: '2026-10-23T08:00:00+08:00' }),
        ],
        // `total` 故意远大于真实行数 —— N 不得用它。
        99,
      ),
      listBody(
        [
          order({ id: 40, status: 4, startAt: '2026-10-23T07:00:00+08:00', endAt: null }),
          // 已补缴取件（4 且 endAt 有值）→ 不属于进行中。
          order({
            id: 50,
            status: 4,
            startAt: '2026-10-23T07:00:00+08:00',
            endAt: '2026-10-23T08:00:00+08:00',
          }),
        ],
        88,
      ),
    ])

    expect(urlsOf(sentRequests(wx.request))).toEqual([ACTIVE_2, ACTIVE_4])
    // 40（已超时）→ 20（待存入）→ 30 / 10（已存入，id 倒序）；首页只渲染前两张。
    expect(allIdsOf(page)).toEqual([40, 20, 30, 10])
    expect(idsOf(page)).toEqual([40, 20])
    expect(page.data.activeOrders).toHaveLength(4)
    expect(page.data.orderCount).toBe(4)
    expect(page.data.showOrders).toBe(true)
    expect(page.data.showOrdersTitle).toBe(true)
    expect(page.data.showViewAll).toBe(true)
    expect(page.data.viewAllLabel).toBe('查看全部 4 个')
  })

  it('⚠️ N = 0：整区（含标题）不渲染', async () => {
    const { page } = await enter([
      listBody([]),
      // 唯一一条 status=4 已闭单 → 过滤后为 0。
      listBody([
        order({
          id: 1,
          status: 4,
          startAt: '2026-10-23T07:00:00+08:00',
          endAt: '2026-10-23T08:00:00+08:00',
        }),
      ]),
    ])

    expect(page.data.ordersPhase).toBe('ready')
    expect(page.data.orderCount).toBe(0)
    expect(page.data.activeOrders).toEqual([])
    expect(page.data.homeOrders).toEqual([])
    expect(page.data.showOrders).toBe(false)
    expect(page.data.showOrdersTitle).toBe(false)
    expect(page.data.showViewAll).toBe(false)
  })

  it('⚠️ N = 1：全部显示，无「查看全部」', async () => {
    const { page } = await enter([
      listBody([order({ id: 1, status: 2, startAt: null })]),
      listBody([]),
    ])

    expect(idsOf(page)).toEqual([1])
    expect(page.data.orderCount).toBe(1)
    expect(page.data.showOrders).toBe(true)
    expect(page.data.showViewAll).toBe(false)
    expect(page.data.viewAllLabel).toBe('')
  })

  it('⚠️ N = 2：两张全部显示，无「查看全部」', async () => {
    const { page } = await enter([
      listBody([
        order({ id: 2, status: 2, startAt: null }),
        order({ id: 1, status: 2, startAt: '2026-10-23T09:00:00+08:00' }),
      ]),
      listBody([]),
    ])

    expect(idsOf(page)).toEqual([2, 1])
    expect(page.data.orderCount).toBe(2)
    expect(page.data.showViewAll).toBe(false)
  })

  it('⚠️ 同 id 出现在两条流时按 id 去重，N 不重复计', async () => {
    const duplicated = order({ id: 7, status: 2, startAt: null })
    const { page } = await enter([
      listBody([duplicated]),
      listBody([order({ id: 7, status: 4, startAt: '2026-10-23T07:00:00+08:00', endAt: null })]),
    ])

    expect(page.data.orderCount).toBe(1)
    expect(idsOf(page)).toEqual([7])
  })

  it('⚠️ 首屏加载失败只在订单区给「订单加载失败 / 重试」，扫码不受影响', async () => {
    const { wx, page } = await enter([networkFailure(), listBody([])])

    expect(page.data.phase).toBe('ready')
    expect(page.data.ordersPhase).toBe('loadFailed')
    expect(page.data.ordersLoadFailedTitle).toBe('订单加载失败')
    expect(page.data.ordersRetryLabel).toBe('重试')
    expect(page.data.showOrders).toBe(true)
    expect(page.data.showOrdersTitle).toBe(false)

    // 订单区失败不影响扫码主行动。
    wx.scanCode.mockImplementation((options) => {
      options.success?.({ result: 'https://locker.example.com/l/WD-01' })
    })
    ;(page.onScan as () => void)()
    expect(wx.navigateTo).toHaveBeenCalledWith({ url: `/${LOCKER_PATH}?code=WD-01` })
  })

  it('⚠️ 失败后点重试真的重新取两条流，成功后渲染订单', async () => {
    const { wx, page } = await enter([networkFailure(), listBody([])])
    expect(page.data.ordersPhase).toBe('loadFailed')

    wx.request.mockImplementation(
      respondInOrder([
        jsonResponse(listBody([order({ id: 1, status: 2, startAt: null })])),
        jsonResponse(listBody([])),
      ]),
    )
    ;(page.onOrdersRetry as () => void)()
    await settle()

    expect(page.data.ordersPhase).toBe('ready')
    expect(idsOf(page)).toEqual([1])
    expect(page.data.showViewAll).toBe(false)
  })

  it('⚠️ 下拉刷新失败：toast「刷新失败，请稍后重试」，旧卡保留，转圈结束', async () => {
    const { wx, page } = await enter([
      listBody([order({ id: 1, status: 2, startAt: null })]),
      listBody([]),
    ])
    expect(idsOf(page)).toEqual([1])

    wx.request.mockImplementation(respondInOrder([networkFailure(), networkFailure()]))
    ;(page.onPullDownRefresh as () => void)()
    await settle()

    expect(mocks.showToast).toHaveBeenCalledWith('刷新失败，请稍后重试')
    expect(idsOf(page)).toEqual([1])
    expect(page.data.ordersPhase).toBe('ready')
    expect(wx.stopPullDownRefresh).toHaveBeenCalled()
  })

  it('⚠️ onShow 静默刷新失败：不提示、保留旧卡、页面仍 ready', async () => {
    const { wx, page } = await enter([
      listBody([order({ id: 1, status: 2, startAt: null })]),
      listBody([]),
    ])
    const before = sentRequests(wx.request).length

    wx.request.mockImplementation(respondInOrder([networkFailure(), networkFailure()]))
    ;(page.onShow as () => void)()
    await settle()

    expect(mocks.showToast).not.toHaveBeenCalled()
    expect(idsOf(page)).toEqual([1])
    expect(page.data.ordersPhase).toBe('ready')
    // 每次回到前台都真的重新取数 —— 没有本地业务缓存。
    expect(sentRequests(wx.request).length).toBe(before + 2)
  })

  it('⚠️ onShow 成功刷新时用新数据替换旧卡', async () => {
    const { wx, page } = await enter([
      listBody([order({ id: 1, status: 2, startAt: null })]),
      listBody([]),
    ])
    expect(idsOf(page)).toEqual([1])

    wx.request.mockImplementation(
      respondInOrder([
        jsonResponse(listBody([order({ id: 2, status: 2, startAt: null })])),
        jsonResponse(listBody([])),
      ]),
    )
    ;(page.onShow as () => void)()
    await settle()

    expect(idsOf(page)).toEqual([2])
  })

  it('⚠️ 整卡点击 → 订单详情（navigateTo，带 id）', async () => {
    const { wx, page } = await enter([
      listBody([order({ id: 40, status: 4, startAt: '2026-10-23T07:00:00+08:00', endAt: null })]),
      listBody([]),
    ])

    ;(page.onOrderTap as (event: unknown) => void)({ detail: { id: 40 } })

    expect(wx.navigateTo).toHaveBeenCalledWith({ url: `/${ORDER_DETAIL_PATH}?id=40` })
  })

  it('⚠️ 「查看全部 N 个」→ switchTab 订单 tab', async () => {
    const { wx, page } = await enter([
      listBody([
        order({ id: 3, status: 2, startAt: null }),
        order({ id: 2, status: 2, startAt: null }),
        order({ id: 1, status: 2, startAt: null }),
      ]),
      listBody([]),
    ])

    ;(page.onViewAll as () => void)()
    expect(wx.switchTab).toHaveBeenCalledWith({ url: `/${ORDER_LIST_PATH}` })
  })

  it('⚠️ 首页卡只用 home 变体，不出现金额 / 取件层', () => {
    const wxml = stripComments(indexWxml())
    const source = stripComments(indexSource())
    expect(wxml).toContain('<order-card')
    expect(wxml).toContain('variant="home"')
    expect(wxml).toMatch(/<skeleton[^>]*variant="card"/)
    expect(wxml).not.toContain('payOrder')
    expect(wxml).not.toContain('pickup-sheet')
    expect(source).not.toContain('formatMoney')
    expect(source).not.toContain('pickup-sheet')
  })

  it('⚠️ 页面不发 wx.request、不碰 storage、不写路径字面量；订单号不进渲染模型', async () => {
    const source = stripComments(indexSource())
    expect(source).not.toMatch(/wx\.request\b/)
    expect(source).not.toMatch(/wx\.(getStorageSync|setStorageSync|removeStorageSync|getStorage)\b/)
    expect(source).not.toMatch(/url\s*:\s*['"`]\/?pages\//)
    expect(source).toContain('ORDER_LIST_PATH')
    expect(source).toContain('ORDER_DETAIL_PATH')

    const { page } = await enter([
      listBody([order({ id: 1, status: 2, startAt: null, orderNo: '20250401001' })]),
      listBody([]),
    ])
    expect(renderedJson(page)).not.toContain('20250401001')
  })
})

describe('#61 首页 · 文案与路由只有一个家', () => {
  it('⚠️ 导航栏标题留空，但 PAGE_TITLES 仍登记「首页」', () => {
    const wxml = stripComments(indexWxml())
    expect(wxml).toMatch(/<navigation-bar\b[^>]*back="\{\{false\}\}"/)
    expect(wxml).not.toMatch(/<navigation-bar\b[^>]*title=/)
    expect(PAGE_TITLES['pages/index/index']).toBe('首页')
  })

  it('⚠️ 柜机码路径来自 `LOCKER_PATH` 常量，且该页已注册在 app.json', () => {
    const source = stripComments(indexSource())
    // ⚠️ 链路的实现已收进 `utils/scan-locker.ts`（四个扫码入口共用），
    // 所以「路径来自常量」这条断言落在**那个模块**上，页面只断言它确实走链路。
    expect(source).toContain('scanToLocker')
    expect(source).not.toMatch(/url\s*:\s*['"`]\/?pages\//)
    expect(source).not.toMatch(/^\s*const\s+\w*PATH\w*\s*=\s*['"`]pages\//m)

    const scanLocker = stripComments(
      readFileSync(join(repoRoot, 'miniprogram', 'utils', 'scan-locker.ts'), 'utf8'),
    )
    expect(scanLocker).toContain('LOCKER_PATH')
    expect(scanLocker).not.toMatch(/url\s*:\s*['"`]\/?pages\//)

    const appJson = JSON.parse(
      readFileSync(join(repoRoot, 'miniprogram', 'app.json'), 'utf8'),
    ) as { pages: string[] }
    expect(appJson.pages).toContain(LOCKER_PATH)
  })

  it('⚠️ 模板只引用文案变量，没有把品牌 / 按钮 / 提示写成字面量', () => {
    const wxml = stripComments(indexWxml())
    expect(wxml).toContain('{{ wordmark }}')
    expect(wxml).toContain('{{ tagline }}')
    expect(wxml).toContain('{{ scanLabel }}')
    for (const literal of [
      HOME_PAGE_COPY.wordmark,
      HOME_PAGE_COPY.tagline,
      HOME_PAGE_COPY.scanButton,
      SCAN_COPY.notLockerCode,
      SCAN_COPY.scanFailed,
      HOME_PAGE_COPY.ordersTitle,
      HOME_PAGE_COPY.viewAll,
      HOME_PAGE_COPY.ordersLoadFailed,
      HOME_PAGE_COPY.ordersRetry,
      HOME_PAGE_COPY.refreshFailed,
    ]) {
      expect(wxml, `wxml 里出现了文案字面量「${literal}」`).not.toContain(literal)
    }
  })
})

describe('#61 首页 · 硬约束（源码守卫）', () => {
  it('⚠️ 不探测 / 不引导相机权限 —— 不做 `getSetting` / `openSetting` / `authorize`', () => {
    const source = stripComments(indexSource()) + stripComments(indexWxml())
    for (const api of ['getSetting', 'openSetting', 'authorize', 'scope.camera']) {
      expect(source, `首页出现了相机权限探测「${api}」`).not.toContain(api)
    }
    expect(source).not.toContain('相机权限')
  })

  it('⚠️ 页面零 storage —— 源码里一个 storage API 都没有', () => {
    const source = stripComments(indexSource())
    for (const api of ['getStorageSync', 'setStorageSync', 'removeStorageSync', 'getStorage']) {
      expect(source, `index.ts 里出现了 ${api}`).not.toContain(api)
    }
  })

  it('⚠️ 订单区（#67）与附近入口条（#72）同屏接线，互不占位', () => {
    const wxml = stripComments(indexWxml())
    expect(wxml).toContain('<order-card')
    expect(wxml).toContain('variant="home"')
    expect(wxml).toContain('class="home__nearby"')
    expect(wxml).toContain('bindtap="onNearby"')
    expect(wxml).not.toContain('ordersPlaceholder')
  })

  it('⚠️ 附近入口条只指路：无动态数据，点击 switchTab 到 NEARBY_PATH', async () => {
    const wx = installWxStub()
    wx.switchTab.mockImplementation(() => {})
    const def = await loadPage()
    const page = instantiate(def)

    ;(page.onNearby as (() => void) | undefined)?.()

    expect(wx.switchTab).toHaveBeenCalledTimes(1)
    expect(wx.switchTab.mock.calls[0]?.[0]).toMatchObject({ url: `/${NEARBY_PATH}` })
    expect(wx.getLocation).not.toHaveBeenCalled()
    expect(wx.request).not.toHaveBeenCalled()

    const wxml = stripComments(indexWxml())
    expect(wxml).toContain('class="home__nearby"')
    expect(wxml).toContain('{{ nearbyLabel }}')
    expect(wxml).toContain('name="nearby.station"')
    expect(wxml).not.toMatch(/nearby[^>]*(distance|count|余位)/i)
    expect(page.data.nearbyLabel).toBe(HOME_PAGE_COPY.nearbyEntry)
  })

  it('⚠️ 按下反馈只有 0ms 换色：hover-class 换 `$color-primary-pressed`，无 transition / transform / opacity', () => {
    const wxml = stripComments(indexWxml())
    expect(wxml).toContain('hover-class="home__scan_active"')

    const scss = stripComments(indexScss())
    expect(scss).toMatch(/\.home__scan_active[\s\S]*\$color-primary-pressed/)
    expect(scss).not.toMatch(/\btransition(?:-[\w-]+)?\s*:/)
    expect(scss).not.toMatch(/\banimation(?:-[\w-]+)?\s*:/)
    expect(scss).not.toMatch(/@(?:-\w+-)?keyframes/)
    expect(scss).not.toMatch(/\btransform\s*:/)
    expect(scss).not.toMatch(/\bopacity\s*:/)
    expect(scss).not.toMatch(/:active\b/)
  })

  it('⚠️ 品牌图标 / 扫码图标走语义 icon 组件，不引图片资源', () => {
    const wxml = stripComments(indexWxml())
    expect(wxml).toContain('<icon')
    expect(wxml).toContain('name="cell.package"')
    expect(wxml).toContain('name="action.scan"')
    expect(wxml).not.toContain('<image')
  })
})
