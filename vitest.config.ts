import { defineConfig } from 'vitest/config'

// 测试载体配置 —— 对应 `docs/spec/07-engineering-form.md` §2（工程约束）与 issue #16。
//
// 为什么几乎没有配置：测试要验的是**异步时序**（单一飞行、排队重放、失败转段），
// 不需要浏览器环境、不需要 DOM、不需要跨端编译链。`miniprogram/` 下的 TS 直接跑，
// 用的是与小程序构建**同一套** tsconfig（module: CommonJS）—— 见 tsconfig.test.json。
export default defineConfig({
  test: {
    // 全局桩（wx.*）靠 globalThis 注入，不需要 jsdom；node 环境最贴近小程序「无 DOM」的事实。
    environment: 'node',
    // 测试代码不进小程序包，因此与 `miniprogram/`、`scripts/` 分开放：`test/` 是唯一入口。
    include: ['test/**/*.test.ts'],
    // ⚠️ 不用 `globals: true`：显式从 'vitest' 导入 describe/it/expect，无需往 tsconfig 的
    // typeRoots 里塞 vitest/globals，也不会让「这个 expect 从哪来」变成隐式约定。
    globals: false,
    // 桩的清理（restore mocks / 卸载 globalThis.wx）在 test/support/setup.ts 里，逐测试生效。
    setupFiles: ['test/support/setup.ts'],
    restoreMocks: true,
  },
})
