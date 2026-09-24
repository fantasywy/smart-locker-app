// `miniprogram/types/auth.ts` 的**类型层**验收 —— issue #17 的每条 Acceptance criteria
// 落成一条可执行断言。
//
// 为什么「类型」要写成测试：`07` §7 的类型层唯一可判定的产出就是「编译器怎么看它」，
// 而这个文件里最值钱的几条（`13.2` 没有 `refreshToken`、`nickname` 是 `| null`）
// 全都是**「编译器必须拦住某种写法」**——只在源码上盯一眼是拦不住的。
// 做法是 `tsc` 当判官（`compileProbe()`），断言方式沿用仓库既有出口
// `pnpm test`，于是类型层与 `test/` 下的行为测试**一条命令跑完**（#15 decision 24）。
//
// 断言风格承 `scripts/verify-visual-tokens.mjs`：**把 spec 里的每条事实落成一条断言、
// 失败时打印出违反的是哪一条规则**。差别是这里的「每条事实」由 TS 编译器裁定 ——
// `@ts-expect-error` 在**没有**报错时自己会变成一条 TS2578，于是「必须不能通过」与
// 「必须能通过」两个方向都由退出码承载，没有一条是空跑的。
// （本文件每条守卫都做过变异验证：把 DTO 改坏，对应的那条断言确实会红。）

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const dtoPath = join(repoRoot, 'miniprogram/types/auth.ts')
const dtoSource = readFileSync(dtoPath, 'utf8')

/**
 * 契约源。它是**兄弟仓库** `java/smart-locker` 的产物，不在本仓库 —— 与 `docs/research/R1`
 * 引用它的方式一致（绝对路径）。缺席时行号核对跳过，见那条测试里的注释。
 */
const contractPath = '/home/fantasywy/codes/java/smart-locker/docs/API设计文档.md'

/** 一个一次性的 TS program —— 只装本文件的用例，不碰仓库的 include。 */
const probeDir = mkdtempSync(join(tmpdir(), 'auth-dto-probe-'))

afterAll(() => {
  rmSync(probeDir, { recursive: true, force: true })
})

/**
 * 用**与小程序构建同一套** compilerOptions 编译一段用例代码，返回 TS 的诊断输出。
 *
 * 为什么不直接 `tsc -p tsconfig.json` 了事：那样只能证明「仓库现在编译得过」，
 * 证明不了「契约里写死的那几条约束真的被类型层挡住了」—— 比如「`13.2` 没有 `refreshToken`」
 * 这条，必须**主动写一句 `data.refreshToken` 并期待它报错**才算验到。
 *
 * 做法：把用例文件放进只 `include` 它自己的临时 program，`extends` 仓库根配置 ——
 * strict / strictNullChecks / noUnusedLocals 全部照旧生效，且不污染仓库目录。
 */
function compileProbe(code: string): string {
  writeFileSync(join(probeDir, 'auth-dto.probe.ts'), code, 'utf8')
  const tsconfigPath = join(probeDir, 'tsconfig.json')
  writeFileSync(
    tsconfigPath,
    JSON.stringify({
      extends: join(repoRoot, 'tsconfig.json'),
      include: ['./auth-dto.probe.ts'],
      exclude: [],
    }),
    'utf8',
  )

  const tsc = join(repoRoot, 'node_modules/.bin/tsc')
  try {
    const stdout = execFileSync(tsc, ['-p', tsconfigPath, '--noEmit', '--pretty', 'false'], {
      encoding: 'utf8',
      cwd: repoRoot,
    })
    return stdout
  } catch (error) {
    // `tsc` 只在有诊断时以非 0 退出；诊断本身在 stdout 上，正是我们要读的东西。
    const failure = error as { stdout?: string; stderr?: string }
    return `${failure.stdout ?? ''}${failure.stderr ?? ''}`
  }
}

/** 剥掉注释后的源码 —— 源代码层面的断言（禁用 `wx.*`、禁中文映射）都读它。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * 把 DTO 编译成 JS 并读回来（**剥掉注释**）。
 *
 * 纯类型模块编译后应当是**空的** —— 这条断言比「源码里搜不到 `wx.request`」更强：
 * 它证明这个模块在运行期**不产出任何代码**，因此不可能发出请求。
 */
