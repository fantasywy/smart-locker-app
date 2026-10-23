// **订单详情页** 的验收 —— ticket #64 / spec #57 §7 + §14。
//
// ## 这个文件挡的是什么
//
// 详情页最容易「看起来能跑」的错：
//   • 未支付却画出一张明细表（`baseFee` 此时是 `null`，画出来就是凭空造账）；
//   • 金额用「应付 / 预估 / 已付清」—— 金额四词各有唯一说法；
//   • 时间轴直接用后端的 `title` —— 那是第二文案源，换一版后端就换一套话；
//   • 支付记录把支付单号 / 渠道 / 状态画上屏；
//   • `3001` 与 `8003` 分成两种说法（用户对成因无能为力，只会多一层猜疑）；
//   • 从等待页 / 支付层返回后不刷新 —— 用户看到的是离开前的旧状态；
//   • 历史单还挂着一个假的取件按钮，或待存入不给取消。
//
// ⇒ 断言一律落在**外部行为**：页面 `data`（界面画了什么）、`wx.*` 调用（跳转去了哪）、
// 请求（GET/POST、URL、顺序）。`showToast` / `confirm` / `alert` 用 `vi.mock`
// 换掉反馈适配层：本文件验的是「页面让用户看到哪句话」，Vant 内部由
// `test/utils/feedback.test.ts` 负责。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWxStub, jsonResponse } from '../helpers/wx'
import { requestsTo, respondInOrder, sentRequests } from '../helpers/http'
import { BASE_URL } from '../../miniprogram/request/config'
import {
  HOME_PAGE_COPY,
  ORDER_CANCEL_COPY,
  ORDER_COPY,
  ORDER_LIST_PATH,
  ORDER_STATUS_LABELS,
  PAGE_TITLES,
  PICKUP_SHEET_COPY,
  RETRY_LABEL,
} from '../../miniprogram/startup/copy'
import { LOCKER_PATH, WAITING_PATH } from '../../miniprogram/utils/routes'
import type { InstalledWxStub } from '../helpers/wx'

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
const detailDir = join(repoRoot, 'miniprogram', 'pages', 'order-detail')
const detailSource = (): string =>
  readFileSync(join(detailDir, 'order-detail.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
const detailWxml = (): string =>
  readFileSync(join(detailDir, 'order-detail.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
const ORDER_ID = 1001
const DETAIL_URL = `${BASE_URL}/api/app/v1/orders/${ORDER_ID}`
const CANCEL_URL = `${DETAIL_URL}/cancel`

/** 一份契约形状的 `13.9` 响应体 —— 默认是「存入等待」（status=2 / startAt=null）。 */
function detailBody(
  orderOverrides: Record<string, unknown> = {},
  responseOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    code: 0,
    message: 'ok',
    data: {
      order: {
        id: ORDER_ID,
        orderNo: '20250401001',
        status: 2,
        baseFee: null,
        overtimeFee: null,
        discount: null,
        payAmount: null,
        startAt: null,
        endAt: null,
        estimatedAmount: 1800,
        pickupCode: null,
        ...orderOverrides,
      },
      locker: {
        id: 11,
        lockerNo: 'WD-01',
        siteName: '万达广场店',
        cellNo: 'S03',
        cellType: 2,
      },
      timeline: [{ event: 'CREATED', title: '后端标题', at: '2025-04-01T09:00:00+08:00' }],
      payments: [],
      ...responseOverrides,
    },
  }
}

/** 已存入未支付：有取件码、有存入时间、有参考金额。 */
function storedBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return detailBody({
    status: 2,
    startAt: '2025-04-01T09:00:00+08:00',
    pickupCode: '385214',
    ...overrides,
  })
}

/** 首笔已支付：费用三项已定格。 */
function paidBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return detailBody({
    status: 2,
    startAt: '2025-04-01T09:00:00+08:00',
    pickupCode: '385214',
    baseFee: 1500,
    overtimeFee: 600,
    discount: 300,
    payAmount: 1800,
    estimatedAmount: null,
    ...overrides,
  })
}

/** 已完成（历史单）：有取件时间、无取件码。 */
function completedBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return detailBody({
    status: 3,
    startAt: '2025-04-01T09:00:00+08:00',
    endAt: '2025-04-01T10:30:00+08:00',
    baseFee: 1500,
    overtimeFee: 0,
    discount: 0,
    payAmount: 1500,
    estimatedAmount: null,
    ...overrides,
  })
}

function businessError(code: number): Record<string, unknown> {
  return { code, message: 'boom', data: null }
}

type ArrangedResponse = Record<string, unknown> | { errMsg: string }

let definition: Record<string, unknown> | null = null

beforeEach(() => {
  definition = null
  mocks.showToast.mockReset()
  mocks.confirm.mockReset()
  mocks.alert.mockReset()
  mocks.confirm.mockResolvedValue(true)
  mocks.alert.mockResolvedValue(undefined)

  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (def: Record<string, unknown>): void => {
    definition = def
  }
})

interface PageInstance {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  triggerEvent: (name: string) => void
  [key: string]: unknown
}

