// **启动闸门**的工程约束守卫 —— issue #20 剩下的几条 Acceptance criteria。
//
// 与 `test/request/conventions.test.ts` 同一取向：这几条是**关于代码形状**的约束，
// 不是运行时行为 —— 「失败出口是唯一的」「文案不出现错误码」「骨架屏不用裸 hex」
// 「不做本地业务数据缓存」。行为测试测不到它们（一个页面自己再写一份失败态，
// 功能上照样能通），所以只能读源码。
//
// 判据一律取**剥离注释后**的源码 —— 注释里提「错误码」是必要的契约说明
// （本文件的主题就是它），不该被当成违规。
//
// 出处：`docs/spec/01-entry-and-identity.md` §3.2 / §4、`docs/spec/09-copy-and-status.md`
// §7.1 / §7.2、`docs/spec/10-visual-language.md` §6 / §8。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  DATA_AREA_PLACEHOLDER_HINT,
  DATA_AREA_PLACEHOLDER_TITLE,
  EMPTY_STATES,
  FAILURE_DETAIL,
  FAILURE_TITLE,
  PAGE_TITLES,
  RETRY_LABEL,
  ORDER_LIST_PATH,
  STATIC_EXITS,
} from '../../miniprogram/startup/copy'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const miniprogramDir = join(repoRoot, 'miniprogram')
const startupDir = join(miniprogramDir, 'startup')
const componentsDir = join(miniprogramDir, 'components')
const pagesDir = join(miniprogramDir, 'pages')

/** 递归收集某目录下指定后缀的全部文件（跳过 node_modules）。 */
function collect(dir: string, extensions: readonly string[]): string[] {
  const found: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue
      found.push(...collect(full, extensions))
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      found.push(full)
    }
  }
  return found
}

/** 剥掉注释后的源码 —— 源码层面的断言都读它。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}

/** 相对仓库根的展示路径，失败信息里用。 */
function rel(path: string): string {
  return relative(repoRoot, path)
}

const allSources = (): string[] => collect(miniprogramDir, ['.ts', '.wxml', '.scss', '.json'])

/**
 * **用户可见的全部文案**字面量。
 *
 * ⚠️ 刻意**不**手写一份「页面里出现过哪些字符串」的清单：手写的那一份会在「有人往
 * `copy.ts` 加一句新文案」时悄悄落后于实现，而落后的那一刻守卫就只剩一个假象
 * （本文件第一版正是这么翻车的 —— 见下面那条断言里的说明）。
 *
 * ⚠️⚠️ **但「反推」这一步本身仍是手写的** —— 下面这个数组就是一个手工维护的清单，
 * 只是它的**每一项取值**来自 `copy.ts` 的导出（改了 `copy.ts` 的取值，这里自动跟着变；
 * 但**往 `copy.ts` 新增一个导出**，这里不会自动多一项）。
 * `#22` 的 review 正是抓到了这个缝：那一票往 `copy.ts` 加了 `PAGE_TITLES`，
 * 却没人想起把它的值加进来 —— 于是 `pages/index/index.wxml` 里写死的「我的订单」
 * **一路绿灯**通过，而它恰是那一票刚收进 `PAGE_TITLES` 的同一个字符串。
 *
 * ⇒ 结论：**新增导出时必须回来加一次**。`test/startup/skeleton.test.ts` 里有一条
 * 「`PAGE_TITLES` 的值不得在别处以字面量出现」的断言作为第二道网 ——
 * 但两道网都要有人补，**别再假设它是自动的**。
 *
 * 构成：三个失败出口的字符串常量 + `STATIC_EXITS` 每一项的 `label`
 * + 数据区占位那两句 + `PAGE_TITLES` 的每一个标题 + `EMPTY_STATES` 的每一句。
 */
