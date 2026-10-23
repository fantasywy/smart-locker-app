// **语义图标** —— Lucide 在构建期栅格化/编码，运行时只做一次 map lookup。
//
// ## 三条裁决（#60，spec §11/§12）
//
// 1. ⚠️ **只接受语义 key / 色调 / 尺寸**。没有 `color`、没有 `class` 透传、
//    没有 `src` —— 页面不能拿它当任意图片组件用。图标名是语义 key（如
//    `action.scan`），不是 Lucide 的 glyph 名；换图标库只改构建脚本与 manifest。
//
// 2. ⚠️ **颜色在构建期写进 data URI**。`<image>` 里的 SVG 不继承 `currentColor`
//    （实测会回退成黑色），所以 `primary` / `sub` / `weak` / `danger` / `white`
//    五档各自对应一份预着色的 SVG；运行时**不读文字颜色**、不拼 SVG 字符串。
//
// 3. ⚠️ **未知 key / 未知 tone 不渲染、不抛错**。生成物是只读表，页面传错名字时
//    正确的失败方式是「这一格没有图标」，而不是整页崩掉或偷偷显示一个默认图标。
//    空 src 由 wxml 的 `wx:if` 挡掉，连 `<image>` 都不会创建。

import { ICON_DATA } from './icons.generated'
import type { IconTone } from './icons.generated'

const DEFAULT_TONE: IconTone = 'sub'
const DEFAULT_SIZE = 24

/**
 * 语义 key + 色调 → 预着色 data URI。
 *
 * ⚠️ **色调白名单不在这里**：`ICON_DATA` 的第二层键就是生成期写死的五档
 * （`ICON_TONES`，与 manifest 一一对应）。早先这里另存了一份
 * `TONES = ['primary', 'sub', ...]` 做 `includes` 校验 —— 那是**第二份真相**：
 * 往 manifest 加一档 tone 时，生成物有了、这份手写数组没有，于是新档位静默不渲染。
 * 现在只做一次查表：未知 tone 取到 `undefined`，回落成空串（裁决 3：不渲染、不抛错）。
 */
function resolveSrc(name: unknown, tone: unknown): string {
  if (typeof name !== 'string' || typeof tone !== 'string') return ''
  const table = ICON_DATA as unknown as Record<string, Record<string, string>>
  return table[name]?.[tone] ?? ''
}

function resolveSize(size: unknown): number {
  const numeric = typeof size === 'number' ? size : Number(size)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : DEFAULT_SIZE
}

Component({
  properties: {
    /** 语义 key（`icons.generated.ts` 的键）。 */
    name: {
      type: String,
      value: '',
    },
    /** 五档色调之一；`white` 只压在深色底上。 */
    tone: {
      type: String,
      value: DEFAULT_TONE,
    },
    /** 图标的 CSS 尺寸（px）。常用 16 / 20 / 24 / 28 / 32 / 44 / 48。 */
    size: {
      type: Number,
      value: DEFAULT_SIZE,
    },
  },

  data: {
    src: '',
    sizePx: DEFAULT_SIZE,
  },

  observers: {
    'name, tone'(name: string, tone: string) {
      this.setData({ src: resolveSrc(name, tone) })
    },
    size(size: number) {
      this.setData({ sizePx: resolveSize(size) })
    },
  },

  lifetimes: {
    attached() {
      this.setData({
        src: resolveSrc(this.data.name, this.data.tone),
        sizePx: resolveSize(this.data.size),
      })
    },
  },
})

export type { IconTone }
