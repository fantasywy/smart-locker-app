// **附近站点的共享展示规则**的行为测试 —— code review finding F 的验收。
//
// 断言只落在纯函数的输出上：可用状态标签、距离写法、坐标判定。
// ⚠️ 这里一个 `wx.*` 桩都不用 —— `utils/nearby.ts` 是纯函数。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NEARBY_COPY } from '../../miniprogram/startup/copy'
import { formatNearbyDistance, hasSiteCoordinates } from '../../miniprogram/utils/nearby'
import type { NearbySite } from '../../miniprogram/types/nearby'

function site(overrides: Partial<NearbySite> = {}): NearbySite {
  return {
    siteId: 1,
    name: '望京 SOHO T1',
    city: '北京',
    address: '朝阳区望京街 10 号',
    lng: 116.481,
    lat: 39.996,
    distanceMeters: 420,
    businessHours: '08:00-22:00',
    availability: 1,
    cellAvailability: { small: 4, medium: 2, large: 0, extraLarge: 1 },
    lockers: [{ position: 'B1 层 3 号电梯口', status: 1 }],
    ...overrides,
  }
}

describe('距离写法', () => {
  it('<1 km 取整到 10 m；≥1 km 一位小数 + km；`0` 是合法距离', () => {
    expect(formatNearbyDistance(0)).toBe(NEARBY_COPY.distanceMeters.replace('{value}', '0'))
    expect(formatNearbyDistance(424)).toBe('420 m')
    expect(formatNearbyDistance(999)).toBe('1000 m')
    expect(formatNearbyDistance(1000)).toBe('1.0 km')
    expect(formatNearbyDistance(12345)).toBe('12.3 km')
  })

  it('未知 / 非法距离留空（不编一个 0 m）', () => {
    expect(formatNearbyDistance(null)).toBe('')
    expect(formatNearbyDistance(Number.NaN)).toBe('')
    expect(formatNearbyDistance(-1)).toBe('')
  })

  it('⚠️ 替换值是函数形式：值里的 `$&` / `$\'` 不会被当成替换模式展开', () => {
    // 模板替换写成 `template.replace('{value}', value)` 时，`value` 里的
    // `$&`（整个匹配）/ `$'`（匹配之后的内容）/ `` $` ``（匹配之前的内容）
    // 会被当成**替换模式**展开 —— 这正是 finding F 要挡的注入面。
    //
    // ⚠️ 距离本身是数字，构造不出含 `$&` 的用例，所以判据取**源码形态**：
    // 这个模块里的模板替换必须走函数形式（与 `utils/datetime.ts` 同一写法）。
    const source = readFileSync(
      fileURLToPath(new URL('../../miniprogram/utils/nearby.ts', import.meta.url)),
      'utf8',
    )
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(code).not.toMatch(/\.replace\([^)]*,\s*String\(/)
    expect(code).toMatch(/\.replace\([^)]*,\s*\(\)\s*=>/)
  })
})

describe('坐标判定', () => {
  it('两轴都是有穷数字才算有坐标', () => {
    expect(hasSiteCoordinates(site())).toBe(true)
    expect(hasSiteCoordinates(site({ lng: null }))).toBe(false)
    expect(hasSiteCoordinates(site({ lat: null }))).toBe(false)
    expect(hasSiteCoordinates(site({ lng: Number.NaN }))).toBe(false)
  })
})
