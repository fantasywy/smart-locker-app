// **取件确认层**（`pickup-sheet`）的契约 —— #65 / spec #57 §5。
//
// 本文件只驱动组件级 seam：`Component()` 定义 + `order` 观察者 + 方法 +
// `wx.request` 响应。断言的是**用户看到什么**（`data`）、**弹层发给了宿主什么**
// （`triggerEvent`）、**发出了哪些请求**（`13.11` → 必要时一次 `13.9`）。
//
// ⚠️ 组件**不导航**：成功后的去向由宿主决定（详情 `redirectTo`、列表 `navigateTo`）。
// 因此这里不会出现任何 `wx.*To` 的目标路径断言 —— 只断言「组件一次都没调」。
//
// ⚠️ 支付回执里的 `paid` / `openCommandIssued` 不参与判态（全站守卫在
// `test/startup/conventions.test.ts`）。本文件只从 `13.11` 取 `payAmount`。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWxStub, jsonResponse } from '../helpers/wx'
import { requestsTo, sentRequests } from '../helpers/http'
import { BASE_URL } from '../../miniprogram/request/config'
import { PICKUP_SHEET_COPY } from '../../miniprogram/startup/copy'
import type { PickupOrder } from '../../miniprogram/types/orders'
import type { InstalledWxStub, WxRequestOptions } from '../helpers/wx'

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
}))

