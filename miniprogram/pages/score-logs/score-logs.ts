// **信用分明细页** —— 只读的分页列表：变动值 / 原因 / 时间（spec #57 §10）。
//
// ## 这一页只画三样东西
//
// 每行只有变动值（带正负号）、原因、时间。⚠️ **不展示**：
//   • `type`（AUTO / MANUAL）—— 内部归因；
//   • `operatorName` —— 内部员工名；
//   • 当前分数 —— 明细接口里根本没有它，页面也不从别处补。
// 类型层保留前两个字段（DTO 要如实反映契约），但页面的渲染模型只映射允许上屏的字段。
//
// ## 数据纪律
//
// 不做本地缓存、不读写 storage：信用分明细每次进入都从 `api/` 取。
// 分页每页 10 条，触底追加；重复 id 按 `id` 去重（后端越界会钳制到末页）。
//
// ⚠️ 中文文案全部来自 `startup/copy.ts`；本页不写用户可见字面量。

import { listScoreLogs } from '../../api/score-logs'
import type { ScoreLog } from '../../types/score'
import { EMPTY_STATES, PAGE_TITLES, SCORE_LOGS_COPY } from '../../startup/copy'
import { formatFullTime } from '../../utils/datetime'
import { showToast } from '../../utils/feedback'
import {
  appendPage,
  applyFirstPage,
  canLoadMore,
  createPagedList,
  nextPage,
} from '../../utils/pagination'
import type { PagedList } from '../../utils/pagination'

/** 每页条数 —— spec §10 逐字：每页 10。 */
const SCORE_LOGS_PAGE_SIZE = 10

/** 页面态 —— 首屏骨架 / 列表 / 页内失败。 */
type ScoreLogsPhase = 'loading' | 'ready' | 'failed'

/** 一行渲染模型 —— 只含允许上屏的字段，内部归因不进来。 */
interface ScoreLogRow {
  id: number
  /** 带符号的变动值：`−10` / `+5` / `0`。 */
  deltaText: string
  /** 色档语义键 —— 模板映射到 `danger` / `positive` / `neutral`。 */
  deltaTone: string
  reason: string
  /** `YYYY-MM-DD HH:mm`（全站完整时间格式）。 */
  time: string
}

interface ScoreLogsData {
  title: string
  phase: ScoreLogsPhase
  logs: ScoreLogRow[]
  /** 拉过且一条都没有 —— 与「还没拉」由 `phase` 区分。 */
  isEmpty: boolean
  /** 页内失败句 / 重试按钮 —— 全站共用文案。 */
  loadFailed: string
  retryLabel: string
  /** 空态只有标题 —— 说明与按钮**故意没有 data 字段**。 */
  emptyTitle: string
}

interface ScoreLogsInstance {
  data: ScoreLogsData
  setData(patch: Partial<ScoreLogsData>): void
}

/** 页面会话的私有运行时 —— 分页推进与并发守卫不进 `data`。 */
interface ScoreLogsRuntime {
  paged: PagedList<ScoreLog>
  loading: boolean
  /** 只为忽略迟到的旧响应（刷新会递增它）。 */
  requestSeq: number
  /** 触底返回的整页都是已知 id —— 再拉也不会增长，停止。 */
  exhausted: boolean
}

const runtimes = new WeakMap<ScoreLogsInstance, ScoreLogsRuntime>()

function runtimeOf(page: ScoreLogsInstance): ScoreLogsRuntime {
  let runtime = runtimes.get(page)
  if (runtime === undefined) {
    runtime = {
      paged: createPagedList<ScoreLog>(),
      loading: false,
      requestSeq: 0,
      exhausted: false,
    }
    runtimes.set(page, runtime)
  }
  return runtime
}

/** 按 id 去重 —— 分页越界会重复末页，重复行不能真的画两遍。 */
function uniqueById(items: readonly ScoreLog[]): ScoreLog[] {
  const seen = new Set<number>()
  const unique: ScoreLog[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    unique.push(item)
  }
  return unique
}

/**
 * 变动值的屏上写法 —— **必须带符号**。
 *
 * ⚠️ 负号是 `−`（U+2212），不是 ASCII 连字符：后者在数字旁更像分隔符。
 * 正数必须显式写 `+`，否则「5」会被读成当前分数而不是一次加分。
 * `0` 不带符号，色档也走中性。
 */
function deltaTextOf(delta: number): string {
  if (delta > 0) return `+${delta}`
  if (delta < 0) return `−${Math.abs(delta)}`
  return '0'
}

