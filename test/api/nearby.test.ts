// **附近柜机端点**的验收 —— ticket #72 / spec #57 §8、§13。
//
// 本文件守页面测不到的三件事：
//   1. 半径 / 城市 / 关键词 / 分页参数的拼装逐字对齐契约，`city` 是必填项；
//   2. `{list,total}` 只在 `api/` 层映射一次成 `{records,total}`；
//   3. 城市清单原样搬运，`{list}` 不冒充分页。
//
// ⚠️ 附近接口**不含 `lockerId` / 柜机码**：类型层不声明它们，测试夹具也不编造。

import { describe, expect, it } from 'vitest'
import { installWxStub, jsonResponse } from '../helpers/wx'
import { respondInOrder, sentRequests } from '../helpers/http'
import { BASE_URL } from '../../miniprogram/request/config'
import {
  NEARBY_CITIES_ENDPOINT,
  NEARBY_SITES_ENDPOINT,
  listNearbyCities,
  listNearbySites,
} from '../../miniprogram/api/nearby'

function ok(data: unknown): ReturnType<typeof jsonResponse> {
  return jsonResponse({ code: 0, message: 'ok', data })
}

/** 一份契约形状的站点行 —— 只含 §13 允许的字段。 */
function site(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    siteId: 12,
    name: '望京 SOHO T1',
    city: '北京',
    address: '朝阳区望京街 10 号',
    lng: 116.481,
    lat: 39.996,
    distanceMeters: 420,
    businessHours: '08:00-22:00',
    availability: 1,
    cellAvailability: { small: 4, medium: 2, large: 0, extraLarge: 1 },
    lockers: [
      { position: 'B1 层 3 号电梯口', status: 1 },
      { position: 'B1 层 5 号电梯口', status: 1 },
    ],
    ...overrides,
  }
}

describe('#72 附近站点端点 · 参数与映射', () => {
  it('带上成对坐标 / 城市 / 半径 / 分页，响应 `{list,total}` 映射成 `{records,total}`', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation(
      respondInOrder([ok({ list: [site()], total: 1 })]),
    )

    const result = await listNearbySites({
      lat: 39.996,
      lng: 116.481,
      radiusMeters: 3000,
      city: '北京',
      page: 2,
      pageSize: 20,
    })

    const [sent] = sentRequests(wx.request)
    expect(sent?.url).toBe(
      `${BASE_URL}${NEARBY_SITES_ENDPOINT}?lat=39.996&lng=116.481&radiusMeters=3000&city=${encodeURIComponent('北京')}&page=2&pageSize=20`,
    )
    expect(sent?.method).toBe('GET')
    expect(result).toEqual({ ok: true, data: { records: [site()], total: 1 } })

    // 响应形状只允许站点聚合字段；没有 lockerId / 柜机码 / site.status。
    if (!result.ok) throw new Error('成功响应不应失败')
    const row = result.data.records[0] as unknown as Record<string, unknown>
    expect(Object.keys(row).sort()).toEqual(
      [
        'address',
        'availability',
        'businessHours',
        'cellAvailability',
        'city',
        'distanceMeters',
        'lat',
        'lng',
        'lockers',
        'name',
        'siteId',
      ].sort(),
    )
    expect(row).not.toHaveProperty('lockerId')
    expect(row).not.toHaveProperty('code')
    expect(row).not.toHaveProperty('status')
  })

  it('搜索必带城市；关键词做编码且不传半径（城内搜索忽略半径）', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation(respondInOrder([ok({ list: [], total: 0 })]))

    await listNearbySites({
      city: '上海',
      keyword: '嘉里 中心',
      page: 1,
      pageSize: 20,
    })

    const [sent] = sentRequests(wx.request)
    expect(sent?.url).toBe(
      `${BASE_URL}${NEARBY_SITES_ENDPOINT}?city=${encodeURIComponent('上海')}&keyword=${encodeURIComponent('嘉里 中心')}&page=1&pageSize=20`,
    )
  })

  it('城市清单从 `{list}` 原样取出，不分页、不改名', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation(
      respondInOrder([ok({ list: [{ city: '北京', siteCount: 42 }, { city: '上海', siteCount: 8 }] })]),
    )

    const result = await listNearbyCities()

    expect(sentRequests(wx.request)[0]?.url).toBe(`${BASE_URL}${NEARBY_CITIES_ENDPOINT}`)
    expect(result).toEqual({
      ok: true,
      data: [
        { city: '北京', siteCount: 42 },
        { city: '上海', siteCount: 8 },
      ],
    })
  })

  it('业务失败原样返回，不把 `list` 洗成空数组', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation(
      respondInOrder([jsonResponse({ code: 1004, message: '服务端异常', data: null })]),
    )

    const result = await listNearbySites({ city: '北京', page: 1, pageSize: 20 })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('业务失败不应成功')
    expect(result.error.code).toBe(1004)
    expect(result.error.message).toBe('服务端异常')
  })
})
