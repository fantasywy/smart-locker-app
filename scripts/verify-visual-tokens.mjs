#!/usr/bin/env node
// 视觉 token 验收脚本 —— 逐值断言 + 动效白名单。
//
// 为什么是脚本而不是「靠眼睛」：token 层全是**可判定的离散事实**，而它出过的两次事故
// （device 的 1.23 对比度、V25 的 2.06 数值漂移）都是眼睛看不出来的。⚠️ 尤其对比度 ——
// device 的单测只断言 `< AA`、不断言具体数值，所以一个错误的 2.06 能一直躺在文档里。
// 本脚本断言**具体数值**，让同类漂移下次立刻报警。
//
// 三类判据：
//   1. token 表逐值（颜色 / 圆角五档 / 四条阴影 / 字号 / 行高 / 字重 / 间距）；
//   2. 对比度（含负向断言：语义原值与 tint 上的绿字都必须 < AA）；
//   3. 结构（已删除 token 不得复现；transition / animation / @keyframes 只允许白名单）。
//
// 用法：node scripts/verify-visual-tokens.mjs
// 退出码 0 = 全过；1 = 有断言失败（打印哪一条、期望值、实际值）。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const miniprogramDir = join(repoRoot, 'miniprogram')
const variablesPath = join(miniprogramDir, 'styles', '_variables.scss')
const mixinsPath = join(miniprogramDir, 'styles', '_mixins.scss')
const appScssPath = join(miniprogramDir, 'app.scss')
const scriptPath = fileURLToPath(import.meta.url)

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

/** 递归收集目录下的指定后缀文件（跳过 node_modules / miniprogram_npm）。 */
function collect(dir, extensions) {
  const found = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'miniprogram_npm') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...collect(full, extensions))
    else if (extensions.some((ext) => entry.endsWith(ext))) found.push(full)
  }
  return found
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

function checkContrast(label, fg, bg, expected) {
  const ratio = round2(contrast(fg, bg))
  check(label, ratio, expected)
  return ratio
}

// ---------- 第 0 条：解析器兜底 ----------
// 解析器一旦静默返回空表（比如换了导入方式），下面所有否定式断言都会假通过。
checkTrue(
  'token 表真的解析出来了（兜底断言）',
  Object.keys(tokens).length > 20,
  `只解析到 ${Object.keys(tokens).length} 个 token`,
)

// ---------- 第 1 条：颜色 token 逐值一致 ----------
const EXPECTED_COLORS = {
  'color-primary': '#00b578',
  'color-primary-pressed': '#00744a',
  'color-primary-active': '#008655',
  'color-primary-tint': '#e8f7f0',
  'color-success': '#00b578',
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
  'color-overlay': 'rgba(0, 0, 0, 0.45)',
}
for (const [name, expected] of Object.entries(EXPECTED_COLORS)) check(`$${name}`, token(name), expected)

// ---------- 第 2 条：白字只允许压三个已批准的底色 ----------
// §12 硬规则 1：白字只允许压 #008655 / #00744a / #1f2329 / #474747。
// 后两个是中性深色（正文色之一与 Vant 深色复合底），这里断言前三个 token 上的取值。
const PRIMARY_FILL = token('color-primary-active')
const PRIMARY_PRESSED = token('color-primary-pressed')
const TEXT_MAIN = token('color-text-main')

const WHITE_TEXT_ON = [
  ['$color-primary-active（主按钮填充）', PRIMARY_FILL, 4.62],
  ['$color-primary-pressed（按下态）', PRIMARY_PRESSED, 5.84],
  ['$color-text-main（正文深色底）', TEXT_MAIN, 15.78],
]
for (const [label, bg, expected] of WHITE_TEXT_ON) {
  const ratio = checkContrast(`白字压 ${label} 对比度`, WHITE, bg, expected)
  checkTrue(`白字压 ${label} ≥ AA`, ratio >= AA, `实际 ${ratio}`)
}

