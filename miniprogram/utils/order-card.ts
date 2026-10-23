// **订单卡片的渲染子集** —— `OrderSummary` → `OrderCardOrder` 的**唯一**裁剪点。
//
// ## 为什么单独一层
//
// 首页进行中区与订单列表画的是**同一种卡**（`order-card` 组件），而两者的来源
// （`13.8` 的行 / 两条进行中流合并后的行）都满足 `OrderSummary`。两页各写一遍
// `cardOrderOf` 的后果不是重复十行，而是**两处裁剪出的字段集合悄悄分叉** ——
// 首页卡多带了取件码、列表卡少带了站点名，同一个组件在两个页面上长得不一样。
//
// ⚠️ 裁剪是**有意的**：`orderNo` / `lockerId` / `cellType` 不进渲染模型（spec §14.5），
// 卡片组件拿不到它们，也就画不出它们。少搬一个字段，就少一条上屏的路。
//
// ⚠️ 本模块是纯函数：不碰 `wx.*`、不读时钟、不写 storage。

import type { OrderCardOrder, OrderSummary } from '../types/orders'

/** 列表行 → 卡片组件能看到的字段 —— 只有这里决定「卡片看得到什么」。 */
export function cardOrderOf(order: OrderSummary): OrderCardOrder {
  return {
    id: order.id,
    status: order.status,
    startAt: order.startAt,
    endAt: order.endAt,
    payAmount: order.payAmount,
    estimatedAmount: order.estimatedAmount,
    pickupCode: order.pickupCode,
    siteName: order.siteName,
    lockerNo: order.lockerNo,
    cellNo: order.cellNo,
  }
}
