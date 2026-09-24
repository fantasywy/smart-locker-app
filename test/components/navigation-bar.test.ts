// **自绘导航栏**的 `home()` —— issue #23 的头号交付物：修一个**已核实的死按钮**。
//
// ## 缺陷原样（本票开工时核实）
//
// `navigation-bar.wxml:26` 绑了 `bindtap="home"`，而 `.ts` 的 `methods` 里
// **只有 `_showChange` 与 `back`** —— `home` 根本没实现。`homeButton` 属性一旦使用，
// 渲染出来就是个**点了没反应的死按钮**。
//
// ⚠️ **`wx.*` 桩在这里不是「顺带用一下」，它是本缺陷唯一的可测形态。**
// 死按钮的症状是「点了什么都不发生」—— 那件事**没有任何返回值可断言**。
// 本仓库的桩在这条上帮了大忙：`switchTab` 是「未编排即**抛错**」的（见 test/helpers/wx.ts），
// 所以「点了没反应」与「点了真的调了 switchTab」在测试里是**可区分**的两件事 ——
// 前者会让用例红，而一个静默返回 undefined 的桩会让两者都绿。
//
// 出处：`docs/spec/01-entry-and-identity.md` §2.4:55-59（柜机页出口走 `wx.switchTab`
// 到订单 tab）、`docs/spec/07-engineering-form.md` §5:138（只有自绘导航栏能承载它）。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { installWxStub, reply } from '../helpers/wx'
import { ORDER_LIST_PATH } from '../../miniprogram/startup/copy'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const navBarDir = join(repoRoot, 'miniprogram', 'components', 'navigation-bar')

/**
 * 读组件定义 —— 小程序的 `Component({...})` 是一个**全局注册调用**，不是模块导出。
 *
 * 所以测试用一个最小的 `Component` 桩把它接住：把传进来的那个对象**原样存下来**，
 * 然后直接调它的 `methods.home()`。这是本仓库对「页面/组件的定义对象」的既有测法
 * （`test/startup/page.test.ts` 同法）。
 *
 * ⚠️ 用 `vi.resetModules()` + 动态 import 而不是顶层 import：`Component` 必须在
 * 模块被求值**之前**就挂在全局上。顶层 import 会在 `beforeEach` 之前跑完。
 */
async function loadComponentDefinition(): Promise<{
  methods: Record<string, (...args: unknown[]) => unknown>
  properties: Record<string, unknown>
  data: Record<string, unknown>
}> {
  let captured: Record<string, unknown> | null = null
  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (definition: Record<string, unknown>) => {
    captured = definition
  }

  vi.resetModules()
  await import('../../miniprogram/components/navigation-bar/navigation-bar')

  delete host.Component
  if (captured === null) throw new Error('navigation-bar.ts 没有调用 Component()')
  // TS 的控制流分析看不出 `captured` 在闭包里被赋值了 —— 这里显式收窄。
  const definition = captured as unknown as {
    methods: Record<string, (...args: unknown[]) => unknown>
    properties: Record<string, unknown>
    data: Record<string, unknown>
  }
  return definition
}

/** 造一个最小组件实例 —— `home()` 只用到 `triggerEvent`。 */
function makeInstance(): {
  triggerEvent: ReturnType<typeof vi.fn>
  data: Record<string, unknown>
} {
  return { triggerEvent: vi.fn(), data: { delta: 1 } }
}