/** 变动值色档 —— 负数扣分 / 正数加分 / 零中性。 */
function deltaToneOf(delta: number): string {
  if (delta > 0) return 'positive'
  if (delta < 0) return 'danger'
  return 'neutral'
}

/** 一条 `13.16` 行 → 渲染模型；`type` / `operatorName` 刻意不搬。 */
function rowOf(item: ScoreLog): ScoreLogRow {
  return {
    id: item.id,
    deltaText: deltaTextOf(item.delta),
    deltaTone: deltaToneOf(item.delta),
    reason: item.reason,
    time: formatFullTime(item.createdAt),
  }
}

/** 把运行时状态刷到 `data` —— 所有成功路径共用这一处。 */
function render(page: ScoreLogsInstance): void {
  const runtime = runtimeOf(page)
  page.setData({
    phase: 'ready',
    logs: runtime.paged.items.map(rowOf),
    isEmpty: runtime.paged.loaded && runtime.paged.items.length === 0,
  })
}

/** 取第一页（首屏 / 刷新共用）—— **替换**已加载内容，不保留陈旧后续页。 */
async function loadFirst(page: ScoreLogsInstance): Promise<void> {
  const runtime = runtimeOf(page)
  const seq = runtime.requestSeq + 1
  runtime.requestSeq = seq
  runtime.loading = true
  if (!runtime.paged.loaded) page.setData({ phase: 'loading' })

  const result = await listScoreLogs(1, SCORE_LOGS_PAGE_SIZE)
  if (seq !== runtime.requestSeq) return
  runtime.loading = false

  if (!result.ok) {
    if (!runtime.paged.loaded) {
      page.setData({ phase: 'failed', logs: [], isEmpty: false })
    } else {
      // 已有内容时刷新失败：保留屏上的真实旧数据，只提示这一次刷新没成功。
      showToast(SCORE_LOGS_COPY.loadFailed)
    }
    return
  }

  runtime.paged = applyFirstPage({
    records: uniqueById(result.data.records),
    total: result.data.total,
  })
  runtime.exhausted = false
  render(page)
}

/** 触底加载下一页（只追加；重复 id 丢弃）。 */
async function loadMore(page: ScoreLogsInstance): Promise<void> {
  const runtime = runtimeOf(page)
  if (page.data.phase !== 'ready' || runtime.loading || runtime.exhausted) return
  if (!canLoadMore(runtime.paged)) return

  const seq = runtime.requestSeq
  runtime.loading = true
  const result = await listScoreLogs(nextPage(runtime.paged), SCORE_LOGS_PAGE_SIZE)
  if (seq !== runtime.requestSeq) return
  runtime.loading = false

  if (!result.ok) {
    // 追加失败不动已有列表 —— 用户还能继续看已经拿到的真实数据。
    showToast(SCORE_LOGS_COPY.loadFailed)
    return
  }

  const known = new Set(runtime.paged.items.map((item) => item.id))
  const records = result.data.records.filter((item) => !known.has(item.id))
  if (records.length === 0) {
    runtime.exhausted = true
    return
  }

  runtime.paged = appendPage(runtime.paged, { records, total: result.data.total })
  render(page)
}

interface ScoreLogsMethods {
  [name: string]: (...args: never[]) => unknown
  onShow(): void
  onReachBottom(): void
  onRetry(): void
}

Component<
  ScoreLogsData,
  Record<string, never>,
  ScoreLogsMethods,
  [],
  Record<string, never>,
  true
>({
  data: {
    title: PAGE_TITLES['pages/score-logs/score-logs'],
    phase: 'loading' as ScoreLogsPhase,
    logs: [],
    isEmpty: false,
    loadFailed: SCORE_LOGS_COPY.loadFailed,
    retryLabel: SCORE_LOGS_COPY.retry,
    emptyTitle: EMPTY_STATES.scoreLogs.title,
  } as ScoreLogsData,

  lifetimes: {
    attached(): void {
      // 有意为空 —— 页面没有需要订阅的外部状态。
    },
  },

  methods: {
    /** 每次回到前台静默刷新并重置回第一页（不保留陈旧后续页）。 */
    onShow(): void {
      const page = this as unknown as ScoreLogsInstance
      if (runtimeOf(page).loading) return
      void loadFirst(page)
    },

    /** 触底加载下一页（终止条件由 `utils/pagination.ts` 唯一决定）。 */
    onReachBottom(): void {
      const page = this as unknown as ScoreLogsInstance
      void loadMore(page)
    },

    /** 页内「重试」—— 首屏失败后的唯一动作。 */
    onRetry(): void {
      const page = this as unknown as ScoreLogsInstance
      if (page.data.phase !== 'failed') return
      void loadFirst(page)
    },
  },
})
