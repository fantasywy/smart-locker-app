// **等待关门页** 的验收 —— ticket #63 / spec #57 §4 + §14。
//
// ## 这个文件挡的是什么
//
// 等待页全部是「看起来能跑」的错：
//   • 把「已发出开门指令」写成「门已开」—— C 端根本证明不了门开过；
//   • 轮询用 `setInterval` 或真实等待 —— 60 秒窗口在测试里不可控，且慢网会叠请求；
//   • `onHide` 不停表 —— 用户切后台后还在打 13.9；
//   • 终局后还在轮询 —— 订单已结束，页面还在刷新；
//   • 手动核对无变化却假装页面会继续自动更新；
//   • 取消 3002 说成一句通用失败 —— 契约逐字是「柜门已开启，请放入物品后关门，或联系客服」；
//   • 取件停滞重开 `13.11` 时用非幂等端点 / 不二次确认；
//   • 非终局渲染金额，或页面自己写 `/100`。
//
// ⇒ 断言一律落在**外部行为**：页面 `data`（界面画了什么）、`wx.*` 调用
// （跳转去了哪）、请求（GET/POST、URL、顺序）。轮询用假计时器驱动，不真等。
//
// ⚠️ `showToast` / `confirm` / `alert` 用 `vi.mock` 换掉反馈适配层：
// 本文件验的是「页面让用户看到哪句话 / 弹窗按钮是什么」，Vant 内部由
// `test/utils/feedback.test.ts` 负责。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWxStub, jsonResponse } from '../helpers/wx'
import { requestsTo, respondInOrder, sentRequests } from '../helpers/http'
import { deferred, installFakeTimers } from '../helpers/timers'
import { BASE_URL } from '../../miniprogram/request/config'
import {
  HOME_PAGE_COPY,
  ORDER_LIST_PATH,
  PAGE_TITLES,
  WAITING_PAGE_COPY,
} from '../../miniprogram/startup/copy'
import { LOCKER_PATH } from '../../miniprogram/utils/routes'
import type { FakeTimers } from '../helpers/timers'
import type { InstalledWxStub, WxRequestSuccessResult } from '../helpers/wx'

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
const waitingDir = join(repoRoot, 'miniprogram', 'pages', 'waiting')
const waitingSource = (): string =>
  readFileSync(join(waitingDir, 'waiting.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
const waitingWxml = (): string =>
  readFileSync(join(waitingDir, 'waiting.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
const waitingScss = (): string =>
  readFileSync(join(waitingDir, 'waiting.scss'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

const ORDER_ID = 1001
const DETAIL_URL = `${BASE_URL}/api/app/v1/orders/${ORDER_ID}`
const CANCEL_URL = `${DETAIL_URL}/cancel`
const PAY_URL = `${DETAIL_URL}/pay`

/** 一份契约形状的 `13.9` 响应体 —— 默认是「存入等待」（status=2 / startAt=null）。 */
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
      timeline: [{ event: 'CREATED', title: '下单', at: '2025-04-01T09:00:00+08:00' }],
      payments: [],
    },
  }
}

/** 存入等待（可取消）。 */
function dropWaitingBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return detailBody({ status: 2, startAt: null, endAt: null, ...overrides })
}

/** 取件等待：`TIMEOUT` 单已付款，但关门事件还没到（endAt 为空）。 */
function pickupWaitingBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return detailBody({
    status: 4,
    startAt: '2025-04-01T09:00:00+08:00',
    endAt: null,
    payAmount: 1800,
    ...overrides,
  })
}

/** 一份业务错误响应体（HTTP 200 + `code ≠ 0`）。 */
function businessError(code: number): Record<string, unknown> {
  return { code, message: 'boom', data: null }
}

/** `13.11` 的成功回执 —— 页面不应读取 `paid` / `openCommandIssued`。 */
function paySuccessBody(): Record<string, unknown> {
  return {
    code: 0,
    message: 'ok',
    data: {
      payNo: 'P20250401001',
      payAmount: 1800,
      channel: 1,
      paidAt: '2025-04-01T10:35:00+08:00',
      orderStatus: 4,
      paid: true,
      openCommandIssued: true,
    },
  }
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
  await import('../../miniprogram/pages/waiting/waiting')
  if (definition === null) throw new Error('waiting.ts 没有调用 Component()')
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
    throw new Error('waiting.ts 没有可调用的 onLoad —— 页面参数无处可去')
  }
  return instance
}

