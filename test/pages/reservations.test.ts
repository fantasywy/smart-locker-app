// **预约列表与预约创建**的验收 —— ticket #70 / spec #57 §10。
//
// 断言只落在**外部行为**：页面 `data` 画了什么、发出了什么请求、点了去哪。
// `confirm` / `showToast` 通过 `vi.mock` 换掉反馈适配层 —— 本文件验的是
// 「用户看到哪句话」，Vant 内部由 `test/utils/feedback.test.ts` 负责。
//
// ⚠️ 列表的五个状态、两组排序、两个动作的确认与成功路径、`6202` 窗口拒绝、
// 空态 / 失败 / 分页，每一条都有独立用例。**不猜分钟数、不倒计时、不置灰**
// 这三条不靠自觉：下面的 6202 用例会同时断言按钮仍在、动作仍可点。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWxStub, jsonResponse, networkFailure } from '../helpers/wx'
import { requestsTo, respondInOrder, sentRequests } from '../helpers/http'
import type { InstalledWxStub, WxRequestOptions } from '../helpers/wx'
import { installFakeTimers } from '../helpers/timers'
import { BASE_URL } from '../../miniprogram/request/config'
import { RESERVATIONS_PATH } from '../../miniprogram/api/reservations'
import {
  EMPTY_STATES,
  LOCKER_PAGE_COPY,
  PAGE_TITLES,
  PROFILE_COPY,
  RESERVATION_CREATE_COPY,
  RESERVATION_LIST_COPY,
  RESERVATION_STATUS_LABELS,
} from '../../miniprogram/startup/copy'
import {
  ORDER_DETAIL_PATH,
  RESERVATION_LIST_PATH,
  WAITING_PATH,
} from '../../miniprogram/utils/routes'

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  confirm: vi.fn(),
  alert: vi.fn(),
}))

vi.mock('../../miniprogram/utils/feedback', () => ({
  showToast: mocks.showToast,
  confirm: mocks.confirm,
  alert: mocks.alert,
}))

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

/** 剥掉注释后的源码 —— 结构断言读它（注释里讨论契约与不展示项是必要的）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const pageSource = (name: string): string =>
  stripComments(readFileSync(join(repoRoot, 'miniprogram', 'pages', name, `${name}.ts`), 'utf8'))
const pageWxml = (name: string): string =>
  stripComments(readFileSync(join(repoRoot, 'miniprogram', 'pages', name, `${name}.wxml`), 'utf8'))

/** 一份契约形状的 `13.13` 行。 */
function reservation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 301,
    resvNo: 'R20250401001',
    lockerId: 11,
    lockerNo: 'WD-01',
    siteName: '万达广场店',
    cellNo: 'M05',
    cellType: 2,
    planStartAt: '2026-09-23T14:00:00+08:00',
    planEndAt: '2026-09-23T16:00:00+08:00',
    actualStartAt: null,
    status: 1,
    orderId: null,
    ...overrides,
  }
}

function listBody(
  items: readonly Record<string, unknown>[],
  total = items.length,
): ReturnType<typeof jsonResponse> {
  return jsonResponse({ code: 0, message: 'ok', data: { list: items, total } })
}

function okBody(data: unknown): ReturnType<typeof jsonResponse> {
  return jsonResponse({ code: 0, message: 'ok', data })
}

let definition: Record<string, unknown> | null = null

beforeEach(() => {
  definition = null
  mocks.showToast.mockReset()
  mocks.confirm.mockReset()
  mocks.alert.mockReset()
  mocks.confirm.mockResolvedValue(true)
  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (def: Record<string, unknown>): void => {
    definition = def
  }
})

