// **列表分页尾部**的行为测试 —— issue #23 的 Acceptance criteria 逐字：
//
//   「分页终止条件 = 已加载条数 ≥ `total`，**有空数组不终止的反例测试**」
//
// ⚠️ 本文件的核心不是「正常翻页能翻」，而是**把那个错误写法钉死在红灯上**。
// 「上一页返回空数组就停」这个直觉写法在本后端**永远不成立**：`03` §1.9 逐字 ——
// 分页越界**钳制到末页**，「请求越界页返回空列表」**不会发生**。
// ⇒ 按空数组判断的实现会**无限重复末页**。
//
// 出处：`docs/spec/03-order-list.md` §1.9 + §7、`docs/spec/05-reservation.md` §6.3、
// `docs/spec/04-blacklist-and-degradation.md` §7.3。
//
// ⚠️ 本文件一个 `wx.*` 桩都不用 —— `utils/pagination.ts` 是纯函数。

import { describe, expect, it } from 'vitest'
import {
  appendPage,
  applyFirstPage,
  canLoadMore,
  createPagedList,
  nextPage,
  PAGE_SIZE,
  type PageOf,
} from '../../miniprogram/utils/pagination'

/** 造一页响应。默认 `total` 就是本页条数 —— 单页到底。 */
function pageOf(records: string[], total = records.length): PageOf<string> {
  return { records, total }
}

/** 造 `count` 条递增的假数据。 */
function records(count: number, offset = 0): string[] {
  return Array.from({ length: count }, (_, index) => `row-${offset + index}`)
}

describe('#23 首屏：pageSize = 20，status 不传（03 §7 / 05 §6.3 / 04 §7.3）', () => {
  it('⚠️ PAGE_SIZE 是 20 —— 三份 spec 逐字一致，且它是**服务端缺省**', () => {
    // 03 §7 那一行原文：「`pageSize = 20`（**服务端缺省**），`status` 不传（全部）」。
    // 这不是我们挑的一个数，是契约事实的登记 —— 改它要同时改三份 spec。
    expect(PAGE_SIZE).toBe(20)
  })

  it('首屏把第一页**整体装进**列表，并记下 total', () => {
    const state = applyFirstPage(pageOf(records(PAGE_SIZE), 45))
    expect(state.items).toHaveLength(PAGE_SIZE)
    expect(state.total).toBe(45)
    expect(state.loaded).toBe(true)
  })

  it('首屏之前：列表是空的、`loaded` 为 false、不能上拉', () => {
    const state = createPagedList<string>()
    expect(state.items).toEqual([])
    expect(state.loaded).toBe(false)
    // ⚠️ 首屏还没回来时上拉必须被忽略（见 canLoadMore 的说明）。
    expect(canLoadMore(state)).toBe(false)
  })

  it('⚠️ 「还没拉过」与「拉过但一条都没有」是两回事 —— 前者骨架屏，后者空态（09 §7.1）', () => {
    // 两者的 `total` **都是 0**，只有 `loaded` 分得开。这正是这个字段存在的理由：
    // 骨架屏（纯图形、无文字）与空态（一句说明 + 主行动）是两张完全不同的画面。
    const notLoadedYet = createPagedList<string>()
    const loadedButEmpty = applyFirstPage(pageOf([], 0))
    expect(notLoadedYet.total).toBe(loadedButEmpty.total)
    expect(notLoadedYet.loaded).not.toBe(loadedButEmpty.loaded)
    // 只有「拉过且为空」才该走空态。
    expect(loadedButEmpty.loaded).toBe(true)
    expect(loadedButEmpty.items).toEqual([])
  })
})

describe('#23 终止条件 = 已加载条数 ≥ total（三处 spec 唯一判据）', () => {
  it('装满了 total 就到底了', () => {
    const state = applyFirstPage(pageOf(records(20), 20))
    expect(canLoadMore(state)).toBe(false)
  })

  it('还有剩余就能继续拉', () => {
    const state = applyFirstPage(pageOf(records(20), 45))
    expect(canLoadMore(state)).toBe(true)
  })

  it('⚠️⚠️ 反例：**末页返回的是非空数组**（后端钳制到末页），仍然必须终止', () => {
    // ⛔ 这是本文件存在的理由。若把判据写成「上一页返回空数组就停」，
    // 下面这条用例会**红** —— 因为后端**根本不会**返回空数组（03 §1.9 逐字）：
    //
    //   「分页越界钳制到末页（PageSupport，缺省 pageSize = 20、上限 100）
    //    ——『请求越界页返回空列表』**不会发生**」
    //
    // 于是按空数组判断的实现：第 3 次上拉请求 `page=3` → 后端**再次**返回末页那 5 条
    // → 不是空数组 → 判定「还有更多」→ 再接一遍 → **无限重复末页**。
    // 用户看到的是同一页数据被一遍遍接在列表后面。
    let state = applyFirstPage(pageOf(records(20, 0), 45))
    state = appendPage(state, pageOf(records(20, 20), 45))
    // 第二页之后还剩 5 条。
    expect(state.items).toHaveLength(40)
    expect(canLoadMore(state)).toBe(true)

    // 第三页：末页只有 5 条（不足 pageSize）。
    state = appendPage(state, pageOf(records(5, 40), 45))
    expect(state.items).toHaveLength(45)
    // ⚠️ 判据是 `45 >= 45` ⇒ 停。**不是**「这页空不空」—— 它非空（5 条）。
    expect(canLoadMore(state)).toBe(false)
  })

  it('⚠️⚠️ 反例：越界请求**重复返回末页**，也不会让列表重新「有更多」', () => {
    // 上面那条的续集：即使有人手滑真的越界拉了一次（后端又回了同样 5 条），
    // `applyPage` 之后 `items.length` 会超过 `total` —— 判据仍是 `≥`，
    // 所以**依然终止**。写成 `=== total` 的实现在这里会翻成 `true`（45+5 ≠ 45 也不 ≥……），
    // 于是又开始无限拉。
    let state = applyFirstPage(pageOf(records(20, 0), 21))
    state = appendPage(state, pageOf(records(1, 20), 21))
    expect(canLoadMore(state)).toBe(false)

    // 越界：后端钳制到末页，重复返回同一页的最后 1 条。
    state = appendPage(state, pageOf(records(1, 20), 21))
    expect(state.items).toHaveLength(22)
    // ⚠️ 必须是 `≥` 而不是 `===`：多出来的那条不会把列表翻回「还能拉」。
    expect(canLoadMore(state)).toBe(false)
  })

  it('⚠️ `total` 取**最新响应**的值 —— 总数变大了不该提前停住', () => {
    // total 会随状态推进而变（新单进来）。若推进逻辑把第一次的 total 存死，
    // 用户会看到列表「就是这些了」，其实服务端还有 —— 而他没有任何办法发现。
    let state = applyFirstPage(pageOf(records(20, 0), 20))
    expect(canLoadMore(state)).toBe(false) // 当时确实到底了
    // 期间用户又下了一单 —— 下一次刷新的响应里 total 变成 21。
    state = applyFirstPage(pageOf(records(20, 0), 21))
    expect(state.total).toBe(21)
    expect(canLoadMore(state)).toBe(true)
  })
})