/** 界面画了什么 —— 断言走这个视图，避免依赖页面内部字段的组织方式。 */
interface WaitingView {
  phase: string
  mainStatement: string
  nextStep: string
  showAutoUpdate: boolean
  stalledHint: string
  networkHint: string
  showManualCheck: boolean
  manualCheckLabel: string
  manualCheckDisabled: boolean
  showCancel: boolean
  showReopen: boolean
  terminalTitle: string
  terminalHint: string
  terminalChip: string
  pickupCode: string
  showPickupCode: boolean
  amountLabel: string
  amountText: string
  showAmount: boolean
  showRescan: boolean
}

function viewOf(page: PageInstance): WaitingView {
  return page.data as unknown as WaitingView
}

/**
 * 装桩 → 加载页面 → `onLoad(options)` → 首查回来 → `onShow()`。
 *
 * ⚠️ 真实小程序的顺序是 onLoad 紧接着 onShow；页面用「首次 onShow 不重置窗口」
 * 来避免把刚发出的首查取消掉。测试复现这个顺序，后面的 hide/show 才有意义。
 */
async function enter(
  options: Record<string, string>,
  responses: readonly ArrangedResponse[],
): Promise<{ wx: InstalledWxStub; page: PageInstance; timers: FakeTimers }> {
  const timers = installFakeTimers()
  const wx = installWxStub()
  wx.switchTab.mockImplementation(() => {})
  wx.redirectTo.mockImplementation(() => {})
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
  await timers.settle()
  ;(page.onShow as () => void)()
  return { wx, page, timers }
}

/** 推进 N 个 3 秒轮询间隔。 */
async function tickPolls(timers: FakeTimers, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await timers.tick(3000)
  }
}

function detailRequests(wx: InstalledWxStub) {
  return requestsTo(sentRequests(wx.request), DETAIL_URL)
}

describe('#63 等待页 · 逐字文案', () => {
  it('⚠️ 主陈述 / 下一步 / 停滞 / 终局 / 取消 / 重开文案都与 spec §4 逐字一致', () => {
    expect(WAITING_PAGE_COPY).toMatchObject({
      mainStatement: '已发出开门指令',
      dropNext: '请放入物品，然后关好柜门',
      pickupNext: '请取出物品，然后关好柜门',
      autoUpdate: '柜门关闭后，页面会自动更新',
      stalledHint: '如果柜门已经关好，这里可能不会立刻变化；可以稍后在订单里查看',
      manualCheck: '我关好门了，再核对一次',
      checking: '正在核对…',
      noUpdate: '暂时没有更新，可以稍后在订单里查看',
      networkHint: '网络不太顺，正在重试',
      backToOrders: '回订单列表',
      storedTitle: '已存入',
      pickupCodeLabel: '取件码',
      storedHint: '取件码已生成，可在订单里随时查看',
      pickedTitle: '已完成取件',
      timeoutChip: '超时结束',
      paidLabel: '实付',
      timeoutPaidLabel: '已付',
      cancelledTitle: '订单已取消',
      cancelledHint: '没有产生费用',
      rescan: '重新扫码',
      endedTitle: '已结束',
      refundedTitle: '已退款',
      endedHint: '如有疑问请联系客服',
      missingTitle: '订单不存在或已删除',
      cancelTitle: '取消这单？',
      cancelMessage: '取消后格口会释放，不会产生费用。',
      cancelDismiss: '再想想',
      cancelAction: '取消订单',
      cancelSuccess: '订单已取消',
      cancelRejected: '柜门已开启，请放入物品后关门，或联系客服',
      reopenLink: '柜门没有反应？重新开门',
      reopenTitle: '重新开门？',
      reopenMessage: '将再次向柜机发出开门指令，请确认您仍在柜机前。',
      reopenCancel: '取消',
      reopenAction: '重新开门',
      reopenSuccess: '已重新发出开门指令',
      reopenFailed: '没收到结果，请稍后重试',
    })
  })

  it('⚠️ 导航栏标题来自文案层，且 `back=false`', async () => {
    const { page } = await enter({ orderId: String(ORDER_ID), mode: 'drop' }, [dropWaitingBody()])

    expect(page.data.title).toBe(PAGE_TITLES['pages/waiting/waiting'])
    expect(waitingWxml()).toContain('back="{{false}}"')
  })
})

