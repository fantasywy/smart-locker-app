#!/usr/bin/env node
// 色调层验收脚本 —— 对应 `docs/spec/10-visual-language.md` §8 的 8 条可判定事实。
//
// 为什么是脚本而不是「靠眼睛」：色调层的取值全是**可判定的离散事实**，而它出过的两次事故
// （device 的 1.23 对比度、V25 的 2.06 数值漂移）都是眼睛看不出来的。⚠️ 尤其第 3 条 ——
// device 的单测只断言 `< AA`、不断言具体数值，所以一个错误的 2.06 能一直躺在文档里。
// 本脚本断言**具体数值**，让同类漂移下次立刻报警。
//
// 用法：node scripts/verify-visual-tokens.mjs
// 退出码 0 = 全过；1 = 有断言失败（打印哪一条、期望值、实际值）。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const variablesPath = fileURLToPath(new URL('../miniprogram/styles/_variables.scss', import.meta.url))
const mixinsPath = fileURLToPath(new URL('../miniprogram/styles/_mixins.scss', import.meta.url))

const failures = []
let checks = 0

function check(label, actual, expected) {
  checks += 1
  if (actual !== expected) {
    failures.push(`${label}\n    期望: ${expected}\n    实际: ${actual}`)
  }
}

function checkTrue(label, condition, detail = '') {
  checks += 1
  if (!condition) failures.push(`${label}${detail ? `\n    ${detail}` : ''}`)
}

/** 解析 `$name: value;`，丢掉行尾注释。 */
function readTokens(scss) {
  const tokens = {}
  for (const line of scss.split('\n')) {
    const m = /^\s*\$([\w-]+)\s*:\s*([^;]+);/.exec(line)
    if (m?.[1] !== undefined && m[2] !== undefined) tokens[m[1]] = m[2].replace(/\/\/.*$/, '').trim()
  }
  return tokens
}

const scss = readFileSync(variablesPath, 'utf8')
const mixinSrc = readFileSync(mixinsPath, 'utf8')
const tokens = readTokens(scss)

function token(name) {
  const value = tokens[name]
  if (value === undefined) throw new Error(`_variables.scss 里没有 $${name}`)
  return value
}

