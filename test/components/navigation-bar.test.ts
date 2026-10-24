// **自绘导航栏**（内部 `van-nav-bar`）的契约 —— #59 按 spec §11 收敛。
//
// 本文件守三件事：
//   1. **入参白名单**：只剩 `title` / `back` / `homeButton` / `ordersButton`，
//      颜色与背景入参删除，其余旧 weui 透传一律不留；
//   2. **三个出口各做一件事**：`back()` 只返回、`home()` 只回首页、`orders()` 只回订单列表；
//      缺省行为必须可用（页面不接事件也能跳），事件只是可选通知口；
//   3. **目标取常量**：`HOME_PATH` / `ORDER_LIST_PATH`，组件里没有页面路径字面量。
//
// ⚠️ 这里仍然用 `wx.*` 桩而不是渲染。`switchTab` / `navigateBack` 都是「未编排即抛错」，
// 所以「点了没反应」与「点了真的调了平台 API」在测试里是可区分的 —— 那正是 #23 修死按钮时
// 建立的判据，改造后继续沿用。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { installWxStub, reply } from '../helpers/wx'
import { ORDER_LIST_PATH } from '../../miniprogram/startup/copy'
import { HOME_PATH } from '../../miniprogram/utils/routes'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const navBarDir = join(repoRoot, 'miniprogram', 'components', 'navigation-bar')
const pagesDir = join(repoRoot, 'miniprogram', 'pages')

interface ComponentDefinition {
  properties: Record<string, unknown>
  data: Record<string, unknown>
  methods: Record<string, (...args: unknown[]) => unknown>
  lifetimes?: Record<string, (...args: unknown[]) => unknown>
}

/**
 * 读组件定义 —— 小程序的 `Component({...})` 是全局注册调用，不是模块导出。
 *
 * ⚠️ 用 `vi.resetModules()` + 动态 import：`Component` 必须在模块求值**之前**
 * 就挂在全局上，顶层 import 会在 `beforeEach` 之前跑完。
 */
async function loadComponentDefinition(): Promise<ComponentDefinition> {
  let captured: Record<string, unknown> | null = null
  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (definition: Record<string, unknown>) => {
    captured = definition
  }

  vi.resetModules()
  await import('../../miniprogram/components/navigation-bar/navigation-bar')

  delete host.Component
  if (captured === null) throw new Error('navigation-bar.ts 没有调用 Component()')
  return captured as unknown as ComponentDefinition
}

/** 造一个最小组件实例 —— 三个出口只用到 `triggerEvent`（attached 不用驱动）。 */
function makeInstance(): { triggerEvent: ReturnType<typeof vi.fn> } {
  return { triggerEvent: vi.fn() }
}

/** 剥掉注释后的源码 —— 结构断言读它。 */
function stripped(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('#59 navigation-bar · 入参收敛为语义白名单', () => {
  it('⚠️ 属性恰好是 title / back / homeButton / ordersButton —— 颜色与背景入参删除', async () => {
    const { properties } = await loadComponentDefinition()
    expect(Object.keys(properties).sort()).toEqual(['back', 'homeButton', 'ordersButton', 'title'])
    for (const removed of ['color', 'background', 'extClass', 'loading', 'show', 'animated', 'delta']) {
      expect(properties, `旧 weui 透传 ${removed} 应删除`).not.toHaveProperty(removed)
    }
  })

  it('⚠️ 模板只把 title 交给 van-nav-bar，没有颜色 / 背景绑定', () => {
    const wxml = stripped(join(navBarDir, 'navigation-bar.wxml'))
    expect(wxml).toContain('<van-nav-bar')
    expect(wxml).toContain('title="{{ title }}"')
    for (const legacy of ['{{ color }}', '{{ background }}', '{{ extClass }}', '{{ loading }}', '{{ show }}']) {
      expect(wxml, `模板仍在透传 ${legacy}`).not.toContain(legacy)
    }
  })

  it('⚠️ 页面里的 <navigation-bar> 只使用白名单属性 —— 防止旧用法漏改', () => {
    const allowed = new Set(['title', 'back', 'homeButton', 'ordersButton'])
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.wxml')) {
          const source = stripped(full)
          for (const match of source.matchAll(/<navigation-bar\b([\s\S]*?)\/?>/g)) {
            const attrText = match[1] ?? ''
            for (const attr of attrText.matchAll(/([:\w-]+)\s*=/g)) {
              const name = attr[1] ?? ''
              if (!allowed.has(name)) offenders.push(`${full} → ${name}`)
            }
          }
        }
      }
    }
    walk(pagesDir)
    expect(offenders, `页面导航栏出现了白名单之外的属性：\n${offenders.join('\n')}`).toEqual([])
  })
})