describe('#63 等待页 · 首屏', () => {
  it('⚠️ 只说「已发出开门指令」+ 存入下一步；非终局不出现金额 / 倒计时 / 分钟数', async () => {
    const { page } = await enter(
      { orderId: String(ORDER_ID), openTimeoutMinutes: '10', mode: 'drop' },
      [dropWaitingBody()],
    )
    const view = viewOf(page)

    expect(view.phase).toBe('waiting')
    expect(view.mainStatement).toBe(WAITING_PAGE_COPY.mainStatement)
    expect(view.nextStep).toBe(WAITING_PAGE_COPY.dropNext)
    expect(view.showAutoUpdate).toBe(true)
    expect(view.showCancel).toBe(true)
    expect(view.showManualCheck).toBe(false)
    expect(view.showAmount).toBe(false)
    expect(view.amountText).toBe('')
    // `openTimeoutMinutes` 只接收、不消费 —— 数据区里没有分钟数。
    expect(JSON.stringify(page.data)).not.toContain('分钟')
    expect(waitingSource()).not.toContain('openTimeoutMinutes')
  })

  it('⚠️ 取件等待：`status=4` 且 `endAt=null` 仍算等待，下一步是取件', async () => {
    const { page } = await enter(
      { orderId: String(ORDER_ID), mode: 'pickup' },
      [pickupWaitingBody()],
    )
    const view = viewOf(page)

    expect(view.phase).toBe('waiting')
    expect(view.nextStep).toBe(WAITING_PAGE_COPY.pickupNext)
    expect(view.showCancel).toBe(false)
    expect(view.showReopen).toBe(false)
    expect(view.showAmount).toBe(false)
  })

  it('⚠️ `mode` 缺失时按回显推断方向：startAt 为空 → 存入', async () => {
    const { page } = await enter({ orderId: String(ORDER_ID) }, [dropWaitingBody()])

    expect(viewOf(page).nextStep).toBe(WAITING_PAGE_COPY.dropNext)
  })

  it('⚠️ `mode` 缺失且 startAt 非空 → 取件', async () => {
    const { page } = await enter({ orderId: String(ORDER_ID) }, [pickupWaitingBody()])

    expect(viewOf(page).nextStep).toBe(WAITING_PAGE_COPY.pickupNext)
  })
})

