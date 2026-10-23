// **信用分明细页**的验收 —— ticket #71 / spec #57 §10。
//
// 断言只落在**外部行为**：页面 `data` 画了什么、发出了什么请求、失败后重试是否真的重发。
// 反馈适配层用 `vi.mock` 换掉 —— 本文件验的是「用户看到哪句话」，Vant 内部由
// `test/utils/feedback.test.ts` 负责。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWxStub, jsonResponse, networkFailure } from '../helpers/wx'
import { requestsTo, respondInOrder, sentRequests } from '../helpers/http'
import type { InstalledWxStub } from '../helpers/wx'
import { BASE_URL } from '../../miniprogram/request/config'
import { SCORE_LOGS_ENDPOINT } from '../../miniprogram/api/score-logs'
import { EMPTY_STATES, PAGE_TITLES, SCORE_LOGS_COPY } from '../../miniprogram/startup/copy'

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  confirm: vi.fn(),
  alert: vi.fn(),
}))

vi.mock('../../miniprogram/utils/feedback', () => ({
  showToast: mocks.showToast,
  confirm: mocks.confirm,
  alert: mocks.alert,
}))

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

/** 剥掉注释后的源码 —— 结构断言读它（注释里讨论不展示项是必要的）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const pageSource = (): string =>
  stripComments(
    readFileSync(join(repoRoot, 'miniprogram', 'pages', 'score-logs', 'score-logs.ts'), 'utf8'),
  )
const pageWxml = (): string =>
  stripComments(
    readFileSync(join(repoRoot, 'miniprogram', 'pages', 'score-logs', 'score-logs.wxml'), 'utf8'),
  )

/** 一份契约形状的 `13.16` 行。 */
function scoreLog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function listBody(
  items: readonly Record<string, unknown>[],
  total = items.length,
): ReturnType<typeof jsonResponse> {
  return jsonResponse({ code: 0, message: 'ok', data: { list: items, total } })
}

let definition: Record<string, unknown> | null = null

beforeEach(() => {
  definition = null
  mocks.showToast.mockReset()
  mocks.confirm.mockReset()
  mocks.alert.mockReset()
  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (def: Record<string, unknown>): void => {
    definition = def
  }
})

interface PageInstance {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  triggerEvent: (name: string) => void
  onShow?: () => void
  onReachBottom?: () => void
  onRetry?: () => void
  [name: string]: unknown
}

function instantiate(def: Record<string, unknown>): PageInstance {
  const instance = {
    data: { ...((def.data as Record<string, unknown>) ?? {}) },
    setData(patch: Record<string, unknown>): void {
      Object.assign(instance.data, patch)
    },
    triggerEvent(): void {},
  } as PageInstance
  for (const [name, fn] of Object.entries((def.methods as Record<string, unknown>) ?? {})) {
    instance[name] = (fn as (...args: unknown[]) => unknown).bind(instance)
  }
  return instance
}

async function loadPage(): Promise<Record<string, unknown>> {
  vi.resetModules()
  await import('../../miniprogram/pages/score-logs/score-logs')
  if (definition === null) throw new Error('score-logs.ts 没有调用 Component()')
  return definition
}

/** 让挂起的微任务链走完（读取 / 分页都是纯微任务驱动的）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 32; i += 1) await Promise.resolve()
}

async function mountPage(
  responses: Parameters<typeof respondInOrder>[0],
): Promise<{ wx: InstalledWxStub; page: PageInstance }> {
  const wx = installWxStub()
  wx.request.mockImplementation(respondInOrder(responses))
  const def = await loadPage()
  const page = instantiate(def)
  page.onShow?.()
  await settle()
  return { wx, page }
}

/** 指向 `13.16` 的请求。 */
function listRequests(wx: InstalledWxStub): ReturnType<typeof sentRequests> {
  return requestsTo(sentRequests(wx.request), `${BASE_URL}${SCORE_LOGS_ENDPOINT}?page=1&pageSize=10`)
}

interface ScoreLogRow {
  id: number
  deltaText: string
  deltaTone: string
  reason: string
  time: string
}

function rowsOf(page: PageInstance): ScoreLogRow[] {
  return (page.data.logs as ScoreLogRow[] | undefined) ?? []
}

describe('#71 信用分明细 · 行格式', () => {
  it('只画变动值（带符号）/ 原因 / 完整时间；负正零各有色档，内部字段不进渲染模型', async () => {
    const { page } = await mountPage([
      listBody([
        scoreLog({ id: 1, delta: -10, reason: '预约爽约', type: 1, operatorName: null }),
        scoreLog({
          id: 2,
          delta: 5,
          reason: '守约奖励',
          type: 2,
          operatorName: '员工甲',
          createdAt: '2026-09-21T08:05:00+08:00',
        }),
        scoreLog({ id: 3, delta: 0, reason: '系统调整', createdAt: '2025-12-31T23:59:00+08:00' }),
      ]),
    ])

    const rows = rowsOf(page)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      id: 1,
      deltaText: '−10',
      deltaTone: 'danger',
      reason: '预约爽约',
      time: '2026-09-22 15:04',
    })
    expect(rows[1]).toMatchObject({
      id: 2,
      deltaText: '+5',
      deltaTone: 'positive',
      reason: '守约奖励',
      time: '2026-09-21 08:05',
    })
    expect(rows[2]).toMatchObject({
      id: 3,
      deltaText: '0',
      deltaTone: 'neutral',
      reason: '系统调整',
      time: '2025-12-31 23:59',
    })

    // 内部归因 / 员工名 / 当前分数都不得进入渲染模型。
    for (const row of rows) {
      expect(row).not.toHaveProperty('type')
      expect(row).not.toHaveProperty('operatorName')
      expect(row).not.toHaveProperty('score')
    }
    expect(JSON.stringify(page.data)).not.toMatch(/AUTO|MANUAL|员工甲|operatorName/)
  })
})