const USER_VISIBLE_COPY_LITERALS: readonly string[] = [
  FAILURE_TITLE,
  FAILURE_DETAIL,
  RETRY_LABEL,
  ...STATIC_EXITS.map((exit) => exit.label),
  DATA_AREA_PLACEHOLDER_TITLE,
  DATA_AREA_PLACEHOLDER_HINT,
  // ⚠️ `PAGE_TITLES` 的值 —— `#22` 新增的导出（见上方说明：新增导出必须回来补一次）。
  ...Object.values(PAGE_TITLES),
  // ⚠️ `EMPTY_STATES` 的每一句 —— `#23` 新增的导出。
  // 空态的三组文案都是用户可见的字，必须能在 `09` §7.1 查到；
  // 把它们纳入这份清单，任何一句以字面量出现在 `empty-state` 组件或页面里都会被抓住。
  // ⚠️ 空串要滤掉：`scoreLogs` 的 `hint` / `actionLabel` 是**有意的缺省**，
  // 而 `code.includes('')` 恒为 true —— 留着它这条守卫会当场全红。
  ...Object.values(EMPTY_STATES).flatMap((state) => [state.title, state.hint, state.actionLabel]),
].filter((literal) => literal !== '')

describe('#20 失败出口是唯一的一份（01 §4）', () => {
  it('⚠️ 失败出口的**每一句**文案都不得在 `copy.ts` 之外以字面量出现', () => {
    // `01` §4 的原文：「**只有一个**，由启动态驱动，不下放到各页面的数据区。
    // 否则同一分支被复制 N 次，且会出现『有的页能重试、有的页不能』。」
    //
    // ⚠️⚠️ **这条断言的第一版是真空的，被 review 用变异测试抓出来了。**
    // 它当时只探「计费说明」这一个字符串 —— 于是「往 `pages/index/index.wxml` 里
    // 粘一份完整的失败出口（说明 + 重试 + 客服），但**不写**『计费说明』」
    // 这个最像真实退化路径的变异，15 条守卫**全绿**。
    // 教训：**用个别字符串当探针 = 只挡住写了那个词的复制**。
    //
    // ⇒ 现在的判据是**全部文案**（`USER_VISIBLE_COPY_LITERALS`，从 `copy.ts` 的导出**反推**出来，
    // 不是手工维护的第二份清单）：任何一句以字面量形式出现在 `copy.ts` 之外，就是又抄了一份。
    // 覆盖面因此从「1 个探针」变成「这一整套出口的每一个字」，
    // 且**新增文案时自动纳入**（这正是它不再真空的原因）。
    // ⚠️ **`app.json` 是唯一的例外，且它豁免的理由与别处不同。**
    // tabBar 的 `text`（「订单」/「我的」）是**原生配置**，与 tabBar 的三个颜色同理：
    // 它**引不到** `copy.ts`（那是 JSON，不是 JS，没有 import）。
    // 所以这不是「又抄了一份文案」，而是**只能写在这里的一份**。
    // ⇒ 代价是它与 `PAGE_TITLES['pages/profile/profile']` 有漂移空间，
    //   由 `skeleton.test.ts` 的断言钉住（那里同时读两处断言 tabBar 项与实际页面标题一致）。
    // 豁免必须**逐字面写死这个路径**，不能用「后缀是 .json 就放过」这类宽判据 ——
    // 那会连页面自己的 `.json` 一起放过，而页面 `.json` 里**不该**有文案。
    const appJsonPath = join(miniprogramDir, 'app.json')
    const offenders: string[] = []
    for (const file of allSources()) {
      if (file === join(startupDir, 'copy.ts')) continue
      if (file === appJsonPath) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const literal of USER_VISIBLE_COPY_LITERALS) {
        if (code.includes(literal)) offenders.push(`${rel(file)} → 「${literal}」`)
      }
    }

    expect(
      offenders,
      `以下位置把失败出口的文案写成了字面量 —— 它只有 startup/copy.ts 一个家，` +
        `唯一的呈现处是 components/failure-exit/（01 §4：失败出口只有一个，不下放到数据区）：\n` +
        offenders.map((f) => `  • ${f}`).join('\n'),
    ).toEqual([])
  })

  it('⚠️ 失败出口的**结构**（三要素）只在一处 wxml 里定义', () => {
    // 上一条挡的是「文案被抄走」，这一条挡的是「**结构**被抄走」——
    // 一个复制粘贴的失败出口即使用 `{{ }}` 从常量读文案（因此躲过上面那条），
    // 它仍然是把 `01` §4 的「说明 + 重试 + 静态出口」这套形状复制了第二遍，
    // 而那正是 §4 要防的（「有的页能重试、有的页不能」）。
    //
    // ⚠️ 判据必须分清**引用**与**重写**：
    //   • 引用 → `<failure-exit bind:retry="onRetry" />` —— 这是**正确用法**；
    //   • 重写 → 自己画 `<view class="failure-exit__title">` + 一个重试 `<button>`。
    // 只看「有 bind:retry 且提到 failure-exit」会把正确用法也判成违规（本断言的
    // 第一版就是这么假失败的）。
    //
    // ⇒ 判据取**失败出口内部的 class 名**（`failure-exit__*`，BEM 的 element 部分）：
    // 那是只有**重写**它的人才会写出来的东西。引用者只会写标签名 `failure-exit`，
    // 永远不会写 `failure-exit__title`。
    const offenders: string[] = []
    for (const file of allSources()) {
      if (!file.endsWith('.wxml')) continue
      if (file.startsWith(join(componentsDir, 'failure-exit'))) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      if (/failure-exit__/.test(code)) offenders.push(rel(file))
    }

    expect(
      offenders,
      `以下 wxml 自己画了失败出口的内部结构（出现了 failure-exit__* 的 class）—— ` +
        `失败出口只有一个定义处，页面只该 <failure-exit /> 引用它（01 §4）：\n` +
        offenders.map((f) => `  • ${f}`).join('\n'),
    ).toEqual([])
  })

  it('⚠️ 失败出口的文案常量在 `startup/copy.ts` 定义，且与 09 §7.2 定稿逐字一致', () => {
    // `09` §7.2 的全局失败出口那一行是**定稿逐字**。把它钉成断言，
    // 是因为它极易在「顺手润色一下」里被改掉 —— 而改文案要过 `09` §5 的流程。
    expect(FAILURE_TITLE).toBe('暂时连不上')
    expect(FAILURE_DETAIL).toBe('请检查网络后重试')
    expect(RETRY_LABEL).toBe('重试')
    expect(STATIC_EXITS.map((exit) => exit.label)).toEqual(['计费说明', '常见问题', '联系客服'])
  })

  it('⚠️ 失败出口的文案里不出现错误码、不出现「鉴权失败」这类术语', () => {
    // 本票的 Acceptance criteria 逐字：「失败出口的文案按 09 §7.3 的定稿，
    // **不出现错误码**、不出现「鉴权失败」这类术语」。
    // ⚠️ 判据是 `startup/` 里**所有**字符串字面量（含页面/组件从它读的那些），
    // 而不只是上面四个常量 —— 后来者加一个「错误码 8001」的常量也能被这条拦住。
    const copySource = readFileSync(join(startupDir, 'copy.ts'), 'utf8')
    const bannedTerms = ['鉴权', '黑名单', '封号', 'token', 'Token']
    for (const term of bannedTerms) {
      expect(stripComments(copySource), `copy.ts 里出现了术语「${term}」`).not.toContain(term)
    }
    // 数字错误码：四位数字字面量（8001 / 1004 / 2001……）。
    const codeLike = stripComments(copySource).match(/\b\d{4}\b/g) ?? []
    expect(codeLike, `copy.ts 里出现了像错误码的数字：${codeLike.join(', ')}`).toEqual([])
  })

  it('⚠️ 失败出口组件**不接** `UnifiedError` —— 拿不到错误码就画不出错误码', () => {
    // 「不出现错误码」这条最可靠的实现方式不是「记得别画」，而是**组件根本拿不到它**。
    // 若失败出口接一个 `error` 属性，某一个后来者顺手画一行 `{{ error.code }}`
    // 就能通过上面所有文案断言（那不是字面量，是插值）。
    const componentSources = collect(join(componentsDir, 'failure-exit'), ['.ts', '.wxml'])
    for (const file of componentSources) {
      const code = stripComments(readFileSync(file, 'utf8'))
      expect(code, `${rel(file)} 引了 UnifiedError / request 层 —— 失败出口不该拿得到错误对象`).not.toMatch(
        /UnifiedError|from\s+['"][^'"]*request[^'"]*['"]/,
      )
      // `code` / `httpStatus` / `kind` 这三兄弟只要出现在模板插值里就是漏了错误码。
      expect(code, `${rel(file)} 的模板里出现了错误对象字段插值`).not.toMatch(
        /\{\{[^}]*\b(error|httpStatus|kind)\b[^}]*\}\}/,
      )
    }
  })

  it('⚠️ 静态出口三件套是**同一份内容** —— 「我的」页实现时不得另写一份（01 §4）', () => {
    // `01` §4：「静态出口（计费说明 / 常见问题 / 联系客服 —— 与 §5 同一份内容，
    // 两条路一份内容）」。本票把「我的」页那份**没有**实现（不在本票范围），
    // 所以这条守卫此刻只断言「上游没有第二份」。它会在「我的」页落地时
    // 变成一条真正拦人的断言 —— 而那正是它该在的位置。
    //
    // ⚠️ 它**不再逐个探字符串**（上面那条「每一句文案」的守卫已经覆盖了字面量），
    // 而是断言一份**独立的、清单式的**事实：静态出口三件套只有 `copy.ts` 一个来源。
    // 两句同为「唯一」，但一句管文案的**字面量**、一句管这份**内容清单**的出处 ——
    // 后者在「我的」页落地时的价值是：它会逼那个实现者**复用** `STATIC_EXITS`，
    // 而不是在「我的」页里对照着写一份看起来一样的三个词。
    expect(STATIC_EXITS.map((exit) => exit.label)).toEqual(['计费说明', '常见问题', '联系客服'])
  })
})