describe('#63 等待页 · 轮询窗口', () => {
  it('⚠️ 前台 3 秒 × 20 次（60 秒）后进停滞，之后不再请求', async () => {
    const { wx, page, timers } = await enter(
      { orderId: String(ORDER_ID), mode: 'drop' },
      Array.from({ length: 21 }, () => dropWaitingBody()),
    )

    expect(detailRequests(wx)).toHaveLength(1)
    expect(detailRequests(wx)[0]?.method).toBe('GET')
    await tickPolls(timers, 19)
    expect(viewOf(page).phase).toBe('waiting')
    expect(detailRequests(wx)).toHaveLength(20)

    await tickPolls(timers, 1)
    expect(viewOf(page).phase).toBe('stalled')
    expect(viewOf(page).showManualCheck).toBe(true)
    expect(viewOf(page).showAutoUpdate).toBe(false)
    expect(viewOf(page).stalledHint).toBe(WAITING_PAGE_COPY.stalledHint)
    expect(detailRequests(wx)).toHaveLength(21)

    await timers.tick(9000)
    expect(detailRequests(wx)).toHaveLength(21)
  })

  it('⚠️ `onHide` 停表；`onShow` 重开一个 20 次窗口；`onUnload` 停表', async () => {
    const { wx, page, timers } = await enter(
      { orderId: String(ORDER_ID), mode: 'drop' },
      Array.from({ length: 31 }, () => dropWaitingBody()),
    )

    await tickPolls(timers, 10)
    expect(detailRequests(wx)).toHaveLength(11)

    ;(page.onHide as () => void)()
    await timers.tick(9000)
    expect(detailRequests(wx)).toHaveLength(11)

    ;(page.onShow as () => void)()
    await tickPolls(timers, 19)
    expect(viewOf(page).phase).toBe('waiting')
    await tickPolls(timers, 1)
    expect(viewOf(page).phase).toBe('stalled')
    expect(detailRequests(wx)).toHaveLength(31)

    ;(page.onUnload as () => void)()
    await timers.tick(9000)
    expect(detailRequests(wx)).toHaveLength(31)
  })

  it('⚠️ 检测到终局立即停表，且不自动跳转', async () => {
    const { wx, page, timers } = await enter(
      { orderId: String(ORDER_ID), mode: 'drop' },
      [
        dropWaitingBody(),
        detailBody({ status: 2, startAt: '2025-04-01T09:00:00+08:00', pickupCode: '385214' }),
      ],
    )

    expect(viewOf(page).phase).toBe('waiting')
    await tickPolls(timers, 1)

    expect(viewOf(page).phase).toBe('stored')
    expect(viewOf(page).pickupCode).toBe('385214')
    expect(viewOf(page).showPickupCode).toBe(true)
    expect(wx.redirectTo).not.toHaveBeenCalled()
    expect(wx.navigateTo).not.toHaveBeenCalled()

    await timers.tick(9000)
    expect(detailRequests(wx)).toHaveLength(2)
  })
})

describe('#63 等待页 · 核对失败与手动核对', () => {
  it('⚠️ 单次失败静默，连续两次失败给网络提示并继续轮询', async () => {
    const { wx, page, timers } = await enter(
      { orderId: String(ORDER_ID), mode: 'drop' },
      [
        dropWaitingBody(),
        { errMsg: 'request:fail timeout' },
        { errMsg: 'request:fail timeout' },
        dropWaitingBody(),
      ],
    )

    await tickPolls(timers, 1)
    expect(viewOf(page).phase).toBe('waiting')
    expect(mocks.showToast).not.toHaveBeenCalled()

    await tickPolls(timers, 1)
    expect(viewOf(page).phase).toBe('trouble')
    expect(viewOf(page).networkHint).toBe(WAITING_PAGE_COPY.networkHint)
    expect(viewOf(page).showManualCheck).toBe(true)
    expect(viewOf(page).showAutoUpdate).toBe(true)

    await tickPolls(timers, 1)
    expect(viewOf(page).phase).toBe('waiting')
    expect(detailRequests(wx)).toHaveLength(4)
  })

  it('⚠️ 停滞后的手动核对仍无变化 → 一句提示，页面保持停滞', async () => {
    const { wx, page, timers } = await enter(
      { orderId: String(ORDER_ID), mode: 'drop' },
      Array.from({ length: 22 }, () => dropWaitingBody()),
    )
    await tickPolls(timers, 20)
    expect(viewOf(page).phase).toBe('stalled')

    ;(page.onManualCheck as () => void)()
    await timers.settle()

    expect(mocks.showToast).toHaveBeenCalledWith({
      message: WAITING_PAGE_COPY.noUpdate,
      duration: 3000,
    })
    expect(viewOf(page).phase).toBe('stalled')
    expect(viewOf(page).showManualCheck).toBe(true)

    await timers.tick(9000)
    expect(detailRequests(wx)).toHaveLength(22)
  })

  it('⚠️ 手动核对在飞时按钮显示「正在核对…」并禁用', async () => {
    const { wx, page, timers } = await enter(
      { orderId: String(ORDER_ID), mode: 'drop' },
      Array.from({ length: 21 }, () => dropWaitingBody()),
    )
    await tickPolls(timers, 20)
    expect(viewOf(page).phase).toBe('stalled')

    const gate = deferred<WxRequestSuccessResult>()
    wx.request.mockImplementationOnce((options) => {
      void gate.promise.then((result) => options.success?.(result))
    })
    ;(page.onManualCheck as () => void)()
    await timers.settle()

    expect(viewOf(page).phase).toBe('checking')
    expect(viewOf(page).showManualCheck).toBe(true)
    expect(viewOf(page).manualCheckLabel).toBe(WAITING_PAGE_COPY.checking)
    expect(viewOf(page).manualCheckDisabled).toBe(true)

    gate.resolve(jsonResponse(dropWaitingBody()))
    await timers.settle()
    expect(viewOf(page).phase).toBe('stalled')
  })
})

