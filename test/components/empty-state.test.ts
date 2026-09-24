// **空态**的两条断言：文案逐字（`09` §7.1）+ 组件不自己跳转。
//
// 出处：`docs/spec/09-copy-and-status.md` §7.1（三个空态**逐字**）；
// `docs/spec/03-order-list.md` §9（订单列表「一个空态」）、
// `docs/spec/05-reservation.md` §2（预约空态出口**只能是扫码**）、
// `docs/spec/04-blacklist-and-degradation.md` §7.3（信用分明细）。
//
// ⚠️ 本票的裁决是「**做成参数化组件**」（三处差异全是数据，结构只有一条），
// 理由逐条写在 `empty-state.ts` 的文件头。下面第一条用例就是那个裁决的判据：
// 三个空态的**结构槽位相同**，只有取值不同。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EMPTY_STATES } from '../../miniprogram/startup/copy'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const emptyStateDir = join(repoRoot, 'miniprogram', 'components', 'empty-state')

/** 剥掉注释后的源码 —— 结构断言读它（注释里出现关键词是必要的说明，不算违规）。 */
function stripped(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('#23 空态：三处共用一条结构（本票的裁决）', () => {
  it('⚠️ 三个空态的**槽位相同** —— 只有取值不同，没有一处需要别的排布', () => {
    // 这就是「做成参数化组件」的全部理由（也是「不能做成三份」的判据）：
    // 三个对象的键**逐字相同**。若哪天空态需要第四个元素（比如一个图标、一行小字链接），
    // 这条会红 —— 那时才该重新审视「一个组件够不够」，而不是现在预防性地留口子。
    const keys = Object.values(EMPTY_STATES).map((state) => Object.keys(state).sort())
    expect(keys[0]).toEqual(['actionLabel', 'hint', 'title'])
    expect(keys[1]).toEqual(keys[0])
    expect(keys[2]).toEqual(keys[0])
  })

  it('⚠️ 三个空态的文案与 09 §7.1 逐字一致', () => {
    // `09` §7.1 那三行是逐字引用（订单与预约两处标「提案」但已成定稿，
    // 信用分明细标「提案」—— 三句都改词须过 `09` §5 的流程）。
    expect(EMPTY_STATES.orders.title).toBe('还没有订单')
    expect(EMPTY_STATES.orders.hint).toBe('扫码存件，把东西放进柜子')
    expect(EMPTY_STATES.orders.actionLabel).toBe('扫码存件')

    expect(EMPTY_STATES.reservations.title).toBe('还没有预约')
    expect(EMPTY_STATES.reservations.hint).toBe('到柜机前扫码后可以预约使用时段')
    expect(EMPTY_STATES.reservations.actionLabel).toBe('扫码存件')

    expect(EMPTY_STATES.scoreLogs.title).toBe('还没有分数变动')
  })

  it('⚠️ 信用分明细的空态**只有标题** —— 别为了凑齐两行编一句话', () => {
    // `09` §7.1 那一行确实只有标题（`04` §7.3 未定文案，且信用分明细**确无动作可做**）。
    // 空 `hint` / 空 `actionLabel` 是**有意的缺省**，不是漏填。
    expect(EMPTY_STATES.scoreLogs.hint).toBe('')
    expect(EMPTY_STATES.scoreLogs.actionLabel).toBe('')
  })

  it('⚠️ 两个主行动是**同一个动作**（订单与预约都走扫码）', () => {
    // `09` §5.6 规则 7：同一个动作在全局只能有一个名字。
    // ⚠️ 预约空态**不是**「新建预约」—— `05` §2 已裁决创建入口只在柜机页
    // （`lockerId` 的唯一来源是扫码），所以空态的出口只能是扫码。
    expect(EMPTY_STATES.reservations.actionLabel).toBe(EMPTY_STATES.orders.actionLabel)
    expect(EMPTY_STATES.reservations.actionLabel).not.toContain('新建')
    expect(EMPTY_STATES.reservations.actionLabel).not.toContain('预约')
  })
})

describe('#23 空态组件：不持有文案、不自己跳转', () => {
  it('⚠️ 组件里没有任何文案字面量 —— 用户可见的每个字归文案层（09 §0 硬规则 1）', () => {
    // 三个空态的文案全部由调用方从 `startup/copy.ts` 传进来。
    // 判据：wxml 里不得出现连续的中文（`{{ }}` 插值不算字面量）。
    const wxml = stripped(join(emptyStateDir, 'empty-state.wxml'))
    const chinese = wxml.match(/[\u4e00-\u9fa5]+/g) ?? []
    expect(chinese, `wxml 里出现了写死的中文：${chinese.join('、')}`).toEqual([])
  })

  it('⚠️ 组件**不自己跳转** —— 主行动只 triggerEvent，路径归页面', () => {
    // 与 `navigation-bar.home()` 的选择**刚好相反**，理由也刚好相反（见 empty-state.ts 裁决 2）：
    // `home()` 的目标唯一（订单 tab），组件可以自己完成；
    // 而空态的动作要跳**别的页面**，且柜机页还认一个 `code` 参数（`01` §6）——
    // 组件不知道当前页面栈，替调用方决定就是替它编一个它没说的东西。
    const ts = stripped(join(emptyStateDir, 'empty-state.ts'))
    for (const banned of ['wx.scanCode', 'wx.navigateTo', 'wx.switchTab', 'wx.redirectTo']) {
      expect(ts, `空态组件里出现了 ${banned} —— 跳转归页面`).not.toContain(banned)
    }
    expect(ts).toContain('triggerEvent')
  })

  it('⚠️ `title` 是**必填**属性 —— 没有默认值（缺省会让「忘了传」静默渲染）', () => {
    // 三个空态的标题互不相同 ⇒ 任何默认值在其中两处都是错的。
    // 没有 `value` 默认值 = 忘了传时属性是 undefined，屏上一片空白 —— 立刻可见。
    const ts = stripped(join(emptyStateDir, 'empty-state.ts'))
    const titleBlock = /title:\s*\{[^}]*\}/.exec(ts)?.[0] ?? ''
    expect(titleBlock, '没找到 title 属性声明').not.toBe('')
    expect(titleBlock, 'title 不该有默认值').not.toContain('value')
  })
})

