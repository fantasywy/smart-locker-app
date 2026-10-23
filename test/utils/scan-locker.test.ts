// **扫码 → 柜机页**这条共享链路的验收 —— code review finding B。
//
// 断言只落在外部行为：`wx.scanCode` 收到了什么、`wx.navigateTo` / `wx.redirectTo`
// 去了哪里、toast 说了哪句（文案从 `SCAN_COPY` 引用，不写第二份字面量）。
//
// 五个调用点（首页 / 订单列表 / 订单详情 / 等待页 / 预约列表）此前各抄了一份这段链路，
// 于是「取消静默」「非柜机码提示」在四页里各有一份实现。这份用例把链路本体钉住，
// 页面侧只需要各断言「调用时选了哪种导航方式」。

import { describe, expect, it, vi } from 'vitest'
import { installWxStub } from '../helpers/wx'
import type { InstalledWxStub } from '../helpers/wx'
import { SCAN_COPY } from '../../miniprogram/startup/copy'
import { LOCKER_PATH } from '../../miniprogram/utils/routes'

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
}))

vi.mock('../../miniprogram/utils/feedback', () => ({
  showToast: mocks.showToast,
}))

/** 一个「会回话」的扫码桩：第 n 次调用走第 n 个结果。 */
function scanReturns(
  wx: InstalledWxStub,
  outcomes: readonly { result?: string; errMsg?: string }[],
): void {
  let index = 0
  wx.scanCode.mockImplementation((options) => {
    const outcome = outcomes[index]
    index += 1
    if (outcome === undefined) throw new Error('scanCode 调用次数超出编排')
    if (outcome.errMsg !== undefined) options.fail?.({ errMsg: outcome.errMsg })
    else options.success?.({ result: outcome.result ?? '', errMsg: 'scanCode:ok' })
  })
}

function openUrls(mock: { mock: { calls: unknown[][] } }): string[] {
  return mock.mock.calls.map((call) => (call[0] as { url: string }).url)
}

const LOCKER_URL = `https://example.com/l/WD-01`

/** 两个导航 API 都是「会真跳」的桩：编排成空实现，只读调用记录。 */
function allowNavigation(wx: InstalledWxStub): void {
  wx.navigateTo.mockImplementation(() => {})
  wx.redirectTo.mockImplementation(() => {})
}

describe('utils/scan-locker —— 扫码到柜机页的唯一条链路', () => {
  it.each([
    ['navigate' as const, 'navigateTo' as const],
    ['redirect' as const, 'redirectTo' as const],
  ])('导航方式 %s → 柜机页带 code，走 %s', async (navigation, api) => {
    const wx = installWxStub()
    allowNavigation(wx)
    scanReturns(wx, [{ result: LOCKER_URL }])
    const { scanToLocker } = await import('../../miniprogram/utils/scan-locker')

    scanToLocker(navigation)

    expect(openUrls(wx[api])).toEqual([`/${LOCKER_PATH}?code=WD-01`])
    // 另一种导航方式是**不**被使用的 —— 两种方式是可判定的二选一。
    const other = api === 'navigateTo' ? 'redirectTo' : 'navigateTo'
    expect(wx[other]).not.toHaveBeenCalled()
  })

  it('非柜机码：留在原地、一句提示，不做任何跳转', async () => {
    const wx = installWxStub()
    allowNavigation(wx)
    scanReturns(wx, [{ result: 'https://example.com/other/thing' }])
    const { scanToLocker } = await import('../../miniprogram/utils/scan-locker')

    scanToLocker('navigate')

    expect(mocks.showToast).toHaveBeenCalledWith(SCAN_COPY.notLockerCode)
    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(wx.redirectTo).not.toHaveBeenCalled()
  })

  it('用户主动取消 → 静默（取消不是失败）', async () => {
    const wx = installWxStub()
    allowNavigation(wx)
    scanReturns(wx, [{ errMsg: 'scanCode:fail cancel' }])
    const { scanToLocker } = await import('../../miniprogram/utils/scan-locker')

    scanToLocker('navigate')

    expect(mocks.showToast).not.toHaveBeenCalled()
    expect(wx.navigateTo).not.toHaveBeenCalled()
  })

  it('其余失败不按成因分叉 → 同一句通用提示', async () => {
    const wx = installWxStub()
    allowNavigation(wx)
    scanReturns(wx, [{ errMsg: 'scanCode:fail camera error' }])
    const { scanToLocker } = await import('../../miniprogram/utils/scan-locker')

    scanToLocker('navigate')

    expect(mocks.showToast).toHaveBeenCalledWith(SCAN_COPY.scanFailed)
  })

  it('不传 onlyFromCamera —— 默认允许相册选码（spec §2）', async () => {
    const wx = installWxStub()
    allowNavigation(wx)
    scanReturns(wx, [{ result: LOCKER_URL }])
    const { scanToLocker } = await import('../../miniprogram/utils/scan-locker')

    scanToLocker('navigate')

    const options = wx.scanCode.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(options).not.toHaveProperty('onlyFromCamera')
  })

  it('柜机码做一次 URL 编码，保留字符不破坏查询串', async () => {
    const wx = installWxStub()
    allowNavigation(wx)
    scanReturns(wx, [{ result: 'https://example.com/l/WD 01' }])
    const { scanToLocker } = await import('../../miniprogram/utils/scan-locker')

    scanToLocker('navigate')

    expect(openUrls(wx.navigateTo)).toEqual([`/${LOCKER_PATH}?code=WD%2001`])
  })

  it('本模块不写用户可见字面量：两句反馈都从 `SCAN_COPY` 取', async () => {
    const source = (
      await import('node:fs')
    ).readFileSync(
      new URL('../../miniprogram/utils/scan-locker.ts', import.meta.url),
      'utf8',
    )
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(code).toContain('SCAN_COPY.notLockerCode')
    expect(code).toContain('SCAN_COPY.scanFailed')
    expect(code).not.toContain(SCAN_COPY.notLockerCode)
    expect(code).not.toContain(SCAN_COPY.scanFailed)
  })
})
