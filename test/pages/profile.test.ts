// **「我的」页（账号页）的验收** —— issue #69 / spec #57 §9。
//
// 断言落在**页面外部行为**上：页面 data 画了什么、发出了什么请求、点了去哪。
// 不测页面内部怎么组织方法，也不 mock 页面自己的方法。
//
// ⚠️ 一次 `13.4` 三块共用是本票的头号验收：每个用例都按「一次读取」编排响应，
// 多出来的请求会让 `respondInOrder` 直接抛错 —— 这样「偷偷多发一条」不可能绿。
//
// ⚠️ `wx.*` 全是「未编排即失败」的桩：头像若偷偷 `wx.uploadFile` / `wx.compressImage`，
// 会以异常形式爆出来；页面若偷偷 `setStorageSync`，同理由 storage 断言挡住。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWxStub, jsonResponse, networkFailure } from '../helpers/wx'
import { requestsTo, respondInOrder, sentRequests } from '../helpers/http'
import {
  AVATAR_DIR,
  UPLOAD_DIR,
  arrangeDownloads,
  downloadOk,
  installMemoryDisk,
} from '../helpers/memory-disk'
import type { MemoryDisk } from '../helpers/memory-disk'
import type {
  InstalledWxStub,
  WxDownloadFileSuccessResult,
  WxUploadFileOptions,
  WxUploadFileSuccessResult,
} from '../helpers/wx'
import { BASE_URL } from '../../miniprogram/request/config'
import { PROFILE_PATH } from '../../miniprogram/api/profile'
import { PAGE_TITLES, PROFILE_COPY, STATIC_EXITS } from '../../miniprogram/startup/copy'
import {
  BILLING_INFO_PATH,
  FAQ_PATH,
  RESERVATION_LIST_PATH,
  SCORE_LOGS_PATH,
} from '../../miniprogram/utils/routes'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const profileDir = join(repoRoot, 'miniprogram', 'pages', 'profile')
const profileSource = (): string => readFileSync(join(profileDir, 'profile.ts'), 'utf8')
const profileWxml = (): string => readFileSync(join(profileDir, 'profile.wxml'), 'utf8')
const profileScss = (): string => readFileSync(join(profileDir, 'profile.scss'), 'utf8')
const copySource = (): string =>
  readFileSync(join(repoRoot, 'miniprogram', 'startup', 'copy.ts'), 'utf8')

/** 收集 `miniprogram/` 下的源码文件（跳过构建产物）。 */
function collectMiniprogramFiles(dir = join(repoRoot, 'miniprogram')): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'miniprogram_npm' || name === 'node_modules' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) found.push(...collectMiniprogramFiles(path))
    else if (/\.(ts|wxml|json|scss)$/.test(name) && !name.endsWith('.d.ts')) found.push(path)
  }
  return found
}

/** 剥掉注释后的源码 —— 结构断言读它（注释里讨论契约与不展示项是必要的）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 一份契约形状的 `13.4` 成功响应体。 */
function profileBody(overrides: Record<string, unknown> = {}): ReturnType<typeof jsonResponse> {
  return jsonResponse({
    code: 0,
    message: 'ok',
    data: {
      id: 88,
      nickname: '小明',
      // ⚠️ 刻意给一个非空头像 / 手机号：页面**仍然**只能画本地默认头像、且不得展示手机号。
      avatar: '/api/app/v1/files/42',
      phone: '13900000000',
      score: 95,
      status: 1,
      blacklistRecord: null,
      ...overrides,
    },
  })
}

/** `13.5` 成功响应体（`data: null`）。 */
const updateOk = (): ReturnType<typeof jsonResponse> =>
  jsonResponse({ code: 0, message: 'ok', data: null })

let definition: Record<string, unknown> | null = null

beforeEach(() => {
  definition = null
  const host = globalThis as unknown as Record<string, unknown>
  host.Component = (def: Record<string, unknown>): void => {
    definition = def
  }
})

interface PageInstance {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  triggerEvent: (name: string) => void
  onShow?: () => void
  onEditProfile?: () => void
  onChooseAvatar?: (event: { detail: { avatarUrl?: string } }) => void
  onNicknameInput?: (event: { detail: { value: string } }) => void
  onSaveProfile?: () => Promise<void>
  onCancelEdit?: () => void
  onScoreLogs?: () => void
  onReservations?: () => void
  onStaticExit?: (event: { currentTarget: { dataset: Record<string, unknown> } }) => void
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
  return instance
}

async function loadPage(): Promise<Record<string, unknown>> {
  vi.resetModules()
  await import('../../miniprogram/pages/profile/profile')
  if (definition === null) throw new Error('profile.ts 没有调用 Component()')
  return definition
}

/** 让挂起的微任务链走完（读取 / 保存 / 重拉都是纯微任务驱动的）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 24; i += 1) await Promise.resolve()
}

/** `mount()` 的本机盘 / 下载编排 —— 不传时给「头像 42 已缓存」。 */
interface MountOptions {
  files?: Record<string, string>
  dirs?: readonly string[]
  downloads?: readonly (WxDownloadFileSuccessResult | { errMsg: string })[]
  /** 页面加载前的额外编排（选图流水线 / 上传响应）。 */
  setup?: (wx: InstalledWxStub, disk: MemoryDisk) => void
}

/** 装桩、编排一组响应、加载页面并触发首次 `onShow`。 */
async function mount(
  responses: Parameters<typeof respondInOrder>[0],
  options: MountOptions = {},
): Promise<{
  wx: InstalledWxStub
  page: PageInstance
  def: Record<string, unknown>
  disk: MemoryDisk
}> {
  const wx = installWxStub()
  const disk = installMemoryDisk(
    wx,
    options.files ?? { [`${AVATAR_DIR}/42`]: 'cached' },
    options.dirs,
  )
  if (options.downloads !== undefined) arrangeDownloads(wx, disk, options.downloads)
  options.setup?.(wx, disk)
  wx.request.mockImplementation(respondInOrder(responses))
  const def = await loadPage()
  const page = instantiate(def)
  page.onShow?.()
  await settle()
  return { wx, page, def, disk }
}

