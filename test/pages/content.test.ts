// **内容页（计费说明 / 常见问题）的验收** —— issue #68 / spec #57 §10 + §13。
//
// 断言落在**页面外部行为**上：页面 data 画了什么、发出了什么请求、重试有没有再发。
// 正文由内容端点下发，所以测试夹具里的正文只用于验证「三种 block 怎么排版」，
// 不进入仓库源码；页面本身连一句正文都不能有。
//
// ⚠️ 两个页面共用一个文件：它们的行为契约是同一条（同一端点、同一套 block、
// 同一套失败重试），差别只有 key 与 `PAGE_TITLES` 的标题。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWxStub, jsonResponse, networkFailure } from '../helpers/wx'
import { respondInOrder, sentRequests } from '../helpers/http'
import type { InstalledWxStub } from '../helpers/wx'
import type { ContentKey } from '../../miniprogram/types/content'
import { LOAD_FAILED_DETAIL, PAGE_TITLES, RETRY_LABEL } from '../../miniprogram/startup/copy'
import { BILLING_INFO_PATH, FAQ_PATH } from '../../miniprogram/utils/routes'
import { BASE_URL, CONTENTS_PATH } from '../../miniprogram/request/config'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const pageDirs = {
  billing: join(repoRoot, 'miniprogram', 'pages', 'billing-info'),
  faq: join(repoRoot, 'miniprogram', 'pages', 'faq'),
} as const

const pageFile = (key: ContentKey, ext: string): string =>
  join(pageDirs[key], `${key === 'billing' ? 'billing-info' : 'faq'}.${ext}`)

/** 剥掉注释后的源码 —— 结构断言读它（注释里讨论文案与契约是必要的）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 递归收集 miniprogram 下指定后缀的源码（跳过构建产物）。 */
function collectSources(dir: string, extensions: readonly string[]): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'miniprogram_npm') continue
      found.push(...collectSources(full, extensions))
    } else if (extensions.some((extension) => entry.endsWith(extension))) {
      found.push(full)
    }
  }
  return found
}

/** 一份契约形状的内容响应体 —— 覆盖三种 block。 */
function contentBody(key: ContentKey): Record<string, unknown> {
  return {
    code: 0,
    message: 'ok',
    data: {
      key,
      title: '来自服务端的标题（页面不展示）',
      updatedAt: '2026-10-23T12:00:00+08:00',
      blocks: [
        { type: 'heading', text: '计费规则' },
        { type: 'paragraph', text: '关门落定后开始按小时计费，取件时结算。' },
        { type: 'qa', question: '怎么存件？', answer: '扫码后选择格口并关门。' },
      ],
    },
  }
}

let definition: Record<string, unknown> | null = null

beforeEach(() => {
  definition = null
  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (def: Record<string, unknown>): void => {
    definition = def
  }
})

const pageModules = {
  billing: () => import('../../miniprogram/pages/billing-info/billing-info'),
  faq: () => import('../../miniprogram/pages/faq/faq'),
} as const

async function loadPage(key: ContentKey): Promise<Record<string, unknown>> {
  vi.resetModules()
  await pageModules[key]()
  if (definition === null) throw new Error(`${key} 页没有调用 Component()`)
  return definition
}

interface PageInstance {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  triggerEvent: (name: string) => void
  attached?: () => void
  [key: string]: unknown
}

function instantiate(def: Record<string, unknown>): PageInstance {
  const instance = {
    data: { ...((def.data as Record<string, unknown>) ?? {}) },
    setData(patch: Record<string, unknown>): void {
      Object.assign(instance.data, patch)
    },
    triggerEvent(): void {},
  } as PageInstance
  for (const [name, fn] of Object.entries((def.methods as Record<string, unknown>) ?? {})) {
    instance[name] = (fn as (...args: unknown[]) => unknown).bind(instance)
  }
  const lifetimes = def.lifetimes as Record<string, () => void> | undefined
  instance.attached = lifetimes?.['attached']?.bind(instance)
  return instance
}

/** 让挂起的微任务链走完（内容请求是纯微任务驱动的）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

/** 装桩、编排一次内容响应、加载并挂载页面。 */
async function loadBillingWith(
  responses: Parameters<typeof respondInOrder>[0],
): Promise<{ wx: InstalledWxStub; page: PageInstance }> {
  const wx = installWxStub()
  wx.request.mockImplementation(respondInOrder(responses))
  const def = await loadPage('billing')
  const page = instantiate(def)
  page.attached?.()
  await settle()
  return { wx, page }
}

