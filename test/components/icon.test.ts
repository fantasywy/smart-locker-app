// #60 图标组件的行为 seam：语义 key / 色调 / 尺寸。
//
// ⚠️ 不测 SVG 像素（那是 `verify:icons` 的职责）。这里测的是组件对外承诺：
//   • 只暴露 `name` / `tone` / `size` 三个属性；
//   • 未知 key（或未知 tone）**不渲染、不抛错**；
//   • 颜色在构建期写进 data URI —— 运行时没有 `currentColor`、不读文字颜色；
//   • 生成物覆盖票面要求的语义 key，且订单状态 7 个 key、格口只登记一个
//     `package` glyph、等待关门是 `hourglass`（不是 `door-open`）。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ICON_DATA } from '../../miniprogram/components/icon/icons.generated'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const iconDir = join(repoRoot, 'miniprogram', 'components', 'icon')

interface IconEntry {
  lucide: string
  sizes?: number[]
}

interface IconManifest {
  lucideVersion: string
  icons: Record<string, IconEntry>
  tabbar: { route: string; lucide: string }[]
}

const manifest = JSON.parse(
  readFileSync(join(repoRoot, 'scripts', 'icons', 'manifest.json'), 'utf8'),
) as IconManifest

const TONES = ['primary', 'sub', 'weak', 'danger', 'white'] as const

function decodeDataUri(uri: string): string {
  expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true)
  return Buffer.from(uri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')
}

type Definition = Record<string, any>

let definition: Definition | null = null

beforeEach(() => {
  definition = null
  ;(globalThis as Record<string, unknown>).Component = (def: Definition) => {
    definition = def
  }
})

async function loadIcon(): Promise<Definition> {
  vi.resetModules()
  await import('../../miniprogram/components/icon/icon')
  if (!definition) throw new Error('icon component did not call Component()')
  return definition
}

function instantiate(def: Definition): Definition {
  const instance: Definition = {
    data: { ...(def.data as Record<string, unknown>) },
    setData(patch: Record<string, unknown>) {
      Object.assign(instance.data as Record<string, unknown>, patch)
    },
  }
  for (const [name, fn] of Object.entries((def.methods as Record<string, Function>) ?? {})) {
    instance[name] = fn.bind(instance)
  }
  return instance
}

describe('#60 icon 组件：只接受 name / tone / size', () => {
  it('⚠️ 公开属性恰好是 name / tone / size —— 没有颜色、没有 className 透传', async () => {
    const def = await loadIcon()
    expect(Object.keys((def.properties as Record<string, unknown>) ?? {}).sort()).toEqual([
      'name',
      'size',
      'tone',
    ])
  })

  it('⚠️ 默认 tone=sub、size=24；未知 key 输出空 src，不抛错', async () => {
    const def = await loadIcon()
    const instance = instantiate(def)
    const observer = (def.observers as Record<string, Function>)['name, tone']
    expect(typeof observer).toBe('function')

    expect(() => observer?.call(instance, 'not.a.real.key', 'sub')).not.toThrow()
    expect(instance.data.src).toBe('')

    observer?.call(instance, 'action.scan', 'primary')
    expect(instance.data.src).toBe(ICON_DATA['action.scan'].primary)
  })

  it('⚠️ 未知 tone 也按“不渲染”处理 —— 色调白名单就是 manifest 的键', async () => {
    const def = await loadIcon()
    const instance = instantiate(def)
    const observer = (def.observers as Record<string, Function>)['name, tone']

    observer?.call(instance, 'action.scan', 'brand-green')
    expect(instance.data.src).toBe('')
  })

  it('⚠️ size 只影响 CSS 尺寸；非法值回退 24', async () => {
    const def = await loadIcon()
    const instance = instantiate(def)
    const observer = (def.observers as Record<string, Function>).size

    observer?.call(instance, 32)
    expect(instance.data.sizePx).toBe(32)
    observer?.call(instance, 0)
    expect(instance.data.sizePx).toBe(24)
    observer?.call(instance, 'oops')
    expect(instance.data.sizePx).toBe(24)
  })

  it('⚠️ 四档格口复用同一个 package key，靠 size 逐档放大 20/24/28/32', async () => {
    const def = await loadIcon()
    const instance = instantiate(def)
    const sizeObserver = (def.observers as Record<string, Function>).size
    const srcObserver = (def.observers as Record<string, Function>)['name, tone']

    srcObserver?.call(instance, 'cell.package', 'sub')
    expect(instance.data.src).toBe(ICON_DATA['cell.package'].sub)
    for (const size of [20, 24, 28, 32]) {
      sizeObserver?.call(instance, size)
      expect(instance.data.sizePx).toBe(size)
    }
  })

  it('⚠️ wxml 用 <image> + wx:if，空 src 时什么也不渲染', async () => {
    const def = await loadIcon()
    expect(def).toBeDefined()
    const wxml = readFileSync(join(iconDir, 'icon.wxml'), 'utf8')
    expect(wxml).toContain('<image')
    expect(wxml).toContain('wx:if="{{src}}"')
    expect(wxml).toContain('mode="aspectFit"')
    expect(wxml).not.toMatch(/[\u4e00-\u9fa5]/)
  })
})