async function compiledJs(): Promise<string> {
  const ts = await import('typescript')
  const output = ts.transpileModule(dtoSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      // ⚠️ 必须显式 removeComments：tsc 默认保留注释，而本模块**整份都是注释 + 类型声明**，
      // 不清掉的话「编译结果是空的」这条断言会被自己的文档注释撑满。
      // 剥注释在这里是**定义**而不是偷懒：我们断言的是「运行期有没有代码」。
      removeComments: true,
    },
    fileName: 'auth.ts',
  })
  return output.outputText.trim()
}

describe('#17 类型层：13.1 / 13.2 的 DTO 形状由编译器裁定', () => {
  it('契约要求的字段齐全、类型与可空性正确（strict 下全绿）', () => {
    // 这段代码**必须**编译通过。任何一处与契约不符（少字段、`| null` 漏标、
    // 枚举值拼错）都会在这里变成一条 TS 诊断，测试随之失败。
    const diagnostics = compileProbe(`
import type { LoginRequest, LoginResponse, RefreshResponse, UserStatus } from '${dtoPath.replace(/\.ts$/, '')}'

// ── 13.1 请求：code 必填，nickname / avatar / phone 可选 ──
const minimal: LoginRequest = { code: 'wx-code' }
const full: LoginRequest = {
  code: 'wx-code',
  nickname: '小明',
  avatar: 'https://example.com/a.png',
  phone: '13900000000',
}

// ── 13.1 响应：user 的 nickname / avatar / phone 在类型上显式 | null ──
const nulled: LoginResponse = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresIn: 7200,
  user: { id: 88, nickname: null, avatar: null, phone: null, score: 100, status: 'NORMAL' },
}
const filled: LoginResponse = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresIn: 7200,
  user: { id: 88, nickname: '小明', avatar: 'https://example.com/a.png', phone: '139', score: 95, status: 'BLACKLISTED' },
}

// ── 13.2 响应：只有 accessToken / expiresIn ──
const refreshed: RefreshResponse = { accessToken: 'access-2', expiresIn: 7200 }

// ── user.status 的枚举与后端逐字一致：只有 NORMAL / BLACKLISTED ──
const normal: UserStatus = 'NORMAL'
const blacklisted: UserStatus = 'BLACKLISTED'

void [minimal, full, nulled, filled, refreshed, normal, blacklisted]
`)
    expect(diagnostics).toBe('')
  })

  it('13.1 的 code 是必填 —— 缺了必须编译不过', () => {
    const diagnostics = compileProbe(`
import type { LoginRequest } from '${dtoPath.replace(/\.ts$/, '')}'
// @ts-expect-error 契约 §13.1 (:924)：code 必填，缺了不该编译过
const missingCode: LoginRequest = { nickname: '小明' }
void missingCode
`)
    expect(diagnostics).toBe('')
  })

  it('13.1 的 user.nickname / avatar / phone 可空 —— 但不可省、不可塞 undefined', () => {
    // 两件事一次验到：① 标了 | null 的字段**必须显式写出来**（也就无法被 strict 忽略）；
    // ② 可空是 `| null`，**不是**可选 —— `undefined` 不是契约里的形状。
    const diagnostics = compileProbe(`
import type { LoginUser } from '${dtoPath.replace(/\.ts$/, '')}'
// @ts-expect-error 可空字段仍须显式给出（契约 §13.1 :934 里它们是 null，不是缺失）
const omitted: LoginUser = { id: 88, score: 100, status: 'NORMAL' }
// @ts-expect-error 可空是 | null，undefined 不在契约形状里
const undef: LoginUser = { id: 88, nickname: undefined, avatar: null, phone: null, score: 100, status: 'NORMAL' }
void [omitted, undef]
`)
    expect(diagnostics).toBe('')
  })

  it('13.2 响应没有 refreshToken —— 写上必须编译不过（契约不得凭空补字段）', () => {
    // 这条是 issue #17 点名的陷阱：类型层若「顺手补上」refreshToken，实现者就会写出
    // 「整个 data 覆盖回 token 结构」的写法，把 refresh 覆盖成 undefined。
    const diagnostics = compileProbe(`
import type { RefreshResponse } from '${dtoPath.replace(/\.ts$/, '')}'
// @ts-expect-error 契约 §13.2 (:943)：响应只有 { accessToken, expiresIn }
const invented: RefreshResponse = { accessToken: 'a', expiresIn: 7200, refreshToken: 'r' }
void invented
`)
    expect(diagnostics).toBe('')
  })

  it('user.status 只认 NORMAL / BLACKLISTED —— 别的字符串必须编译不过', () => {
    const diagnostics = compileProbe(`
import type { UserStatus } from '${dtoPath.replace(/\.ts$/, '')}'
// @ts-expect-error 枚举与后端逐字一致（§13.1 :939）；类型层不做任何别的取值
const invented: UserStatus = 'BANNED'
void invented
`)
    expect(diagnostics).toBe('')
  })
})