// 负向：这些底色**不得**承载白字。旧按下态色值也必须在「白字压它只有 3.61」这条上被钉死。
const OLD_PRESSED_HEX = '#009a' + '68'
const VANT_PRESSED_COMPOSITE = '#0072' + '48'
const FORBIDDEN_WHITE_BACKGROUNDS = [
  ['$color-primary（装饰原值）', token('color-primary'), 2.66],
  ['旧按下态色值', OLD_PRESSED_HEX, 3.61],
  ['$color-warning（警示原值）', token('color-warning'), 2.19],
  ['$color-danger（危险原值）', token('color-danger'), 2.90],
  ['$color-info（中性原值）', token('color-info'), 3.08],
]
for (const [label, bg, expected] of FORBIDDEN_WHITE_BACKGROUNDS) {
  const ratio = checkContrast(`白字压 ${label} 对比度`, WHITE, bg, expected)
  checkTrue(`白字不得压 ${label}（< AA）`, ratio < AA, `实际 ${ratio}`)
}

// Vant 按下态的复合色（#59 接线时使用）—— 这里只钉住 §12 的对比度事实。
const vantPressedRatio = checkContrast('白字压 Vant 按下态复合色对比度', WHITE, VANT_PRESSED_COMPOSITE, 6.0)
checkTrue('白字压 Vant 按下态复合色 ≥ AA', vantPressedRatio >= AA, `实际 ${vantPressedRatio}`)

// ---------- 第 3 条：tint / 页面底上的文字与绿色 ----------
const TINT = token('color-primary-tint')
const PAGE_BG = token('color-bg-page')
const TEXT_SUB = token('color-text-sub')

const primaryOnTint = checkContrast('$color-primary-active 压 tint 对比度', PRIMARY_FILL, TINT, 4.18)
checkTrue(
  '$color-primary-active 在 tint 上只能做图标 / 描边（< AA，不得当文字）',
  primaryOnTint < AA,
  `实际 ${primaryOnTint}`,
)
const subOnTint = checkContrast('$color-text-sub 压 tint 对比度', TEXT_SUB, TINT, 4.93)
checkTrue('$color-text-sub 压 tint ≥ AA', subOnTint >= AA, `实际 ${subOnTint}`)
const mainOnTint = checkContrast('$color-text-main 压 tint 对比度', TEXT_MAIN, TINT, 14.27)
checkTrue('$color-text-main 压 tint ≥ AA', mainOnTint >= AA, `实际 ${mainOnTint}`)

const subOnPage = checkContrast('$color-text-sub 压页面底对比度', TEXT_SUB, PAGE_BG, 5.08)
checkTrue('$color-text-sub 压页面底 ≥ AA', subOnPage >= AA, `实际 ${subOnPage}`)
const mainOnPage = checkContrast('$color-text-main 压页面底对比度', TEXT_MAIN, PAGE_BG, 14.70)
checkTrue('$color-text-main 压页面底 ≥ AA', mainOnPage >= AA, `实际 ${mainOnPage}`)

// ---------- 第 4 条：ink 压白底 / 标签底全部 ≥ AA ----------
const INK_ON_WHITE = {
  'color-warning-ink': 4.77,
  'color-danger-ink': 4.53,
  'color-primary-active': 4.62,
}
for (const [name, expected] of Object.entries(INK_ON_WHITE)) {
  const ratio = checkContrast(`$${name} 压白底对比度`, token(name), WHITE, expected)
  checkTrue(`$${name} 压白底 ≥ AA`, ratio >= AA, `实际 ${ratio}`)
}

const subRatio = checkContrast('$color-text-sub 压白底对比度', TEXT_SUB, WHITE, 5.45)
checkTrue('$color-text-sub 承载信息的文字 ≥ AA', subRatio >= AA, `实际 ${subRatio}`)

