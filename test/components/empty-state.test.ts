// **空态**的契约与内部实现边界 —— #59 按 spec §11 换 Vant 承载。
//
// 对外契约**不变**（标题 / 说明 / 行动文案 + 无载荷事件），所以这里继续守三件事：
//   1. 三个空态的槽位相同、文案逐字（数据层）；
//   2. 组件不持有文案、不自己跳转、`title` 必填（行为层）；
//   3. 内部改用 `van-empty` + `van-button`，`image=""` 关掉远端默认图，
//      描述色仍是 `$color-text-sub`（视觉层）。
//
// ⚠️ 不再断言 `.empty-state__action` 的 `height: 88rpx` 之类的自绘按钮细节 ——
// 按钮已经交给 `van-button`，再断言那些等于在测一个不存在的实现。改为断言
// 「用了 Vant + 主题 token」这条新的外部事实。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_STATES } from '../../miniprogram/startup/copy'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const emptyStateDir = join(repoRoot, 'miniprogram', 'components', 'empty-state')

/** 剥掉注释后的源码 —— 结构断言读它（注释里出现关键词是必要的说明，不算违规）。 */
function stripped(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

interface ComponentDefinition {
  properties: Record<string, { type?: unknown; value?: unknown }>
  data?: Record<string, unknown>
  methods: Record<string, (...args: unknown[]) => unknown>
}

async function loadComponentDefinition(): Promise<ComponentDefinition> {
  let captured: Record<string, unknown> | null = null
  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (definition: Record<string, unknown>) => {
    captured = definition
  }
  vi.resetModules()
  await import('../../miniprogram/components/empty-state/empty-state')
  delete host.Component
  if (captured === null) throw new Error('empty-state.ts 没有调用 Component()')
  return captured as unknown as ComponentDefinition
}

describe('#23 空态：三处共用一条结构（契约不变）', () => {
  it('⚠️ 三个空态的**槽位相同** —— 只有取值不同，没有一处需要别的排布', () => {
    const keys = Object.values(EMPTY_STATES).map((state) => Object.keys(state).sort())
    expect(keys[0]).toEqual(['actionLabel', 'hint', 'title'])
    expect(keys[1]).toEqual(keys[0])
    expect(keys[2]).toEqual(keys[0])
  })

  it('⚠️ 三个空态的文案逐字一致', () => {
    expect(EMPTY_STATES.orders.title).toBe('还没有订单')
    expect(EMPTY_STATES.orders.hint).toBe('扫码存件，把东西放进柜子')
    expect(EMPTY_STATES.orders.actionLabel).toBe('扫码存件')

    expect(EMPTY_STATES.reservations.title).toBe('还没有预约')
    expect(EMPTY_STATES.reservations.hint).toBe('到柜机前扫码后可以预约使用时段')
    expect(EMPTY_STATES.reservations.actionLabel).toBe('扫码存件')

    expect(EMPTY_STATES.scoreLogs.title).toBe('还没有分数变动')
  })

  it('⚠️ 信用分明细的空态**只有标题** —— 别为了凑齐两行编一句话', () => {
    expect(EMPTY_STATES.scoreLogs.hint).toBe('')
    expect(EMPTY_STATES.scoreLogs.actionLabel).toBe('')
  })

  it('⚠️ 两个主行动是**同一个动作**（订单与预约都走扫码）', () => {
    expect(EMPTY_STATES.reservations.actionLabel).toBe(EMPTY_STATES.orders.actionLabel)
    expect(EMPTY_STATES.reservations.actionLabel).not.toContain('新建')
    expect(EMPTY_STATES.reservations.actionLabel).not.toContain('预约')
  })
})

describe('#59 空态组件：对外契约不变', () => {
  it('⚠️ 属性恰好是 title / hint / actionLabel，且 title 必填（没有默认值）', async () => {
    const { properties } = await loadComponentDefinition()
    expect(Object.keys(properties).sort()).toEqual(['actionLabel', 'hint', 'title'])
    expect(properties.title?.value, 'title 不该有默认值').toBeUndefined()
    expect(properties.hint?.value).toBe('')
    expect(properties.actionLabel?.value).toBe('')
  })

  it('⚠️ 主行动只发 `action` 事件，**不带载荷** —— 跳转归页面', async () => {
    const { methods } = await loadComponentDefinition()
    const instance = { triggerEvent: vi.fn() }
    methods.onAction?.call(instance)
    expect(instance.triggerEvent).toHaveBeenCalledTimes(1)
    expect(instance.triggerEvent).toHaveBeenCalledWith('action')
  })

  it('⚠️ 组件**不自己跳转**，也不碰 wx', () => {
    const ts = stripped(join(emptyStateDir, 'empty-state.ts'))
    for (const banned of ['wx.scanCode', 'wx.navigateTo', 'wx.switchTab', 'wx.redirectTo']) {
      expect(ts, `空态组件里出现了 ${banned} —— 跳转归页面`).not.toContain(banned)
    }
    expect(ts).toContain('triggerEvent')
  })

  it('⚠️ 组件里没有任何文案字面量 —— 用户可见的每个字归文案层', () => {
    const wxml = stripped(join(emptyStateDir, 'empty-state.wxml'))
    const chinese = wxml.match(/[\u4e00-\u9fa5]+/g) ?? []
    expect(chinese, `wxml 里出现了写死的中文：${chinese.join('、')}`).toEqual([])
  })
})

describe('#59 空态内部改由 Vant 承载（视觉约束）', () => {
  it('⚠️ `van-empty` + `van-button`，且 `image=""` 关闭远端默认图', () => {
    const wxml = stripped(join(emptyStateDir, 'empty-state.wxml'))
    expect(wxml).toContain('<van-empty')
    expect(wxml).toContain('image=""')
    expect(wxml).toContain('<van-button')
    expect(wxml).toContain('bind:click="onAction"')
    // 文案仍然只来自调用方。
    expect(wxml).toContain('{{ title }}')
    expect(wxml).toContain('{{ hint }}')
    expect(wxml).toContain('{{ actionLabel }}')
  })

  it('⚠️ 组件 json 声明 Vant 组件（页面级 / 组件级，不全局注册）', () => {
    const json = JSON.parse(readFileSync(join(emptyStateDir, 'empty-state.json'), 'utf8')) as {
      component: boolean
      styleIsolation?: string
      usingComponents?: Record<string, string>
    }
    expect(json.component).toBe(true)
    expect(json.styleIsolation).toBe('apply-shared')
    expect(json.usingComponents?.['van-empty']).toBe('@vant/weapp/empty/index')
    expect(json.usingComponents?.['van-button']).toBe('@vant/weapp/button/index')
  })

  it('⚠️ 描述文字仍用 `$color-text-sub`，标题用 `$color-text-main`', () => {
    const scss = stripped(join(emptyStateDir, 'empty-state.scss'))
    expect(scss).toContain('$color-text-sub')
    expect(scss).toContain('$color-text-main')
  })

  it('⚠️ 不写裸 hex；不新增 transition / animation / keyframes', () => {
    const scss = stripped(join(emptyStateDir, 'empty-state.scss'))
    const hexes = scss.match(/#[0-9a-f]{3,8}\b/gi) ?? []
    expect(hexes, `出现了裸 hex：${hexes.join(', ')} —— 一律引 styles/ 的 token`).toEqual([])
    expect(scss).not.toMatch(/\btransition(?:-[\w-]+)?\s*:/)
    expect(scss).not.toMatch(/\banimation(?:-[\w-]+)?\s*:/)
    expect(scss).not.toMatch(/@(?:-\w+-)?keyframes/)
  })

  it('⚠️ 布局几何用 rpx（组件自身的 padding / margin / 尺寸不写裸 px）', () => {
    const scss = stripped(join(emptyStateDir, 'empty-state.scss'))
    const offenders: string[] = []
    for (const line of scss.split('\n')) {
      if (!/^\s*(padding|margin|height|width|line-height|top|left|right|bottom)[\w-]*\s*:/.test(line)) {
        continue
      }
      if (/\b\d+(\.\d+)?px\b/.test(line)) offenders.push(line.trim())
    }
    expect(offenders, `以下布局几何写了 px：\n${offenders.join('\n')}`).toEqual([])
  })
})
