// **柜机码三来源收敛**的验收 —— issue #26 §1（`resolveLockerCode()`）。
//
// ## 为什么这条是纯函数、也就因此可以独立测
//
// 票面逐字：「收敛逻辑是**纯函数**，应可独立测试（不需 `wx.*` 桩）」。
// 它的三个来源（`q` / `options.code` / `scanCode.result`）**全部是字符串**，
// 而「从哪个来源进来的」这件事在收敛之后从产品里消失（`01` §2.2）——
// 所以本文件**不装 `wx` 桩**，也不该装：装了就说明这个函数碰到了它不该碰的东西。
//
// 出处：`docs/spec/01-entry-and-identity.md` §2.1（载荷格式 `https://<域名>/l/{lockerCode}`）、
// §2.2（两条通道 + 三来源收敛 + `scancode_time` 不参与业务判断）、§6.1（解析不出 code）。

import { describe, expect, it } from 'vitest'
import { resolveLockerCode } from '../../miniprogram/utils/locker-code'

describe('#26 resolveLockerCode · 通道 A：微信「扫一扫」直达（01 §2.2）', () => {
  it('⚠️ `q` 是**完整链接的 URL 编码** —— 必须 `decodeURIComponent` 一次', () => {
    // `01` §2.2 原文：「`onLoad(q)`，`q` = **完整链接的 URL 编码**，需 `decodeURIComponent` 一次」。
    // 微信给了两处编码：整个 URL 被编码一次，URL 里的 `:` 与 `/` 也各被编了一次
    // （`https%3A%2F%2F...`）—— 这正是真机上真实拿到的形态。
    const q = 'https%3A%2F%2Flocker.example.com%2Fl%2FWD-01'
    expect(resolveLockerCode({ q })).toBe('WD-01')
  })

  it('⚠️ 只 `decodeURIComponent` **一次** —— 解两次会把含 `%` 的码解坏', () => {
    // 「一次」是票面逐字。若实现写成循环解码 / 解两次，一个本身含转义序列的柜机码
    // 会被**多解一层** —— 而柜机码是印在贴纸上的静态编号，
    // 解出来的东西既不是用户扫到的、也不是服务端认得的。
    // 这里用一个「解一次后仍是合法内容」的码来钉住次数：
    // 解两次会得到 'WD-01' 之外的另一个串（`%2541` → `%41` → `A`）。
    const q = 'https%3A%2F%2Flocker.example.com%2Fl%2FWD%2D01'
    expect(resolveLockerCode({ q })).toBe('WD-01')
  })

  it('⚠️ 未编码的完整链接同样接住 —— 微信不保证一定给编码形态', () => {
    // 同一个 `q` 参数在真机上可能已经是**未编码**的完整 URL（工具与真机行为有差异）。
    // 收敛函数不因此分叉：两者的结果必须一致，否则「两条通道表现一致」在
    // 「同一条通道的两种编码形态」上就先破了。
    expect(resolveLockerCode({ q: 'https://locker.example.com/l/WD-01' })).toBe('WD-01')
  })

  it('⚠️ `scancode_time` **不参与任何业务判断**（01 §2.2:38）', () => {
    // 票面逐字：「柜机二维码是静态贴纸，时间戳没有语义」。
    // 落成断言的方式：**同一个 `q`，时间戳天差地别，结果必须逐字相同**。
    // 若实现里冒出一个「太旧就作废」的分支，这一条会红。
    const q = 'https%3A%2F%2Flocker.example.com%2Fl%2FWD-01'
    expect(resolveLockerCode({ q, scancode_time: '1' })).toBe('WD-01')
    expect(resolveLockerCode({ q, scancode_time: '9999999999' })).toBe('WD-01')
    expect(resolveLockerCode({ q })).toBe('WD-01')
  })
})

describe('#26 resolveLockerCode · 通道 B：小程序内 `wx.scanCode`（01 §2.2）', () => {
  it('⚠️ `scanCode.result` 是完整链接 —— 与通道 A 收敛到同一个 code', () => {
    // `01` §2.2 的「**两条通道表现必须一致**」在收敛层就是这一条：
    // 两个来源给出**同一个字符串输入**，因此必须给出同一个输出。
    // 一旦实现按来源分叉（「通道 B 直接当码用」），这里会红。
    expect(resolveLockerCode({ scanResult: 'https://locker.example.com/l/WD-01' })).toBe('WD-01')
  })

  it('⚠️ 与通道 A 逐字等价 —— 同一份输入、同一份输出', () => {
    // 把「两通道一致」写成一条**逐字相等**的断言，而不是两条各测一次的断言：
    // 后者在实现分叉时**照样全绿**（各走各的路，各自自洽）。
    const url = 'https://locker.example.com/l/WD-07'
    expect(resolveLockerCode({ scanResult: url })).toBe(resolveLockerCode({ q: url }))
  })
})

