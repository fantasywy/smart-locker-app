// **时间格式化**的行为测试 —— issue #23 的 Acceptance criteria 之一：
// 「日期格式化模块覆盖全部格式，**有 Vitest 断言**（纯函数，不需桩）」。
//
// ⚠️ **本文件一个 `wx.*` 桩都不用** —— 那本身就是一条断言：`utils/datetime.ts`
// 是纯函数（`utils/` 的定位）。哪天有人往它里面塞了一个 `wx.` 调用，
// 这里的用例会立刻因为「未编排即失败」而红 —— 而不是等到真机上才发现。
// ⚠️ 期望值一律**照抄定稿的示例列**（`04-01 09:00` / `2026-04-01 11:30` /
// `09-23 14:00 – 16:00` ……），不是「看着像就行」。示例就是判据。

import { describe, expect, it } from 'vitest'
import {
  formatFullTime,
  formatNotYetStored,
  formatOrderTime,
  formatOrderTimeInProgress,
  formatReservationRange,
  formatRestrictionSince,
} from '../../miniprogram/utils/datetime'

/** 服务端回显的形态：带 `+08:00`（已实测）。 */
const SERVER_INSTANT = '2026-04-01T09:00:00+08:00'

/** 固定的「现在」—— 三档写法里「今天」的参照系，显式传入，不由模块读时钟。 */
const NOW = new Date('2026-10-23T12:00:00+08:00')

describe('#23 时间写法', () => {
  it('①全站三档（§14.3）：当天「今天 HH:mm」/ 当年 `MM-DD HH:mm` / 跨年 `YYYY-MM-DD HH:mm`', () => {
    // 契约逐字：「当天「今天 HH:mm」、当年 `MM-DD HH:mm`、跨年 `YYYY-MM-DD HH:mm`；
    // 不使用相对时间。」
    expect(formatOrderTime('2026-10-23T09:05:00+08:00', NOW)).toBe('今天 09:05')
    expect(formatOrderTime('2026-04-01T09:00:00+08:00', NOW)).toBe('04-01 09:00')
    expect(formatOrderTime('2025-04-01T09:00:00+08:00', NOW)).toBe('2025-04-01 09:00')
  })

  it('①三档是**同一个函数**的分支 —— 订单列表 / 详情 / 首页卡都走它，不许各写一套', () => {
    // 判据：带「存入」前缀的写法逐字等于「前缀 + 三档选择器的输出」。
    // 任何「列表一个写法、详情另一个写法」的分叉都会在这条上现形。
    for (const instant of [
      '2026-10-23T09:05:00+08:00',
      '2026-04-01T09:00:00+08:00',
      '2025-04-01T09:00:00+08:00',
    ]) {
      expect(formatOrderTimeInProgress(instant, NOW)).toBe(`存入 ${formatOrderTime(instant, NOW)}`)
    }
  })

  it('②订单列表 · 在途 → 前缀「存入」+ 三档写法', () => {
    // 前缀里的「存入」是 GLOSSARY.md 的 canonical 术语（不许说「寄件」/「寄存」）。
    expect(formatOrderTimeInProgress(SERVER_INSTANT, NOW)).toBe('存入 04-01 09:00')
    expect(formatOrderTimeInProgress('2026-10-23T09:05:00+08:00', NOW)).toBe('存入 今天 09:05')
    expect(formatOrderTimeInProgress(SERVER_INSTANT, NOW).startsWith('存入 ')).toBe(true)
  })

  it('③订单列表 · 未存入 → 留空，改放引导句「关好柜门才算存入」', () => {
    expect(formatNotYetStored()).toBe('关好柜门才算存入')
    // ⚠️ 它**一个时刻都不给** —— 这一条的口径就是「留空」。
    // 一个「近似时刻」在这里比空白更糟：它会看起来像个真的截止时间。
    expect(formatNotYetStored()).not.toMatch(/\d/)
    // ⚠️ 不得断言「门还没关」（核对接不到新事实不代表门没关）。
    expect(formatNotYetStored()).not.toContain('门还没关')
  })

  it('④详情时间轴 / 支付记录 / 信用分明细 / 受限卡 → `YYYY-MM-DD HH:mm`（补全年份）', () => {
    // 示例逐字：`2026-04-01 11:30`。
    expect(formatFullTime('2026-04-01T11:30:00+08:00')).toBe('2026-04-01 11:30')
    // 信用分明细示例逐字：`2026-09-22 15:04`。
    expect(formatFullTime('2026-09-22T15:04:00+08:00')).toBe('2026-09-22 15:04')
    // ⚠️ 与 ① 的分界是**用途**（回查 vs 列表），不是「哪一页」：
    // 回查用途的位置无条件补全年份，列表 / 卡片走三档。
    expect(formatFullTime(SERVER_INSTANT).startsWith('2026-04-01 09:00')).toBe(true)
  })

  it('⑤预约列表副行 → `MM-DD HH:mm – HH:mm`，**同日**', () => {
    // 示例逐字：`09-23 14:00 – 16:00`。
    expect(formatReservationRange('2026-09-23T14:00:00+08:00', '2026-09-23T16:00:00+08:00')).toBe(
      '09-23 14:00 – 16:00',
    )
  })

  it('⑤预约列表副行 → **跨天时段重复日期**', () => {
    // 示例逐字：跨天 `09-23 23:00 – 09-24 01:00`。
    // ⚠️ 不得写成 `09-23 23:00 – 01:00` —— 那样读起来像一个已经过去的时刻，
    // 而它其实是第二天凌晨。
    expect(formatReservationRange('2026-09-23T23:00:00+08:00', '2026-09-24T01:00:00+08:00')).toBe(
      '09-23 23:00 – 09-24 01:00',
    )
  })

  it('⑤分隔符是 en dash 且两侧各一个空格', () => {
    const range = formatReservationRange('2026-09-23T14:00:00+08:00', '2026-09-23T16:00:00+08:00')
    // ⚠️ `–`（U+2013）不是 ASCII `-`：日期里的连字符与分隔符必须一眼可分。
    expect(range).toContain(' – ')
    expect(range).not.toContain(' - ')
  })

  it('⑥受限卡 → 「自 YYYY-MM-DD HH:mm 起」', () => {
    // spec #57 §9 定稿逐字：「自 {createdAt} 起」→「自 2026-09-22 15:04 起」。
    expect(formatRestrictionSince('2026-09-22T15:04:00+08:00')).toBe('自 2026-09-22 15:04 起')
  })
})

