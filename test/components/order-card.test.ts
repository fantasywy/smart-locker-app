// **订单卡**（`order-card`）的契约 —— ticket #66 / spec #57 §2 + §6。
//
// 这个组件是订单的**唯一**呈现单元：首页卡用 `home` 变体，订单列表用
// `active` / `history` 两个变体。三条硬边界：
//   1. **组件不导航**：整卡点击与卡内主行动都只 `triggerEvent`，去向归宿主；
//   2. **状态标签与色档只有一套**（`utils/order-status.ts` + `ORDER_STATUS_LABELS`），
//      组件里不得再出现第二张状态表；
//   3. **字段矩阵是逐状态的**：已取消不显示格口 / 时间、已退款不显示金额、
//      已存入已支付显示实付、`TIMEOUT` 终局显示已付 —— 不是「有值就画」。
//
// 断言只落在组件级 seam：`Component()` 定义 + `order` 观察者 + 事件。
// 不渲染模板、不测样式，也不碰任何 `wx.*To`（组件根本不该调用它们）。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWxStub } from '../helpers/wx'
import { ORDER_COPY, ORDER_STATUS_LABELS, PICKUP_SHEET_COPY } from '../../miniprogram/startup/copy'
import type { OrderSummary } from '../../miniprogram/types/orders'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const cardDir = join(repoRoot, 'miniprogram', 'components', 'order-card')
const cardSource = (): string =>
  readFileSync(join(cardDir, 'order-card.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
const cardWxml = (): string =>
  readFileSync(join(cardDir, 'order-card.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')

interface ComponentDefinition {
  properties: Record<string, { type?: unknown; value?: unknown }>
  data: Record<string, unknown>
  observers?: Record<string, (...args: unknown[]) => void>
  methods: Record<string, (...args: unknown[]) => unknown>
  lifetimes?: Record<string, (...args: unknown[]) => unknown>
}

interface CardInstance {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  triggerEvent: ReturnType<typeof vi.fn>
  onCardTap: () => void
  onCardAction: () => void
}

const ORDER_ID = 1001

/** 一份 `13.8` 行形状的最小订单 —— 每个用例只覆盖它要测的那几个字段。 */
function order(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: ORDER_ID,
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

let definition: ComponentDefinition | null = null

beforeEach(() => {
  definition = null
  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (def: Record<string, unknown>): void => {
    definition = def as unknown as ComponentDefinition
  }
})

async function loadComponent(): Promise<ComponentDefinition> {
  vi.resetModules()
  await import('../../miniprogram/components/order-card/order-card')
  if (definition === null) throw new Error('order-card.ts 没有调用 Component()')
  return definition
}

function instantiate(def: ComponentDefinition, current: OrderSummary): CardInstance {
  const instance = {
    data: { ...def.data, order: current },
    setData(patch: Record<string, unknown>): void {
      Object.assign(instance.data, patch)
    },
    triggerEvent: vi.fn(),
  } as unknown as CardInstance
  for (const [name, fn] of Object.entries(def.methods)) {
    ;(instance as unknown as Record<string, unknown>)[name] = fn.bind(instance)
  }
  return instance
}

/** 走一遍真实属性观察者 —— 断言看到的就是模板能拿到的渲染模型。 */
async function render(current: OrderSummary, variant: 'home' | 'active' | 'history'): Promise<CardInstance> {
  const def = await loadComponent()
  const instance = instantiate(def, current)
  instance.data.variant = variant
  def.observers?.order?.call(instance, current)
  return instance
}

describe('#66 order-card · 入参与事件边界', () => {
  it('⚠️ 属性只有 order / variant，事件只发 tap / action', async () => {
    const definition = await loadComponent()
    expect(Object.keys(definition.properties).sort()).toEqual(['order', 'variant'])
  })

  it('⚠️ 整卡点击与主行动都只发事件，组件自己不导航', async () => {
    const wxStub = installWxStub()
    const instance = await render(order(), 'active')

    instance.onCardTap()
    expect(instance.triggerEvent).toHaveBeenCalledWith('tap', { id: ORDER_ID })
    expect(wxStub.navigateTo).not.toHaveBeenCalled()
    expect(wxStub.redirectTo).not.toHaveBeenCalled()
    expect(wxStub.switchTab).not.toHaveBeenCalled()

    instance.onCardAction()
    expect(instance.triggerEvent).toHaveBeenCalledWith('action', { id: ORDER_ID })
    expect(wxStub.navigateTo).not.toHaveBeenCalled()
    expect(wxStub.redirectTo).not.toHaveBeenCalled()
    expect(wxStub.switchTab).not.toHaveBeenCalled()
  })

  it('⚠️ 组件源码不出现跳转 API 与页面路径字面量', () => {
    const source = cardSource()
    expect(source).not.toMatch(/wx\.(navigateTo|redirectTo|switchTab|navigateBack)/)
    expect(source).not.toMatch(/['"`]\/?pages\//)
  })

  it('⚠️ 卡内主行动用 catchtap（不冒泡到整卡），整卡自身也 catchtap', () => {
    const wxml = cardWxml()
    expect(wxml).toMatch(/catchtap="onCardAction"/)
    expect(wxml).toMatch(/catchtap="onCardTap"/)
  })
})

describe('#66 order-card · 九种状态标签与色档', () => {
  const cases: Array<{
    name: string
    current: OrderSummary
    variant: 'active' | 'history'
    label: string
    tone: string
  }> = [
    {
      name: '待支付（兜底）',
      current: order({ status: 1, startAt: null, estimatedAmount: null }),
      variant: 'active',
      label: '待支付',
      tone: 'warn',
    },
    {
      name: '待存入',
      current: order({ status: 2, startAt: null }),
      variant: 'active',
      label: '待存入',
      tone: 'ok',
    },
    {
      name: '已存入',
      current: order({ status: 2, startAt: '2025-04-01T09:00:00+08:00' }),
      variant: 'active',
      label: '已存入',
      tone: 'ok',
    },
    {
      name: '已超时',
      current: order({ status: 4, startAt: '2025-04-01T09:00:00+08:00', endAt: null }),
      variant: 'active',
      label: '已超时',
      tone: 'warn',
    },
    {
      name: '超时结束',
      current: order({
        status: 4,
        startAt: '2025-04-01T09:00:00+08:00',
        endAt: '2025-04-01T11:00:00+08:00',
      }),
      variant: 'history',
      label: '超时结束',
      tone: 'muted',
    },
    {
      name: '已完成',
      current: order({
        status: 3,
        startAt: '2025-04-01T09:00:00+08:00',
        endAt: '2025-04-01T10:30:00+08:00',
      }),
      variant: 'history',
      label: '已完成',
      tone: 'muted',
    },
    {
      name: '已结束',
      current: order({
        status: 5,
        startAt: '2025-04-01T09:00:00+08:00',
        endAt: '2025-04-01T10:30:00+08:00',
      }),
      variant: 'history',
      label: '已结束',
      tone: 'muted',
    },
    {
      name: '已退款',
      current: order({
        status: 6,
        startAt: '2025-04-01T09:00:00+08:00',
        endAt: '2025-04-01T10:30:00+08:00',
      }),
      variant: 'history',
      label: '已退款',
      tone: 'muted',
    },
    {
      name: '已取消',
      current: order({ status: 7, startAt: null, endAt: null }),
      variant: 'history',
      label: '已取消',
      tone: 'muted',
    },
  ]

  for (const item of cases) {
    it(`⚠️ ${item.name} → 「${item.label}」/ ${item.tone}`, async () => {
      const instance = await render(item.current, item.variant)
      expect(instance.data.statusLabel).toBe(item.label)
      expect(instance.data.statusTone).toBe(item.tone)
    })
  }

  it('⚠️ 标签逐字来自共享状态表（组件里没有第二张表）', () => {
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
    expect(cardSource()).not.toMatch(/待支付|待存入|已存入|已超时|超时结束|已完成|已结束|已退款|已取消/)
  })
})

describe('#66 order-card · 字段 / 金额 / 主行动矩阵', () => {
  it('⚠️ 待存入：只有格口，无时间、无取件码、无金额，主行动「继续等待关门」', async () => {
    const instance = await render(
      order({ status: 2, startAt: null, estimatedAmount: 1800, pickupCode: null }),
      'active',
    )

    expect(instance.data.cellLine).toBe('S03')
    expect(instance.data.showPickupCode).toBe(false)
    expect(instance.data.showAmount).toBe(false)
    expect(instance.data.showAction).toBe(true)
    expect(instance.data.actionLabel).toBe(ORDER_COPY.continueWaiting)
  })

  it('⚠️ 已存入（未支付）：格口 · 存入时间、取件码、参考金额、主行动「取件开门」', async () => {
    const instance = await render(
      order({
        status: 2,
        startAt: '2025-04-01T09:00:00+08:00',
        estimatedAmount: 1800,
        pickupCode: '385214',
      }),
      'active',
    )

    expect(instance.data.cellLine).toBe('S03 · 存入 04-01 09:00')
    expect(instance.data.showPickupCode).toBe(true)
    expect(instance.data.pickupCode).toBe('385214')
    expect(instance.data.showAmount).toBe(true)
    expect(instance.data.amountLabel).toBe(ORDER_COPY.referenceLabel)
    expect(instance.data.amount).toBe('¥18.00')
    expect(instance.data.showAction).toBe(true)
    expect(instance.data.actionLabel).toBe(PICKUP_SHEET_COPY.pickupAction)
  })

  it('⚠️ 已存入（已支付）：金额词是「实付」，不是「已付」', async () => {
    const instance = await render(
      order({
        status: 2,
        startAt: '2025-04-01T09:00:00+08:00',
        payAmount: 1500,
        estimatedAmount: null,
        pickupCode: '385214',
      }),
      'active',
    )

    expect(instance.data.showAmount).toBe(true)
    expect(instance.data.amountLabel).toBe(ORDER_COPY.paidLabel)
    expect(instance.data.amountLabel).toBe('实付')
    expect(instance.data.amount).toBe('¥15.00')
    expect(instance.data.showAction).toBe(true)
  })

  it('⚠️ 已超时（未取件）：格口 · 存入时间、取件码、参考金额、主行动「取件开门」', async () => {
    const instance = await render(
      order({
        status: 4,
        startAt: '2025-04-01T09:00:00+08:00',
        endAt: null,
        estimatedAmount: 2400,
        pickupCode: '385214',
      }),
      'active',
    )

    expect(instance.data.cellLine).toBe('S03 · 存入 04-01 09:00')
    expect(instance.data.showPickupCode).toBe(true)
    expect(instance.data.amountLabel).toBe(ORDER_COPY.referenceLabel)
    expect(instance.data.amount).toBe('¥24.00')
    expect(instance.data.actionLabel).toBe(PICKUP_SHEET_COPY.pickupAction)
  })

  it('⚠️ 已完成：格口 · 取件时间、无取件码、实付、无行动', async () => {
    const instance = await render(
      order({
        status: 3,
        startAt: '2025-04-01T09:00:00+08:00',
        endAt: '2025-04-01T10:30:00+08:00',
        payAmount: 1500,
        pickupCode: '385214',
      }),
      'history',
    )

    expect(instance.data.cellLine).toBe('S03 · 04-01 10:30')
    expect(instance.data.showPickupCode).toBe(false)
    expect(instance.data.amountLabel).toBe(ORDER_COPY.paidLabel)
    expect(instance.data.amount).toBe('¥15.00')
    expect(instance.data.showAction).toBe(false)
  })

  it('⚠️ 超时结束：金额词是「已付」，无行动', async () => {
    const instance = await render(
      order({
        status: 4,
        startAt: '2025-04-01T09:00:00+08:00',
        endAt: '2025-04-01T11:00:00+08:00',
        payAmount: 2400,
      }),
      'history',
    )

    expect(instance.data.amountLabel).toBe(ORDER_COPY.timeoutPaidLabel)
    expect(instance.data.amountLabel).toBe('已付')
    expect(instance.data.amount).toBe('¥24.00')
    expect(instance.data.showAction).toBe(false)
  })

  it('⚠️ 已结束（5）：有实付才显示，无行动', async () => {
    const instance = await render(
      order({
        status: 5,
        startAt: '2025-04-01T09:00:00+08:00',
        endAt: '2025-04-01T10:30:00+08:00',
        payAmount: 1500,
      }),
      'history',
    )

    expect(instance.data.amountLabel).toBe(ORDER_COPY.paidLabel)
    expect(instance.data.amount).toBe('¥15.00')
    expect(instance.data.showAction).toBe(false)
  })

  it('⚠️ 已退款：不显示金额（退款额不在契约里，「实付」会误导）', async () => {
    const instance = await render(
      order({
        status: 6,
        startAt: '2025-04-01T09:00:00+08:00',
        endAt: '2025-04-01T10:30:00+08:00',
        payAmount: 1500,
      }),
      'history',
    )

    expect(instance.data.showAmount).toBe(false)
    expect(instance.data.amount).toBe('')
    expect(instance.data.showAction).toBe(false)
  })

  it('⚠️ 已取消：不显示格口与时间，无金额、无行动', async () => {
    const instance = await render(
      order({ status: 7, cellNo: 'S03', startAt: null, endAt: null, payAmount: 1500 }),
      'history',
    )

    expect(instance.data.cellLine).toBe('')
    expect(instance.data.showAmount).toBe(false)
    expect(instance.data.showAction).toBe(false)
  })

  it('⚠️ 待支付兜底：按进行中呈现、无 CTA', async () => {
    const instance = await render(
      order({ status: 1, startAt: null, estimatedAmount: 1800 }),
      'active',
    )

    expect(instance.data.statusLabel).toBe('待支付')
    expect(instance.data.showAction).toBe(false)
  })

  it('⚠️ home 变体：无金额、无 CTA；有取件码就显示', async () => {
    const instance = await render(
      order({
        status: 2,
        startAt: '2025-04-01T09:00:00+08:00',
        estimatedAmount: 1800,
        payAmount: 1500,
        pickupCode: '385214',
      }),
      'home',
    )

    expect(instance.data.showAmount).toBe(false)
    expect(instance.data.showAction).toBe(false)
    expect(instance.data.showPickupCode).toBe(true)
    expect(instance.data.pickupCode).toBe('385214')
  })

  it('⚠️ 金额缺值时不编一个「¥0.00」出来', async () => {
    const instance = await render(
      order({ status: 2, startAt: '2025-04-01T09:00:00+08:00', estimatedAmount: null }),
      'active',
    )

    expect(instance.data.showAmount).toBe(false)
    expect(instance.data.amount).toBe('')
  })
})
