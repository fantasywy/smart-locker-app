// **柜机页**的验收 —— issue #26 的全部行为断言。
//
// ## 这个文件为什么必须存在（它挡的是什么）
//
// 票面有 12 条 Acceptance criteria，其中**只有 2 条**是纯函数能覆盖的
// （`resolveLockerCode` 的三来源与零 storage 的源码守卫）。
// 剩下的全部关于**页面的行为**：四种非正常进入是不是同一个页面、置灰有没有写明原因、
// 「开始存件」用的是 `redirectTo` 还是 `navigateTo`、`openTimeoutMinutes` 从哪来。
//
// 这些恰好是**最像「看着能跑」的错**：
//   • 把 `online=false` 做成 `wx.showModal` —— 手测时「弹窗出现了，功能正常」，
//     而票面明说那是**正常响应**、要做成页内说明；
//   • 用 `navigateTo` 进等待态 —— 功能上照样能跳，「等待态渲染出来了」全绿，
//     而返回键会退回柜机页并**再开一次门**（`08` §2 逐字）；
//   • `openTimeoutMinutes` 写死 10 —— 一辈子看不出来，直到运营改了配置。
//
// ⇒ 判据全部落在**外部行为**上：`setData` 收到了什么（界面画了什么）、
// `wx.*` 被调了什么（跳转与请求）、请求体里发了什么。不测页面内部怎么组织方法。
//
// 柜机上下文只能来自扫码：`docs/adr/0001-c-end-no-locker-browsing.md`。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installWxStub, jsonResponse, reply } from '../helpers/wx'
import { respondInOrder, requestsTo, sentRequests } from '../helpers/http'
import { BASE_URL } from '../../miniprogram/request/config'
import { LOCKER_PAGE_COPY, PAGE_TITLES } from '../../miniprogram/startup/copy'
import { RESERVATION_CREATE_PATH, WAITING_PATH } from '../../miniprogram/utils/routes'
import type { InstalledWxStub } from '../helpers/wx'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

const LOCKER_URL = `${BASE_URL}/api/app/v1/lockers/by-code?code=WD-01`
const CREATE_ORDER_URL = `${BASE_URL}/api/app/v1/orders`


/** 一份契约形状的 `13.6` 响应体 —— 默认是一台**完全可用**的柜机。 */
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
      status: 'ONLINE',
      cellAvailability: { small: 4, medium: 2, large: 0 },
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

/** 一个业务错误响应体（HTTP 200 + `code ≠ 0`，`07` §4.2）。 */
function businessError(code: number, message = 'boom'): Record<string, unknown> {
  return { code, message, data: null }
}

/**
 * 装好桩、接住 `Component()` 定义、并加载柜机页。
 *
 * ⚠️ 每例都要 `resetModules()`：页面在**模块级**持有登录链的飞行态
 * （与首页的闸门同一个理由），vitest 的模块缓存会让第二个用例复用第一个的模块状态。
 */
let definition: Record<string, unknown> | null = null

beforeEach(() => {
  definition = null
  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (def: Record<string, unknown>): void => {
    definition = def
  }
})

async function loadPage(): Promise<Record<string, unknown>> {
  vi.resetModules()
  await import('../../miniprogram/pages/locker/locker')
  if (definition === null) throw new Error('locker.ts 没有调用 Component()')
  return definition
}

/** 页面实例 —— `data` / `setData` / `triggerEvent`，方法都绑到这个实例上。 */
interface PageInstance {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  triggerEvent: (name: string) => void
  onLoad?: (options: Record<string, string>) => void
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
  // ⚠️ **`onLoad` 在 `methods` 里，不在顶层。** 这是「用 `Component()` 写页面」的形态
  // （仓库既有取向，`#22` 定的）：页面生命周期钩子挂在 `methods` 上，由
  // `Component<..., TIsPage = true>` 的类型参数让 TS 认出来。
  //
  // ⚠️ 第一版在循环**之后**又读了一次 `def['onLoad']`（那是 `Page({...})` 的写法）
  // 并把它赋给 `instance.onLoad` —— 于是恒为 `undefined`，把循环刚绑好的那个冲掉。
  // 症状很隐蔽：**单文件跑时全绿**（那次循环确实绑上了），只有全套一起跑、
  // 模块缓存命中时才暴露成「页面参数丢了」。
  // ⇒ 现在的写法对「钩子挂在哪」**不敏感**：两处都读一遍，缺了就直接报错，
  //   而不是留一个 `undefined` 让后面每个用例都以「界面没渲染」的形式失败。
  const topLevelOnLoad = def['onLoad'] as ((options: Record<string, string>) => void) | undefined
  if (topLevelOnLoad !== undefined) instance.onLoad = topLevelOnLoad.bind(instance)
  if (typeof instance.onLoad !== 'function') {
    throw new Error('locker.ts 没有可调用的 onLoad —— 页面参数无处可去')
  }
  return instance
}

/**
 * 一次 `wx.request` 的编排值 —— **契约响应体**（`{code, message, data}`）
 * 或**网络失败**（`{errMsg}`）。
 *
 * ⚠️ 写成联合而不是 `WxRequestSuccessResult | {errMsg}`：用例里写的是**响应体**，
 * `jsonResponse()` 的包封由本文件统一加。直接把 `WxRequestSuccessResult`
 * 当类型会让每个用例都得先手写一遍 `jsonResponse(...)` —— 而那层噪音
 * 会把「这条用例编排了几个响应」这个真正重要的信息埋掉。
 */
type BodyOrFailure =
  | { body: Record<string, unknown> }
  | { failure: { errMsg: string } }

