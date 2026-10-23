// **四档格口卡** —— 柜机页 2×2 网格里的一个格子（#62，spec §3 / §11）。
//
// ## 对外契约
//
// | 入参 | 说明 |
// |---|---|
// | `type` | 后端数字码 `1 \| 2 \| 3 \| 4`（1 小 / 2 中 / 3 大 / 4 特大） |
// | `label` | 中文档名（页面从 `LOCKER_PAGE_COPY.cellTypeLabels` 取，组件不自己造词） |
// | `available` | 该档余位（`13.6` 的 `cellAvailability[...]`） |
// | `state` | `normal` / `soldout` / `offline` —— 三种**正常**的呈现，不是错误 |
// | `selected` | 是否被用户选中 |
//
// 事件只有 `select`，载荷 `{ type }`：卡只回答「用户点了哪一档」，
// 选中态由页面持有（页面还要在 `submitting` 时拒绝选择）。
//
// ## 三条裁决
//
// 1. ⚠️ **卡里只有档名与余位，没有尺寸、没有示例物品。** 四档的相对大小只靠
//    `package` 图标逐档放大（20 / 24 / 28 / 32px）表达 —— 写「适合 A4 文件」
//    这类示例就是在替用户判断他的东西能不能放进去，而验证它是否放得下不是 C 端的事。
//
// 2. ⚠️ **售罄 / 离线卡不响应点击。** 页面已经用服务端回显把这一档标成不可用，
//    卡再发一次 `select` 只会让页面多写一条同样的守卫。卡的 `state` 是唯一开关。
//
// 3. **文案只从 `startup/copy.ts` 来。** 「余 N 个」「已满」「不可用」都是用户可见的字，
//    组件不持有第二份字面量；余位模板由 copy 层给，格式化在本组件做（它就是余位的呈现处）。

import { LOCKER_PAGE_COPY } from '../../startup/copy'

/**
 * 数字码 → `package` 图标尺寸（px）。
 *
 * ⚠️ 这是 spec §3 唯一允许的「逐档放大」：四档共用同一个 `cell.package` glyph，
 * 不造四个图标。尺寸只由 `type` 决定，与余位 / 选中态无关。
 */
const PACKAGE_ICON_SIZES: Record<number, number> = { 1: 20, 2: 24, 3: 28, 4: 32 }

function iconSizeOf(type: unknown): number {
  const numeric = typeof type === 'number' ? type : Number(type)
  return PACKAGE_ICON_SIZES[numeric] ?? PACKAGE_ICON_SIZES[1] ?? 20
}

/** 余位文案 —— `normal` 展示「余 N 个」，另外两档展示状态字。 */
function availabilityTextOf(available: unknown, state: unknown): string {
  if (state === 'soldout') return LOCKER_PAGE_COPY.soldOut
  if (state === 'offline') return LOCKER_PAGE_COPY.unavailable
  const count = typeof available === 'number' ? available : Number(available)
  return LOCKER_PAGE_COPY.remaining.replace('{count}', String(Number.isFinite(count) ? count : 0))
}

Component({
  properties: {
    /** 后端数字码（1 小 / 2 中 / 3 大 / 4 特大）。 */
    type: {
      type: Number,
      value: 1,
    },
    /** 中文档名 —— 由页面从文案层传入。 */
    label: {
      type: String,
      value: '',
    },
    /** 该档余位。 */
    available: {
      type: Number,
      value: 0,
    },
    /** `normal` / `soldout` / `offline`。 */
    state: {
      type: String,
      value: 'normal',
    },
    /** 选中态 —— 描边与 check 的唯一开关。 */
    selected: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    iconSize: 20,
    availabilityText: availabilityTextOf(0, 'normal'),
  },

  observers: {
    type(type: unknown) {
      this.setData({ iconSize: iconSizeOf(type) })
    },
    'available, state'(available: unknown, state: unknown) {
      this.setData({ availabilityText: availabilityTextOf(available, state) })
    },
  },

  lifetimes: {
    attached() {
      // 属性默认值在部分基础库上不会触发 observer —— 挂载时补一次初值，
      // 保证首帧的图标尺寸与余位文案就是对的，而不是等到下一次 setData。
      this.setData({
        iconSize: iconSizeOf(this.data.type),
        availabilityText: availabilityTextOf(this.data.available, this.data.state),
      })
    },
  },

  methods: {
    /**
     * 点击一格 —— **只有 `normal` 档把选择交给页面**。
     *
     * ⚠️ 售罄 / 离线不发事件是刻意的：它们是服务端回显的正常状态，
     * 点了不该产生任何动作（更不该打一次注定 `8002` / `4004` 的建单请求）。
     */
    onTap(): void {
      if (this.data.state !== 'normal') return
      this.triggerEvent('select', { type: this.data.type })
    },
  },
})

// 显式标记为模块：本文件没有 export，但测试用动态 import 读取 Component() 定义。
export {}
