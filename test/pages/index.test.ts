// **首页扫码主行动** 的验收 —— issue #61（spec #57 §2）。
//
// 本文件守两半：
//   1. **行为**：四种扫码结果各走到哪里（进柜机页 / 留在首页提示 / 静默 / 提示）；
//   2. **形状**：闸门三态仍由 `phase` 驱动、按下反馈是 0ms 换色、路径只有一个家、
//      不探测相机权限、不建订单卡 / 附近入口、页面不碰 storage。
//
// ⚠️ 断言落在页面外部行为上：`wx.scanCode` 收到了什么、`wx.navigateTo` 去了哪里、
// `showToast` 说了哪句话。不测页面内部怎么组织方法。
//
// ⚠️ `showToast` 用 `vi.mock` 换掉反馈适配层：本文件验的是「页面让用户看到哪句话」，
// Vant 内部由 `test/utils/feedback.test.ts` 负责。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWxStub, jsonResponse, reply } from '../helpers/wx'
import { respondInOrder } from '../helpers/http'
import { HOME_PAGE_COPY, NEARBY_PATH, PAGE_TITLES } from '../../miniprogram/startup/copy'
import { LOCKER_PATH } from '../../miniprogram/utils/routes'
import type { InstalledWxStub } from '../helpers/wx'

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('../../miniprogram/utils/feedback', () => ({
  showToast: mocks.showToast,
  confirm: mocks.confirm,
}))

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const indexDir = join(repoRoot, 'miniprogram', 'pages', 'index')
const indexSource = (): string => readFileSync(join(indexDir, 'index.ts'), 'utf8')
const indexWxml = (): string => readFileSync(join(indexDir, 'index.wxml'), 'utf8')
const indexScss = (): string => readFileSync(join(indexDir, 'index.scss'), 'utf8')

/** 一份契约形状的 `13.1` 成功响应体。 */
function loginBody(): Record<string, unknown> {
  return {
    code: 0,
    message: 'ok',
    data: {
      accessToken: 'ACCESS-1',
      refreshToken: 'REFRESH-1',
      expiresIn: 7200,
      user: { id: 88, nickname: null, avatar: null, phone: null, score: 100, status: 1 },
    },
  }
}

/** 剥掉注释后的源码 —— 结构断言读它（注释里讨论契约是必要的）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

let definition: Record<string, unknown> | null = null

beforeEach(() => {
  definition = null
  mocks.showToast.mockReset()
  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (def: Record<string, unknown>): void => {
    definition = def
  }
})

/** 加载首页组件定义 —— `vi.resetModules()` 让模块级闸门单例每例都是新的。 */
async function loadPage(): Promise<Record<string, unknown>> {
  vi.resetModules()
  await import('../../miniprogram/pages/index/index')
  if (definition === null) throw new Error('index.ts 没有调用 Component()')
  return definition
}

interface PageInstance {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  triggerEvent: (name: string) => void
  attached?: () => void
  detached?: () => void
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
  const lifetimes = def.lifetimes as Record<string, () => void> | undefined
  instance.attached = lifetimes?.['attached']?.bind(instance)
  instance.detached = lifetimes?.['detached']?.bind(instance)
  return instance
}

/** 让挂起的微任务链走完（登录链是纯微任务驱动的）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

/**
 * 装好扫码桩并加载页面。
 *
 * `wx.scanCode` 与 `wx.navigateTo` 都按「真实回话」编排 —— 未编排即抛错的桩会让
 * 「某条分支根本没调 API」以异常形式爆出来，而本文件要断言的正是「调没调」。
 */
async function scanWith(outcome: {
  result?: string
  errMsg?: string
}): Promise<{ wx: InstalledWxStub; page: PageInstance }> {
  const wx = installWxStub()
  wx.scanCode.mockImplementation((options) => {
    if (outcome.errMsg === undefined) {
      options.success?.({ result: outcome.result ?? '', errMsg: 'scanCode:ok' })
    } else {
      options.fail?.({ errMsg: outcome.errMsg })
    }
  })
  wx.navigateTo.mockImplementation(() => {})
  const def = await loadPage()
  const page = instantiate(def)
  ;(page.onScan as (() => void) | undefined)?.()
  return { wx, page }
}