describe('#23 空态的视觉约束（10 §6 / §7.2 —— review 补的守卫）', () => {
  it('⚠️ 不写裸 hex（10 §6 禁令 5）', () => {
    const scss = stripped(join(emptyStateDir, 'empty-state.scss'))
    const hexes = scss.match(/#[0-9a-f]{3,8}\b/gi) ?? []
    expect(hexes, `出现了裸 hex：${hexes.join(', ')} —— 一律引 styles/ 的 token`).toEqual([])
  })

  it('⚠️⚠️ **布局几何用 `rpx`，不写裸 `px`**（10 §7.2）', () => {
    // ⛔ 这条是本票 review 抓出来的**真违规**，而它此前**没有任何守卫**：
    // `scripts/verify-visual-tokens.mjs` 的 68 条断言里一条都不查 px/rpx，
    // 于是「布局几何用 rpx」这条 §7.2 的硬裁决在代码里是**裸奔**的 ——
    // 第一版写了 `padding: 96px` 与 `line-height: 2.5`（≈35px，比 44px 的可点目标下限还小），
    // 全绿通过。
    //
    // ⇒ 判据：`.empty-state` 的几何声明（padding / margin / height / width / line-height）
    //    不得直接写 `px`。⚠️ 字号走 `v.$font-size-*`（那些 token 本身是 px，
    //    属 §7.2「字号用 px」那一半），所以这条只查几何属性，不查 font-size。
    const scss = stripped(join(emptyStateDir, 'empty-state.scss'))
    const offenders: string[] = []
    for (const line of scss.split('\n')) {
      // 只挑几何属性；`font-size` 不在其中（字号按 §7.2 就该是 px 系的 token）。
      if (!/^\s*(padding|margin|height|width|line-height|top|left|right|bottom)[\w-]*\s*:/.test(line)) {
        continue
      }
      const px = line.match(/\b\d+(\.\d+)?px\b/g) ?? []
      if (px.length > 0) offenders.push(`${line.trim()}  → ${px.join(', ')}`)
    }
    expect(
      offenders,
      `以下布局几何写了 px —— 10 §7.2 要求布局几何用 rpx（字号与 1px 细节才用 px）：\n` +
        offenders.map((f) => `  • ${f}`).join('\n'),
    ).toEqual([])
  })

  it('⚠️ 主行动的按下态用 `$color-primary-hover`，不是 `-active`（10 §3.1）', () => {
    // `_variables.scss` 给这两个 token 分了不同语义：`-hover` 是**按下态**，
    // `-active` 是「正常/激活档」，后者同时是绿色文字的 ink 与「白字压绿底」的底色。
    // 拿 ink 当按下态的底色是两回事，且会与 `failure-exit__retry` 的按下态**分叉**。
    const scss = stripped(join(emptyStateDir, 'empty-state.scss'))
    const activeBlock = /\.empty-state__action_active\s*\{([^}]*)\}/.exec(scss)?.[1] ?? ''
    expect(activeBlock, '没找到 __action_active 的规则体').not.toBe('')
    expect(activeBlock).toContain('$color-primary-hover')
    expect(activeBlock, '按下态用了 -active（那是 ink / 激活档，不是按下态）').not.toContain(
      '$color-primary-active',
    )
  })

  it('⚠️ 主行动的可点目标 ≥ 44px（10 §7.2「可点目标下限更严」）', () => {
    // 88rpx @375pt ≈ 44px，与 `failure-exit__retry` 的 `height: 44px` 对齐 ——
    // 两个都是页面级主按钮，尺寸不一致会让两屏看起来像两个人做的。
    const scss = stripped(join(emptyStateDir, 'empty-state.scss'))
    const actionBlock = /\.empty-state__action\s*\{([\s\S]*?)\n\}/.exec(scss)?.[1] ?? ''
    expect(actionBlock, '没找到 __action 的规则体').not.toBe('')
    expect(actionBlock).toMatch(/height:\s*88rpx/)
  })
})