const weakRatio = checkContrast('$color-text-weak 压白底对比度', token('color-text-weak'), WHITE, 3.02)
checkTrue(
  '$color-text-weak 只给占位符 / 禁用态 —— 本来就过不了 AA',
  weakRatio < AA && weakRatio > 3,
  `实际 ${weakRatio}`,
)

checkContrast('$color-text-main 压白底对比度', TEXT_MAIN, WHITE, 15.78)

// 标签底必须纯白：浅灰面会把三个 ink 全部压破 AA（见 _mixins.scss 的实测）。
const LABEL_BG = token('color-bg-card')
checkTrue(
  '标签底必须是纯白 $color-bg-card',
  LABEL_BG === WHITE,
  `实际 $color-bg-card: ${LABEL_BG} —— 浅灰面会把 ink 压破 AA`,
)
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

// ---------- 第 5 条：语义色原值全部 < AA（具体数值，不是只判不等号） ----------
// device 的 V25 记作「2.06 / 2.57 / 2.66」，用标准算法复算其实是 2.19 / 2.90 / 2.66
// （只有绿对上）。device 的单测只断言 `< AA`，所以那个错误的 2.06 一直躺着。
// 这里断言数值：既要「< AA」这个结论，也要数值本身正确。
const SEMANTIC_ON_WHITE = {
  'color-primary': 2.66,
  'color-warning': 2.19,
  'color-danger': 2.90,
  'color-info': 3.08,
}
for (const [name, expected] of Object.entries(SEMANTIC_ON_WHITE)) {
  const ratio = checkContrast(`$${name} 压白底对比度`, token(name), WHITE, expected)
  checkTrue(`$${name} 原值不得 ≥ AA（只能做装饰）`, ratio < AA, `实际 ${ratio}`)
}

// ---------- 第 6 条：圆角五档 / 四条阴影 / 字号与间距逐值 ----------
const EXPECTED_RADIUS = {
  'radius-chip': '8px',
  'radius-control': '12px',
  'radius-card': '16px',
  'radius-sheet': '20px',
  'radius-pill': '999px',
}
for (const [name, expected] of Object.entries(EXPECTED_RADIUS)) check(`$${name}`, token(name), expected)

const EXPECTED_SHADOWS = {
  'shadow-card': '0 1px 2px rgba(0, 0, 0, 0.04)',
  'shadow-raised': '0 4px 12px rgba(0, 0, 0, 0.08)',
  'shadow-sheet': '0 8px 24px rgba(0, 0, 0, 0.12)',
  'shadow-bar': '0 -2px 8px rgba(0, 0, 0, 0.06)',
}
for (const [name, expected] of Object.entries(EXPECTED_SHADOWS)) check(`$${name}`, token(name), expected)

const EXPECTED_TYPE = {
  'font-size-meta': '11px',
  'font-size-aux': '12px',
  'font-size-body': '14px',
  'font-size-title': '16px',
  'font-size-heading': '18px',
  'font-size-hero': '24px',
  'font-size-display': '28px',
  'line-height-heading': '26px',
  'line-height-hero': '32px',
  'line-height-display': '36px',
  'font-weight-medium': '500',
  'font-weight-semibold': '600',
}
for (const [name, expected] of Object.entries(EXPECTED_TYPE)) check(`$${name}`, token(name), expected)

for (const [sizeName, lineName] of [
  ['font-size-heading', 'line-height-heading'],
  ['font-size-hero', 'line-height-hero'],
  ['font-size-display', 'line-height-display'],
]) {
  const size = Number.parseFloat(token(sizeName))
  const lineHeight = Number.parseFloat(token(lineName))
  checkTrue(
    `$${lineName} 是 $${sizeName} 的配套行高（行高 > 字号）`,
    lineHeight > size,
    `实际 ${lineHeight}px vs ${size}px`,
  )
}

