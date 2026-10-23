// #60 图标流水线的产物守卫：8 张 tabBar PNG + 只读生成清单 + 第三方声明。
//
// PNG 的像素级校验（IHDR / 颜色 / 内容盒）在 `scripts/verify-icons.mjs` 里还有一份
// 独立实现；这里守的是「产物真的进了 git、且与票面事实一致」，不是构建脚本自证。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decodePng, alphaBBox, opaqueColors } from '../helpers/png'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const miniprogramDir = join(repoRoot, 'miniprogram')
const tabbarDir = join(miniprogramDir, 'assets', 'tabbar')
const iconDir = join(miniprogramDir, 'components', 'icon')

const ROUTES = ['index', 'order-list', 'nearby', 'profile'] as const

function rel(path: string): string {
  return relative(repoRoot, path)
}

function token(name: string): string {
  const scss = readFileSync(join(miniprogramDir, 'styles', '_variables.scss'), 'utf8')
  const match = new RegExp(`^\\s*\\$${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`, 'm').exec(scss)
  if (!match?.[1]) throw new Error(`token ${name} not found`)
  return match[1].toLowerCase()
}

describe('#60 tabBar PNG：8 张、81×81 RGBA、两态颜色来自 token', () => {
  it('⚠️ 四条 route × 常态/选中 = 8 张，文件名固定，且没有多余图片', () => {
    expect(existsSync(tabbarDir), '缺少 miniprogram/assets/tabbar/').toBe(true)
    const files = readdirSync(tabbarDir).sort()
    const expected = ROUTES.flatMap((route) => [`${route}-active.png`, `${route}.png`]).sort()
    expect(files).toEqual(expected)
  })

  it('⚠️ PNG 头是 81×81、8-bit RGBA、非隔行 —— 原生 tabBar 的硬要求', () => {
    for (const route of ROUTES) {
      for (const suffix of ['', '-active']) {
        const file = join(tabbarDir, `${route}${suffix}.png`)
        const png = decodePng(readFileSync(file))
        expect(png.width, `${rel(file)} 宽度`).toBe(81)
        expect(png.height, `${rel(file)} 高度`).toBe(81)
        expect(png.bitDepth).toBe(8)
        expect(png.colorType).toBe(6)
        expect(png.interlace).toBe(0)
      }
    }
  })

  it('⚠️ 内容盒 72：不透明像素的包围盒不超过 72×72，四边留白 ≥4px', () => {
    for (const route of ROUTES) {
      for (const suffix of ['', '-active']) {
        const file = join(tabbarDir, `${route}${suffix}.png`)
        const png = decodePng(readFileSync(file))
        const box = alphaBBox(png)
        expect(box.maxX - box.minX + 1, `${rel(file)} 内容宽`).toBeLessThanOrEqual(72)
        expect(box.maxY - box.minY + 1, `${rel(file)} 内容高`).toBeLessThanOrEqual(72)
        expect(box.minX, `${rel(file)} 左留白`).toBeGreaterThanOrEqual(4)
        expect(box.minY, `${rel(file)} 上留白`).toBeGreaterThanOrEqual(4)
        expect(box.maxX, `${rel(file)} 右留白`).toBeLessThanOrEqual(76)
        expect(box.maxY, `${rel(file)} 下留白`).toBeLessThanOrEqual(76)
      }
    }
  })

  it('⚠️ 常态 = $color-text-weak，选中 = $color-text-main（品牌绿不进 tabBar）', () => {
    const weak = token('color-text-weak')
    const main = token('color-text-main')
    for (const route of ROUTES) {
      const normal = decodePng(readFileSync(join(tabbarDir, `${route}.png`)))
      const active = decodePng(readFileSync(join(tabbarDir, `${route}-active.png`)))
      expect(opaqueColors(normal), `${route}.png 出现了非 token 色`).toEqual([weak])
      expect(opaqueColors(active), `${route}-active.png 出现了非 token 色`).toEqual([main])
    }
  })
})

describe('#60 icons.generated.ts：只读语义清单进 git', () => {
  it('⚠️ 生成物存在、带 AUTO-GENERATED 头、不是手写文件', () => {
    const file = join(iconDir, 'icons.generated.ts')
    expect(existsSync(file)).toBe(true)
    const body = readFileSync(file, 'utf8')
    expect(body).toContain('AUTO-GENERATED')
    expect(body).toContain('pnpm icons:build')
    expect(body).toContain('data:image/svg+xml;base64,')
  })

  it('⚠️ 生成物里没有 currentColor / 裸 glyph 名（运行时只认语义 key）', () => {
    const body = readFileSync(join(iconDir, 'icons.generated.ts'), 'utf8')
    expect(body).not.toContain('currentColor')
    expect(body).not.toContain('door-open')
    expect(body).not.toContain('lucide-static')
  })
})

describe('#60 第三方声明：Lucide ISC + Feather 派生 MIT 逐字保留', () => {
  it('⚠️ THIRD_PARTY_NOTICES.md 完整包含 lucide-static LICENSE 原文', () => {
    const notices = readFileSync(join(repoRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    const license = readFileSync(
      join(repoRoot, 'node_modules', 'lucide-static', 'LICENSE'),
      'utf8',
    ).trim()
    expect(notices).toContain(license)
    expect(notices).toContain('ISC License')
    expect(notices).toContain('The MIT License (MIT) (for the icons listed above)')
    expect(notices).toContain('Copyright (c) 2013-present Cole Bemis')
  })
})