describe('#61 首页 · 扫码四种结果', () => {
  it('⚠️ 扫到柜机码 → `navigateTo` 柜机页，并带上解析后的 `code`', async () => {
    const { wx } = await scanWith({ result: 'https://locker.example.com/l/WD-01' })

    expect(wx.scanCode).toHaveBeenCalledTimes(1)
    expect(wx.navigateTo).toHaveBeenCalledTimes(1)
    const url = (wx.navigateTo.mock.calls[0]?.[0] as { url: string } | undefined)?.url ?? ''
    expect(url).toBe(`/${LOCKER_PATH}?code=WD-01`)
    expect(mocks.showToast).not.toHaveBeenCalled()
  })

  it('⚠️ 非柜机码 → 留在首页给一句提示，绝不跳转', async () => {
    const { wx } = await scanWith({ result: 'https://example.com/not-a-locker' })

    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledTimes(1)
    expect(mocks.showToast).toHaveBeenCalledWith(HOME_PAGE_COPY.notLockerCode)
  })

  it('⚠️ 用户取消（`errMsg` 含 cancel）→ 静默，不提示也不跳转', async () => {
    const { wx } = await scanWith({ errMsg: 'scanCode:fail cancel' })

    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(mocks.showToast).not.toHaveBeenCalled()
  })

  it('⚠️ 其他失败 → 一句「扫码没成功，请重试」，不按成因分叉', async () => {
    const { wx } = await scanWith({ errMsg: 'scanCode:fail camera error' })

    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledTimes(1)
    expect(mocks.showToast).toHaveBeenCalledWith(HOME_PAGE_COPY.scanFailed)
  })

  it('⚠️ 不传 `onlyFromCamera` —— 默认允许从相册选码', async () => {
    const { wx } = await scanWith({ result: 'https://locker.example.com/l/WD-01' })

    const options = wx.scanCode.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(options).toBeDefined()
    expect(options).not.toHaveProperty('onlyFromCamera')
    expect(typeof options?.['success']).toBe('function')
    expect(typeof options?.['fail']).toBe('function')
  })
})

describe('#61 首页 · 闸门三态', () => {
  it('冷启动首帧是 loading（首页同构骨架），登录成功后 ready', async () => {
    const wx = installWxStub()
    wx.login.mockImplementation(reply({ code: 'WX-CODE', errMsg: 'login:ok' }))
    wx.request.mockImplementation(respondInOrder([jsonResponse(loginBody())]))

    const def = await loadPage()
    const page = instantiate(def)
    expect(page.data.phase).toBe('loading')
    page.attached?.()
    await settle()
    expect(page.data.phase).toBe('ready')
    expect(page.data.wordmark).toBe(HOME_PAGE_COPY.wordmark)
    expect(page.data.tagline).toBe(HOME_PAGE_COPY.tagline)
    expect(page.data.scanLabel).toBe(HOME_PAGE_COPY.scanButton)
  })

  it('登录失败 → failed（整页失败出口仍由启动态驱动）', async () => {
    const wx = installWxStub()
    wx.login.mockImplementation(reply({ code: 'WX-CODE', errMsg: 'login:ok' }))
    wx.request.mockImplementation(respondInOrder([{ errMsg: 'request:fail timeout' }]))

    const def = await loadPage()
    const page = instantiate(def)
    page.attached?.()
    await settle()
    expect(page.data.phase).toBe('failed')
  })

  it('⚠️ 模板按 phase 互斥渲染：loading → 首页骨架，ready → 首页，failed → 失败出口', () => {
    const wxml = stripComments(indexWxml())
    expect(wxml).toMatch(/<skeleton[^>]*wx:if="\{\{ phase === 'loading' \}\}"/)
    expect(wxml).toMatch(/<skeleton[^>]*variant="home"/)
    expect(wxml).toMatch(/wx:elif="\{\{ phase === 'ready' \}\}"/)
    expect(wxml).toMatch(/<failure-exit\b/)
  })
})