describe('#63 等待页 · 九种落点', () => {
  interface TerminalCase {
    name: string
    body: Record<string, unknown>
    phase: string
    title: string
    hint?: string
    pickupCode?: string
    amountLabel?: string
    amountText?: string
    chip?: string
    showAmount?: boolean
    showRescan?: boolean
  }

  const terminalCases: readonly TerminalCase[] = [
    {
      name: '已存入 + 取件码',
      body: detailBody({
        status: 2,
        startAt: '2025-04-01T09:00:00+08:00',
        pickupCode: '385214',
        payAmount: null,
      }),
      phase: 'stored',
      title: WAITING_PAGE_COPY.storedTitle,
      hint: WAITING_PAGE_COPY.storedHint,
      pickupCode: '385214',
      showAmount: false,
    },
    {
      name: '已完成取件 + 实付',
      body: detailBody({
        status: 3,
        startAt: '2025-04-01T09:00:00+08:00',
        endAt: '2025-04-01T11:30:00+08:00',
        payAmount: 1800,
      }),
      phase: 'picked',
      title: WAITING_PAGE_COPY.pickedTitle,
      hint: '',
      amountLabel: WAITING_PAGE_COPY.paidLabel,
      amountText: '¥18.00',
      showAmount: true,
    },
    {
      name: '超时结束 + 已付',
      body: detailBody({
        status: 4,
        startAt: '2025-04-01T09:00:00+08:00',
        endAt: '2025-04-01T11:30:00+08:00',
        payAmount: 2400,
      }),
      phase: 'timeoutEnd',
      title: WAITING_PAGE_COPY.pickedTitle,
      chip: WAITING_PAGE_COPY.timeoutChip,
      amountLabel: WAITING_PAGE_COPY.timeoutPaidLabel,
      amountText: '¥24.00',
      showAmount: true,
    },
    {
      name: '订单已取消',
      body: detailBody({ status: 7 }),
      phase: 'cancelled',
      title: WAITING_PAGE_COPY.cancelledTitle,
      hint: WAITING_PAGE_COPY.cancelledHint,
      showRescan: true,
    },
    {
      name: '已结束',
      body: detailBody({ status: 5, endAt: '2025-04-01T11:30:00+08:00' }),
      phase: 'ended',
      title: WAITING_PAGE_COPY.endedTitle,
      hint: WAITING_PAGE_COPY.endedHint,
    },
    {
      name: '已退款',
      body: detailBody({ status: 6, endAt: '2025-04-01T11:30:00+08:00' }),
      phase: 'ended',
      title: WAITING_PAGE_COPY.refundedTitle,
      hint: WAITING_PAGE_COPY.endedHint,
      showAmount: false,
    },
  ]

  for (const testCase of terminalCases) {
    it(`⚠️ 终局逐字：${testCase.name}`, async () => {
      const { page } = await enter(
        { orderId: String(ORDER_ID), mode: 'drop' },
        [testCase.body],
      )
      const view = viewOf(page)

      expect(view.phase).toBe(testCase.phase)
      expect(view.terminalTitle).toBe(testCase.title)
      expect(view.terminalHint).toBe(testCase.hint ?? '')
      expect(view.showPickupCode).toBe(testCase.pickupCode !== undefined)
      if (testCase.pickupCode !== undefined) expect(view.pickupCode).toBe(testCase.pickupCode)
      expect(view.showAmount).toBe(testCase.showAmount ?? false)
      if (testCase.amountLabel !== undefined) expect(view.amountLabel).toBe(testCase.amountLabel)
      if (testCase.amountText !== undefined) expect(view.amountText).toBe(testCase.amountText)
      if (testCase.chip !== undefined) expect(view.terminalChip).toBe(testCase.chip)
      expect(view.showRescan).toBe(testCase.showRescan ?? false)
      expect(view.showCancel).toBe(false)
      expect(view.showReopen).toBe(false)
      expect(view.showManualCheck).toBe(false)
    })
  }

  it('⚠️ 订单不存在（3001）与非本人（8003）统一成同一句，并提供回订单列表', async () => {
    for (const code of [3001, 8003] as const) {
      const { wx, page, timers } = await enter(
        { orderId: String(ORDER_ID), mode: 'drop' },
        [businessError(code)],
      )

      expect(viewOf(page).phase).toBe('missing')
      expect(viewOf(page).terminalTitle).toBe(WAITING_PAGE_COPY.missingTitle)
      expect(detailRequests(wx)).toHaveLength(1)

      ;(page.onBackToOrders as () => void)()
      expect(wx.switchTab.mock.calls[0]?.[0]).toMatchObject({ url: `/${ORDER_LIST_PATH}` })

      await timers.tick(9000)
      expect(detailRequests(wx)).toHaveLength(1)
    }
  })
})