/** 指向 `13.4` / `13.5` 的请求。 */
function profileRequests(wx: InstalledWxStub): ReturnType<typeof sentRequests> {
  return requestsTo(sentRequests(wx.request), `${BASE_URL}${PROFILE_PATH}`)
}

describe('#69 我的页 · 资料读取：一次请求，三块共用', () => {
  it('进入时恰好一次 13.4，身份 / 受限 / 信用分都从它来', async () => {
    const { wx, page } = await mount([profileBody()])

    expect(profileRequests(wx)).toHaveLength(1)
    expect(page.data.phase).toBe('ready')
    expect(page.data.nickname).toBe('小明')
    expect(page.data.score).toBe(95)
    expect(page.data.restricted).toBe(false)
    expect(page.data.title).toBe(PAGE_TITLES['pages/profile/profile'])
    // 手机号不进 data —— 不进 data 就画不上屏。
    expect(Object.keys(page.data)).not.toContain('phone')
  })

  it('首帧两块各自骨架：identity / credit 是各自一份，不是一张整页骨架', async () => {
    const def = await loadPage()
    const page = instantiate(def)
    expect(page.data.phase).toBe('loading')

    const wxml = stripComments(profileWxml())
    expect(wxml).toMatch(/<skeleton[^>]*wx:if="\{\{ phase === 'loading' \}\}"[^>]*variant="identity"/)
    expect(wxml).toMatch(/<skeleton[^>]*wx:if="\{\{ phase === 'loading' \}\}"[^>]*variant="credit"/)
  })

  it('每次 onShow 重拉一次；页面没有 onLoad（否则进入时会打两次）', async () => {
    const { wx, page, def } = await mount([profileBody(), profileBody({ score: 91 })])

    page.onShow?.()
    await settle()

    expect(profileRequests(wx)).toHaveLength(2)
    expect(page.data.score).toBe(91)
    expect((def.methods as Record<string, unknown>)['onLoad']).toBeUndefined()
  })

  it('昵称为空 → 显示「微信用户」；但编辑预填仍是空串（不把回退值当成用户资料）', async () => {
    const { page } = await mount([profileBody({ nickname: null })])

    expect(page.data.nickname).toBe(PROFILE_COPY.nicknameFallback)
    expect(page.data.savedNickname).toBe('')
    page.onEditProfile?.()
    expect(page.data.nicknameDraft).toBe('')
  })

  it('读取失败 → 身份区与信用分各自一行「加载失败，请重试」，静态出口照常可用', async () => {
    const { wx, page } = await mount([networkFailure()])

    expect(page.data.phase).toBe('failed')
    const wxml = stripComments(profileWxml())
    // 两块各一份块内提示；不是一张整页失败页。
    expect(wxml.match(/\{\{ blockLoadFailed \}\}/g)).toHaveLength(2)

    // 静态条目与数据无关：失败后仍能点。
    wx.navigateTo.mockImplementation(() => {})
    page.onReservations?.()
    page.onStaticExit?.({ currentTarget: { dataset: { exitId: 'faq' } } })
    const urls = wx.navigateTo.mock.calls.map((call) => (call[0] as { url: string }).url)
    expect(urls).toEqual([`/${RESERVATION_LIST_PATH}`, `/${FAQ_PATH}`])
  })
})

describe('#69 我的页 · 受限卡两态', () => {
  it('受限 → 卡片出现，四行文案逐字（含原因与「自 … 起」）', async () => {
    const { page } = await mount([
      profileBody({
        status: 2,
        blacklistRecord: {
          reason: '多次超时未取件',
          createdAt: '2026-09-22T15:04:00+08:00',
          auto: true,
        },
      }),
    ])

    expect(page.data.restricted).toBe(true)
    expect(page.data.restrictedTitle).toBe('账号受限')
    expect(page.data.restrictedBody).toBe(
      '暂时不能存件、创建预约或开始使用预约；已有订单仍可正常取件。',
    )
    expect(page.data.restrictionReason).toBe('原因：多次超时未取件')
    expect(page.data.restrictionSince).toBe('自 2026-09-22 15:04 起')
    expect(page.data.restrictedContact).toBe('如有疑问，请联系客服')
  })

  it('未受限 → 不渲染卡片（模板条件是 restricted）', async () => {
    const { page } = await mount([profileBody({ status: 1, blacklistRecord: null })])

    expect(page.data.restricted).toBe(false)
    expect(stripComments(profileWxml())).toMatch(
      /<view wx:if="\{\{ restricted \}\}" class="profile__restricted/,
    )
    // 不展示内部归因：auto / 自动 / 人工 都不进 data，也不进模板。
    expect(Object.keys(page.data)).not.toContain('blacklistRecord')
    const visible = stripComments(profileWxml())
    expect(visible).not.toContain('auto')
    expect(visible).not.toContain('限制开始于')
  })

  it('重拉失败 → 收回上一次的受限卡，不展示过期状态', async () => {
    const { page } = await mount([
      profileBody({
        status: 2,
        blacklistRecord: { reason: '多次超时未取件', createdAt: '2026-09-22T15:04:00+08:00', auto: true },
      }),
      networkFailure(),
    ])
    expect(page.data.restricted).toBe(true)

    page.onShow?.()
    await settle()

    expect(page.data.phase).toBe('failed')
    expect(page.data.restricted).toBe(false)
    expect(page.data.restrictionReason).toBe('')
    expect(page.data.restrictionSince).toBe('')
  })

  it('原因为空 → 整行省略（data 为空串，模板按空串不渲染）', async () => {
    const { page } = await mount([
      profileBody({
        status: 2,
        blacklistRecord: { reason: '   ', createdAt: '2026-09-22T15:04:00+08:00', auto: false },
      }),
    ])

    expect(page.data.restrictionReason).toBe('')
    expect(stripComments(profileWxml())).toContain('wx:if="{{ restrictionReason }}"')
  })

  it('受限用户仍可改资料（身份行不因受限而消失 / 置灰）', async () => {
    const { page } = await mount([
      profileBody({
        status: 2,
        blacklistRecord: { reason: '人工拉黑', createdAt: '2026-09-22T15:04:00+08:00', auto: false },
      }),
    ])

    page.onEditProfile?.()
    expect(page.data.popupVisible).toBe(true)
    expect(page.data.nicknameDraft).toBe('小明')
  })

  it('「联系客服」是原生 open-type="contact" 按钮，不是页面跳转', () => {
    const wxml = stripComments(profileWxml())
    const contact = /<button[^>]*open-type="contact"/.exec(wxml)
    expect(contact, '受限卡 / 帮助与支持都必须有原生客服按钮').not.toBeNull()
    expect(wxml.match(/open-type="contact"/g)?.length).toBeGreaterThanOrEqual(2)
    expect(profileSource()).not.toContain('chooseContact')
  })
})

