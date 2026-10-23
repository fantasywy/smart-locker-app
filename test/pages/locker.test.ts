// **柜机页（四档）** 的验收 —— issue #62，spec #57 §3。
//
// ## 这个文件挡的是什么
//
// 四档改造里最像「看着能跑」的错，全都不报错、手测也未必看得出来：
//   • 格口类型仍是字符串枚举 —— 请求发得到，但服务端认不出，订单建不出来；
//   • `extraLarge` 漏掉 —— 第四档永远显示 0 / 不可点，用户以为柜机没有特大格；
//   • 任一档为 0 就把「预约」整体置灰 —— 旧三档页的行为，已被 spec 明确推翻；
//   • 建单成功用 `navigateTo` —— 返回键会退回一个**已经建过单**的页面；
//   • 提交中不防重复 —— `13.7` 不幂等，连点两次真的抢两个格口；
//   • 首屏预选一档 —— 用户以为自己已经选好了。
//
// ⇒ 断言一律落在**外部行为**上：页面 `data`（界面画了什么）、`wx.*` 调用
// （跳转去了哪、用了哪个 API）、请求体（发出去的到底是什么）。
//
// ⚠️ 柜机上下文只能来自扫码：`docs/adr/0001-c-end-no-locker-browsing.md`。
// 本页零 storage —— 下面有运行期与源码两道守卫。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installWxStub, jsonResponse, reply } from '../helpers/wx'
import { respondInOrder, requestsTo, sentRequests } from '../helpers/http'
import { deferred } from '../helpers/timers'
import { BASE_URL } from '../../miniprogram/request/config'
import { LOCKER_PAGE_COPY, PAGE_TITLES, RETRY_LABEL } from '../../miniprogram/startup/copy'
import { RESERVATION_CREATE_PATH, WAITING_PATH } from '../../miniprogram/utils/routes'
import type { WxRequestOptions, WxRequestSuccessResult } from '../helpers/wx'
import type { InstalledWxStub } from '../helpers/wx'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

const LOCKER_URL = `${BASE_URL}/api/app/v1/lockers/by-code?code=WD-01`
const CREATE_ORDER_URL = `${BASE_URL}/api/app/v1/orders`

/** 一份契约形状的 `13.6` 响应体 —— 默认是一台**四档都有余位**的柜机。 */
function lockerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 0,
    message: 'ok',
    data: {
      id: 11,
      code: 'WD-01',
      siteId: 3,
      siteName: '望京 SOHO T1',
      position: 'B1 层 3 号电梯口',
      online: true,
      status: 1,
      cellAvailability: { small: 4, medium: 2, large: 1, extraLarge: 3 },
      ...overrides,
    },
  }
}

/** 一份契约形状的 `13.7` 响应体。 */
function createOrderBody(openTimeoutMinutes = 10): Record<string, unknown> {
  return {
    code: 0,
    message: 'ok',
    data: { orderId: 1001, orderNo: '20250401001', cellNo: 'M05', openTimeoutMinutes },
  }
}

/** 一个业务错误响应体（HTTP 200 + `code ≠ 0`）。 */
function businessError(code: number, message = 'boom'): Record<string, unknown> {
  return { code, message, data: null }
}

let definition: Record<string, unknown> | null = null

/** 控制栈深 —— 柜机页的导航出口按 `getCurrentPages().length` 分叉。 */
function setPageDepth(depth: number): void {
  ;(globalThis as unknown as Record<string, unknown>).getCurrentPages = () =>
    Array.from({ length: depth }, () => ({}))
}

beforeEach(() => {
  definition = null
  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (def: Record<string, unknown>): void => {
    definition = def
  }
  setPageDepth(1)
})

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).getCurrentPages
})

async function loadPage(): Promise<Record<string, unknown>> {
  vi.resetModules()
  await import('../../miniprogram/pages/locker/locker')
  if (definition === null) throw new Error('locker.ts 没有调用 Component()')
  return definition
}

interface PageInstance {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  triggerEvent: (name: string) => void
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
  if (typeof instance.onLoad !== 'function') {
    throw new Error('locker.ts 没有可调用的 onLoad —— 页面参数无处可去')
  }
  return instance
}

