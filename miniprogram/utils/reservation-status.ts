// **预约状态** —— 后端数字码 → 标签 / 色档 / 分组归属。全站唯一的一处判定。
//
// ## 为什么需要一个模块
//
// spec #57 §10 的五个显示态逐字定稿，而列表同时要做「待使用 / 已结束」两组。
// 若页面里各写一遍 `status === 1`，第一次改动（比如把 `NOSHOW` 从危险档调走）
// 只会落在其中一处，于是同一张预约在组头与标签上各说一套。
//
// ## 两条边界
//
// 1. **色档是样式决策，不是文案。** 它不参与 `copy.ts`（那里只有用户能读到的字），
//    但必须与 `tone-card` / `tone-chip` 的档名一致：`ok` / `warn` / `danger` / `muted`。
// 2. **只认数字码**：`ReservationStatus` 是后端值域；`PENDING` 等英文名只在注释里出现。
//
// ⚠️ 本模块是纯函数，不碰 `wx.*`、不读当前时间 —— 与 `utils/order-status.ts` 同一纪律。

import { RESERVATION_STATUS_LABELS } from '../startup/copy'
import type { ReservationStatusKey } from '../startup/copy'
import type { ReservationStatus } from '../types/reservations'

/**
 * 预约状态标签的色档 —— 直接对应 `styles/_mixins.scss` 的 `tone-*` 档名。
 *
 * ⚠️ **`NOSHOW` 走 danger**：它是唯一「已发生扣分」的状态，必须一眼可辨；
 * `EXPIRED` 是柜机故障、不扣分，走中性档 —— 两者若同色，归因纪律就废了。
 */
export type ReservationStatusTone = 'ok' | 'danger' | 'muted'

/** 状态摘要 —— 页面只消费这三个字段。 */
export interface ReservationStatusBadge {
  /** 语义键 —— 测试与样式选择器用；不直接上屏。 */
  key: ReservationStatusKey
  /** 用户看到的标签（逐字来自 `RESERVATION_STATUS_LABELS`）。 */
  label: string
  /** 标签色档。 */
  tone: ReservationStatusTone
}

/**
 * 把 `13.13` 的 `status` 收敛成状态标签。
 *
 * 五个数字码与五个语义一一对应，**没有合并**（与订单的 11→9 不同：预约的五个枚举
 * 在用户视角本就是五件事）。
 */
export function resolveReservationStatus(status: ReservationStatus): ReservationStatusBadge {
  if (status === 1) return badge('pending', 'ok')
  if (status === 2) return badge('used', 'muted')
  if (status === 3) return badge('cancelled', 'muted')
  if (status === 4) return badge('noshow', 'danger')
  return badge('expired', 'muted')
}

/** 是否「待使用」组 —— 只有它允许开始使用 / 取消预约。 */
export function isPendingReservation(status: ReservationStatus): boolean {
  return status === 1
}

function badge(key: ReservationStatusKey, tone: ReservationStatusTone): ReservationStatusBadge {
  return { key, label: RESERVATION_STATUS_LABELS[key], tone }
}
