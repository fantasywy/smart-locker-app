// `13.x` 认证端点的请求形状 —— 手写请求函数，**只做搬运**（`07` §3 硬规则 2）。
//
// 契约出处：API设计文档.md §13.1 `POST /api/app/v1/auth/login` (:919-939)、
// §13.2 `POST /api/app/v1/auth/refresh` (:941-943)；`docs/spec/07-engineering-form.md`
// §4.3 硬约束 5、§4.4（token 口径）。
//
// ⚠️ **`api/` 不含业务分支**（`07` §3 硬规则 2）：本模块只做「入参 → 请求 → 出参 DTO」的搬运。
// 状态判断、文案、跳转全在页面（或页面共享的组件）里 —— 这样同一个端点在订单列表与详情页
// 被用到时不会长出两套语义。
//
// ⚠️ 本模块的两个函数**都走免鉴权出口**（`requestWithoutAuth`）：`13.1` / `13.2` 是
// `WebMvcConfig.java:46-47` 唯二排除在 `AppAuthInterceptor` 之外的端点（`07` §4.3 硬约束 5）。
// 登录链因此**不依赖登录态** —— 这是防递归的第一道，也是最重要的一道。
//
// ⚠️ **实现在 `request/auth-endpoints.ts`，本模块只是把它导出给调用方。** 这不是多一层
// 转发，而是**打断一个模块循环**：请求层的登录失效处理自己要调 `13.1` / `13.2`，
// 若它反过来 import 本模块，就与本模块 import 请求层出口形成 `request ⇄ api` 的环。
// 依赖方向必须单向 `api/ → request/`，所以「请求层自己要用的那两个端点形状」长在 `request/` 里，
// 本模块把它**重新导出**给页面 —— 页面照旧 `import { login, refresh } from '../api/auth'`，
// 调用形状一个字没变。完整的理由写在那个文件的头注释里。

// ⚠️ 用 `export ... from` 而不是 `import` + `export`：少一个中转变量，
// 且「本模块没有自己的逻辑」这件事在语法上就是显然的。
export { login, refresh } from '../request/auth-endpoints'