type BodyOrFailure =
  | { body: Record<string, unknown> }
  | { failure: { errMsg: string } }

/** 装桩 → 加载页面 → 用给定的 `onLoad(options)` 进入。 */
async function enter(
  options: Record<string, string>,
  responses: readonly BodyOrFailure[],
  depth = 1,
): Promise<{ wx: InstalledWxStub; page: PageInstance }> {
  const wx = installWxStub()
  setPageDepth(depth)
  wx.login.mockImplementation(reply({ code: 'WX-CODE', errMsg: 'login:ok' }))
  wx.request.mockImplementation(
    respondInOrder(responses.map((r) => ('failure' in r ? r.failure : jsonResponse(r.body)))),
  )
  wx.switchTab.mockImplementation(() => {})
  wx.navigateTo.mockImplementation(() => {})
  wx.redirectTo.mockImplementation(() => {})
  wx.showModal.mockImplementation(() => {})
  wx.showToast.mockImplementation(() => {})

  const def = await loadPage()
  const page = instantiate(def)
  ;(page.onLoad as (options: Record<string, string>) => void)(options)
  await settle()
  return { wx, page }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

/** 四档渲染行 —— 断言一律走它，避免依赖页面内部的字段组织方式。 */
interface CellRowView {
  type: number
  label: string
  available: number
  state: 'normal' | 'soldout' | 'offline'
  selected: boolean
}

function cellOf(page: PageInstance, type: 1 | 2 | 3 | 4): CellRowView {
  const cells = page.data.cells as CellRowView[]
  const row = cells.find((cell) => cell.type === type)
  if (row === undefined) {
    throw new Error(
      `界面上没有第 ${type} 档 —— 实际渲染的是 [${cells.map((c) => c.type).join(', ')}]`,
    )
  }
  return row
}

function selectCell(page: PageInstance, type: 1 | 2 | 3 | 4): void {
  ;(page.onSelectCell as (event: { detail: { type: number } }) => void)({ detail: { type } })
}

function openConfirm(page: PageInstance): void {
  ;(page.onPrimary as () => void)()
}

function confirmCreate(page: PageInstance): void {
  ;(page.onConfirmCreate as () => void)()
}

describe('#62 柜机页 · 四档渲染与选择', () => {
  it('⚠️ 渲染站点名 + 位置 + 四档（小 / 中 / 大 / 特大）与各自余位', async () => {
    const { page } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }])

    expect(page.data.siteName).toBe('望京 SOHO T1')
    expect(page.data.position).toBe('B1 层 3 号电梯口')
    expect((page.data.cells as CellRowView[]).map((c) => c.type)).toEqual([1, 2, 3, 4])
    expect(cellOf(page, 1)).toMatchObject({
      label: LOCKER_PAGE_COPY.cellTypeLabels[1],
      available: 4,
      state: 'normal',
    })
    expect(cellOf(page, 2)).toMatchObject({
      label: LOCKER_PAGE_COPY.cellTypeLabels[2],
      available: 2,
      state: 'normal',
    })
    expect(cellOf(page, 3)).toMatchObject({
      label: LOCKER_PAGE_COPY.cellTypeLabels[3],
      available: 1,
      state: 'normal',
    })
    expect(cellOf(page, 4)).toMatchObject({
      label: LOCKER_PAGE_COPY.cellTypeLabels[4],
      available: 3,
      state: 'normal',
    })
  })

  it('⚠️ 首屏不预选：底栏「请选择格口 / 四档均可存」，CTA 置灰', async () => {
    const { page } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }])

    expect(page.data.selectedType).toBeNull()
    for (const type of [1, 2, 3, 4] as const) {
      expect(cellOf(page, type).selected, `第 ${type} 档首屏不该被选中`).toBe(false)
    }
    expect(page.data.barTitle).toBe(LOCKER_PAGE_COPY.chooseCell)
    expect(page.data.barHint).toBe(LOCKER_PAGE_COPY.allCellsAvailable)
    expect(page.data.ctaEnabled).toBe(false)
    expect(page.data.ctaLabel).toBe(LOCKER_PAGE_COPY.cta)
  })

  it('⚠️ 选中一档 → 底栏「已选 中格口 / 余 2 个」，CTA 可点，且只有这一档被选中', async () => {
    const { page } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }])

    selectCell(page, 2)

    expect(page.data.selectedType).toBe(2)
    expect(page.data.barTitle).toBe(LOCKER_PAGE_COPY.selectedCell.replace('{label}', '中格口'))
    expect(page.data.barHint).toBe(LOCKER_PAGE_COPY.remaining.replace('{count}', '2'))
    expect(page.data.ctaEnabled).toBe(true)
    expect(cellOf(page, 2).selected).toBe(true)
    for (const type of [1, 3, 4] as const) {
      expect(cellOf(page, type).selected).toBe(false)
    }
  })

  it('⚠️ 售罄 / 离线档点了不会选中，也不会成为建单规格', async () => {
    const { page } = await enter({ code: 'WD-01' }, [
      { body: lockerBody({ cellAvailability: { small: 4, medium: 0, large: 0, extraLarge: 3 } }) },
    ])

    selectCell(page, 2)
    selectCell(page, 3)

    expect(page.data.selectedType).toBeNull()
    expect(page.data.ctaEnabled).toBe(false)
  })

  it('⚠️ 任何状态都不出现金额 —— 页面 data 里没有金额字样 / 符号', async () => {
    const { page } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }])
    selectCell(page, 2)

    const visible = JSON.stringify(page.data)
    expect(visible).not.toContain('¥')
    expect(visible).not.toContain('金额')
    expect(visible).not.toContain('价格')
  })
})

