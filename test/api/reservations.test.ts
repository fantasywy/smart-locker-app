// **预约端点（13.12–13.15）的验收** —— ticket #70 / spec #57 §10。
//
// 本文件守页面测不到的三件事：
//   1. 四个端点的**路径 / 方法 / 请求体**逐字对齐契约（尤其 `13.13` 的 `status` 不传）；
//   2. 列表响应的 `{list,total}` 在 `api/` 层**只映射一次**成 `PageOf.records` ——
//      页面不该认识 `list` 这个字段名；
//   3. 失败原样交给页面，`api/` 不做业务归因。
//
// ⚠️ 请求层用回调式 `wx.request`，所以回话用 `respondInOrder()` / `queueMicrotask`，
// 不用 `mockResolvedValueOnce`（见 `test/helpers/wx.ts` 文件头）。

import { describe, expect, it } from 'vitest'
import { installWxStub, jsonResponse } from '../helpers/wx'
import { respondInOrder, sentRequests } from '../helpers/http'
import { BASE_URL } from '../../miniprogram/request/config'
import {
  RESERVATIONS_PATH,
  cancelReservation,
  createReservation,
  listReservations,
  useReservation,
} from '../../miniprogram/api/reservations'
import type { Reservation } from '../../miniprogram/types/reservations'

/** 一份契约形状的 `13.13` 行。 */
function reservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: 301,
    resvNo: 'R20250401001',
    lockerId: 11,
    lockerNo: 'WD-01',
    siteName: '万达广场店',
    cellNo: 'M05',
    cellType: 2,
    planStartAt: '2026-09-23T14:00:00+08:00',
    planEndAt: '2026-09-23T16:00:00+08:00',
    actualStartAt: null,
    status: 1,
    orderId: null,
    ...overrides,
  }
}

function ok(data: unknown): ReturnType<typeof jsonResponse> {
  return jsonResponse({ code: 0, message: 'ok', data })
}

describe('#70 预约端点 · 13.12 创建', () => {
  it('POST /reservations，请求体恰好四个契约字段（cellType 是数字码）', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation(
      respondInOrder([ok({ reservationId: 301, resvNo: 'R20250401001', cellNo: 'M05' })]),
    )

    const result = await createReservation({
      lockerId: 11,
      cellType: 2,
      planStartAt: '2026-09-23T14:00:00',
      planEndAt: '2026-09-23T16:00:00',
    })

    const [sent] = sentRequests(wx.request)
    expect(sent?.url).toBe(`${BASE_URL}${RESERVATIONS_PATH}`)
    expect(sent?.method).toBe('POST')
    expect(sent?.data).toEqual({
      lockerId: 11,
      cellType: 2,
      planStartAt: '2026-09-23T14:00:00',
      planEndAt: '2026-09-23T16:00:00',
    })
    expect(result).toEqual({
      ok: true,
      data: { reservationId: 301, resvNo: 'R20250401001', cellNo: 'M05' },
    })
  })
})

describe('#70 预约端点 · 13.13 我的预约列表', () => {
  it('GET /reservations?page=&pageSize=，`{list,total}` 映射成 `{records,total}`', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation(
      respondInOrder([ok({ list: [reservation()], total: 1 })]),
    )

    const result = await listReservations(2, 10)

    const [sent] = sentRequests(wx.request)
    expect(sent?.url).toBe(`${BASE_URL}${RESERVATIONS_PATH}?page=2&pageSize=10`)
    expect(sent?.method).toBe('GET')
    // ⚠️ 页面只认识 `records`（`utils/pagination.ts` 的 `PageOf`）——
    // `api/` 是 `list → records` 的唯一映射点。
    expect(result).toEqual({
      ok: true,
      data: { records: [reservation()], total: 1 },
    })
  })

  it('业务失败原样返回，不把 `list` 洗成空数组', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation(
      respondInOrder([jsonResponse({ code: 6202, message: '状态已变化', data: null })]),
    )

    const result = await listReservations(1, 10)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('业务失败不应成功')
    expect(result.error.code).toBe(6202)
    expect(result.error.message).toBe('状态已变化')
  })
})

describe('#70 预约端点 · 13.14 取消 / 13.15 开始使用', () => {
  it('取消：POST /reservations/:id/cancel，成功 data 为 null', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation(respondInOrder([ok(null)]))

    const result = await cancelReservation(301)

    const [sent] = sentRequests(wx.request)
    expect(sent?.url).toBe(`${BASE_URL}${RESERVATIONS_PATH}/301/cancel`)
    expect(sent?.method).toBe('POST')
    expect(result).toEqual({ ok: true, data: null })
  })

  it('开始使用：POST /reservations/:id/use，返回 orderId', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation(
      respondInOrder([ok({ orderId: 2002, orderNo: '20250401002', cellNo: 'M05' })]),
    )

    const result = await useReservation(301)

    const [sent] = sentRequests(wx.request)
    expect(sent?.url).toBe(`${BASE_URL}${RESERVATIONS_PATH}/301/use`)
    expect(sent?.method).toBe('POST')
    expect(result).toEqual({
      ok: true,
      data: { orderId: 2002, orderNo: '20250401002', cellNo: 'M05' },
    })
  })

  it('6202（窗口外 / 状态已变）只是失败对象 —— 归因在页面', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation(
      respondInOrder([
        jsonResponse({ code: 6202, message: '当前不在使用窗口内', data: null }),
      ]),
    )

    const result = await useReservation(301)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('6202 不应成功')
    expect(result.error.code).toBe(6202)
    expect(result.error.message).toBe('当前不在使用窗口内')
  })
})