async function loadPage(): Promise<Record<string, unknown>> {
  vi.resetModules()
  await import('../../miniprogram/pages/order-detail/order-detail')
  if (definition === null) throw new Error('order-detail.ts 没有调用 Component()')
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
  if (typeof instance.onLoad !== 'function') {
    throw new Error('order-detail.ts 没有可调用的 onLoad —— 页面参数无处可去')
  }
  return instance
}

/**
 * 装桩 → 加载页面 → `onLoad({id})` → 首查（真实运行时 onLoad 后紧跟 onShow）。
 *
 * ⚠️ 页面首查由 `onShow` 驱动，所以这里复现真实顺序；后续再调 `onShow` 就是
 * 「从等待页 / 支付层回来」的静默刷新。
 */
async function enter(
  options: Record<string, string>,
  responses: readonly ArrangedResponse[],
): Promise<{ wx: InstalledWxStub; page: PageInstance }> {
  const wx = installWxStub()
  wx.switchTab.mockImplementation(() => {})
  wx.redirectTo.mockImplementation(() => {})
  wx.navigateTo.mockImplementation(() => {})
  wx.scanCode.mockImplementation(() => {})
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
  ;(page.onLoad as (options: Record<string, string>) => void)(options)
  ;(page.onShow as () => void)()
  await settle()
  return { wx, page }
}

/** 让挂起的微任务链走完（api → request 是纯 Promise 链）。 */
async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

function viewOf(page: PageInstance): Record<string, unknown> {
  return page.data
}

function detailRequests(wx: InstalledWxStub) {
  return requestsTo(sentRequests(wx.request), DETAIL_URL)
}

// ---------------------------------------------------------------------------
// 文案与共享状态表
// ---------------------------------------------------------------------------

describe('#64 订单详情 · 文案与共享状态表', () => {
  it('⚠️ 九个状态标签逐字（与订单列表共用同一张表）', () => {
    expect(ORDER_STATUS_LABELS).toEqual({
      pendingPayment: '待支付',
      waitingDrop: '待存入',
      stored: '已存入',
      timeout: '已超时',
      timeoutEnd: '超时结束',
      completed: '已完成',
      ended: '已结束',
      refunded: '已退款',
      cancelled: '已取消',
    })
  })

  it('⚠️ 费用与结构的文案逐字', () => {
    expect(ORDER_COPY).toMatchObject({
      referenceLabel: '参考金额',
      referenceNote: '以取件支付时服务端计算为准',
      baseFeeLabel: '基础费',
      overtimeFeeLabel: '超时费',
      discountLabel: '优惠',
      paidLabel: '实付',
      timeoutPaidLabel: '已付',
      paymentLabel: '本次支付',
      continueWaiting: '继续等待关门',
      lockerNoLabel: '柜机码',
      cellLabel: '格口',
      timeline: {
        CREATED: '下单',
        OPENED: '存入',
        FINISHED: '结束',
        CANCELLED: '取消',
        FORCE_ENDED: '结束',
        REFUNDED: '退款',
      },
    })
    expect(ORDER_COPY.pickupCodeLabel).toBe('取件码')
    expect(ORDER_COPY.scanEntry).toBe(HOME_PAGE_COPY.scanButton)
  })

  it('⚠️ 取消弹窗与等待页是同一套文案（同一个动作只有一个名字）', () => {
    expect(ORDER_CANCEL_COPY).toMatchObject({
      title: '取消这单？',
      message: '取消后格口会释放，不会产生费用。',
      dismiss: '再想想',
      action: '取消订单',
      success: '订单已取消',
      rejected: '柜门已开启，请放入物品后关门，或联系客服',
    })
  })

  it('⚠️ 导航栏标题来自文案层', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [detailBody()])

    expect(viewOf(page).title).toBe(PAGE_TITLES['pages/order-detail/order-detail'])
  })
})

// ---------------------------------------------------------------------------
// 六块
// ---------------------------------------------------------------------------