// ---------- WCAG 2.1（与 device 的 tokens.spec.ts 同一实现） ----------
const channels = (hex) => {
  const m = /^#([\da-f]{6})$/i.exec(hex)
  if (!m?.[1]) throw new Error(`不是 6 位 hex：${hex}`)
  const v = parseInt(m[1], 16)
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
}
const luminance = (hex) => {
  const [r = 0, g = 0, b = 0] = channels(hex).map((c) => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const round2 = (n) => Math.round(n * 100) / 100

const AA = 4.5
const WHITE = '#ffffff'

// ---------- 第 0 条：解析器兜底 ----------
// 解析器一旦静默返回空表（比如换了导入方式），下面所有否定式断言都会假通过。
checkTrue(
  'token 表真的解析出来了（兜底断言）',
  Object.keys(tokens).length > 20,
  `只解析到 ${Object.keys(tokens).length} 个 token`,
)

// ---------- 第 1 条：五档 token 取值逐值一致 ----------
const EXPECTED_TOKENS = {
  'color-primary': '#00b578',
  'color-primary-active': '#008655',
  'color-warning': '#e6a23c',
  'color-danger': '#f56c6c',
  'color-info': '#909399',
  'color-warning-ink': '#976a27',
  'color-danger-ink': '#c05454',
  'color-text-main': '#1f2329',
  'color-text-sub': '#646a73',
  'color-text-weak': '#8f959e',
  'color-bg-page': '#f5f7fa',
  'color-bg-card': '#ffffff',
  'color-border': '#dcdfe6',
  'color-primary-hover': '#009a68',
  'color-success': '#00b578',
}
for (const [name, expected] of Object.entries(EXPECTED_TOKENS)) check(`$${name}`, token(name), expected)

// ---------- 第 2 条：ink 压白底全部 ≥ AA（断言具体数值） ----------
const INK_ON_WHITE = {
  'color-warning-ink': 4.77,
  'color-danger-ink': 4.53,
  'color-primary-active': 4.62,
}
for (const [name, expected] of Object.entries(INK_ON_WHITE)) {
  const ratio = round2(contrast(token(name), WHITE))
  check(`$${name} 压白底对比度`, ratio, expected)
  checkTrue(`$${name} 压白底 ≥ AA`, ratio >= AA, `实际 ${ratio}`)
}

// 中性文字三档：sub 承载信息（必须过 AA），weak 只做占位符（本来就过不了）
const subRatio = round2(contrast(token('color-text-sub'), WHITE))
check('$color-text-sub 压白底对比度', subRatio, 5.45)
checkTrue('$color-text-sub 承载信息的文字 ≥ AA', subRatio >= AA, `实际 ${subRatio}`)

const weakRatio = round2(contrast(token('color-text-weak'), WHITE))
check('$color-text-weak 压白底对比度', weakRatio, 3.02)
checkTrue(
  '$color-text-weak 只给占位符 / 禁用态 —— 本来就过不了 AA',
  weakRatio < AA && weakRatio > 3,
  `实际 ${weakRatio}`,
)

const mainRatio = round2(contrast(token('color-text-main'), WHITE))
check('$color-text-main 压白底对比度', mainRatio, 15.78)

// ---------- 第 2b 条：ink 压「标签底」也 ≥ AA ----------
// ⚠️ 这条正是逼出「标签底必须纯白」的那条断言。两条歧路都会在这里失败：
//   ① 把标签底改成语义色浅调底 —— 红/绿在物理上就过不了 AA（spec §4.1 有实测表）；
//   ② 改成一个「浅灰面」（比如 $color-bg-page = #f5f7fa）—— 三个 ink 掉到 4.44/4.22/4.31，全破线。
// 只有纯白同时满足三个 ink。
const LABEL_BG = token('color-bg-card')
checkTrue(
  '标签底必须是纯白 $color-bg-card',
  LABEL_BG === '#ffffff',
  `实际 $color-bg-card: ${LABEL_BG} —— 浅灰面会把 ink 压破 AA`,
)
// 顺手确认 mixin 里用的是纯白，而不是被悄悄换成 $color-bg-page
checkTrue(
  'tone-chip 的 background 取 $color-bg-card（不是 $color-bg-page）',
  /background:\s*v\.\$color-bg-card;/.test(mixinSrc),
  'tone-chip 的底色被换成了浅灰面 —— 那会让三个 ink 全部破 AA',
)
for (const name of Object.keys(INK_ON_WHITE)) {
  const ratio = round2(contrast(token(name), LABEL_BG))
  checkTrue(
    `$${name} 压标签底也 ≥ AA`,
    ratio >= AA,
    `实际 ${ratio} —— 标签底必须保持纯白，不得改成语义色浅调底或浅灰面`,
  )
}

// ---------- 第 3 条：语义色原值全部 < AA（**具体数值**，不是只判不等号） ----------
// device 的 V25 记作「2.06 / 2.57 / 2.66」，用标准算法复算其实是 2.19 / 2.90 / 2.66
// （只有绿对上）。device 的单测只断言 `< AA`，所以那个错误的 2.06 一直躺着。
// 这里**断言数值**：既要「< AA」这个结论，也要数值本身正确。
const SEMANTIC_ON_WHITE = {
  'color-primary': 2.66,
  'color-warning': 2.19,
  'color-danger': 2.90,
  'color-info': 3.08,
}
for (const [name, expected] of Object.entries(SEMANTIC_ON_WHITE)) {
  const ratio = round2(contrast(token(name), WHITE))
  check(`$${name} 压白底对比度`, ratio, expected)
  checkTrue(`$${name} 原值不得 ≥ AA（只能做装饰）`, ratio < AA, `实际 ${ratio}`)
}

// ---------- 第 4 条：四支 mixin 都能编译出五档选择器 ----------
const TONES = ['ok', 'info', 'warn', 'danger', 'muted']
for (const mixin of ['tone-bar', 'tone-chip', 'tone-text', 'tone-dot']) {
  checkTrue(`mixin ${mixin} 存在`, new RegExp(`@mixin\\s+${mixin}\\s*\\(`).test(mixinSrc))
}
for (const tone of TONES) {
  checkTrue(
    `tone-chip 覆盖 .is-${tone}`,
    mixinSrc.includes(`&.is-${tone}`),
    '五档必须显式各自输出 —— 不得靠「不写 class」的默认值蒙混',
  )
}

// ---------- 第 5 条：档名拼错在编译期报错 ----------
checkTrue(
  '存在档名校验（_check-tones），拼错在编译期报错',
  /@function\s+_check-tones/.test(mixinSrc) && /@error/.test(mixinSrc),
  '没有这条守卫时，拼错档名会静默生成一条永不匹配的规则',
)

// ---------- 第 6 条：变量文件里没有裸 hex 散落 ----------
// 允许的位置：$name: #hex; 的取值行。禁止的是 mixin / 规则体里直接写 hex。
const nakedHexInRules = scss
  .split('\n')
  .map((line, i) => ({ line: line.trim(), no: i + 1 }))
  .filter(({ line }) => /^[.#&]/.test(line) && /#[0-9a-f]{3,8}\b/i.test(line))
checkTrue(
  '_variables.scss 的规则体里没有裸 hex',
  nakedHexInRules.length === 0,
  nakedHexInRules.map((x) => `:${x.no} ${x.line}`).join('\n    '),
)

// ---------- 第 7 条：不出现 8 位 hex（一律 rgba()） ----------
for (const [name, src] of [['_variables.scss', scss], ['_mixins.scss', mixinSrc]]) {
  const eightDigit = src.match(/#[0-9a-f]{8}\b/gi) ?? []
  checkTrue(`${name} 不出现 8 位 hex`, eightDigit.length === 0, `发现：${eightDigit.join(', ')}`)
}

// ---------- 第 8 条：字号与间距档数一致 ----------
for (const [name, expected] of Object.entries({
  'font-size-meta': '11px',
  'font-size-aux': '12px',
  'font-size-body': '14px',
  'font-size-title': '16px',
  'font-size-display': '28px',
  'spacing-xs': '4px',
  'spacing-sm': '8px',
  'spacing-md': '12px',
  'spacing-lg': '16px',
  'spacing-xl': '20px',
  'spacing-xxl': '24px',
  'radius-component': '4px',
  'radius-card': '8px',
  'status-bar-width': '3px',
})) check(`$${name}`, token(name), expected)

// 色条刻意是 px（不是 rpx）—— 文档级一致，见 spec §7.2
checkTrue(
  '$status-bar-width 用 px（不是 rpx）',
  token('status-bar-width').endsWith('px'),
  `实际 ${token('status-bar-width')}`,
)

// ---------- 报告 ----------
if (failures.length === 0) {
  console.log(`✅ 色调层验收全过（${checks} 条断言）`)
  process.exit(0)
}
console.error(`❌ 色调层验收失败：${failures.length} / ${checks} 条\n`)
for (const f of failures) console.error(`  • ${f}\n`)
process.exit(1)
