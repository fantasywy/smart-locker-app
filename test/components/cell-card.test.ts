// **四档格口卡**的契约 —— #62 按 spec §3 / §11 新增。
//
// 本文件守两件事：
//   1. **对外契约**：五个入参（type / label / available / state / selected）与一个
//      `select` 事件；卡只负责画「这一档现在能不能存」，不替页面做选择。
//   2. **视觉契约里的可判定部分**：档位 → `package` 图标尺寸 20 / 24 / 28 / 32；
//      选中态是 1.5px `$color-primary-active` 描边 + `cell.selected`，未选中是空心圆；
//      卡内只有档名与余位，**不写尺寸、不写示例物品**。
//
// ⚠️ 这里不测 Vant / 小程序渲染，只驱动 `Component()` 定义与源码结构 ——
// 与 `icon.test.ts` / `empty-state.test.ts` 同一条行为 seam。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { LOCKER_PAGE_COPY } from '../../miniprogram/startup/copy'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const cellCardDir = join(repoRoot, 'miniprogram', 'components', 'cell-card')

interface ComponentDefinition {
  properties: Record<string, { type?: unknown; value?: unknown }>
  data: Record<string, unknown>
  observers?: Record<string, (...args: unknown[]) => void>
  methods: Record<string, (...args: unknown[]) => unknown>
}

async function loadComponentDefinition(): Promise<ComponentDefinition> {
  let captured: Record<string, unknown> | null = null
  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (definition: Record<string, unknown>) => {
    captured = definition
  }
  vi.resetModules()
  await import('../../miniprogram/components/cell-card/cell-card')
  delete host.Component
  if (captured === null) throw new Error('cell-card.ts 没有调用 Component()')
  return captured as unknown as ComponentDefinition
}

function stripped(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function makeInstance(data: Record<string, unknown>): {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  triggerEvent: ReturnType<typeof vi.fn>
} {
  const instance = {
    data: { ...data },
    setData(patch: Record<string, unknown>): void {
      Object.assign(instance.data, patch)
    },
    triggerEvent: vi.fn(),
  }
  return instance
}

describe('#62 cell-card · 对外契约', () => {
  it('⚠️ 入参恰好是 type / label / available / state / selected，事件只有 select', async () => {
    const { properties, methods } = await loadComponentDefinition()
    expect(Object.keys(properties).sort()).toEqual([
      'available',
      'label',
      'selected',
      'state',
      'type',
    ])
    expect(Object.keys(methods)).toEqual(['onTap'])
  })

  it('⚠️ 档位决定 package 图标的尺寸 —— 20 / 24 / 28 / 32px 逐档放大', async () => {
    const { observers, data } = await loadComponentDefinition()
    const instance = makeInstance(data)
    const observer = observers?.['type']
    expect(observer, '缺少 type 观察者 —— 图标尺寸不会随档位变化').toBeDefined()

    for (const [type, size] of [
      [1, 20],
      [2, 24],
      [3, 28],
      [4, 32],
    ] as const) {
      observer?.call(instance, type)
      expect(instance.data.iconSize, `第 ${type} 档的 package 图标尺寸不对`).toBe(size)
    }
  })

  it('⚠️ 卡内文字只表达「这一档现在能不能存」—— 余 N 个 / 已满 / 不可用', async () => {
    const { observers, data } = await loadComponentDefinition()
    const instance = makeInstance(data)
    const observer = observers?.['available, state']
    expect(observer, '缺少 available/state 观察者 —— 售罄与离线文案不会出现').toBeDefined()

    observer?.call(instance, 3, 'normal')
    expect(instance.data.availabilityText).toBe(
      LOCKER_PAGE_COPY.remaining.replace('{count}', '3'),
    )

    observer?.call(instance, 0, 'soldout')
    expect(instance.data.availabilityText).toBe(LOCKER_PAGE_COPY.soldOut)

    observer?.call(instance, 0, 'offline')
    expect(instance.data.availabilityText).toBe(LOCKER_PAGE_COPY.unavailable)
  })

  it('⚠️ 只有 normal 档能被点 —— 售罄 / 离线卡点了不发 select', async () => {
    const { methods, data } = await loadComponentDefinition()

    const normal = makeInstance({ ...data, type: 2, state: 'normal' })
    methods.onTap?.call(normal)
    expect(normal.triggerEvent).toHaveBeenCalledWith('select', { type: 2 })

    for (const state of ['soldout', 'offline'] as const) {
      const disabled = makeInstance({ ...data, type: 2, state })
      methods.onTap?.call(disabled)
      expect(disabled.triggerEvent, `${state} 卡不该响应点击`).not.toHaveBeenCalled()
    }
  })
})

describe('#62 cell-card · 视觉与文案纪律', () => {
  it('⚠️ 选中态用 cell.selected，未选中是空心圆；图标只登记一个 package', () => {
    const wxml = stripped(join(cellCardDir, 'cell-card.wxml'))
    expect(wxml).toContain('name="cell.package"')
    expect(wxml).toContain('name="cell.selected"')
    expect(wxml).toContain('cell-card__circle')
    expect(wxml).not.toMatch(/[\u4e00-\u9fa5]/)
  })

  it('⚠️ 不写尺寸、不写示例物品 —— 卡内只有档名与余位', () => {
    const wxml = stripped(join(cellCardDir, 'cell-card.wxml'))
    const copySource = JSON.stringify(LOCKER_PAGE_COPY)
    for (const banned of ['cm', '尺寸', '手机', '行李箱', '背包', '包裹']) {
      expect(wxml, `格口卡里出现了「${banned}」—— 不写尺寸、不写示例物品`).not.toContain(banned)
    }
    // 卡片的可见文本只来自 label / availabilityText 两个插值。
    expect(wxml).toContain('{{ label }}')
    expect(wxml).toContain('{{ availabilityText }}')
    expect(copySource).not.toContain('尺寸')
  })

  it('⚠️ 选中描边 1.5px $color-primary-active；零裸 hex、无 transition / animation', () => {
    const scss = stripped(join(cellCardDir, 'cell-card.scss'))
    expect(scss).toMatch(/border:\s*1\.5px solid v\.\$color-primary-active/)
    const hexes = scss.match(/#[0-9a-f]{3,8}\b/gi) ?? []
    expect(hexes, `出现了裸 hex：${hexes.join(', ')}`).toEqual([])
    expect(scss).not.toMatch(/\btransition(?:-[\w-]+)?\s*:/)
    expect(scss).not.toMatch(/\banimation(?:-[\w-]+)?\s*:/)
    expect(scss).not.toMatch(/@(?:-\w+-)?keyframes/)
    // 按下反馈用 hover-class，不用 :active。
    expect(scss).not.toContain(':active')
  })

  it('⚠️ 组件根节点显式设主文字色，且样式用 BEM cell-card__*', () => {
    const scss = stripped(join(cellCardDir, 'cell-card.scss'))
    const rootBlock = /\.cell-card\s*\{([^}]*)\}/s.exec(scss)?.[1] ?? ''
    expect(rootBlock).toMatch(/color:\s*v\.\$color-text-main/)
    expect(scss).toContain('.cell-card__label')
    expect(scss).toContain('.cell-card__availability')
  })
})
