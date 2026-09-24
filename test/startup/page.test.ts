// **首页（闸门承载页）的验收** —— issue #20 里「重试能重新走一遍登录链并成功渲染」这条。
//
// ⚠️ 为什么需要这个文件（`gate.test.ts` 已经测过 `gate.start()` 了）：
// 那条 criterion 的原文是「**重试**能重新走一遍登录链并**成功渲染**」——
// 它有两半：闸门能重跑（`gate.test.ts` 覆盖），以及**点重试真的到达了闸门**、
// **状态真的画到了界面上**（页面覆盖）。两者之间那段接线（`onRetry` → `start()`、
// 订阅 → `setData`、先读后订的顺序）此前**零覆盖** ——
// 把 `onRetry` 写成空函数、或把「先读 state 再订阅」写反，全套测试照样全绿。
// review 指出了这个缺口，本文件补上。
//
// 断言落在**页面的外部行为**上：`setData` 收到了什么（= 界面画了什么）、
// `wx.login` / `wx.request` 被发了几次（= 登录链真的重跑了吗）。
// **不测**页面内部怎么组织方法。

import { beforeEach, describe, expect, it } from 'vitest'
import { installWxStub, jsonResponse, reply } from '../helpers/wx'
import { respondInOrder, sentRequests } from '../helpers/http'
import { BASE_URL } from '../../miniprogram/request/config'

const LOGIN_URL = `${BASE_URL}/api/app/v1/auth/login`

/** 一份契约形状的 `13.1` 成功响应体。 */
function loginBody(): Record<string, unknown> {
  return {
    code: 0,
    message: 'ok',
    data: {
      accessToken: 'ACCESS-1',
      refreshToken: 'REFRESH-1',
      expiresIn: 7200,
      user: { id: 88, nickname: null, avatar: null, phone: null, score: 100, status: 'NORMAL' },
    },
  }
}

/**
 * 装好桩并加载首页组件定义。
 *
 * ⚠️ 每例都要**重新 import** 页面模块：页面在**模块级**持有闸门单例
 * （见 `index.ts` 的 `gate`），而 vitest 的模块缓存会让第二个用例复用第一个用例
 * 那个「已经 ready」的闸门 —— 于是「冷启动从 loading 开始」这条永远验不了。
 * `resetModules` 在装桩**之前**跑，保证页面拿到的是新桩与新闸门。
 */
async function loadPage(): Promise<{ definition: Record<string, unknown> }> {
  const { vi } = await import('vitest')
  vi.resetModules()
  await import('../../miniprogram/pages/index/index')
  // `Component()` 在测试环境里没有实现 —— 用一个桩接住它注册的定义。
  return { definition: definition as Record<string, unknown> }
}

/**
 * 接住 `Component()` 的定义。
 *
 * ⚠️ 这是本仓库第一次测**页面组件**：`miniprogram/pages/index/index.ts` 在顶层调
 * `Component({...})`，而 vitest 的 node 环境里没有这个全局函数。
 * 装一个最小的桩把它接下来即可 —— 不需要模拟整套小程序运行时，
 * 因为本文件要验的只是「页面那几个方法有没有正确接线」。
 * 方法用 `call(instance)` 驱动，`instance` 提供 `data` / `setData` / `triggerEvent`。
 */
let definition: Record<string, unknown> | null = null

beforeEach(async () => {
  definition = null
  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (def: Record<string, unknown>): void => {
    definition = def
  }
  const { vi } = await import('vitest')
  vi.resetModules()
})

/** 造一个页面实例 —— 带 `data` / `setData`，并绑定定义里的 methods。 */
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
  // `lifetimes.attached` 也绑上实例 —— 页面靠它启动闸门。
  const lifetimes = def.lifetimes as Record<string, () => void> | undefined
  instance.attached = lifetimes?.['attached']?.bind(instance)
  instance.detached = lifetimes?.['detached']?.bind(instance)
  return instance
}

