// 请求层的**工程约束守卫** —— issue #18 剩下的几条 Acceptance criteria。
//
// 这几条的共同点：它们是**关于代码形状**的约束，不是关于运行时行为的 ——
// 「`pages/` 之外不得出现 `wx.request`」「`api/` 不含业务分支」「不引 store」。
// 行为测试测不到它们（一个页面自己拼 URL 发请求，功能上照样能通），所以只能读源码。
//
// 断言风格同 `test/types/auth.test.ts` 的源码守卫：**把 spec 里的一条事实落成一条断言、
// 失败时打印出违反的是哪一条**。判据一律取**剥离注释后**的源码 —— 注释里提 `wx.request`
// 是必要的契约说明（本文件的主题就是它），不该被当成违规。
//
// 出处：`docs/spec/07-engineering-form.md` §3 目录结构硬规则 1 / 2、§6 状态管理。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const miniprogramDir = join(repoRoot, 'miniprogram')
const requestDir = join(miniprogramDir, 'request')
const apiDir = join(miniprogramDir, 'api')
const pagesDir = join(miniprogramDir, 'pages')

/** 递归收集某目录下的全部 `.ts`（跳过 `.d.ts` 与 `node_modules`）。 */
function collectSources(dir: string): string[] {
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
      found.push(...collectSources(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      found.push(full)
    }
  }
  return found
}

/** 剥掉注释后的源码 —— 源码层面的断言都读它。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** 相对仓库根的展示路径，失败信息里用。 */
function rel(path: string): string {
  return relative(repoRoot, path)
}

describe('#18 工程约束：唯一 HTTP 出口（07 §3 硬规则 1）', () => {
  it('⚠️ `wx.request` 只出现在 `miniprogram/request/` 里 —— 别处零出现', () => {
    // `07` §3 硬规则 1：「`pages/` 之外不得出现 `wx.request` —— 一切 HTTP 走 `request/`。
    // 页面调 `api/` 的函数，不拼 URL、不拼 header。」
    // 本守卫比那句更严一点：**整个 miniprogram/ 里只有 request/ 能出现它**。
    // 严格是刻意的 —— 规则的原话是「pages/ 之外不得」，但把 `api/` 也算进去没有任何代价，
    // 且堵死了「在 api/ 里自己发一条请求」这条最容易被接受的绕路。
    const offenders: string[] = []
    for (const file of collectSources(miniprogramDir)) {
      if (file.startsWith(requestDir)) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      if (/\bwx\s*\.\s*request\b/.test(code)) offenders.push(rel(file))
    }

    expect(
      offenders,
      `以下文件在 request/ 之外出现了 wx.request —— 违反 07 §3 硬规则 1（唯一 HTTP 出口）：\n` +
        offenders.map((f) => `  • ${f}`).join('\n'),
    ).toEqual([])
  })

  it('请求层**恰好有一个** `wx.request` 调用点', () => {
    // 反面：如果 request/ 自己内部散落多处 `wx.request`，「附加 token + 归一化」这条
    // 单一路径就不再是单一的了 —— 新增的调用点很容易漏掉鉴权头或归一化。
    const callSites = collectSources(requestDir).filter((file) =>
      /\bwx\s*\.\s*request\b/.test(stripComments(readFileSync(file, 'utf8'))),
    )
    expect(callSites.map(rel), '请求层应当只有一个文件真正调用 wx.request').toEqual([
      rel(join(requestDir, 'index.ts')),
    ])
  })
})