describe('#62 柜机页 · 逐档置灰与预约入口', () => {
  it('⚠️ 某档为 0 只灰该档，其他档照常可点，预约入口**不**整体置灰', async () => {
    const { page } = await enter({ code: 'WD-01' }, [
      { body: lockerBody({ cellAvailability: { small: 4, medium: 0, large: 2, extraLarge: 0 } }) },
    ])

    expect(cellOf(page, 1).state).toBe('normal')
    expect(cellOf(page, 2).state).toBe('soldout')
    expect(cellOf(page, 3).state).toBe('normal')
    expect(cellOf(page, 4).state).toBe('soldout')
    expect(cellOf(page, 1).available).toBe(4)
    expect(cellOf(page, 3).available).toBe(2)

    // ⚠️ 旧三档页在「任一档为 0」时把预约入口整体置灰，spec §3 明确推翻：
    // 预约页自己按档位判断，本页只在离线 / 四档全满时拦住。
    expect(page.data.reserveEnabled).toBe(true)
    expect(page.data.reserveReason).toBe('')
  })

  it('⚠️ 柜机离线是正常响应：完整渲染 + 四档「不可用」+ 页内原因，不弹 toast / modal', async () => {
    const { wx, page } = await enter({ code: 'WD-01' }, [
      {
        body: lockerBody({
          online: false,
          status: 2,
          cellAvailability: { small: 0, medium: 0, large: 0, extraLarge: 0 },
        }),
      },
    ])

    expect(page.data.siteName).toBe('望京 SOHO T1')
    expect(page.data.position).toBe('B1 层 3 号电梯口')
    expect(page.data.lockerUsable).toBe(false)
    expect(page.data.lockerReason).toBe(LOCKER_PAGE_COPY.lockerUnavailableReason)
    expect(page.data.phase).toBe('ready')
    for (const type of [1, 2, 3, 4] as const) {
      expect(cellOf(page, type).state, `离线时第 ${type} 档没有置灰`).toBe('offline')
    }
    expect(page.data.barTitle).toBe(LOCKER_PAGE_COPY.offlineBarTitle)
    expect(page.data.barHint).toBe(LOCKER_PAGE_COPY.offlineBarHint)
    expect(page.data.ctaEnabled).toBe(false)
    expect(page.data.reserveEnabled).toBe(false)
    expect(page.data.reserveReason).toBe(LOCKER_PAGE_COPY.lockerUnavailableReason)
    expect(wx.showModal).not.toHaveBeenCalled()
    expect(wx.showToast).not.toHaveBeenCalled()
  })

  it('⚠️ 四档全满也是正常响应：四档「已满」+ 底栏「暂无可存格口」+ 不弹窗', async () => {
    const { wx, page } = await enter({ code: 'WD-01' }, [
      { body: lockerBody({ cellAvailability: { small: 0, medium: 0, large: 0, extraLarge: 0 } }) },
    ])

    expect(page.data.phase).toBe('ready')
    for (const type of [1, 2, 3, 4] as const) {
      expect(cellOf(page, type).state).toBe('soldout')
    }
    expect(page.data.barTitle).toBe(LOCKER_PAGE_COPY.allSoldOutBarTitle)
    expect(page.data.barHint).toBe(LOCKER_PAGE_COPY.allSoldOutBarHint)
    expect(page.data.ctaEnabled).toBe(false)
    expect(page.data.reserveEnabled).toBe(false)
    expect(page.data.reserveReason).toBe(LOCKER_PAGE_COPY.allSoldOutReserveReason)
    expect(wx.showModal).not.toHaveBeenCalled()
    expect(wx.showToast).not.toHaveBeenCalled()
  })

  it('⚠️ 预约入口只在离线 / 四档全满时置灰，点击带 lockerId 用 navigateTo', async () => {
    const { wx, page } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }])

    expect(page.data.reserveEnabled).toBe(true)
    ;(page.onReserve as () => void)()
    await settle()

    const url = (wx.navigateTo.mock.calls[0]?.[0] as { url: string } | undefined)?.url ?? ''
    expect(url).toContain(RESERVATION_CREATE_PATH)
    expect(url).toContain('lockerId=11')
    // 预约是「去看一眼」，不是移交 —— 必须是 navigateTo。
    expect(wx.redirectTo).not.toHaveBeenCalled()
  })

  it('⚠️ 置灰的预约入口点了什么都不做', async () => {
    const { wx, page } = await enter({ code: 'WD-01' }, [
      { body: lockerBody({ cellAvailability: { small: 0, medium: 0, large: 0, extraLarge: 0 } }) },
    ])
    expect(page.data.reserveEnabled).toBe(false)

    ;(page.onReserve as () => void)()
    await settle()

    expect(wx.navigateTo).not.toHaveBeenCalled()
  })

  it('⚠️ 可用性只读 `online` —— 不在客户端维护 status 清单', async () => {
    const { page } = await enter({ code: 'WD-01' }, [
      {
        body: lockerBody({
          online: true,
          // 2 是 OFFLINE 的原始码；服务端收敛后的 online=true 才是权威。
          status: 2,
          cellAvailability: { small: 2, medium: 2, large: 2, extraLarge: 2 },
        }),
      },
    ])

    expect(page.data.lockerUsable).toBe(true)
    expect(cellOf(page, 2).state).toBe('normal')
  })
})

