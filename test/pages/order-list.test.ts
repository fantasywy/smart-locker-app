// **订单列表页** 的验收 —— ticket #66 / spec #57 §1 + §6 + §14。
//
// 本文件只驱动页面级行为 seam：`Component()` 定义 + 生命周期 + `wx.request` 响应。
// 断言的是：用户看到哪两组、顺序与卡片变体；两条流分页怎么发请求、怎么去重；
// 空 / 骨架 / 首屏失败 / 刷新失败 / 加载更多失败是否互不混淆；以及卡片事件
// 最终把用户带到哪里（详情 / 等待页 / 共享取件层）。
//
// ⚠️ 组件内部（订单卡字段矩阵）由 `test/components/order-card.test.ts` 负责；
// 本文件只验「用了哪个变体、收到事件后去了哪里」。
// ⚠️ 页面**不画支付界面**：已存入 / 已超时只打开 `pickup-sheet`；`13.11` 归组件。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWxStub, jsonResponse, networkFailure } from '../helpers/wx'
import { respondInOrder, sentRequests, urlsOf } from '../helpers/http'
import { BASE_URL } from '../../miniprogram/request/config'
import {
  EMPTY_STATES,
  ORDER_LIST_COPY,
  ORDER_LIST_PATH,
  ORDER_STATUS_LABELS,
  PAGE_TITLES,
} from '../../miniprogram/startup/copy'
import { LOCKER_PATH, ORDER_DETAIL_PATH, WAITING_PATH } from '../../miniprogram/utils/routes'
import type { OrderSummary } from '../../miniprogram/types/orders'
import type { InstalledWxStub } from '../helpers/wx'

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
}))

