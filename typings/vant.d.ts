// **Vant Weapp 的最小类型声明** —— 只覆盖 `utils/feedback.ts` 用到的函数式 API。
//
// ⚠️ 为什么不直接 `import` 包内的 `.d.ts`：
//   `@vant/weapp` 的声明文件带 `/// <reference types="miniprogram-api-typings" />`，
//   而本仓库的 `wx.*` 类型是 **vendored** 在 `typings/types/wx/` 里的另一份声明。
//   两份全局声明同时进入程序会让 `Component({...})` 的 `this` 推断失效（`triggerEvent` /
//   `setData` 全部报 TS2339），所以不能把 Vant 的 d.ts 拉进编译图。
//
// ⚠️ 这是**边界替身**，不是第二份 Vant 类型：只声明本仓库实际调用的
//   Toast(options) / Dialog.confirm(options) / Dialog.alert(options)，其余字段用
//   index signature 放行。
//   真正的运行时代码仍由开发者工具「构建 npm」从 `@vant/weapp/lib` 解析。

declare module '@vant/weapp/toast/toast' {
  interface ToastOptions {
    message?: string | number
    duration?: number
    context?: unknown
    [key: string]: unknown
  }
  function Toast(options: ToastOptions | string | number): unknown
  export default Toast
}

declare module '@vant/weapp/dialog/dialog' {
  interface DialogOptions {
    title?: string
    message?: string
    confirmButtonText?: string
    cancelButtonText?: string
    showCancelButton?: boolean
    context?: unknown
    [key: string]: unknown
  }
  const Dialog: {
    (options: DialogOptions): Promise<unknown>
    alert(options: DialogOptions): Promise<unknown>
    confirm(options: DialogOptions): Promise<unknown>
  }
  export default Dialog
}
