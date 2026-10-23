// `13.16` 信用分明细的**手写 DTO** —— 只有形状，没有行为。
//
// 契约：API设计文档.md §13.16 `GET /api/app/v1/score-logs`
//（响应结构同管理端 §9.3，仅本人数据）。
//
// ⚠️ 本模块遵守类型层的既定规则：不发明字段、不改字段名、可空显式标 `| null`、
// 枚举值与后端逐字一致（`type` 是数字码 1 / 2），**找不到契约依据的字段不写**。
//
// ⚠️ **`type` 与 `operatorName` 是内部字段**：类型层如实反映后端形状，但页面
// 不得把它们搬进渲染模型 —— 用户只看变动值 / 原因 / 时间（spec §10）。
// 「类型上有」不等于「界面可以画」。

/**
 * 信用分变动类型 —— **后端数字码**。
 *
 * 契约：`1`(AUTO，规则触发) / `2`(MANUAL，人工调整)。
 *
 * ⚠️ 这是**内部归因**，任何 C 端界面都不展示；它只用于让 DTO 与契约逐字一致。
 * 中文 / 英文枚举名都不成为运行时值，页面也不读它。
 */
export type ScoreLogType = 1 | 2

/**
 * `13.16` 列表行。
 *
 * 契约：§9.3 / §13.16
 *
 * ```json
 * { "id": 1, "delta": -10, "reason": "预约爽约", "type": 1,
 *   "operatorName": null, "createdAt": "2025-03-20T08:00:00+08:00" }
 * ```
 */
export interface ScoreLog {
  /** 记录 ID —— 分页去重的键。 */
  id: number

  /**
   * 信用分变动值 —— 负数是扣分，正数是加分，`0` 是实际未变动但留痕。
   *
   * ⚠️ 界面必须显式带符号（`−10` / `+5`），不能只写绝对值；
   * `0` 不带符号、走中性色。
   */
  delta: number

  /** 变动原因 —— 由服务端下发并原样展示；页面不自己编归因。 */
  reason: string

  /** 内部类型（AUTO / MANUAL）—— **不上屏**。 */
  type: ScoreLogType

  /** 操作人姓名 —— 内部员工信息，**不上屏**；自动变动时为 `null`。 */
  operatorName: string | null

  /** 变动时刻 —— 服务端回显的 ISO 串；界面按全站完整时间格式展示。 */
  createdAt: string
}

/**
 * `13.16` 响应 `data` —— `{list,total}`。
 *
 * ⚠️ 页面只认识 `PageOf.records`；`list → records` 的映射在
 * `api/score-logs.ts` 一处完成（repo 的分页口径：不在页面各写一遍）。
 */
export interface ScoreLogListResponse {
  list: ScoreLog[]
  total: number
}