const EXPECTED_SPACING = {
  'spacing-xs': '4px',
  'spacing-sm': '8px',
  'spacing-md': '12px',
  'spacing-lg': '16px',
  'spacing-xl': '20px',
  'spacing-xxl': '24px',
  'spacing-xxxl': '32px',
  'status-bar-width': '3px',
}
for (const [name, expected] of Object.entries(EXPECTED_SPACING)) check(`$${name}`, token(name), expected)

// 色条刻意是 px（不是 rpx）—— 固定物理尺寸，不随屏宽缩放
checkTrue(
  '$status-bar-width 用 px（不是 rpx）',
  token('status-bar-width').endsWith('px'),
  `实际 ${token('status-bar-width')}`,
)

// ---------- 第 7 条：四支 mixin 都能编译出五档选择器 ----------
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

// 圆角语义：标签用 chip、卡用 card —— 通用圆角已经拆成 chip / control。
checkTrue(
  'tone-chip 使用 $radius-chip',
  /border-radius:\s*v\.\$radius-chip;/.test(mixinSrc),
  '标签 / 徽标 / 小控件应使用 chip 圆角',
)
checkTrue(
  'card 使用 $radius-card',
  /border-radius:\s*v\.\$radius-card;/.test(mixinSrc),
  '卡片应使用 card 圆角',
)
checkTrue('card 使用 $shadow-card', /box-shadow:\s*v\.\$shadow-card;/.test(mixinSrc))

// ---------- 第 8 条：档名拼错在编译期报错 ----------
checkTrue(
  '存在档名校验（_check-tones），拼错在编译期报错',
  /@function\s+_check-tones/.test(mixinSrc) && /@error/.test(mixinSrc),
  '没有这条守卫时，拼错档名会静默生成一条永不匹配的规则',
)

// ---------- 第 9 条：变量文件里没有裸 hex 散落 ----------
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

// ---------- 第 10 条：不出现 8 位 hex（一律 rgba()） ----------
for (const [name, src] of [
  ['_variables.scss', scss],
  ['_mixins.scss', mixinSrc],
]) {
  const eightDigit = src.match(/#[0-9a-f]{8}\b/gi) ?? []
  checkTrue(`${name} 不出现 8 位 hex`, eightDigit.length === 0, `发现：${eightDigit.join(', ')}`)
}

// ---------- 第 11 条：已删除 token 与旧值不得复现 ----------
// 旧 token 名刻意用拼接构造：本脚本自己也不能成为残留引用（验收要求「样式与脚本里都不再出现」）。
const DELETED_TOKEN_NAMES = ['radius' + '-component', 'color-primary' + '-hover', 'shadow-card' + '-hover']
const sourceFiles = [
  ...collect(miniprogramDir, ['.scss', '.ts', '.wxml', '.json']),
  ...collect(join(repoRoot, 'test'), ['.ts']),
  scriptPath,
]
const deletedOffenders = []
for (const file of sourceFiles) {
  const lines = readFileSync(file, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    for (const name of DELETED_TOKEN_NAMES) {
      if (line.includes(name)) deletedOffenders.push(`${relative(repoRoot, file)}:${i + 1}  ${line.trim()}`)
    }
    if (line.toLowerCase().includes(OLD_PRESSED_HEX)) {
      deletedOffenders.push(`${relative(repoRoot, file)}:${i + 1}  旧按下态色值 ${OLD_PRESSED_HEX}`)
    }
  }
}
checkTrue(
  '已删除的旧 token 名 / 旧按下态色值不再出现',
  deletedOffenders.length === 0,
  deletedOffenders.map((x) => `  • ${x}`).join('\n'),
)

// ---------- 第 12 条：动效白名单 ----------
/** 把注释替换为等长空白，保留换行 —— 结构断言要能打印 文件:行，而注释不该被当成样式。 */
function blankComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (match, prefix) => prefix + ' '.repeat(Math.max(0, match.length - prefix.length)))
}