describe('#18 工程约束：`api/` 只做搬运（07 §3 硬规则 2）', () => {
  it('`api/` 不含 UI 副作用 —— 没有 toast / modal / 跳转', () => {
    // `07` §3 硬规则 2：「`api/` 不含业务分支 —— 状态判断、文案、跳转全在页面。」
    // 请求层自己也不弹窗（§4.1 只归一化），这条把同一约束继续压到端点搬运层。
    const banned = ['showToast', 'showModal', 'navigateTo', 'redirectTo', 'switchTab', 'reLaunch']
    const offenders: string[] = []
    for (const file of collectSources(apiDir)) {
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const api of banned) {
        if (new RegExp(`\\bwx\\s*\\.\\s*${api}\\b`).test(code)) offenders.push(`${rel(file)} → wx.${api}`)
      }
    }

    expect(
      offenders,
      `api/ 里出现了 UI 副作用 —— 违反 07 §3 硬规则 2（api/ 只做搬运）：\n` +
        offenders.map((f) => `  • ${f}`).join('\n'),
    ).toEqual([])
  })

  it('`api/` 里的中文字面量只出现在注释里（文案属 09，不进搬运层）', () => {
    // 与 `types/` 同一条纪律（`07` §7 规则 4）：代码里的中文只可能是硬编码文案，
    // 而文案的唯一事实源是 `09` 文案层。api/ 需要说人话时，把异常交给页面。
    for (const file of collectSources(apiDir)) {
      const code = stripComments(readFileSync(file, 'utf8'))
      expect(
        code,
        `${rel(file)} 的代码里出现了中文字面量 —— 文案属 09 文案层，不进 api/`,
      ).not.toMatch(/['"`][^'"`]*[\u4e00-\u9fa5][^'"`]*['"`]/)
    }
  })
})

describe('#18 工程约束：不引 store，App.globalData 不放业务数据（07 §6）', () => {
  it('请求层与 api/ 不读写 `App.globalData`', () => {
    // `07` §6 的裁决：不引任何 store；`App.globalData` **仅限请求层自身需要的少量值**
    // （token 句柄、单一飞行队列状态），**不放业务数据**。
    //
    // ⚠️ 本票更进一步：**根本不用 `globalData`** —— token 走 `storage`（§4.4 定案），
    // 单一飞行队列属 #19。所以「零出现」才是当前正确状态；将来 #19 真的需要队列状态时，
    // 这条守卫应当被**有意识地**放宽到「只允许 globalData 持有队列状态」，而不是无声忽略。
    const offenders: string[] = []
    for (const file of [...collectSources(requestDir), ...collectSources(apiDir)]) {
      const code = stripComments(readFileSync(file, 'utf8'))
      if (/globalData/.test(code)) offenders.push(rel(file))
    }

    expect(
      offenders,
      `以下文件碰了 globalData —— 本票（#18）不需要它（token 走 storage）；` +
        `若有新增需求须显式裁决（07 §6）：\n${offenders.map((f) => `  • ${f}`).join('\n')}`,
    ).toEqual([])
  })

  it('不引任何状态管理库 —— 依赖里没有 store', () => {
    // `07` §6：「不引任何 store（不引 pinia、不引轻量库）」。一期连运行时依赖都是零
    // （`07` §2「能不加依赖就不加」），所以这条断言在 package.json 上是全空的。
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(pkg.dependencies ?? {}, '一期不引任何运行时依赖（07 §2）').toEqual({})
  })
})

