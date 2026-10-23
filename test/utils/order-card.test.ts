// **订单卡片的渲染子集**的唯一实现处 —— code review finding G 的验收。
//
// 首页与订单列表此前各有一份**逐字相同**的 `cardOrderOf`。两份的后果不是重复十行，
// 而是「卡片看得到什么字段」这件事有两个说法 —— 一处多带 `pickupCode`、
// 另一处少带 `siteName`，同一个组件在两页上就会长得不一样。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cardOrderOf } from '../../miniprogram/utils/order-card'
import type { OrderSummary } from '../../miniprogram/types/orders'

function order(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: 1001,
    orderNo: '20250401001',
    lockerId: 11,
    lockerNo: 'WD-01',
    siteName: '万达广场店',
    cellNo: 'S03',
    cellType: 2,
    startAt: '2026-10-23T09:00:00+08:00',
    endAt: null,
    status: 2,
    payAmount: null,
    estimatedAmount: 1800,
    pickupCode: '385214',
    ...overrides,
  }
}

function sourceOf(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../../miniprogram/${relativePath}`, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

describe('utils/order-card —— 卡片子集只裁一次', () => {
  it('裁剪保留卡片要的字段，丢掉 orderNo / lockerId / cellType', () => {
    const card = cardOrderOf(order())

    expect(card).toEqual({
      id: 1001,
      status: 2,
      startAt: '2026-10-23T09:00:00+08:00',
      endAt: null,
      payAmount: null,
      estimatedAmount: 1800,
      pickupCode: '385214',
      siteName: '万达广场店',
      lockerNo: 'WD-01',
      cellNo: 'S03',
    })
    // ⚠️ 少搬一个字段就少一条上屏的路：订单号 / 柜机 ID / 档位码都不进渲染模型。
    expect(card).not.toHaveProperty('orderNo')
    expect(card).not.toHaveProperty('lockerId')
    expect(card).not.toHaveProperty('cellType')
  })

  it('两个页面都引用它，没有第二份 `cardOrderOf` 实现', () => {
    const consumers = ['pages/index/index.ts', 'pages/order-list/order-list.ts']
    for (const path of consumers) {
      const code = sourceOf(path)
      expect(code, `${path} 没有引用共享裁剪`).toContain("from '../../utils/order-card'")
      // 本页里不得再有 `function cardOrderOf(` 的定义。
      expect(code, `${path} 又写了一份 cardOrderOf`).not.toMatch(/function\s+cardOrderOf\s*\(/)
    }
  })
})
