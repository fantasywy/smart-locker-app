// `13.4` 个人信息 / `13.5` 更新个人信息的**手写 DTO** —— 只有形状，没有行为。
//
// 契约：API设计文档.md §13.4 `GET /api/app/v1/profile`、§13.5 `PUT /api/app/v1/profile`
// 后端真源（已核实）：
//   • `locker-identity/.../vo/AppProfileVO.java` —— 响应字段
//   • `locker-identity/.../vo/BlacklistRecordVO.java` —— `blacklistRecord` 的三个字段
//   • `locker-identity/.../dto/AppProfileUpdateRequest.java` —— 请求体只收 `nickname` / `avatar`
//   • `locker-common/.../config/JacksonConfig.java` —— `LocalDateTime` 序列化为
//     `yyyy-MM-dd'T'HH:mm:ss+08:00`；`CodedEnum` 序列化为数字码
//
// ⚠️ **`phone` 在类型里存在，但页面不得展示它。** 类型层如实反映后端形状（「不发明字段、
// 不删契约字段」），而「不展示手机号」是界面层的硬约束 —— 两者不是同一件事。
// 「类型上有 phone」不等于「页面可以画 phone」。
//
// ⚠️ `avatar` 的值域是 `null` / `/api/app/v1/files/{id}` / 历史 `https://…`。
// 我的页按 #75 只把「本站文件地址」交给 `avatar-cache` 解析成本地路径；历史外链与
// null 一律走本地默认图、零请求。页面不保存原始 `url` 上屏，也不引入任何上传开关。
//
// ⚠️ 本模块遵守类型层的既定规则：不发明字段、不改字段名、可空显式标 `| null`、
// 枚举值与后端逐字一致（`UserStatus` 复用 `types/auth.ts` 的数字码），
// 找不到契约依据的字段不写。

import type { UserStatus } from './auth'

/**
 * `13.4` 响应里的受限记录 —— **仅受限用户非空**。
 *
 * 契约：`blacklistRecord` = 最近一次进入记录 `{ reason, createdAt, auto }`
 * （`BlacklistRecordVO`）。`auto` 表示是否系统自动拉黑。
 *
 * ⚠️ **`auto` 是内部归因，界面不得展示**：用户看到的受限卡只说「账号受限」与原因 / 起始时间
 * （spec §9）。`operatorName` / `releaseCondition` 等管理端字段**不在 C 端响应里**，
 * 因此类型里也不出现它们 —— 「契约里没有的字段不写」。
 */
export interface BlacklistRecord {
  /**
   * 进入受限的原因（人工拉黑时为操作人填写的原因）。
   *
   * ⚠️ 契约没有声明它可空，但界面仍须处理「空原因」：为空时**整行省略**（spec §9）。
   * 类型保持 `string`（契约形状），空串判定留给页面。
   */
  reason: string

  /** 进入受限的时刻 —— 服务端回显的 ISO 串（`2026-09-22T15:04:00+08:00`）。 */
  createdAt: string

  /** 是否系统自动拉黑。**只读、不上屏**（界面不得展示内部归因）。 */
  auto: boolean
}

/**
 * `13.4` 响应 `data` —— 当前登录用户的资料。
 *
 * ```json
 * { "id": 88, "nickname": "小明", "avatar": "/api/app/v1/files/42", "phone": "13900000000",
 *   "score": 95, "status": 1, "blacklistRecord": null }
 * ```
 *
 * ⚠️ **`status` 是数字码**（1 正常 / 2 受限），与 `13.1` 的 `LoginUser.status` 同一个
 * `UserStatus` 类型 —— 两处不能各写一套。
 */
export interface ProfileResponse {
  /** 用户 ID。不可空。 */
  id: number

  /** 昵称。**可空** —— 未授权 / 未填写时为 `null`；界面回退「微信用户」。 */
  nickname: string | null

  /**
   * 头像地址。**可空**。
   *
   * 值域：`null`（未设置）/ `/api/app/v1/files/{id}`（本站文件）/ `https://…`（历史外链）。
   * ⚠️ 它**不能直接给 `<image src>`**：本站地址是二进制端点（需 Bearer）。页面只把
   * 合法地址交给 `avatar-cache` 下载 / 命中本地路径后再上屏。
   */
  avatar: string | null

  /** 手机号。**可空**。⚠️ 即便有值，**界面也不得展示**（spec §14.5）。 */
  phone: string | null

  /** 信用分。不可空。⚠️ 它是「信用分」，不是可兑换的「积分」。 */
  score: number

  /** 用户状态（1 正常 / 2 受限）。不可空。 */
  status: UserStatus

  /** 最近一次进入受限的记录；正常用户为 `null`，受限用户非空。 */
  blacklistRecord: BlacklistRecord | null
}

/**
 * `13.5` 请求体 —— `PUT /api/app/v1/profile`。
 *
 * 契约：两个字段均可选，**部分更新**；缺省 / `null` 表示不改。
 *
 * ⚠️ 三态由「字段是否出现」承载：
 *   • `nickname` 缺省 / `null` → 不改；`""` / 纯空白 → `1001`；其它 ≤ 64 原值写入。
 *   • `avatar` 缺省 / `null` → 不改；`""` → 清空；其它必须是本人上传的
 *     `/api/app/v1/files/{id}`。
 *
 * ⚠️ 页面**只提交发生变化的字段**：头像变了发 `avatar`，昵称变了发 `nickname`，
 * 两者都变才同时出现。头像上传成功但 `PUT` 失败时，重试只重发本请求（0 次上传）。
 */
export interface UpdateProfileRequest {
  nickname?: string
  avatar?: string
}