describe('#18 工程约束：token 读写集中在一个模块（07 §4.4）', () => {
  it('token 的 storage 键只在 request/token.ts 里出现', () => {
    // `07` §4.4 的口径是「token 读写集中在**一个模块**」（验收标准 25：将来若要加退出登录
    // 只需改一处）。若 api/ 或页面自己拼这两个 key，这句话就不成立了。
    //
    // ⚠️ 判据是**键名**而不是「有没有调 setStorageSync」：storage 是通用设施，
    // 别的模块写自己的键（如骨架页的调试日志）与 token 无关，不该被这条拦下。
    // 用键名做判据，既准确又不会随无关代码的增减而误报。
    const tokenKeys = /auth\.(accessToken|refreshToken)/
    const offenders: string[] = []
    for (const file of collectSources(miniprogramDir)) {
      if (file === join(requestDir, 'token.ts')) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      if (tokenKeys.test(code)) offenders.push(rel(file))
    }

    expect(
      offenders,
      `以下文件自己拼了 token 的 storage 键 —— token 读写应集中在 request/token.ts（07 §4.4）：\n` +
        offenders.map((f) => `  • ${f}`).join('\n'),
    ).toEqual([])
  })

  it('`pages/` 目前的骨架不含请求逻辑（本票不做页面 UI）', () => {
    // #18 的一条验收标准是「本票不含任何页面 UI」（#15 的 Out of Scope 也有这条）。
    // 现有页面还是官方 quickstart 的骨架，因此断言它们**没有**引入请求层 ——
    // 这条会随着后续页面票被有意识地替换掉，而不是无声失效。
    for (const file of collectSources(pagesDir)) {
      const code = stripComments(readFileSync(file, 'utf8'))
      expect(code, `${rel(file)} 引了请求层/api —— 页面票不在 #18 范围内`).not.toMatch(
        /from\s+['"][^'"]*(request|api)[^'"]*['"]/,
      )
    }
  })
})

describe('#19 工程约束：依赖方向单向 —— request/ 不得依赖 api/（07 §3 / §4）', () => {
  it('⚠️ `request/` 里没有任何 `../api/...` 的 import', () => {
    // `07` §3 的分层是 `pages/ → api/ → request/`：**页面调 `api/` 的函数**，而请求层被
    // 所有人依赖、自己不被任何上层依赖。
    //
    // ⚠️ 这条守卫是 #19 逼出来的。登录失效处理必须自己去调 `13.1` / `13.2`，最自然的写法是
    // `request/index.ts` 里 `import { login, refresh } from '../api/auth'` —— 而 `api/auth.ts`
    // 反过来用的正是请求层的出口。两行同时写下去就是 `request ⇄ api` **模块循环**。
    //
    // 循环**不会在类型上报错**，也不一定立刻炸：只有某一方在**模块求值期**（顶层常量、
    // 装饰器、立即执行的表达式）用到另一方时才会拿到 `undefined`。今天「碰巧没事」，
    // 而它会在未来某次无害的重构里突然显形，症状（`login is not a function`）与改动毫无关系
    // —— 这正是必须用守卫钉住、而不是靠注释提醒的那类约束。
    //
    // 正解见 `request/auth-endpoints.ts` 的头注释：端点形状长在 request/ 里，`api/auth.ts` 重导出。
    const offenders: string[] = []
    for (const file of collectSources(requestDir)) {
      const code = stripComments(readFileSync(file, 'utf8'))
      if (/from\s+['"][^'"]*\/api\//.test(code)) offenders.push(rel(file))
    }

    expect(
      offenders,
      `request/ 里的文件 import 了 api/ —— 这构成模块循环，破坏单向依赖（07 §3）：\n` +
        offenders.map((f) => `  • ${f}`).join('\n'),
    ).toEqual([])
  })

  it('端点的 URL 字面量仍然只有一份（重导出没有制造第二份路径）', () => {
    // 重导出 `13.1` / `13.2` 时最容易的退化是「顺手把路径字符串也抄一份」——
    // 而 `07` §4.3 硬约束 5 的豁免名单就是拿这个字符串比对的，
    // 两处字面量之间的漂移**就是鉴权缺口**。`config.ts` 是它唯一的家。
    const offenders: string[] = []
    for (const file of [...collectSources(requestDir), ...collectSources(apiDir)]) {
      if (file === join(requestDir, 'config.ts')) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      if (/['"]\/api\/app\/v1\/auth\//.test(code)) offenders.push(rel(file))
    }

    expect(
      offenders,
      `以下文件自己写了 auth 端点路径字面量 —— 路径只有 config.ts 一个家（07 §4.3 硬约束 5）：\n` +
        offenders.map((f) => `  • ${f}`).join('\n'),
    ).toEqual([])
  })
})
