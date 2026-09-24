// **时间格式化**的行为测试 —— issue #23 的 Acceptance criteria 之一：
// 「日期格式化模块覆盖 `09` §5.4 全部 7 种格式，**有 Vitest 断言**（纯函数，不需桩）」。
//
// ⚠️ **本文件一个 `wx.*` 桩都不用** —— 那本身就是一条断言：`utils/datetime.ts`
// 是纯函数（`07` §3 给 `utils/` 的定位）。哪天有人往它里面塞了一个 `wx.` 调用，
// 这里的用例会立刻因为「未编排即失败」而红 —— 而不是等到真机上才发现。
//
// 出处：`docs/spec/09-copy-and-status.md` §5.4（时间写法表 + 时区硬规则）、§5.8（硬规则 4）。
//
// ⚠️ 期望值一律**照抄 `09` §5.4 的示例列**（`04-01 09:00` / `2026-04-01 11:30` /
// `09-23 14:00 – 16:00` ……），不是「看着像就行」。那张表是定稿，示例就是判据。

import { describe, expect, it } from 'vitest'
import {
  formatDurationSlot,
  formatFullTime,
  formatNotYetStored,
  formatOrderTime,
  formatOrderTimeInProgress,
  formatReservationRange,
  formatRestrictionSince,
  formatSlotTime,
} from '../../miniprogram/utils/datetime'

/** 服务端回显的形态：带 `+08:00`（`05` §1.18 已实测）。 */
const SERVER_INSTANT = '2026-04-01T09:00:00+08:00'

describe('#23 09 §5.4 的七种时间写法', () => {
  it('①订单列表 · 在途 → `存入 MM-DD HH:mm`（09 §5.4 第 1 行）', () => {
    // 表里的示例逐字：`存入 04-01 09:00`。
    expect(formatOrderTimeInProgress(SERVER_INSTANT)).toBe('存入 04-01 09:00')
    // 前缀里的「存入」是 CONTEXT.md 的 canonical 术语（09 §5.5：不许说「寄件」/「寄存」）。
    expect(formatOrderTimeInProgress(SERVER_INSTANT).startsWith('存入 ')).toBe(true)
  })

  it('②订单列表 · 终局 → `MM-DD HH:mm`，**不加前缀**（09 §5.4 第 2 行）', () => {
    // 示例逐字：`04-01 11:30`。状态标签已说明这是什么时刻，再加前缀是说两遍。
    expect(formatOrderTime('2026-04-01T11:30:00+08:00')).toBe('04-01 11:30')
    // ⚠️ 与 ① 的**唯一区别**就是前缀 —— 两个函数必须真的不同。
    expect(formatOrderTime('2026-04-01T11:30:00+08:00')).not.toContain('存入')
  })

  it('③订单列表 · 未存入 → 留空，改放引导句「关好柜门才算存入」（09 §5.4 第 3 行，03 §5/§8 逐字）', () => {
    expect(formatNotYetStored()).toBe('关好柜门才算存入')
    // ⚠️ 它**一个时刻都不给** —— 表里那一行的口径就是「留空」。
    // 一个「近似时刻」在这里比空白更糟：它会看起来像个真的截止时间。
    expect(formatNotYetStored()).not.toMatch(/\d/)
    // ⚠️ 不得断言「门还没关」（09 §5.7：核对接不到新事实不代表门没关）。
    expect(formatNotYetStored()).not.toContain('门还没关')
  })

  it('④订单详情 / 信用分明细 / 受限卡 → `YYYY-MM-DD HH:mm`（补全年份）', () => {
    // 第 4 行示例逐字：`2026-04-01 11:30`。
    expect(formatFullTime('2026-04-01T11:30:00+08:00')).toBe('2026-04-01 11:30')
    // 第 8 行（信用分明细）示例逐字：`2026-09-22 15:04`。
    expect(formatFullTime('2026-09-22T15:04:00+08:00')).toBe('2026-09-22 15:04')
    // ⚠️ 与 ② 的关系：**同一个时刻，列表省年份、详情补全** —— 两种口径的分界是
    // 「列表 vs 回查」（09 §5.4 的原话），不是「哪一页」。
    expect(formatFullTime(SERVER_INSTANT).endsWith(formatOrderTime(SERVER_INSTANT))).toBe(true)
  })

  it('⑤预约列表副行 → `MM-DD HH:mm – HH:mm`，**同日**（09 §5.4 第 5 行）', () => {
    // 示例逐字：`09-23 14:00 – 16:00`。
    expect(formatReservationRange('2026-09-23T14:00:00+08:00', '2026-09-23T16:00:00+08:00')).toBe(
      '09-23 14:00 – 16:00',
    )
  })

  it('⑤预约列表副行 → **跨天时段重复日期**（09 §5.4 第 5 行）', () => {
    // 示例逐字：跨天 `09-23 23:00 – 09-24 01:00`。
    // ⚠️ 不得写成 `09-23 23:00 – 01:00` —— 那样读起来像一个已经过去的时刻，
    // 而它其实是第二天凌晨。
    expect(formatReservationRange('2026-09-23T23:00:00+08:00', '2026-09-24T01:00:00+08:00')).toBe(
      '09-23 23:00 – 09-24 01:00',
    )
  })

  it('⑤分隔符是 en dash 且两侧各一个空格（05 §7.1 逐字）', () => {
    const range = formatReservationRange('2026-09-23T14:00:00+08:00', '2026-09-23T16:00:00+08:00')
    // ⚠️ `–`（U+2013）不是 ASCII `-`：日期里的连字符与分隔符必须一眼可分。
    expect(range).toContain(' – ')
    expect(range).not.toContain(' - ')
  })

  it('⑥预约创建 · 开始档位 → `HH:mm`（09 §5.4 第 6 行）', () => {
    // 示例逐字：`14:00` / `14:30` —— 只给时刻、不给日期（日期由页面标题承担，05 §3.2）。
    expect(formatSlotTime('2026-09-23T14:00:00+08:00')).toBe('14:00')
    expect(formatSlotTime('2026-09-23T14:30:00+08:00')).toBe('14:30')
    expect(formatSlotTime('2026-09-23T14:30:00+08:00')).not.toMatch(/-/)
  })

  it('⑦受限卡 → 「限制开始于 YYYY-MM-DD HH:mm」（09 §5.4 第 9 行 + §7.5:505 逐字）', () => {
    // 09 §7.5:505 的定稿示例逐字：「**限制开始于 2026-09-22 15:04**」。
    expect(formatRestrictionSince('2026-09-22T15:04:00+08:00')).toBe('限制开始于 2026-09-22 15:04')
  })
})