/**
 * 装桩 → 加载页面 → 用给定的 `onLoad(options)` 进入。
 *
 * ⚠️⚠️ **本页不发登录请求。** 这是与首页（闸门的承载页）最容易被搞混的一点：
 * 首页在 `attached` 里跑整条登录链（`wx.login` → `13.1`），而**柜机页不跑** ——
 * 它直接发 `13.6`，登录由**请求层**按需处理（`07` §4.3：`13.6` 需要 access，
 * 而没有 token 时……）。
 *
 * ⚠️ 本仓库当前的事实是：冷启动的登录链挂在**首页**上（`pages/index/index.ts` 的闸门）。
 * 通道 A 是**冷启动直达柜机页**、栈深 1 —— 首页根本没被挂载过。
 * 那条链路的登录归属见 `01` §3.4 / `07` §4.4（`13.6` 需要 access ⇒ 扫码链路
 * 必须先完成登录），本票**不为它编一个实现**：请求层对 `401` 的恢复是现成的
 * （`#19`），柜机页要做的只是**不吞掉失败**。
 *
 * ⇒ 测试因此把 `13.6` 的响应放在**第一个**位置，`wx.login` 的编排只在
 *    「真的发生了重登」时才被消费（`respondInOrder` 会为未被消费的响应报错，
 *    所以这里显式只给业务响应）。
 */
async function enter(
  options: Record<string, string>,
  responses: readonly BodyOrFailure[],
): Promise<{ wx: InstalledWxStub; page: PageInstance }> {
  const wx = installWxStub()
  wx.login.mockImplementation(reply({ code: 'WX-CODE', errMsg: 'login:ok' }))
  wx.request.mockImplementation(
    respondInOrder(responses.map((r) => ('failure' in r ? r.failure : jsonResponse(r.body)))),
  )
  // ⚠️ 四个跳转/弹层 API **全部编排成 no-op**，而**不是**留着「未编排即抛错」：
  // 它们的正确用量就是 0 次，而「一次都没被调用」由各用例的显式断言（或反向断言）负责。
  // 留着抛错会让「这条用例根本不该跳转」这件事以**异常**的形式爆出来 ——
  // 失败信息指向桩，而不是指向那条被违反的规则。
  wx.switchTab.mockImplementation(() => {})
  wx.navigateTo.mockImplementation(() => {})
  wx.redirectTo.mockImplementation(() => {})
  wx.showModal.mockImplementation(() => {})
  wx.showToast.mockImplementation(() => {})

  const def = await loadPage()
  const page = instantiate(def)
  page.onLoad?.(options)
  await settle()
  return { wx, page }
}

/** 让挂在微任务队列上的登录链 + 业务请求全部落定。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

/** 一档规格在界面上的那一行 —— 三档渲染成 `cells` 数组，断言都从这里取。 */
interface CellRowView {
  type: string
  label: string
  available: number
  enabled: boolean
  reason: string
}

/**
 * 取某一档的渲染行 —— **断言一律走它**，不走页面上的别的字段。
 *
 * ⚠️ 为什么这点值得一个 helper：三档在界面上是**同一块模板渲染出来的三行**
 * （`cells` 数组），而「逐档独立置灰」是本票的硬要求。
 * 若测试改从三个平铺的 `data` 字段（`smallEnabled` / `mediumEnabled` / …）取，
 * 就默认了「实现会平铺三个字段」—— 而那不是契约，是实现细节。
 * 走数组则无论是平铺还是数组，测的都是同一件事。
 */
function cellOf(page: PageInstance, type: 'SMALL' | 'MEDIUM' | 'LARGE'): CellRowView {
  const cells = page.data.cells as CellRowView[]
  const row = cells.find((cell) => cell.type === type)
  if (row === undefined) {
    throw new Error(
      `界面上没有 ${type} 档 —— 实际渲染的三档是 [${cells.map((c) => c.type).join(', ')}]`,
    )
  }
  return row
}

describe('#26 柜机页 · 正常渲染（01 §6）', () => {
  it('⚠️ 渲染站点名 + 位置 + 三档余位 + 三个入口', async () => {
    const { page } = await enter({ q: 'https%3A%2F%2Flocker.example.com%2Fl%2FWD-01' }, [
      { body: lockerBody() },
    ])

    expect(page.data.siteName).toBe('望京 SOHO T1')
    expect(page.data.position).toBe('B1 层 3 号电梯口')
    // ⚠️ 三档余位**各自**都要在界面上有值 —— 票面要求「三档规格各自独立置灰」。
    // 只断言「有数据」会让「三档合成一个布尔」的实现全绿。
    expect(cellOf(page, 'SMALL').available).toBe(4)
    expect(cellOf(page, 'MEDIUM').available).toBe(2)
    expect(cellOf(page, 'LARGE').available).toBe(0)
    // 两档有余位 ⇒ 可点；大档为 0 ⇒ 不可点（下面那条专门验「逐档独立」）。
    expect(cellOf(page, 'SMALL').enabled).toBe(true)
    expect(cellOf(page, 'MEDIUM').enabled).toBe(true)
  })

  it('⚠️ 页面只认 `code` —— 三个来源进入时 `13.6` 的查询串**逐字相同**', async () => {
    // 票面：「**页面只认 `code`，不关心来源** —— 『用户从哪进来』这个变量在收敛之后
    // 从产品里消失」。落成断言的方式：三个来源各进入一次，**发出的请求逐字相同**。
    // 若实现按来源分叉（比如通道 B 直接拿 result 当 code），这一条会红。
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
    expect(seen[0]).toBe(LOCKER_URL)
    expect(seen[1]).toBe(LOCKER_URL)
    expect(seen[2]).toBe(LOCKER_URL)
  })
})

