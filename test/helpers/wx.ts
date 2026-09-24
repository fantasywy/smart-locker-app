// 可复用的 `wx.*` 全局桩 —— issue #16 的核心交付物。
//
// 它替代真机 / 微信开发者工具：测试不启动模拟器，就能拿到一个「每次调用返回什么由测试说了算」
// 的 `wx` 全局。承 `docs/spec/07-engineering-form.md` §2（工程约束）与 §4（请求层口径）。
//
// ⚠️ 四条设计约束，都是被后续票的用法逼出来的：
//
// 1. **逐次编排，不是静态返回值。** `wx.login` 第二次调用必须能返回失败（`01` §3.4 的
//    「重登一次，失败则丢弃原动作」）。所以每个方法都按「调用序」取下一个编排值，
//    而不是一个可改的属性。
//
// 2. **未编排的调用 = 立刻失败，不是静默成功。** 桩的默认行为是抛一个说人话的错误。
//    否则「忘了编排 `wx.login`」会变成一条假通过的断言 —— 而本票要防的正是这种情况。
//
// 3. ⚠️ **`wx.request` / `wx.login` 是回调式的 —— 不要用 `mockResolvedValueOnce`。**
//    它们**不返回 Promise**：请求层等的是 `options.success(...)`，一个被 resolve 的
//    Promise 永远不会去调它。写了 `login.mockResolvedValueOnce(...)` 既不报错、也不生效，
//    只会让测试在超时或「未编排」错误里绕远路。
//    **回话要用 `reply()`（或整组用的 `respondInOrder()`）配合 `mockImplementationOnce`。**
//
// 4. **每个 stub 都是标准 vitest mock。** 因此 `toHaveBeenCalledTimes()` / `mock.calls`
//    直接可用 —— `07` §4.3 硬约束 1「单一飞行」的核心断言就是「`13.2` 只被调用一次」。
//
// 用法：
//   const wxStub = installWxStub()
//   wxStub.login.mockImplementationOnce(reply({ code: 'CODE-1', errMsg: 'login:ok' }))
//   wxStub.login.mockImplementationOnce(reply({ errMsg: 'login:fail' }, false))   // 第 2 次失败
//   wxStub.request.mockImplementationOnce(reply(jsonResponse({ code: 0, data: {...} })))
//
//   // 整组一次编排好、并断言到达顺序 —— 见 test/helpers/http.ts：
//   wxStub.request.mockImplementation(respondInOrder([jsonResponse(...), networkFailure()]))
//
// 本文件提供 `reply()`（单次回话）；`http.ts` 提供 `respondInOrder()`
// （按序整组回话）与 `sentRequests()` / `urlsOf()` / `requestsTo()`（读调用记录）。

import { vi } from 'vitest'
import type { Mock } from 'vitest'

/** `wx.request` 的 success 回调参数形状（只列本仓库会用到的字段）。 */
export interface WxRequestSuccessResult {
  /** HTTP 状态码。⚠️ 业务错误走 `200 + code ≠ 0`，认证错误才用真 `401/403`（`07` §4.2）。 */
  statusCode: number
  /** ⚠️ 故意标成 `unknown`：契约说「非 JSON 响应」也是一条真实分支（`07` §4.2 的 `network`），
   *  所以测试必须能编排一个**不是对象**的 `data`（如 `'<html>502</html>'`）。
   *  请求层负责把它归一化成 `kind: 'network'`。 */
  data: unknown
  /** 响应头。`13.2` 之类的端点用不到，留给将来需要读头的用例。 */
  header?: Record<string, string>
  /** 微信侧的错误描述（`request:ok` / `request:fail timeout`……）。 */
  errMsg?: string
}

/** `wx.request` 的 fail 回调参数形状。 */
export interface WxRequestFailResult {
  errMsg: string
}

/** `wx.request` 的 options —— 测试**断言**的就是它（发出了什么请求）。 */
export interface WxRequestOptions {
  url: string
  method?: string
  data?: unknown
  header?: Record<string, string>
  timeout?: number
  success?: (res: WxRequestSuccessResult) => void
  fail?: (err: WxRequestFailResult) => void
  complete?: () => void
}