describe('#23 时区硬规则：只用服务端回显的值，不用客户端本地时钟重算（09 §5.4 附注）', () => {
  it('⚠️ 服务端说几点，屏上就是几点 —— 与运行设备的时区无关', () => {
    // `09` §5.4 附注逐字：「展示的是**服务端回显**的时刻（响应带 `+08:00`）。
    // **不得**用客户端本地时钟重新格式化出另一个值 —— 那是双源真相。」
    //
    // ⚠️ 这条用例的**判据**正是「入参是字符串、输出是字符串」：本模块从头到尾
    // 不构造 `Date`。若哪天有人把实现改成 `new Date(instant).getHours()`，
    // 那么在非东八区的运行环境（CI、或用户改了手机时区）下这里会**当场变红**。
    //
    // 三个不同的偏移，同一个字面时刻 —— 屏上必须是同一个值。
    // ⚠️ 这里刻意**不断言**「带 `+08:00` 才显示」：契约响应带 `+08:00`（05 §1.18），
    // 但格式化层不该去校验偏移 —— 它只负责把服务端给的那段字面数字搬上屏。
    const asServerEchoed = '2026-04-01T09:00:00+08:00'
    expect(formatOrderTime(asServerEchoed)).toBe('04-01 09:00')
    // 同一段日期时刻、不同偏移后缀 → 仍是同一个显示值（本模块不读偏移）。
    expect(formatOrderTime('2026-04-01T09:00:00Z')).toBe('04-01 09:00')
    expect(formatOrderTime('2026-04-01T09:00:00-05:00')).toBe('04-01 09:00')
  })

  it('⚠️ 本模块不提供任何「取当前时间」的入口 —— 双源真话在类型上就写不出来', () => {
    // 落地方式不是「记得别这么写」，而是**根本不给这个能力**（见 datetime.ts 文件头规则 1）。
    // 判据取模块的导出清单：多出一个 `formatNow` / `now` 之类的导出就是开了一个口子。
    //
    // ⚠️ 这份清单是**穷举**的（`toEqual` 而非 `toContain`）—— 所以新增导出时这条会红，
    // 逼着作者回来说明「新增的这个为什么不算一个读时钟的口子」。
    // `formatDurationSlot`（#23 review 补）正是被它拦下来过一次的。
    return import('../../miniprogram/utils/datetime').then((module) => {
      expect(Object.keys(module).sort()).toEqual([
        'formatDurationSlot',
        'formatFullTime',
        'formatNotYetStored',
        'formatOrderTime',
        'formatOrderTimeInProgress',
        'formatReservationRange',
        'formatRestrictionSince',
        'formatSlotTime',
      ])
    })
  })
})