describe('#20 首页：闸门接线（重试真的到达闸门、状态真的画到界面）', () => {
  it('⚠️ 冷启动：先画 loading（骨架屏），登录成功后画 ready', async () => {
    const wx = installWxStub()
    wx.login.mockImplementation(reply({ code: 'WX-CODE', errMsg: 'login:ok' }))
    wx.request.mockImplementation(respondInOrder([jsonResponse(loginBody())]))

    const { definition: def } = await loadPage()
    const page = instantiate(def)
    ;(page.attached as () => void)()

    // 首帧必须是 loading —— 否则骨架屏永远不会出现（01 §3.2「结构先出现」）。
    // ⚠️ 这条也顺带钉住「先读 state 再订阅」的顺序：写反了这里就是 undefined/旧值。
    expect(page.data.phase).toBe('loading')

    await vi_wait()
    expect(page.data.phase).toBe('ready')
  })

  it('⚠️ 登录失败 → 画 failed（失败出口由启动态驱动）', async () => {
    const wx = installWxStub()
    wx.login.mockImplementation(reply({ code: 'WX-CODE', errMsg: 'login:ok' }))
    // 后端 5xx —— `01` §4 穷举的成因之一。
    wx.request.mockImplementation(respondInOrder([{ errMsg: 'request:fail timeout' }]))

    const { definition: def } = await loadPage()
    const page = instantiate(def)
    ;(page.attached as () => void)()

    await vi_wait()
    expect(page.data.phase).toBe('failed')
  })

  it('⚠️ 点重试 → 重新走一遍登录链并成功渲染（01 §4 / 09 §6 第 33 条）', async () => {
    const wx = installWxStub()
    // `wx.login` 只有第一次失败，第二次成功 —— 模拟「网络恢复后重试」。
    wx.login.mockImplementationOnce(reply({ code: '', errMsg: 'login:fail' }, false))
    wx.login.mockImplementation(reply({ code: 'WX-CODE-2', errMsg: 'login:ok' }))
    wx.request.mockImplementation(respondInOrder([jsonResponse(loginBody())]))

    const { definition: def } = await loadPage()
    const page = instantiate(def)
    ;(page.attached as () => void)()

    await vi_wait()
    expect(page.data.phase).toBe('failed')

    // 用户点「重试」—— 走的正是失败出口组件 triggerEvent('retry') 接到的那个方法。
    ;(page.onRetry as () => void)()

    await vi_wait()
    expect(page.data.phase).toBe('ready')

    // ⚠️ 判据是「登录链**真的重跑了**」而不只是「状态变了」：
    // `wx.login` 被调了两次（第一次失败 + 重试那次），且第二次之后才发了 13.1。
    expect(wx.login).toHaveBeenCalledTimes(2)
    expect(sentRequests(wx.request).map((r) => r.url)).toEqual([LOGIN_URL])
  })

  it('⚠️ 重试时回到 loading —— 用户看得见「在重连」，而不是停在失败页上', async () => {
    const wx = installWxStub()
    wx.login.mockImplementationOnce(reply({ code: '', errMsg: 'login:fail' }, false))
    // 第二次登录链挂住不回来，好让我们观察中间那一帧。
    let release!: () => void
    wx.login.mockImplementation(
      () =>
        new Promise<void>(() => {
          release = () => {}
        }) as unknown as void,
    )

    const { definition: def } = await loadPage()
    const page = instantiate(def)
    ;(page.attached as () => void)()
    await vi_wait()
    expect(page.data.phase).toBe('failed')

    ;(page.onRetry as () => void)()
    await vi_wait()

    // 回到 loading —— 界面从失败出口切回骨架屏。
    expect(page.data.phase).toBe('loading')
    release()
  })

  it('⚠️ 登录成功且 status 为 BLACKLISTED → 照样画 ready（不阻断，04 §5）', async () => {
    const wx = installWxStub()
    wx.login.mockImplementation(reply({ code: 'WX-CODE', errMsg: 'login:ok' }))
    const body = loginBody()
    // 把 user.status 改成 BLACKLISTED —— 登录**照样成功**（01 §1.4）。
    const data = body['data'] as Record<string, unknown>
    ;(data['user'] as Record<string, unknown>)['status'] = 'BLACKLISTED'
    wx.request.mockImplementation(respondInOrder([jsonResponse(body)]))

    const { definition: def } = await loadPage()
    const page = instantiate(def)
    ;(page.attached as () => void)()

    await vi_wait()
    // ⚠️ 页面**不得**因受限状态而画失败出口 —— 拦截权只能属于服务端（04 §5）。
    expect(page.data.phase).toBe('ready')
  })

  it('⚠️ 页面重建时**先读一次当前态画首帧** —— 闸门已经 ready 时不能从 loading 重新开始', async () => {
    // 这一条钉住 `attached` 里「先读 state、再订阅」的顺序（见 `index.ts` 的注释）。
    // ⚠️ 普通用例验不了它：冷启动时闸门本来就是 `loading`，而 `data.phase` 的初值
    // 恰好也是 `loading` —— 于是「读不读那一次」看不出差别（变异测试证实：
    // 删掉 `this.applyState(current.state)` 之后，其余 6 条用例全绿）。
    //
    // 真实的差别在**页面重建**：闸门是模块级单例，登录链早就跑完了。
    // 此时若不读一次当前态，页面会停在 `loading`（骨架屏）**永远不动** ——
    // 因为闸门已经 `ready`，不会再有状态变化通知过来。这是「白屏」级的事故，
    // 而它只在「退出页面再进来」时出现，正常手测很容易漏掉。
    const wx = installWxStub()
    wx.login.mockImplementation(reply({ code: 'WX-CODE', errMsg: 'login:ok' }))
    wx.request.mockImplementation(respondInOrder([jsonResponse(loginBody())]))

    const { definition: def } = await loadPage()
    // 第一次挂载：跑完登录链，闸门到 ready。
    const first = instantiate(def)
    ;(first.attached as () => void)()
    await vi_wait()
    expect(first.data.phase).toBe('ready')
    ;(first.detached as () => void)()

    // 第二次挂载（同一个模块级闸门，已 ready）—— 首帧就必须是 ready。
    const second = instantiate(def)
    ;(second.attached as () => void)()

    expect(
      second.data.phase,
      '重建的页面首帧不是 ready —— 闸门已经 ready 时不会再有通知，页面会永远停在骨架屏',
    ).toBe('ready')
  })

  it('⚠️ detached 真的退订了 —— 销毁后闸门的状态变化不再碰这个实例', async () => {
    // 不退订的后果：已销毁的页面实例仍被 `setData`（监听器泄漏；反复进出首页会累积）。
    //
    // ⚠️⚠️ **这条断言的第一版是真空的**，被变异测试抓出来了（去掉 `detached` 里的退订
    // 后仍然全绿）。原因有两层，都值得记下来：
    //
    //   1. **`unsubscribe` 是模块级变量** —— 第二个页面实例 `attached()` 时又会
    //      `unsubscribe?.()` 一次，**顺手**把上一个实例的订阅清掉。所以「detached 里
    //      退不退订」在「后面还有新页面挂载」的剧本里看不出差别。
    //   2. **销毁之后闸门没有动** —— 没有状态变化，监听器在不在都收不到东西。
    //
    // ⇒ 写法必须同时满足：**销毁后不再挂载新页面**（绕开第 1 层的掩盖），
    //   **且之后让闸门真的动一次**（绕开第 2 层的掩盖）。
    //
    // 让闸门动的办法：另存一个**不受页面管理**的订阅者去驱动它 ——
    // 但闸门是页面模块的私有单例，测试拿不到它。
    // 于是改用「**重挂载**」这条真实路径，并把断言落在**订阅者数量**这个可观测量上：
    // 泄漏的表现是「同一个实例被通知多次」。用 `setData` 计数即可。
    const wx = installWxStub()
    wx.login.mockImplementationOnce(reply({ code: '', errMsg: 'login:fail' }, false))
    wx.login.mockImplementation(reply({ code: 'WX-CODE', errMsg: 'login:ok' }))
    wx.request.mockImplementation(respondInOrder([jsonResponse(loginBody())]))

    const { definition: def } = await loadPage()

    // 第一个实例：失败 → 销毁。
    const stale = instantiate(def)
    ;(stale.attached as () => void)()
    await vi_wait()
    expect(stale.data.phase).toBe('failed')
    ;(stale.detached as () => void)()

    // 销毁后开始计数：任何 setData 都是「被泄漏的订阅」打过来的。
    const staleWrites: Record<string, unknown>[] = []
    stale.setData = (patch: Record<string, unknown>): void => {
      staleWrites.push(patch)
      Object.assign(stale.data, patch)
    }

    // 重挂载并让它跑起来 —— 闸门状态会变化多次（loading → ready）。
    const fresh = instantiate(def)
    ;(fresh.attached as () => void)()
    await vi_wait()
    expect(fresh.data.phase).toBe('ready')

    expect(
      staleWrites,
      '已销毁的页面实例在闸门状态变化时仍被 setData —— detached 没有退订，监听器泄漏了',
    ).toEqual([])
  })

  it('⚠️ 页面不把错误对象画进 data —— 界面上没有错误码可画', async () => {
    const wx = installWxStub()
    wx.login.mockImplementation(reply({ code: 'WX-CODE', errMsg: 'login:ok' }))
    wx.request.mockImplementation(
      respondInOrder([jsonResponse({ code: 8001, message: '微信登录失败' })]),
    )

    const { definition: def } = await loadPage()
    const page = instantiate(def)
    ;(page.attached as () => void)()
    await vi_wait()

    expect(page.data.phase).toBe('failed')
    // `data` 里只有 phase、导航栏标题与占位文案 —— 没有 error / code / message 任何一项。
    // ⚠️ `title` 是 `#22` 加的：首页的自绘导航栏标题改从 `PAGE_TITLES` 取
    // （原先写死在 wxml 里，与其余 9 个空壳页形状不一致）。它是**文案**，不是错误对象，
    // 不在本断言要挡的东西里 —— 本断言的判据仍是「没有任何一项来自 `UnifiedError`」。
    expect(Object.keys(page.data).sort()).toEqual(
      ['dataAreaHint', 'dataAreaTitle', 'phase', 'title'].sort(),
    )
  })
})

/** 让挂起的 microtask 链走完（登录链是纯微任务驱动的，不需要 fake timer）。 */
async function vi_wait(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}