describe('#68 内容页 · 三种 block 排版', () => {
  it('⚠️ billing：页面 data 收到三种 block，导航栏标题来自 PAGE_TITLES', async () => {
    const { page } = await loadBillingWith([jsonResponse(contentBody('billing'))])

    expect(page.data.phase).toBe('ready')
    expect(page.data.title).toBe(PAGE_TITLES['pages/billing-info/billing-info'])
    expect(page.data.blocks).toEqual([
      { key: 0, type: 'heading', text: '计费规则' },
      { key: 1, type: 'paragraph', text: '关门落定后开始按小时计费，取件时结算。' },
      { key: 2, type: 'qa', question: '怎么存件？', answer: '扫码后选择格口并关门。' },
    ])
  })

  it('⚠️ faq：同一套 block 契约，key 走 /contents/faq，标题来自 PAGE_TITLES', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation(respondInOrder([jsonResponse(contentBody('faq'))]))

    const page = instantiate(await loadPage('faq'))
    page.attached?.()
    await settle()

    expect(page.data.phase).toBe('ready')
    expect(page.data.title).toBe(PAGE_TITLES['pages/faq/faq'])
    expect(page.data.blocks).toHaveLength(3)
    expect(sentRequests(wx.request)[0]?.url).toBe(`${BASE_URL}${CONTENTS_PATH}/faq`)
  })

  it('⚠️ 模板只按 heading / paragraph / qa 三种类型分支，不解析富文本', () => {
    for (const key of ['billing', 'faq'] as const) {
      const wxml = stripComments(readFileSync(pageFile(key, 'wxml'), 'utf8'))
      expect(wxml).toContain(`item.type === 'heading'`)
      expect(wxml).toContain(`item.type === 'paragraph'`)
      expect(wxml).toContain(`item.type === 'qa'`)
      expect(wxml).toContain('{{ item.text }}')
      expect(wxml).toContain('{{ item.question }}')
      expect(wxml).toContain('{{ item.answer }}')
      expect(wxml).not.toContain('<rich-text')
    }
  })
})

describe('#68 内容页 · 失败不白屏与重试', () => {
  it('⚠️ 网络失败 → 页内失败说明 + 重试；重试成功后直接出内容', async () => {
    const { wx, page } = await loadBillingWith([
      networkFailure(),
      jsonResponse(contentBody('billing')),
    ])

    expect(page.data.phase).toBe('loadFailed')
    expect(page.data.loadFailedDetail).toBe(LOAD_FAILED_DETAIL)
    expect(page.data.retryLabel).toBe(RETRY_LABEL)
    expect(page.data.blocks).toEqual([])

    ;(page.onRetryLoad as () => void)()
    await settle()

    expect(page.data.phase).toBe('ready')
    expect(page.data.blocks).toHaveLength(3)
    expect(wx.request).toHaveBeenCalledTimes(2)
  })

  it('⚠️ 未知 key（404 + 1002）同样落页内失败；重试仍走同一个 /contents/faq', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation(
      respondInOrder([
        jsonResponse({ code: 1002, message: '内容不存在', data: null }, 404),
        jsonResponse(contentBody('faq')),
      ]),
    )
    const page = instantiate(await loadPage('faq'))
    page.attached?.()
    await settle()

    expect(page.data.phase).toBe('loadFailed')
    expect(page.data.loadFailedDetail).toBe(LOAD_FAILED_DETAIL)

    ;(page.onRetryLoad as () => void)()
    await settle()

    expect(page.data.phase).toBe('ready')
    expect(sentRequests(wx.request).map((request) => request.url)).toEqual([
      `${BASE_URL}${CONTENTS_PATH}/faq`,
      `${BASE_URL}${CONTENTS_PATH}/faq`,
    ])
  })

  it('⚠️ 失败态在模板里是独立一支 —— 有说明 + 重试按钮，不停在骨架屏上', () => {
    for (const key of ['billing', 'faq'] as const) {
      const wxml = stripComments(readFileSync(pageFile(key, 'wxml'), 'utf8'))
      expect(wxml).toMatch(/wx:elif="\{\{ phase === 'loadFailed' \}\}"/)
      expect(wxml).toContain('{{ loadFailedDetail }}')
      expect(wxml).toContain('bindtap="onRetryLoad"')
      expect(wxml).toContain('{{ retryLabel }}')
    }
  })

  it('⚠️ 登录链失败（storage 无 token）时内容页仍可直接取内容 —— 不调 wx.login', async () => {
    const wx = installWxStub()
    wx.request.mockImplementation(respondInOrder([jsonResponse(contentBody('faq'))]))

    const page = instantiate(await loadPage('faq'))
    page.attached?.()
    await settle()

    expect(page.data.phase).toBe('ready')
    expect(wx.login).not.toHaveBeenCalled()
    const [sent] = sentRequests(wx.request)
    expect(sent.header.Authorization).toBeUndefined()
  })
})