interface PageInstance {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  triggerEvent: (name: string) => void
  onShow?: () => void
  onLoad?: (options: Record<string, string | undefined>) => void
  onReachBottom?: () => void
  onRetry?: () => void
  onStartUse?: (event: { currentTarget: { dataset: Record<string, unknown> } }) => void
  onCancel?: (event: { currentTarget: { dataset: Record<string, unknown> } }) => void
  onViewOrder?: (event: { currentTarget: { dataset: Record<string, unknown> } }) => void
  onScan?: () => void
  onSelectCellType?: (event: { currentTarget: { dataset: Record<string, unknown> } }) => void
  onSelectDate?: (event: { currentTarget: { dataset: Record<string, unknown> } }) => void
  onSelectSlot?: (event: { currentTarget: { dataset: Record<string, unknown> } }) => void
  onSelectDuration?: (event: { currentTarget: { dataset: Record<string, unknown> } }) => void
  onSubmit?: () => void
  [name: string]: unknown
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

async function loadPage(
  name: 'reservation-list' | 'reservation-create',
): Promise<Record<string, unknown>> {
  vi.resetModules()
  if (name === 'reservation-list') {
    await import('../../miniprogram/pages/reservation-list/reservation-list')
  } else {
    await import('../../miniprogram/pages/reservation-create/reservation-create')
  }
  if (definition === null) throw new Error(`${name}.ts 没有调用 Component()`)
  return definition
}

/** 让挂起的微任务链走完（读取 / 动作 / 刷新都是纯微任务驱动的）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 32; i += 1) await Promise.resolve()
}

interface GroupView {
  key: string
  title: string
  cards: CardView[]
}

interface CardView {
  id: number
  siteName: string
  lockerNo: string
  cellText: string
  timeRange: string
  statusLabel: string
  statusTone: string
  note: string
  showNote: boolean
  showStart: boolean
  showCancel: boolean
  showViewOrder: boolean
}

function groupsOf(page: PageInstance): GroupView[] {
  return (page.data.groups as GroupView[] | undefined) ?? []
}

function cardsOf(page: PageInstance): CardView[] {
  return groupsOf(page).flatMap((group) => group.cards)
}

async function mountList(
  responses: Parameters<typeof respondInOrder>[0],
): Promise<{ wx: InstalledWxStub; page: PageInstance }> {
  const wx = installWxStub()
  wx.request.mockImplementation(respondInOrder(responses))
  wx.redirectTo.mockImplementation(() => {})
  wx.navigateTo.mockImplementation(() => {})
  const def = await loadPage('reservation-list')
  const page = instantiate(def)
  page.onShow?.()
  await settle()
  return { wx, page }
}

/** 指向 `13.13` 的请求。 */
function listRequests(wx: InstalledWxStub): ReturnType<typeof sentRequests> {
  return requestsTo(sentRequests(wx.request), `${BASE_URL}${RESERVATIONS_PATH}?page=1&pageSize=10`)
}

describe('#70 我的预约 · 五状态与分组', () => {
  it('五个状态标签逐字，色档：PENDING ok / NOSHOW danger / 其余 muted', async () => {
    const { page } = await mountList([
      listBody([
        reservation({ id: 1, status: 1 }),
        reservation({ id: 2, status: 2, orderId: 2002 }),
        reservation({ id: 3, status: 3 }),
        reservation({ id: 4, status: 4 }),
        reservation({ id: 5, status: 5 }),
      ]),
    ])

    const cards = cardsOf(page)
    expect(cards.map((card) => card.statusLabel)).toEqual([
      RESERVATION_LIST_COPY.groupPending,
      RESERVATION_STATUS_LABELS.used,
      RESERVATION_STATUS_LABELS.cancelled,
      RESERVATION_STATUS_LABELS.noshow,
      RESERVATION_STATUS_LABELS.expired,
    ])
    expect(cards.map((card) => card.statusTone)).toEqual(['ok', 'muted', 'muted', 'danger', 'muted'])
    // 标签逐字（spec §10 五句）。
    expect(RESERVATION_STATUS_LABELS).toEqual({
      pending: '待使用',
      used: '已使用',
      cancelled: '已取消',
      noshow: '已爽约',
      expired: '已失效',
    })
  })

  it('两组：待使用 planStartAt 升序 / 已结束 planStartAt 降序；组头只在非空时出现', async () => {
    const { page } = await mountList([
      listBody([
        reservation({ id: 1, status: 1, planStartAt: '2026-09-25T10:00:00+08:00' }),
        reservation({ id: 2, status: 1, planStartAt: '2026-09-23T09:00:00+08:00' }),
        reservation({ id: 3, status: 2, planStartAt: '2026-09-22T10:00:00+08:00' }),
        reservation({ id: 4, status: 3, planStartAt: '2026-09-26T10:00:00+08:00' }),
        reservation({ id: 5, status: 4, planStartAt: '2026-09-21T10:00:00+08:00' }),
      ]),
    ])

    const groups = groupsOf(page)
    expect(groups.map((group) => group.key)).toEqual(['pending', 'ended'])
    expect(groups.map((group) => group.title)).toEqual(['待使用', '已结束'])
    expect(groups[0]?.cards.map((card) => card.id)).toEqual([2, 1])
    expect(groups[1]?.cards.map((card) => card.id)).toEqual([4, 3, 5])
  })

  it('只有一种组时另一组不出现 —— 空组不画组头', async () => {
    const { page } = await mountList([listBody([reservation({ id: 1, status: 1 })])])

    expect(groupsOf(page).map((group) => group.key)).toEqual(['pending'])
  })

  it('卡片字段：站点名 / 柜机码 / 档名 + cellNo / 时段（同日只写一次日期）', async () => {
    const { page } = await mountList([listBody([reservation()])])

    const [card] = cardsOf(page)
    expect(card?.siteName).toBe('万达广场店')
    expect(card?.lockerNo).toBe('WD-01')
    expect(card?.cellText).toBe('中格口 · M05')
    expect(card?.timeRange).toBe('09-23 14:00 – 16:00')
  })

  it('跨天时段重复日期 —— 不写成看起来已经过去的时刻', async () => {
    const { page } = await mountList([
      listBody([
        reservation({
          planStartAt: '2026-09-23T23:00:00+08:00',
          planEndAt: '2026-09-24T01:00:00+08:00',
        }),
      ]),
    ])

    expect(cardsOf(page)[0]?.timeRange).toBe('09-23 23:00 – 09-24 01:00')
  })
})

describe('#70 我的预约 · 状态动作与说明', () => {
  it('待使用：开始使用 / 取消预约两个动作都在；USED 有 orderId → 查看订单', async () => {
    const { page } = await mountList([
      listBody([
        reservation({ id: 1, status: 1 }),
        reservation({ id: 2, status: 2, orderId: 2002 }),
      ]),
    ])

    const cards = cardsOf(page)
    expect(cards[0]?.showStart).toBe(true)
    expect(cards[0]?.showCancel).toBe(true)
    expect(cards[0]?.showViewOrder).toBe(false)
    expect(cards[1]?.showStart).toBe(false)
    expect(cards[1]?.showCancel).toBe(false)
    expect(cards[1]?.showViewOrder).toBe(true)
    expect(page.data.startActionLabel).toBe(RESERVATION_LIST_COPY.startAction)
    expect(page.data.cancelActionLabel).toBe(RESERVATION_LIST_COPY.cancelAction)
    expect(page.data.viewOrderLabel).toBe(RESERVATION_LIST_COPY.viewOrderAction)
  })

  it('USED 无 orderId：不出现「查看订单」—— 没有订单可去就不造假入口', async () => {
    const { page } = await mountList([
      listBody([reservation({ id: 2, status: 2, orderId: null })]),
    ])

    expect(cardsOf(page)[0]?.showViewOrder).toBe(false)
  })

  it('NOSHOW / EXPIRED 的卡内说明不同；CANCELLED 无说明无动作', async () => {
    const { page } = await mountList([
      listBody([
        reservation({ id: 4, status: 4 }),
        reservation({ id: 5, status: 5 }),
        reservation({ id: 3, status: 3 }),
      ]),
    ])

    const [noshow, expired, cancelled] = cardsOf(page)
    expect(noshow?.note).toBe(RESERVATION_LIST_COPY.noshowNote)
    expect(noshow?.showNote).toBe(true)
    expect(expired?.note).toBe(RESERVATION_LIST_COPY.expiredNote)
    expect(expired?.showNote).toBe(true)
    // 两句必须不同 —— 爽约是用户责任（已扣分），失效是柜机责任（不扣分）。
    expect(noshow?.note).not.toBe(expired?.note)
    expect(cancelled?.showNote).toBe(false)
    expect(cancelled?.showStart).toBe(false)
    expect(cancelled?.showCancel).toBe(false)
    expect(cancelled?.showViewOrder).toBe(false)
  })

  it('查看订单 → navigateTo 订单详情，带订单 ID（参数名是 id）', async () => {
    const { wx, page } = await mountList([
      listBody([reservation({ id: 2, status: 2, orderId: 2002 })]),
    ])

    page.onViewOrder?.({ currentTarget: { dataset: { id: 2002 } } })

    expect(wx.navigateTo.mock.calls.map((call) => (call[0] as { url: string }).url)).toEqual([
      `/${ORDER_DETAIL_PATH}?id=2002`,
    ])
  })
})

describe('#70 我的预约 · 开始使用', () => {
  it('二次确认逐字 → 13.15 → redirectTo 等待页（orderId + mode=drop）', async () => {
    const { wx, page } = await mountList([
      listBody([reservation({ id: 301 })]),
      okBody({ orderId: 2002, orderNo: '20250401002', cellNo: 'M05' }),
    ])

    page.onStartUse?.({ currentTarget: { dataset: { id: 301 } } })
    await settle()

    expect(mocks.confirm).toHaveBeenCalledWith({
      title: '开始使用？',
      message: '开始使用后会生成存件订单，柜门将打开；预约不可恢复。',
      cancelText: '取消',
      confirmText: '开始使用',
    })
    const useRequests = requestsTo(
      sentRequests(wx.request),
      `${BASE_URL}${RESERVATIONS_PATH}/301/use`,
    )
    expect(useRequests).toHaveLength(1)
    expect(useRequests[0]?.method).toBe('POST')
    expect(wx.redirectTo.mock.calls.map((call) => (call[0] as { url: string }).url)).toEqual([
      `/${WAITING_PATH}?orderId=2002&mode=drop`,
    ])
  })

  it('取消确认 → 不调 13.15', async () => {
    mocks.confirm.mockResolvedValue(false)
    const wx = installWxStub()
    wx.request.mockImplementation(respondInOrder([listBody([reservation({ id: 301 })])]))
    const def = await loadPage('reservation-list')
    const page = instantiate(def)
    page.onShow?.()
    await settle()

    page.onStartUse?.({ currentTarget: { dataset: { id: 301 } } })
    await settle()

    expect(requestsTo(sentRequests(wx.request), `${BASE_URL}${RESERVATIONS_PATH}/301/use`)).toHaveLength(0)
  })

  it('6202：动作点提示逐字 + 刷新；不猜分钟数、不置灰、不倒计时', async () => {
    const { wx, page } = await mountList([
      listBody([reservation({ id: 301 })]),
      jsonResponse({ code: 6202, message: '当前不在使用窗口内', data: null }),
      listBody([reservation({ id: 301 })]),
    ])

    page.onStartUse?.({ currentTarget: { dataset: { id: 301 } } })
    await settle()

    expect(mocks.showToast).toHaveBeenCalledWith(
      RESERVATION_LIST_COPY.windowRejected,
    )
    expect(listRequests(wx)).toHaveLength(2)
    // 按钮仍在、仍可点；页面 data 里没有任何窗口端点 / 分钟数。
    expect(cardsOf(page)[0]?.showStart).toBe(true)
    expect(page.data).not.toHaveProperty('holdMinutes')
    expect(page.data).not.toHaveProperty('noShowMinutes')
    expect(JSON.stringify(page.data)).not.toMatch(/分钟/)
  })

  it('按钮在窗口外也不 disabled —— 源码里没有按窗口置灰的分支', async () => {
    const source = pageSource('reservation-list')
    expect(source).not.toMatch(/holdMinutes|noShowMinutes|countdown|倒计时/)
    expect(pageWxml('reservation-list')).not.toMatch(/start[^\n]*disabled/)
  })
})

describe('#70 我的预约 · 取消预约', () => {
  it('二次确认逐字 → 13.14 → 刷新列表', async () => {
    const { wx, page } = await mountList([
      listBody([reservation({ id: 301 })]),
      okBody(null),
      listBody([reservation({ id: 301, status: 3 })]),
    ])

    page.onCancel?.({ currentTarget: { dataset: { id: 301 } } })
    await settle()

    expect(mocks.confirm).toHaveBeenCalledWith({
      title: '取消预约？',
      message: '取消后格口会被释放，预约不可恢复。',
      cancelText: '再想想',
      confirmText: '取消预约',
    })
    const cancelRequests = requestsTo(
      sentRequests(wx.request),
      `${BASE_URL}${RESERVATIONS_PATH}/301/cancel`,
    )
    expect(cancelRequests).toHaveLength(1)
    expect(cancelRequests[0]?.method).toBe('POST')
    expect(listRequests(wx)).toHaveLength(2)
    expect(cardsOf(page)[0]?.statusLabel).toBe('已取消')
  })
})

describe('#70 我的预约 · 空态 / 失败 / 分页', () => {
  it('空列表 → 复用预约空态（标题 / 说明 / 出口文案逐字）', async () => {
    const { page } = await mountList([listBody([], 0)])

    expect(page.data.isEmpty).toBe(true)
    expect(page.data.emptyTitle).toBe(EMPTY_STATES.reservations.title)
    expect(page.data.emptyHint).toBe(EMPTY_STATES.reservations.hint)
    expect(page.data.emptyActionLabel).toBe(EMPTY_STATES.reservations.actionLabel)
    expect(pageWxml('reservation-list')).toContain('<empty-state')
  })

  it('首屏失败 → 页内「加载失败，请重试」+ 重试真的重发', async () => {
    const { wx, page } = await mountList([
      networkFailure(),
      listBody([reservation({ id: 301 })]),
    ])

    expect(page.data.phase).toBe('failed')
    expect(page.data.loadFailed).toBe('加载失败，请重试')

    page.onRetry?.()
    await settle()

    expect(page.data.phase).toBe('ready')
    expect(cardsOf(page)).toHaveLength(1)
    expect(listRequests(wx)).toHaveLength(2)
  })

  it('每页 10 条、触底追加下一页；重复 id 去重', async () => {
    const firstPage = Array.from({ length: 10 }, (_, index) =>
      reservation({ id: 300 + index, planStartAt: `2026-09-${String(10 + index).padStart(2, '0')}T10:00:00+08:00` }),
    )
    const { wx, page } = await mountList([
      listBody(firstPage, 12),
      listBody([reservation({ id: 309, planStartAt: '2026-09-19T10:00:00+08:00' }), reservation({ id: 310 })], 12),
    ])

    page.onReachBottom?.()
    await settle()

    const urls = sentRequests(wx.request).map((request) => request.url)
    expect(urls).toEqual([
      `${BASE_URL}${RESERVATIONS_PATH}?page=1&pageSize=10`,
      `${BASE_URL}${RESERVATIONS_PATH}?page=2&pageSize=10`,
    ])
    expect(cardsOf(page)).toHaveLength(11)
    expect(new Set(cardsOf(page).map((card) => card.id)).size).toBe(11)
  })
})

describe('#70 我的预约 · 工程约束', () => {
  it('标题来自 copy、二级页有返回箭头、零 storage、零路径字面量', async () => {
    const pageDef = await loadPage('reservation-list')
    expect((pageDef.data as Record<string, unknown>).title).toBe(
      PAGE_TITLES['pages/reservation-list/reservation-list'],
    )
    expect(pageWxml('reservation-list')).toMatch(/<navigation-bar[^>]*back="\{\{true\}\}"/)

    const source = pageSource('reservation-list')
    expect(source).not.toMatch(/getStorageSync|setStorageSync|removeStorageSync|getStorage/)
    expect(source).not.toMatch(/url:\s*['"`]\/?pages\//)
  })
})

// ---------------------------------------------------------------------------
// 预约创建页
// ---------------------------------------------------------------------------

interface SlotOption {
  value: string
  label: string
}

interface DurationOption {
  hours: number
  label: string
}

function slotOptionsOf(page: PageInstance): SlotOption[] {
  return (page.data.slotOptions as SlotOption[] | undefined) ?? []
}

function durationOptionsOf(page: PageInstance): DurationOption[] {
  return (page.data.durationOptions as DurationOption[] | undefined) ?? []
}

function eventOf(value: string | number): { currentTarget: { dataset: Record<string, unknown> } } {
  return { currentTarget: { dataset: { value } } }
}

/** 默认「现在」—— 2026-09-23 13:10 本地时间，今天的下一个档位是 13:30。 */
function defaultNow(): Date {
  return new Date(2026, 8, 23, 13, 10, 0, 0)
}

async function mountCreate(
  responses: Parameters<typeof respondInOrder>[0],
  options: Record<string, string | undefined> = { lockerId: '11' },
  now: Date = defaultNow(),
): Promise<{ wx: InstalledWxStub; page: PageInstance }> {
  const timers = installFakeTimers()
  timers.setNow(now.getTime())
  const wx = installWxStub()
  wx.request.mockImplementation(respondInOrder(responses))
  wx.redirectTo.mockImplementation(() => {})
  const def = await loadPage('reservation-create')
  const page = instantiate(def)
  page.onLoad?.(options)
  await settle()
  return { wx, page }
}

/** 选齐三项 —— 档位 / 开始档位 / 时长。 */
function selectAll(
  page: PageInstance,
  cellType = 2,
  slotLabel = '14:00',
  hours = 2,
): void {
  page.onSelectCellType?.(eventOf(cellType))
  const slot = slotOptionsOf(page).find((option) => option.label === slotLabel)
  if (slot === undefined) throw new Error(`测试时段里没有 ${slotLabel}`)
  page.onSelectSlot?.(eventOf(slot.value))
  page.onSelectDuration?.(eventOf(hours))
}

describe('#70 预约创建 · 结构与字段', () => {
  it('唯一入口带 lockerId；四档档名来自文案层；初始不发任何请求', async () => {
    const { wx, page } = await mountCreate([])

    expect(page.data.title).toBe(PAGE_TITLES['pages/reservation-create/reservation-create'])
    expect(page.data.invalidEntry).toBe(false)
    expect(page.data.cellTypeOptions).toEqual([
      { value: 1, label: LOCKER_PAGE_COPY.cellTypeLabels[1] },
      { value: 2, label: LOCKER_PAGE_COPY.cellTypeLabels[2] },
      { value: 3, label: LOCKER_PAGE_COPY.cellTypeLabels[3] },
      { value: 4, label: LOCKER_PAGE_COPY.cellTypeLabels[4] },
    ])
    expect(wx.request).not.toHaveBeenCalled()
  })

  it('开始档位：30 分钟步长、只渲染未来档位；档位值是「无偏移本地 ISO」', async () => {
    const { page } = await mountCreate([])

    const slots = slotOptionsOf(page)
    expect(slots[0]?.label).toBe('13:30')
    expect(slots.some((slot) => slot.label === '13:00')).toBe(false)
    // 请求口径：无偏移本地 ISO（响应才带 +08:00）—— 不是契约示例里的带偏移串。
    expect(slots.every((slot) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(slot.value))).toBe(true)
    expect(slots[0]?.value).toBe('2026-09-23T13:30:00')
  })

  it('时长档位：1 / 2 / 4 / 8 小时（单位写「小时」，不用 h）', async () => {
    const { page } = await mountCreate([])

    expect(durationOptionsOf(page).map((option) => option.label)).toEqual([
      '1小时',
      '2小时',
      '4小时',
      '8小时',
    ])
  })

  it('今天档位已过完 → 说明指向明天；切到明天拿到整天的档位', async () => {
    const { page } = await mountCreate([], { lockerId: '11' }, new Date(2026, 8, 23, 23, 40))

    expect(slotOptionsOf(page)).toHaveLength(0)
    expect(page.data.showEmptySlotHint).toBe(true)
    expect(page.data.emptySlotHint).toBe(RESERVATION_CREATE_COPY.noSlotsToday)

    page.onSelectDate?.(eventOf(1))
    await settle()

    const tomorrow = slotOptionsOf(page)
    expect(tomorrow).toHaveLength(48)
    expect(tomorrow[0]?.label).toBe('00:00')
    expect(tomorrow[tomorrow.length - 1]?.label).toBe('23:30')
    expect(page.data.showEmptySlotHint).toBe(false)
    expect(page.data.selectedSlot).toBe('')
  })
})

describe('#70 预约创建 · 校验与提交', () => {
  it('缺 lockerId → 拒绝提交，不发请求', async () => {
    const { wx, page } = await mountCreate([], {})

    expect(page.data.invalidEntry).toBe(true)
    expect(page.data.entryHint).toBe(RESERVATION_CREATE_COPY.invalidEntry)

    page.onSubmit?.()
    await settle()

    expect(wx.request).not.toHaveBeenCalled()
    expect(wx.redirectTo).not.toHaveBeenCalled()
  })

  it('三项没选齐 → 本地校验，不发请求', async () => {
    const { wx, page } = await mountCreate([])

    page.onSubmit?.()
    await settle()
    expect(page.data.submitError).toBe(RESERVATION_CREATE_COPY.selectRequired)
    expect(wx.request).not.toHaveBeenCalled()

    page.onSelectCellType?.(eventOf(2))
    page.onSubmit?.()
    await settle()
    expect(page.data.submitError).toBe(RESERVATION_CREATE_COPY.selectRequired)
    expect(wx.request).not.toHaveBeenCalled()
  })

  it('选齐后提交：13.12 请求体恰好四字段（cellType 数字码 + 本地时段）→ 回预约列表', async () => {
    const { wx, page } = await mountCreate([
      okBody({ reservationId: 301, resvNo: 'R20250401001', cellNo: 'M05' }),
    ])

    selectAll(page, 2, '14:00', 2)
    page.onSubmit?.()
    await settle()

    const [sent] = sentRequests(wx.request)
    expect(sent?.url).toBe(`${BASE_URL}${RESERVATIONS_PATH}`)
    expect(sent?.method).toBe('POST')
    expect(sent?.data).toEqual({
      lockerId: 11,
      cellType: 2,
      planStartAt: '2026-09-23T14:00:00',
      planEndAt: '2026-09-23T16:00:00',
    })
    expect(wx.redirectTo.mock.calls.map((call) => (call[0] as { url: string }).url)).toEqual([
      `/${RESERVATION_LIST_PATH}`,
    ])
  })

  it('提交中防重复：连点两次只发一次 13.12', async () => {
    const timers = installFakeTimers()
    timers.setNow(defaultNow().getTime())
    const wx = installWxStub()
    let pending: WxRequestOptions | undefined
    wx.request.mockImplementation((options) => {
      pending = options
    })
    wx.redirectTo.mockImplementation(() => {})
    const def = await loadPage('reservation-create')
    const page = instantiate(def)
    page.onLoad?.({ lockerId: '11' })
    await settle()
    selectAll(page)

    page.onSubmit?.()
    page.onSubmit?.()
    await settle()

    expect(wx.request).toHaveBeenCalledTimes(1)
    pending?.success?.(
      jsonResponse({
        code: 0,
        message: 'ok',
        data: { reservationId: 301, resvNo: 'R20250401001', cellNo: 'M05' },
      }),
    )
    await settle()
    expect(wx.redirectTo).toHaveBeenCalledTimes(1)
  })

  it('提交中按钮禁用（technical debounce），避免连点造出第二条预约', async () => {
    const { page } = await mountCreate([])
    page.onSelectCellType?.(eventOf(2))
    expect(page.data.submitting).toBe(false)
    // 源码层：按钮的 disabled 只由 submitting 驱动，不由状态 / 时间驱动。
    expect(pageWxml('reservation-create')).toMatch(/disabled="\{\{ submitting \}\}"/)
  })

  it('8002 无空闲格口 → 动作点就地解释（不弹 toast、不跳转）', async () => {
    const { wx, page } = await mountCreate([
      jsonResponse({ code: 8002, message: '无空闲格口', data: null }),
    ])

    selectAll(page)
    page.onSubmit?.()
    await settle()

    expect(page.data.submitError).toBe(RESERVATION_CREATE_COPY.cellTypeFull)
    expect(page.data.submitting).toBe(false)
    expect(wx.redirectTo).not.toHaveBeenCalled()
  })

  it('8007 同时段已有预约 → 定稿文案就地解释', async () => {
    const { page } = await mountCreate([
      jsonResponse({ code: 8007, message: '已有预约', data: null }),
    ])

    selectAll(page)
    page.onSubmit?.()
    await settle()

    expect(page.data.submitError).toBe(RESERVATION_CREATE_COPY.duplicate)
  })

  it('5004 受限 → 统一受限说明，不展示服务端 message', async () => {
    const { page } = await mountCreate([
      jsonResponse({ code: 5004, message: '黑名单用户', data: null }),
    ])

    selectAll(page)
    page.onSubmit?.()
    await settle()

    expect(page.data.submitError).toBe(PROFILE_COPY.restrictedBody)
    expect(page.data.submitError).not.toContain('黑名单')
  })

  it('下单前不显示金额：页面 data 与模板都没有价格字段 / ¥', async () => {
    const { page } = await mountCreate([])

    expect(JSON.stringify(page.data)).not.toMatch(/¥|金额|价格|estimatedAmount|payAmount/)
    expect(pageWxml('reservation-create')).not.toMatch(/¥|金额|价格|estimatedAmount|payAmount/)
  })
})

describe('#70 预约创建 · 工程约束', () => {
  it('二级页有返回箭头、零 storage、零路径字面量；标题来自 copy', async () => {
    const def = await loadPage('reservation-create')
    expect((def.data as Record<string, unknown>).title).toBe(
      PAGE_TITLES['pages/reservation-create/reservation-create'],
    )
    expect(pageWxml('reservation-create')).toMatch(/<navigation-bar[^>]*back="\{\{true\}\}"/)

    const source = pageSource('reservation-create')
    expect(source).not.toMatch(/getStorageSync|setStorageSync|removeStorageSync|getStorage/)
    expect(source).not.toMatch(/url:\s*['"`]\/?pages\//)
  })
})