describe('#23 09 §5.4 第 7 行：时长档位（不用 1h）', () => {
  it('⚠️ `1小时 / 2小时 / 4小时 / 8小时` —— 单位写成中文「小时」', () => {
    // `09` §5.4 第 7 行逐字：`1小时 / 2小时 / 4小时 / 8小时`（**不用 `1h`**）。
    // ⚠️ 这不是一个假想的错法：`05` §3.1 的表格里写的**恰恰就是** `1h / 2h / 4h / 8h` ——
    // 照那份 spec 抄就会写错，所以 §5.4 这一行的存在是有针对性的。
    expect(formatDurationSlot(1)).toBe('1小时')
    expect(formatDurationSlot(2)).toBe('2小时')
    expect(formatDurationSlot(4)).toBe('4小时')
    expect(formatDurationSlot(8)).toBe('8小时')
  })

  it('⚠️ **不得**出现 `h` 这个单位写法（09 §5.4 那一行的全部意义）', () => {
    for (const hours of [1, 2, 4, 8]) {
      const label = formatDurationSlot(hours)
      expect(label).not.toContain('h')
      expect(label).not.toContain('H')
      expect(label).not.toMatch(/[A-Za-z]/)
    }
  })

  it('⚠️ 非法档位值返回空串 —— 不编一个「0小时」或不存在的档位出来', () => {
    // 与别的格式化函数同一口径：解析不出来就不给值。
    // ⚠️ 判据是「正整数」，所以 `1.5` 也落空 —— `05` §3.1 的档位是整数小时，
    // 一个小数说明调用方传错了东西，那种错该当场可见。
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatDurationSlot(bad), `${bad} 不该被格式化`).toBe('')
    }
  })

  it('⚠️ 它不含任何上限判断（05 §1.2：C 端拿不到任何配置数字）', () => {
    // ⚠️ 真正不许出现的是 `maxHours`(24) 那类**配置数字** —— C 端拿不到任何一个
    // 预约配置数字（`05` §1.2），所以这里不能有「最多 24 小时」这类校验或文案。
    // 24 不在五档里，传进来照样老实渲染 —— 上限归服务端（`8006`），不归格式化层。
    expect(formatDurationSlot(24)).toBe('24小时')
  })
})

describe('#23 禁止项：相对时间 / 星期 / 秒 / 倒计时（09 §5.4 表末 + §5.8 硬规则 4）', () => {
  it('⚠️ 输出里永远不出现秒', () => {
    // 09 §5.4 的「禁止」列逐字：❌ 秒。`HH:mm:ss` 里的 `:30` 一个都不该漏出来。
    const outputs = [
      formatOrderTime('2026-04-01T11:30:45+08:00'),
      formatOrderTimeInProgress('2026-04-01T09:00:59+08:00'),
      formatFullTime('2026-04-01T11:30:45+08:00'),
      formatSlotTime('2026-04-01T11:30:45+08:00'),
      formatReservationRange('2026-09-23T14:00:30+08:00', '2026-09-23T16:00:30+08:00'),
    ]
    for (const output of outputs) {
      // 每个输出里的 `HH:mm` 组数 = 出现的冒号数；一个时刻最多一组。
      const colonGroups = output.match(/\d{1,4}:\d{2}:\d{2}/g) ?? []
      expect(colonGroups, `「${output}」里出现了秒`).toEqual([])
    }
  })

  it('⚠️ 输出里永远不出现相对时间与星期', () => {
    // 09 §5.4 的「禁止」列逐字：❌ 相对时间（「3 分钟前」「刚刚」）❌ 星期。
    const banned = ['分钟前', '小时前', '刚刚', '昨天', '今天', '明天', '星期', '周', '还有', '剩余']
    const outputs = [
      formatOrderTime('2026-04-01T11:30:00+08:00'),
      formatOrderTimeInProgress('2026-04-01T09:00:00+08:00'),
      formatFullTime('2026-04-01T11:30:00+08:00'),
      formatSlotTime('2026-04-01T14:00:00+08:00'),
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
    // 09 §5.8 硬规则 4 逐字：「绝不倒计时、绝不显示分钟数」。
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
      expect(formatOrderTime(bad), `「${bad}」不该被格式化`).toBe('')
      expect(formatFullTime(bad)).toBe('')
      expect(formatSlotTime(bad)).toBe('')
      expect(formatOrderTimeInProgress(bad)).toBe('')
      expect(formatRestrictionSince(bad)).toBe('')
    }
  })

  it('⚠️ 预约时段里任一端解析不出 → 整体留空（不渲染半截时段）', () => {
    // 一个「09-23 14:00 – 」的半截时段比空白更糟：它看起来像后端说了什么，其实没有。
    expect(formatReservationRange('2026-09-23T14:00:00+08:00', '')).toBe('')
    expect(formatReservationRange('', '2026-09-23T16:00:00+08:00')).toBe('')
  })
})
