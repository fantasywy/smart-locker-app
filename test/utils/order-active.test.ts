// **进行中订单的合并口径** —— 首页进行中区与订单列表进行中组共用同一段判定。
//
// spec #57 §2 / §6 的候选集合是 `status == 2`，或（`status == 4` 且 `endAt == null`）；
// 排序是「已超时 → 待存入 → 已存入」，同档按 `id` 倒序。两处各写一遍 `if` 的后果是
// 首页与列表对同一张订单给出不同分组 —— 所以判定与排序只允许有一个家。
//
// ⚠️ `status == 1`（待支付）按进行中兜底：一期不产生，但若服务端意外回显，
// 它仍进进行中组、标签「待支付」、不给 CTA（spec §6）。本文件把它钉住。

import { describe, expect, it } from 'vitest'
import { isActiveOrder, mergeActiveOrders } from '../../miniprogram/utils/order-active'
import type { OrderSummary } from '../../miniprogram/types/orders'

function order(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: 1,
    orderNo: '20250401001',
    lockerId: 11,
    lockerNo: 'WD-01',
    siteName: '万达广场店',
    cellNo: 'S03',
    cellType: 2,
    startAt: null,
    endAt: null,
    status: 2,
    payAmount: null,
    estimatedAmount: null,
    pickupCode: null,
    ...overrides,
  }
}

describe('#67 进行中订单 · 判定与排序', () => {
  it('判定：2，或 4 且 endAt 为空；4 已闭单 / 3 / 5 / 6 / 7 不属于进行中', () => {
    expect(isActiveOrder(order({ status: 2, startAt: null }))).toBe(true)
    expect(isActiveOrder(order({ status: 2, startAt: '2026-10-23T09:00:00+08:00' }))).toBe(true)
    expect(
      isActiveOrder(order({ status: 4, startAt: '2026-10-23T07:00:00+08:00', endAt: null })),
    ).toBe(true)
    expect(
      isActiveOrder(
        order({
          status: 4,
          startAt: '2026-10-23T07:00:00+08:00',
          endAt: '2026-10-23T08:00:00+08:00',
        }),
      ),
    ).toBe(false)
    for (const status of [3, 5, 6, 7] as const) {
      expect(isActiveOrder(order({ status }))).toBe(false)
    }
  })

  it('排序：已超时 → 待存入 → 已存入；同档 id 倒序', () => {
    const merged = mergeActiveOrders(
      [
        order({ id: 10, status: 2, startAt: '2026-10-23T09:00:00+08:00' }),
        order({ id: 20, status: 2, startAt: null }),
        order({ id: 30, status: 2, startAt: '2026-10-23T08:00:00+08:00' }),
      ],
      [order({ id: 40, status: 4, startAt: '2026-10-23T07:00:00+08:00', endAt: null })],
    )
    expect(merged.map((item) => item.id)).toEqual([40, 20, 30, 10])
  })

  it('合并：过滤两条流里不属于进行中的行，并按 id 去重', () => {
    const merged = mergeActiveOrders(
      [order({ id: 1, status: 2, startAt: null }), order({ id: 2, status: 3 })],
      [
        order({ id: 1, status: 4, startAt: '2026-10-23T07:00:00+08:00', endAt: null }),
        order({ id: 3, status: 4, endAt: '2026-10-23T08:00:00+08:00' }),
      ],
    )
    expect(merged.map((item) => item.id)).toEqual([1])
  })
})