describe('#26 柜机页 · 四种非正常进入（01 §6.1 表）', () => {
  it('⚠️ 解析不出 `code` → 入口失效页（不出站名、不发 `13.6`）', async () => {
    // `01` §6.1 第一行：「解析不出 `code`｜入口失效｜『这个码没用』页」。
    // ⚠️ 判据是**两条**：界面进了入口失效态，**且没有发出查询请求** ——
    // 后者才是真正会漏的那一半（拿空串去查柜机，界面照样画入口失效页，
    // 但那是一次无意义的往返，且服务端的 `1002` 会掩盖真正的「解析失败」）。
    const { wx, page } = await enter({}, [])

    expect(page.data.phase).toBe('entryFailed')
    expect(page.data.entryFailedTitle).toBe(LOCKER_PAGE_COPY.unusableCodeTitle)
    expect(requestsTo(sentRequests(wx.request), LOCKER_URL)).toEqual([])
  })

  it('⚠️ `13.6` → `1002` → **同一个页面**，只换文案（01 §6.1 逐字）', async () => {
    // `01` §6.1 第二行逐字：「**同一个页面**，文案换为『可能是旧贴纸』+ 引导联系客服」。
    //
    // ⚠️ 断言必须同时钉住「同一个」与「只换文案」两件事：
    //   • 第一个 `phase` 相等 ⇒ **同一个**（若实现给 `1002` 另造一个状态/页面，这里会红）；
    //   • 第二个标题不同 ⇒ **只换文案**（若实现照抄了「这个码没用」，这里会红）。
    const { page: invalid } = await enter({ q: 'https%3A%2F%2Fx.com%2Fl%2F' }, [])
    const { page: gone } = await enter({ code: 'WD-01' }, [{ body: businessError(1002, '柜机不存在') }])

    expect(gone.data.phase).toBe(invalid.data.phase)
    expect(gone.data.entryFailedTitle).toBe(LOCKER_PAGE_COPY.staleStickerTitle)
    expect(gone.data.entryFailedTitle).not.toBe(invalid.data.entryFailedTitle)
  })

  it('⚠️⚠️ `online = false` 是**正常响应**：完整渲染柜机信息 + 入口置灰 + 写明原因', async () => {
    // 票面逐字：「**完整渲染柜机信息**，入口**置灰并写明原因**」，且
    // 「**后两种是正常响应而非错误**（`§16 #29`）—— 把它们做成错误弹窗，
    // 用户会以为自己扫错了。**拿到数据意味着用户能看见『确实有这么台柜机、
    // 只是现在不能用』，这是有效信息。**」
    //
    // ⇒ 三条断言缺一不可：
    //   1. 站名与位置**照样画出来**（这才叫「完整渲染」）；
    //   2. 三个入口**都**置灰（不只是主入口 —— 预约入口同样走不通，`05` §3.4）；
    //   3. 置灰的**原因在界面上**（不是弹窗、不是 toast）。
    const { wx, page } = await enter({ code: 'WD-01' }, [
      {
        body: lockerBody({
          online: false,
          status: 'OFFLINE',
          cellAvailability: { small: 0, medium: 0, large: 0 },
        }),
      },
    ])

    // ① 完整渲染 —— 站名与位置一个不少。
    expect(page.data.siteName).toBe('望京 SOHO T1')
    expect(page.data.position).toBe('B1 层 3 号电梯口')
    // 三档**全部**不可点（不只是主入口），且原因写明（不是弹窗）。
    for (const type of ['SMALL', 'MEDIUM', 'LARGE'] as const) {
      expect(cellOf(page, type).enabled, `${type} 档在柜机不可用时没有置灰`).toBe(false)
      expect(cellOf(page, type).reason).toBe(LOCKER_PAGE_COPY.lockerUnavailableReason)
    }
    // ② 入口置灰 + 原因在页内。
    expect(page.data.lockerUsable).toBe(false)
    expect(page.data.lockerReason).toBe(LOCKER_PAGE_COPY.lockerUnavailableReason)
    // ③ ⚠️ 它**不是**错误态 —— 页面不得进任何失败分支。
    expect(page.data.phase).toBe('ready')
    // ④ ⚠️ 不是通用错误弹窗：整条路径上一次 modal 都没弹过。
    expect(wx.showModal).not.toHaveBeenCalled()
  })

  it('⚠️⚠️ 某规格余位为 0：**该档**置灰 + 「该规格已满」，其余档照常可点', async () => {
    // `01` §6.1 第四行：「`cellAvailability[type] === 0`｜**正常响应**｜该类型入口
    // **置灰**（建单会 `8002`），说明『该规格已满』」。
    //
    // ⚠️ 关键是**逐档独立**：`large = 0` 而 `small/medium` 有余位时，
    // 只有大档该灰。写成「任一档为 0 就全灰」会让本来能用的两档点不动 ——
    // 而那是用户**拿不到**柜门的直接原因（`01` §6.1 末句：唯一真出口是换一台柜机，
    // 但那是在**这台柜机确实满了**的前提下）。
    const { wx, page } = await enter({ code: 'WD-01' }, [
      { body: lockerBody({ cellAvailability: { small: 4, medium: 2, large: 0 } }) },
    ])

    expect(cellOf(page, 'SMALL').enabled).toBe(true)
    expect(cellOf(page, 'MEDIUM').enabled).toBe(true)
    expect(cellOf(page, 'LARGE').enabled).toBe(false)
    expect(cellOf(page, 'LARGE').reason).toBe(LOCKER_PAGE_COPY.cellTypeFullReason)
    // 有余位的那两档**不带**「已满」原因。
    expect(cellOf(page, 'SMALL').reason).toBe('')
    expect(cellOf(page, 'MEDIUM').reason).toBe('')
    // 正常响应，不是错误态；也没有弹窗。
    expect(page.data.phase).toBe('ready')
    expect(wx.showModal).not.toHaveBeenCalled()
  })

  it('⚠️ 非 `1002` 的失败**不留骨架屏** —— 给说明 + 重试出路（09 §7.2）', async () => {
    // ⚠️ 这条也是 review 阶段补上的，挡的是本页第一版的一个真实缺口。
    //
    // 第一版对非 `1002` 的失败只写了一句 `setData({ phase: 'loading' })`，
    // 理由是「停在骨架屏，不编一个错误页」。它挡对了一半（**确实不该**冒充
    // 「这个码没用」，见上面那条），但另一半是错的：
    // **骨架屏是「还在加载」的形态，而那一刻请求已经回来了、并且失败了。**
    // 用户于是盯着一屏永远不动的占位 —— 既不知道出了什么事，也**没有重试的入口**。
    //
    // ⇒ 正确的形态是 `09` §7.2 的「详情页加载失败」那一行：**加载失败，请重试** +
    //   一个重试出口。它不是「编一个错误页」，它是 `09` 里已有的那一行。
    const { page } = await enter({ code: 'WD-01' }, [
      // 网络不通 —— `07` §4.2 的 `kind: 'network'`，既不是 `1002` 也不是成功。
      { failure: { errMsg: 'request:fail timeout' } },
    ])

    expect(page.data.phase, '取柜机失败却停在骨架屏 —— 用户会永远等下去').toBe('loadFailed')
    expect(page.data.loadFailedDetail).toBe(LOCKER_PAGE_COPY.loadFailedDetail)
    // ⚠️ 且它**不是**入口失效 —— 成因不同、出路也不同（换贴纸 vs 重试）。
    expect(page.data.entryFailedTitle).not.toBe(LOCKER_PAGE_COPY.staleStickerTitle)
  })

  it('⚠️ 「重试」真的重发 `13.6`，成功后进 ready', async () => {
    // 有出口还不够 —— 那个按钮必须**真的重发请求**。一个只改 `phase` 的假重试
    // 会把用户留在「加载失败」页上反复点，而页面看起来「响应了」。
    const wx = installWxStub()
    wx.login.mockImplementation(reply({ code: 'WX-CODE', errMsg: 'login:ok' }))
    wx.request.mockImplementation(
      respondInOrder([
        { errMsg: 'request:fail timeout' },
        jsonResponse(lockerBody()),
      ]),
    )
    wx.switchTab.mockImplementation(() => {})
    wx.navigateTo.mockImplementation(() => {})
    wx.redirectTo.mockImplementation(() => {})
    wx.showModal.mockImplementation(() => {})
    wx.showToast.mockImplementation(() => {})

    const def = await loadPage()
    const page = instantiate(def)
    page.onLoad?.({ code: 'WD-01' })
    await settle()
    expect(page.data.phase).toBe('loadFailed')

    ;(page.onRetryLoad as () => void)()
    await settle()

    expect(page.data.phase).toBe('ready')
    expect(page.data.siteName).toBe('望京 SOHO T1')
    // ⚠️ 判据是「真的又发了一次」—— 只看 `phase` 的话，一个本地翻状态的实现也能过。
    expect(requestsTo(sentRequests(wx.request), LOCKER_URL)).toHaveLength(2)
  })

  it('⚠️ 可用性判据是 `online` 一个字段 —— `status` **不参与判断**（R1 陷阱表）', async () => {
    // ⚠️ 这条钉的是一个**看起来像漏实现**的设计选择，所以理由要写在测试里。
    //
    // `01` §6.1 / `09` §7.2 把条件写成两个子句（`online = false` **或** `status` 非 `ONLINE`），
    // 但 `R1` §1 陷阱表已核实它们**同义**：「`online`｜口径 = `locker.status == ONLINE`
    // （已按优先级链收敛）」—— `online` 就是服务端替我们算好的布尔。
    //
    // ⇒ 客户端若自己再对 `status` 做集合判断，就是**把后端的收敛逻辑抄一份**，
    //   而抄的那份会在后端新增枚举时静默过期。
    //
    // ⚠️ 断言方式：构造一个 `online: true` 但 `status` **不在「可用」白名单里**的响应
    // （这里用一个后端当前没有、将来可能加的值）。只读 `online` 的实现 ⇒ 入口可点；
    // 而任何「自己维护一个可用状态清单」的实现 ⇒ 会把这一档灰掉，从而在这条上红。
    const { page } = await enter({ code: 'WD-01' }, [
      {
        body: lockerBody({
          // ⚠️ 刻意是一个**当前枚举之外**的值 —— 后端将来加状态时，
          // `online` 会先跟上，而客户端的清单不会。
          status: 'DECOMMISSIONED',
          online: true,
          cellAvailability: { small: 2, medium: 2, large: 2 },
        }),
      },
    ])

    expect(
      page.data.lockerUsable,
      '可用性没有跟着 online 走 —— 说明实现自己维护了一份 status 清单，那会在后端加枚举时静默过期',
    ).toBe(true)
    expect(cellOf(page, 'SMALL').enabled).toBe(true)
  })

  it('⚠️ 余位为 0 时**不出现**「去预约」引导（01 §6.1 / 05 §3.4）', async () => {
    // 票面逐字：「**余位 0 时不得引导『去预约』** —— 预约同样只认 `FREE` 格口
    // （`13.12` 无空闲 → `8002`），唯一真出口是『换一台柜机』」。
    //
    // ⚠️ 这条**测不了「不存在的东西」** —— 断言只能落在「界面上出现的字」上。
    // ⇒ 做法是把本页会渲染的全部文案（`LOCKER_PAGE_COPY` 的每一个值）里
    //   凡是含「预约」的**摘出来单独看**：它们只能是那个次要入口的按钮名
    //   （`09` §6 第 5 条）与它的置灰原因（`该规格已满`，`05` §3.4 逐字），
    //   **不得**是任何「去预约 / 试试预约 / 预约使用」式的引导句。
    const allCopy = JSON.stringify(LOCKER_PAGE_COPY)
    const guidance = allCopy.match(/[^"'，。]*预约[^"'，。]*/g) ?? []
    expect(
      guidance,
      `柜机页的文案里出现了含「预约」的句子 —— 余位 0 时不得引导去预约（01 §6.1）：\n` +
        guidance.map((g) => `  • 「${g}」`).join('\n'),
    ).toEqual(['预约'])
  })
})

describe('#26 柜机页 · 开始存件 → 13.7 → 等待态（01 §6 / 08 §2）', () => {
  it('⚠️⚠️ 成功后背 `redirectTo` 进等待态 —— **断言不是 `navigateTo`**', async () => {
    // `08` §2:48 逐字：「⚠️ **为什么必须 `redirectTo` 而不是 `navigateTo`**：
    // `06` §7 硬约束 1 明写『移交后**不得再渲染支付界面**』。若用 `navigateTo`，
    // 用户按返回键就退回了那个页面 —— **等于绕过硬约束**…`redirectTo` 让
    // 『退回支付页』这个状态**物理上不存在**。」
    //
    // ⚠️ 这条断言的价值全在「不是 `navigateTo`」那一半：「跳过去了」这件事
    // `navigateTo` 与 `redirectTo` 都做得到，只看前半句的测试**两者都能过**。
    const { wx, page } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }, { body: createOrderBody() }])

    ;(page.onStartStoring as (e: { currentTarget: { dataset: unknown } }) => void)({
      currentTarget: { dataset: { cellType: 'MEDIUM' } },
    })
    await settle()

    expect(wx.redirectTo).toHaveBeenCalledTimes(1)
    expect(wx.navigateTo).not.toHaveBeenCalled()
    const url = (wx.redirectTo.mock.calls[0]?.[0] as { url: string }).url
    expect(url).toContain(WAITING_PATH)
  })

  it('⚠️ 入参是 `orderId` + `openTimeoutMinutes`，且来自**响应**不是硬编码', async () => {
    // 票面逐字：「入参：`orderId` + **`openTimeoutMinutes`**（⚠️ 这是该字段**唯一**的
    // 合法来源与唯一合法使用位置）」，且验收：「`openTimeoutMinutes` **只**从 `13.7`
    // 响应取，**不硬编码、不猜**」。
    //
    // ⚠️ 判据刻意用一个**不等于 10 的值**（10 是后端缺省，写死它也能过一条用 10 的断言）。
    // 用 7 之后，「实现里写着 `?? 10` 或者干脆 `'10'`」这一类会当场红。
    const { wx, page } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }, { body: createOrderBody(7) }])

    ;(page.onStartStoring as (e: { currentTarget: { dataset: unknown } }) => void)({
      currentTarget: { dataset: { cellType: 'MEDIUM' } },
    })
    await settle()

    const url = (wx.redirectTo.mock.calls[0]?.[0] as { url: string }).url
    expect(url).toContain('orderId=1001')
    expect(url).toContain('openTimeoutMinutes=7')
  })

  it('⚠️ 请求体只发 `lockerId` + `cellType`，且 `lockerId` 来自 `13.6`', async () => {
    // `01` §1.2 逐字：「**`lockerId` 的唯一来源是 `13.6`**」。用户点的是**规格**，
    // 不是格口 —— 具体分配哪个格口由服务端在事务里做（`13.7` :995）。
    //
    // ⚠️ 这里必须点一个**有余位**的档（默认响应里 `medium = 2`）：点一个置灰的档
    // 会被下面那条「置灰不发请求」的规则正确拦下，于是这条用例会以
    // 「一个请求都没发」的形式失败 —— 而那看起来像「请求体拼错了」，
    // 实际是「点错了档」。用 MEDIUM 让这条用例只测它自己那件事。
    const { wx, page } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }, { body: createOrderBody() }])

    ;(page.onStartStoring as (e: { currentTarget: { dataset: unknown } }) => void)({
      currentTarget: { dataset: { cellType: 'MEDIUM' } },
    })
    await settle()

    const posts = requestsTo(sentRequests(wx.request), CREATE_ORDER_URL)
    expect(posts).toHaveLength(1)
    expect(posts[0]?.method).toBe('POST')
    expect(posts[0]?.data).toEqual({ lockerId: 11, cellType: 'MEDIUM' })
  })

  it('⚠️ 同一份模板渲染的三档各自带上自己的 `cellType` —— 不是三块写死的按钮', async () => {
    // 三档是**同一块模板** `wx:for` 出来的（见 wxml），所以「点小档发 SMALL、
    // 点大档发 LARGE」这件事完全依赖 `data-cell-type="{{ item.type }}"` 那一处绑定。
    // ⚠️ 一个把 `cellType` 写死成 `'MEDIUM'` 的实现（三块按钮各写一遍时最容易犯）
    // 会让用户**选了大格口、拿到的却是中格口** —— 而界面上一切正常。
    const { wx, page } = await enter({ code: 'WD-01' }, [
      { body: lockerBody({ cellAvailability: { small: 4, medium: 4, large: 4 } }) },
      { body: createOrderBody() },
    ])

    ;(page.onStartStoring as (e: { currentTarget: { dataset: unknown } }) => void)({
      currentTarget: { dataset: { cellType: 'LARGE' } },
    })
    await settle()

    const posts = requestsTo(sentRequests(wx.request), CREATE_ORDER_URL)
    expect(posts[0]?.data).toEqual({ lockerId: 11, cellType: 'LARGE' })
  })

  it('⚠️ 建单失败不跳转 —— 留在柜机页（失败归因就地解释，07 §4.1）', async () => {
    // `13.7` 的两个准入类失败码（`4004` / `8002`）按 `04` §9 在**动作点就地解释**。
    // 跳进等待态是本票最坏的失败形态：用户会站在柜机前等一个**从没开过的门**。
    const { wx, page } = await enter({ code: 'WD-01' }, [
      { body: lockerBody() },
      { body: businessError(4004, '柜机不可用') },
    ])

    ;(page.onStartStoring as (e: { currentTarget: { dataset: unknown } }) => void)({
      currentTarget: { dataset: { cellType: 'MEDIUM' } },
    })
    await settle()

    expect(wx.redirectTo).not.toHaveBeenCalled()
    expect(page.data.phase).toBe('ready')
  })

  it('⚠️ 请求进行中防抖 —— `13.7` 不幂等，连点不得建两张单（09 §5.8 允许的例外）', async () => {
    // `R1` §1「13.7 · 幂等性」逐字：「**不幂等** —— 每次调用创建新订单 + 新预留格口。
    // 前端须防止重复提交（如按钮 loading/本地去重）」。
    // ⚠️ 这条防抖是 `09` §5.8 硬规则 5 **明确允许**的唯一两种禁用之一
    // （「请求进行中的技术性防抖」）—— 所以它不是对「绝不事前阻断」的违反。
    const { wx, page } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }, { body: createOrderBody() }])
    const tap = page.onStartStoring as (e: { currentTarget: { dataset: unknown } }) => void

    // 连点两次，**不 await 中间那次** —— 这正是用户手快时的真实时序。
    tap({ currentTarget: { dataset: { cellType: 'MEDIUM' } } })
    tap({ currentTarget: { dataset: { cellType: 'MEDIUM' } } })
    await settle()

    expect(requestsTo(sentRequests(wx.request), CREATE_ORDER_URL)).toHaveLength(1)
  })
})

