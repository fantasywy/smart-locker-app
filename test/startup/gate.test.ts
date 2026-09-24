// **启动闸门**的验收 —— issue #20 的第一组 criteria（两个状态 + 四类成因一致 + 重试）。
//
// 断言落在**外部行为**上（#15 Testing Decisions）：闸门的 `state` 是什么、订阅收到了什么、
// `start()` 前后各是什么。**不测**内部实现 —— 不测 `setState` 被调用几次、
// 不测监听器集合的内部结构。
//
// ⚠️ 依赖是**注入**的（`createStartupGate(ensureLogin)`），所以这里不必编排
// `wx.login` / `wx.request` 的时序：本文件验的是**闸门的形态**，
// 「登录链自己怎么走」已由 `test/api/auth-session.test.ts` 覆盖。
// 用替身还有一个好处 —— 「四类成因表现一致」这条只有在能自由造出四类失败时才验得了。

import { describe, expect, it, vi } from 'vitest'
import { createStartupGate } from '../../miniprogram/startup/gate'
import type { StartupState } from '../../miniprogram/startup/gate'
import type { UnifiedError } from '../../miniprogram/request/types'

/**
 * `01` §4 穷举的**四类登录失败成因** —— 逐条对应一个真实的统一异常对象。
 *
 * ⚠️ 这四条的 `kind` / `code` / `httpStatus` 各不相同，正是「表现必须一致」这条的
 * 试金石：若闸门按 `kind` 或 `code` 分叉，四条里必然有某几条画出不同的东西。
 */
const FAILURE_CAUSES: readonly { name: string; error: UnifiedError }[] = [
  {
    name: '网络不通',
    // `07` §4.2：网络失败 / 超时时**没有** HTTP 往返 ⇒ 状态码与业务码都是 null。
    error: { httpStatus: null, code: null, message: 'request:fail timeout', kind: 'network' },
  },
  {
    name: 'wx.login 失败',
    // `01` §4 的成因穷举里有它；`api/session.ts` 把 `wx.login` 的失败也归成 `network`。
    error: { httpStatus: null, code: null, message: 'login:fail', kind: 'network' },
  },
  {
    name: '13.1 返回 8001',
    // `8001` 走 HTTP 200 + 业务码 ⇒ `kind: 'business'`，**不是** unauthorized
    // （`types/auth.ts` 的 `LoginRequest.code` 注释、§15 :1307）。
    error: { httpStatus: 200, code: 8001, message: '微信登录失败', kind: 'business' },
  },
  {
    name: '后端 5xx',
    // `normalize.ts`：非 2xx 的失败不得被 body 的 code 洗白，归 `network`。
    error: { httpStatus: 500, code: 500, message: 'Internal Server Error', kind: 'network' },
  },
]

