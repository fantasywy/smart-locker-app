// **小程序骨架**的工程约束守卫 —— issue #22 的 Acceptance criteria。
//
// 与 `test/startup/conventions.test.ts` 同一取向：这些是**关于代码形状**的约束，
// 不是运行时行为。「`tabBar` 不引图标」「`navigationStyle` 仍是 `custom`」
// 「10 个页面都注册了」「`logs` 没有残留引用」—— 功能测试一个都测不到
// （一个带图标的 tabBar 照样能跑），所以只能读配置与源码。
//
// 出处：`docs/spec/07-engineering-form.md` §5（页面与导航、一期不分包、自绘导航栏、
// 无本地图片资源）、`docs/spec/01-entry-and-identity.md` §2.3（tabBar 两项）。
//
// ⚠️ 这些守卫的价值全在**未来**：本票把骨架一次性配齐，是为了让后面的页面票
// 只动自己那个目录。而「后来者顺手加个图标 / 顺手改回默认导航栏 / 顺手引分包」
// 恰好都是那种一次通过、事后没人验收的改动 —— 把它们钉成断言，代价是几毫秒。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { PAGE_TITLES } from '../../miniprogram/startup/copy'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const miniprogramDir = join(repoRoot, 'miniprogram')

function rel(path: string): string {
  return relative(repoRoot, path)
}

/** `app.json` 的原样解析结果。 */
const appJson = JSON.parse(readFileSync(join(miniprogramDir, 'app.json'), 'utf8')) as {
  pages: string[]
  window: Record<string, unknown>
  tabBar?: {
    color?: string
    selectedColor?: string
    backgroundColor?: string
    borderStyle?: string
    list: { pagePath: string; text: string; iconPath?: string; selectedIconPath?: string }[]
  }
  subPackages?: unknown[]
  subpackages?: unknown[]
  window_navigationStyle?: string
}

describe('#22 BASE_URL 指向可联调后端（07 §4.3）', () => {
  it('⚠️ BASE_URL 是**具体地址**，不是占位符 —— 占位符等于任何页面都连不上', async () => {
    // 本票的起点事实：`config.ts` 里写着 `https://api.example.com`，
    // 于是**任何页面都发不出一次成功的请求** —— 而这是全部 9 张页面票的前置。
    //
    // ⚠️ 判据是「不含占位符特征」，不是「等于某个具体字符串」：
    // 真机联调时**必须**把它改成局域网 IP（见 config.ts 的注释与 #22 走查清单），
    // 那时这条断言仍应全绿。钉死值会让正常的联调改动变成一次无意义的红灯。
    const { BASE_URL } = await import('../../miniprogram/request/config')
    expect(BASE_URL).not.toMatch(/example\.com|placeholder|localhost:0|TODO/i)
    expect(BASE_URL).toMatch(/^https?:\/\/[^\s/]+$/)
  })

  it('⚠️ 路径常量仍然拼在 BASE_URL 之后（请求层的唯一拼装点没被绕开）', async () => {
    const { BASE_URL, LOGIN_PATH } = await import('../../miniprogram/request/config')
    // `request/index.ts` 用的是模板串 `${BASE_URL}${path}` —— 这里复算一遍，
    // 挡住「BASE_URL 带了尾斜杠」这种会把 URL 拼成 `//api/app/...` 的改动。
    expect(BASE_URL.endsWith('/')).toBe(false)
    expect(`${BASE_URL}${LOGIN_PATH}`).toBe(`${BASE_URL}/api/app/v1/auth/login`)
  })
})