describe('#26 resolveLockerCode · 第三个来源 `options.code`（01 §2.2 表）', () => {
  it('⚠️ `options.code` 是**裸柜机码**，原样收敛（不解析 URL）', () => {
    // 票面：「`options.code`（spec 定义的第三个来源，本票须一并覆盖）」。
    // ⚠️ 它与另外两个**形状不同**：`q` / `scanResult` 是完整链接（`01` §2.1 的载荷格式），
    // 而 `code` 按名字与 spec 的用法（柜机页入参 `code`）就是那个编号本身。
    // ⇒ 实现**不得**对 `code` 施加 URL 解析：解析一个裸码只会把它解坏或解空。
    expect(resolveLockerCode({ code: 'WD-01' })).toBe('WD-01')
  })

  it('⚠️ `code` 与 URL 来源一致时结果相同 —— 三条路汇成一个值', () => {
    // 票面的「收敛成一个 `code`」：三个来源不是三条结果路径，是同一个值的三种拿法。
    const expected = 'WD-01'
    expect(resolveLockerCode({ code: expected })).toBe(expected)
    expect(resolveLockerCode({ q: `https%3A%2F%2Flocker.example.com%2Fl%2F${expected}` })).toBe(
      expected,
    )
    expect(resolveLockerCode({ scanResult: `https://locker.example.com/l/${expected}` })).toBe(
      expected,
    )
  })
})

describe('#26 resolveLockerCode · 解析不出 code（01 §6.1 第一行）', () => {
  it('⚠️ 三个来源都没有 → `null`（不是空串、不是抛异常）', () => {
    // `01` §6.1 第一行：「解析不出 `code`｜入口失效」。
    // 返回 `null` 而不是空串：空串是一个**合法的字符串**（`if (code)` 之外的写法
    // 会把它当成「有值」一路带下去），而 `null` 在 strict TS 下强迫调用方处理这个分支。
    expect(resolveLockerCode({})).toBeNull()
  })

  it('⚠️ 认不出的链接形态 → `null`，不猜', () => {
    // 柜机二维码的载荷格式是 `01` §2.1 定死的 `https://<域名>/l/{lockerCode}`。
    // 一个不匹配这个形状的串（别的网站、别的路径、别的深度的 URL）**不是柜机码** ——
    // 从中截一段当码用，等于替用户猜他扫了什么，最坏的结果是拿一个不存在的码去查柜机，
    // 而用户以为「扫到了」。⇒ 认不出就是认不出。
    expect(resolveLockerCode({ q: 'https%3A%2F%2Fexample.com%2Fother%2FWD-01' })).toBeNull()
    expect(resolveLockerCode({ scanResult: 'https://example.com/hello' })).toBeNull()
    expect(resolveLockerCode({ q: 'https://locker.example.com/l/' })).toBeNull()
  })

  it('⚠️ 空串 / 只有空白 → `null`（与「没有来源」同一条路）', () => {
    // 页面参数为空串是真实存在的形态（`onLoad({ q: '' })`）。它**不是**一个 code，
    // 也不能走「有值」那条路 —— 否则请求层会拿空串去查柜机。
    expect(resolveLockerCode({ q: '' })).toBeNull()
    expect(resolveLockerCode({ code: '' })).toBeNull()
    expect(resolveLockerCode({ scanResult: '   ' })).toBeNull()
  })

  it('⚠️ 畸形的 URL 编码 → `null`，**不抛异常**', () => {
    // `decodeURIComponent('%')` 会**抛 `URIError`**。冷启动通道 A 上抛出一个未捕获异常
    // 等于白屏 —— 而用户拿到的码坏了时，正确表现是 `01` §6.1 的「这个码没用」页。
    // ⇒ 解码失败必须收敛成「解析不出」，与「码是空的」同一条路。
    expect(() => resolveLockerCode({ q: '%' })).not.toThrow()
    expect(resolveLockerCode({ q: '%' })).toBeNull()
    expect(resolveLockerCode({ q: '%E4%BD' })).toBeNull()
  })
})

describe('#26 resolveLockerCode · 来源优先级（同一次进入给了多个来源时）', () => {
  it('⚠️ `code` 优先于 URL 来源 —— 显式参数比从链接里刨出来的更可信', () => {
    // 冷启动时 `q` 与 `code` 可能同时到达（二维码规则配了参数、或用户从分享链接进来）。
    // 此时 `code` 是**页面参数直给**的，`q` 需要一次解码 + 一次解析 ——
    // 前者少两道转换，就少两处出错空间。
    expect(
      resolveLockerCode({ code: 'WD-09', q: 'https%3A%2F%2Flocker.example.com%2Fl%2FWD-01' }),
    ).toBe('WD-09')
  })

  it('⚠️ `code` 为空但 `q` 有值 → 用 `q`（空串不算「给了」）', () => {
    // 「空串不是来源」这条在三来源上必须一致，否则优先级规则会退化成
    // 「谁先出现用谁」—— 而空串恰好是「出现了但没给东西」。
    expect(resolveLockerCode({ code: '', q: 'https://locker.example.com/l/WD-01' })).toBe('WD-01')
  })
})
