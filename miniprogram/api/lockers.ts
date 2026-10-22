// `13.6` 扫码查柜机 —— 手写 DTO + 请求函数，**只做搬运**。
//
// 契约：API设计文档.md §13.6 `GET /api/app/v1/lockers/by-code` (:1091-1103)
// ⚠️ `lockerId` 的唯一来源是本响应 data。
//
// ⚠️ **`api/` 不含业务分支**：本模块只做「入参 → 请求 → 出参 DTO」。
// 「`online === false` 该置灰谁」「`1002` 该说什么」全在页面 —— 这样同一个端点在将来的
// 别的页面被用到时不会长出两套语义。
//
// ⚠️⚠️ **`13.6` 需要 access。** 这不是一条可以「顺手免鉴权」的端点：
// 这一点已按源码核实（§13 总则 :1043 + §13.6 :1103「需登录态」），
// 曾被认为是冲突的那条「命名风格例外」（:25）讲的是**路径命名**，不是鉴权豁免。
// ⇒ 它走 `request()`（带 auth + 登录失效恢复），**不是** `requestWithoutAuth`。
// 后果是**冷启动扫码通道 A 必须先完成登录**才能拿到柜机信息 ——
// 这不是特例，是启动状态机的常规路径。
//
// ⚠️ `13.6` **不返回价格、不返回格口清单**（`cellNo` 只在建单后返回）
// ⇒ 柜机页天然只有一屏：站点名 + 位置 + 三档余位 + 入口。别在这里找价格字段。

import type { LockerByCode } from '../types/lockers'
import type { RequestResult } from '../request/types'
import { API_PREFIX } from '../request/config'
import { request } from '../request/index'

/** `13.6` 的路径 —— `GET /api/app/v1/lockers/by-code`（契约 §13.6 :1091）。 */
export const LOCKER_BY_CODE_PATH = `${API_PREFIX}/lockers/by-code`

// ⚠️ **DTO 在 `../types/lockers.ts`**，不在本文件（「`types/` 与 `api/`
// 一一对应」）。本模块只做搬运：入参 → 请求 → 出参 DTO。
// 想读契约形状的读者去看那个文件；想读调用方式的读者看这里。
//
// ⚠️ 那句「`13.6` 不返回价格、不返回格口清单 ⇒ 柜机页天然只有一屏」的完整说明
// 与各字段的契约出处，随 DTO 一起搬去了 `types/lockers.ts` —— 这里不再重述。
/**
 * `13.6` 扫码查柜机 —— 按柜机码反查一台柜机。
 *
 * @param code `resolveLockerCode()` 收敛出来的柜机码（如 `WD-01`）。**由调用方保证非空** ——
 *             解析不出 `code` 时页面根本不该走到这里。
 * @returns 成功时柜机信息；失败时统一异常对象（四字段，**不抛异常**）
 *
 * ⚠️ **唯一可预期的业务失败码是 `1002`**（柜机不存在 / 已软删，`:1101`）——
 * 它对应用户可见的「这个码可能来自旧贴纸」，与「解析不出 code」
 * **走同一个页面、只换文案**。归属判断在页面，不在这里。
 *
 * ⚠️ `401` 不会从这里漏出去给页面：请求层内部消费掉登录失效处理。
 */
export function getLockerByCode(code: string): Promise<RequestResult<LockerByCode>> {
  return request<LockerByCode>(`${LOCKER_BY_CODE_PATH}?code=${encodeURIComponent(code)}`)
}