vi.mock('../../miniprogram/utils/feedback', () => ({
  showToast: mocks.showToast,
}))

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const listDir = join(repoRoot, 'miniprogram', 'pages', 'order-list')
const listSource = (): string =>
  readFileSync(join(listDir, 'order-list.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
const listWxml = (): string =>
  readFileSync(join(listDir, 'order-list.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')

const LIST_URL = `${BASE_URL}/api/app/v1/orders`
const ACTIVE_2 = `${LIST_URL}?status=2&pageSize=20`
const ACTIVE_4 = `${LIST_URL}?status=4&pageSize=20`
const HISTORY_PAGE = (page: number): string => `${LIST_URL}?pageSize=10&page=${page}`

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

interface PageInstance {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  [key: string]: unknown
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

async function loadPage(): Promise<Record<string, unknown>> {
  vi.resetModules()
  await import('../../miniprogram/pages/order-list/order-list')
  if (definition === null) throw new Error('order-list.ts 没有调用 Component()')
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

/** 让挂起的微任务链走完（api → request 是纯 Promise 链；历史流可能连翻多页）。 */
async function settle(): Promise<void> {
  for (let index = 0; index < 40; index += 1) await Promise.resolve()
}

/**
 * 装桩 → 加载页面 → `onShow()`（真实运行时 onShow 是首查入口）。
 *
 * 首查按 `status=2` → `status=4` → 历史页的顺序发请求；历史流为了凑够 10 条
 * 可能连翻数页（由响应编排里的页数决定）。
 */
async function enter(
  responses: readonly ArrangedResponse[],
): Promise<{ wx: InstalledWxStub; page: PageInstance }> {
  const wx = installWxStub()
  wx.navigateTo.mockImplementation(() => {})
  wx.redirectTo.mockImplementation(() => {})
  wx.switchTab.mockImplementation(() => {})
  wx.scanCode.mockImplementation(() => {})
  wx.stopPullDownRefresh.mockImplementation(() => {})
  wx.request.mockImplementation(
    respondInOrder(
      responses.map((response) =>
        typeof response['errMsg'] === 'string'
          ? { errMsg: response['errMsg'] }
          : jsonResponse(response),
      ),
    ),
  )

  const def = await loadPage()
  const page = instantiate(def)
  ;(page.onShow as () => void)()
  await settle()
  return { wx, page }
}

function idsOf(page: PageInstance, key: 'activeOrders' | 'historyOrders'): number[] {
  return (page.data[key] as OrderSummary[]).map((item) => item.id)
}

function renderedJson(page: PageInstance): string {
  return JSON.stringify(page.data)
}

// ---------------------------------------------------------------------------
// 分组 / 排序
// ---------------------------------------------------------------------------

describe('#66 订单列表 · 分组与排序', () => {
  const active2 = [
    order({ id: 10, status: 2, startAt: '2025-04-01T09:00:00+08:00' }),
    order({ id: 20, status: 2, startAt: null }),
    order({ id: 30, status: 2, startAt: '2025-04-01T08:00:00+08:00' }),
  ]
  const active4 = [
    order({ id: 40, status: 4, startAt: '2025-04-01T07:00:00+08:00', endAt: null }),
    // 已补缴取件（4 且 endAt 有值）→ 不进进行中。
    order({ id: 50, status: 4, startAt: '2025-04-01T07:00:00+08:00', endAt: '2025-04-01T08:00:00+08:00' }),
  ]
  // 服务端契约是 id 倒序，但这里刻意打乱：组内排序是本页的职责。
  const history = [
    order({ id: 70, status: 5, endAt: '2025-04-01T10:00:00+08:00' }),
    order({ id: 90, status: 7 }),
    order({ id: 50, status: 4, endAt: '2025-04-01T08:00:00+08:00' }),
    order({ id: 60, status: 3, endAt: '2025-04-01T10:00:00+08:00' }),
    order({ id: 80, status: 6, endAt: '2025-04-01T10:00:00+08:00' }),
    order({ id: 40, status: 4, startAt: '2025-04-01T07:00:00+08:00', endAt: null }),
    order({ id: 10, status: 2, startAt: '2025-04-01T09:00:00+08:00' }),
  ]

  it('⚠️ 进行中：已超时 → 待存入 → 已存入，同档 id 倒序；已补缴取件落已结束', async () => {
    const { page } = await enter([
      listBody(active2, 3),
      listBody(active4, 2),
      listBody(history, 7),
    ])

    // 40（已超时）→ 20（待存入）→ 30 / 10（已存入，id 倒序）
    expect(idsOf(page, 'activeOrders')).toEqual([40, 20, 30, 10])
    // 历史流按 id 倒序；已出现过的 10 / 40 被丢弃，50 是已结束单。
    expect(idsOf(page, 'historyOrders')).toEqual([90, 80, 70, 60, 50])
    expect(page.data.showActiveGroup).toBe(true)
    expect(page.data.showHistoryGroup).toBe(true)
    expect(page.data.isEmpty).toBe(false)
    expect(page.data.activeGroupTitle).toBe(ORDER_LIST_COPY.activeGroup)
    expect(page.data.historyGroupTitle).toBe(ORDER_LIST_COPY.historyGroup)
  })

  it('⚠️ 组标题只在组非空时出现；两组都空才整页空态', async () => {
    const { page } = await enter([
      listBody([], 0),
      listBody([], 0),
      listBody([], 0),
    ])

    expect(page.data.showActiveGroup).toBe(false)
    expect(page.data.showHistoryGroup).toBe(false)
    expect(page.data.isEmpty).toBe(true)
    expect(page.data.emptyTitle).toBe(EMPTY_STATES.orders.title)
    expect(page.data.emptyHint).toBe(EMPTY_STATES.orders.hint)
    expect(page.data.emptyActionLabel).toBe(EMPTY_STATES.orders.actionLabel)
  })

  it('⚠️ 标题来自文案层（页面标题 =「订单」）', async () => {
    const { page } = await enter([listBody([], 0), listBody([], 0), listBody([], 0)])
    expect(page.data.title).toBe(PAGE_TITLES['pages/order-list/order-list'])
    expect(page.data.title).toBe('订单')
  })
})

// ---------------------------------------------------------------------------
// tab / 路径常量
// ---------------------------------------------------------------------------

describe('#66 订单列表 · tab 与路径常量', () => {
  it('⚠️ 订单列表路径常量指向本页，且是 tabBar 的第二项（首页 / 订单 / 附近 / 我的）', () => {
    expect(ORDER_LIST_PATH).toBe('pages/order-list/order-list')
    const appJson = JSON.parse(
      readFileSync(join(repoRoot, 'miniprogram', 'app.json'), 'utf8'),
    ) as { pages: string[]; tabBar: { list: { pagePath: string; text: string }[] } }

    expect(appJson.pages).toContain(ORDER_LIST_PATH)
    expect(appJson.tabBar.list.map((item) => item.text)).toEqual(['首页', '订单', '附近', '我的'])
    expect(appJson.tabBar.list[1]?.pagePath).toBe(ORDER_LIST_PATH)
  })
})

// ---------------------------------------------------------------------------
// 两条流分页
// ---------------------------------------------------------------------------

describe('#66 订单列表 · 两条流分页（零后端改动）', () => {
  it('⚠️ 进行中两条查询各取一页，按契约的 URL 与顺序发出', async () => {
    const { wx } = await enter([listBody([], 0), listBody([], 0), listBody([], 0)])

    expect(urlsOf(sentRequests(wx.request))).toEqual([ACTIVE_2, ACTIVE_4, HISTORY_PAGE(1)])
  })

  it('⚠️ 任一进行中流 total > 20 时出现「还有更多进行中订单」，点击翻该状态的下一页', async () => {
    const page2 = [order({ id: 101, status: 2, startAt: null })]
    const { wx, page } = await enter([
      listBody([order({ id: 100, status: 2, startAt: null })], 21),
      listBody([], 0),
      listBody([], 0),
      listBody(page2, 21),
    ])

    expect(page.data.showMoreActive).toBe(true)
    expect(page.data.moreActiveLabel).toBe(ORDER_LIST_COPY.moreActive)

    ;(page.onMoreActive as () => void)()
    await settle()

    const urls = urlsOf(sentRequests(wx.request))
    expect(urls).toContain(`${ACTIVE_2}&page=2`)
    expect(page.data.showMoreActive).toBe(false)
    expect(idsOf(page, 'activeOrders')).toEqual([101, 100])
  })

  it('⚠️ 两条进行中流都还有更多时，一次点击各翻下一页（不丢另一条流）', async () => {
    const { wx, page } = await enter([
      listBody([], 21),
      listBody([], 21),
      listBody([], 0),
      listBody([order({ id: 201, status: 2, startAt: null })], 21),
      listBody([order({ id: 202, status: 4, startAt: '2025-04-01T09:00:00+08:00', endAt: null })], 21),
    ])

    ;(page.onMoreActive as () => void)()
    await settle()

    const urls = urlsOf(sentRequests(wx.request))
    expect(urls).toContain(`${ACTIVE_2}&page=2`)
    expect(urls).toContain(`${ACTIVE_4}&page=2`)
    expect(idsOf(page, 'activeOrders')).toEqual([202, 201])
  })

  it('⚠️ 历史流跳过已出现在进行中的 id，并可连续翻页凑够 10 条', async () => {
    const active = [
      order({ id: 1, status: 2, startAt: '2025-04-01T09:00:00+08:00' }),
      order({ id: 2, status: 2, startAt: null }),
    ]
    const history1 = Array.from({ length: 10 }, (_, index) =>
      order({ id: 100 - index, status: 3, endAt: '2025-04-01T10:00:00+08:00' }),
    )
    // 第一页里混入两个进行中 id：去掉后只剩 8 条。
    history1[0] = order({ id: 1, status: 2, startAt: '2025-04-01T09:00:00+08:00' })
    history1[1] = order({ id: 2, status: 2, startAt: null })
    const history2 = [
      order({ id: 50, status: 3, endAt: '2025-04-01T10:00:00+08:00' }),
      order({ id: 49, status: 3, endAt: '2025-04-01T10:00:00+08:00' }),
    ]

    const { wx, page } = await enter([
      listBody(active, 2),
      listBody([], 0),
      listBody(history1, 12),
      listBody(history2, 12),
    ])

    const urls = urlsOf(sentRequests(wx.request))
    expect(urls).toContain(HISTORY_PAGE(1))
    expect(urls).toContain(HISTORY_PAGE(2))
    expect(idsOf(page, 'historyOrders')).toEqual([98, 97, 96, 95, 94, 93, 92, 91, 50, 49])
    expect(renderedJson(page)).not.toContain('"total"')
  })

  it('⚠️ 触底只翻历史流，不碰进行中分页', async () => {
    const first = Array.from({ length: 10 }, (_, index) =>
      order({ id: 100 - index, status: 3, endAt: '2025-04-01T10:00:00+08:00' }),
    )
    const second = [order({ id: 80, status: 3, endAt: '2025-04-01T10:00:00+08:00' })]
    const { wx, page } = await enter([
      listBody([order({ id: 1, status: 2, startAt: null })], 21),
      listBody([], 0),
      listBody(first, 20),
      listBody(second, 20),
    ])

    ;(page.onReachBottom as () => void)()
    await settle()

    const urls = urlsOf(sentRequests(wx.request))
    expect(urls).toContain(HISTORY_PAGE(2))
    expect(urls.some((url) => url.includes('page=2') && url.includes('status='))).toBe(false)
    expect(idsOf(page, 'historyOrders')).toEqual([...first.map((row) => row.id), 80])
  })
})

// ---------------------------------------------------------------------------
// 空 / 载 / 错
// ---------------------------------------------------------------------------

describe('#66 订单列表 · 空 / 载 / 错互不混淆', () => {
  it('⚠️ 首屏失败是页内「订单加载失败 / 重试」，不是整页失败出口', async () => {
    const { page } = await enter([
      networkFailure(),
      listBody([], 0),
    ])

    expect(page.data.phase).toBe('loadFailed')
    expect(page.data.loadFailedTitle).toBe(ORDER_LIST_COPY.loadFailed)
    expect(page.data.retryLabel).toBe(ORDER_LIST_COPY.retry)
    expect(listWxml()).not.toContain('failure-exit')
  })

  it('⚠️ 首屏失败后点重试真的重新请求，成功后恢复列表', async () => {
    const { wx, page } = await enter([networkFailure(), listBody([], 0)])
    expect(page.data.phase).toBe('loadFailed')

    wx.request.mockImplementation(
      respondInOrder([jsonResponse(listBody([], 0)), jsonResponse(listBody([], 0)), jsonResponse(listBody([], 0))]),
    )
    ;(page.onRetry as () => void)()
    await settle()

    expect(page.data.phase).toBe('ready')
    expect(page.data.isEmpty).toBe(true)
  })

  it('⚠️ 下拉刷新失败：toast 一句、保留旧数据、转圈结束', async () => {
    const { wx, page } = await enter([
      listBody([order({ id: 1, status: 2, startAt: null })], 1),
      listBody([], 0),
      listBody([], 0),
    ])
    expect(idsOf(page, 'activeOrders')).toEqual([1])

    wx.request.mockImplementation(respondInOrder([networkFailure(), networkFailure()]))
    ;(page.onPullDownRefresh as () => void)()
    await settle()

    expect(mocks.showToast).toHaveBeenCalledWith(ORDER_LIST_COPY.refreshFailed)
    expect(idsOf(page, 'activeOrders')).toEqual([1])
    expect(wx.stopPullDownRefresh).toHaveBeenCalled()
  })

  it('⚠️ onShow 静默刷新失败不打断旧列表、不弹提示', async () => {
    const { wx, page } = await enter([
      listBody([order({ id: 1, status: 2, startAt: null })], 1),
      listBody([], 0),
      listBody([], 0),
    ])

    wx.request.mockImplementation(respondInOrder([networkFailure(), networkFailure()]))
    ;(page.onShow as () => void)()
    await settle()

    expect(mocks.showToast).not.toHaveBeenCalled()
    expect(idsOf(page, 'activeOrders')).toEqual([1])
    expect(page.data.phase).toBe('ready')
  })

  it('⚠️ 加载更多失败：底部「加载失败，点击重试」，已加载项保留；点击重试成功', async () => {
    const first = Array.from({ length: 10 }, (_, index) =>
      order({ id: 100 - index, status: 3, endAt: '2025-04-01T10:00:00+08:00' }),
    )
    const { wx, page } = await enter([
      listBody([], 0),
      listBody([], 0),
      listBody(first, 20),
    ])

    wx.request.mockImplementation(respondInOrder([networkFailure()]))
    ;(page.onReachBottom as () => void)()
    await settle()

    expect(page.data.showLoadMoreFailed).toBe(true)
    expect(page.data.loadMoreFailedLabel).toBe(ORDER_LIST_COPY.loadMoreFailed)
    expect(idsOf(page, 'historyOrders')).toEqual(first.map((row) => row.id))

    wx.request.mockImplementation(
      respondInOrder([jsonResponse(listBody([order({ id: 80, status: 3, endAt: '2025-04-01T10:00:00+08:00' })], 20))]),
    )
    ;(page.onLoadMoreRetry as () => void)()
    await settle()

    expect(page.data.showLoadMoreFailed).toBe(false)
    expect(idsOf(page, 'historyOrders')).toEqual([...first.map((row) => row.id), 80])
  })

  it('⚠️ 空态的主行动跑与首页相同的扫码链路', async () => {
    const { wx, page } = await enter([listBody([], 0), listBody([], 0), listBody([], 0)])
    expect(page.data.showEmptyAction).toBe(true)

    wx.scanCode.mockImplementation((options) => {
      options.success?.({ result: 'https://example.com/l/WD-01' })
    })
    ;(page.onEmptyAction as () => void)()

    expect(wx.navigateTo).toHaveBeenCalledWith({ url: `/${LOCKER_PATH}?code=WD-01` })
  })

  it('⚠️ 非空列表不放常驻扫码入口', async () => {
    const { page } = await enter([
      listBody([order({ id: 1, status: 2, startAt: null })], 1),
      listBody([], 0),
      listBody([], 0),
    ])

    expect(page.data.showEmptyAction).toBe(false)
    expect(listWxml()).not.toContain('order-list__scan')
  })
})

// ---------------------------------------------------------------------------
// 卡片接线
// ---------------------------------------------------------------------------

describe('#66 订单列表 · 卡片接线', () => {
  it('⚠️ 整卡点击 → 订单详情（navigateTo，带 id）', async () => {
    const { wx, page } = await enter([
      listBody([order({ id: 1, status: 2, startAt: null })], 1),
      listBody([], 0),
      listBody([], 0),
    ])

    ;(page.onCardTap as (event: unknown) => void)({ detail: { id: 1 } })

    expect(wx.navigateTo).toHaveBeenCalledWith({ url: `/${ORDER_DETAIL_PATH}?id=1` })
  })

  it('⚠️ 待存入主行动 → 等待页（navigateTo，mode=drop）', async () => {
    const { wx, page } = await enter([
      listBody([order({ id: 1, status: 2, startAt: null })], 1),
      listBody([], 0),
      listBody([], 0),
    ])

    ;(page.onCardAction as (event: unknown) => void)({ detail: { id: 1 } })

    expect(wx.navigateTo).toHaveBeenCalledWith({
      url: `/${WAITING_PATH}?orderId=1&mode=drop`,
    })
  })

  it('⚠️ 已存入主行动 → 打开共享取件层，不自己跳转、不画支付界面', async () => {
    const { wx, page } = await enter([
      listBody(
        [
          order({
            id: 1,
            status: 2,
            startAt: '2025-04-01T09:00:00+08:00',
            estimatedAmount: 1800,
            pickupCode: '385214',
          }),
        ],
        1,
      ),
      listBody([], 0),
      listBody([], 0),
    ])

    ;(page.onCardAction as (event: unknown) => void)({ detail: { id: 1 } })

    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(page.data.pickupOrder).toMatchObject({
      id: 1,
      status: 2,
      startAt: '2025-04-01T09:00:00+08:00',
      endAt: null,
      payAmount: null,
      estimatedAmount: 1800,
      siteName: '万达广场店',
      lockerNo: 'WD-01',
      cellNo: 'S03',
    })
    expect(listSource()).not.toMatch(/payOrder|PICKUP_SHEET_COPY/)
    expect(listWxml()).toContain('<pickup-sheet')
  })

  it('⚠️ 已超时主行动也打开同一个取件层', async () => {
    const { page } = await enter([
      listBody([], 0),
      listBody(
        [
          order({
            id: 2,
            status: 4,
            startAt: '2025-04-01T09:00:00+08:00',
            endAt: null,
            estimatedAmount: 2400,
            pickupCode: '385214',
          }),
        ],
        1,
      ),
      listBody([], 0),
    ])

    ;(page.onCardAction as (event: unknown) => void)({ detail: { id: 2 } })
    expect(page.data.pickupOrder).toMatchObject({ id: 2, status: 4 })
  })

  it('⚠️ 取件成功后从列表进等待页（navigateTo，mode=pickup）；dismiss 清空', async () => {
    const { wx, page } = await enter([
      listBody(
        [order({ id: 1, status: 2, startAt: '2025-04-01T09:00:00+08:00', pickupCode: '385214' })],
        1,
      ),
      listBody([], 0),
      listBody([], 0),
    ])

    ;(page.onCardAction as (event: unknown) => void)({ detail: { id: 1 } })
    ;(page.onPickupSuccess as (event: unknown) => void)({ detail: { orderId: 1 } })

    expect(page.data.pickupOrder).toBe(null)
    expect(wx.navigateTo).toHaveBeenCalledWith({
      url: `/${WAITING_PATH}?orderId=1&mode=pickup`,
    })

    ;(page.onCardAction as (event: unknown) => void)({ detail: { id: 1 } })
    ;(page.onPickupDismiss as () => void)()
    expect(page.data.pickupOrder).toBe(null)
  })

  it('⚠️ 取件层 refresh → 收起并重新加载列表', async () => {
    const { wx, page } = await enter([
      listBody(
        [order({ id: 1, status: 2, startAt: '2025-04-01T09:00:00+08:00', pickupCode: '385214' })],
        1,
      ),
      listBody([], 0),
      listBody([], 0),
    ])

    ;(page.onCardAction as (event: unknown) => void)({ detail: { id: 1 } })
    wx.request.mockImplementation(
      respondInOrder([jsonResponse(listBody([], 0)), jsonResponse(listBody([], 0)), jsonResponse(listBody([], 0))]),
    )
    ;(page.onPickupRefresh as (event: unknown) => void)({ detail: { missing: false } })
    await settle()

    expect(page.data.pickupOrder).toBe(null)
    expect(page.data.isEmpty).toBe(true)
  })

  it('⚠️ 卡片只由列表页声明 active / history 两个变体', () => {
    const wxml = listWxml()
    expect(wxml).toContain('order-card')
    expect(wxml).toContain('variant="active"')
    expect(wxml).toContain('variant="history"')
  })
})

// ---------------------------------------------------------------------------
// 源码守卫
// ---------------------------------------------------------------------------

describe('#66 订单列表 · 源码守卫', () => {
  it('⚠️ 不写跳转路径字面量、不碰 storage、不发 wx.request', () => {
    const source = listSource()
    expect(source).not.toMatch(/url\s*:\s*['"`]\/?pages\//)
    expect(source).not.toMatch(/wx\.(getStorageSync|setStorageSync|removeStorageSync|getStorage)\b/)
    expect(source).not.toMatch(/wx\.request\b/)
  })

  it('⚠️ 不展示订单号 / 支付单号 / 渠道 / 手机号', async () => {
    const { page } = await enter([
      listBody([order({ id: 1, status: 2, startAt: null })], 1),
      listBody([], 0),
      listBody([], 0),
    ])
    const wxml = listWxml()
    expect(wxml).not.toContain('orderNo')
    expect(wxml).not.toContain('payNo')
    expect(wxml).not.toContain('channel')
    expect(wxml).not.toContain('phone')
    // 页面只把卡片需要的子集交给组件，订单号不进入任何渲染模型。
    expect(renderedJson(page)).not.toContain('20250401001')
  })

  it('⚠️ 状态标签仍只有共享表一份', () => {
    expect(Object.values(ORDER_STATUS_LABELS)).toContain('已超时')
  })
})