describe('#26 柜机页 · 两个出口（01 §2.4 / 05 §2、§3.4）', () => {
  it('⚠️⚠️ 「我的订单」真的 `wx.switchTab` 到订单 tab（01 §2.4:57）', async () => {
    // 票面：「顶部固定一个『我的订单』出口，走 **`wx.switchTab`** 到订单 tab。
    // ⚠️ 这不是可选项：通道 A 是冷启动栈深 1、底部 tabBar 不显示 ⇒ 这是屏上
    // **唯一**通往订单列表的可见路径。」
    //
    // ⚠️ 本页**自己写一个 `switchTab`** 是最像「看起来也对」的错 ——
    // `#23` 已经把这件事修在 `navigation-bar.home()` 里了，页面再写一份就是
    // 同一个动作两个家（`09` §5.6 规则 7 的反面）。
    // ⇒ 断言落在**组件的事件转发**上：页面接住 `bind:home` 之后调 `wx.switchTab`，
    //   且目标与 `ORDER_LIST_PATH` 逐字一致。
    const { wx, page } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }])

    ;(page.onMyOrders as () => void)()
    await settle()

    expect((wx.switchTab.mock.calls[0]?.[0] as { url: string } | undefined)?.url).toBe(
      '/pages/index/index',
    )
  })

  it('⚠️ 「预约」用 `navigateTo` 进预约创建页，并带 `lockerId`（05 §2、§6.1）', async () => {
    // `05` §2：「创建入口**只在柜机页**」；`05` §3.4：余位 0 时**同样置灰**。
    // ⚠️ 这里用 `navigateTo`（不是 `redirectTo`）是**对的** —— 预约创建不是移交，
    // 用户取消后应当能退回柜机页。移交语义（`redirectTo`）只属于等待态（`08` §2）。
    //
    // ⚠️ 夹具必须让**三档都有余位**：`lockerBody()` 的缺省大格口是 0，
    // 而按 `05` §3.4 预约入口在**任一档**为 0 时就置灰 —— 用缺省夹具的话，
    // 这条用例会因为「入口本来就该是灰的」而失败，看起来像 `navigateTo` 拼错了。
    // 让每条用例的夹具只暴露它要测的那一件事。
    const { wx, page } = await enter({ code: 'WD-01' }, [
      { body: lockerBody({ cellAvailability: { small: 4, medium: 2, large: 1 } }) },
    ])

    ;(page.onReserve as () => void)()
    await settle()

    const url = (wx.navigateTo.mock.calls[0]?.[0] as { url: string } | undefined)?.url ?? ''
    expect(url).toContain(RESERVATION_CREATE_PATH)
    // ⚠️ `lockerId` 来自本页的 `13.6`（`01` §1.2 的「唯一来源」）。
    expect(url).toContain('lockerId=11')
  })

  it('⚠️ 柜机不可用时「预约」入口也置灰（05 §3.4 逐字，与开始存件同等）', async () => {
    // `05` §3.4 逐字：「`cellAvailability[type] === 0` 时，柜机页的『预约』入口
    // **与『开始存件』同样置灰**并写明『该规格已满』」。
    // 而柜机整体 `online = false` 时更不必说 —— 预约同样建不出来。
    const { page } = await enter({ code: 'WD-01' }, [
      {
        body: lockerBody({
          online: false,
          status: 'MAINTAINING',
          cellAvailability: { small: 0, medium: 0, large: 0 },
        }),
      },
    ])

    expect(page.data.reserveEnabled).toBe(false)
    expect(page.data.reserveReason).toBe(LOCKER_PAGE_COPY.lockerUnavailableReason)
  })

  it('⚠️⚠️ 余位 0 时「预约」入口**同样置灰**，原因说「该规格已满」（05 §3.4 逐字）', async () => {
    // ⚠️⚠️ **这条断言是本票 review 阶段抓出来补上的，而它抓的是一个真实的违规。**
    //
    // 实现第一版把预约入口只挂在 `online` 上，并在注释里给自己编了一条理由
    // （「预约要的是以后有格口，此刻满不代表预约时段也满」）—— 听起来合理，
    // 但它**恰好是 `05` §3.4 明文排除的那个推理**。原文逐字：
    //
    // > 承 `01` §6.1：**余位 0 时不得引导「去预约」** —— 预约同样只认 `FREE` 格口
    // > （`13.12` 无空闲 → `8002`），唯一真出口是「换一台柜机」。
    // > **本节不推翻该结论**：`cellAvailability[type] === 0` 时，柜机页的「预约」入口
    // > **与「开始存件」同样置灰**并写明「该规格已满」。
    //
    // ⚠️ 上一句「本节不推翻该结论」说明作者预见到了这个推理 —— 而它还是发生了。
    // 教训：**当一条 spec 明确写下「不得据 X 推导 Y」时，实现里任何复现那个推导的
    // 注释都是危险信号**，无论它读起来多合理。规格在这里是权威，不是论据。
    const { page } = await enter({ code: 'WD-01' }, [
      // 柜机**可用**，但大格口余位为 0 —— 这正是 §3.4 描述的那个场景。
      { body: lockerBody({ cellAvailability: { small: 4, medium: 2, large: 0 } }) },
    ])

    expect(
      page.data.reserveEnabled,
      '余位为 0 时预约入口没有置灰 —— 05 §3.4 明令它与「开始存件」同等置灰',
    ).toBe(false)
    expect(page.data.reserveReason).toBe(LOCKER_PAGE_COPY.cellTypeFullReason)
  })

  it('⚠️ 三档都还有余位时「预约」入口照常可点 —— 置灰只在有余位为 0 时发生', async () => {
    // 上一条的反面，防止修得过头（把预约入口**永远**灰掉 —— 那会让「预约」这个
    // 功能在本页彻底不可达，而它正是 `05` §2 定下的**创建唯一切入点**）。
    const { page } = await enter({ code: 'WD-01' }, [
      { body: lockerBody({ cellAvailability: { small: 1, medium: 1, large: 1 } }) },
    ])

    expect(page.data.reserveEnabled).toBe(true)
    expect(page.data.reserveReason).toBe('')
  })

  it('⚠️ 置灰的入口不发请求 —— 点了也不建单（防抖之外的第二道）', async () => {
    // 置灰是**服务端回显驱动**的（`09` §5.8 容许的例外）。既然界面明确说了
    // 「该规格已满」，那么照着点一下不该真的去打一次注定 `8002` 的请求 ——
    // 而 `13.7` **不幂等**，多发一次请求在多用户并发下是真的会抢格口的。
    const { wx, page } = await enter({ code: 'WD-01' }, [
      { body: lockerBody({ cellAvailability: { small: 0, medium: 0, large: 0 } }) },
    ])

    ;(page.onStartStoring as (e: { currentTarget: { dataset: unknown } }) => void)({
      currentTarget: { dataset: { cellType: 'LARGE' } },
    })
    await settle()

    expect(requestsTo(sentRequests(wx.request), CREATE_ORDER_URL)).toEqual([])
    expect(wx.redirectTo).not.toHaveBeenCalled()
  })

  it('⚠️ 置灰的**预约**入口同样点了不动 —— 两条入口的守卫必须对称', async () => {
    // ⚠️ 这条是 review 抓出来的：第一版对「开始存件」有守卫（`if (!row.enabled) return`），
    // 对「预约」却只判了 `locker` 在不在 —— **`reserveEnabled` 根本没读**。
    //
    // 症状是真实的：wxml 上确实有 `disabled="{{ !reserveEnabled }}"`，所以**手点不出来**；
    // 但「置灰的入口点了什么都不做」这条纪律就成了**只由模板保证**的东西 ——
    // 而模板的 `disabled` 是**渲染层**的，事件绑定、无障碍触发、或将来把按钮换成
    // `<view bindtap>` 的任何一次改动，都会让守卫凭空消失。守卫要长在处理函数里。
    const { wx, page } = await enter({ code: 'WD-01' }, [
      // 大格口满 ⇒ 预约入口置灰（05 §3.4）。
      { body: lockerBody({ cellAvailability: { small: 4, medium: 2, large: 0 } }) },
    ])
    expect(page.data.reserveEnabled).toBe(false)

    ;(page.onReserve as () => void)()
    await settle()

    expect(
      wx.navigateTo,
      '置灰的预约入口仍然跳转了 —— 守卫没有落在处理函数里，只靠模板的 disabled',
    ).not.toHaveBeenCalled()
  })
})

