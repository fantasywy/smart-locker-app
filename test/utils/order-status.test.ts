// **订单谓词**的唯一实现处 —— code review finding A 的验收。
//
// 四个页面此前各写了一遍同一件事：`isEnded`（列表）/ `isHistory`（详情）/
// `isTerminal`（取件层）/ 等待页的裸状态码 switch。它们都在回答「这张单在状态机的
// 哪一格」，于是任何一次口径修正都只会落在其中一处。
//
// 这份用例钉住三件事：
//   1. 谓词的**语义**（进行中 / 已结束互补、可取件、已终局）；
//   2. `isTerminalOrder` 与 `isEndedOrder` 的**差别**（后者是列表分组，前者是支付判据）；
//   3. 页面**不再自己判定** —— 源码层断言它们引用了共享实现。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  canPickupOrder,
  isActiveOrder,
  isEndedOrder,
  isTerminalOrder,
  resolveOrderStatus,
} from '../../miniprogram/utils/order-status'
import type { OrderStatusFields } from '../../miniprogram/utils/order-status'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const miniprogramDir = join(repoRoot, 'miniprogram')

function collect(dir: string, extensions: readonly string[]): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'miniprogram_npm') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...collect(full, extensions))
    else if (extensions.some((ext) => entry.endsWith(ext))) found.push(full)
  }
  return found
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1')
}

function fields(overrides: Partial<OrderStatusFields> = {}): OrderStatusFields {
  return { status: 2, startAt: null, endAt: null, ...overrides }
}

const STORED = '2026-10-23T09:00:00+08:00'
const CLOSED = '2026-10-23T10:00:00+08:00'