describe('#62 柜机页 · 入口失效 / 加载失败', () => {
  it('⚠️ 解析不出 code → 入口失效页，且不发 13.6', async () => {
    const { wx, page } = await enter({}, [])

    expect(page.data.phase).toBe('entryFailed')
    expect(page.data.entryFailedTitle).toBe(LOCKER_PAGE_COPY.unusableCodeTitle)
    expect(requestsTo(sentRequests(wx.request), LOCKER_URL)).toEqual([])
  })

  it('⚠️ 13.6 → 1002 与解析失败是**同一个页面**，只换文案', async () => {
    const { page: invalid } = await enter({ q: 'https%3A%2F%2Fx.com%2Fl%2F' }, [])
    const { page: gone } = await enter({ code: 'WD-01' }, [
      { body: businessError(1002, '柜机不存在') },
    ])

    expect(gone.data.phase).toBe(invalid.data.phase)
    expect(gone.data.entryFailedTitle).toBe(LOCKER_PAGE_COPY.staleStickerTitle)
    expect(gone.data.entryFailedTitle).not.toBe(invalid.data.entryFailedTitle)
  })

  it('⚠️ 三个来源进入时 13.6 的查询串逐字相同', async () => {
    const seen: string[] = []
    const entries: Record<string, string>[] = [
      { q: 'https%3A%2F%2Flocker.example.com%2Fl%2FWD-01' },
      { code: 'WD-01' },
      { scanResult: 'https://locker.example.com/l/WD-01' },
    ]
    for (const options of entries) {
      const { wx } = await enter(options, [{ body: lockerBody() }])
      const urls = sentRequests(wx.request).map((r) => r.url)
      seen.push(urls.find((u) => u.includes('by-code')) ?? '(没有查柜机)')
    }
    expect(seen).toEqual([LOCKER_URL, LOCKER_URL, LOCKER_URL])
  })

  it('⚠️ 非 1002 的失败 → 页内 loadFailed（不停骨架屏）+ 底栏说明', async () => {
    const { page } = await enter({ code: 'WD-01' }, [
      { failure: { errMsg: 'request:fail timeout' } },
    ])

    expect(page.data.phase).toBe('loadFailed')
    expect(page.data.loadFailedDetail).toBe(LOCKER_PAGE_COPY.loadFailedDetail)
    expect(page.data.barTitle).toBe(LOCKER_PAGE_COPY.loadFailedBarTitle)
    expect(page.data.barHint).toBe(LOCKER_PAGE_COPY.loadFailedBarHint)
    expect(page.data.ctaEnabled).toBe(false)
    expect(page.data.entryFailedTitle).not.toBe(LOCKER_PAGE_COPY.staleStickerTitle)
  })

  it('⚠️ 重试真的重发 13.6，成功后进 ready', async () => {
    const wx = installWxStub()
    wx.login.mockImplementation(reply({ code: 'WX-CODE', errMsg: 'login:ok' }))
    wx.request.mockImplementation(
      respondInOrder([{ errMsg: 'request:fail timeout' }, jsonResponse(lockerBody())]),
    )
    wx.switchTab.mockImplementation(() => {})
    wx.navigateTo.mockImplementation(() => {})
    wx.redirectTo.mockImplementation(() => {})
    wx.showModal.mockImplementation(() => {})
    wx.showToast.mockImplementation(() => {})

    const def = await loadPage()
    const page = instantiate(def)
    ;(page.onLoad as (options: Record<string, string>) => void)({ code: 'WD-01' })
    await settle()
    expect(page.data.phase).toBe('loadFailed')

    ;(page.onRetryLoad as () => void)()
    await settle()

    expect(page.data.phase).toBe('ready')
    expect(page.data.siteName).toBe('望京 SOHO T1')
    expect(requestsTo(sentRequests(wx.request), LOCKER_URL)).toHaveLength(2)
  })
})