describe('#23 navigation-bar · home() 不再是死按钮', () => {
  it('⚠️⚠️ `home` 方法**真的存在** —— 这正是本票要修的那个缺陷', async () => {
    // 缺陷原样：`wxml:26` 绑了 `bindtap="home"`，而 `methods` 里没有它。
    // 这条断言直接对着那个事实 —— 它在本票开工时是**红的**。
    const { methods } = await loadComponentDefinition()
    expect(Object.keys(methods)).toContain('home')
    expect(typeof methods.home).toBe('function')
  })

  it('⚠️ 点击后**真的 `wx.switchTab` 到订单 tab**（01 §2.4:57 逐字）', async () => {
    // `01` §2.4 逐字：「柜机页**顶部固定一个「我的订单」出口**（`wx.switchTab` 到订单 tab）」。
    const wxStub = installWxStub()
    wxStub.switchTab.mockImplementation(reply({ errMsg: 'switchTab:ok' }))

    const { methods } = await loadComponentDefinition()
    methods.home.call(makeInstance())

    expect(wxStub.switchTab).toHaveBeenCalledTimes(1)
    // ⚠️ 路径带前导 `/`（小程序的绝对路径写法），且指向 tabBar 的第一项。
    expect(wxStub.switchTab.mock.calls[0]?.[0]?.url).toBe(`/${ORDER_LIST_PATH}`)
    expect(wxStub.switchTab.mock.calls[0]?.[0]?.url).toBe('/pages/index/index')
  })

  it('⚠️ 必须是 `switchTab`，**不是** `navigateTo` / `redirectTo`', async () => {
    // 订单列表是 tabBar 页（01 §2.3），而 `navigateTo` 对 tabBar 页会**静默失败** ——
    // 照样不跳转、不报错。那就等于没修这个死按钮，只是把「没实现」换成了「调错了 API」。
    //
    // 判据取**源码**而不是行为：一个调错 API 的实现照样能通过上面那条「调了 switchTab」
    // 的反面 —— 这里断言的是「源码里根本没有别的跳转 API」。
    const source = readFileSync(join(navBarDir, 'navigation-bar.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    // ⚠️ 方法体里有一层 `wx.switchTab({ ... })` 的嵌套花括号，所以匹配到**下一个
    // 顶层方法**为止（`\n    }` 是方法体收尾那一行的缩进），而不是第一个 `}`。
    const homeBody = /home\(\)\s*\{[\s\S]*?\n {4}\}/.exec(source)?.[0] ?? ''
    expect(homeBody, '没找到 home() 的实现体').not.toBe('')
    expect(homeBody).toContain('wx.switchTab')
    expect(homeBody).not.toContain('wx.navigateTo')
    expect(homeBody).not.toContain('wx.redirectTo')
    expect(homeBody).not.toContain('wx.reLaunch')
  })

  it('⚠️ 目标路径来自 `ORDER_LIST_PATH`，不是本文件里的字面量', async () => {
    // `wx.switchTab` 的 url 必须是 `app.json` 的 `tabBar.list[].pagePath` 之一 ——
    // 差一个字符就是**静默失败**，与要修的症状一模一样、只是更难查。
    // 而那个路径在 `app.json`（JSON，引不到 TS）与调用点各有一份 ⇒ 字面量散落 = 漂移空间。
    const source = readFileSync(join(navBarDir, 'navigation-bar.ts'), 'utf8')
    // 模板串拼出来的是常量，不是写死的路径。
    expect(source).toContain('ORDER_LIST_PATH')
    expect(source).toMatch(/url:\s*`\/\$\{ORDER_LIST_PATH\}`/)
    // ⚠️ 不得出现写死的页面路径字面量。
    expect(source).not.toMatch(/['"`]\/pages\//)
  })

  it('⚠️ `home()` 也 `triggerEvent`，让页面能接住（与 back() 形态一致）', async () => {
    // 票面：「用 `triggerEvent` 还是直接 `wx.switchTab`，由实现者定，但**必须让页面能接住**
    // （现有 `back` 用的是 `triggerEvent`，保持一致即可）。」
    //
    // 本票的裁决是**两者都做**（见 navigation-bar.ts 裁决 1）：`switchTab` 是缺省行为，
    // 事件是可选的通知口。⚠️ 反过来做（只 triggerEvent、跳转交给页面）的后果是
    // **又一次死按钮** —— 10 个页面里任何一个漏接 `bind:home` 就又点不动了，
    // 而那正是本次要修的缺陷本身。
    const wxStub = installWxStub()
    wxStub.switchTab.mockImplementation(reply({ errMsg: 'switchTab:ok' }))

    const { methods } = await loadComponentDefinition()
    const instance = makeInstance()
    methods.home.call(instance)

    expect(instance.triggerEvent).toHaveBeenCalledWith('home', {}, {})
  })

  it('⚠️ `home` 在 wxml 上的绑定仍在（改实现时别把模板那一半弄丢）', () => {
    // 缺陷的另一半在模板里：`bindtap="home"`。若有人「修」的方式是把模板那行删掉，
    // 按钮就彻底不渲染了 —— 上面那些断言全都测不到那件事。
    const wxml = readFileSync(join(navBarDir, 'navigation-bar.wxml'), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
    expect(wxml).toContain('bindtap="home"')
    // 导出图标那个 wrapper 也还在（按钮本身要能被看见）。
    expect(wxml).toContain('weui-navigation-bar__btn_home_wrapper')
  })
})

describe('#23 navigation-bar · home 按钮**看得见**（真机走查抓出来的第二个缺陷）', () => {
  it('⚠️⚠️ `__btn_home` / `__btn_home_wrapper` **在 scss 里有样式** —— 否则按钮塌成 0×0', () => {
    // ⛔ 这是本票在**微信开发者工具模拟器上实测**才发现的第二个缺陷，而它**没有任何
    // 测试能提前抓到**（本文件上面那 5 条全绿时它依然存在）：
    //
    //   `wxml` 里 home 按钮的 class 是 `weui-navigation-bar__btn_home_wrapper` /
    //   `__btn_home`，而 `navigation-bar.scss` **从来没有定义过这两个 class**。
    //   于是 `homeButton` 打开后：元素渲染出来了（DOM 查得到、`aria-label="首页"` 在）、
    //   `bindtap` 也修好了 —— **但用户在屏上什么都看不见**，因为一个没有任何尺寸
    //   声明的 `view` 塌成 0×0。**点得到、看不见**，与死按钮是同一种用户后果。
    //
    // ⇒ 教训：`methods.home` 存在 + `wx.switchTab` 被调 = **只证明了「点了会跳」**，
    //   完全没证明「用户找得到这个按钮」。这件事只有**真机/模拟器**能验
    //   （`10` §11 已登记过「未实测」类问题，#23 的票面也正是这么要求的）。
    //   这条断言就是把那次走查的结论固化下来，防止后来的重构把它删掉。
    const scss = readFileSync(join(navBarDir, 'navigation-bar.scss'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    )
    expect(scss, '缺少 __btn_home_wrapper 的样式 —— 点击热区塌成 0×0').toMatch(
      /\.weui-navigation-bar__btn_home_wrapper\s*\{/,
    )
    expect(scss, '缺少 __btn_home 的样式 —— 图标画不出来').toMatch(
      /\.weui-navigation-bar__btn_home\s*\{/,
    )
  })

  it('⚠️ home 图标**有实际尺寸**（不是只有颜色声明）', () => {
    // 「有样式」还不够 —— 一个只有 `background-color` 而没有 `width` / `height` 的
    // mask 元素仍然什么都看不见。尺寸是「看得见」的全部。
    const scss = readFileSync(join(navBarDir, 'navigation-bar.scss'), 'utf8')
    const homeBlock = /\.weui-navigation-bar__btn_home\s*\{([^}]*)\}/.exec(scss)?.[1] ?? ''
    expect(homeBlock, '没找到 __btn_home 的规则体').not.toBe('')
    expect(homeBlock, 'home 图标没有宽度 —— 会塌成 0').toMatch(/width:\s*\d+px/)
    expect(homeBlock, 'home 图标没有高度 —— 会塌成 0').toMatch(/height:\s*\d+px/)
    // 图标本身用 mask + 内联 SVG 画（与 goback 同一手法），**不引图片资源**。
    expect(homeBlock).toMatch(/mask:\s*url\("data:image\/svg\+xml/);
  })

  it('⚠️ home 图标**不引任何图片文件**（07 §5:126 的「无本地图片资源」仍是事实）', () => {
    // `07` §5 把「本期没有任何本地图片或图标资源」当作已核实事实，并据此裁决不分包。
    // 补一个图标时最容易的做法就是塞一张 png —— 那句话会**静默变假**。
    // 本文件与 `skeleton.test.ts` 的「miniprogram/ 下无图片文件」互为佐证。
    const scss = readFileSync(join(navBarDir, 'navigation-bar.scss'), 'utf8')
    const homeBlock = /\.weui-navigation-bar__btn_home\s*\{([^}]*)\}/.exec(scss)?.[1] ?? ''
    expect(homeBlock, 'home 图标引了图片文件 —— 应走 mask + 内联 SVG').not.toMatch(
      /url\(["']?[^"')]*\.(png|jpg|jpeg|gif|svg|webp)["']?\)/,
    )
  })
})