describe('#61 首页 · 文案与路由只有一个家', () => {
  it('⚠️ 导航栏标题留空，但 PAGE_TITLES 仍登记「首页」', () => {
    const wxml = stripComments(indexWxml())
    expect(wxml).toMatch(/<navigation-bar\b[^>]*back="\{\{false\}\}"/)
    expect(wxml).not.toMatch(/<navigation-bar\b[^>]*title=/)
    expect(PAGE_TITLES['pages/index/index']).toBe('首页')
  })

  it('⚠️ 柜机码路径来自 `LOCKER_PATH` 常量，且该页已注册在 app.json', () => {
    const source = stripComments(indexSource())
    expect(source).toContain('LOCKER_PATH')
    expect(source).not.toMatch(/url\s*:\s*['"`]\/?pages\//)
    expect(source).not.toMatch(/^\s*const\s+\w*PATH\w*\s*=\s*['"`]pages\//m)

    const appJson = JSON.parse(
      readFileSync(join(repoRoot, 'miniprogram', 'app.json'), 'utf8'),
    ) as { pages: string[] }
    expect(appJson.pages).toContain(LOCKER_PATH)
  })

  it('⚠️ 模板只引用文案变量，没有把品牌 / 按钮 / 提示写成字面量', () => {
    const wxml = stripComments(indexWxml())
    expect(wxml).toContain('{{ wordmark }}')
    expect(wxml).toContain('{{ tagline }}')
    expect(wxml).toContain('{{ scanLabel }}')
    for (const literal of [
      HOME_PAGE_COPY.wordmark,
      HOME_PAGE_COPY.tagline,
      HOME_PAGE_COPY.scanButton,
      HOME_PAGE_COPY.notLockerCode,
      HOME_PAGE_COPY.scanFailed,
    ]) {
      expect(wxml, `wxml 里出现了文案字面量「${literal}」`).not.toContain(literal)
    }
  })
})

describe('#61 首页 · 硬约束（源码守卫）', () => {
  it('⚠️ 不探测 / 不引导相机权限 —— 不做 `getSetting` / `openSetting` / `authorize`', () => {
    const source = stripComments(indexSource()) + stripComments(indexWxml())
    for (const api of ['getSetting', 'openSetting', 'authorize', 'scope.camera']) {
      expect(source, `首页出现了相机权限探测「${api}」`).not.toContain(api)
    }
    expect(source).not.toContain('相机权限')
  })

  it('⚠️ 页面零 storage —— 源码里一个 storage API 都没有', () => {
    const source = stripComments(indexSource())
    for (const api of ['getStorageSync', 'setStorageSync', 'removeStorageSync', 'getStorage']) {
      expect(source, `index.ts 里出现了 ${api}`).not.toContain(api)
    }
  })

  it('⚠️ 订单区仍是占位：没有订单卡组件、没有订单列表数据', () => {
    const wxml = stripComments(indexWxml())
    for (const forbidden of ['order-card', 'wx:for="{{ orders }}"']) {
      expect(wxml, `首页提前实现了「${forbidden}」—— 订单区归 #67`).not.toContain(forbidden)
    }
  })

  it('⚠️ 附近入口条只指路：无动态数据，点击 switchTab 到 NEARBY_PATH', async () => {
    const wx = installWxStub()
    wx.switchTab.mockImplementation(() => {})
    const def = await loadPage()
    const page = instantiate(def)

    ;(page.onNearby as (() => void) | undefined)?.()

    expect(wx.switchTab).toHaveBeenCalledTimes(1)
    expect(wx.switchTab.mock.calls[0]?.[0]).toMatchObject({ url: `/${NEARBY_PATH}` })
    expect(wx.getLocation).not.toHaveBeenCalled()
    expect(wx.request).not.toHaveBeenCalled()

    const wxml = stripComments(indexWxml())
    expect(wxml).toContain('class="home__nearby"')
    expect(wxml).toContain('{{ nearbyLabel }}')
    expect(wxml).toContain('name="nearby.station"')
    expect(wxml).not.toMatch(/nearby[^>]*(distance|count|余位)/i)
    expect(page.data.nearbyLabel).toBe(HOME_PAGE_COPY.nearbyEntry)
  })

  it('⚠️ 按下反馈只有 0ms 换色：hover-class 换 `$color-primary-pressed`，无 transition / transform / opacity', () => {
    const wxml = stripComments(indexWxml())
    expect(wxml).toContain('hover-class="home__scan_active"')

    const scss = stripComments(indexScss())
    expect(scss).toMatch(/\.home__scan_active[\s\S]*\$color-primary-pressed/)
    expect(scss).not.toMatch(/\btransition(?:-[\w-]+)?\s*:/)
    expect(scss).not.toMatch(/\banimation(?:-[\w-]+)?\s*:/)
    expect(scss).not.toMatch(/@(?:-\w+-)?keyframes/)
    expect(scss).not.toMatch(/\btransform\s*:/)
    expect(scss).not.toMatch(/\bopacity\s*:/)
    expect(scss).not.toMatch(/:active\b/)
  })

  it('⚠️ 品牌图标 / 扫码图标走语义 icon 组件，不引图片资源', () => {
    const wxml = stripComments(indexWxml())
    expect(wxml).toContain('<icon')
    expect(wxml).toContain('name="cell.package"')
    expect(wxml).toContain('name="action.scan"')
    expect(wxml).not.toContain('<image')
  })
})