const navigationBarScss = join(miniprogramDir, 'components', 'navigation-bar', 'navigation-bar.scss')
function scanMotion() {
  const violations = []
  const whitelisted = { animation: 0, keyframes: 0 }
  for (const file of collect(miniprogramDir, ['.scss'])) {
    const lines = blankComments(readFileSync(file, 'utf8')).split('\n')
    /** 当前选择器 / at-rule 栈 —— 只为判断 animation 是否落在 `.weui-loading` 里。 */
    const stack = []
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? ''
      const trimmed = line.trim()
      const where = `${relative(repoRoot, file)}:${i + 1}  ${trimmed}`

      if (/\btransition(?:-[\w-]+)?\s*:/.test(trimmed)) violations.push(where)

      if (/\banimation(?:-[\w-]+)?\s*:/.test(trimmed)) {
        const selector = stack[stack.length - 1] ?? ''
        const isAllowed =
          file === navigationBarScss && selector === '.weui-loading' && /\banimation\s*:\s*loading\b/.test(trimmed)
        if (isAllowed) whitelisted.animation += 1
        else violations.push(where)
      }

      const keyframes = /@(?:-\w+-)?keyframes\s+([\w-]+)/.exec(trimmed)
      if (keyframes) {
        const isAllowed = file === navigationBarScss && keyframes[1] === 'loading'
        if (isAllowed) whitelisted.keyframes += 1
        else violations.push(where)
      }

      // 维护选择器栈：只处理本仓库的简单 SCSS 形态（一行一个开头 `{`）。
      const openCount = (line.match(/\{/g) ?? []).length
      const closeCount = (line.match(/\}/g) ?? []).length
      if (openCount > 0) {
        const before = line.slice(0, line.indexOf('{')).trim()
        for (let k = 0; k < openCount; k += 1) stack.push(before)
      }
      for (let k = 0; k < closeCount; k += 1) stack.pop()
    }
  }
  return { violations, whitelisted }
}

const motion = scanMotion()
checkTrue(
  'transition / animation / @keyframes 只命中功能性 loading 白名单',
  motion.violations.length === 0,
  motion.violations.map((x) => `  • ${x}`).join('\n'),
)
// #59 把导航栏换成 `van-nav-bar` 后删掉了 weui 的 `loading` 入参与该 spinner：
// 源码里不再有任何自绘 animation / keyframes。Vant 的 `van-loading` 在
// `miniprogram_npm`（构建产物，不进源码扫描），属白名单第 ② 条。
checkTrue(
  '源码内没有自绘 animation / @keyframes（白名单不再被使用）',
  motion.whitelisted.animation === 0 && motion.whitelisted.keyframes === 0,
  `实际 animation ${motion.whitelisted.animation} 处、@keyframes ${motion.whitelisted.keyframes} 处`,
)

// ---------- 第 13 条：页面 / 组件 SCSS 里不得出现像素行高 ----------
// spec §12 的几何口径：「字号 / 圆角 / 1px 细节继续 `px`；布局几何继续 `rpx`」——
// 行高两者都不是：它要么是**字号的相对比例**（无单位），要么就该走
// `$line-height-heading` / `$line-height-hero` / `$line-height-display` 三档 token。
// 写成 `line-height: 22px` 的后果是**行高与字号脱钩**：字号一改文字就偏，
// 而且「一屏一个像素值」会重新散进每个页面。
//
// ⚠️ 例外只有 token 定义处（`_variables.scss` 的三档 px 行高）、`_mixins.scss`
// 的共享 mixin（它已经收敛成比例），以及 `app.scss` 里 Vant 的
// `--button-line-height` / `--cell-line-height`（那是**第三方主题变量**，不是本仓库的行高）。
// 判据用后行断言排除 `--xxx-line-height` 形态的自定义属性。
let lastLineHeightOffenders = []
checkTrue(
  '页面 / 组件 SCSS 不出现像素行高（一律无单位比例或 token）',
  (() => {
    const offenders = []
    for (const file of collect(miniprogramDir, ['.scss'])) {
      const relativePath = relative(repoRoot, file)
      if (relativePath.endsWith(join('styles', '_variables.scss'))) continue
      if (relativePath.endsWith(join('styles', '_mixins.scss'))) continue
      if (relativePath === relative(repoRoot, appScssPath)) continue
      const lines = blankComments(readFileSync(file, 'utf8')).split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        if (/(?<![\w-])line-height\s*:\s*[\d.]+px/.test(lines[i] ?? '')) {
          offenders.push(`${relativePath}:${i + 1}  ${(lines[i] ?? '').trim()}`)
        }
      }
    }
    lastLineHeightOffenders = offenders
    return offenders.length === 0
  })(),
  lastLineHeightOffenders.map((x) => `  • ${x}`).join('\n'),
)