describe('#64 订单详情 · 六块', () => {
  it('⚠️ 六块自上而下：状态摘要 → 取件码 → 柜机信息 → 费用 → 时间轴 → 支付记录', () => {
    const wxml = detailWxml()
    const order = [
      'detail__status',
      'detail__pickup',
      'detail__locker',
      'detail__fee',
      'detail__timeline',
      'detail__payments',
    ].map((block) => wxml.indexOf(block))

    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('⚠️ 已存入未支付：状态摘要 / 取件码 / 柜机信息 / 参考金额 / 时间轴都上屏', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [storedBody()])

    expect(viewOf(page).statusLabel).toBe(ORDER_STATUS_LABELS.stored)
    expect(viewOf(page).statusTone).toBe('ok')
    expect(viewOf(page).statusTime).toBe('2025-04-01 09:00')
    expect(viewOf(page).showPickupCode).toBe(true)
    expect(viewOf(page).pickupCode).toBe('385214')
    expect(viewOf(page).siteName).toBe('万达广场店')
    expect(viewOf(page).lockerNo).toBe('WD-01')
    expect(viewOf(page).cellLabel).toBe(ORDER_COPY.cellLabel)
    expect(viewOf(page).cellText).toBe('中格口 · S03')
    expect(viewOf(page).showFee).toBe(true)
    expect(viewOf(page).showFeeDetail).toBe(false)
    expect(viewOf(page).referenceAmount).toBe('¥18.00')
    expect(viewOf(page).referenceNote).toBe(ORDER_COPY.referenceNote)
    expect(viewOf(page).showTimeline).toBe(true)
    expect(viewOf(page).showPayments).toBe(false)
  })

  it('⚠️ 取件码常驻、不折叠：只要有值就渲染，且在时间轴之前', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [storedBody()])

    expect(viewOf(page).showPickupCode).toBe(true)
    expect(detailWxml()).toContain('wx:if="{{ showPickupCode }}"')
    expect(detailWxml()).not.toContain('detail__pickup-toggle')
  })

  it('⚠️ 时间轴只消费事件码，不消费后端 `title`', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [
      detailBody({
        status: 3,
        startAt: '2025-04-01T09:00:00+08:00',
        endAt: '2025-04-01T10:30:00+08:00',
        payAmount: 1500,
        baseFee: 1500,
        overtimeFee: 0,
        discount: 0,
      }),
    ])

    const rows = viewOf(page).timelineRows as Array<{ label: string; time: string }>
    expect(rows).toEqual([{ label: ORDER_COPY.timeline.CREATED, time: '2025-04-01 09:00' }])
    expect(JSON.stringify(page.data)).not.toContain('后端标题')
  })

  it('⚠️ 六个事件码各翻成本地文案（`FINISHED` / `FORCE_ENDED` 都是「结束」）', async () => {
    const at = '2025-04-01T09:00:00+08:00'
    const { page } = await enter({ id: String(ORDER_ID) }, [
      detailBody(
        { status: 3, startAt: at, endAt: at, payAmount: 1500, baseFee: 1500 },
        {
          timeline: [
            { event: 'CREATED', title: '后端一', at },
            { event: 'OPENED', title: '后端二', at },
            { event: 'FINISHED', title: '后端三', at },
            { event: 'CANCELLED', title: '后端四', at },
            { event: 'FORCE_ENDED', title: '后端五', at },
            { event: 'REFUNDED', title: '后端六', at },
          ],
        },
      ),
    ])

    expect((viewOf(page).timelineRows as Array<{ label: string }>).map((row) => row.label)).toEqual([
      ORDER_COPY.timeline.CREATED,
      ORDER_COPY.timeline.OPENED,
      ORDER_COPY.timeline.FINISHED,
      ORDER_COPY.timeline.CANCELLED,
      ORDER_COPY.timeline.FORCE_ENDED,
      ORDER_COPY.timeline.REFUNDED,
    ])
    expect(JSON.stringify(page.data)).not.toContain('后端')
  })

  it('⚠️ 时间轴为空时整块不渲染', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [
      detailBody({}, { timeline: [] }),
    ])

    expect(viewOf(page).showTimeline).toBe(false)
    expect(viewOf(page).timelineRows).toEqual([])
  })

  it('⚠️ 支付记录只在有支付时出现；每行「本次支付」+ 时间，不出现单号 / 渠道 / 状态', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [
      detailBody(
        {
          status: 3,
          startAt: '2025-04-01T09:00:00+08:00',
          endAt: '2025-04-01T10:30:00+08:00',
          baseFee: 1500,
          overtimeFee: 0,
          discount: 0,
          payAmount: 1500,
        },
        {
          payments: [
            {
              payNo: 'P20250401001',
              amount: 1500,
              channel: 1,
              status: 2,
              paidAt: '2025-04-01T10:20:00+08:00',
            },
          ],
        },
      ),
    ])

    expect(viewOf(page).showPayments).toBe(true)
    expect(viewOf(page).paymentRows).toEqual([
      { label: ORDER_COPY.paymentLabel, amount: '¥15.00', time: '2025-04-01 10:20' },
    ])
    expect(JSON.stringify(page.data)).not.toContain('P20250401001')
    expect(JSON.stringify(page.data)).not.toContain('20250401001')
  })

  it('⚠️ 支付记录为空时不给空占位', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [storedBody()])

    expect(viewOf(page).showPayments).toBe(false)
    expect(detailWxml()).not.toContain('detail__payments-empty')
  })
})

// ---------------------------------------------------------------------------
// 状态摘要：九种状态 + 关键时间
// ---------------------------------------------------------------------------