describe('#63 等待页 · 存入取消', () => {
  it('⚠️ 二次确认文案逐字；成功后 toast + 切取消终局，且不再轮询', async () => {
    const { wx, page, timers } = await enter(
      { orderId: String(ORDER_ID), mode: 'drop' },
      [dropWaitingBody(), { code: 0, message: 'ok', data: null }],
    )

    ;(page.onCancel as () => void)()
    await timers.settle()

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.confirm.mock.calls[0]?.[0]).toMatchObject({
      title: WAITING_PAGE_COPY.cancelTitle,
      message: WAITING_PAGE_COPY.cancelMessage,
      cancelText: WAITING_PAGE_COPY.cancelDismiss,
      confirmText: WAITING_PAGE_COPY.cancelAction,
    })
    expect(detailRequests(wx)).toHaveLength(1)
    const cancelRequests = sentRequests(wx.request).filter((request) => request.url === CANCEL_URL)
    expect(cancelRequests).toHaveLength(1)
    expect(cancelRequests[0]?.method).toBe('POST')
    expect(mocks.showToast).toHaveBeenCalledWith(WAITING_PAGE_COPY.cancelSuccess)
    expect(viewOf(page).phase).toBe('cancelled')
    expect(viewOf(page).terminalTitle).toBe(WAITING_PAGE_COPY.cancelledTitle)
    expect(viewOf(page).terminalHint).toBe(WAITING_PAGE_COPY.cancelledHint)
    expect(viewOf(page).showRescan).toBe(true)

    await timers.tick(9000)
    expect(detailRequests(wx)).toHaveLength(1)
  })

  it('⚠️ 服务端 3002 → 契约逐字弹窗；页面仍在等待且轮询继续（不重试取消）', async () => {
    const { wx, page, timers } = await enter(
      { orderId: String(ORDER_ID), mode: 'drop' },
      [dropWaitingBody(), businessError(3002), dropWaitingBody()],
    )

    ;(page.onCancel as () => void)()
    await timers.settle()

    expect(mocks.alert).toHaveBeenCalledTimes(1)
    expect(mocks.alert.mock.calls[0]?.[0]).toMatchObject({
      message: WAITING_PAGE_COPY.cancelRejected,
    })
    expect(viewOf(page).phase).toBe('waiting')
    expect(viewOf(page).showCancel).toBe(true)
    // 取消请求只发了一次 —— 存入路径没有重试。
    expect(sentRequests(wx.request).filter((request) => request.url === CANCEL_URL)).toHaveLength(1)

    await tickPolls(timers, 1)
    expect(detailRequests(wx)).toHaveLength(2)
  })

  it('⚠️ 用户点「再想想」→ 不发取消请求', async () => {
    mocks.confirm.mockResolvedValueOnce(false)
    const { wx, page } = await enter(
      { orderId: String(ORDER_ID), mode: 'drop' },
      [dropWaitingBody()],
    )

    ;(page.onCancel as () => void)()
    await Promise.resolve()
    await Promise.resolve()

    expect(sentRequests(wx.request).filter((request) => request.url === CANCEL_URL)).toHaveLength(0)
    expect(viewOf(page).phase).toBe('waiting')
  })
})