// ---------- 第 14 条：app.scss 的 Vant 主题映射（#59 起强制） ----------
// spec §12：12 组组件的变量按表映射；值必须来自 `_variables.scss`（用 `#{}` 插值），
// 不允许在 app.scss 里抄第二份色值。这里逐项断言 **变量存在且引用正确 token**。
const VANT_THEME_VARIABLES = {
  // Button
  '--button-primary-background-color': '$color-primary-active',
  '--button-primary-border-color': '$color-primary-active',
  '--button-primary-color': '$color-bg-card',
  '--button-border-radius': '$radius-control',
  '--button-default-height': '48px',
  '--button-large-height': '48px',
  '--button-default-font-size': '$font-size-title',
  '--button-normal-font-size': '$font-size-body',
  '--button-line-height': '24px',
  '--button-plain-background-color': '$color-bg-card',
  // Cell
  '--cell-background-color': '$color-bg-card',
  '--cell-text-color': '$color-text-main',
  '--cell-font-size': '$font-size-body',
  '--cell-line-height': '22px',
  '--cell-vertical-padding': '14px',
  '--cell-horizontal-padding': '$spacing-lg',
  '--cell-label-color': '$color-text-sub',
  '--cell-label-font-size': '$font-size-aux',
  '--cell-value-color': '$color-text-sub',
  '--cell-right-icon-color': '$color-text-weak',
  '--cell-active-color': '$color-bg-page',
  // CellGroup
  '--cell-group-inset-border-radius': '$radius-card',
  '--cell-group-title-color': '$color-text-sub',
  '--cell-group-title-font-size': '$font-size-aux',
  // Field
  '--field-label-color': '$color-text-sub',
  '--field-input-text-color': '$color-text-main',
  '--field-placeholder-text-color': '$color-text-weak',
  '--field-input-error-text-color': '$color-danger-ink',
  '--field-error-message-color': '$color-danger-ink',
  '--field-error-message-text-font-size': '$font-size-aux',
  // Popup
  '--popup-background-color': '$color-bg-card',
  '--popup-round-border-radius': '$radius-sheet',
  // Overlay
  '--overlay-background-color': '$color-overlay',
  // Dialog
  '--dialog-border-radius': '$radius-sheet',
  '--dialog-background-color': '$color-bg-card',
  '--dialog-header-font-weight': '$font-weight-semibold',
  // Toast（底色是 spec §12 指定的半透明深色，无对应 token）
  '--toast-background-color': 'rgba(0, 0, 0, 0.72)',
  '--toast-border-radius': '$radius-control',
  '--toast-text-color': '$color-bg-card',
  '--toast-font-size': '$font-size-body',
  // NavBar
  '--nav-bar-background-color': '$color-bg-card',
  '--nav-bar-title-text-color': '$color-text-main',
  '--nav-bar-icon-color': '$color-text-main',
  '--nav-bar-text-color': '$color-text-main',
  '--nav-bar-title-font-size': '$font-size-title',
  // Search
  '--search-background-color': '$color-bg-page',
  '--search-input-height': '36px',
  '--search-label-color': '$color-text-main',
  '--search-left-icon-color': '$color-text-weak',
  '--search-action-text-color': '$color-primary-active',
  // SubmitBar
  '--submit-bar-background-color': '$color-bg-card',
  '--submit-bar-text-color': '$color-text-main',
  '--submit-bar-text-font-size': '$font-size-body',
  '--submit-bar-height': '64px',
  '--submit-bar-padding': ['$spacing-sm', '$spacing-lg'],
  '--submit-bar-button-height': '48px',
  '--submit-bar-button-width': '160px',
  // Loading
  '--loading-spinner-color': '$color-primary-active',
  '--loading-text-color': '$color-text-sub',
}