describe('#26 柜机页 · 上下文纪律（01 §6 / ADR-0001）', () => {
  it('⚠️⚠️ 运行期**零写入** storage —— 柜机上下文不进 storage（ADR-0001 硬规则）', async () => {
    // 票面逐字：「⚠️ **禁止隐式记住上次柜机** —— **不得**把柜机上下文写入 `storage`。
    // 最坏结果是用户在**另一台**柜机前被带上别的柜机上下文，**下单成功而门在别处开了**。
    // 省一次扫码的收益与开错柜门的风险严重不对称。（ADR-0001）」
    //
    // ⚠️ 判据为什么是「**零写入**」而不是「零调用」：本页走的是真实的请求层，
    // 而请求层**要读** storage 里的 access token（`07` §4.4 定案：token 持久化）——
    // 那是登录身份，**不是**柜机上下文。把「读」也算违规会让这条断言
    // 只能靠在桩上做手脚来通过，而那就测不到真东西了。
    // ⇒ ADR-0001 禁的是「**记住**上次柜机」，而「记住」这个动作只有 `setStorageSync`
    //   做得到。**读**单独由下一条源码守卫钉住（它断言本页连读都没写过）。
    const { wx } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }])

    expect(wx.setStorageSync).not.toHaveBeenCalled()
    expect(wx.removeStorageSync).not.toHaveBeenCalled()
    // ⚠️ 读是允许的 —— 但那一次读**必须来自请求层**（key 是 `auth.accessToken`），
    // 而不是本页在翻自己的柜机上下文。这一条断言把「是谁在读」也钉住。
    for (const [key] of wx.getStorageSync.mock.calls) {
      expect(
        String(key),
        `柜机页从 storage 读了 \`${String(key)}\` —— 柜机上下文只能来自页面参数（ADR-0001）`,
      ).toMatch(/^auth\./)
    }
  })

  it('⚠️⚠️ 本页源码里**一个 storage API 都没有** —— 上面那条读法是对的，但仍要机械地钉住', async () => {
    // 上一条是**运行时**断言：它证明「这一次进入没有写 storage」。
    // 这一条是**源码**断言：它证明「这个文件里根本没有写 storage 的代码路径」——
    // 包括那些本次没走到的分支（比如「记住上次柜机」那个错误实现的读分支）。
    //
    // ⚠️ 两条都要，因为它们挡的是两种不同的退化：
    //   • 上一条挡「在某条分支上写了」；
    //   • 这一条挡「写了一个本次没走到的分支」—— 而柜机页恰恰有四条分支
    //     （四种非正常进入 + 正常态 + 重新扫码），运行时断言只能覆盖走过的那些。
    const source = readFileSync(
      join(repoRoot, 'miniprogram', 'pages', 'locker', 'locker.ts'),
      'utf8',
    )
    // 剥注释后再判 —— 本文件的注释里大量讨论 storage，那是必要的契约说明。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    for (const api of ['getStorageSync', 'setStorageSync', 'removeStorageSync', 'getStorage']) {
      expect(
        code,
        `locker.ts 里出现了 \`${api}\` —— 柜机上下文只能来自页面参数（01 §6 + ADR-0001）`,
      ).not.toContain(api)
    }
  })
})

