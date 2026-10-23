// `GET /contents/{key}` —— 手写 DTO + 请求函数，**只做搬运**。
//
// 契约：spec #57 §13「新端点（后端待建）」：
//   `GET /api/app/v1/contents/{key}`（**免鉴权**，后端待建）
//   → `{ key, title, updatedAt, blocks[] }`，未知 key → `404 + 1002`。
//
// ⚠️ **本模块走 `requestWithoutAuth`**，不是普通 `request()`：
//   • 免鉴权是硬要求 —— `failure-exit` 的计费 / FAQ 必须在登录链失败时也能打开；
//   • 登录链可能刚刚清空 token，若这里去读 storage / 撞 401 再触发恢复，
//     内容页就会跟着登录链一起坏掉，而它本来正是那条链的退路。
// `requestWithoutAuth` 不读 storage、不挂恢复；`config.ts` 的豁免前缀是第二道兜底。
//
// ⚠️ **`api/` 不含业务分支**：未知 key 的 `404 + 1002`、网络失败都由页面决定
// 「页内失败 + 重试」；本模块只把异常对象交出去。正文也不在这里加工 ——
// 服务端下发什么 block，页面就按那三种排版。

import type { ContentKey, ContentResponse } from '../types/content'
import type { RequestResult } from '../request/types'
import { CONTENTS_PATH } from '../request/config'
import { requestWithoutAuth } from '../request/index'

/**
 * `GET /contents/{key}` —— 取一页由后端维护的内容。
 *
 * @param key 内容页的固定 key（`billing` / `faq`）。页面不接收路由参数来决定它。
 * @returns 成功时契约 DTO；失败时统一异常对象（**不抛异常**）
 *
 * ⚠️ 返回里的 `title` **不用于导航栏**：导航栏标题按 spec §10 取 `PAGE_TITLES`。
 * 内容正文归后端，界面文案归文案层，两者不互相顶替。
 */
export function getContent(key: ContentKey): Promise<RequestResult<ContentResponse>> {
  return requestWithoutAuth<ContentResponse>(`${CONTENTS_PATH}/${key}`)
}