checkTrue('app.scss 存在（Vant 主题的唯一落点）', existsSync(appScssPath))
const appScss = existsSync(appScssPath) ? readFileSync(appScssPath, 'utf8') : ''
checkTrue(
  'app.scss 用 @use 引入 token（不抄第二份色值）',
  /@use\s+['\"]\.\/styles\/variables['\"]\s+as\s+v;/.test(appScss),
)
const appScssNoComments = appScss
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/gm, '$1')
checkTrue(
  'app.scss 不出现裸 hex',
  !/#[0-9a-f]{3,8}\b/i.test(appScssNoComments),
  (appScssNoComments.match(/#[0-9a-f]{3,8}\b/gi) ?? []).join(', '),
)

// 所有变量必须在 `page { ... }` 里（Vant 全局主题的官方落点）。
const pageBlockMatch = /(^|\n)page\s*\{([\s\S]*?)\n\}/.exec(appScss)
const pageBlock = pageBlockMatch?.[2] ?? ''
checkTrue('app.scss 存在 page { ... } 主题块', pageBlock.length > 0)

for (const [prop, expected] of Object.entries(VANT_THEME_VARIABLES)) {
  const line = pageBlock
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith(`${prop}:`))
  checkTrue(`page 块声明 ${prop}`, line !== undefined, `未找到 ${prop}`)
  if (line !== undefined) {
    const expectedParts = Array.isArray(expected) ? expected : [expected]
    checkTrue(
      `${prop} 的值来自 ${expectedParts.join(' + ')}`,
      expectedParts.every((part) => line.includes(part)),
      `实际：${line}`,
    )
  }
}

// 四处 Vant 写死、无变量可用的类覆盖（spec §12）。
const classOverrides = [
  ['.van-empty__description', 'color', '$color-text-sub'],
  ['.van-cell::after', 'border-bottom-color', '$color-border'],
  ['.van-search__content', 'border-radius', '$radius-control'],
  ['.app-popup-shadow', 'box-shadow', '$shadow-sheet'],
  ['.app-submit-bar-shadow', 'box-shadow', '$shadow-bar'],
]
for (const [selector, property, tokenName] of classOverrides) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(appScss)?.[1] ?? ''
  checkTrue(`存在类覆盖 ${selector}`, block.length > 0, `未找到 ${selector}`)
  if (block.length > 0) {
    // SCSS 里写作 `v.$token`；去掉 `v.` 后按裸 token 名匹配，避免把引用写死成一种形式。
    const blockWithoutNamespace = block.replace(/v\./g, '')
    checkTrue(
      `${selector} 的 ${property} 引用 ${tokenName}`,
      new RegExp(`${property}\\s*:\\s*${tokenName.replace(/\$/g, '\\$')}`).test(blockWithoutNamespace),
      `实际：${block.trim()}`,
    )
  }
}

// ---------- 报告 ----------
if (failures.length === 0) {
  console.log(`✅ 视觉 token 验收全过（${checks} 条断言）`)
  process.exit(0)
}
console.error(`❌ 视觉 token 验收失败：${failures.length} / ${checks} 条\n`)
for (const f of failures) console.error(`  • ${f}\n`)
process.exit(1)