describe('#63 等待页 · 取件停滞重新开门', () => {
  it('⚠️ 二次确认后重发 13.11；成功 toast 并回到等待（重新开窗）', async () => {
    const { wx, page, timers } = await enter(
      { orderId: String(ORDER_ID), mode: 'pickup' },
      [
        ...Array.from({ length: 21 }, () => pickupWaitingBody()),
        paySuccessBody(),
        pickupWaitingBody(),
      ],
    )
    await tickPolls(timers, 20)
    expect(viewOf(page).phase).toBe('stalled')
    expect(viewOf(page).showReopen).toBe(true)

    ;(page.onReopen as () => void)()
    await timers.settle()

    expect(mocks.confirm.mock.calls[0]?.[0]).toMatchObject({
      title: WAITING_PAGE_COPY.reopenTitle,
      message: WAITING_PAGE_COPY.reopenMessage,
      cancelText: WAITING_PAGE_COPY.reopenCancel,
      confirmText: WAITING_PAGE_COPY.reopenAction,
    })
    const payRequests = sentRequests(wx.request).filter((request) => request.url === PAY_URL)
    expect(payRequests).toHaveLength(1)
    expect(payRequests[0]?.method).toBe('POST')
    expect(mocks.showToast).toHaveBeenCalledWith(WAITING_PAGE_COPY.reopenSuccess)
    expect(viewOf(page).phase).toBe('waiting')

    await tickPolls(timers, 1)
    expect(detailRequests(wx)).toHaveLength(22)
  })

  it('⚠️ 重新开门失败 → toast「没收到结果，请稍后重试」，留在停滞', async () => {
    const { wx, page, timers } = await enter(
      { orderId: String(ORDER_ID), mode: 'pickup' },
      [...Array.from({ length: 21 }, () => pickupWaitingBody()), { errMsg: 'request:fail timeout' }],
    )
    await tickPolls(timers, 20)
    expect(viewOf(page).phase).toBe('stalled')

    ;(page.onReopen as () => void)()
    await timers.settle()

    expect(mocks.showToast).toHaveBeenCalledWith(WAITING_PAGE_COPY.reopenFailed)
    expect(viewOf(page).phase).toBe('stalled')
    expect(viewOf(page).showReopen).toBe(true)
    expect(sentRequests(wx.request).filter((request) => request.url === PAY_URL)).toHaveLength(1)
  })
})