describe('#62 柜机页 · 确认弹层与建单', () => {
  it('⚠️ 点 CTA 先开二次确认，不直接建单；弹层展示站点 / 档位 / 余位', async () => {
    const { wx, page } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }])
    selectCell(page, 2)

    openConfirm(page)
    await settle()

    expect(page.data.confirmVisible).toBe(true)
    expect(page.data.confirmTitle).toBe(LOCKER_PAGE_COPY.confirmTitle)
    expect(page.data.confirmSiteName).toBe('望京 SOHO T1')
    expect(page.data.confirmCellValue).toBe('中格口')
    expect(page.data.confirmRemainingValue).toBe(
      LOCKER_PAGE_COPY.remaining.replace('{count}', '2'),
    )
    expect(page.data.confirmActionLabel).toBe(LOCKER_PAGE_COPY.confirmAction)
    expect(page.data.cancelLabel).toBe(LOCKER_PAGE_COPY.cancel)
    // 二次确认 = 还没下单。
    expect(requestsTo(sentRequests(wx.request), CREATE_ORDER_URL)).toEqual([])
    expect(wx.redirectTo).not.toHaveBeenCalled()
  })

  it('⚠️ 取消关闭弹层，不发建单请求', async () => {
    const { wx, page } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }])
    selectCell(page, 2)
    openConfirm(page)

    ;(page.onCancelSheet as () => void)()
    await settle()

    expect(page.data.confirmVisible).toBe(false)
    expect(requestsTo(sentRequests(wx.request), CREATE_ORDER_URL)).toEqual([])
    expect(wx.redirectTo).not.toHaveBeenCalled()
  })

  it('⚠️ 确认后请求体是数字码 { lockerId, cellType: 2 }', async () => {
    const { wx, page } = await enter({ code: 'WD-01' }, [
      { body: lockerBody() },
      { body: createOrderBody() },
    ])
    selectCell(page, 2)
    openConfirm(page)

    confirmCreate(page)
    await settle()

    const posts = requestsTo(sentRequests(wx.request), CREATE_ORDER_URL)
    expect(posts).toHaveLength(1)
    expect(posts[0]?.method).toBe('POST')
    expect(posts[0]?.data).toEqual({ lockerId: 11, cellType: 2 })
  })

  it('⚠️⚠️ 成功必须 redirectTo 等待页（带 orderId / openTimeoutMinutes / mode=drop），不是 navigateTo', async () => {
    const { wx, page } = await enter({ code: 'WD-01' }, [
      { body: lockerBody() },
      { body: createOrderBody(7) },
    ])
    selectCell(page, 2)
    openConfirm(page)
    confirmCreate(page)
    await settle()

    expect(wx.redirectTo).toHaveBeenCalledTimes(1)
    expect(wx.navigateTo).not.toHaveBeenCalled()
    const url = (wx.redirectTo.mock.calls[0]?.[0] as { url: string }).url
    expect(url).toContain(WAITING_PATH)
    expect(url).toContain('orderId=1001')
    // ⚠️ 用 7 而不是缺省 10 —— 写死缺省值的实现会在这条红。
    expect(url).toContain('openTimeoutMinutes=7')
    expect(url).toContain('mode=drop')
  })

  it('⚠️ 每档各自带自己的数字码 —— 选特大档发 4', async () => {
    const { wx, page } = await enter({ code: 'WD-01' }, [
      { body: lockerBody() },
      { body: createOrderBody() },
    ])
    selectCell(page, 4)
    openConfirm(page)
    confirmCreate(page)
    await settle()

    expect(requestsTo(sentRequests(wx.request), CREATE_ORDER_URL)[0]?.data).toEqual({
      lockerId: 11,
      cellType: 4,
    })
  })

  it('⚠️⚠️ 提交中：保留选中、卡片不可点、CTA「正在下单…」+ spinner、遮罩不可关、防重复', async () => {
    const gate = deferred<WxRequestSuccessResult>()
    const wx = installWxStub()
    wx.login.mockImplementation(reply({ code: 'WX-CODE', errMsg: 'login:ok' }))
    let call = 0
    wx.request.mockImplementation((options: WxRequestOptions) => {
      call += 1
      if (call === 1) {
        queueMicrotask(() => options.success?.(jsonResponse(lockerBody())))
        return
      }
      // 建单请求挂在闸门上 —— 测试决定它什么时候回来。
      void gate.promise.then((response) => options.success?.(response))
    })
    wx.switchTab.mockImplementation(() => {})
    wx.navigateTo.mockImplementation(() => {})
    wx.redirectTo.mockImplementation(() => {})
    wx.showModal.mockImplementation(() => {})
    wx.showToast.mockImplementation(() => {})

    const def = await loadPage()
    const page = instantiate(def)
    ;(page.onLoad as (options: Record<string, string>) => void)({ code: 'WD-01' })
    await settle()
    selectCell(page, 2)
    openConfirm(page)

    confirmCreate(page)
    // 第二次点击发生在第一单还挂在半空时。
    confirmCreate(page)
    await settle()

    expect(page.data.submitting).toBe(true)
    expect(page.data.selectedType).toBe(2)
    expect(page.data.ctaLabel).toBe(LOCKER_PAGE_COPY.submitting)
    expect(page.data.ctaLoading).toBe(true)
    expect(page.data.ctaEnabled).toBe(false)
    expect(page.data.confirmOverlayClosable).toBe(false)
    // 卡片在提交中不可点：再选一档不会改变选择。
    selectCell(page, 4)
    expect(page.data.selectedType).toBe(2)
    // 防重复：只发了一次建单。
    expect(requestsTo(sentRequests(wx.request), CREATE_ORDER_URL)).toHaveLength(1)

    gate.resolve(jsonResponse(createOrderBody()))
    await settle()
    expect(wx.redirectTo).toHaveBeenCalledTimes(1)
  })

  it('⚠️ 提交失败：就地「下单失败，请重试」，保留选择，不跳转、不弹 toast', async () => {
    const { wx, page } = await enter({ code: 'WD-01' }, [
      { body: lockerBody() },
      { body: businessError(5000, 'server exploded') },
    ])
    selectCell(page, 2)
    openConfirm(page)
    confirmCreate(page)
    await settle()

    expect(page.data.submitError).toBe(LOCKER_PAGE_COPY.submitFailed)
    expect(page.data.selectedType).toBe(2)
    expect(page.data.submitting).toBe(false)
    expect(page.data.ctaEnabled).toBe(true)
    expect(page.data.confirmVisible).toBe(false)
    expect(wx.redirectTo).not.toHaveBeenCalled()
    expect(wx.showToast).not.toHaveBeenCalled()
  })

  it('⚠️ 4004 用柜机不可用原因就地解释', async () => {
    const { page } = await enter({ code: 'WD-01' }, [
      { body: lockerBody() },
      { body: businessError(4004, 'locker offline') },
    ])
    selectCell(page, 2)
    openConfirm(page)
    confirmCreate(page)
    await settle()

    expect(page.data.submitError).toBe(LOCKER_PAGE_COPY.lockerUnavailableReason)
  })

  it('⚠️ 8002 用「该规格已满」就地解释', async () => {
    const { page } = await enter({ code: 'WD-01' }, [
      { body: lockerBody() },
      { body: businessError(8002, 'full') },
    ])
    selectCell(page, 2)
    openConfirm(page)
    confirmCreate(page)
    await settle()

    expect(page.data.submitError).toBe(LOCKER_PAGE_COPY.cellTypeFullReason)
  })
})

