// **金额展示工具** —— spec #57 §14.1 / §15「金额四词」的落地。
//
// 这个文件挡的是三件会静默说谎的事：
//   • 分转元做了两次（`payAmount / 100 / 100`）—— 数字小了一百倍，界面照样渲染；
//   • 忘了千分位 —— `¥1234.56` 与 `¥1,234.56` 在订单金额上是两种可信度；
//   • 少了两位小数 —— `¥12` 会被读成十二元整，而服务端给的是分。
//
// 判据一律是**已知的输入 → 逐字输出**，不拿代码自己的算法去算期望值。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { formatMoney } from '../../miniprogram/utils/money'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const moneySource = (): string =>
  readFileSync(join(repoRoot, 'miniprogram', 'utils', 'money.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

describe('#63 金额展示：分 → ¥ + 两位小数 + 千分位', () => {
  it('⚠️ 0 分渲染成 ¥0.00，而不是空串或 ¥0', () => {
    expect(formatMoney(0)).toBe('¥0.00')
  })

  it('⚠️ 整元补齐两位小数', () => {
    expect(formatMoney(1200)).toBe('¥12.00')
  })

  it('⚠️ 千分位只加在整数部分', () => {
    expect(formatMoney(123456)).toBe('¥1,234.56')
    expect(formatMoney(123456789)).toBe('¥1,234,567.89')
  })

  it('⚠️ 分转元只做一次：源码里恰好一处 `/ 100`', () => {
    // 这条是「页面不各写除法」的同一把尺子，钉在工具自己的实现上：
    // 两次除法不会报错，只会让金额小一百倍。
    const divisions = moneySource().match(/\/\s*100\b/g) ?? []
    expect(divisions).toHaveLength(1)
  })
})