describe('#67 「今天」的判定口径', () => {
  it('「今天」按服务端时刻的东八区日期判定，不受运行设备时区影响', () => {
    expect(formatOrderTime('2026-10-23T00:30:00+08:00', NOW)).toBe('今天 00:30')
    expect(formatOrderTime('2026-10-22T23:30:00+08:00', NOW)).toBe('10-22 23:30')
  })

  it('解析不出时返回空串，不编一个时刻出来', () => {
    expect(formatOrderTime('', NOW)).toBe('')
    expect(formatOrderTime('not-a-date', NOW)).toBe('')
    expect(formatOrderTime('2026-10-23T09:05:00+08:00', new Date(Number.NaN))).toBe('')
  })
})

describe('#23 时区硬规则：只用服务端回显的值，不用客户端本地时钟重算', () => {
  it('⚠️ 服务端说几点，屏上就是几点 —— 与运行设备的时区无关', () => {
    // 附注逐字：「展示的是**服务端回显**的时刻（响应带 `+08:00`）。
    // **不得**用客户端本地时钟重新格式化出另一个值 —— 那是双源真相。」
    //
    // ⚠️ 这条用例的**判据**正是「入参是字符串、输出是字符串」：本模块从头到尾
    // 不构造 `Date`。若哪天有人把实现改成 `new Date(instant).getHours()`，
    // 那么在非东八区的运行环境（CI、或用户改了手机时区）下这里会**当场变红**。
    //
    // 三个不同的偏移，同一个字面时刻 —— 屏上必须是同一个值。
    // ⚠️ 这里刻意**不断言**「带 `+08:00` 才显示」：契约响应带 `+08:00`，
    // 但格式化层不该去校验偏移 —— 它只负责把服务端给的那段字面数字搬上屏。
    const asServerEchoed = '2026-04-01T09:00:00+08:00'
    expect(formatOrderTime(asServerEchoed, NOW)).toBe('04-01 09:00')
    // 同一段日期时刻、不同偏移后缀 → 仍是同一个显示值（本模块不读偏移）。
    expect(formatOrderTime('2026-04-01T09:00:00Z', NOW)).toBe('04-01 09:00')
    expect(formatOrderTime('2026-04-01T09:00:00-05:00', NOW)).toBe('04-01 09:00')
  })

  it('⚠️ 本模块不提供任何**隐式**「取当前时间」的入口 —— 双源真话在类型上就写不出来', () => {
    // 落地方式不是「记得别这么写」，而是**根本不给这个能力**（见 datetime.ts 文件头规则 1）。
    // 判据取模块的导出清单：多出一个 `formatNow` / `now` 之类的导出就是开了一个口子。
    //
    // ⚠️ 三档写法需要「现在」来做「今天」判断，但 `now` 是**显式入参**：
    // 模块自己仍然没有任何 `new Date()` 去猜当前时刻。这是「调用方给参照系」而不是
    // 「格式化层自己读时钟」—— 后者正是这条纪律要挡的东西。
    //
    // ⚠️ 这份清单是**穷举**的（`toEqual` 而非 `toContain`）—— 所以新增导出时这条会红，
    // 逼着作者回来说明「新增的这个为什么不算一个读时钟的口子」。
    return import('../../miniprogram/utils/datetime').then((module) => {
      expect(Object.keys(module).sort()).toEqual([
        'formatFullTime',
        'formatNotYetStored',
        'formatOrderTime',
        'formatOrderTimeInProgress',
        'formatReservationRange',
        'formatRestrictionSince',
      ])
    })
  })
})