describe('#64 订单详情 · 状态摘要', () => {
  const cases: Array<{
    name: string
    order: Record<string, unknown>
    label: string
    tone: string
    time: string
  }> = [
    {
      name: '待支付',
      order: { status: 1, startAt: null, estimatedAmount: null },
      label: '待支付',
      tone: 'warn',
      time: '',
    },
    {
      name: '待存入',
      order: { status: 2, startAt: null },
      label: '待存入',
      tone: 'ok',
      time: '',
    },
    {
      name: '已存入',
      order: { status: 2, startAt: '2025-04-01T09:00:00+08:00' },
      label: '已存入',
      tone: 'ok',
      time: '2025-04-01 09:00',
    },
    {
      name: '已超时（未取件）',
      order: { status: 4, startAt: '2025-04-01T09:00:00+08:00', endAt: null },
      label: '已超时',
      tone: 'warn',
      time: '2025-04-01 09:00',
    },
    {
      name: '超时结束',
      order: {
        status: 4,
        startAt: '2025-04-01T09:00:00+08:00',
        endAt: '2025-04-01T11:00:00+08:00',
      },
      label: '超时结束',
      tone: 'muted',
      time: '2025-04-01 11:00',
    },
    {
      name: '已完成',
      order: {
        status: 3,
        startAt: '2025-04-01T09:00:00+08:00',
        endAt: '2025-04-01T10:30:00+08:00',
      },
      label: '已完成',
      tone: 'muted',
      time: '2025-04-01 10:30',
    },
    {
      name: '已结束',
      order: {
        status: 5,
        startAt: '2025-04-01T09:00:00+08:00',
        endAt: '2025-04-01T10:30:00+08:00',
      },
      label: '已结束',
      tone: 'muted',
      time: '2025-04-01 10:30',
    },
    {
      name: '已退款',
      order: {
        status: 6,
        startAt: '2025-04-01T09:00:00+08:00',
        endAt: '2025-04-01T10:30:00+08:00',
      },
      label: '已退款',
      tone: 'muted',
      time: '2025-04-01 10:30',
    },
    {
      name: '已取消',
      order: { status: 7, startAt: null, endAt: null },
      label: '已取消',
      tone: 'muted',
      time: '',
    },
  ]

  for (const item of cases) {
    it(`⚠️ ${item.name} → 「${item.label}」/ ${item.tone} / 关键时间「${item.time}」`, async () => {
      const { page } = await enter({ id: String(ORDER_ID) }, [detailBody(item.order)])

      expect(viewOf(page).statusLabel).toBe(item.label)
      expect(viewOf(page).statusTone).toBe(item.tone)
      expect(viewOf(page).statusTime).toBe(item.time)
    })
  }

  it('⚠️ 状态摘要不写解释性句子 —— 没有字段能证明「门已开」', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [storedBody()])

    expect(viewOf(page).statusHint).toBeUndefined()
    expect(detailWxml()).not.toContain('门已开')
  })
})

// ---------------------------------------------------------------------------
// 柜机信息
// ---------------------------------------------------------------------------

describe('#64 订单详情 · 柜机信息', () => {
  it('⚠️ 站点名 / 柜机码 / 档位 + cellNo 都要上屏', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [storedBody()])

    expect(viewOf(page).siteName).toBe('万达广场店')
    expect(viewOf(page).lockerNo).toBe('WD-01')
    expect(viewOf(page).cellText).toBe('中格口 · S03')
  })

  it('⚠️ 已取消订单不显示格口（格口已释放）', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [
      detailBody({ status: 7, startAt: null, endAt: null }),
    ])

    expect(viewOf(page).showCell).toBe(false)
    expect(viewOf(page).cellText).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 费用矩阵
// ---------------------------------------------------------------------------

describe('#64 订单详情 · 费用矩阵', () => {
  it('⚠️ 未支付：只有参考金额 + 一句说明，不造明细行', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [storedBody()])

    expect(viewOf(page).showFee).toBe(true)
    expect(viewOf(page).showFeeDetail).toBe(false)
    expect(viewOf(page).feeRows).toEqual([])
    expect(viewOf(page).showReference).toBe(true)
    expect(viewOf(page).referenceLabel).toBe(ORDER_COPY.referenceLabel)
    expect(viewOf(page).referenceAmount).toBe('¥18.00')
    expect(viewOf(page).referenceNote).toBe('以取件支付时服务端计算为准')
    expect(viewOf(page).showPaid).toBe(false)
  })

  it('⚠️ 参考金额缺失时整行不渲染，但说明句仍在', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [
      detailBody({ status: 2, startAt: null, estimatedAmount: null }),
    ])

    expect(viewOf(page).showReference).toBe(false)
    expect(viewOf(page).referenceAmount).toBe('')
    expect(viewOf(page).referenceNote).toBe(ORDER_COPY.referenceNote)
    expect(viewOf(page).showFeeDetail).toBe(false)
  })

  it('⚠️ 已支付：基础费 / 超时费 / 优惠 / 实付逐行正确', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [paidBody()])

    expect(viewOf(page).showFeeDetail).toBe(true)
    expect(viewOf(page).feeRows).toEqual([
      { label: ORDER_COPY.baseFeeLabel, amount: '¥15.00' },
      { label: ORDER_COPY.overtimeFeeLabel, amount: '¥6.00' },
      { label: ORDER_COPY.discountLabel, amount: '¥3.00' },
    ])
    expect(viewOf(page).showReference).toBe(false)
    expect(viewOf(page).showPaid).toBe(true)
    expect(viewOf(page).paidLabel).toBe(ORDER_COPY.paidLabel)
    expect(viewOf(page).paidAmount).toBe('¥18.00')
  })

  it('⚠️ 优惠为 0 不渲染「优惠」行', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [
      paidBody({ discount: 0 }),
    ])

    const labels = (viewOf(page).feeRows as Array<{ label: string }>).map((row) => row.label)
    expect(labels).toEqual([ORDER_COPY.baseFeeLabel, ORDER_COPY.overtimeFeeLabel])
    expect(labels).not.toContain(ORDER_COPY.discountLabel)
  })

  it('⚠️ `TIMEOUT` 单已支付时金额词是「已付」，不是「实付」', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [
      paidBody({ status: 4, endAt: null }),
    ])

    expect(viewOf(page).showFeeDetail).toBe(true)
    expect(viewOf(page).paidLabel).toBe(ORDER_COPY.timeoutPaidLabel)
    expect(viewOf(page).paidLabel).toBe('已付')
    expect(viewOf(page).paidAmount).toBe('¥18.00')
  })

  it('⚠️ `TIMEOUT` 未取件未支付：参考金额 + 说明，不出现「还需支付」', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [
      detailBody({
        status: 4,
        startAt: '2025-04-01T09:00:00+08:00',
        endAt: null,
        estimatedAmount: 2400,
        pickupCode: '385214',
      }),
    ])

    expect(viewOf(page).showFeeDetail).toBe(false)
    expect(viewOf(page).referenceAmount).toBe('¥24.00')
    expect(viewOf(page).referenceNote).toBe(ORDER_COPY.referenceNote)
    expect(viewOf(page).showPaid).toBe(false)
    expect(JSON.stringify(viewOf(page))).not.toContain('还需支付')
  })

  it('⚠️ 已退款：明细 + 实付照常，不新增退款金额', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [
      completedBody({ status: 6, payAmount: 1500 }),
    ])

    expect(viewOf(page).showFeeDetail).toBe(true)
    expect(viewOf(page).paidLabel).toBe(ORDER_COPY.paidLabel)
    expect(viewOf(page).paidAmount).toBe('¥15.00')
    expect(JSON.stringify(viewOf(page))).not.toContain('退款金额')
    expect(detailWxml()).not.toContain('refund')
  })

  it('⚠️ 已取消：整块费用区不渲染', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [
      detailBody({ status: 7, startAt: null, endAt: null }),
    ])

    expect(viewOf(page).showFee).toBe(false)
    expect(viewOf(page).feeRows).toEqual([])
    expect(viewOf(page).referenceAmount).toBe('')
    expect(detailWxml()).toContain('wx:if="{{ showFee }}"')
  })

  it('⚠️ 金额只在展示层换算一次：千分位与两位小数由 `formatMoney` 负责', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [
      detailBody({ status: 2, startAt: '2025-04-01T09:00:00+08:00', estimatedAmount: 123456 }),
    ])

    expect(viewOf(page).referenceAmount).toBe('¥1,234.56')
    expect(detailSource()).not.toContain('/ 100')
    expect(detailSource()).not.toContain('/100')
  })
})

