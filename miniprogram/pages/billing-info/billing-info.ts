// **计费说明页** —— 内容由端点下发，界面只排版（issue #68 / spec #57 §10）。
//
// ## 本页只有三件事
//
// 1. **取一页内容**：`GET /contents/billing`（**免鉴权**）。登录链失败时
//    `failure-exit` 也能打开本页 —— 这是一条硬要求，所以请求走 `requestWithoutAuth`。
// 2. **按三种 block 排版**：`heading` → 小标题、`paragraph` → 正文段、`qa` → 问题 + 答案。
//    正文一个字都不进 `startup/copy.ts`，也不进 wxml 字面量 —— 服务端改内容，
//    客户端不需要发版。
// 3. **失败不白屏**：未知 key / 网络失败都落在页内「加载失败，请重试」+ 重试。
//
// ⚠️ **零缓存、零 storage**：正文属于「看到就必须是真的」那类数据，缓存说谎比空白更糟。
// 每次进入都重新请求；骨架屏只负责加载态的结构占位。
//
// ⚠️ **骨架 → 内容直接替换**：wxml 用互斥的 `wx:if / wx:elif / wx:else`，
// scss 里没有 transition / animation / opacity —— 不做淡入。

import { getContent } from '../../api/contents'
import type { ContentBlock } from '../../types/content'
import { LOAD_FAILED_DETAIL, PAGE_TITLES, RETRY_LABEL } from '../../startup/copy'

/** 内容页的三个相位 —— 与柜机页同一条「加载 / 内容 / 页内失败」口径。 */
type ContentPhase = 'loading' | 'ready' | 'loadFailed'

/**
 * 渲染行 —— 服务端 block 加上一个稳定的 `key`。
 *
 * ⚠️ `key` 不是服务端字段：`wx:for` 需要它，而内容块本身没有 id。
 * 内容一次替换、不重排，用数组下标足够；不要把下标写进业务语义。
 */
type ContentRow =
  | { key: number; type: 'heading'; text: string }
  | { key: number; type: 'paragraph'; text: string }
  | { key: number; type: 'qa'; question: string; answer: string }

/** 页面渲染模型 —— 每个字段都直接对应 wxml 里的一个绑定。 */
interface ContentPageData {
  title: string
  phase: ContentPhase
  blocks: ContentRow[]
  loadFailedDetail: string
  retryLabel: string
}

/** 页面实例的私有形状（`Component` 没有为页面私有字段提供官方位置）。 */
interface ContentPageInstance {
  data: ContentPageData
  setData(patch: Partial<ContentPageData>): void
}

/**
 * 把服务端 block 收敛成渲染行。
 *
 * ⚠️ 只认三种 `type`；其余值**丢弃而不是抛错**。类型层已经收窄到三种，
 * 但服务端是独立部署的 —— 多出一种 block 时，正确的降级是「这一块不显示」，
 * 而不是整页白屏。这条与 `icon` 组件「未知 key 不渲染、不抛错」是同一条取向。
 */
function toRows(blocks: readonly ContentBlock[]): ContentRow[] {
  const rows: ContentRow[] = []
  blocks.forEach((block, index) => {
    switch (block.type) {
      case 'heading':
        rows.push({ key: index, type: 'heading', text: block.text })
        return
      case 'paragraph':
        rows.push({ key: index, type: 'paragraph', text: block.text })
        return
      case 'qa':
        rows.push({ key: index, type: 'qa', question: block.question, answer: block.answer })
        return
      default:
        // 见函数注释：未知 block 静默丢弃，不把整页拖进失败态。
        return
    }
  })
  return rows
}

Component({
  data: {
    /**
     * 导航栏标题 —— 唯一的家是 `startup/copy.ts` 的 `PAGE_TITLES`。
     * ⚠️ **不用服务端响应里的 `title`**：spec §10 明确「导航栏标题用 PAGE_TITLES」，
     * 内容标题与页面标题是两层，不能让它们互相顶替。
     */
    title: PAGE_TITLES['pages/billing-info/billing-info'],
    phase: 'loading' as ContentPhase,
    blocks: [] as ContentRow[],
    loadFailedDetail: LOAD_FAILED_DETAIL,
    retryLabel: RETRY_LABEL,
  } as ContentPageData,

  lifetimes: {
    attached(): void {
      // 本页不接收页面参数：key 是固定的（计费页永远是 billing）。
      void this.loadContent()
    },
  },

  methods: {
    /**
     * 取内容并按结果落态。
     *
     * ⚠️ **不防抖**：GET 天然幂等，重试就是把同一条请求再发一次。
     * ⚠️ 失败时**清空 blocks**：不把旧内容留在屏幕上 —— 内容页没有「保留旧数据」这条口径，
     * 旧规则比空白更危险（用户会以为新规则就是这样）。
     */
    async loadContent(): Promise<void> {
      const page = this as unknown as ContentPageInstance
      page.setData({ phase: 'loading' })

      const result = await getContent('billing')
      if (!result.ok) {
        page.setData({ phase: 'loadFailed', blocks: [] })
        return
      }

      page.setData({ phase: 'ready', blocks: toRows(result.data.blocks) })
    },

    /** 页内重试 —— 重新取同一页内容。 */
    onRetryLoad(): void {
      void this.loadContent()
    },
  },
})
