// **反馈适配层** —— 轻提示与确认弹窗的唯一出口（spec §14.10 / §11）。
//
// 判据只到「交给 Vant 的文案与按钮」这一层：`Toast` / `Dialog` 是用 `vi.mock` 换掉的
// **边界替身**，断言的是用户最终看到的那几句话与两个按钮，不测 Vant 内部怎么渲染
// （spec Testing Decisions 逐字：「测试断言文案与按钮，不测 Vant 内部」）。
//
// ⚠️ 页面代码不得直接 `import` Vant 的 Toast / Dialog —— 那样文案与禁用词就散成了
// 多份，页面还各自持有弹窗宿主。本文件最后一条源码守卫把这条钉死。

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIRM_COPY } from '../../miniprogram/startup/copy'

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  dialogConfirm: vi.fn(),
}))

vi.mock('@vant/weapp/toast/toast', () => ({ default: mocks.toast }))
vi.mock('@vant/weapp/dialog/dialog', () => ({ default: { confirm: mocks.dialogConfirm } }))

import { confirm, showToast } from '../../miniprogram/utils/feedback'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const miniprogramDir = join(repoRoot, 'miniprogram')

beforeEach(() => {
  mocks.toast.mockReset()
  mocks.dialogConfirm.mockReset()
})

describe('#59 反馈适配层 · 轻提示', () => {
  it('⚠️ 只把文案交给 Toast —— 页面不碰 Vant 内部', () => {
    showToast('订单已取消')
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    expect(mocks.toast.mock.calls[0]?.[0]).toMatchObject({ message: '订单已取消' })
  })

  it('⚠️ 可选展示时长原样传递；不传时不伪造 duration（走 Vant 默认）', () => {
    showToast({ message: '已重新发出开门指令', duration: 1500 })
    expect(mocks.toast.mock.calls[0]?.[0]).toMatchObject({
      message: '已重新发出开门指令',
      duration: 1500,
    })

    mocks.toast.mockReset()
    showToast('订单已取消')
    expect(mocks.toast.mock.calls[0]?.[0]).not.toHaveProperty('duration')
  })
})

describe('#59 反馈适配层 · 确认弹窗', () => {
  it('⚠️ 默认按钮文案来自 copy.ts，不是 Vant 的默认值', async () => {
    expect(CONFIRM_COPY).toEqual({ confirm: '确认', cancel: '取消' })
    mocks.dialogConfirm.mockResolvedValue(undefined)

    await confirm({ title: '取消这单？', message: '取消后格口会释放，不会产生费用。' })

    expect(mocks.dialogConfirm).toHaveBeenCalledTimes(1)
    expect(mocks.dialogConfirm.mock.calls[0]?.[0]).toMatchObject({
      title: '取消这单？',
      message: '取消后格口会释放，不会产生费用。',
      confirmButtonText: '确认',
      cancelButtonText: '取消',
      showCancelButton: true,
    })
  })

  it('⚠️ 动作专属的按钮文案（取消订单 / 开始使用 / 确认存件）由调用方逐字传入', async () => {
    mocks.dialogConfirm.mockResolvedValue(undefined)

    await confirm({
      title: '取消预约？',
      message: '取消后格口会被释放，预约不可恢复。',
      confirmText: '取消预约',
      cancelText: '再想想',
    })

    expect(mocks.dialogConfirm.mock.calls[0]?.[0]).toMatchObject({
      confirmButtonText: '取消预约',
      cancelButtonText: '再想想',
    })
  })

  it('⚠️ 确认 resolve(true)；取消 / 遮罩关闭 resolve(false) —— 页面只关心二值结果', async () => {
    mocks.dialogConfirm.mockResolvedValueOnce(undefined)
    await expect(confirm({ message: '确定？' })).resolves.toBe(true)

    mocks.dialogConfirm.mockRejectedValueOnce({ action: 'cancel' })
    await expect(confirm({ message: '确定？' })).resolves.toBe(false)

    mocks.dialogConfirm.mockRejectedValueOnce({ action: 'overlay' })
    await expect(confirm({ message: '确定？' })).resolves.toBe(false)
  })
})

describe('#59 反馈适配层是唯一入口', () => {
  it('⚠️ 页面 / 组件 / startup 不得直接 import Vant 的 Toast 或 Dialog', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!entry.name.endsWith('.ts')) continue
        if (full === join(miniprogramDir, 'utils', 'feedback.ts')) continue
        const source = readFileSync(full, 'utf8')
        if (/@vant\/weapp\/(?:toast|dialog)/.test(source)) {
          offenders.push(relative(repoRoot, full))
        }
      }
    }
    walk(miniprogramDir)
    expect(offenders, `以下文件绕过了反馈适配层：\n${offenders.join('\n')}`).toEqual([])
  })
})