// ---------------------------------------------------------------------------
// 取消
// ---------------------------------------------------------------------------

describe('#64 订单详情 · 取消（只对待存入开放）', () => {
  it('⚠️ 待存入：弹窗文案与等待页同一套；确认后 POST 13.10，成功 toast + 回订单列表', async () => {
    const { wx, page } = await enter({ id: String(ORDER_ID) }, [
      detailBody({ status: 2, startAt: null }),
      { code: 0, message: 'ok', data: null },
    ])

    expect(viewOf(page).showCancel).toBe(true)
    expect(viewOf(page).cancelActionLabel).toBe(ORDER_CANCEL_COPY.action)

    ;(page.onCancel as () => void)()
    await settle()

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.confirm).toHaveBeenCalledWith({
      title: ORDER_CANCEL_COPY.title,
      message: ORDER_CANCEL_COPY.message,
      cancelText: ORDER_CANCEL_COPY.dismiss,
      confirmText: ORDER_CANCEL_COPY.action,
    })

    const cancelRequests = requestsTo(sentRequests(wx.request), CANCEL_URL)
    expect(cancelRequests).toHaveLength(1)
    expect(cancelRequests[0]?.method).toBe('POST')
    expect(mocks.showToast).toHaveBeenCalledWith(ORDER_CANCEL_COPY.success)
    expect(wx.switchTab).toHaveBeenCalledWith({ url: `/${ORDER_LIST_PATH}` })
  })

  it('⚠️ 已存入（startAt 有值）不出现取消入口', async () => {
    const { wx, page } = await enter({ id: String(ORDER_ID) }, [storedBody()])

    expect(viewOf(page).showCancel).toBe(false)
    ;(page.onCancel as () => void)()
    await settle()

    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(requestsTo(sentRequests(wx.request), CANCEL_URL)).toHaveLength(0)
  })

  it('⚠️ 用户在弹窗里选「再想想」→ 不发请求', async () => {
    mocks.confirm.mockResolvedValueOnce(false)
    const { wx, page } = await enter({ id: String(ORDER_ID) }, [
      detailBody({ status: 2, startAt: null }),
    ])

    ;(page.onCancel as () => void)()
    await settle()

    expect(requestsTo(sentRequests(wx.request), CANCEL_URL)).toHaveLength(0)
    expect(mocks.showToast).not.toHaveBeenCalled()
  })

  it('⚠️ 3002：用契约逐字告知（与等待页同一句），随后静默刷新最新状态', async () => {
    const { wx, page } = await enter({ id: String(ORDER_ID) }, [
      detailBody({ status: 2, startAt: null }),
      businessError(3002),
      storedBody(),
    ])

    ;(page.onCancel as () => void)()
    await settle()

    expect(mocks.alert).toHaveBeenCalledTimes(1)
    expect(mocks.alert).toHaveBeenCalledWith({
      title: ORDER_CANCEL_COPY.title,
      message: ORDER_CANCEL_COPY.rejected,
    })
    // 刷新后页面已经说「已存入」—— 与服务端的最新事实一致。
    expect(detailRequests(wx)).toHaveLength(2)
    expect(viewOf(page).statusLabel).toBe(ORDER_STATUS_LABELS.stored)
    expect(viewOf(page).showCancel).toBe(false)
  })

  it('⚠️ 取消的其他失败：一句「没收到结果」，不假装已经取消', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [
      detailBody({ status: 2, startAt: null }),
      businessError(5000),
    ])

    ;(page.onCancel as () => void)()
    await settle()

    expect(mocks.showToast).toHaveBeenCalledWith(ORDER_COPY.cancelFailed)
    expect(viewOf(page).phase).toBe('ready')
    expect(viewOf(page).showCancel).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 失败归因 / 静默刷新
// ---------------------------------------------------------------------------

describe('#64 订单详情 · 加载失败与静默刷新', () => {
  for (const code of [3001, 8003]) {
    it(`⚠️ ${code} → 统一「订单不存在或已删除」，不区分不存在与无权`, async () => {
      const { wx, page } = await enter({ id: String(ORDER_ID) }, [businessError(code)])

      expect(viewOf(page).phase).toBe('missing')
      expect(viewOf(page).missingTitle).toBe('订单不存在或已删除')
      expect(viewOf(page).backToOrdersLabel).toBe(ORDER_COPY.backToOrders)
      expect(mocks.showToast).not.toHaveBeenCalled()

      ;(page.onBackToOrders as () => void)()
      expect(wx.switchTab).toHaveBeenCalledWith({ url: `/${ORDER_LIST_PATH}` })
    })
  }

  it('⚠️ 其他失败 → 页内重试，重试真的再发一次 13.9', async () => {
    const { wx, page } = await enter({ id: String(ORDER_ID) }, [
      businessError(5000),
      storedBody(),
    ])

    expect(viewOf(page).phase).toBe('loadFailed')
    expect(viewOf(page).loadFailedDetail).toBe(ORDER_COPY.loadFailed)
    expect(viewOf(page).retryLabel).toBe(RETRY_LABEL)
    expect(detailRequests(wx)).toHaveLength(1)

    ;(page.onRetry as () => void)()
    await settle()

    expect(detailRequests(wx)).toHaveLength(2)
    expect(viewOf(page).phase).toBe('ready')
    expect(viewOf(page).statusLabel).toBe(ORDER_STATUS_LABELS.stored)
  })

  it('⚠️ 每次 onShow 静默刷新：从等待页 / 支付层回来必须看到最新状态', async () => {
    const { wx, page } = await enter({ id: String(ORDER_ID) }, [
      storedBody(),
      paidBody(),
    ])

    expect(viewOf(page).showPaid).toBe(false)

    ;(page.onShow as () => void)()
    await settle()

    expect(detailRequests(wx)).toHaveLength(2)
    expect(viewOf(page).phase).toBe('ready')
    expect(viewOf(page).showPaid).toBe(true)
    expect(viewOf(page).paidAmount).toBe('¥18.00')
  })

  it('⚠️ 静默刷新失败保留已有内容，不整页闪回失败块', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [
      storedBody(),
      businessError(5000),
    ])

    ;(page.onShow as () => void)()
    await settle()

    expect(viewOf(page).phase).toBe('ready')
    expect(viewOf(page).statusLabel).toBe(ORDER_STATUS_LABELS.stored)
    expect(viewOf(page).pickupCode).toBe('385214')
  })

  it('⚠️ 静默刷新期间不切回骨架屏（首屏之后没有第二次 loading）', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [storedBody(), paidBody()])

    ;(page.onShow as () => void)()
    await settle()

    expect(viewOf(page).phase).toBe('ready')
    expect(detailWxml()).toContain("phase === 'loading'")
  })

  it('⚠️ 参数不合法 → 直接进「订单不存在」，不发请求', async () => {
    const { wx, page } = await enter({ id: 'not-a-number' }, [])

    expect(viewOf(page).phase).toBe('missing')
    expect(wx.request).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 主行动 / 历史单扫码出口
// ---------------------------------------------------------------------------

describe('#64 订单详情 · 主行动', () => {
  it('⚠️ 待存入：「继续等待关门」→ redirectTo 等待页（mode=drop），不是 navigateTo', async () => {
    const { wx, page } = await enter({ id: String(ORDER_ID) }, [
      detailBody({ status: 2, startAt: null }),
    ])

    expect(viewOf(page).showActionBar).toBe(true)
    expect(viewOf(page).primaryActionLabel).toBe(ORDER_COPY.continueWaiting)
    expect(viewOf(page).showCancel).toBe(true)
    expect(viewOf(page).canPickup).toBe(false)

    ;(page.onPrimaryAction as () => void)()

    expect(wx.redirectTo).toHaveBeenCalledTimes(1)
    expect(wx.redirectTo.mock.calls[0]?.[0]).toMatchObject({
      url: `/${WAITING_PATH}?orderId=${ORDER_ID}&mode=drop`,
    })
    expect(wx.navigateTo).not.toHaveBeenCalled()
  })

  it('⚠️ 已存入：底栏「取件开门」打开共享取件层，页面不自己跳转', async () => {
    const { wx, page } = await enter({ id: String(ORDER_ID) }, [storedBody()])

    expect(viewOf(page).canPickup).toBe(true)
    expect(viewOf(page).showActionBar).toBe(true)
    expect(viewOf(page).primaryAction).toBe('pickup')
    expect(viewOf(page).primaryActionLabel).toBe(PICKUP_SHEET_COPY.pickupAction)
    expect(viewOf(page).showCancel).toBe(false)
    expect(viewOf(page).pickupOrder).toBeNull()

    ;(page.onPrimaryAction as () => void)()

    expect(viewOf(page).pickupOrder).toMatchObject({
      id: ORDER_ID,
      status: 2,
      startAt: '2025-04-01T09:00:00+08:00',
      endAt: null,
      payAmount: null,
      estimatedAmount: 1800,
      siteName: '万达广场店',
      lockerNo: 'WD-01',
      cellNo: 'S03',
    })
    expect(wx.redirectTo).not.toHaveBeenCalled()
    expect(wx.navigateTo).not.toHaveBeenCalled()
  })

  it('⚠️ 已超时未取件：底栏「补缴并开门」，仍打开同一个取件层', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [
      detailBody({
        status: 4,
        startAt: '2025-04-01T09:00:00+08:00',
        payAmount: 500,
        estimatedAmount: 1800,
        pickupCode: '385214',
      }),
    ])

    expect(viewOf(page).canPickup).toBe(true)
    expect(viewOf(page).primaryActionLabel).toBe(PICKUP_SHEET_COPY.topUpAction)
    expect(viewOf(page).primaryAction).toBe('pickup')

    ;(page.onPrimaryAction as () => void)()
    expect(viewOf(page).pickupOrder).toMatchObject({ status: 4, payAmount: 500 })
  })

  it('⚠️ 取件层 success → 详情页 redirectTo 等待页（mode=pickup），不是 navigateTo', async () => {
    const { wx, page } = await enter({ id: String(ORDER_ID) }, [storedBody()])
    ;(page.onPrimaryAction as () => void)()

    ;(page.onPickupSuccess as () => void)()

    expect(viewOf(page).pickupOrder).toBeNull()
    expect(wx.redirectTo).toHaveBeenCalledTimes(1)
    expect(wx.redirectTo.mock.calls[0]?.[0]).toMatchObject({
      url: `/${WAITING_PATH}?orderId=${ORDER_ID}&mode=pickup`,
    })
    expect(wx.navigateTo).not.toHaveBeenCalled()
  })

  it('⚠️ 取件层 dismiss → 只收起弹层，不刷新、不跳转', async () => {
    const { wx, page } = await enter({ id: String(ORDER_ID) }, [storedBody()])
    ;(page.onPrimaryAction as () => void)()

    ;(page.onPickupDismiss as () => void)()

    expect(viewOf(page).pickupOrder).toBeNull()
    expect(wx.redirectTo).not.toHaveBeenCalled()
    expect(wx.switchTab).not.toHaveBeenCalled()
  })

  it('⚠️ 取件层 refresh(missing) → 来源页回订单列表', async () => {
    const { wx, page } = await enter({ id: String(ORDER_ID) }, [storedBody()])
    ;(page.onPrimaryAction as () => void)()

    ;(page.onPickupRefresh as (event: { detail?: { missing?: boolean } }) => void)({
      detail: { missing: true },
    })

    expect(viewOf(page).pickupOrder).toBeNull()
    expect(wx.switchTab).toHaveBeenCalledTimes(1)
    expect(wx.switchTab.mock.calls[0]?.[0]).toMatchObject({ url: `/${ORDER_LIST_PATH}` })
  })

  it('⚠️ 取件层 refresh（状态已变）→ 静默重查一次 13.9', async () => {
    const { wx, page } = await enter({ id: String(ORDER_ID) }, [storedBody(), completedBody()])
    ;(page.onPrimaryAction as () => void)()

    ;(page.onPickupRefresh as (event: { detail?: { missing?: boolean } }) => void)({
      detail: { missing: false },
    })
    await settle()

    expect(viewOf(page).pickupOrder).toBeNull()
    expect(detailRequests(wx)).toHaveLength(2)
    expect(viewOf(page).statusLabel).toBe(ORDER_STATUS_LABELS.completed)
  })

  it('⚠️ `status=1` 兜底：标签「待支付」，没有任何 CTA', async () => {
    const { wx, page } = await enter({ id: String(ORDER_ID) }, [
      detailBody({ status: 1, startAt: null, estimatedAmount: null }),
    ])

    expect(viewOf(page).statusLabel).toBe(ORDER_STATUS_LABELS.pendingPayment)
    expect(viewOf(page).showActionBar).toBe(false)
    expect(viewOf(page).showScanEntry).toBe(false)
    expect(viewOf(page).canPickup).toBe(false)
    expect(wx.redirectTo).not.toHaveBeenCalled()
  })

  it('⚠️ 历史单没有行动条，底部只有次级「扫码存件」', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [completedBody()])

    expect(viewOf(page).showActionBar).toBe(false)
    expect(viewOf(page).showScanEntry).toBe(true)
    expect(viewOf(page).scanEntryLabel).toBe(HOME_PAGE_COPY.scanButton)
  })

  it('⚠️ 历史单扫码走与首页同一条链路：解析出柜机码 → 柜机页', async () => {
    const { wx, page } = await enter({ id: String(ORDER_ID) }, [completedBody()])
    wx.scanCode.mockImplementation((options) => {
      options.success?.({ result: 'https://locker.example.com/l/WD-01' })
    })

    ;(page.onScanEntry as () => void)()

    expect(wx.navigateTo).toHaveBeenCalledTimes(1)
    expect(wx.navigateTo.mock.calls[0]?.[0]).toMatchObject({
      url: `/${LOCKER_PATH}?code=WD-01`,
    })
    expect(mocks.showToast).not.toHaveBeenCalled()
  })

  it('⚠️ 历史单扫到非柜机码 → 一句提示、不跳转；取消静默；其他失败一句提示', async () => {
    const { wx, page } = await enter({ id: String(ORDER_ID) }, [completedBody()])

    wx.scanCode.mockImplementation((options) => {
      options.success?.({ result: 'https://example.com/not-a-locker' })
    })
    ;(page.onScanEntry as () => void)()
    expect(mocks.showToast).toHaveBeenCalledWith(HOME_PAGE_COPY.notLockerCode)
    expect(wx.navigateTo).not.toHaveBeenCalled()

    mocks.showToast.mockReset()
    wx.scanCode.mockImplementation((options) => {
      options.fail?.({ errMsg: 'scanCode:fail cancel' })
    })
    ;(page.onScanEntry as () => void)()
    expect(mocks.showToast).not.toHaveBeenCalled()

    wx.scanCode.mockImplementation((options) => {
      options.fail?.({ errMsg: 'scanCode:fail camera' })
    })
    ;(page.onScanEntry as () => void)()
    expect(mocks.showToast).toHaveBeenCalledWith(HOME_PAGE_COPY.scanFailed)
  })
})

