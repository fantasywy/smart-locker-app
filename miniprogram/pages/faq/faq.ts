// **常见问题页** —— 内容由端点下发，界面只排版（issue #68 / spec #57 §10）。
//
// ## 与计费说明页共享的行为契约
//
//   1. 取 `GET /contents/faq`（**免鉴权**）：登录链失败时 `failure-exit` 也能打开本页。
//   2. 只排版三种 block：`heading` / `paragraph` / `qa`；正文不进 `startup/copy.ts`。
//   3. 未知 key / 网络失败 → 页内「加载失败，请重试」+ 重试，不白屏。
//
// ⚠️ 两个页面**不共享一份正文 / 不共享一份模板字面量**：它们各自只请求自己的 key，
// 正文完全由服务端决定（FAQ 的七个主题由后端内容维护，客户端不写死问题或答案）。
//
// ⚠️ **零缓存、零 storage**；骨架 → 内容直接替换，scss 里没有淡入 / 过渡。

import { getContent } from '../../api/contents'
import type { ContentBlock } from '../../types/content'
import { LOAD_FAILED_DETAIL, PAGE_TITLES, RETRY_LABEL } from '../../startup/copy'

/** 内容页的三个相位 —— 与计费说明页同一条口径。 */
type ContentPhase = 'loading' | 'ready' | 'loadFailed'

/**
 * 渲染行 —— 服务端 block 加上一个稳定的 `key`。
 *
 * ⚠️ `key` 不是服务端字段：`wx:for` 需要它，而内容块本身没有 id。
 * 内容一次替换、不重排，用数组下标足够。
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
 * ⚠️ 只认三种 `type`；其余值**丢弃而不是抛错**（理由同计费页：
 * 服务端独立部署，多一种 block 的正确降级是「这一块不显示」）。
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
        return
    }
  })
  return rows
}

Component({
  data: {
    /**
     * 导航栏标题 —— 唯一的家是 `startup/copy.ts` 的 `PAGE_TITLES`。
     * ⚠️ 不用服务端响应里的 `title`（spec §10：导航栏标题用 PAGE_TITLES）。
     */
    title: PAGE_TITLES['pages/faq/faq'],
    phase: 'loading' as ContentPhase,
    blocks: [] as ContentRow[],
    loadFailedDetail: LOAD_FAILED_DETAIL,
    retryLabel: RETRY_LABEL,
  } as ContentPageData,

  lifetimes: {
    attached(): void {
      // 本页不接收页面参数：key 是固定的（FAQ 页永远是 faq）。
      void this.loadContent()
    },
  },

  methods: {
    /**
     * 取内容并按结果落态。
     *
     * ⚠️ 不防抖：GET 天然幂等，重试就是把同一条请求再发一次。
     * ⚠️ 失败时清空 blocks：不把旧内容留在屏幕上 —— 旧规则 / 旧答案比空白更危险。
     */
    async loadContent(): Promise<void> {
      const page = this as unknown as ContentPageInstance
      page.setData({ phase: 'loading' })

      const result = await getContent('faq')
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