describe('#71 信用分明细 · 失败与重试', () => {
  it('首屏失败 → 页内「加载失败，请重试」+ 重试真的重发', async () => {
    const { wx, page } = await mountPage([
      networkFailure(),
      listBody([scoreLog({ id: 1 })]),
    ])

    expect(page.data.phase).toBe('failed')
    expect(page.data.loadFailed).toBe(SCORE_LOGS_COPY.loadFailed)
    expect(page.data.retryLabel).toBe(SCORE_LOGS_COPY.retry)
    expect(pageWxml()).toContain('bindtap="onRetry"')

    page.onRetry?.()
    await settle()

    expect(page.data.phase).toBe('ready')
    expect(rowsOf(page)).toHaveLength(1)
    expect(listRequests(wx)).toHaveLength(2)
  })
})

describe('#71 信用分明细 · 分页', () => {
  it('每页 10 条、触底追加下一页；重复 id 去重', async () => {
    const firstPage = Array.from({ length: 10 }, (_, index) =>
      scoreLog({ id: 100 + index, reason: `记录 ${index}` }),
    )
    const { wx, page } = await mountPage([
      listBody(firstPage, 12),
      listBody([
        // 服务端越界钳制到末页时会重复已有 id —— 同一行不能画两遍。
        scoreLog({ id: 109, reason: '记录 9' }),
        scoreLog({ id: 110, reason: '记录 10' }),
        scoreLog({ id: 111, reason: '记录 11' }),
      ], 12),
    ])

    page.onReachBottom?.()
    await settle()

    const urls = sentRequests(wx.request).map((request) => request.url)
    expect(urls).toEqual([
      `${BASE_URL}${SCORE_LOGS_ENDPOINT}?page=1&pageSize=10`,
      `${BASE_URL}${SCORE_LOGS_ENDPOINT}?page=2&pageSize=10`,
    ])
    expect(rowsOf(page)).toHaveLength(12)
    expect(new Set(rowsOf(page).map((row) => row.id)).size).toBe(12)
  })

  it('追加页失败 → 保留已加载行，轻提示一句话（不把列表清空）', async () => {
    const firstPage = Array.from({ length: 10 }, (_, index) => scoreLog({ id: 100 + index }))
    const { page } = await mountPage([listBody(firstPage, 12), networkFailure()])

    page.onReachBottom?.()
    await settle()

    expect(rowsOf(page)).toHaveLength(10)
    expect(mocks.showToast).toHaveBeenCalledWith(SCORE_LOGS_COPY.loadFailed)
  })
})

describe('#71 信用分明细 · 工程约束', () => {
  it('标题来自 copy、二级页有返回箭头、零 storage、零路径字面量', async () => {
    const pageDef = await loadPage()
    expect((pageDef.data as Record<string, unknown>).title).toBe(
      PAGE_TITLES['pages/score-logs/score-logs'],
    )
    expect(pageWxml()).toMatch(/<navigation-bar[^>]*back="\{\{true\}\}"/)

    const source = pageSource()
    expect(source).not.toMatch(/getStorageSync|setStorageSync|removeStorageSync|getStorage/)
    expect(source).not.toMatch(/url:\s*['"`]\/?pages\//)
  })

  it('变动值色档走 token：负 danger-ink / 正 primary-active / 零中性；无动效', () => {
    const scss = stripComments(
      readFileSync(
        join(repoRoot, 'miniprogram', 'pages', 'score-logs', 'score-logs.scss'),
        'utf8',
      ),
    )

    expect(scss).toMatch(/\.score-logs__delta\.is-danger\s*\{[^}]*color:\s*v\.\$color-danger-ink/s)
    expect(scss).toMatch(
      /\.score-logs__delta\.is-positive\s*\{[^}]*color:\s*v\.\$color-primary-active/s,
    )
    expect(scss).toMatch(/\.score-logs__delta\.is-neutral\s*\{[^}]*color:\s*v\.\$color-text-main/s)
    // 骨架 → 内容直接替换：本页样式零 transition / animation。
    expect(scss).not.toMatch(/transition|animation|@keyframes/)
    // 不写裸 hex。
    expect(scss).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })

  it('内部字段不参与渲染：页面源码不读 type / operatorName / 当前分数', () => {
    const source = pageSource()
    expect(source).not.toMatch(/operatorName/)
    expect(source).not.toMatch(/\.type\b/)
    expect(source).not.toMatch(/\.score\b/)
  })
})

describe('#71 信用分明细 · 空态', () => {
  it('空列表 → 复用空态标题；**没有**说明与按钮', async () => {
    const { page } = await mountPage([listBody([], 0)])

    expect(page.data.isEmpty).toBe(true)
    expect(page.data.emptyTitle).toBe(EMPTY_STATES.scoreLogs.title)
    expect(page.data).not.toHaveProperty('emptyHint')
    expect(page.data).not.toHaveProperty('emptyActionLabel')

    const wxml = pageWxml()
    expect(wxml).toContain('<empty-state')
    expect(wxml).toMatch(/<empty-state[^>]*title="\{\{ emptyTitle \}\}"/)
    // 说明句与按钮的入参都不传 —— 空态只有标题。
    expect(wxml).not.toMatch(/hint=|action-label=/)
  })
})