describe('#20 启动闸门：三个状态（01 §3.2 / §3.4）', () => {
  it('冷启动初始态是 loading（骨架屏那一帧）', () => {
    const gate = createStartupGate(() => Promise.resolve({ ok: true, data: null }))

    // ⚠️ 还没调 `start()` 就必须是 loading —— 页面 `onLoad` 先读 `state` 画首帧，
    // 若初始态是别的，骨架屏那一帧就永远不会出现（`01` §3.2「结构先出现」）。
    expect(gate.state.phase).toBe('loading')
  })

  it('⚠️ 登录链跑完之前一直是 loading —— 骨架屏先出现，数据区等 token', async () => {
    // 一个「由测试决定何时完成」的登录链：闸门必须在它未完成时保持 loading。
    let release!: (result: { ok: true; data: null }) => void
    const pending = new Promise<{ ok: true; data: null }>((resolve) => {
      release = resolve
    })
    const gate = createStartupGate(() => pending)

    const started = gate.start()

    // ⚠️ 这一条是本票一半的内容：**让出微任务之后**（而非只是同步地）仍是 loading。
    // 若闸门在 `start()` 里同步跑完登录链，页面永远看不到骨架屏。
    await Promise.resolve()
    expect(gate.state.phase).toBe('loading')

    release({ ok: true, data: null })
    await started
    expect(gate.state.phase).toBe('ready')
  })

  it('登录成功 → ready（业务数据区可以渲染了）', async () => {
    const gate = createStartupGate(() => Promise.resolve({ ok: true, data: null }))

    const state = await gate.start()

    expect(state.phase).toBe('ready')
    expect(gate.state.phase).toBe('ready')
  })

  it('⚠️ ready 不携带业务数据 —— 闸门只管「登录好了没」，不管数据（01 §3.2 不缓存）', async () => {
    // 登录响应里塞了一份看起来很诱人的用户信息；闸门**不得**把它挂到状态上。
    // 挂上去就等于开了「把登录时刻的快照当业务数据用」的口子（`04` §5 禁本地快照）。
    const gate = createStartupGate(() =>
      Promise.resolve({
        ok: true,
        // 一个形状可疑的 `data`：闸门连它是什么都不该关心。
        data: { user: { score: 100, status: 'NORMAL' } },
      }),
    )

    const state = await gate.start()

    expect(state).toEqual({ phase: 'ready' })
  })

  it('⚠️ 登录成功且 user.status 为 BLACKLISTED → 照样 ready（01 §1.4 登录不被拒）', async () => {
    // 承 `02` 带住的陷阱、`04` §5「拦截权只能属于服务端」：受限用户**允许登录**。
    // 闸门放行；是否受限 由动作点的 `5004`（`kind: 'restricted'`）说了算。
    // ⚠️ 本地若据此拦截，最坏的结果是**把已经解禁的用户挡在门外**。
    const gate = createStartupGate(() =>
      Promise.resolve({
        ok: true,
        data: { user: { score: 40, status: 'BLACKLISTED' } },
      }),
    )

    const state = await gate.start()

    expect(state.phase).toBe('ready')
  })
})

describe('#20 启动闸门：四类失败成因表现一致（01 §4）', () => {
  for (const cause of FAILURE_CAUSES) {
    it(`登录失败（${cause.name}）→ failed，且 error 原样带住以便诊断`, async () => {
      const gate = createStartupGate(() => Promise.resolve({ ok: false, error: cause.error }))

      const state = await gate.start()

      expect(state.phase).toBe('failed')
      // ⚠️ `error` 是给**诊断与测试**看的，不是给界面看的 —— 失败出口的文案是
      // `09` §7.2 的定稿，不含错误码。它的存在正是「四类成因确实都落到了这里」的证据。
      expect(state).toEqual({ phase: 'failed', error: cause.error })
    })
  }

  it('⚠️ 四类成因的落点是**同一个状态形状** —— 没有哪种成因多一个字段或少一个分支', async () => {
    // 逐条跑完之后，把四种 failed 态**两两对比去掉 error 之后的部分**：
    // 它们必须逐字相同。若闸门给某类成因加了一个 `retryable: false` 之类的分支
    // （那正是「有的页能重试、有的页不能」的来源），这条会当场失败。
    const shapes: string[] = []
    for (const cause of FAILURE_CAUSES) {
      const gate = createStartupGate(() => Promise.resolve({ ok: false, error: cause.error }))
      const state = await gate.start()
      expect(state.phase).toBe('failed')
      if (state.phase !== 'failed') throw new Error('unreachable')
      // 扣掉 `error`（唯一的差异源）之后的形状。
      const { phase } = state
      shapes.push(JSON.stringify({ phase, keys: Object.keys(state).sort() }))
    }

    expect(
      new Set(shapes).size,
      `四类成因的 failed 态形状必须完全一致，实际出现 ${
        new Set(shapes).size
      } 种：\n${shapes.join('\n')}`,
    ).toBe(1)
  })
})