describe('#17 类型层：只写契约有的东西（07 §7 的规则落在源码上）', () => {
  it('每个 DTO 顶部带「契约：API设计文档.md §…(:行号)」出处注释', () => {
    // 出处可回查是「不得自造契约」在代码层的落地方式 —— `07` §7 规则 1。
    // 因此每个导出的 DTO 形状上都该有一条**带章节号与行号**的契约注释：
    // 章节号让规则可定位，行号让原文可回查（两者缺一，「可回查」就不成立）。
    const shapes = ['LoginRequest', 'LoginUser', 'LoginResponse', 'RefreshResponse']
    const contractAnnotation = /契约：[\s\S]*?§[\s\S]*?\(:\d+(?:-\d+)?\)/

    for (const shape of shapes) {
      // 取该 interface 的 JSDoc：「export interface X」往上的最近一个 `/** … */` 块。
      const declarationStart = dtoSource.indexOf(`export interface ${shape} {`)
      expect(declarationStart, `${shape} 在 ${dtoPath} 中不存在`).toBeGreaterThan(-1)
      const docStart = dtoSource.lastIndexOf('/**', declarationStart)
      const doc = dtoSource.slice(docStart, declarationStart)

      expect(
        contractAnnotation.test(doc),
        `${shape} 的文档注释缺少带 §章节与 (:行号) 的契约出处 —— 期望形如 ` +
          `「契约：API设计文档.md §13.1 (:929-939)」，实际注释为:\n${doc.trim()}`,
      ).toBe(true)
    }
  })

  it('契约出处的行号真的指得准 —— 打开被引文档逐条核对（「可回查」不是形状匹配就算数）', () => {
    // ⚠️ 上一条只校验注释的**形状**（有没有 `§…(:行号)`），一条把 `(:929-939)` 改成 `(:1-2)`
    // 的注释照样能过 —— 那样「出处可回查」（`07` §7 规则 1）就退化成了装饰。
    // 这条把行号**真的打开来读**：每个引用必须在契约源里命中它声称的那节。
    //
    // 契约源不在本仓库（它是 `java/smart-locker` 的产物），所以缺失时**跳过而不是失败** ——
    // 别人的机器上不该因为没 clone 后端而红。但只要它在，行号就必须对得上。
    if (!existsSync(contractPath)) {
      console.warn(`⚠️ 跳过行号核对：契约源不在 ${contractPath}（未 clone 后端仓库）`)
      return
    }

    const lines = readFileSync(contractPath, 'utf8').split('\n')
    /** 取 1-based 行号区间（含两端）。 */
    const slice = (start: number, end: number): string => lines.slice(start - 1, end).join('\n')

    // 逐条核对：本模块注释里出现的**每一处** `(:行号)` 引用都必须指向它声称的内容。
    // 左列是注释里的引用写法，右列是「该区间里必须出现的关键词」。
    const citations: readonly { label: string; from: number; to: number; mustContain: string }[] = [
      { label: '§1.4.2 access 2h / refresh 30 天', from: 60, to: 64, mustContain: 'refreshToken 默认 **30 天**' },
      { label: '§13 认证总则', from: 917, to: 917, mustContain: '除 13.1/13.2 外均需' },
      { label: '§13.1 请求体', from: 922, to: 927, mustContain: 'nickname/avatar/phone` 可选' },
      { label: '§13.1 响应 data', from: 929, to: 939, mustContain: '"refreshToken": "yyyy"' },
      { label: '§13.1 user 行（nickname/avatar/phone 可空）', from: 934, to: 934, mustContain: '"nickname"' },
      { label: '§13.1 规则（黑名单允许登录）', from: 939, to: 939, mustContain: '黑名单用户允许登录' },
      { label: '§13.2 刷新', from: 941, to: 943, mustContain: 'X-Refresh-Token' },
      { label: '§13.2 响应形状（无 refreshToken）', from: 943, to: 943, mustContain: '"expiresIn": 7200' },
      { label: '§15 错误码 8001', from: 1307, to: 1307, mustContain: '8001' },
    ]

    for (const { label, from, to, mustContain } of citations) {
      const text = slice(from, to)
      expect(
        text,
        `契约引用 ${label} 声称在 API设计文档.md :${from}${to === from ? '' : `-${to}`}，` +
          `但该区间里读不到它该讲的内容（期望含「${mustContain}」）。实际内容:\n${text}`,
      ).toContain(mustContain)
    }

    // 反向核对：`13.2` 的**响应**里没有 refreshToken —— 本票最关键的「不得凭空补字段」。
    // ⚠️ 不能直接对整行取反：那一行同时描述**请求头** `X-Refresh-Token: <refreshToken>`
    // （是 refresh 的**入参**，必须出现）和**响应** `{ accessToken, expiresIn }`。
    // 取反必须只落在响应那段上，否则这条守卫会因为请求头里的同名变量误报。
    const refreshLine = slice(943, 943)
    const responseShape = refreshLine.slice(refreshLine.indexOf('响应 `data`'))
    expect(responseShape, '§13.2 的响应描述没找到 —— 契约源结构变了，本守卫需重新对齐').not.toBe('')
    expect(
      responseShape,
      '§13.2 的响应里出现了 refreshToken —— 契约事实变了，RefreshResponse 需重新裁决',
    ).not.toContain('refreshToken')
  })

  it('不引入任何 HTTP 调用 —— 本票不发明请求（wx.request 零出现）', async () => {
    // ⚠️ 断言必须落在**剥离注释后**的源码上。本模块的注释里刻意写了 `wx.login`（它是 `code`
    // 的来源）与「不含 `wx.*` 调用」这句话 —— 那是契约说明，正是要保留的东西。
    // 「零出现」约束的是代码本身。
    const withoutComments = stripComments(dtoSource)
    expect(withoutComments).not.toMatch(/\bwx\b/)
    expect(withoutComments).not.toMatch(/request|fetch|Promise/)

    // 而且这一条由编译器兜底：本模块**不含任何需要编译的语句**，所以编译产物里只剩
    // CommonJS 的两行模块样板（`"use strict"` + `__esModule` 标记），没有任何函数体、
    // 没有任何 import。一个纯类型模块，是「本票不引入任何 HTTP 调用」最强的形态 ——
    // 它在运行期**不产出可执行的代码**，因此不可能发出任何东西。
    const js = await compiledJs()
    const executable = js
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && line !== '"use strict";' && !/^Object\.defineProperty\(exports, "__esModule"/.test(line))
    expect(executable, `DTO 编译出了可执行代码，本票不该有：\n${executable.join('\n')}`).toEqual([])
  })

  it('不带任何中文映射 —— 中文字面量只允许出现在注释里', () => {
    // `07` §7 规则 4：枚举的中文映射属 `09` 文案层，不进类型层。
    // 判据取「注释之外有没有中文字符串/模板字面量」，而不是「文件里有没有中文」——
    // 契约陷阱必须写在注释里，那正是本模块最值钱的部分。
    expect(stripComments(dtoSource)).not.toMatch(/['"`][^'"`]*[\u4e00-\u9fa5][^'"`]*['"`]/)
  })

  it('user.status 的 DTO 注释写明了「登录成功时也可能为 BLACKLISTED、不得事前阻断（04 §5）」', () => {
    // issue #17 要求这条陷阱**写进 DTO 注释**，而不是只活在票面里：后来者读到 `status` 时
    // 必须在同一屏看到「登录成功也可能是它」与「不得据此阻断」。
    // 断言读的是**该字段自己的 JSDoc**，不是整个文件 —— 否则这条会在别处提到 `04` 时空过。
    const fieldStart = dtoSource.indexOf('status: UserStatus')
    expect(fieldStart).toBeGreaterThan(-1)
    const docStart = dtoSource.lastIndexOf('/**', fieldStart)
    const doc = dtoSource.slice(docStart, fieldStart)

    expect(doc, '未写明登录成功时也可能返回它').toContain('BLACKLISTED')
    expect(doc, '未写明「登录成功」与 status 正交').toMatch(/登录成功/)
    expect(doc, '未写明客户端不得据此事前阻断').toMatch(/不得据此做任何事前阻断/)
    expect(doc, '未给出禁阻断的裁决出处（04 §5）').toMatch(/`04`\s*§5|04 §5/)
  })
})