describe('#68 失败出口 · 静态出口真的跳到内容页', () => {
  /** 加载首页组件定义（只为一个方法，不跑闸门 / 不挂载）。 */
  async function loadIndexPage(): Promise<Record<string, unknown>> {
    vi.resetModules()
    await import('../../miniprogram/pages/index/index')
    if (definition === null) throw new Error('index.ts 没有调用 Component()')
    return definition
  }

  it('⚠️ 「计费说明」→ navigateTo 计费页（目标来自路由常量，页面不写路径）', async () => {
    const wx = installWxStub()
    wx.navigateTo.mockImplementation(() => {})
    const page = instantiate(await loadIndexPage())

    ;(page.onStaticExit as (event: unknown) => void)({ detail: { exitId: 'billing' } })

    expect(wx.navigateTo).toHaveBeenCalledTimes(1)
    expect((wx.navigateTo.mock.calls[0]?.[0] as { url: string }).url).toBe(`/${BILLING_INFO_PATH}`)
  })

  it('⚠️ 「常见问题」→ navigateTo FAQ 页', async () => {
    const wx = installWxStub()
    wx.navigateTo.mockImplementation(() => {})
    const page = instantiate(await loadIndexPage())

    ;(page.onStaticExit as (event: unknown) => void)({ detail: { exitId: 'faq' } })

    expect(wx.navigateTo).toHaveBeenCalledTimes(1)
    expect((wx.navigateTo.mock.calls[0]?.[0] as { url: string }).url).toBe(`/${FAQ_PATH}`)
  })

  it('⚠️ 「联系客服」不经过页面跳转 —— 仍是原生 open-type="contact" 且无降级', () => {
    const wxml = stripComments(
      readFileSync(join(repoRoot, 'miniprogram', 'components', 'failure-exit', 'failure-exit.wxml'), 'utf8'),
    )
    // 客服按钮的载体是微信原生能力，页面侧没有「兜底跳电话 / 跳网页」的分支。
    expect(wxml).toContain('open-type="contact"')
    expect(wxml).toContain('data-exit-id="{{ item.id }}"')
    expect(wxml).not.toContain('phone')
    expect(wxml).not.toContain('联系客服')
  })

  it('⚠️ 客服 id 到页面也是空操作 —— 原生按钮不降级成页面跳转', async () => {
    const wx = installWxStub()
    const page = instantiate(await loadIndexPage())

    ;(page.onStaticExit as (event: unknown) => void)({ detail: { exitId: 'contact' } })

    // `wx.navigateTo` / `wx.showToast` 都是未编排即抛错的桩：
    // 页面若给客服做了任何降级（跳页 / 提示），这里会直接炸出来。
    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(wx.showToast).not.toHaveBeenCalled()
  })

  it('⚠️ 静态出口组件把 id 放进事件 detail，页面按 id 选目标而不是按文案', () => {
    // 直接用组件定义驱动一次点击：`triggerEvent('staticexit', dataset)`。
    // 页面收到的必须是 `{ exitId }` —— 若这里传的是 label，页面就无法把「改词」与「改行为」分开。
    const triggerEvent = vi.fn()
    return (async () => {
      vi.resetModules()
      await import('../../miniprogram/components/failure-exit/failure-exit')
      if (definition === null) throw new Error('failure-exit.ts 没有调用 Component()')
      const methods = definition['methods'] as Record<string, (...args: unknown[]) => void>
      methods['onStaticExit']?.call(
        { triggerEvent } as unknown,
        { currentTarget: { dataset: { exitId: 'billing' } } },
      )
      expect(triggerEvent).toHaveBeenCalledWith('staticexit', { exitId: 'billing' })
    })()
  })
})

