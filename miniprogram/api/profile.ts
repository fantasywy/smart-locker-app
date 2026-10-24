// `13.4` / `13.5` 个人资料读取与更新 —— 手写 DTO + 请求函数，**只做搬运**。
//
// 契约：API设计文档.md §13.4 `GET /api/app/v1/profile`、§13.5 `PUT /api/app/v1/profile`
//
// ⚠️ **`api/` 不含业务分支**：哪些块显示骨架、失败时块内怎么提示、昵称 1–64 怎么校验，
// 都是页面 / 文案层的裁决。本模块只把契约 DTO 与统一异常对象交出去。
//
// ⚠️ 两个端点**都需要登录态**（§13 总则：除 13.1/13.2 外均需 Bearer），所以走普通
// `request()`：401 由请求层内部的恢复链消费，页面拿到的只有「恢复也失败」那一类。
// 13.4 的失败**不弹窗**，只在块内显示一行「加载失败，请重试」（spec §9）。
//
// ⚠️ 头像上传（`13.17`）不在这里：它属于 `api/files.ts`。本模块只负责 `13.4` / `13.5`；
// 页面按 #75 的流程先调 `uploadAvatar()` 拿 `url`，再把变化字段交给 `updateProfile()`。

import type { ProfileResponse, UpdateProfileRequest } from '../types/profile'
import type { RequestResult } from '../request/types'
import { API_PREFIX } from '../request/config'
import { request } from '../request/index'

/**
 * `13.4` / `13.5` 的路径 —— `GET` 读、`PUT` 写同一个地址。
 *
 * ⚠️ 导出常量而不是在页面里写 `/api/app/v1/profile`：路径只有一个家，
 * 且守卫会挡住页面里的 `/api/app/v1` 字面量。
 */
export const PROFILE_PATH = `${API_PREFIX}/profile`

/**
 * `13.4` 读取当前登录用户的资料。
 *
 * @returns 成功时契约 DTO；失败时统一异常对象（**不抛异常**）
 *
 * ⚠️ 页面进入与每次 `onShow` 各调用一次，且三块（身份 / 受限 / 信用分）**共用同一次结果** ——
 * 不要拆成三条请求，否则三块会各自失败、各自重试，页面上出现三种「加载失败」。
 */
export function getProfile(): Promise<RequestResult<ProfileResponse>> {
  return request<ProfileResponse>(PROFILE_PATH)
}

/**
 * `13.5` 更新个人资料 —— **只提交发生变化的字段**（部分更新）。
 *
 * @param body 只含变化字段的请求体（`nickname` 和 / 或 `avatar`）
 * @returns 成功时契约响应 `data: null`；失败时统一异常对象
 *
 * ⚠️ 成功响应 **没有用户数据**（`data: null`）⇒ 调用方**必须重拉 13.4**，
 * 不做乐观更新：昵称 trim 后落库的值由服务端回显，本地拼一个「应该是这个」就是双源真相。
 */
export function updateProfile(body: UpdateProfileRequest): Promise<RequestResult<null>> {
  return request<null>(PROFILE_PATH, {
    method: 'PUT',
    data: body,
  })
}
