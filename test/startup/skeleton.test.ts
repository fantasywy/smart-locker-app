// **小程序骨架**的工程约束守卫 —— issue #22 的 Acceptance criteria。
//
// 与 `test/startup/conventions.test.ts` 同一取向：这些是**关于代码形状**的约束，
// 不是运行时行为。「tabBar 的图标还没接进 app.json」「`navigationStyle` 仍是 `custom`」
// 「12 个页面都注册了」「`logs` 没有残留引用」—— 功能测试一个都测不到
// （一个带图标的 tabBar 照样能跑），所以只能读配置与源码。
//
// ⚠️ 这些守卫的价值全在**未来**：本票把骨架一次性配齐，是为了让后面的页面票
// 只动自己那个目录。而「后来者顺手加个图标 / 顺手改回默认导航栏 / 顺手引分包」
// 恰好都是那种一次通过、事后没人验收的改动 —— 把它们钉成断言，代价是几毫秒。
// （#60 之后「顺手加图标」的判据变成：四个 tab 没齐之前，`app.json` 不得出现
// `iconPath` —— 见下方 tabBar 用例。）

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { PAGE_TITLES } from '../../miniprogram/startup/copy'
import { alphaBBox, decodePng, opaqueColors } from '../helpers/png'

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
  style?: string
}

describe('#59 Vant 接入的前置配置（构建 npm 与主题）', () => {
  const projectConfig = JSON.parse(
    readFileSync(join(repoRoot, 'project.config.json'), 'utf8'),
  ) as {
    setting?: {
      packNpmManually?: boolean
      packNpmRelationList?: { packageJsonPath?: string; miniprogramNpmDistDir?: string }[]
    }
  }
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  it('⚠️ 构建 npm 手动指定依赖打包关系：根 package.json → miniprogram/', () => {
    // 根 `package.json` 在 `miniprogramRoot` **之外**，不开手动映射时开发者工具
    // 默认「构建 npm」找不到依赖 —— 而且它**不报错**，只在运行时表现为
    // `van-*` 组件找不到。spec §12 / #40 研究把这条列为接入的第一步。
    expect(projectConfig.setting?.packNpmManually).toBe(true)
    expect(projectConfig.setting?.packNpmRelationList).toEqual([
      {
        packageJsonPath: './package.json',
        miniprogramNpmDistDir: './miniprogram/',
      },
    ])
  })

  it('⚠️ @vant/weapp 在 dependencies 里 —— DevTools「构建 npm」只读这个字段', () => {
    // ⚠️ 与直觉相反：Vant 虽然是**构建期**拷进 `miniprogram_npm/` 的，
    // 但微信开发者工具的 `packNpmManually` 只读取 `package.json.dependencies`，
    // 放在 `devDependencies` 时构建直接返回「No miniprogram_npm package was found」
    // （已用 DevTools 实测）。⇒ 它必须在 `dependencies`，且是**唯一**的运行时依赖；
    // 这条与两条既有依赖守卫（request / startup conventions）同步。
    expect(pkg.dependencies).toEqual({ '@vant/weapp': '1.11.7' })
    expect(pkg.devDependencies?.['@vant/weapp']).toBeUndefined()
  })

  it('⚠️ app.json 不再声明 `style: "v2"` —— Vant 要求新版基础组件样式关闭', () => {
    // Vant 快速上手明确要求移除 `style: "v2"`：新版基础组件样式会强行加样式，
    // 难以覆盖，可能造成 Vant 组件样式混乱。⚠️ 移除后原生 `<button>` 的默认外观会变，
    // 视觉回归是**人工/开发者工具**项（本仓库没有截图基线）。
    expect(appJson.style).toBeUndefined()
  })
})

