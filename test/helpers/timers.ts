// fake timer 辅助 —— issue #16 的第二件交付物。
//
// 要驱动的两件事（票面原文）：
//   • **超时** —— 「请求超时」是 `07` §4.2 `network` 分类的三个触发之一（另两个是
//     请求失败与非 JSON 响应），也是 `01` §3.3 硬口径 1 唯一承认「可能已生效但响应丢失」
//     的分支。真等一个超时（小程序默认 60s）在测试里不可接受。
//   • **延迟响应** —— `07` §4.3 的单一飞行要验「刷新进行中，新请求到达并入同一队列」。
//     这条只有在能控制「响应什么时候回」时才验得了：若响应立即返回，第二个请求到达时
//     刷新早已结束，队列根本不会被走到。
//
// ⚠️ 只暴露「驱动时钟」的最小集合（恰好是下面 `FakeTimers` 的五个成员），
// 不做通用计时器封装：
//   • `tick()` / `settle()` —— 推进时间 / 只排空微任务。
//   • `setNow()` / `now()` —— 读拨系统时刻（验超时边界用）。
//   • `restore()` —— 还原真实计时器（正常不手动调，setup 逐测试做）。
// 刻意的：通用封装（比如「等 N 毫秒」）会把「这个 await 到底在等什么」变成隐式约定，
// 而本票要验的正是时序 —— 每一次等待都该在测试里看得见。

import { vi } from 'vitest'

export interface FakeTimers {
  /** 把一个延迟到点：`tick(500)` = 时间前进 500ms 并跑掉沿途的 setTimeout。 */
  tick: (ms?: number) => Promise<void>
  /** 排空已排定的微任务 —— 不推进时间，只让已 resolve 的 Promise 链走完。 */
  settle: () => Promise<void>
  /** 把系统时间拨到某个时刻（验超时边界用，不改变已排定的计时器）。 */
  setNow: (ms: number) => void
  /** 当前（fake）时钟。用来断言「时间真的被驱动了」，而不是只断言结果。 */
  now: () => number
  /** 还原真实计时器。正常不需要手动调用 —— setup 文件逐测试还原。 */
  restore: () => void
}

/**
 * 装上 fake timer 并返回驱动它的句柄。
 *
 * ⚠️ 调用方不必自己还原：`test/support/setup.ts` 的 `afterEach` 会做（`vi.useRealTimers()`），
 * 所以一个用例里推进过的时间不会泄漏到下一个用例。
 */
export function installFakeTimers(): FakeTimers {
  vi.useFakeTimers()
  return {
    tick: async (ms = 0) => {
      await vi.advanceTimersByTimeAsync(ms)
    },
    settle: async () => {
      // advanceTimersByTimeAsync(0) 会跑掉到期（= 已到点）的计时器并排空微任务，
      // 但不推进时钟。这正是「响应回来了，让 await 链走完」所需要的。
      await vi.advanceTimersByTimeAsync(0)
    },
    setNow: (ms) => {
      vi.setSystemTime(ms)
    },
    now: () => Date.now(),
    restore: () => {
      vi.useRealTimers()
    },
  }
}

/**
 * 一个「由测试决定何时返回」的 Promise —— 延迟响应的最小载体。
 *
 * 为什么不用 `setTimeout` 编排延迟：`07` §4.3 要验的是「响应**尚未**回来时，第二个请求
 * 到达并入了同一队列」。这需要的是一个**可控闸门**，不是一个有确定时长的延迟 ——
 * 时长会在慢机器上变成偶发失败，而闸门不会。
 *
 * ```ts
 * const gate = deferred<WxRequestSuccessResult>()
 * wxStub.request.mockImplementationOnce((options) => { gate.promise.then((r) => options.success?.(r)) })
 * // ……此时请求已发出但未回来，可以断言「没有第二次刷新」
 * gate.resolve(jsonResponse({ code: 0, data: null, message: 'ok' }))
 * await timers.settle()
 * ```
 */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