vi.mock('../../miniprogram/utils/feedback', () => ({
  showToast: mocks.showToast,
}))

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const sheetDir = join(repoRoot, 'miniprogram', 'components', 'pickup-sheet')
const sheetSource = (): string =>
  readFileSync(join(sheetDir, 'pickup-sheet.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
const sheetWxml = (): string =>
  readFileSync(join(sheetDir, 'pickup-sheet.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
const sheetScss = (): string =>
  readFileSync(join(sheetDir, 'pickup-sheet.scss'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

const ORDER_ID = 1001
const PAY_URL = `${BASE_URL}/api/app/v1/orders/${ORDER_ID}/pay`
const DETAIL_URL = `${BASE_URL}/api/app/v1/orders/${ORDER_ID}`

/** 一份取件层需要的最小订单视图 —— 详情页由 `13.9` 的 order + locker 拼成。 */
function pickupOrder(overrides: Partial<PickupOrder> = {}): PickupOrder {
  return {
    id: ORDER_ID,
    status: 2,
    startAt: '2025-04-01T09:00:00+08:00',
    endAt: null,
    payAmount: null,
    estimatedAmount: 1800,
    siteName: '万达广场店',
    lockerNo: 'WD-01',
    cellNo: 'S03',
    ...overrides,
  }
}

function payBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 0,
    message: 'ok',
    data: {
      payNo: 'P-1',
      payAmount: 1800,
      channel: 1,
      paidAt: '2025-04-01T09:10:00+08:00',
      orderStatus: 2,
      paid: true,
      openCommandIssued: true,
      ...overrides,
    },
  }
}

function detailBody(orderOverrides: Record<string, unknown> = {}): Record<string, unknown> {
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
        startAt: '2025-04-01T09:00:00+08:00',
        endAt: null,
        estimatedAmount: 1800,
        pickupCode: '385214',
        ...orderOverrides,
      },
      locker: {
        id: 11,
        lockerNo: 'WD-01',
        siteName: '万达广场店',
        cellNo: 'S03',
        cellType: 2,
      },
      timeline: [],
      payments: [],
    },
  }
}

function businessError(code: number, message: string | null = 'boom'): Record<string, unknown> {
  return { code, message, data: null }
}

interface ComponentDefinition {
  properties: Record<string, { type?: unknown; value?: unknown }>
  data: Record<string, unknown>
  observers?: Record<string, (...args: unknown[]) => void>
  methods: Record<string, (...args: unknown[]) => unknown>
}

interface SheetInstance {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  triggerEvent: ReturnType<typeof vi.fn>
  onSubmit: () => void
  onKnow: () => void
  onDismiss: () => void
}

let definition: ComponentDefinition | null = null

beforeEach(() => {
  definition = null
  mocks.showToast.mockReset()
  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (def: Record<string, unknown>): void => {
    definition = def as unknown as ComponentDefinition
  }
})

async function loadComponent(): Promise<ComponentDefinition> {
  definition = null
  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (def: Record<string, unknown>): void => {
    definition = def as unknown as ComponentDefinition
  }
  vi.resetModules()
  await import('../../miniprogram/components/pickup-sheet/pickup-sheet')
  delete host.Component
  if (definition === null) throw new Error('pickup-sheet.ts 没有调用 Component()')
  return definition
}

function instantiate(def: ComponentDefinition): SheetInstance {
  const instance = {
    data: { ...def.data },
    setData(patch: Record<string, unknown>): void {
      Object.assign(instance.data, patch)
    },
    triggerEvent: vi.fn(),
  } as unknown as SheetInstance
  const writable = instance as unknown as Record<string, unknown>
  for (const [name, fn] of Object.entries(def.methods)) {
    writable[name] = fn.bind(instance)
  }
  return instance
}

/** 让挂起的微任务链走完（api → request 是纯 Promise 链）。 */
async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

/**
 * 手动排队的 `wx.request` 桩 —— 让「支付中」这个中间态可断言。
 *
 * `respondInOrder()` 会在下一个微任务就回话；而本文件需要先看到「支付中…」再回话。
 */
function pendingRequests(wx: InstalledWxStub): WxRequestOptions[] {
  const pending: WxRequestOptions[] = []
  wx.request.mockImplementation((options) => {
    pending.push(options)
  })
  return pending
}

async function openSheet(order: PickupOrder): Promise<SheetInstance> {
  const def = await loadComponent()
  const instance = instantiate(def)
  def.observers?.['order']?.call(instance, order)
  return instance
}

function view(instance: SheetInstance): Record<string, unknown> {
  return instance.data
}

// ---------------------------------------------------------------------------
// 三种金额分支
// ---------------------------------------------------------------------------

describe('#65 pickup-sheet · 三种金额分支', () => {
  it('⚠️ 入参只有 order，事件只有 success / dismiss / refresh', async () => {
    const def = await loadComponent()
    expect(Object.keys(def.properties)).toEqual(['order'])
    expect(Object.keys(def.methods).sort()).toEqual(
      ['onDismiss', 'onKnow', 'onSubmit'].sort(),
    )
  })

  it('⚠️ 首次支付（status=2 / payAmount=null）：参考金额 + 定稿说明 + 取件开门', async () => {
    const instance = await openSheet(pickupOrder())

    expect(view(instance).visible).toBe(true)
    expect(view(instance).locationLine).toBe('万达广场店 · WD-01 · S03')
    expect(view(instance).showEstimated).toBe(true)
    expect(view(instance).estimatedLabel).toBe(PICKUP_SHEET_COPY.referenceLabel)
    expect(view(instance).estimatedAmount).toBe('¥18.00')
    expect(view(instance).showPaid).toBe(false)
    expect(view(instance).note).toBe(PICKUP_SHEET_COPY.firstNote)
    expect(view(instance).actionLabel).toBe(PICKUP_SHEET_COPY.pickupAction)
  })

  it('⚠️ 幂等重开（status=2 / payAmount!=null）：实付 + 无需再次支付 + 取件开门', async () => {
    const instance = await openSheet(pickupOrder({ payAmount: 1800 }))

    expect(view(instance).showEstimated).toBe(false)
    expect(view(instance).showPaid).toBe(true)
    expect(view(instance).paidLabel).toBe(PICKUP_SHEET_COPY.actualPaidLabel)
    expect(view(instance).paidAmount).toBe('¥18.00')
    expect(view(instance).note).toBe(PICKUP_SHEET_COPY.reopenNote)
    expect(view(instance).actionLabel).toBe(PICKUP_SHEET_COPY.pickupAction)
  })

  it('⚠️ 已超时补缴（status=4 / endAt=null）：参考金额 + 已付（有值时）+ 补缴并开门', async () => {
    const instance = await openSheet(pickupOrder({ status: 4, payAmount: 500 }))

    expect(view(instance).showEstimated).toBe(true)
    expect(view(instance).estimatedLabel).toBe(PICKUP_SHEET_COPY.referenceLabel)
    expect(view(instance).showPaid).toBe(true)
    expect(view(instance).paidLabel).toBe(PICKUP_SHEET_COPY.paidLabel)
    expect(view(instance).paidAmount).toBe('¥5.00')
    expect(view(instance).note).toBe(PICKUP_SHEET_COPY.topUpNote)
    expect(view(instance).actionLabel).toBe(PICKUP_SHEET_COPY.topUpAction)
  })

  it('⚠️ 参考金额缺失时整行不渲染，绝不写「暂不可用」', async () => {
    const instance = await openSheet(pickupOrder({ estimatedAmount: null }))

    expect(view(instance).showEstimated).toBe(false)
    expect(view(instance).estimatedAmount).toBe('')
    expect(JSON.stringify(view(instance))).not.toContain('暂不可用')
  })
})

// ---------------------------------------------------------------------------
// 状态机与成功三态
// ---------------------------------------------------------------------------

describe('#65 pickup-sheet · 状态机与成功三态', () => {
  it('⚠️ 支付中：按钮「支付中…」、遮罩不可关、同一次请求在飞时重复提交被挡住', async () => {
    const wx = installWxStub()
    wx.switchTab.mockImplementation(() => {})
    wx.navigateTo.mockImplementation(() => {})
    wx.redirectTo.mockImplementation(() => {})
    const pending = pendingRequests(wx)
    const instance = await openSheet(pickupOrder())

    instance.onSubmit()
    instance.onSubmit()
    instance.onSubmit()
    await settle()

    expect(view(instance).phase).toBe('paying')
    expect(view(instance).actionLabel).toBe(PICKUP_SHEET_COPY.paying)
    expect(view(instance).actionDisabled).toBe(true)
    expect(view(instance).overlayClosable).toBe(false)
    expect(sentRequests(wx.request)).toHaveLength(1)
    expect(sentRequests(wx.request)[0]).toMatchObject({ url: PAY_URL, method: 'POST' })
    expect(pending).toHaveLength(1)

    // 支付中遮罩点击不关闭、不发 dismiss。
    instance.onDismiss()
    expect(view(instance).visible).toBe(true)
    expect(instance.triggerEvent).not.toHaveBeenCalled()
  })

  it('⚠️ 首次支付成功：标题「支付成功」+ 本次支付 ¥x（来自 13.11）+ 统一副行；必须点「知道了」才发 success', async () => {
    const wx = installWxStub()
    wx.switchTab.mockImplementation(() => {})
    wx.navigateTo.mockImplementation(() => {})
    wx.redirectTo.mockImplementation(() => {})
    const pending = pendingRequests(wx)
    const instance = await openSheet(pickupOrder())

    instance.onSubmit()
    await settle()
    pending[0]?.success?.(jsonResponse(payBody()))
    await settle()

    expect(view(instance).phase).toBe('success')
    expect(view(instance).showSuccess).toBe(true)
    expect(view(instance).successTitle).toBe(PICKUP_SHEET_COPY.successTitle)
    expect(view(instance).showSuccessAmount).toBe(true)
    expect(view(instance).successAmountLabel).toBe(PICKUP_SHEET_COPY.successAmountLabel)
    expect(view(instance).successAmount).toBe('¥18.00')
    expect(view(instance).successHint).toBe(PICKUP_SHEET_COPY.successHint)
    expect(view(instance).overlayClosable).toBe(false)

    // 成功态不自动跳转、也不自动发事件 —— 必须由用户点「知道了」。
    expect(instance.triggerEvent).not.toHaveBeenCalled()
    instance.onDismiss()
    expect(view(instance).visible).toBe(true)
    expect(instance.triggerEvent).not.toHaveBeenCalled()

    instance.onKnow()
    expect(instance.triggerEvent).toHaveBeenCalledTimes(1)
    expect(instance.triggerEvent.mock.calls[0]?.[0]).toBe('success')
    expect(view(instance).visible).toBe(false)
    expect(wx.switchTab).not.toHaveBeenCalled()
    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(wx.redirectTo).not.toHaveBeenCalled()
  })

  it('⚠️ 超时补缴成功：标题「支付成功」但**不显示金额**', async () => {
    const wx = installWxStub()
    const pending = pendingRequests(wx)
    const instance = await openSheet(pickupOrder({ status: 4, payAmount: 500 }))

    instance.onSubmit()
    await settle()
    pending[0]?.success?.(jsonResponse(payBody({ payAmount: 700 })))
    await settle()

    expect(view(instance).phase).toBe('success')
    expect(view(instance).successTitle).toBe(PICKUP_SHEET_COPY.successTitle)
    expect(view(instance).showSuccessAmount).toBe(false)
    expect(view(instance).successAmount).toBe('')
    expect(view(instance).successHint).toBe(PICKUP_SHEET_COPY.successHint)
  })

  it('⚠️ 幂等重开成功：标题「已发出开门指令」；13.11 返回的首笔金额不得冒充本次支付', async () => {
    const wx = installWxStub()
    const pending = pendingRequests(wx)
    const instance = await openSheet(pickupOrder({ payAmount: 1800 }))

    instance.onSubmit()
    await settle()
    pending[0]?.success?.(jsonResponse(payBody()))
    await settle()

    expect(view(instance).phase).toBe('success')
    expect(view(instance).successTitle).toBe(PICKUP_SHEET_COPY.reopenSuccessTitle)
    expect(view(instance).showSuccessAmount).toBe(false)
    expect(view(instance).successAmount).toBe('')
  })

  it('⚠️ 空闲态遮罩可关：发 dismiss，不刷新、不成功', async () => {
    const instance = await openSheet(pickupOrder())

    expect(view(instance).overlayClosable).toBe(true)
    instance.onDismiss()

    expect(view(instance).visible).toBe(false)
    expect(instance.triggerEvent).toHaveBeenCalledWith('dismiss')
  })
})

// ---------------------------------------------------------------------------
// 网络超时：先核对一次 13.9
// ---------------------------------------------------------------------------

describe('#65 pickup-sheet · 网络核对', () => {
  it('⚠️ 支付请求网络失败 → 「正在核对支付结果…」→ 只查一次 13.9', async () => {
    const wx = installWxStub()
    const pending = pendingRequests(wx)
    const instance = await openSheet(pickupOrder())

    instance.onSubmit()
    await settle()
    pending[0]?.fail?.({ errMsg: 'request:fail timeout' })
    await settle()

    expect(view(instance).phase).toBe('reconciling')
    expect(view(instance).showReconciling).toBe(true)
    expect(view(instance).reconcilingLabel).toBe(PICKUP_SHEET_COPY.reconciling)
    expect(view(instance).overlayClosable).toBe(false)
    expect(sentRequests(wx.request)).toHaveLength(2)
    expect(requestsTo(sentRequests(wx.request), DETAIL_URL)).toHaveLength(1)
  })

  it('⚠️ 核对到已支付且未取件 → 成功态，但**不显示本次支付金额**', async () => {
    const wx = installWxStub()
    const pending = pendingRequests(wx)
    const instance = await openSheet(pickupOrder())

    instance.onSubmit()
    await settle()
    pending[0]?.fail?.({ errMsg: 'request:fail timeout' })
    await settle()
    pending[1]?.success?.(jsonResponse(detailBody({ payAmount: 1800 })))
    await settle()

    expect(view(instance).phase).toBe('success')
    expect(view(instance).successTitle).toBe(PICKUP_SHEET_COPY.successTitle)
    expect(view(instance).showSuccessAmount).toBe(false)
    expect(view(instance).successAmount).toBe('')
    // 只有一次 13.9，不重发 13.11。
    expect(sentRequests(wx.request)).toHaveLength(2)
    expect(requestsTo(sentRequests(wx.request), PAY_URL)).toHaveLength(1)
  })

  it('⚠️ 核对到订单已终局 → 关闭并 refresh，不进成功态', async () => {
    const wx = installWxStub()
    const pending = pendingRequests(wx)
    const instance = await openSheet(pickupOrder())

    instance.onSubmit()
    await settle()
    pending[0]?.fail?.({ errMsg: 'request:fail timeout' })
    await settle()
    pending[1]?.success?.(
      jsonResponse(
        detailBody({ status: 3, endAt: '2025-04-01T10:30:00+08:00', payAmount: 1800 }),
      ),
    )
    await settle()

    expect(view(instance).visible).toBe(false)
    expect(view(instance).phase).toBe('idle')
    expect(instance.triggerEvent).toHaveBeenCalledWith('refresh', { missing: false })
    expect(view(instance).showSuccess).toBe(false)
  })

  it('⚠️ 核对不到支付 → 「没有查询到支付结果，请重试」，停留可重试', async () => {
    const wx = installWxStub()
    const pending = pendingRequests(wx)
    const instance = await openSheet(pickupOrder())

    instance.onSubmit()
    await settle()
    pending[0]?.fail?.({ errMsg: 'request:fail timeout' })
    await settle()
    pending[1]?.success?.(jsonResponse(detailBody({ payAmount: null })))
    await settle()

    expect(view(instance).visible).toBe(true)
    expect(view(instance).phase).toBe('failed')
    expect(view(instance).failureMessage).toBe(PICKUP_SHEET_COPY.noPayment)
  })

  it('⚠️ 核对请求本身失败 → 同样给「没有查询到支付结果，请重试」，不猜已付', async () => {
    const wx = installWxStub()
    const pending = pendingRequests(wx)
    const instance = await openSheet(pickupOrder())

    instance.onSubmit()
    await settle()
    pending[0]?.fail?.({ errMsg: 'request:fail timeout' })
    await settle()
    pending[1]?.fail?.({ errMsg: 'request:fail timeout' })
    await settle()

    expect(view(instance).phase).toBe('failed')
    expect(view(instance).failureMessage).toBe(PICKUP_SHEET_COPY.noPayment)
  })
})

// ---------------------------------------------------------------------------
// 五类失败归因
// ---------------------------------------------------------------------------

describe('#65 pickup-sheet · 失败归因', () => {
  async function submitWith(response: Record<string, unknown>): Promise<SheetInstance> {
    const wx = installWxStub()
    const pending = pendingRequests(wx)
    const instance = await openSheet(pickupOrder())
    instance.onSubmit()
    await settle()
    pending[0]?.success?.(jsonResponse(response))
    await settle()
    return instance
  }

  it('⚠️ 3002：逐字告知 → 关闭并 refresh 来源页', async () => {
    const instance = await submitWith(businessError(3002))

    expect(mocks.showToast).toHaveBeenCalledWith(PICKUP_SHEET_COPY.stateChanged)
    expect(view(instance).visible).toBe(false)
    expect(instance.triggerEvent).toHaveBeenCalledWith('refresh', { missing: false })
  })

  it('⚠️ 6001：逐字告知 → 停留，可重试', async () => {
    const instance = await submitWith(businessError(6001))

    expect(view(instance).visible).toBe(true)
    expect(view(instance).phase).toBe('failed')
    expect(view(instance).failureMessage).toBe(PICKUP_SHEET_COPY.feeUnavailable)
    expect(instance.triggerEvent).not.toHaveBeenCalled()
    expect(mocks.showToast).not.toHaveBeenCalled()
  })

  it('⚠️ 3001 / 8003：统一「订单不存在或已删除」→ 关闭并 refresh(missing)，宿主回列表', async () => {
    for (const code of [3001, 8003]) {
      mocks.showToast.mockReset()
      const instance = await submitWith(businessError(code))

      expect(mocks.showToast).toHaveBeenCalledWith(PICKUP_SHEET_COPY.missing)
      expect(view(instance).visible).toBe(false)
      expect(instance.triggerEvent).toHaveBeenCalledWith('refresh', { missing: true })
    }
  })

  it('⚠️ 其他业务码：服务端 message 直出，停留可重试', async () => {
    const instance = await submitWith(businessError(9999, '后端给的原因'))

    expect(view(instance).phase).toBe('failed')
    expect(view(instance).failureMessage).toBe('后端给的原因')
    expect(view(instance).visible).toBe(true)
    expect(instance.triggerEvent).not.toHaveBeenCalled()
  })

  it('⚠️ 其他业务码且无 message：兜底「请稍后重试」，停留可重试', async () => {
    const instance = await submitWith(businessError(9999, null))

    expect(view(instance).phase).toBe('failed')
    expect(view(instance).failureMessage).toBe(PICKUP_SHEET_COPY.fallback)
  })

  it('⚠️ 失败态允许重试：再点主按钮会再发一次 13.11', async () => {
    const wx = installWxStub()
    const pending = pendingRequests(wx)
    const instance = await openSheet(pickupOrder())

    instance.onSubmit()
    await settle()
    pending[0]?.success?.(jsonResponse(businessError(6001)))
    await settle()
    expect(view(instance).phase).toBe('failed')

    instance.onSubmit()
    await settle()
    expect(view(instance).phase).toBe('paying')
    expect(sentRequests(wx.request)).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 源码守卫：组件永远不替宿主做决定
// ---------------------------------------------------------------------------

describe('#65 pickup-sheet · 源码守卫', () => {
  it('⚠️ 组件不导航、不写路径字面量、不碰 storage、不直接 import Vant 反馈', async () => {
    const source = sheetSource()
    expect(source).not.toMatch(/\bwx\s*\.\s*(navigateTo|redirectTo|switchTab|reLaunch)\b/)
    expect(source).not.toMatch(/url:\s*['"`]\/?pages\//)
    expect(source).not.toContain('/api/app/v1')
    expect(source).not.toMatch(/\bwx\s*\.\s*(get|set|remove)Storage(Sync)?\b/)
    expect(source).not.toContain('@vant/weapp')
  })

  it('⚠️ wxml 没有中文文案 —— 每一个字都来自 copy.ts', () => {
    expect(sheetWxml()).not.toMatch(/[\u4e00-\u9fa5]/)
  })

  it('⚠️ 弹层是 Vant 的底部 popup：round + 阴影 custom-class', async () => {
    const wxml = sheetWxml()
    expect(wxml).toContain('position="bottom"')
    expect(wxml).toContain('round="{{ true }}"')
    expect(wxml).toContain('custom-class="app-popup-shadow pickup-sheet"')
    expect(wxml).toContain('close-on-click-overlay="{{ overlayClosable }}"')
  })

  it('⚠️ 样式只走 token：零裸 hex、无 transition / animation、根节点显式主文字色', async () => {
    const scss = sheetScss()
    expect(scss.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([])
    expect(scss).not.toMatch(/\btransition(?:-[\w-]+)?\s*:/)
    expect(scss).not.toMatch(/\banimation(?:-[\w-]+)?\s*:/)
    expect(scss).not.toContain(':active')
    const rootBlock = /\.pickup-sheet\s*\{([^}]*)\}/s.exec(scss)?.[1] ?? ''
    expect(rootBlock).toMatch(/color:\s*v\.\$color-text-main/)
  })

  it('⚠️ 非取件条件（待存入 / 历史单）即使被误传也不渲染', async () => {
    const waiting = await openSheet(pickupOrder({ startAt: null }))
    expect(view(waiting).visible).toBe(false)
    expect(view(waiting).phase).toBe('idle')
  })
})