describe('#22 BASE_URL 指向可联调后端', () => {
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

describe('#66/#72 tabBar：首页 + 订单 + 附近 + 我的（图标就位）', () => {
  it('⚠️ tabBar 恰好四项：首页（0）+ 订单（1）+ 附近（2）+ 我的（3）', () => {
    const tabBar = appJson.tabBar
    expect(tabBar, 'app.json 必须有 tabBar').toBeDefined()
    // ⚠️ 顺序是**语义**不是排版：首页是唯一主行动入口，订单是「我的订单」出口的目标，
    // 我的在最后。`ORDER_LIST_PATH` 必须指向 index 1 的那一项，附近是 index 2。
    expect(tabBar?.list.map((item) => item.text)).toEqual(['首页', '订单', '附近', '我的'])
    expect(tabBar?.list.map((item) => item.pagePath)).toEqual([
      'pages/index/index',
      'pages/order-list/order-list',
      'pages/nearby/nearby',
      'pages/profile/profile',
    ])
  })

  it('⚠️ 四个 tab 的 iconPath / selectedIconPath 指向 8 张 PNG 里对应当前 4 个 tab 的那 8 张', () => {
    // #60 产出四组 × 两态共 8 张 81×81 PNG（`miniprogram/assets/tabbar/`）。
    // #66/#72 把四个 tab 一次接齐 —— **绝不引用不存在的 PNG**（原生 tabBar 会静默不显示图标）。
    const routes = ['index', 'order-list', 'nearby', 'profile']
    for (const item of appJson.tabBar?.list ?? []) {
      const route = item.pagePath.split('/')[1] ?? ''
      expect(routes, `tabBar 出现了本票未接线的页面：${item.pagePath}`).toContain(route)
      expect(item.iconPath, `${item.text} 缺 iconPath`).toBe(`assets/tabbar/${route}.png`)
      expect(item.selectedIconPath, `${item.text} 缺 selectedIconPath`).toBe(
        `assets/tabbar/${route}-active.png`,
      )
    }
  })

  it('⚠️ 仓库里的图片资源恰好是 8 张 tabBar PNG + 3 张地图 marker PNG', () => {
    // 这条替换了 #22 的「无本地图片资源」断言（#60 起，那句话不再是事实）。
    // 判据不是「文件存在」而是**原生组件的硬要求**：tabBar 是 81×81、8-bit RGBA、
    // 非隔行、内容盒 72、两态颜色分别等于 weak / main；#73 的三张 marker 是 48×48。
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
    expect(found.sort()).toEqual(
      [
        ...['index', 'order-list', 'nearby', 'profile'].flatMap((route) => [
          `miniprogram/assets/tabbar/${route}.png`,
          `miniprogram/assets/tabbar/${route}-active.png`,
        ]),
        // 地图 marker 的三色图不会被 tabBar 引用，但同样必须进 git。
        'miniprogram/assets/map/marker-available.png',
        'miniprogram/assets/map/marker-full.png',
        'miniprogram/assets/map/marker-unavailable.png',
      ].sort(),
    )

    const scss = readFileSync(join(miniprogramDir, 'styles', '_variables.scss'), 'utf8')
    const tokens: Record<string, string> = {}
    for (const line of scss.split('\n')) {
      const m = /^\s*\$([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(line)
      if (m?.[1] !== undefined && m[2] !== undefined) tokens[m[1]] = m[2].toLowerCase()
    }

    for (const route of ['index', 'order-list', 'nearby', 'profile']) {
      for (const suffix of ['', '-active']) {
        const file = join(miniprogramDir, 'assets', 'tabbar', `${route}${suffix}.png`)
        const png = decodePng(readFileSync(file))
        expect([png.width, png.height], `${rel(file)} 尺寸`).toEqual([81, 81])
        expect(png.bitDepth).toBe(8)
        expect(png.colorType).toBe(6)
        expect(png.interlace).toBe(0)
        const box = alphaBBox(png)
        expect(box.maxX - box.minX + 1, `${rel(file)} 内容宽`).toBeLessThanOrEqual(72)
        expect(box.maxY - box.minY + 1, `${rel(file)} 内容高`).toBeLessThanOrEqual(72)
        const expected = suffix === '' ? tokens['color-text-weak'] : tokens['color-text-main']
        expect(opaqueColors(png), `${rel(file)} 颜色`).toEqual([expected])
      }
    }
  })

  it('⚠️ 语义图标清单 `icons.generated.ts` 也在仓库里（只读生成物）', () => {
    // 8 张 PNG 只服务原生 tabBar；页面里的图标走构建期 base64 data URI 清单。
    // 两者都属于 #60 的产物，所以在这里一起守「产物真的进了 git」。
    const generated = join(miniprogramDir, 'components', 'icon', 'icons.generated.ts')
    expect(existsSync(generated), '缺少 miniprogram/components/icon/icons.generated.ts').toBe(true)
    const body = readFileSync(generated, 'utf8')
    expect(body).toContain('AUTO-GENERATED')
    expect(body).toContain("'cell.package'")
    expect(body).toContain('data:image/svg+xml;base64,')
    expect(body).not.toContain('currentColor')
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

describe('#22 导航形态：自绘导航栏 + 不分包', () => {
  it('⚠️ navigationStyle 仍是 custom —— 柜机页的「我的订单」出口依赖它', () => {
    // 柜机页是**冷启动、栈深 1 的非 tab 页**：系统返回 = 直接退回微信、
    // 底部 tabBar 不显示 ⇒ 屏幕上没有任何通往订单列表的可见路径，
    // 必须在页面顶部固定一个「我的订单」出口。**只有自绘导航栏能承载它。**
    //
    // ⚠️ 所以这一条不是「保持现状」的惰性默认值 —— 改回 `default` 会**删掉**那个出口。
    expect(appJson.window.navigationStyle).toBe('custom')
  })

  it('⚠️ 未引入分包（一期不分包）', () => {
    // 既定裁决：主包上限 2MB，而本期页面全是原生 wxml/wxss + 数据全走接口，
    // **没有可减的大物**，且分包**并不能加快首屏**（它只减体积）。
    expect(appJson.subPackages).toBeUndefined()
    expect(appJson.subpackages).toBeUndefined()
  })
})

describe('#22 页面注册：12 个页面（#66 订单列表 / #72 附近已注册）', () => {
  /** 页面与命名裁决收敛出的 12 个页面。 */
  const EXPECTED_PAGES = [
    'pages/index/index',
    'pages/order-list/order-list',
    'pages/nearby/nearby',
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

  it('⚠️ pages 恰好注册这 12 个，且顺序与页表一致', () => {
    // ⚠️ 顺序有意义：`pages` 的**第一项是启动页**。启动页是首页，
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

  it('⚠️ 每个页面的标题都在文案层 PAGE_TITLES 里有一份', () => {
    // 标题是**用户可见的字**，归文案层。空壳页的 wxml 只写 `{{ title }}`，
    // 值从 `startup/copy.ts` 取 —— 这条挡住「某个页面漏了标题」或「标题写死在模板里」。
    const registered = new Set(appJson.pages)
    const titled = new Set(Object.keys(PAGE_TITLES))
    expect([...registered].filter((p) => !titled.has(p))).toEqual([])
    expect([...titled].filter((p) => !registered.has(p))).toEqual([])
  })

  it('⚠️ tabBar 的四项都在 pages 里注册过（否则 tabBar 点了没反应）', () => {
    for (const item of appJson.tabBar?.list ?? []) {
      expect(appJson.pages).toContain(item.pagePath)
    }
  })

  it('⚠️ tabBar 的 text 与**对应页面自己的标题**一致 —— 它俩本来就是同一个词', () => {
    // ⚠️ 这一条补的是上面那个豁免留下的缝。
    // `app.json` 的 `tabBar[].text` 是**原生配置**（JSON 引不到 `copy.ts`），
    // 所以文案守卫**必须**放它一马（见 `conventions.test.ts` 里的豁免说明）。
    // 四个 tab 的短词（首页 / 订单 / 附近 / 我的）与页面标题
    // 都是**同一个词，两处写**：一处原生 JSON，一处文案层。
    //
    // ⇒ 判据取**包含关系**而不是相等：tabBar 项是短词，页面标题是页面名。
    //   钉住「标题里含得住 tabBar 的短词」既挡住漂移，又不去要求两个位置
    //   必须逐字相同（那会与两处各自的措辞冲突）。
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

describe('#22 删除 quickstart 死代码 pages/logs（无设计出处、无端点）', () => {
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
        // `miniprogram_npm/` 是开发者工具构建出来的第三方产物，不是仓库源码。
        if (entry.name === 'node_modules' || entry.name === 'miniprogram_npm') continue
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
    // 但文案层定义了 7 种时间格式，日期工具的正经实现归 #23。
    // 顺手删掉它会把这件工作**提前**做掉一半、且做在一个错误的形状上。
    expect(existsSync(join(miniprogramDir, 'utils', 'util.ts'))).toBe(true)
  })
})