describe('#23 刷新是**重置**不是增量（03 §7 的 onShow / 下拉刷新）', () => {
  it('⚠️ 刷新**丢弃已加载的后续页** —— 保留陈旧后续页等于让列表撒谎', () => {
    // 03 §7 逐字：「`onShow`：**静默刷新并重置回第一页**（丢弃已加载的后续页）」；
    // 理由那条也逐字：「在途单的状态会在翻页之间变，保留陈旧后续页等于让列表撒谎」。
    let state = applyFirstPage(pageOf(records(20, 0), 45))
    state = appendPage(state, pageOf(records(20, 20), 45))
    expect(state.items).toHaveLength(40)

    // onShow / 下拉刷新 —— 拿回来的第一页**替换**全部内容，不是接在后面。
    state = applyFirstPage(pageOf(records(20, 100), 45))
    expect(state.items).toHaveLength(20)
    expect(state.items[0]).toBe('row-100')
    // 旧的第 21–40 条一个都不在了（它们的顺序与状态都可能已经过期）。
    expect(state.items).not.toContain('row-20')
  })

  it('⚠️ 重置之后页码跟着回到第 2 页（由长度推导，没有「忘了归零」这个状态）', () => {
    // 「第几页」不另存字段（见 PagedList 的说明）：它由 items.length 推出来。
    // 于是「刷新了但页码没归零」这个 bug 在结构上写不出来。
    let state = applyFirstPage(pageOf(records(20, 0), 100))
    state = appendPage(state, pageOf(records(20, 20), 100))
    expect(nextPage(state)).toBe(3)
    state = applyFirstPage(pageOf(records(20, 0), 100))
    expect(nextPage(state)).toBe(2)
  })
})

describe('#23 页码推导（服务端页码从 1 开始）', () => {
  it('⚠️ 初态 `page = 0` → `nextPage` 给出 **1** —— 首屏要的就是第 1 页', () => {
    // 若初态写成 1，首屏就会去拉第 2 页，而第 1 页**永远不会被加载**。
    const initial = createPagedList<string>()
    expect(initial.page).toBe(0)
    expect(nextPage(initial)).toBe(1)
  })

  it('装了 20 条 → 下一页是 2', () => {
    expect(nextPage(applyFirstPage(pageOf(records(20), 100)))).toBe(2)
  })

  it('⚠️⚠️ 末页**不满**时，`nextPage` 不得回退到已经拉过的那一页', () => {
    // ⛔ 这是本文件第二个「错写法必红」的用例，抓的是**推导式**缺陷：
    // 由长度反推页码（`floor(len / PAGE_SIZE) + 1`）在末页不满时会算出 **3** ——
    // 而第 3 页刚刚才拉过（返回了那 5 条）。于是末页会被一遍遍接上去：
    // 与「按空数组判断」**同一个症状，不同的成因**。
    //
    // 20 + 20 + 5 = 45 条装完，实际拉了三页（1/2/3），下一页是 4。
    let state = applyFirstPage(pageOf(records(20, 0), 45))
    expect(nextPage(state)).toBe(2)
    state = appendPage(state, pageOf(records(20, 20), 45))
    expect(nextPage(state)).toBe(3)
    state = appendPage(state, pageOf(records(5, 40), 45))
    // ⚠️ 长度推导会给出 `floor(45/20)+1 = 3`（重复第 3 页）；正确值是 4。
    expect(nextPage(state)).toBe(4)
  })

  it('⚠️ 刷新之后页码**跟着回到第 2 页** —— 重置必须同时归位内容与页码', () => {
    let state = applyFirstPage(pageOf(records(20, 0), 100))
    state = appendPage(state, pageOf(records(20, 20), 100))
    expect(nextPage(state)).toBe(3)

    state = applyFirstPage(pageOf(records(20, 0), 100))
    // ⚠️ 只清 `items` 而不归页码的后果：下一次上拉去请求第 3 页 ——
    // 而列表里只有第 1 页，**第 2 页整段凭空消失**。
    expect(state.page).toBe(1)
    expect(nextPage(state)).toBe(2)
  })
})