describe('#62 柜机页 · 导航出口', () => {
  it('⚠️ 冷启动栈深 1：左「首页」+ 右「我的订单」，不是返回箭头', async () => {
    const { page } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }], 1)

    expect(page.data.navHome).toBe(true)
    expect(page.data.navOrders).toBe(true)
    expect(page.data.navBack).toBe(false)
  })

  it('⚠️ 栈深 > 1：左返回 + 右「我的订单」', async () => {
    const { page } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }], 3)

    expect(page.data.navBack).toBe(true)
    expect(page.data.navHome).toBe(false)
    expect(page.data.navOrders).toBe(true)
  })

  it('⚠️ 入口失效页的「我的订单」走 switchTab 到订单 tab', async () => {
    const { wx, page } = await enter({}, [])

    ;(page.onMyOrders as () => void)()
    await settle()

    expect((wx.switchTab.mock.calls[0]?.[0] as { url: string } | undefined)?.url).toBe(
      '/pages/index/index',
    )
  })

  it('⚠️ 入口失效页「重新扫码」复用同一条解析 + 查询链路', async () => {
    const wx = installWxStub()
    wx.login.mockImplementation(reply({ code: 'WX-CODE', errMsg: 'login:ok' }))
    wx.request.mockImplementation(respondInOrder([jsonResponse(lockerBody())]))
    wx.switchTab.mockImplementation(() => {})
    wx.navigateTo.mockImplementation(() => {})
    wx.redirectTo.mockImplementation(() => {})
    wx.showModal.mockImplementation(() => {})
    wx.showToast.mockImplementation(() => {})
    wx.scanCode.mockImplementation((options) => {
      options.success?.({ result: 'https://locker.example.com/l/WD-01' })
    })

    const def = await loadPage()
    const page = instantiate(def)
    ;(page.onLoad as (options: Record<string, string>) => void)({})
    await settle()
    expect(page.data.phase).toBe('entryFailed')

    ;(page.onRescan as () => void)()
    await settle()

    expect(page.data.phase).toBe('ready')
    expect(requestsTo(sentRequests(wx.request), LOCKER_URL)).toHaveLength(1)
  })
})