describe('#69 我的页 · 昵称编辑', () => {
  it('trim 后为空 → 「昵称不能为空」，不发请求、弹层不关', async () => {
    const { wx, page } = await mount([profileBody()])
    page.onEditProfile?.()
    page.onNicknameInput?.({ detail: { value: '   ' } })
    await page.onSaveProfile?.()
    await settle()

    expect(page.data.nicknameError).toBe('昵称不能为空')
    expect(page.data.popupVisible).toBe(true)
    expect(profileRequests(wx)).toHaveLength(1)
  })

  it('trim 后超过 64 → 「昵称最多 64 个字符」，不发请求', async () => {
    const { wx, page } = await mount([profileBody()])
    page.onEditProfile?.()
    page.onNicknameInput?.({ detail: { value: 'a'.repeat(65) } })
    await page.onSaveProfile?.()
    await settle()

    expect(page.data.nicknameError).toBe('昵称最多 64 个字符')
    expect(profileRequests(wx)).toHaveLength(1)
  })

  it('trim 后保存 → 只提交 nickname、关闭弹层并重拉 13.4', async () => {
    const { wx, page } = await mount([
      profileBody(),
      updateOk(),
      profileBody({ nickname: '新昵称' }),
    ])
    page.onEditProfile?.()
    page.onNicknameInput?.({ detail: { value: '  新昵称  ' } })
    await page.onSaveProfile?.()
    await settle()

    const requests = profileRequests(wx)
    expect(requests).toHaveLength(3)
    const update = requests[1]
    expect(update?.method).toBe('PUT')
    expect(update?.data).toEqual({ nickname: '新昵称' })
    // 只提交变化字段 —— 头像不在本票的写路径里。
    expect(update?.data).not.toHaveProperty('avatar')

    expect(page.data.popupVisible).toBe(false)
    expect(page.data.nicknameError).toBe('')
    expect(page.data.nickname).toBe('新昵称')
    expect(page.data.savedNickname).toBe('新昵称')
  })

  it('没有变化 → 直接关闭，不发空更新、也不重拉', async () => {
    const { wx, page } = await mount([profileBody()])
    page.onEditProfile?.()
    await page.onSaveProfile?.()
    await settle()

    expect(profileRequests(wx)).toHaveLength(1)
    expect(page.data.popupVisible).toBe(false)
  })

  it('保存失败 → 留在弹层内一行「保存失败，请重试」，不重拉', async () => {
    const { wx, page } = await mount([profileBody(), networkFailure()])
    page.onEditProfile?.()
    page.onNicknameInput?.({ detail: { value: '新昵称' } })
    await page.onSaveProfile?.()
    await settle()

    expect(profileRequests(wx)).toHaveLength(2)
    expect(page.data.popupVisible).toBe(true)
    expect(page.data.saving).toBe(false)
    expect(page.data.nicknameError).toBe('保存失败，请重试')
    expect(page.data.nicknameDraft).toBe('新昵称')
  })

  it('取消 → 关闭并丢弃未保存修改（重开回到服务端原值）', async () => {
    const { page } = await mount([profileBody()])
    page.onEditProfile?.()
    page.onNicknameInput?.({ detail: { value: '临时草稿' } })
    page.onCancelEdit?.()
    expect(page.data.popupVisible).toBe(false)

    page.onEditProfile?.()
    expect(page.data.nicknameDraft).toBe('小明')
    expect(page.data.nicknameError).toBe('')
  })
})

describe('#69 我的页 · 静态出口与路由', () => {
  it('三件套复用 STATIC_EXITS，计费 / FAQ 按 id 跳转，客服走原生按钮', async () => {
    const { wx, page } = await mount([profileBody()])
    const exits = page.data.staticExits as { id: string; label: string }[]
    expect(exits.map((exit) => exit.id)).toEqual(STATIC_EXITS.map((exit) => exit.id))
    expect(exits.map((exit) => exit.label)).toEqual(STATIC_EXITS.map((exit) => exit.label))

    wx.navigateTo.mockImplementation(() => {})
    page.onStaticExit?.({ currentTarget: { dataset: { exitId: 'billing' } } })
    page.onStaticExit?.({ currentTarget: { dataset: { exitId: 'faq' } } })
    const urls = wx.navigateTo.mock.calls.map((call) => (call[0] as { url: string }).url)
    expect(urls).toEqual([`/${BILLING_INFO_PATH}`, `/${FAQ_PATH}`])
  })

  it('信用分「明细」→ 信用分明细页；「我的预约」→ 我的预约页', async () => {
    const { wx, page } = await mount([profileBody()])
    wx.navigateTo.mockImplementation(() => {})

    page.onScoreLogs?.()
    page.onReservations?.()

    const urls = wx.navigateTo.mock.calls.map((call) => (call[0] as { url: string }).url)
    expect(urls).toEqual([`/${SCORE_LOGS_PATH}`, `/${RESERVATION_LIST_PATH}`])
  })

  it('路由常量与 app.json 注册表一致；两个二级页导航栏显示返回', () => {
    expect(SCORE_LOGS_PATH).toBe('pages/score-logs/score-logs')
    expect(RESERVATION_LIST_PATH).toBe('pages/reservation-list/reservation-list')
    const appJson = JSON.parse(
      readFileSync(join(repoRoot, 'miniprogram', 'app.json'), 'utf8'),
    ) as { pages: string[] }
    expect(appJson.pages).toContain(SCORE_LOGS_PATH)
    expect(appJson.pages).toContain(RESERVATION_LIST_PATH)

    for (const page of ['score-logs', 'reservation-list']) {
      const wxml = readFileSync(join(repoRoot, 'miniprogram', 'pages', page, `${page}.wxml`), 'utf8')
      expect(wxml, `${page} 是二级页，导航栏必须有返回箭头`).toMatch(
        /<navigation-bar[^>]*back="\{\{true\}\}"/,
      )
    }
  })

  it('我的页是 tab 页：自绘导航栏 back=false', () => {
    expect(stripComments(profileWxml())).toMatch(/<navigation-bar[^>]*back="\{\{ false \}\}"/)
  })
})