export interface WxLoginSuccessResult {
  code: string
  errMsg?: string
}

export interface WxLoginOptions {
  timeout?: number
  success?: (res: WxLoginSuccessResult) => void
  fail?: (err: WxRequestFailResult) => void
  complete?: () => void
}

/** `wx.*` 全局的形状。刻意只列本仓库会碰到的成员 —— 用不到的 API 不预先编造。 */
/** `installWxStub()` 的返回：桩本身，外加一个手动卸载口。 */
export interface InstalledWxStub extends WxStub {
  /** 手动卸载。正常不需要 —— `test/support/setup.ts` 会逐测试自动卸载。 */
  uninstall: () => void
}

export interface WxStub {
  login: Mock<(options: WxLoginOptions) => void>
  getStorageSync: Mock<(key: string) => unknown>
  setStorageSync: Mock<(key: string, value: unknown) => void>
  removeStorageSync: Mock<(key: string) => void>
  request: Mock<(options: WxRequestOptions) => void>
}

/** 未编排调用时的兜底错误 —— 让「忘了编排」在测试输出里一眼可辨。 */
class UnstubbedWxCall extends Error {
  constructor(method: string) {
    super(
      `wx.${method} 被调用了，但这个测试没有编排它的返回值。\n` +
        `    → 用 wxStub.${method}.mockResolvedValueOnce(...) 逐次编排，` +
        `或在断言里显式承认它不该被调用（expect(wxStub.${method}).not.toHaveBeenCalled()）。`,
    )
    this.name = 'UnstubbedWxCall'
  }
}

/** 构造一个「未编排即失败」的 mock：调用它只会抛出 UnstubbedWxCall。 */
function unstubbed<TArgs extends unknown[]>(method: string): Mock<(...args: TArgs) => void> {
  return vi.fn((..._args: TArgs) => {
    throw new UnstubbedWxCall(method)
  })
}

/** 造一份 `wx.request` 的成功响应。默认 `200` —— 业务错误也走 200（`07` §4.2）。 */
export function jsonResponse(
  body: unknown,
  statusCode = 200,
  header: Record<string, string> = { 'content-type': 'application/json' },
): WxRequestSuccessResult {
  return { statusCode, data: body, header, errMsg: 'request:ok' }
}

/** 造一份 `wx.request` 的失败结果（网络不通 / 超时 —— 两者在微信侧都是 `fail`）。 */
export function networkFailure(errMsg = 'request:fail timeout'): WxRequestFailResult {
  return { errMsg }
}

/**
 * 把一个「回话结果」包成回调式 API 要的函数。
 *
 * 为什么需要它：`wx.login` / `wx.request` **不返回 Promise** —— 它们把结果交给
 * `options.success` / `options.fail`。所以 `mockResolvedValueOnce(...)` 对它们毫无作用
 * （见文件头约束 3）。`reply()` 把结果转成「拿到 options 就回调」的实现，
 * 这才是这两个 API 的编排方式。
 *
 * @param result 成功回调的入参（`wx.login` 得 `{ code }`，`wx.request` 得 `{ statusCode, data }`）
 * @param ok `false` 时改走 `options.fail`（网络不通 / 超时）
 * @param delayMs 可选延迟：给「刷新还在飞」这类时序断言用；不传则下一个微任务就回话
 */
export function reply<T>(result: T, ok = true, delayMs?: number): (options: {
  success?: (r: T) => void
  fail?: (r: T) => void
  complete?: () => void
}) => void {
  return (options) => {
    const fire = (): void => {
      if (ok) options.success?.(result)
      else options.fail?.(result)
      options.complete?.()
    }
    if (delayMs === undefined) queueMicrotask(fire)
    else setTimeout(fire, delayMs)
  }
}

/**
 * 把 `wx` 全局装进 `globalThis`，返回可直接编排与断言的桩。
 *
 * ⚠️ **调用方不必自己清理。** 每个测试结束后由 `test/support/setup.ts` 卸载（`afterEach`），
 * 因此单个测试改的桩状态不会泄漏到下一个测试 —— 这是 issue #16 的一条验收标准。
 * 需要手动卸载时用返回的 `uninstall`。
 */
