// 逐测试的桩隔离 —— issue #16 的一条验收标准：
// 「桩的安装/清理是隔离的 —— 单个测试改的桩状态不泄漏到下一个测试」。
//
// ⚠️ 隔离是**两件**事，只做一件都不够：
//   1. **卸载全局**：`globalThis.wx` 必须消失，否则下一个用例悄悄继承了上一个的调用记录，
//      「`13.2` 只被调用一次」这类断言会因为看到上一个用例的调用而假失败/假通过。
//   2. **还原计时器**：忘了 `vi.useRealTimers()` 会让后续用例里所有真实等待变成死等。
//
// `restoreMocks: true`（vitest.config.ts）另外负责清掉每个 mock 的调用记录。

import { afterEach } from 'vitest'
import { vi } from 'vitest'
import { uninstallWxStub } from '../helpers/wx'

afterEach(() => {
  uninstallWxStub()
  vi.useRealTimers()
})