describe('#62 柜机页 · 模板结构（页面 data 真的被画出来）', () => {
  function template(): string {
    return readFileSync(
      join(repoRoot, 'miniprogram', 'pages', 'locker', 'locker.wxml'),
      'utf8',
    )
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
  }

  it('⚠️ 2×2 网格逐档渲染 cell-card，五个入参全部接线', () => {
    const wxml = template()
    expect(wxml).toContain('<cell-card')
    for (const prop of ['type', 'label', 'available', 'state', 'selected']) {
      expect(wxml, `cell-card 没有接 ${prop}`).toContain(`${prop}="{{ item.${prop} }}"`)
    }
    expect(wxml).toContain('bind:select="onSelectCell"')
  })

  it('⚠️ 导航栏三个出口与确认弹层都在模板里', () => {
    const wxml = template()
    expect(wxml).toContain('homeButton="{{ navHome }}"')
    expect(wxml).toContain('ordersButton="{{ navOrders }}"')
    expect(wxml).toContain('back="{{ navBack }}"')
    expect(wxml).toContain('<van-popup')
    expect(wxml).toContain('close-on-click-overlay="{{ confirmOverlayClosable }}"')
    expect(wxml).toContain('bind:click-overlay="onCancelSheet"')
    expect(wxml).toContain('bind:click="onConfirmCreate"')
  })

  it('⚠️ 提交中不靠整页透明度 —— 页面样式里没有 opacity', () => {
    const scss = readFileSync(
      join(repoRoot, 'miniprogram', 'pages', 'locker', 'locker.scss'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(scss).not.toMatch(/opacity\s*:/)
  })
})

describe('#62 柜机页 · 上下文与工程纪律', () => {
  it('⚠️ 运行期零写入 storage —— 柜机上下文不进 storage（ADR-0001）', async () => {
    const { wx } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }])

    expect(wx.setStorageSync).not.toHaveBeenCalled()
    expect(wx.removeStorageSync).not.toHaveBeenCalled()
    for (const [key] of wx.getStorageSync.mock.calls) {
      expect(String(key)).toMatch(/^auth\./)
    }
  })

  it('⚠️ 本页源码里一个 storage API 都没有', async () => {
    const source = readFileSync(
      join(repoRoot, 'miniprogram', 'pages', 'locker', 'locker.ts'),
      'utf8',
    )
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    for (const api of ['getStorageSync', 'setStorageSync', 'removeStorageSync', 'getStorage']) {
      expect(code, `locker.ts 里出现了 ${api}`).not.toContain(api)
    }
  })

  it('⚠️ 页面里不出现任何页面路径字面量 —— 一律从 utils/routes / copy 引', async () => {
    const source = readFileSync(
      join(repoRoot, 'miniprogram', 'pages', 'locker', 'locker.ts'),
      'utf8',
    )
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const inlined: string[] = []
    for (const m of code.matchAll(/^\s*const\s+\w*PATH\w*\s*=\s*['"`](pages\/[^'"`]+)['"`]/gm)) {
      inlined.push(m[1] ?? '')
    }
    for (const m of code.matchAll(/url\s*:\s*['"`]\/?(pages\/[^'"`?]+)/g)) {
      inlined.push(m[1] ?? '')
    }
    expect(inlined).toEqual([])
  })

  it('⚠️ 导航栏标题来自文案层', async () => {
    const { page } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }])
    expect(page.data.title).toBe(PAGE_TITLES['pages/locker/locker'])
  })

  it('⚠️ 重试按钮复用全局 RETRY_LABEL —— 同一个动作只有一个名字', async () => {
    const { page } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }])
    expect(page.data.retryLabel).toBe(RETRY_LABEL)
  })

  it('⚠️ 两个跳转常量都注册在 app.json 里', async () => {
    const appJson = JSON.parse(
      readFileSync(join(repoRoot, 'miniprogram', 'app.json'), 'utf8'),
    ) as { pages: string[] }
    expect(appJson.pages).toContain(WAITING_PATH)
    expect(appJson.pages).toContain(RESERVATION_CREATE_PATH)
  })
})