describe('#63 等待页 · 出口', () => {
  it('⚠️ 取消终局的「重新扫码」：解析出柜机码后 redirectTo 柜机页', async () => {
    const { wx, page } = await enter(
      { orderId: String(ORDER_ID), mode: 'drop' },
      [detailBody({ status: 7 })],
    )
    wx.scanCode.mockImplementation((options) => {
      options.success?.({ result: 'https://locker.example.com/l/WD-01' })
    })

    ;(page.onRescan as () => void)()

    expect(wx.redirectTo).toHaveBeenCalledTimes(1)
    expect(wx.redirectTo.mock.calls[0]?.[0]).toMatchObject({
      url: `/${LOCKER_PATH}?code=WD-01`,
    })
    expect(wx.navigateTo).not.toHaveBeenCalled()
  })

  it('⚠️ 扫到非柜机码留在本页提示；扫码失败（取消之外）一句通用提示', async () => {
    const { wx, page } = await enter(
      { orderId: String(ORDER_ID), mode: 'drop' },
      [detailBody({ status: 7 })],
    )

    wx.scanCode.mockImplementation((options) => {
      options.success?.({ result: 'https://example.com/not-a-locker' })
    })
    ;(page.onRescan as () => void)()
    expect(mocks.showToast).toHaveBeenCalledWith(HOME_PAGE_COPY.notLockerCode)

    mocks.showToast.mockReset()
    wx.scanCode.mockImplementation((options) => {
      options.fail?.({ errMsg: 'scanCode:fail camera' })
    })
    ;(page.onRescan as () => void)()
    expect(mocks.showToast).toHaveBeenCalledWith(HOME_PAGE_COPY.scanFailed)

    mocks.showToast.mockReset()
    wx.scanCode.mockImplementation((options) => {
      options.fail?.({ errMsg: 'scanCode:fail cancel' })
    })
    ;(page.onRescan as () => void)()
    expect(mocks.showToast).not.toHaveBeenCalled()
    expect(wx.redirectTo).not.toHaveBeenCalled()
  })

  it('⚠️ 「回订单列表」走 switchTab', async () => {
    const { wx, page } = await enter(
      { orderId: String(ORDER_ID), mode: 'drop' },
      [dropWaitingBody()],
    )

    ;(page.onBackToOrders as () => void)()
    expect(wx.switchTab.mock.calls[0]?.[0]).toMatchObject({ url: `/${ORDER_LIST_PATH}` })
  })
})

describe('#63 等待页 · 源码守卫', () => {
  it('⚠️ 页面不写路径字面量、不读写 storage、不出现 `/100`', () => {
    const code = waitingSource()

    const inlined: string[] = []
    for (const match of code.matchAll(/^\s*const\s+\w*PATH\w*\s*=\s*['"`](pages\/[^'"`]+)['"`]/gm)) {
      inlined.push(match[1] ?? '')
    }
    for (const match of code.matchAll(/url\s*:\s*['"`]\/?(pages\/[^'"`?]+)/g)) {
      inlined.push(match[1] ?? '')
    }
    expect(inlined).toEqual([])

    for (const api of ['getStorageSync', 'setStorageSync', 'removeStorageSync', 'getStorage']) {
      expect(code, `waiting.ts 里出现了 ${api}`).not.toContain(api)
    }
    expect(code).not.toMatch(/\/\s*100\b/)
  })

  it('⚠️ 模板不出现分钟数 / 指令状态 / 进度条，且带反馈宿主', () => {
    const wxml = waitingWxml()
    expect(wxml).not.toContain('openTimeoutMinutes')
    expect(wxml).not.toMatch(/分钟|倒计时|进度/)
    expect(wxml).toContain('<van-toast id="van-toast" />')
    expect(wxml).toContain('<van-dialog id="van-dialog" />')
  })

  it('⚠️ 页面样式没有自绘 transition / animation / opacity', () => {
    const scss = waitingScss()
    expect(scss).not.toMatch(/\btransition\s*:/)
    expect(scss).not.toMatch(/@keyframes/)
    expect(scss).not.toMatch(/\bopacity\s*:/)
  })
})