describe('#23 禁止项：相对时间 / 星期 / 秒 / 倒计时', () => {
  it('⚠️ 输出里永远不出现秒', () => {
    // 「禁止」列逐字：❌ 秒。`HH:mm:ss` 里的 `:30` 一个都不该漏出来。
    const outputs = [
      formatOrderTime('2026-04-01T11:30:45+08:00', NOW),
      formatOrderTimeInProgress('2026-04-01T09:00:59+08:00', NOW),
      formatFullTime('2026-04-01T11:30:45+08:00'),
      formatReservationRange('2026-09-23T14:00:30+08:00', '2026-09-23T16:00:30+08:00'),
    ]
    for (const output of outputs) {
      // 每个输出里的 `HH:mm` 组数 = 出现的冒号数；一个时刻最多一组。
      const colonGroups = output.match(/\d{1,4}:\d{2}:\d{2}/g) ?? []
      expect(colonGroups, `「${output}」里出现了秒`).toEqual([])
    }
  })

  it('⚠️ 输出里永远不出现相对时间与星期', () => {
    // 「禁止」列逐字：❌ 相对时间（「3 分钟前」「刚刚」）❌ 星期。
    // ⚠️ 「今天」**不在这张禁用表里**：它是 §14.3 定稿的三档写法之一，
    // 由三档选择器在「当天」这一个分支里给出；相对时间（刚刚 / N 分钟前）与
    // 星期仍然是禁止的。
    const banned = ['分钟前', '小时前', '刚刚', '昨天', '明天', '星期', '周', '还有', '剩余']
    const outputs = [
      formatOrderTime('2026-04-01T11:30:00+08:00', NOW),
      formatOrderTimeInProgress('2026-04-01T09:00:00+08:00', NOW),
      formatFullTime('2026-04-01T11:30:00+08:00'),
      formatReservationRange('2026-09-23T14:00:00+08:00', '2026-09-23T16:00:00+08:00'),
      formatRestrictionSince('2026-09-22T15:04:00+08:00'),
      formatNotYetStored(),
    ]
    for (const output of outputs) {
      for (const term of banned) {
        expect(output, `「${output}」里出现了禁用写法「${term}」`).not.toContain(term)
      }
    }
  })

  it('⚠️ 本模块不做减法 —— 任何倒计时/分钟数在结构上算不出来', () => {
    // 硬规则 4 逐字：「绝不倒计时、绝不显示分钟数」。
    // 判据：模块的导出里**没有**任何「两个时刻之间」的函数（`formatReservationRange`
    // 是把两个时刻并排写出来，不是求差 —— 它不做任何算术）。
    // 这条与上面那条导出清单断言互为佐证：清单挡新增，这条挡语义。
    return import('../../miniprogram/utils/datetime').then((module) => {
      const source = Object.keys(module).join(' ')
      expect(source).not.toMatch(/diff|remaining|countdown|left|until|elapsed/i)
    })
  })
})

describe('#23 解析失败时不编造 —— 显式返回空串', () => {
  it('⚠️ 格式不对的串返回空串，而不是切出一段垃圾渲染上去', () => {
    // 「看到的就是真的」是这一层的全部价值。`value.slice(0, 16)` 那类写法对
    // 空串 / `null` 序列化成的 `"null"` / 契约漂移成的别的时间格式会**静默成功**，
    // 然后把一段垃圾画到屏上。
    const garbage = ['', 'null', 'undefined', '2026-04-01 11:30:00', 'not-a-date', '2026/04/01']
    for (const bad of garbage) {
      expect(formatOrderTime(bad, NOW), `「${bad}」不该被格式化`).toBe('')
      expect(formatFullTime(bad)).toBe('')
      expect(formatOrderTimeInProgress(bad, NOW)).toBe('')
      expect(formatRestrictionSince(bad)).toBe('')
    }
  })

  it('⚠️ 预约时段里任一端解析不出 → 整体留空（不渲染半截时段）', () => {
    // 一个「09-23 14:00 – 」的半截时段比空白更糟：它看起来像后端说了什么，其实没有。
    expect(formatReservationRange('2026-09-23T14:00:00+08:00', '')).toBe('')
    expect(formatReservationRange('', '2026-09-23T16:00:00+08:00')).toBe('')
  })
})