describe('#22 tabBar：订单 + 我的，纯文字（01 §2.3）', () => {
  it('⚠️ tabBar 存在，且恰好两项：订单（index 0）+ 我的（index 1）', () => {
    const tabBar = appJson.tabBar
    expect(tabBar, 'app.json 必须有 tabBar').toBeDefined()
    // ⚠️ 顺序是**语义**不是排版：`01` §2.3 与 §2.4 都依赖「订单是 index 0」——
    // 柜机页的「我的订单」出口要走 `wx.switchTab` 回到它。
    expect(tabBar?.list.map((item) => item.text)).toEqual(['订单', '我的'])
    expect(tabBar?.list.map((item) => item.pagePath)).toEqual([
      'pages/index/index',
      'pages/profile/profile',
    ])
  })

  it('⚠️ tabBar **不引入任何图片/图标资源**（07 §5:126 的「无本地图片资源」仍是事实）', () => {
    // `07` §5 把「本期页面没有任何本地图片或图标资源」当成**已核实的事实**写进
    // 「一期不分包」的理由。tabBar 的图标需求与它直接冲突，本票的裁决是：
    // **接受纯文字 tabBar**（微信原生支持省略 `iconPath`），不去动那句事实。
    //
    // ⇒ 一旦有人补了 `iconPath`，`07` §5:126 那句话就变假了。
    //    那一天必须**同时**更正文档，而不是让文档悄悄说谎 —— 这条断言就是那个提醒。
    for (const item of appJson.tabBar?.list ?? []) {
      expect(item.iconPath, `${item.text} 不得带图标 —— 要么保持纯文字，要么同步更正 07 §5:126`).toBeUndefined()
      expect(item.selectedIconPath, `${item.text} 不得带选中图标`).toBeUndefined()
    }
  })

  it('⚠️ 仓库里确实没有任何图片/图标资源文件（与上一条互为佐证）', () => {
    // 上一条只挡 tabBar 这一个入口。若哪天有人往 `miniprogram/` 里丢了一张 png，
    // 「无本地图片资源」这句事实同样变假 —— 而且是**静默**变假。
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico']
    const found: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (imageExtensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
          found.push(rel(full))
        }
      }
    }
    walk(miniprogramDir)
    expect(found, 'miniprogram/ 下出现了图片资源 —— 请同步更正 07 §5:126').toEqual([])
  })

  it('⚠️ tabBar 的三个颜色**对齐色调层 token**，不是随手挑的色值', () => {
    // `app.json` 是**原生配置**，引不到 SCSS 变量 ⇒ 这三个色值天然有「第二个家」。
    // 本仓库的裁决是把它们对齐到色调层既有 token，而不是自造三个近似色：
    //   • `color`（未选中项）       → `$color-text-weak`
    //   • `selectedColor`（当前项） → `$color-text-main`
    //   • `backgroundColor`         → `$color-bg-card`
    //
    // ⚠️ 这条守卫是**真会咬人**的那种：本票第一版手写了 `#8A8A8E` / `#1F1F1F` ——
    // 三个都不是任何 token 的取值，肉眼却完全看不出（都是灰/近黑）。
    // 色调层的两次已知事故（device 的 1.23 对比度、V25 的 2.06 漂移）同属这一类。
    const scss = readFileSync(join(miniprogramDir, 'styles', '_variables.scss'), 'utf8')
    const tokens: Record<string, string> = {}
    for (const line of scss.split('\n')) {
      const m = /^\s*\$([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(line)
      if (m?.[1] !== undefined && m[2] !== undefined) tokens[m[1]] = m[2].toLowerCase()
    }
    const tabBar = appJson.tabBar
    expect(tabBar?.color).toBe(tokens['color-text-weak'])
    expect(tabBar?.selectedColor).toBe(tokens['color-text-main'])
    expect(tabBar?.backgroundColor).toBe(tokens['color-bg-card'])
  })
})

describe('#22 导航形态：自绘导航栏 + 不分包（07 §5）', () => {
  it('⚠️ navigationStyle 仍是 custom —— 柜机页的「我的订单」出口依赖它', () => {
    // `07` §5:138 原文：柜机页是**冷启动、栈深 1 的非 tab 页**，系统返回 = 直接退回微信、
    // 底部 tabBar 不显示 ⇒ 屏幕上没有任何通往订单列表的可见路径，
    // 必须在页面顶部固定一个「我的订单」出口。**只有自绘导航栏能承载它。**
    //
    // ⚠️ 所以这一条不是「保持现状」的惰性默认值 —— 改回 `default` 会**删掉**那个出口。
    expect(appJson.window.navigationStyle).toBe('custom')
  })

  it('⚠️ 未引入分包（07 §5:128「一期不分包」）', () => {
    // `07` §5 的裁决：主包上限 2MB，而本期页面全是原生 wxml/wxss + 数据全走接口，
    // **没有可减的大物**，且分包**并不能加快首屏**（它只减体积）。
    expect(appJson.subPackages).toBeUndefined()
    expect(appJson.subpackages).toBeUndefined()
  })
})

