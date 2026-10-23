// **附近站点卡**（`station-card`）的契约 —— ticket #72 / spec #57 §8 + §11。
//
// 这个组件是附近目录的**唯一**呈现单元。四条硬边界：
//   1. 字段矩阵：名称 / 状态 / 距离（有则）/ 营业时间（缺则整行不渲染）/ 地址 /
//      四档余位（0 也渲染）/ 柜机位置（>2 折叠）/ 导航（有坐标才出现）；
//   2. 卡片唯一动作是导航；导航只发事件，`wx.openLocation` 归宿主；
//   3. 没有任何 `lockerId` / 柜机码 / 查看柜机 / 下单 / 预约出口；
//   4. 无坐标站点不显示距离与导航，但仍在列表里。
//
// 断言只落在组件级 seam：`Component()` 定义 + `site` 观察者 + 事件。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWxStub } from '../helpers/wx'
import { NEARBY_COPY } from '../../miniprogram/startup/copy'
import type { NearbySite } from '../../miniprogram/types/nearby'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const cardDir = join(repoRoot, 'miniprogram', 'components', 'station-card')
const cardSource = (): string =>
  readFileSync(join(cardDir, 'station-card.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
const cardWxml = (): string =>
  readFileSync(join(cardDir, 'station-card.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')

interface ComponentDefinition {
  properties: Record<string, { type?: unknown; value?: unknown }>
  data: Record<string, unknown>
  observers?: Record<string, (...args: unknown[]) => void>
  methods: Record<string, (...args: unknown[]) => unknown>
  lifetimes?: Record<string, (...args: unknown[]) => unknown>
}

interface CardInstance {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  triggerEvent: ReturnType<typeof vi.fn>
  onSelect: () => void
  onNavigate: () => void
}

const SITE_ID = 12

/** 一份契约形状的站点行 —— 每个用例只覆盖它要测的字段。 */
function site(overrides: Partial<NearbySite> = {}): NearbySite {
  return {
    siteId: SITE_ID,
    name: '望京 SOHO T1',
    city: '北京',
    address: '朝阳区望京街 10 号',
    lng: 116.481,
    lat: 39.996,
    distanceMeters: 426,
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

let definition: ComponentDefinition | null = null

beforeEach(() => {
  definition = null
  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (def: Record<string, unknown>): void => {
    definition = def as unknown as ComponentDefinition
  }
})

async function loadComponent(): Promise<ComponentDefinition> {
  vi.resetModules()
  await import('../../miniprogram/components/station-card/station-card')
  if (definition === null) throw new Error('station-card.ts 没有调用 Component()')
  return definition
}

function instantiate(def: ComponentDefinition, current: NearbySite): CardInstance {
  const instance = {
    data: { ...def.data, site: current },
    setData(patch: Record<string, unknown>): void {
      Object.assign(instance.data, patch)
    },
    triggerEvent: vi.fn(),
  } as unknown as CardInstance
  for (const [name, fn] of Object.entries(def.methods)) {
    ;(instance as unknown as Record<string, unknown>)[name] = fn.bind(instance)
  }
  return instance
}

/** 走一遍真实属性观察者 —— 断言看到的就是模板能拿到的渲染模型。 */
async function render(current: NearbySite): Promise<CardInstance> {
  const def = await loadComponent()
  const instance = instantiate(def, current)
  def.observers?.site?.call(instance, current)
  return instance
}

describe('#72 station-card · 字段矩阵', () => {
  it('站点名 / 可用状态 / 距离 / 营业时间 / 地址 / 四档余位 / 柜机位置 / 只读说明齐全', async () => {
    const instance = await render(site())

    expect(instance.data).toMatchObject({
      siteId: SITE_ID,
      name: '望京 SOHO T1',
      statusLabel: NEARBY_COPY.statusAvailable,
      statusTone: 'ok',
      distanceText: '430 m',
      showDistance: true,
      businessHours: '08:00-22:00',
      showBusinessHours: true,
      address: '朝阳区望京街 10 号',
      showAddress: true,
      showNavigate: true,
      navigateLabel: NEARBY_COPY.navigate,
      footer: NEARBY_COPY.footer,
    })
    expect(instance.data.cellRows).toEqual([
      { key: 'small', label: NEARBY_COPY.cellLabels.small, count: 4 },
      { key: 'medium', label: NEARBY_COPY.cellLabels.medium, count: 2 },
      { key: 'large', label: NEARBY_COPY.cellLabels.large, count: 0 },
      { key: 'extraLarge', label: NEARBY_COPY.cellLabels.extraLarge, count: 1 },
    ])
    expect(instance.data.lockerPositions).toEqual(['B1 层 3 号电梯口', 'B1 层 5 号电梯口'])
    expect(instance.data.showLockerMore).toBe(false)
  })

  it('营业时间缺失 → 整行不渲染；地址缺失同理', async () => {
    const instance = await render(site({ businessHours: null, address: null }))
    expect(instance.data.showBusinessHours).toBe(false)
    expect(instance.data.businessHours).toBe('')
    expect(instance.data.showAddress).toBe(false)
  })

  it('可用状态只映射服务端 1 / 2 / 3，不拿站点后台状态重算', async () => {
    const cases = [
      { availability: 1 as const, label: NEARBY_COPY.statusAvailable, tone: 'ok' },
      { availability: 2 as const, label: NEARBY_COPY.statusFull, tone: 'warn' },
      { availability: 3 as const, label: NEARBY_COPY.statusUnavailable, tone: 'muted' },
    ]
    for (const entry of cases) {
      const instance = await render(site({ availability: entry.availability }))
      expect(instance.data.statusLabel).toBe(entry.label)
      expect(instance.data.statusTone).toBe(entry.tone)
      // DTO 里没有 site.status；页面也不得把后台处置状态画成营业状态。
      expect(instance.data).not.toHaveProperty('siteStatus')
    }

    // 零柜机按「暂不可用」返回（服务端派生）；客户端不补一个自己的判断。
    const noLockers = await render(site({ availability: 3, lockers: [] }))
    expect(noLockers.data.statusLabel).toBe(NEARBY_COPY.statusUnavailable)
  })

  it('距离：<1 km 取整到 10 m；≥1 km 一位小数 + km；0 合法；无坐标不出距离', async () => {
    expect((await render(site({ distanceMeters: 0 }))).data.distanceText).toBe('0 m')
    expect((await render(site({ distanceMeters: 426 }))).data.distanceText).toBe('430 m')
    expect((await render(site({ distanceMeters: 1000 }))).data.distanceText).toBe('1.0 km')
    expect((await render(site({ distanceMeters: 1249 }))).data.distanceText).toBe('1.2 km')
    expect((await render(site({ distanceMeters: 1250, lng: null, lat: null }))).data).toMatchObject({
      showDistance: false,
      distanceText: '',
    })
  })

  it('柜机位置 >2 台时只显示前两条 + 「共 N 台」；空位置不渲染该行', async () => {
    const many = await render(
      site({
        lockers: [
          { position: 'A', status: 1 },
          { position: 'B', status: 1 },
          { position: 'C', status: 2 },
        ],
      }),
    )
    expect(many.data.lockerPositions).toEqual(['A', 'B'])
    expect(many.data.showLockerMore).toBe(true)
    expect(many.data.lockerMoreText).toBe('共 3 台')

    const none = await render(
      site({ lockers: [{ position: null, status: 1 }] }),
    )
    expect(none.data.showLockers).toBe(false)
  })

  it('无坐标站点：不出距离、不出导航，但仍渲染站点名与余位', async () => {
    const instance = await render(
      site({ lng: null, lat: null, distanceMeters: null }),
    )
    expect(instance.data).toMatchObject({
      name: '望京 SOHO T1',
      showDistance: false,
      showNavigate: false,
    })
    expect(instance.data.cellRows).toHaveLength(4)
  })
})

describe('#72 station-card · 事件与能力边界', () => {
  it('⚠️ 属性只有 site，事件只有 select / navigate；组件自己不导航', async () => {
    const definition = await loadComponent()
    expect(Object.keys(definition.properties)).toEqual(['site'])

    const wxStub = installWxStub()
    const instance = await render(site())

    instance.onSelect()
    expect(instance.triggerEvent).toHaveBeenCalledWith('select', { siteId: SITE_ID })
    instance.onNavigate()
    expect(instance.triggerEvent).toHaveBeenCalledWith('navigate', { siteId: SITE_ID })

    expect(wxStub.openLocation).not.toHaveBeenCalled()
    expect(wxStub.navigateTo).not.toHaveBeenCalled()
    expect(wxStub.switchTab).not.toHaveBeenCalled()
  })

  it('⚠️ 源码无 lockerId / 柜机码 / 出站柜机页 / 下单 / 预约', () => {
    const source = cardSource() + cardWxml()
    expect(source).not.toMatch(/lockerId|lockers?\[\]\.code|柜机码|柜机 ID/i)
    expect(source).not.toMatch(/pages\/locker|LOCKER_PATH|navigateTo|redirectTo|switchTab/)
    expect(source).not.toMatch(/createOrder|reservation|预约|下单/)
    expect(source).not.toContain('查看柜机')
  })

  it('模板唯一动作是导航，且导航用 catchtap 不冒泡到选卡', () => {
    const wxml = cardWxml()
    expect(wxml).toMatch(/catchtap="onNavigate"/)
    expect(wxml).not.toMatch(/bindtap="onNavigate"/)
    expect(wxml).toMatch(/catchtap="onSelect"/)
  })
})