export function installWxStub(): InstalledWxStub {
  const host = globalThis as unknown as Record<string, unknown>

  // storage 的默认实现：一个真的会读写的内存表。
  // 为什么默认不是「未编排即失败」：storage 的语义就是读回自己写过的东西，
  // 让每个用例都手写一遍 getStorageSync 的返回值只会把真实验为噪音。
  //
  // ⚠️ 需要「storage 里本来就有 token」时用下面导出的 `seedStorage()`，**不要**
  // `getStorageSync.mockImplementation(...)` —— 那会整个替换掉内存表的读取实现，
  // 于是 `setStorageSync` 再写什么都读不回来。「重放必须带刷新后的新 access」
  // 这类断言会因此假失败（第一次请求的旧令牌被读了一辈子）。
  const memory = new Map<string, unknown>()

  const stub: WxStub = {
    login: unstubbed<[WxLoginOptions]>('login'),
    getStorageSync: vi.fn((key: string) => memory.get(key)) as Mock<(key: string) => unknown>,
    setStorageSync: vi.fn((key: string, value: unknown) => {
      memory.set(key, value)
    }),
    removeStorageSync: vi.fn((key: string) => {
      memory.delete(key)
    }),
    request: unstubbed<[WxRequestOptions]>('request'),
  }

  // ⚠️ 预置值走**内存表**而不是覆盖 mock：读写仍然是一张表，语义完整。
  seedStorageInto = (key: string, value: unknown): void => {
    memory.set(key, value)
  }

  host.wx = stub
  // ⚠️ 用**身份**登记归属，而不是鸭子类型判别。见 installedStub 的注释。
  owned = stub

  return Object.assign(stub, { uninstall: uninstallWxStub }) as InstalledWxStub
}

/**
 * 往**当前**已安装的桩的 storage 内存表里预置一个值（如「冷启动时 token 已经在」）。
 *
 * ⚠️ 它是**函数**而不是 `installWxStub()` 的返回成员：`memory` 是每次安装新造的闭包，
 * 而「预置」这件事只在装完之后才有意义。写成返回成员会诱导出
 * `installWxStub().seed(...)` 这种丢掉其他成员的链式写法。
 *
 * @throws 还没装桩就调用时 —— 静默无效会让用例变成一条假通过的断言。
 */
export function seedStorage(key: string, value: unknown): void {
  if (seedStorageInto === undefined) {
    throw new Error('seedStorage() 必须在 installWxStub() 之后调用。')
  }
  seedStorageInto(key, value)
}

/** 当前桩的内存表写入口 —— `installWxStub()` 逐次装填；`uninstallWxStub()` 清空。 */
let seedStorageInto: ((key: string, value: unknown) => void) | undefined

/**
 * 当前由本模块装在 `globalThis` 上的桩 —— 靠**引用相等**判断归属。
 *
 * ⚠️ 曾经这里用鸭子类型（「有这 5 个 key 就算我们的」），后果是 `uninstallWxStub()` 会
 * 删掉**测试自己 set 的任何**同形状对象 —— 而注释恰恰写着「不覆盖测试自己 set 的对象」。
 * 引用相等没有这个问题：只有本模块亲手装进去的那个对象才会被卸载。
 */
let owned: WxStub | undefined

/** 当前装在 `globalThis` 上的桩；没装、或装的是别人 set 的对象时为 `undefined`。 */
export function currentWxStub(): WxStub | undefined {
  return owned
}

/** 卸载 `globalThis` 上的桩（由 setup 文件逐测试调用）。只卸载本模块装的。 */
export function uninstallWxStub(): void {
  const host = globalThis as unknown as Record<string, unknown>
  if (owned !== undefined && host.wx === owned) delete host.wx
  owned = undefined
  // ⚠️ 一起清掉预置入口：留着会让**下一个**用例的 `seedStorage()` 悄悄写进
  // 上一个用例已经废弃的内存表，然后读不到 —— 症状是「预置了 token 却像没预置」。
  seedStorageInto = undefined
}
