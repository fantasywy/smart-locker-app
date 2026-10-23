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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWxStub, jsonResponse, networkFailure } from '../helpers/wx'
import { requestsTo, respondInOrder, sentRequests } from '../helpers/http'
import type { InstalledWxStub } from '../helpers/wx'
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

/** 装桩、编排一组响应、加载页面并触发首次 `onShow`。 */
async function mount(
  responses: Parameters<typeof respondInOrder>[0],
): Promise<{ wx: InstalledWxStub; page: PageInstance; def: Record<string, unknown> }> {
  const wx = installWxStub()
  wx.request.mockImplementation(respondInOrder(responses))
  const def = await loadPage()
  const page = instantiate(def)
  page.onShow?.()
  await settle()
  return { wx, page, def }
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

  it('头像只读：无上传 / 压缩 / 选图入口，也无编译期开关', () => {
    const source = stripComments(profileSource()) + stripComments(profileWxml())
    for (const forbidden of [
      'AVATAR_UPLOAD_ENABLED',
      'chooseAvatar',
      'uploadFile',
      'compressImage',
      'wx.chooseMedia',
      'wx.chooseImage',
    ]) {
      expect(source, `头像本票只读，却出现了「${forbidden}」`).not.toContain(forbidden)
    }
    // 本地默认头像用 icon 组件（构建期 data URI），不是网络图片。
    expect(source).toContain('<icon name="profile.avatar"')
    expect(source).not.toContain('<image')
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