describe('#68 内容页 · 只认三种 block', () => {
  it('⚠️ 未知 block 类型被丢弃 —— 不把整页拖进失败态', async () => {
    const body = contentBody('billing')
    const data = body['data'] as { blocks: Record<string, unknown>[] }
    data.blocks.push({ type: 'video', src: 'https://example.com/a.mp4' })

    const { page } = await loadBillingWith([jsonResponse(body)])

    expect(page.data.phase).toBe('ready')
    expect(page.data.blocks).toHaveLength(3)
    expect(page.data.blocks).not.toContainEqual(
      expect.objectContaining({ type: 'video' }),
    )
  })

  it('⚠️ 内容页界面层不写具体价格 / 发票 / 优惠券 —— 正文维护口径见 types/content.ts', () => {
    // 正文本身由服务端维护，客户端测不到；这里守的是**界面层不要自己加内容**：
    // 一旦有人在 wxml / scss / 页面文案里写价格或两个禁用主题词，这条会先响。
    for (const key of ['billing', 'faq'] as const) {
      for (const extension of ['ts', 'wxml', 'scss'] as const) {
        const code = stripComments(readFileSync(pageFile(key, extension), 'utf8'))
        for (const banned of ['¥', '发票', '优惠券']) {
          expect(code, `${key}.${extension} 里出现了「${banned}」`).not.toContain(banned)
        }
      }
    }
  })
})

describe('#68 内容页 · 硬约束（源码守卫）', () => {
  it('⚠️ 两个页面零 storage —— 源码里一个 storage API 都没有', () => {
    for (const key of ['billing', 'faq'] as const) {
      const source = stripComments(readFileSync(pageFile(key, 'ts'), 'utf8'))
      for (const api of ['getStorageSync', 'setStorageSync', 'removeStorageSync', 'getStorage']) {
        expect(source, `${key} 页出现了 ${api}`).not.toContain(api)
      }
    }
  })

  it('⚠️ 骨架 → 内容直接替换：没有 transition / animation / opacity / transform', () => {
    for (const key of ['billing', 'faq'] as const) {
      const scss = stripComments(readFileSync(pageFile(key, 'scss'), 'utf8'))
      expect(scss).not.toMatch(/\btransition(?:-[\w-]+)?\s*:/)
      expect(scss).not.toMatch(/\banimation(?:-[\w-]+)?\s*:/)
      expect(scss).not.toMatch(/@(?:-\w+-)?keyframes/)
      expect(scss).not.toMatch(/\bopacity\s*:/)
      expect(scss).not.toMatch(/\btransform\s*:/)
    }
  })

  it('⚠️ 正文不进文案层 / 模板字面量 —— 夹具正文在 miniprogram 源码里零出现', () => {
    const contentLiterals = [
      '计费规则',
      '关门落定后开始按小时计费，取件时结算。',
      '怎么存件？',
      '扫码后选择格口并关门。',
    ]
    const sources = collectSources(join(repoRoot, 'miniprogram'), ['.ts', '.wxml', '.scss', '.json'])
    for (const file of sources) {
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const literal of contentLiterals) {
        expect(code, `${file} 里出现了内容正文「${literal}」`).not.toContain(literal)
      }
    }
    // 文案层同理：正文归后端，`copy.ts` 只放界面文案。
    const copy = readFileSync(join(repoRoot, 'miniprogram', 'startup', 'copy.ts'), 'utf8')
    for (const literal of contentLiterals) expect(copy).not.toContain(literal)
  })

  it('⚠️ 页面源码零中文字面量 —— 界面文案全部来自 copy.ts，正文全部来自服务端', () => {
    for (const key of ['billing', 'faq'] as const) {
      for (const extension of ['ts', 'wxml', 'scss'] as const) {
        const code = stripComments(readFileSync(pageFile(key, extension), 'utf8'))
        expect(code, `${key}.${extension} 里出现了中文字面量`).not.toMatch(/[\u4e00-\u9fa5]/)
      }
    }
  })

  it('⚠️ 页面不写路径字面量；两个路径都注册在 app.json 的 PAGE_TITLES 里', () => {
    for (const key of ['billing', 'faq'] as const) {
      const source = stripComments(readFileSync(pageFile(key, 'ts'), 'utf8'))
      expect(source).not.toMatch(/url\s*:\s*['"`]\/?pages\//)
      expect(source).not.toMatch(/^\s*const\s+\w*PATH\w*\s*=\s*['"`]pages\//m)
    }

    const appJson = JSON.parse(
      readFileSync(join(repoRoot, 'miniprogram', 'app.json'), 'utf8'),
    ) as { pages: string[] }
    expect(appJson.pages).toContain(BILLING_INFO_PATH)
    expect(appJson.pages).toContain(FAQ_PATH)
    expect(BILLING_INFO_PATH).toBe('pages/billing-info/billing-info')
    expect(FAQ_PATH).toBe('pages/faq/faq')
  })
})