describe('#22 页面注册：10 个页面一次配齐（07 §5 页表）', () => {
  /** `07` §5 页表 + §8 命名裁决收敛出的 10 个页面。 */
  const EXPECTED_PAGES = [
    'pages/index/index',
    'pages/profile/profile',
    'pages/locker/locker',
    'pages/order-detail/order-detail',
    'pages/waiting/waiting',
    'pages/reservation-list/reservation-list',
    'pages/reservation-create/reservation-create',
    'pages/score-logs/score-logs',
    'pages/billing-info/billing-info',
    'pages/faq/faq',
  ]

  it('⚠️ pages 恰好注册这 10 个，且顺序与页表一致', () => {
    // ⚠️ 顺序有意义：`pages` 的**第一项是启动页**。首页 = 订单列表（`01` §2.3），
    // 所以它必须排第一 —— 否则冷启动会落到别的页上。
    expect(appJson.pages).toEqual(EXPECTED_PAGES)
  })

  it('⚠️ 每个注册的页面，四件套文件都真实存在（否则编辑器直接编译不过）', () => {
    // 「注册了但文件不存在」是**编译期**错误，不是运行时 —— 本票的验收标准里
    // 「能编译通过」指的就是它。这里静态查一遍，不必等开发者工具。
    const missing: string[] = []
    for (const page of appJson.pages) {
      for (const ext of ['.ts', '.json', '.wxml', '.scss']) {
        const file = join(miniprogramDir, `${page}${ext}`)
        if (!existsSync(file)) missing.push(rel(file))
      }
    }
    expect(missing, `以下页面文件缺失：\n${missing.map((f) => `  • ${f}`).join('\n')}`).toEqual([])
  })

  it('⚠️ 每个页面的标题都在文案层 PAGE_TITLES 里有一份（09 §0 硬规则 1）', () => {
    // 标题是**用户可见的字**，归文案层。空壳页的 wxml 只写 `{{ title }}`，
    // 值从 `startup/copy.ts` 取 —— 这条挡住「某个页面漏了标题」或「标题写死在模板里」。
    const registered = new Set(appJson.pages)
    const titled = new Set(Object.keys(PAGE_TITLES))
    expect([...registered].filter((p) => !titled.has(p))).toEqual([])
    expect([...titled].filter((p) => !registered.has(p))).toEqual([])
  })

  it('⚠️ tabBar 的两项都在 pages 里注册过（否则 tabBar 点了没反应）', () => {
    for (const item of appJson.tabBar?.list ?? []) {
      expect(appJson.pages).toContain(item.pagePath)
    }
  })

  it('⚠️ tabBar 的 text 与**对应页面自己的标题**一致 —— 它俩本来就是同一个词', () => {
    // ⚠️ 这一条补的是上面那个豁免留下的缝。
    // `app.json` 的 `tabBar[].text` 是**原生配置**（JSON 引不到 `copy.ts`），
    // 所以文案守卫**必须**放它一马（见 `conventions.test.ts` 里的豁免说明）。
    // 但「订单」这个 tab 的页面标题恰好也是「我的订单」、`我的` tab 对应
    // `PAGE_TITLES['pages/profile/profile']` —— **同一个词，两处写**。
    //
    // ⇒ 判据取**包含关系**而不是相等：`01` §2.3 的 tabBar 项是短词「订单」，
    //   而页面标题是「我的订单」（`01` §2.4 的柜机页出口也用它），两者**有意不同**。
    //   钉住「标题里含得住 tabBar 的短词」既挡住漂移（比如把页面标题改成「历史订单」
    //   而 tabBar 还写「订单」→ 仍是包含，不报；但改成「我的柜子」就会报），
    //   又不去要求两个位置必须逐字相同（那会与 §2.3 / §2.4 的措辞冲突）。
    const titles = PAGE_TITLES as Record<string, string>
    for (const item of appJson.tabBar?.list ?? []) {
      const pageTitle = titles[item.pagePath]
      expect(pageTitle, `${item.pagePath} 缺 PAGE_TITLES`).toBeDefined()
      expect(
        pageTitle?.includes(item.text),
        `tabBar 写「${item.text}」，而 ${item.pagePath} 的标题是「${pageTitle}」—— 两者已经对不上了`,
      ).toBe(true)
    }
  })
})

describe('#22 删除 quickstart 死代码 pages/logs（无 spec 出处、无端点）', () => {
  it('⚠️ pages/logs 目录已删除', () => {
    expect(existsSync(join(miniprogramDir, 'pages', 'logs'))).toBe(false)
  })

  it('⚠️ 仓库内（源码与测试）无 pages/logs 残留引用', () => {
    // ⚠️ 文档里的历史引用不算残留（`docs/` 记的是**当时**的事实，不该被追溯修改）；
    // 这里查的是源码 / 配置 / 测试 —— 那些地方出现 `pages/logs` 就是一条死链接。
    //
    // ⚠️ **本文件自己必须豁免**：它的判据字符串与注释里都写着 `pages/logs`，
    // 而剥离注释对付不了「正则字面量里的这个名字」。豁免一个守卫文件，
    // 比为了让守卫干净而把它的判据拆成拼接字符串要好 —— 后者会让判据本身变得不可读。
    const extensions = ['.ts', '.json', '.wxml', '.scss', '.mjs', '.js']
    const selfPath = fileURLToPath(import.meta.url)
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!extensions.some((ext) => entry.name.endsWith(ext))) continue
        if (full === selfPath) continue
        // 剥离注释：`config.ts` 与 `index.ts` 的注释里**需要**提到这个名字来解释它已删除。
        const code = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
        if (/pages\/logs/.test(code)) offenders.push(rel(full))
      }
    }
    walk(miniprogramDir)
    walk(join(repoRoot, 'test'))
    expect(offenders).toEqual([])
  })

  it('⚠️ utils/util.ts **保留** —— 日期工具的正经实现归本批第 2 张票（#23）', () => {
    // 本票的票面明确写了这条禁令：`formatTime` 的唯一消费者确实是 `logs.ts`，
    // 但 `09` §5.4 定义了 7 种时间格式，日期工具的正经实现归 #23。
    // 顺手删掉它会把这件工作**提前**做掉一半、且做在一个错误的形状上。
    expect(existsSync(join(miniprogramDir, 'utils', 'util.ts'))).toBe(true)
  })
})