describe('#20 骨架屏与失败出口的视觉约束（10 §6 / §8）', () => {
  it('⚠️ 骨架屏不使用 10 之外的裸 hex —— 一行都不许有', () => {
    // 本票 Acceptance：「骨架屏不使用 10 之外的裸 hex」。`10` §6 禁令 5 / §8 第 6 条。
    // 判据：任何 `#rgb` / `#rrggbb` / `#rrggbbaa` 字面量。
    const offenders: string[] = []
    for (const file of collect(join(componentsDir, 'skeleton'), ['.scss', '.wxml'])) {
      const code = stripComments(readFileSync(file, 'utf8'))
      const hexes = code.match(/#[0-9a-f]{3,8}\b/gi) ?? []
      if (hexes.length > 0) offenders.push(`${rel(file)} → ${hexes.join(', ')}`)
    }

    expect(
      offenders,
      `骨架屏里出现了裸 hex —— 一律引 styles/ 的 token（10 §6 禁令 5）：\n` +
        offenders.map((f) => `  • ${f}`).join('\n'),
    ).toEqual([])
  })

  it('⚠️ 骨架屏**不得放「加载中」文字盖住骨架**（09 §7.1 逐字禁令）', () => {
    // `09` §7.1 的原文：「骨架屏 | **纯图形占位，无文字。**」+「⚠️ 不得放『加载中』
    // 文字盖住骨架」。
    // 判据比那一句更严一点：骨架屏组件的 wxml 里**不得有任何文本节点**。
    // 严格是刻意的 —— 「加载中…」只是最显眼的那一个，而任何文字都违反「无文字」。
    const wxml = stripComments(readFileSync(join(componentsDir, 'skeleton', 'skeleton.wxml'), 'utf8'))
    // 去掉标签与自闭合标签后，剩下的应当是纯空白。
    const textNodes = wxml
      .replace(/<[^>]*>/g, '')
      .replace(/\s/g, '')
    expect(
      textNodes,
      `骨架屏的 wxml 里出现了文本节点（09 §7.1：纯图形占位，无文字）：\n    ${textNodes}`,
    ).toBe('')
  })

  it('⚠️ 失败出口与骨架屏的样式根节点都显式设了主文字色（10 §6 禁令 4）', () => {
    // `10` §6 禁令 4：页面容器不得依赖继承的文字色（device 曾因此白底对比度 1.23、
    // 整片看不见）。**值对**不等于**有人用了它** —— 这条断言的就是「有人用了它」。
    for (const name of ['skeleton', 'failure-exit']) {
      const scss = stripComments(readFileSync(join(componentsDir, name, `${name}.scss`), 'utf8'))
      // 根节点规则体（`.skeleton { ... }`）里必须有一条 `color: v.$color-text-main`。
      // ⚠️ 用 [^}]* 而非 \s* —— 声明块里 `color` 不一定紧跟左花括号
      // （本文件的两处都在 `padding` / `display` 之后）。
      const rootBlock = new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`, 's').exec(scss)?.[1] ?? ''
      expect(
        rootBlock,
        `${name}.scss 的根节点没有显式设 $color-text-main（10 §6 禁令 4）—— ` +
          `实际规则体：\n${rootBlock}`,
      ).toMatch(/color:\s*v\.\$color-text-main/)
    }
  })

  it('⚠️ 语义色不做文字色 —— 骨架屏与失败出口不出现 `color: v.$color-{primary,warning,danger,info}`', () => {
    // `10` §6 禁令 1（承 V25）：语义色原值压白底全部低于 AA 4.5（2.19 / 2.90 / 2.66 / 3.08）。
    // 文字一律走 ink（由 mixin 施加，见 `10` §5 契约 3）。
    // ⚠️ 唯一合法的原值文字用法是「白字压语义色底」—— 那是 `color: $color-bg-card`，
    // 与这条断言不冲突。
    const offenders: string[] = []
    const roots = [join(componentsDir, 'skeleton'), join(componentsDir, 'failure-exit')]
    for (const root of roots) {
      for (const file of collect(root, ['.scss'])) {
        const code = stripComments(readFileSync(file, 'utf8'))
        const bad = code.match(/color:\s*v\.\$(color-(primary|warning|danger|info|success))\b/g) ?? []
        if (bad.length > 0) offenders.push(`${rel(file)} → ${bad.join(', ')}`)
      }
    }

    expect(
      offenders,
      `以下样式把语义色原值当文字色用了 —— 压白底过不了 AA，一律走 ink（10 §6 禁令 1）：\n` +
        offenders.map((f) => `  • ${f}`).join('\n'),
    ).toEqual([])
  })
})

describe('#20 不做本地业务数据缓存（01 §3.2）', () => {
  it('⚠️ 闸门、骨架屏、失败出口、首页都不读写 storage', () => {
    // `01` §3.2 的原文：「**不做本地业务数据缓存**：取件码与订单状态属『看到就必须是真的』
    // 的数据；缓存说谎（用户拿着过期取件码走到柜机前）比空白更糟。
    // **首屏加速靠骨架屏，不靠数据缓存**。」
    //
    // ⚠️ 判据落在**这几处新代码**上，而不是「全端零 storage」——
    // `request/token.ts` 本来就要写 token（那是登录身份，不是业务数据，
    // 由 `07` §4.4 定案）。把守卫钉在闸门链路上，既准确又不会随无关代码的增减而误报。
    // （quickstart 残留的 `pages/logs` 已由 #22 删除，此处不再有它的例外。）
    const guarded = [
      ...collect(startupDir, ['.ts']),
      ...collect(join(componentsDir, 'skeleton'), ['.ts']),
      ...collect(join(componentsDir, 'failure-exit'), ['.ts']),
      join(pagesDir, 'index', 'index.ts'),
    ]
    const offenders: string[] = []
    for (const file of guarded) {
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const api of ['getStorageSync', 'setStorageSync', 'removeStorageSync', 'getStorage']) {
        if (new RegExp(`\\bwx\\s*\\.\\s*${api}\\b`).test(code)) offenders.push(`${rel(file)} → wx.${api}`)
      }
    }

    expect(
      offenders,
      `闸门链路上出现了 storage 读写 —— 不做本地业务数据缓存（01 §3.2）：\n` +
        offenders.map((f) => `  • ${f}`).join('\n'),
    ).toEqual([])
  })

  it('⚠️ 闸门的 ready 态不携带业务数据 —— 状态里只有 phase', () => {
    // 「不做缓存」不只在 storage 那一层：把登录时刻的快照挂到闸门状态上，
    // 等于开了一个「把快照当业务数据用」的口子（`04` §5 明令不做本地 status 快照）。
    // 这条由 `test/startup/gate.test.ts` 的行为断言覆盖（ready 态 `toEqual({phase})`），
    // 这里从**源码**再确认一次类型定义里没有别的字段。
    const gateSource = stripComments(readFileSync(join(startupDir, 'gate.ts'), 'utf8'))
    // `ready` 那一支必须恰好是 `{ phase: 'ready' }`。
    expect(gateSource, "StartupState 的 ready 支携带了额外字段").toMatch(
      /\{\s*phase:\s*'ready'\s*\}/,
    )
    // 且不得出现任何 user / score / status 之类的业务字段读法。
    for (const field of ['user', 'score', 'status']) {
      expect(gateSource, `gate.ts 里出现了业务字段「${field}」`).not.toMatch(
        new RegExp(`\\.\\s*${field}\\b`),
      )
    }
  })
})

describe('#20 闸门链路的工程约束（07 §3 / §6）', () => {
  it('⚠️ `pages/` 与 `components/` 不出现 `wx.request` —— 唯一 HTTP 出口不破', () => {
    // 承 `07` §3 硬规则 1（`test/request/conventions.test.ts` 已有全端守卫）。
    // 这里在新代码上再钉一次，是为了让违规信息直接指向本票的文件。
    const offenders: string[] = []
    for (const dir of [pagesDir, componentsDir]) {
      for (const file of collect(dir, ['.ts'])) {
        const code = stripComments(readFileSync(file, 'utf8'))
        if (/\bwx\s*\.\s*request\b/.test(code)) offenders.push(rel(file))
      }
    }

    expect(offenders, `页面/组件里出现了 wx.request（07 §3 硬规则 1）：${offenders.join(', ')}`).toEqual([])
  })

  it('⚠️ 首页不 import 请求层 —— 页面只与闸门打交道', () => {
    // `07` §3 的分层是 `pages/ → api/ → request/`，且「登录失效怎么办 → 不用管，
    // 请求层已处理」（§8 的自查表）。首页若直接 import `request/`，它就绕过了 `api/`
    // 这层搬运 —— 而且暗示页面自己在管登录态，而那归闸门（`01` §4 由启动态驱动）。
    const code = stripComments(readFileSync(join(pagesDir, 'index', 'index.ts'), 'utf8'))
    expect(code, `首页 import 了请求层 —— 页面应与闸门/ api 打交道（07 §3）`).not.toMatch(
      /from\s+['"][^'"]*request[^'"]*['"]/,
    )
  })

  it('⚠️ 闸门不引 store，也不碰 `App.globalData`', () => {
    // `07` §6：「不引任何 store」；`globalData` 仅限请求层自身需要的少量值。
    // 闸门的飞行态放在**模块级闭包**里（见 `gate.ts` 的 `inFlight`），
    // 它不需要 `globalData` —— 多一处全局可变状态就多一处生命周期问题。
    const code = stripComments(readFileSync(join(startupDir, 'gate.ts'), 'utf8'))
    expect(code, 'gate.ts 碰了 globalData —— 飞行态放在模块闭包里即可（07 §6）').not.toMatch(
      /globalData/,
    )

    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(pkg.dependencies ?? {}, '一期不引任何运行时依赖（07 §2）').toEqual({})
  })

  it('⚠️ `startup/` 不依赖 `pages/` 或 `components/` —— 依赖方向单向', () => {
    // `startup/` 是被页面依赖的那一层（闸门与文案）。若它反过来 import 页面或组件，
    // 就构成模块循环 —— 与 #19 修掉的 `request ⇄ api` 同一类问题，
    // 且同样**不会在类型上报错**，只在某个模块求值期突然显形。
    const offenders: string[] = []
    for (const file of collect(startupDir, ['.ts'])) {
      const code = stripComments(readFileSync(file, 'utf8'))
      if (/from\s+['"][^'"]*\/(pages|components)\//.test(code)) offenders.push(rel(file))
    }

    expect(offenders, `startup/ 依赖了上层（07 §3 单向依赖）：${offenders.join(', ')}`).toEqual([])
  })
})

describe('#23 `wx.switchTab` 的目标确实是 tabBar 的一项（01 §2.4）', () => {
  it('⚠️ `ORDER_LIST_PATH` 是 `app.json` 里真实注册的 tabBar 页', () => {
    // `01` §2.4:57 逐字：柜机页顶部固定一个「我的订单」出口，**走 `wx.switchTab` 到订单 tab**。
    //
    // ⚠️⚠️ 这条断言挡的是一个**静默失败**：`wx.switchTab` 的 url 必须是
    // `tabBar.list[].pagePath` 之一，写错一个字符**不跳转、不报错** ——
    // 症状与 #23 要修的那个死按钮**一模一样**，只是更难查（调用发生了，画面没动）。
    //
    // 那个路径在 `app.json` 里有一份（JSON 引不到 TS）、在 `copy.ts` 里有一份，
    // 两处都可能被改。这条断言是**唯一**把它们扣在一起的地方。
    const appJson = JSON.parse(readFileSync(join(miniprogramDir, 'app.json'), 'utf8')) as {
      pages: string[]
      tabBar: { list: { pagePath: string }[] }
    }
    const tabPaths = appJson.tabBar.list.map((item) => item.pagePath)

    expect(tabPaths, '订单必须是 tabBar 的第一项（01 §2.3）').toContain(ORDER_LIST_PATH)
    expect(appJson.pages, 'ORDER_LIST_PATH 不在 pages 注册表里').toContain(ORDER_LIST_PATH)
    // ⚠️ `wx.switchTab` 的 url 拼成 `/${ORDER_LIST_PATH}` —— 断言拼出来的那个串
    // 与 app.json 里的字面路径**逐字相同**（而不是「归一化之后相同」）。
    expect(`/${ORDER_LIST_PATH}`).toBe(`/${tabPaths[0]}`)
  })

  it('⚠️ **`wx.switchTab` 的 url**不得由别处拼出来 —— 那是最像静默失败的一处', () => {
    // `wx.switchTab` 的 url 是**静默失败**那一类（见上）。若某个页面自己拼一份
    // `url: '/pages/index/index'`，改路径时它会悄悄留旧值 —— 而那正是
    // `ORDER_LIST_PATH` 这个常量存在的理由。
    //
    // ⚠️⚠️ **判据必须收窄到「跳转的 url」，不能是「这个串出现在任何地方」。**
    // 第一版就是宽判据（`code.includes('pages/index/index')`），它当场抓到了
    // `pages/index/index.ts` —— 而那里出现这个串是**完全正当**的：
    // `PAGE_TITLES['pages/index/index']` 是**用页面自己的路径当键查标题**，
    // 与「往订单 tab 跳」是两件事。宽判据会逼着后来者为了消红灯去绕开一个正确的写法，
    // 而守卫一旦逼人绕路，下一个人就会直接删掉它。
    // ⇒ 只认**跳转 API 的 url 参数**里出现的那个串。`PAGE_TITLES` 的键不受影响。
    const offenders: string[] = []
    for (const file of allSources()) {
      // `app.json` 是原生配置（JSON 引不到 TS，只能写在那里）；`copy.ts` 是它的家。
      if (file === join(miniprogramDir, 'app.json')) continue
      if (file === join(startupDir, 'copy.ts')) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      // 形如 `url: '/pages/index/index'` 或 `url: \`/${ORDER_LIST_PATH}\`` 之外的硬编码。
      const hardCoded = new RegExp(`url\\s*:\\s*['"\`]/?${ORDER_LIST_PATH}\\b`)
      if (hardCoded.test(code)) offenders.push(rel(file))
    }

    expect(
      offenders,
      `以下位置把订单列表的页面路径写死进了跳转 url —— 它只有 copy.ts 的 ORDER_LIST_PATH ` +
        `一个家，写错一个字符就是 wx.switchTab 的静默失败（01 §2.4）：\n` +
        offenders.map((f) => `  • ${f}`).join('\n'),
    ).toEqual([])
  })
})