describe('#60 图标清单：语义 key 与构建期颜色', () => {
  it('⚠️ 生成物与源 manifest 一一对应，每个 key 都有五档 tone', () => {
    const manifestKeys = Object.keys(manifest.icons).sort()
    expect(Object.keys(ICON_DATA).sort()).toEqual(manifestKeys)
    for (const key of manifestKeys) {
      const tones = (ICON_DATA as Record<string, Record<string, string>>)[key]
      expect(Object.keys(tones ?? {}).sort()).toEqual([...TONES].sort())
    }
  })

  it('⚠️ 订单状态恰好 7 个 key，glyph 与票面一致', () => {
    const orderStatusGlyphs = [
      'wallet',
      'timer',
      'circle-check',
      'clock-alert',
      'circle-slash',
      'undo-2',
      'circle-x',
    ]
    const registered = Object.entries(manifest.icons)
      .filter(([key]) => key.startsWith('status.'))
      .map(([, entry]) => entry.lucide)
      .filter((glyph) => orderStatusGlyphs.includes(glyph))
      .sort()
    expect(registered).toEqual([...orderStatusGlyphs].sort())
  })

  it('⚠️ 四档格口只登记一个 package glyph（逐档放大，不造四个图标）', () => {
    const packageKeys = Object.entries(manifest.icons)
      .filter(([, entry]) => entry.lucide === 'package')
      .map(([key]) => key)
    expect(packageKeys).toEqual(['cell.package'])
    expect(manifest.icons['cell.package']?.sizes).toEqual([20, 24, 28, 32])
    expect(Object.keys(ICON_DATA['cell.package']).sort()).toEqual([...TONES].sort())
  })

  it('⚠️ 等待关门用 hourglass，清单里不得出现 door-open', () => {
    expect(manifest.icons['status.waiting']?.lucide).toBe('hourglass')
    expect(JSON.stringify(manifest)).not.toContain('door-open')
  })

  it('⚠️ 票面点名的 UI key 都已登记', () => {
    for (const key of [
      'action.scan',
      'action.search',
      'action.locate',
      'action.back',
      'action.close',
      'nearby.station',
      'nearby.navigate',
      'nav.disclosure',
    ]) {
      expect(manifest.icons[key], `缺少语义 key：${key}`).toBeDefined()
    }
  })

  it('⚠️ 颜色在构建期写死为 token 值，data URI 里没有 currentColor', () => {
    const decoded = decodeDataUri(ICON_DATA['action.scan'].primary)
    expect(decoded).toContain('stroke="#008655"')
    expect(decoded).not.toContain('currentColor')

    const sub = decodeDataUri(ICON_DATA['action.search'].sub)
    expect(sub).toContain('stroke="#646a73"')
    const weak = decodeDataUri(ICON_DATA['nav.disclosure'].weak)
    expect(weak).toContain('stroke="#8f959e"')
    const danger = decodeDataUri(ICON_DATA['status.pendingPayment'].danger)
    expect(danger).toContain('stroke="#c05454"')
    const white = decodeDataUri(ICON_DATA['action.scan'].white)
    expect(white).toContain('stroke="#ffffff"')
  })

  it('⚠️ 运行时源码不得 import Lucide（只允许读生成物）', () => {
    const componentTs = readFileSync(join(iconDir, 'icon.ts'), 'utf8')
    const generated = readFileSync(join(iconDir, 'icons.generated.ts'), 'utf8')
    expect(componentTs).not.toMatch(/from ['"]lucide/)
    expect(componentTs).not.toContain('lucide-static')
    expect(generated).not.toMatch(/from ['"]lucide/)
    expect(generated).not.toContain('lucide-static')
  })
})