describe('utils/order-status —— 订单谓词的唯一定义', () => {
  it('进行中：2，或（4 且 endAt 为空）；1 按进行中兜底', () => {
    expect(isActiveOrder(fields({ status: 2, startAt: null }))).toBe(true)
    expect(isActiveOrder(fields({ status: 2, startAt: STORED }))).toBe(true)
    expect(isActiveOrder(fields({ status: 4, startAt: STORED, endAt: null }))).toBe(true)
    // 待支付一期不产生；若服务端意外回显，按进行中兜底（spec §6）。
    expect(isActiveOrder(fields({ status: 1 }))).toBe(true)
    expect(isActiveOrder(fields({ status: 4, startAt: STORED, endAt: CLOSED }))).toBe(false)
    for (const status of [3, 5, 6, 7] as const) {
      expect(isActiveOrder(fields({ status })), `status=${status} 不该算进行中`).toBe(false)
    }
  })

  it('已结束 = 进行中的**补集** —— 两者永不重合、也不留空隙', () => {
    const cases: OrderStatusFields[] = [
      fields({ status: 1 }),
      fields({ status: 2, startAt: null }),
      fields({ status: 2, startAt: STORED }),
      fields({ status: 3, startAt: STORED, endAt: CLOSED }),
      fields({ status: 4, startAt: STORED, endAt: null }),
      fields({ status: 4, startAt: STORED, endAt: CLOSED }),
      fields({ status: 5, startAt: STORED, endAt: CLOSED }),
      fields({ status: 6, startAt: STORED, endAt: CLOSED }),
      fields({ status: 7 }),
    ]
    for (const order of cases) {
      expect(isEndedOrder(order)).toBe(!isActiveOrder(order))
    }
  })

  it('可取件：已存入（startAt 有值）且未取走（endAt 为空），状态 2 / 4', () => {
    expect(canPickupOrder(fields({ status: 2, startAt: STORED, endAt: null }))).toBe(true)
    expect(canPickupOrder(fields({ status: 4, startAt: STORED, endAt: null }))).toBe(true)
    // 还没存入 / 已经取走 / 终局状态都不能取件。
    expect(canPickupOrder(fields({ status: 2, startAt: null, endAt: null }))).toBe(false)
    expect(canPickupOrder(fields({ status: 2, startAt: STORED, endAt: CLOSED }))).toBe(false)
    expect(canPickupOrder(fields({ status: 3, startAt: STORED, endAt: CLOSED }))).toBe(false)
    expect(canPickupOrder(fields({ status: 7 }))).toBe(false)
  })

  it('已终局是「已结束」的超集：任何 endAt 有值的单都终局（取件层的支付判据）', () => {
    // 终局那四个状态码。
    for (const status of [3, 5, 6, 7] as const) {
      expect(isTerminalOrder(fields({ status }))).toBe(true)
    }
    expect(isTerminalOrder(fields({ status: 4, startAt: STORED, endAt: CLOSED }))).toBe(true)
    // 超集的证明：列表判为「已结束」的每一单，取件层都判为终局。
    for (const ended of [
      fields({ status: 3, startAt: STORED, endAt: CLOSED }),
      fields({ status: 4, startAt: STORED, endAt: CLOSED }),
      fields({ status: 5, startAt: STORED, endAt: CLOSED }),
      fields({ status: 6, startAt: STORED, endAt: CLOSED }),
      fields({ status: 7 }),
    ]) {
      expect(isEndedOrder(ended)).toBe(true)
      expect(isTerminalOrder(ended)).toBe(true)
    }
    // ⚠️ 差别所在：`status=4` 且 `endAt` 为空时**不是**终局 —— 它还在等用户取件。
    const waitingPickup = fields({ status: 4, startAt: STORED, endAt: null })
    expect(isTerminalOrder(waitingPickup)).toBe(false)
    expect(isEndedOrder(waitingPickup)).toBe(false)
    // ⚠️ **反向不成立**：`status=2` 却已经有 `endAt`（服务端状态推进的中间态）——
    // 取件层按终局处理（不再重发支付），而列表分组只认 `status`，仍算在办。
    // 两条判据各自回答自己的问题，所以不能互相替换。
    const closedWhileStored = fields({ status: 2, startAt: STORED, endAt: CLOSED })
    expect(isTerminalOrder(closedWhileStored)).toBe(true)
    expect(isEndedOrder(closedWhileStored)).toBe(false)
  })

  it('标签判定与谓词同一张表：已取消 / 已完成 / 超时结束 都指向同一个语义键', () => {
    expect(resolveOrderStatus(7, null, null).key).toBe('cancelled')
    expect(resolveOrderStatus(3, STORED, CLOSED).key).toBe('completed')
    expect(resolveOrderStatus(4, STORED, CLOSED).key).toBe('timeoutEnd')
    expect(resolveOrderStatus(2, STORED, null).key).toBe('stored')
  })
})

describe('订单谓词只有这一处实现', () => {
  const consumers = [
    'pages/order-list/order-list.ts',
    'pages/order-detail/order-detail.ts',
    'components/pickup-sheet/pickup-sheet.ts',
    'pages/waiting/waiting.ts',
  ] as const

  it('四个消费方都从 `utils/order-status.ts` 取谓词', () => {
    for (const path of consumers) {
      const code = stripComments(readFileSync(join(miniprogramDir, path), 'utf8'))
      expect(code, `${path} 没有引用共享谓词`).toMatch(/utils\/order-status/)
    }
  })

  it('消费方里不再出现「终局状态码链条」—— 那就是第二份实现', () => {
    const offenders: string[] = []
    for (const file of collect(miniprogramDir, ['.ts'])) {
      if (file.endsWith(join('utils', 'order-status.ts'))) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      // 5 / 6 只出现在共享谓词里；页面里出现 `status === 5 || status === 6` 这类链条
      // 就是又写了一遍「什么算结束」。
      if (/order\.status\s*===\s*[56]\b/.test(code)) offenders.push(relative(repoRoot, file))
    }
    expect(offenders, `这些文件自己判定了终局状态：${offenders.join(', ')}`).toEqual([])
  })
})