// ---------------------------------------------------------------------------
// 源码守卫：这一页永远不该出现的东西
// ---------------------------------------------------------------------------

describe('#64 订单详情 · 源码守卫', () => {
  it('⚠️ 不展示订单号 / 支付单号 / 渠道 / 手机号（数据区与模板都不出现）', async () => {
    const { page } = await enter({ id: String(ORDER_ID) }, [
      detailBody(
        { status: 3, startAt: '2025-04-01T09:00:00+08:00', endAt: '2025-04-01T10:30:00+08:00', payAmount: 1500, baseFee: 1500 },
        {
          payments: [
            { payNo: 'P-9', amount: 1500, channel: 1, status: 2, paidAt: '2025-04-01T10:20:00+08:00' },
          ],
        },
      ),
    ])

    const serialized = JSON.stringify(page.data)
    expect(serialized).not.toContain('20250401001')
    expect(serialized).not.toContain('P-9')
    expect(serialized).not.toContain('channel')
    expect(serialized).not.toContain('phone')
    expect(detailWxml()).not.toContain('orderNo')
    expect(detailWxml()).not.toContain('payNo')
    expect(detailWxml()).not.toContain('channel')
    expect(detailWxml()).not.toContain('phone')
  })

  it('⚠️ 页面不写路径字面量、不碰 storage、不直接用 Vant 反馈、不写禁用词', () => {
    const source = detailSource()
    expect(source).not.toMatch(/url:\s*['"`]\/?pages\//)
    expect(source).not.toContain('/api/app/v1')
    expect(source).not.toMatch(/\bwx\s*\.\s*(get|set|remove)Storage(Sync)?\b/)
    expect(source).not.toContain('@vant/weapp')
    for (const word of ['门已开', '开门成功', '取件成功', '已付清', '应付', '预估价', '锁定价', '还需支付']) {
      expect(detailSource()).not.toContain(word)
      expect(detailWxml()).not.toContain(word)
    }
  })

  it('⚠️ 首屏用详情形状的骨架屏', () => {
    expect(detailWxml()).toContain('variant="detail"')
  })

  it('⚠️ 固定行动条只在有真实 CTA 时出现', () => {
    expect(detailWxml()).toContain("phase === 'ready' && showActionBar")
    expect(detailWxml()).toContain('wx:if="{{ showCancel }}"')
  })

  it('⚠️ 取件层是共享组件：页面只传 order / 收事件，不画支付界面、不调 13.11', () => {
    const source = detailSource()
    const wxml = detailWxml()
    const json = readFileSync(join(detailDir, 'order-detail.json'), 'utf8')

    expect(wxml).toContain('<pickup-sheet')
    expect(wxml).toContain('order="{{ pickupOrder }}"')
    expect(wxml).toContain('bind:success="onPickupSuccess"')
    expect(wxml).toContain('bind:dismiss="onPickupDismiss"')
    expect(wxml).toContain('bind:refresh="onPickupRefresh"')
    expect(json).toContain('"pickup-sheet": "/components/pickup-sheet/pickup-sheet"')

    // 页面不自己画支付弹层 / 不自己调支付接口 —— 这些都属于共享组件。
    expect(wxml).not.toContain('van-popup')
    expect(source).not.toContain('payOrder')
    expect(source).not.toContain('@vant/weapp')
  })
})