describe('#69 我的页 · 硬约束（源码守卫）', () => {
  it('不展示手机号；不出现退出登录 / 账号注销 / 发票 / 优惠券', () => {
    const source = stripComments(profileSource()) + stripComments(profileWxml())
    for (const forbidden of ['phone', '退出登录', '注销', '发票', '优惠券', 'logout']) {
      expect(source, `「我的」页出现了不展示项「${forbidden}」`).not.toContain(forbidden)
    }
  })

  it('头像展示走本地缓存；上传只经 api/utils，页面不直接调平台 API，也无开关', () => {
    const source = stripComments(profileSource()) + stripComments(profileWxml())
    for (const forbidden of [
      'wx.uploadFile',
      'wx.downloadFile',
      'compressImage',
      'getFileSystemManager',
      'wx.chooseMedia',
      'wx.chooseImage',
      'AVATAR_UPLOAD_ENABLED',
    ]) {
      expect(source, `「我的」页不应直接出现「${forbidden}」`).not.toContain(forbidden)
    }
    expect(source, '默认头像仍用本地 icon').toContain('name="profile.avatar"')
    expect(source, '有缓存路径时用 image').toContain('src="{{ avatarPath }}"')
  })

  it('页面零 storage —— 受限状态与信用分每次从 13.4 取', () => {
    const source = stripComments(profileSource())
    for (const api of ['getStorageSync', 'setStorageSync', 'removeStorageSync', 'getStorage']) {
      expect(source, `profile.ts 里出现了 ${api}`).not.toContain(api)
    }
  })

  it('零动效 / 零裸 hex：按下反馈只用 hover-class 换色', () => {
    const scss = stripComments(profileScss())
    expect(scss).not.toMatch(/\btransition(?:-[\w-]+)?\s*:/)
    expect(scss).not.toMatch(/\banimation(?:-[\w-]+)?\s*:/)
    expect(scss).not.toMatch(/@(?:-\w+-)?keyframes/)
    expect(scss).not.toMatch(/\btransform\s*:/)
    expect(scss).not.toMatch(/\bopacity\s*:/)
    expect(scss).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(scss).toContain('$color-primary-pressed')
  })

  it('页面不写路径字面量 —— 四个目标全部来自 utils/routes.ts', () => {
    const source = stripComments(profileSource())
    expect(source).not.toMatch(/url\s*:\s*['"`]\/?pages\//)
    expect(source).not.toMatch(/^\s*const\s+\w*PATH\w*\s*=\s*['"`]pages\//m)
    for (const name of ['SCORE_LOGS_PATH', 'RESERVATION_LIST_PATH', 'STATIC_EXIT_PATHS']) {
      expect(source, `路径常量 ${name} 应来自 utils/routes.ts`).toContain(name)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #75 头像显示 / 缓存 / 清理
// ─────────────────────────────────────────────────────────────────────────────

const PART_42 = `${AVATAR_DIR}/42.part`

describe('#75 我的页 · 头像显示：只认本站文件地址', () => {
  it('缓存命中 → 同步显示本地路径，0 次 downloadFile', async () => {
    const { wx, page } = await mount([profileBody()])

    expect(page.data.avatarPath).toBe(`${AVATAR_DIR}/42`)
    expect(wx.downloadFile, '命中缓存不得再下载').not.toHaveBeenCalled()
  })

  it('缓存未命中 → 先默认图，后台只下 1 次，成功后换成缓存路径', async () => {
    const wx = installWxStub()
    const disk = installMemoryDisk(wx, {})
    // 下载先挂起：让「首帧」成为可观察事实，再由测试手动完成它。
    let pending: Parameters<InstalledWxStub['downloadFile']>[0] | undefined
    wx.downloadFile.mockImplementation((options) => {
      pending = options
      return { abort: vi.fn() }
    })
    wx.request.mockImplementation(respondInOrder([profileBody()]))
    const def = await loadPage()
    const page = instantiate(def)
    page.onShow?.()
    await settle()

    expect(page.data.avatarPath, '首帧必须是本地默认图').toBe('')
    expect(wx.downloadFile, '未命中只下 1 次').toHaveBeenCalledTimes(1)

    if (pending?.filePath !== undefined) disk.files.set(pending.filePath, 'downloaded')
    pending?.success?.(downloadOk(PART_42))
    await settle()

    expect(page.data.avatarPath).toBe(`${AVATAR_DIR}/42`)
  })

  it('`https://` 外链 → 默认图、零请求', async () => {
    const { wx, page } = await mount([
      profileBody({ avatar: 'https://wx.qlogo.cn/mmopen/abc/0' }),
    ])

    expect(page.data.avatarPath).toBe('')
    expect(wx.downloadFile).not.toHaveBeenCalled()
  })

  it('`null` → 默认图、零请求', async () => {
    const { wx, page } = await mount([profileBody({ avatar: null })], { files: {} })

    expect(page.data.avatarPath).toBe('')
    expect(wx.downloadFile).not.toHaveBeenCalled()
  })

  it('404 → 本次运行期记死；再次 onShow 不再下载', async () => {
    const { wx, page } = await mount([profileBody(), profileBody()], {
      files: {},
      downloads: [{ ...downloadOk(PART_42), statusCode: 404 }],
    })

    expect(wx.downloadFile).toHaveBeenCalledTimes(1)
    page.onShow?.()
    await settle()

    expect(wx.downloadFile, '404 后不得重试').toHaveBeenCalledTimes(1)
    expect(page.data.avatarPath).toBe('')
  })

  it('13.4 成功后清理缓存：只留当前 id、清空 pending', async () => {
    const { disk } = await mount([profileBody()], {
      files: {
        [`${AVATAR_DIR}/41`]: 'old',
        [`${AVATAR_DIR}/42`]: 'current',
        [`${AVATAR_DIR}/43.part`]: 'partial',
        [`${UPLOAD_DIR}/avatar`]: 'pending',
      },
    })

    expect([...disk.files.keys()].sort()).toEqual([`${AVATAR_DIR}/42`])
  })

  it('再次 onShow → 按新的当前 id 清理（旧头像被删）', async () => {
    const { page, disk } = await mount([profileBody(), profileBody({ avatar: '/api/app/v1/files/43' })], {
      files: { [`${AVATAR_DIR}/42`]: 'old' },
    })
    expect(disk.files.has(`${AVATAR_DIR}/42`)).toBe(true)

    disk.files.set(`${AVATAR_DIR}/43`, 'new')
    page.onShow?.()
    await settle()

    expect([...disk.files.keys()]).toEqual([`${AVATAR_DIR}/43`])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #75 选图 → 上传（弹层三态）
// ─────────────────────────────────────────────────────────────────────────────

const PENDING = `${UPLOAD_DIR}/avatar`
const TEMP_AVATAR = '/tmp/choose-avatar.jpg'
const AVATAR_42 = `${AVATAR_DIR}/42`
const AVATAR_77 = `${AVATAR_DIR}/77`

/** 选图测试的默认盘：已有旧头像缓存 + 一张待选的临时图。 */
function chooseFiles(extra: Record<string, string> = {}): Record<string, string> {
  return { [AVATAR_42]: 'cached', [TEMP_AVATAR]: 'image-bytes', ...extra }
}

/** 编排 `getImageInfo` —— 默认 800×600（不需要压缩）。 */
function arrangeImageInfo(wx: InstalledWxStub, width = 800, height = 600): void {
  wx.getImageInfo.mockImplementation((options) => {
    queueMicrotask(() =>
      options.success?.({
        width,
        height,
        path: PENDING,
        type: 'jpg',
        orientation: 'up',
        errMsg: 'getImageInfo:ok',
      }),
    )
  })
}

/** 一份契约形状的 `13.17` 成功响应。 */
function uploadOk(url = '/api/app/v1/files/77'): WxUploadFileSuccessResult {
  return {
    statusCode: 200,
    data: JSON.stringify({
      code: 0,
      message: 'ok',
      data: { id: Number(url.split('/').pop()), url, size: 1024, mime: 'image/jpeg', width: 1080, height: 1080 },
    }),
    errMsg: 'uploadFile:ok',
  }
}

/** 一份 `8008` 业务错误（HTTP 200 + code）。 */
function uploadRateLimited(): WxUploadFileSuccessResult {
  return {
    statusCode: 200,
    data: JSON.stringify({ code: 8008, message: '操作过于频繁，请稍后再试', data: null }),
    errMsg: 'uploadFile:ok',
  }
}

async function openAndChoose(
  page: PageInstance,
  wx: InstalledWxStub,
): Promise<void> {
  page.onEditProfile?.()
  await page.onChooseAvatar?.({ detail: { avatarUrl: TEMP_AVATAR } })
  await settle()
  expect(wx.uploadFile, '选图必须走一次上传（否则本用例的编排不成立）').toHaveBeenCalled()
}

describe('#75 我的页 · 选图上传三态', () => {
  it('上传中头像位 spinner、保存禁用；成功后预览 pending 本地文件', async () => {
    const uploads: WxUploadFileOptions[] = []
    const { wx, page, disk } = await mount([profileBody()], {
      files: chooseFiles(),
      setup(stub) {
        arrangeImageInfo(stub)
        stub.uploadFile.mockImplementation((options) => {
          uploads.push(options)
          return { abort: vi.fn() }
        })
      },
    })

    page.onEditProfile?.()
    page.onChooseAvatar?.({ detail: { avatarUrl: TEMP_AVATAR } })
    await settle()

    expect(page.data.avatarUploading, '上传中').toBe(true)
    const wxml = stripComments(profileWxml())
    expect(wxml, '保存按钮在上传中必须禁用').toMatch(
      /<van-button[^>]*disabled="\{\{ saving \|\| avatarUploading \}\}"/,
    )

    uploads[0]?.success?.(uploadOk())
    await settle()

    expect(page.data.avatarUploading).toBe(false)
    expect(page.data.avatarError).toBe('')
    expect(page.data.avatarPreviewPath, '成功后用 pending 本地文件预览').toBe(PENDING)
    expect(disk.files.has(PENDING), 'pending 必须留到保存成功').toBe(true)
    expect(wx.uploadFile).toHaveBeenCalledTimes(1)
    // 只选图不保存 → 不得发 PUT。
    expect(profileRequests(wx)).toHaveLength(1)
  })

  it('上传失败 → 「图片上传失败，请重试」，pending 保留，不自动重试', async () => {
    const { wx, page, disk } = await mount([profileBody()], {
      files: chooseFiles(),
      setup(stub) {
        arrangeImageInfo(stub)
        stub.uploadFile.mockImplementation((options) => {
          queueMicrotask(() => options.fail?.({ errMsg: 'uploadFile:fail timeout' }))
          return { abort: vi.fn() }
        })
      },
    })

    await openAndChoose(page, wx)

    expect(page.data.avatarUploading).toBe(false)
    expect(page.data.avatarError).toBe(PROFILE_COPY.avatarUploadFailed)
    expect(disk.files.has(PENDING), '失败后重试不能重选，pending 必须还在').toBe(true)
    expect(wx.uploadFile, '不得自动重试').toHaveBeenCalledTimes(1)
    expect(page.data.popupVisible).toBe(true)
  })

  it('压缩三轮仍超限 → 「图片过大，请换一张」、零上传、原头像不变', async () => {
    const { wx, page, disk } = await mount([profileBody()], {
      files: chooseFiles({
        '/tmp/compressed-1.jpg': 'x',
        '/tmp/compressed-2.jpg': 'x',
        '/tmp/compressed-3.jpg': 'x',
      }),
      setup(stub, disk2) {
        arrangeImageInfo(stub)
        stub.compressImage.mockImplementation((options) => {
          const index = stub.compressImage.mock.calls.length
          queueMicrotask(() =>
            options.success?.({ tempFilePath: `/tmp/compressed-${index}.jpg`, errMsg: 'compressImage:ok' }),
          )
        })
        disk2.fs.stat.mockImplementation(({ path, success, fail }) => {
          queueMicrotask(() => {
            if (path === PENDING) {
              success?.({ stats: { size: 2_097_153 }, errMsg: 'stat:ok' })
              return
            }
            const content = disk2.files.get(path)
            if (content === undefined) fail?.({ errMsg: `fail no such file or directory ${path}` })
            else success?.({ stats: { size: Buffer.byteLength(content) }, errMsg: 'stat:ok' })
          })
        })
      },
    })

    page.onEditProfile?.()
    await page.onChooseAvatar?.({ detail: { avatarUrl: TEMP_AVATAR } })
    await settle()

    expect(page.data.avatarError).toBe(PROFILE_COPY.avatarTooLarge)
    expect(page.data.avatarUploading).toBe(false)
    expect(wx.uploadFile, '超限必须零上传').not.toHaveBeenCalled()
    expect(page.data.avatarPath, '原头像不变').toBe(AVATAR_42)
    expect(page.data.avatarPreviewPath, '预览保持原头像').toBe(AVATAR_42)
    expect(disk.files.has(PENDING), '压缩产物留在 pending，关闭时清理').toBe(true)
  })

  it('chooseAvatar 无回调 → 静默返回：不 loading、不发请求、弹层状态不变', async () => {
    const { wx, page } = await mount([profileBody()], { files: chooseFiles() })
    page.onEditProfile?.()
    const before = {
      popupVisible: page.data.popupVisible,
      avatarPreviewPath: page.data.avatarPreviewPath,
      avatarError: page.data.avatarError,
      avatarUploading: page.data.avatarUploading,
    }

    await page.onChooseAvatar?.({ detail: {} })
    await page.onChooseAvatar?.({ detail: { avatarUrl: '' } })
    await settle()

    expect(page.data).toMatchObject(before)
    expect(page.data.avatarUploading).toBe(false)
    expect(wx.uploadFile).not.toHaveBeenCalled()
    expect(wx.getImageInfo).not.toHaveBeenCalled()
    expect(wx.compressImage).not.toHaveBeenCalled()
  })

  it('8008 → 「操作太频繁，请稍后再试」、保留 pending、0 次自动重试', async () => {
    const { wx, page, disk } = await mount([profileBody()], {
      files: chooseFiles(),
      setup(stub) {
        arrangeImageInfo(stub)
        stub.uploadFile.mockImplementation((options) => {
          queueMicrotask(() => options.success?.(uploadRateLimited()))
          return { abort: vi.fn() }
        })
      },
    })

    await openAndChoose(page, wx)

    expect(page.data.avatarError).toBe(PROFILE_COPY.avatarRateLimited)
    expect(page.data.avatarUploading).toBe(false)
    expect(wx.uploadFile, '8008 后不得自动重试').toHaveBeenCalledTimes(1)
    expect(disk.files.has(PENDING), '8008 要保留待提交文件').toBe(true)
    expect(page.data.popupVisible).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #75 保存：只发变化字段 / 重试语义 / 缓存转正
// ─────────────────────────────────────────────────────────────────────────────

/** 让 `wx.uploadFile` 按序回话（成功 / 失败 / 业务错误都行）。 */
function arrangeUploads(
  wx: InstalledWxStub,
  results: readonly (WxUploadFileSuccessResult | { errMsg: string })[],
): void {
  let index = 0
  wx.uploadFile.mockImplementation((options) => {
    const result = results[index]
    index += 1
    if (result === undefined) {
      throw new Error(`wx.uploadFile 第 ${index} 次被调用，但只编排了 ${results.length} 个响应`)
    }
    queueMicrotask(() => {
      if ('statusCode' in result) options.success?.(result)
      else options.fail?.(result)
    })
    return { abort: vi.fn() }
  })
}

/** 选图 + 等上传完成（正常路径）。 */
async function chooseAndUpload(page: PageInstance): Promise<void> {
  page.onEditProfile?.()
  await page.onChooseAvatar?.({ detail: { avatarUrl: TEMP_AVATAR } })
  await settle()
  expect(page.data.avatarPreviewPath).toBe(PENDING)
}

describe('#75 我的页 · 保存只发变化字段', () => {
  it('只换头像 → PUT body 只有 avatar；成功 1 次 PUT + 1 次 13.4，pending 转正不下载', async () => {
    const { wx, page, disk } = await mount(
      [profileBody(), updateOk(), profileBody({ avatar: '/api/app/v1/files/77' })],
      {
        files: chooseFiles(),
        setup(stub) {
          arrangeImageInfo(stub)
          arrangeUploads(stub, [uploadOk()])
        },
      },
    )
    await chooseAndUpload(page)

    const before = profileRequests(wx).length
    await page.onSaveProfile?.()
    await settle()

    const requests = profileRequests(wx)
    expect(requests, '保存阶段恰好 1 次 PUT + 1 次 13.4').toHaveLength(before + 2)
    expect(requests[before]?.method).toBe('PUT')
    expect(requests[before]?.data, '只发变化字段').toEqual({
      avatar: '/api/app/v1/files/77',
    })
    expect(requests[before]?.data).not.toHaveProperty('nickname')
    expect(requests[before + 1]?.method).toBe('GET')
    expect(wx.uploadFile, '已上传成功，保存不得再传').toHaveBeenCalledTimes(1)
    expect(wx.downloadFile, 'pending 直接转正，保存成功不下载').not.toHaveBeenCalled()

    expect(page.data.popupVisible).toBe(false)
    expect(page.data.avatarPath, '屏上头像换成新 url 的本地缓存路径').toBe(AVATAR_77)
    expect(disk.files.has(PENDING)).toBe(false)
    expect(disk.files.get(AVATAR_77)).toBe('image-bytes')
    expect(disk.files.has(AVATAR_42), '旧头像缓存被清理').toBe(false)
  })

  it('昵称与头像都变 → 两个字段都发（昵称仍提交 trim 后的值）', async () => {
    const { wx, page } = await mount(
      [profileBody(), updateOk(), profileBody({ avatar: '/api/app/v1/files/77' })],
      {
        files: chooseFiles(),
        setup(stub) {
          arrangeImageInfo(stub)
          arrangeUploads(stub, [uploadOk()])
        },
      },
    )
    await chooseAndUpload(page)
    page.onNicknameInput?.({ detail: { value: '  新昵称  ' } })

    await page.onSaveProfile?.()
    await settle()

    const requests = profileRequests(wx)
    expect(requests[1]?.method).toBe('PUT')
    expect(requests[1]?.data).toEqual({
      nickname: '新昵称',
      avatar: '/api/app/v1/files/77',
    })
  })

  it('上传成功但 PUT 失败 → 保留 url、弹层不关；再保存只重发 PUT（0 次 uploadFile）', async () => {
    const { wx, page } = await mount(
      [profileBody(), networkFailure(), updateOk(), profileBody({ avatar: '/api/app/v1/files/77' })],
      {
        files: chooseFiles(),
        setup(stub) {
          arrangeImageInfo(stub)
          arrangeUploads(stub, [uploadOk()])
        },
      },
    )
    await chooseAndUpload(page)

    await page.onSaveProfile?.()
    await settle()

    expect(page.data.popupVisible, 'PUT 失败不关弹层').toBe(true)
    expect(page.data.nicknameError).toBe(PROFILE_COPY.saveFailed)
    expect(wx.uploadFile).toHaveBeenCalledTimes(1)
    expect(page.data.avatarPreviewPath, '已上传的 pending 预览仍在').toBe(PENDING)

    await page.onSaveProfile?.()
    await settle()

    const requests = profileRequests(wx)
    expect(requests.map((request) => request.method)).toEqual(['GET', 'PUT', 'PUT', 'GET'])
    expect(wx.uploadFile, '重试只重发 PUT').toHaveBeenCalledTimes(1)
    expect(page.data.popupVisible).toBe(false)
    expect(page.data.avatarPath).toBe(AVATAR_77)
  })

  it('上传失败后点保存 → 先重传（再 1 次 uploadFile、0 次重选），成功后再 PUT', async () => {
    const { wx, page } = await mount(
      [profileBody(), updateOk(), profileBody({ avatar: '/api/app/v1/files/77' })],
      {
        files: chooseFiles(),
        setup(stub) {
          arrangeImageInfo(stub)
          arrangeUploads(stub, [{ errMsg: 'uploadFile:fail timeout' }, uploadOk()])
        },
      },
    )
    page.onEditProfile?.()
    await page.onChooseAvatar?.({ detail: { avatarUrl: TEMP_AVATAR } })
    await settle()
    expect(page.data.avatarError).toBe(PROFILE_COPY.avatarUploadFailed)

    await page.onSaveProfile?.()
    await settle()

    expect(wx.uploadFile, '重试 = 再 1 次上传').toHaveBeenCalledTimes(2)
    const requests = profileRequests(wx)
    expect(requests[1]?.method).toBe('PUT')
    expect(requests[1]?.data).toEqual({ avatar: '/api/app/v1/files/77' })
    expect(page.data.popupVisible).toBe(false)
  })

  it('8008 后点保存 → 再 1 次 uploadFile、0 次重选，成功后继续 PUT', async () => {
    const { wx, page } = await mount(
      [profileBody(), updateOk(), profileBody({ avatar: '/api/app/v1/files/77' })],
      {
        files: chooseFiles(),
        setup(stub) {
          arrangeImageInfo(stub)
          arrangeUploads(stub, [uploadRateLimited(), uploadOk()])
        },
      },
    )
    page.onEditProfile?.()
    await page.onChooseAvatar?.({ detail: { avatarUrl: TEMP_AVATAR } })
    await settle()
    expect(page.data.avatarError).toBe(PROFILE_COPY.avatarRateLimited)
    expect(wx.uploadFile).toHaveBeenCalledTimes(1)

    await page.onSaveProfile?.()
    await settle()

    expect(wx.uploadFile, '用户再点保存才重试，且只试一次').toHaveBeenCalledTimes(2)
    expect(page.data.popupVisible).toBe(false)
    expect(page.data.avatarPath).toBe(AVATAR_77)
  })

  it('上传重试仍失败 → 不发 PUT，弹层不关、待提交文件还在', async () => {
    const { wx, page, disk } = await mount([profileBody()], {
      files: chooseFiles(),
      setup(stub) {
        arrangeImageInfo(stub)
        arrangeUploads(stub, [
          { errMsg: 'uploadFile:fail timeout' },
          { errMsg: 'uploadFile:fail timeout' },
        ])
      },
    })
    page.onEditProfile?.()
    await page.onChooseAvatar?.({ detail: { avatarUrl: TEMP_AVATAR } })
    await settle()

    await page.onSaveProfile?.()
    await settle()

    expect(wx.uploadFile).toHaveBeenCalledTimes(2)
    expect(profileRequests(wx), '上传没成功就不得 PUT').toHaveLength(1)
    expect(page.data.popupVisible).toBe(true)
    expect(page.data.avatarError).toBe(PROFILE_COPY.avatarUploadFailed)
    expect(disk.files.has(PENDING)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #75 关闭弹层：abort / 删 pending / 丢弃 url / 迟到回调
// ─────────────────────────────────────────────────────────────────────────────

describe('#75 我的页 · 关闭弹层', () => {
  it('上传进行中关闭 → UploadTask.abort()、删 pending；迟到回调不改已关闭弹层', async () => {
    const uploads: WxUploadFileOptions[] = []
    const abort = vi.fn()
    const { wx, page, disk } = await mount([profileBody()], {
      files: chooseFiles(),
      setup(stub) {
        arrangeImageInfo(stub)
        stub.uploadFile.mockImplementation((options) => {
          uploads.push(options)
          return { abort }
        })
      },
    })
    page.onEditProfile?.()
    void page.onChooseAvatar?.({ detail: { avatarUrl: TEMP_AVATAR } })
    await settle()

    expect(page.data.avatarUploading).toBe(true)
    expect(disk.files.has(PENDING)).toBe(true)

    page.onCancelEdit?.()
    await settle()

    expect(abort, '关闭上传中的弹层必须 abort').toHaveBeenCalledTimes(1)
    expect(disk.files.has(PENDING), 'pending 必须删掉').toBe(false)
    expect(page.data.popupVisible).toBe(false)
    expect(page.data.avatarUploading).toBe(false)

    // 迟到的成功 / 失败都不许把状态写回已关闭的弹层。
    uploads[0]?.success?.(uploadOk())
    uploads[0]?.fail?.({ errMsg: 'uploadFile:fail abort' })
    await settle()

    expect(page.data.popupVisible).toBe(false)
    expect(page.data.avatarPreviewPath).toBe('')
    expect(page.data.avatarError).toBe('')
    expect(page.data.avatarPath, '当前头像不变').toBe(AVATAR_42)
    expect(profileRequests(wx), '取消不得发 PUT').toHaveLength(1)
  })

  it('已上传未保存时关闭 → 丢弃 url 并删 pending，不调服务端删除', async () => {
    const { wx, page, disk } = await mount([profileBody()], {
      files: chooseFiles(),
      setup(stub) {
        arrangeImageInfo(stub)
        arrangeUploads(stub, [uploadOk()])
      },
    })
    await chooseAndUpload(page)
    expect(disk.files.has(PENDING)).toBe(true)

    page.onCancelEdit?.()
    await settle()

    expect(disk.files.has(PENDING), '丢弃的 pending 必须删掉').toBe(false)
    expect(wx.uploadFile, '关闭不得再上传').toHaveBeenCalledTimes(1)
    expect(profileRequests(wx), '已上传未保存关闭只丢弃本地 url，不发 PUT / 删除').toHaveLength(1)
    expect(page.data.avatarPath).toBe(AVATAR_42)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #75 源码守卫：文案层 / 零开关 / 零直接请求
// ─────────────────────────────────────────────────────────────────────────────

describe('#75 我的页 · 源码守卫', () => {
  const NEW_COPY = [
    ['avatarUploadFailed', '图片上传失败，请重试'],
    ['avatarTooLarge', '图片过大，请换一张'],
    ['avatarRateLimited', '操作太频繁，请稍后再试'],
  ] as const

  it('三条新文案逐字在 PROFILE_COPY 里，且只出现在 copy.ts', () => {
    for (const [key, literal] of NEW_COPY) {
      expect(PROFILE_COPY[key], `${key} 必须逐字`).toBe(literal)
      // 文案层里有且只有一份字面量（注释不重复它）。
      expect(stripComments(copySource()).split(literal), `${literal} 在 copy.ts 里应恰好一次`).toHaveLength(2)
      const offenders = collectMiniprogramFiles()
        .filter((file) => file !== join(repoRoot, 'miniprogram', 'startup', 'copy.ts'))
        .filter((file) => stripComments(readFileSync(file, 'utf8')).includes(literal))
      expect(offenders, `「${literal}」只能出现在 copy.ts`).toEqual([])
    }
  })

  it('页面零 `/api/app/v1/files` 字面量、不 import request/', () => {
    const source = stripComments(profileSource()) + stripComments(profileWxml())
    expect(source).not.toContain('/api/app/v1/files')
    expect(stripComments(profileSource())).not.toMatch(/from\s+['"][^'"]*\/request\//)
  })

  it('不存在任何头像上传开关常量（AVATAR_UPLOAD_ENABLED 零定义、零引用）', () => {
    const offenders = collectMiniprogramFiles().filter((file) =>
      /AVATAR_UPLOAD_ENABLED|UPLOAD_ENABLED/.test(stripComments(readFileSync(file, 'utf8'))),
    )
    expect(offenders, '本票不允许引入任何上传开关').toEqual([])
  })

  it('头像入口是原生 chooseAvatar 按钮；上传中保存禁用', () => {
    const wxml = stripComments(profileWxml())
    expect(wxml).toMatch(/<button[^>]*open-type="chooseAvatar"[^>]*bind:chooseavatar="onChooseAvatar"/)
    expect(wxml).toMatch(/disabled="\{\{ saving \|\| avatarUploading \}\}"/)
    expect(wxml).toMatch(/<van-loading wx:if="\{\{ avatarUploading \}\}"/)
  })

  it('保存成功路径不得在页面里直接下载 / 上传 / 拼文件地址', () => {
    const source = stripComments(profileSource())
    for (const api of ['wx.uploadFile', 'wx.downloadFile', 'wx.getFileSystemManager', 'wx.compressImage']) {
      expect(source, `页面不得直接调 ${api}`).not.toContain(api)
    }
    expect(source).toContain('promotePendingAvatar')
    expect(source).toContain('discardPendingAvatar')
  })
})