describe('#20 启动闸门：重试（01 §4 / 09 §6 第 33 条）', () => {
  it('⚠️ 失败后重试 → 重新走完整登录链并成功渲染', async () => {
    const ensureLogin = vi
      .fn<() => Promise<{ ok: false; error: UnifiedError } | { ok: true; data: null }>>()
      .mockResolvedValueOnce({ ok: false, error: FAILURE_CAUSES[0]!.error })
      .mockResolvedValueOnce({ ok: true, data: null })
    const gate = createStartupGate(ensureLogin)

    const failed = await gate.start()
    expect(failed.phase).toBe('failed')

    // 「重试」= **再跑一次启动链**，不是「重发上一次失败的请求」。
    const retried = await gate.start()

    expect(retried.phase).toBe('ready')
    expect(ensureLogin).toHaveBeenCalledTimes(2)
  })

  it('⚠️ 重试走的是**完整登录链** —— 成因是 wx.login 失败时也照样能重试', async () => {
    // 这一条是「重试 = 重跑启动链」与「重试 = 重发上次的请求」的分界。
    // `wx.login` 失败时**根本没有请求可重发**，只有重跑整条链才救得回来。
    // 断言方式：登录链共被调起两次，且第二次成功后状态是 ready。
    const ensureLogin = vi
      .fn<() => Promise<{ ok: false; error: UnifiedError } | { ok: true; data: null }>>()
      .mockResolvedValueOnce({
        ok: false,
        // `wx.login` 失败的长相：没有 HTTP 往返，message 是微信侧 errMsg。
        error: { httpStatus: null, code: null, message: 'login:fail', kind: 'network' },
      })
      .mockResolvedValueOnce({ ok: true, data: null })
    const gate = createStartupGate(ensureLogin)

    await gate.start()
    const second = await gate.start()

    expect(second.phase).toBe('ready')
    expect(ensureLogin).toHaveBeenCalledTimes(2)
  })

  it('重试期间回到 loading —— 界面从失败出口切回骨架屏，而不是停在失败上', async () => {
    let release!: (result: { ok: true; data: null }) => void
    const ensureLogin = vi
      .fn<() => Promise<{ ok: false; error: UnifiedError } | { ok: true; data: null }>>()
      .mockResolvedValueOnce({ ok: false, error: FAILURE_CAUSES[0]!.error })
      .mockImplementationOnce(
        () =>
          new Promise<{ ok: true; data: null }>((resolve) => {
            release = resolve
          }),
      )
    const gate = createStartupGate(ensureLogin)

    await gate.start()
    const retrying = gate.start()

    // 登录链还没回来 —— 必须已经回到 loading（否则用户会盯着失败页怀疑按钮没反应）。
    await Promise.resolve()
    expect(gate.state.phase).toBe('loading')

    release({ ok: true, data: null })
    await retrying
    expect(gate.state.phase).toBe('ready')
  })

  it('重试再次失败 → 仍落同一个出口（不会退化成别的状态）', async () => {
    const ensureLogin = vi
      .fn<() => Promise<{ ok: false; error: UnifiedError }>>()
      .mockResolvedValue({ ok: false, error: FAILURE_CAUSES[3]!.error })
    const gate = createStartupGate(ensureLogin)

    expect((await gate.start()).phase).toBe('failed')
    expect((await gate.start()).phase).toBe('failed')
    expect(gate.state.phase).toBe('failed')
  })

  it('⚠️ 已 ready 时再 start() **不重跑登录链**、也不退回 loading（页面重建会走到这里）', async () => {
    // ⚠️ 这条钉的是一个**真实缺陷**（review 逼出来的）：
    // `run()` 的第一行会把状态设回 `loading`，于是「对已 ready 的闸门调 start()」
    // 会让界面退回骨架屏并把整条登录链重跑一遍。
    //
    // 触发路径是**页面重建**：闸门是模块级单例（`pages/index/index.ts`），
    // 用户退出首页再进来时 `attached` 会再调一次 `start()` ——
    // 已登录用户于是看到一次无谓的骨架屏闪烁 + 一次多余的 `wx.login` / `13.1`。
    const ensureLogin = vi.fn(() => Promise.resolve({ ok: true as const, data: null }))
    const gate = createStartupGate(ensureLogin)

    await gate.start()
    expect(gate.state.phase).toBe('ready')

    const again = gate.start()

    // 状态**不得**退回 loading —— 否则页面会画一帧骨架屏。
    expect(gate.state.phase).toBe('ready')
    // 登录链**不得**重跑。
    expect(ensureLogin).toHaveBeenCalledTimes(1)
    expect((await again).phase).toBe('ready')
    expect(ensureLogin).toHaveBeenCalledTimes(1)
  })

  it('⚠️ 但 `failed` 时 start() **必须**重跑 —— 重试不能也被短路掉', async () => {
    // 上一条的短路**只对 ready 成立**：失败态必须能重试（`01` §4）。
    // 若把短路写成「只要不是 loading 就返回」，重试会静默失效 ——
    // 按钮点了没反应，而用户看到的是一个永远不会好的失败页。
    const ensureLogin = vi
      .fn<() => Promise<{ ok: false; error: UnifiedError } | { ok: true; data: null }>>()
      .mockResolvedValueOnce({ ok: false, error: FAILURE_CAUSES[0]!.error })
      .mockResolvedValueOnce({ ok: true, data: null })
    const gate = createStartupGate(ensureLogin)

    await gate.start()
    expect(gate.state.phase).toBe('failed')

    expect((await gate.start()).phase).toBe('ready')
    expect(ensureLogin).toHaveBeenCalledTimes(2)
  })

  it('⚠️ 并发 start() 共用同一次飞行 —— 不会打出两条登录链（承 07 §4.3 单一飞行）', async () => {
    // 冷启动与用户手速极快的重试、或将来多个部分同时触发启动时，不该各跑一条链。
    // ⚠️ 这条与请求层 `inFlightRecovery` 是同一取向：**全局恰好一次**。
    let release!: (result: { ok: true; data: null }) => void
    const ensureLogin = vi.fn(
      () =>
        new Promise<{ ok: true; data: null }>((resolve) => {
          release = resolve
        }),
    )
    const gate = createStartupGate(ensureLogin)

    const first = gate.start()
    const second = gate.start()

    expect(ensureLogin).toHaveBeenCalledTimes(1)

    release({ ok: true, data: null })
    expect((await first).phase).toBe('ready')
    expect((await second).phase).toBe('ready')
  })
})

