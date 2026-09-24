// 可复用的 `wx.*` 全局桩 —— issue #16 的核心交付物。
//
// 它替代真机 / 微信开发者工具：测试不启动模拟器，就能拿到一个「每次调用返回什么由测试说了算」
// 的 `wx` 全局。承 `docs/spec/07-engineering-form.md` §2（工程约束）与 §4（请求层口径）。
//
// ⚠️ 三条设计约束，都是被后续票的用法逼出来的：
//
// 1. **逐次编排，不是静态返回值。** `wx.login` 第二次调用必须能返回失败（`01` §3.4 的
//    「重登一次，失败则丢弃原动作」）。所以每个方法都是 `mockResolvedValueOnce()` 的语义，
//    而不是一个可改的属性。
//
// 2. **未编排的调用 = 立刻失败，不是静默成功。** 桩的默认行为是 reject 一个说人话的错误。
//    否则「忘了编排 `wx.login`」会变成一条假通过的断言 —— 而本票要防的正是这种情况。
//    需要「什么都不做」时用 `wxStub.login.mockResolvedValueOnce(...)` 显式写出来。
//
// 3. **每个 stub 都是标准 vitest mock。** 因此 `toHaveBeenCalledTimes()` / `mock.calls`
//    直接可用 —— `07` §4.3 硬约束 1「单一飞行」的核心断言就是「`13.2` 只被调用一次」。
//
// 用法：
//   const wxStub = installWxStub()
//   wxStub.login.mockResolvedValueOnce({ code: 'CODE-1', errMsg: 'login:ok' })
//   wxStub.request.mockResolvedValueOnce(jsonResponse({ code: 0, data: {...}, message: 'ok' }))

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

const WX_METHODS = ['login', 'getStorageSync', 'setStorageSync', 'removeStorageSync', 'request'] as const

/**
 * 把 `wx` 全局装进 `globalThis`，返回可直接编排与断言的桩。
 *
 * ⚠️ **调用方不必自己清理。** 每个测试结束后由 `test/support/setup.ts` 卸载（`afterEach`），
 * 因此单个测试改的桩状态不会泄漏到下一个测试 —— 这是 issue #16 的一条验收标准。
 * 需要手动卸载时用返回的 `uninstall`。
 */
export function installWxStub(): WxStub & { uninstall: () => void } {
  const host = globalThis as unknown as Record<string, unknown>

  // storage 的默认实现：一个真的会读写的内存表。
  // 为什么默认不是「未编排即失败」：storage 的语义就是读回自己写过的东西，
  // 让每个用例都手写一遍 getStorageSync 的返回值只会把真实验为噪音。
  // 需要「storage 里本来就有 token」时，照样可以覆盖：getStorageSync.mockReturnValueOnce('...')。
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

  host.wx = stub

  return {
    ...stub,
    uninstall: () => {
      if (isWxStub(host.wx)) delete host.wx
    },
  }
}

/** 判断 `globalThis.wx` 是不是本模块装的桩 —— 不覆盖测试自己 set 的其他对象。 */
function isWxStub(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  return WX_METHODS.every((name) => name in value)
}

/** 当前装在 `globalThis` 上的桩；没装时为 `undefined`。 */
export function currentWxStub(): WxStub | undefined {
  const host = globalThis as unknown as Record<string, unknown>
  return isWxStub(host.wx) ? (host.wx as WxStub) : undefined
}

/** 卸载 `globalThis` 上的桩（由 setup 文件逐测试调用）。 */
export function uninstallWxStub(): void {
  const host = globalThis as unknown as Record<string, unknown>
  if (isWxStub(host.wx)) delete host.wx
}