describe('#59 navigation-bar · 三个出口各做一件事', () => {
  it('⚠️ home() 只回首页：switchTab 到 HOME_PATH 常量', async () => {
    const wxStub = installWxStub()
    wxStub.switchTab.mockImplementation(reply({ errMsg: 'switchTab:ok' }))

    const { methods } = await loadComponentDefinition()
    const instance = makeInstance()
    methods.home?.call(instance)

    expect(wxStub.switchTab).toHaveBeenCalledTimes(1)
    expect((wxStub.switchTab.mock.calls[0]?.[0] as { url: string }).url).toBe(`/${HOME_PATH}`)
    expect(instance.triggerEvent).toHaveBeenCalledWith('home', {}, {})
  })

  it('⚠️ orders() 只回订单列表：switchTab 到 ORDER_LIST_PATH 常量', async () => {
    const wxStub = installWxStub()
    wxStub.switchTab.mockImplementation(reply({ errMsg: 'switchTab:ok' }))

    const { methods } = await loadComponentDefinition()
    const instance = makeInstance()
    methods.orders?.call(instance)

    expect(wxStub.switchTab).toHaveBeenCalledTimes(1)
    expect((wxStub.switchTab.mock.calls[0]?.[0] as { url: string }).url).toBe(`/${ORDER_LIST_PATH}`)
    expect(instance.triggerEvent).toHaveBeenCalledWith('orders', {}, {})
  })

  it('⚠️ back() 只返回：navigateBack + back 事件（事件是可选的，不是跳转的前提）', async () => {
    const wxStub = installWxStub()
    wxStub.navigateBack.mockImplementation((options) => {
      reply({ errMsg: 'navigateBack:ok' })(options ?? {})
    })

    const { methods } = await loadComponentDefinition()
    const instance = makeInstance()
    methods.back?.call(instance)

    expect(wxStub.navigateBack).toHaveBeenCalledTimes(1)
    expect(instance.triggerEvent).toHaveBeenCalledWith('back', {}, {})
  })

  it('⚠️ 每个方法只调自己那个跳转 API —— 不互相串线，也不写路径字面量', () => {
    const source = stripped(join(navBarDir, 'navigation-bar.ts'))
    const bodyOf = (name: string): string => {
      const match = new RegExp(`${name}\\(\\)\\s*\\{[\\s\\S]*?\\n {4}\\}`).exec(source)
      return match?.[0] ?? ''
    }
    const homeBody = bodyOf('home')
    const ordersBody = bodyOf('orders')
    const backBody = bodyOf('back')
    expect(homeBody, '没找到 home() 实现体').not.toBe('')
    expect(ordersBody, '没找到 orders() 实现体').not.toBe('')
    expect(backBody, '没找到 back() 实现体').not.toBe('')

    expect(homeBody).toContain('wx.switchTab')
    expect(homeBody).not.toMatch(/wx\.(navigateTo|redirectTo|reLaunch|navigateBack)/)
    expect(ordersBody).toContain('wx.switchTab')
    expect(ordersBody).not.toMatch(/wx\.(navigateTo|redirectTo|reLaunch|navigateBack)/)
    expect(backBody).toContain('wx.navigateBack')
    expect(backBody).not.toMatch(/wx\.(switchTab|navigateTo|redirectTo|reLaunch)/)

    // 目标来自常量：组件里不得出现 `/pages/...` 字面量。
    expect(source).not.toMatch(/['"`]\/?pages\//)
    expect(source).toContain('HOME_PATH')
    expect(source).toContain('ORDER_LIST_PATH')
    expect(source).toMatch(/url:\s*`\/\$\{HOME_PATH\}`/)
    expect(source).toMatch(/url:\s*`\/\$\{ORDER_LIST_PATH\}`/)
  })

  it('⚠️ 事件名与模板绑定一一对应（改实现时别把模板那一半弄丢）', () => {
    const wxml = stripped(join(navBarDir, 'navigation-bar.wxml'))
    expect(wxml).toContain('bindtap="back"')
    expect(wxml).toContain('bindtap="home"')
    expect(wxml).toContain('bindtap="orders"')
    for (const cls of ['app-navbar__back', 'app-navbar__home', 'app-navbar__orders']) {
      expect(wxml, `缺少 ${cls} 的渲染入口`).toContain(cls)
    }
  })
})

describe('#59 navigation-bar · Vant 实现与样式约束', () => {
  it('⚠️ 内部改用 van-nav-bar（页面级声明，不全局注册）', () => {
    const json = JSON.parse(readFileSync(join(navBarDir, 'navigation-bar.json'), 'utf8')) as {
      component: boolean
      styleIsolation?: string
      usingComponents?: Record<string, string>
    }
    expect(json.component).toBe(true)
    expect(json.styleIsolation).toBe('apply-shared')
    expect(json.usingComponents?.['van-nav-bar']).toBe('@vant/weapp/nav-bar/index')
  })

  it('⚠️ 样式用 BEM app-navbar__*，不再出现 weui 残留', () => {
    const scss = stripped(join(navBarDir, 'navigation-bar.scss'))
    expect(scss).toContain('.app-navbar')
    expect(scss).toMatch(/\.app-navbar__back\b/)
    expect(scss).toContain('.app-navbar__orders')
    expect(scss, 'weui 骨架残留').not.toContain('weui-navigation-bar')
  })

  it('⚠️ 不写裸 hex；不新增 transition / animation / keyframes', () => {
    const scss = stripped(join(navBarDir, 'navigation-bar.scss'))
    const hexes = scss.match(/#[0-9a-f]{3,8}\b/gi) ?? []
    expect(hexes, `出现了裸 hex：${hexes.join(', ')}`).toEqual([])
    expect(scss).not.toMatch(/\btransition(?:-[\w-]+)?\s*:/)
    expect(scss).not.toMatch(/\banimation(?:-[\w-]+)?\s*:/)
    expect(scss).not.toMatch(/@(?:-\w+-)?keyframes/)
  })

  it('⚠️ 导航栏用 token 写死颜色 —— 不再接受页面传色', () => {
    const scss = stripped(join(navBarDir, 'navigation-bar.scss'))
    expect(scss).toContain('$color-bg-card')
    expect(scss).toContain('$color-text-main')
    expect(scss).toContain('$color-bg-page')
  })
})

describe('#59 navigation-bar · 胶囊避让几何', () => {
  function makeAttachableInstance(definition: ComponentDefinition): {
    data: Record<string, unknown>
    setData: (patch: Record<string, unknown>) => void
    triggerEvent: ReturnType<typeof vi.fn>
  } {
    const instance = {
      data: { ...(definition.data as Record<string, unknown>) },
      setData(patch: Record<string, unknown>) {
        Object.assign(instance.data, patch)
      },
      triggerEvent: vi.fn(),
    }
    return instance
  }

  it('⚠️ attached 用胶囊实测位置预留右侧宽度（px，与 Vant 同一坐标系）', async () => {
    const wxStub = installWxStub()
    wxStub.getSystemInfoSync.mockReturnValue({ windowWidth: 375, statusBarHeight: 20, platform: 'ios' })
    wxStub.getMenuButtonBoundingClientRect.mockReturnValue({
      left: 278,
      right: 365,
      top: 24,
      bottom: 56,
      width: 87,
      height: 32,
    })

    const definition = await loadComponentDefinition()
    const instance = makeAttachableInstance(definition)
    definition.lifetimes?.attached?.call(instance)

    // 375 - 278 - 16 = 81：右槽自身已经让出 16px，别再多留一格。
    expect(instance.data.capsuleSafeWidth).toBe(81)
  })

  it('⚠️ 胶囊留白只在有右槽时收窄容器 —— 其余页面标题才在屏幕中线', () => {
    const wxml = stripped(join(navBarDir, 'navigation-bar.wxml'))
    const inner = /<view[^>]*class="app-navbar__inner"([^>]*)>/.exec(wxml)?.[1] ?? ''
    const right = /<view slot="right" class="app-navbar__right"([^>]*)>/.exec(wxml)?.[1] ?? ''

    // van-nav-bar 的标题在内容宽度里 margin:0 auto；容器一旦 padding-right，
    // 标题就整体左移半个胶囊宽（375 屏实测 ~48px）。只有柜机页右侧有「我的订单」，
    // 那一页必须收窄让位；其余页面保持全宽，标题才居中。
    expect(inner).toContain('ordersButton ?')
    expect(inner).toContain('padding-right')
    expect(inner).toContain('capsuleSafeWidth')
    expect(right).not.toContain('padding-right')
  })

  it('⚠️ 量不到胶囊时回退 0 —— 几何失败不该让整页白屏', async () => {
    const wxStub = installWxStub()
    wxStub.getMenuButtonBoundingClientRect.mockImplementation(() => {
      throw new Error('getMenuButtonBoundingClientRect is not supported')
    })

    const definition = await loadComponentDefinition()
    const instance = makeAttachableInstance(definition)
    definition.lifetimes?.attached?.call(instance)

    expect(instance.data.capsuleSafeWidth).toBe(0)
  })
})

describe('#59 两个跳转目标都是真实 tabBar 页', () => {
  const appJson = JSON.parse(
    readFileSync(join(repoRoot, 'miniprogram', 'app.json'), 'utf8'),
  ) as { pages: string[]; tabBar: { list: { pagePath: string }[] } }

  it('⚠️ HOME_PATH 与 ORDER_LIST_PATH 都在 tabBar 与 pages 注册表里', () => {
    const tabPaths = appJson.tabBar.list.map((item) => item.pagePath)
    for (const [label, path] of [
      ['HOME_PATH', HOME_PATH],
      ['ORDER_LIST_PATH', ORDER_LIST_PATH],
    ] as const) {
      expect(tabPaths, `${label} 不是 tabBar 项`).toContain(path)
      expect(appJson.pages, `${label} 不在 pages 注册表里`).toContain(path)
    }
  })
})