describe('#20 启动闸门：订阅（页面据此 setData）', () => {
  it('状态变化逐个通知订阅者，且携带新状态', async () => {
    const gate = createStartupGate(() => Promise.resolve({ ok: true, data: null }))
    const seen: StartupState[] = []
    gate.subscribe((state) => seen.push(state))

    await gate.start()

    expect(seen.map((s) => s.phase)).toEqual(['loading', 'ready'])
  })

  it('⚠️ 订阅时不立即回调 —— 页面自己在 onLoad 读 state 画首帧，补发会让首帧画两遍', async () => {
    const gate = createStartupGate(() => Promise.resolve({ ok: true, data: null }))
    const listener = vi.fn()

    gate.subscribe(listener)

    expect(listener).not.toHaveBeenCalled()
  })

  it('退订之后不再收到通知', async () => {
    const gate = createStartupGate(() => Promise.resolve({ ok: true, data: null }))
    const listener = vi.fn()
    const unsubscribe = gate.subscribe(listener)

    unsubscribe()
    await gate.start()

    expect(listener).not.toHaveBeenCalled()
  })

  it('⚠️ 状态是**换新对象**而不是就地改 —— 页面可以靠引用判等跳过无谓 setData', async () => {
    const gate = createStartupGate(() => Promise.resolve({ ok: true, data: null }))
    const before = gate.state

    await gate.start()

    expect(gate.state).not.toBe(before)
  })
})