describe('#26 柜机页 · 渲染标题（09 §0 硬规则 1）', () => {
  it('⚠️ 导航栏标题来自文案层 —— 不在 wxml 里写字面量', async () => {
    const { page } = await enter({ code: 'WD-01' }, [{ body: lockerBody() }])
    expect(page.data.title).toBe(PAGE_TITLES['pages/locker/locker'])
  })
})

describe('#26 跳转路径只有一个家（07 §3 / 05 §2 / 08 §2）', () => {
  it('⚠️⚠️ 柜机页里**不出现任何页面路径字面量** —— 一律从 `utils/routes` 引', async () => {
    // ⚠️ 这条是 review 抓出来的缺陷的守卫：本票第一版在柜机页里写死过
    // `const RESERVATION_CREATE_PATH = 'pages/reservation-create/...'` ——
    // 而**同一个 commit** 刚建了 `utils/routes.ts`，那个文件的注释正在为
    // 完全相同的理由解释路径为什么不能是页面里的字面量。
    //
    // 症状与 `#23` 修的死按钮同源：`wx.*To` 拿到不存在的路径时**静默失败**
    // （不跳转、不报错），用户看到的就是「点了没反应」。
    //
    // ⚠️⚠️ **判据必须收窄到「跳转目标的常量定义」，不能是「这个串出现在任何地方」。**
    // 第一版用了宽判据，它当场抓到了 `PAGE_TITLES['pages/locker/locker']` ——
    // 而那里出现这个串是**完全正当**的：那是用页面自己的路径当键**查标题**，
    // 与「往这个页面跳」是两件事（`test/startup/conventions.test.ts` 里有一条
    // 同源的守卫，它的注释记着同一个教训）。
    // 守卫一旦逼人绕开一个正确的写法，下一个人就会直接删掉它。
    //
    // ⇒ 只认**模块顶层的 `const X = 'pages/...'`**：那正是「路径被抄了一份」的形状。
    //   跳转调用点若内联字面量，同样会被 `url:` 那一支抓到。
    const source = readFileSync(
      join(repoRoot, 'miniprogram', 'pages', 'locker', 'locker.ts'),
      'utf8',
    )
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const inlined: string[] = []
    // ① 顶层常量定义：`const ANY_PATH = 'pages/x/y'`
    for (const m of code.matchAll(/^\s*const\s+\w*PATH\w*\s*=\s*['"`](pages\/[^'"`]+)['"`]/gm)) {
      inlined.push(`const ... = '${m[1]}'`)
    }
    // ② 跳转 url 里内联的字面量：`url: '/pages/x/y...'`
    for (const m of code.matchAll(/url\s*:\s*['"`]\/?(pages\/[^'"`?]+)/g)) {
      inlined.push(`url: '${m[1]}'`)
    }

    expect(
      inlined,
      `柜机页里出现了写死的页面路径 —— 一律从 utils/routes 引（写错就是跳转的静默失败）：\n` +
        inlined.map((p) => `  • ${p}`).join('\n'),
    ).toEqual([])
  })

  it('⚠️ 两个路径常量都真的注册在 `app.json` 里 —— 否则跳转静默失败', async () => {
    // `wx.*To` 对**未注册**的路径同样静默失败。这条断言把常量与那份原生配置
    // 扣在一起 —— `app.json` 是 JSON，引不到 TS，所以只能靠测试比对。
    const appJson = JSON.parse(
      readFileSync(join(repoRoot, 'miniprogram', 'app.json'), 'utf8'),
    ) as { pages: string[] }

    expect(appJson.pages, 'WAITING_PATH 没有注册在 app.json 里').toContain(WAITING_PATH)
    expect(appJson.pages, 'RESERVATION_CREATE_PATH 没有注册在 app.json 里').toContain(
      RESERVATION_CREATE_PATH,
    )
  })
})
