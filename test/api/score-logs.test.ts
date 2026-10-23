// **信用分明细端点（13.16）的验收** —— ticket #71 / spec #57 §10。
//
// 本文件守页面测不到的三件事：
//   1. `GET /score-logs?page=&pageSize=` 的路径 / 查询参数逐字对齐契约；
//   2. 响应的 `{list,total}` 在 `api/` 层**只映射一次**成 `PageOf.records`；
//   3. 失败原样交给页面，`api/` 不做业务归因。

import { describe, expect, it } from 'vitest'
import { installWxStub, jsonResponse } from '../helpers/wx'
import { respondInOrder, sentRequests } from '../helpers/http'
import { BASE_URL } from '../../miniprogram/request/config'
import { SCORE_LOGS_ENDPOINT, listScoreLogs } from '../../miniprogram/api/score-logs'
import type { ScoreLog } from '../../miniprogram/types/score'

/** 一份契约形状的 `13.16` 行 —— 内部字段也在，供类型与页面隔离两头都验到。 */
function scoreLog(overrides: Partial<ScoreLog> = {}): ScoreLog {
  return {
    id: 1,
    delta: -10,
    reason: '预约爽约',
    type: 1,
    operatorName: null,
    createdAt: '2026-09-22T15:04:00+08:00',
    ...overrides,
  }
}

function ok(data: unknown): ReturnType<typeof jsonResponse> {
  return jsonResponse({ code: 0, message: 'ok', data })
}

describe('#71 信用分明细端点 · 13.16', () => {
  it('GET /score-logs?page=&pageSize=，`{list,total}` 映射成 `{records,total}`', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation(
      respondInOrder([ok({ list: [scoreLog()], total: 1 })]),
    )

    const result = await listScoreLogs(2, 10)

    const [sent] = sentRequests(wx.request)
    expect(sent?.url).toBe(`${BASE_URL}${SCORE_LOGS_ENDPOINT}?page=2&pageSize=10`)
    expect(sent?.method).toBe('GET')
    expect(result).toEqual({
      ok: true,
      data: { records: [scoreLog()], total: 1 },
    })
  })

  it('业务失败原样返回，不把 `list` 洗成空数组', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation(
      respondInOrder([jsonResponse({ code: 1004, message: '服务端异常', data: null })]),
    )

    const result = await listScoreLogs(1, 10)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('业务失败不应成功')
    expect(result.error.code).toBe(1004)
    expect(result.error.message).toBe('服务端异常')
  })
})
