// 请求层的**类型层** —— 统一异常对象与请求选项的形状。
//
// 契约出处：`docs/spec/07-engineering-form.md` §4.2（统一异常对象四字段 + `kind` 归一化表）。
//
// ⚠️ 本模块**只有形状，没有行为**（与 `types/auth.ts` 同一取向）：纯类型声明 + 少量常量，
// 编译后不产出任何可执行代码，因此可以被 `request/` 与 `api/` 自由 `import type`。

/**
 * 归一化分类 —— `07` §4.2 的表**逐行**落成联合类型。
 *
 * | `kind` | 触发 | 调用方预期行为 |
 * |---|---|---|
 * | `network` | 请求失败 / 超时 / 非 JSON 响应 | 按该动作自身重试口径处理 |
 * | `unauthorized` | `401`（含 `2001` / `2005`） | **请求层内部消费**，不抛给页面 |
 * | `forbidden` | `403` | 按受限处理 |
 * | `restricted` | `code === 5004` | **特判**：走 `04` §4 受限卡，**不展示服务端 message** |
 * | `business` | `200 + code ≠ 0`（其余） | **按 `message` 直出**，在动作点就地解释 |
 *
 * ⚠️ 写成联合类型（而不是 `string`）的价值：调用方 `switch (error.kind)` 时 strict TS
 * 会强制穷尽全部分支 —— 后来者新增一个 `kind` 而忘了处理，是编译错而不是运行时静默。
 */
export type ErrorKind = 'network' | 'unauthorized' | 'forbidden' | 'restricted' | 'business'

/**
 * 统一异常对象 —— `07` §4.2 的**四字段**，一个不多一个不少。
 *
 * ⚠️ 它**不是** JS `Error` 的子类，也**不抛** —— 请求层以返回值形式交给调用方
 * （`07` §4.1「页面拿到的永远是异常对象，由页面决定怎么讲」）。
 */
export interface UnifiedError {
  /**
   * HTTP 状态码。区分 `401`/`403` 与 `200` 靠它。
   *
   * ⚠️ **网络失败 / 超时时为 `null`** —— 那时根本没有 HTTP 交换发生，不假装有状态码。
   */
  httpStatus: number | null

  /**
   * 业务码（body `code`）。
   *
   * ⚠️ **非 JSON 响应或网络失败时为 `null`** —— 连 body 都没读出来，编一个出来就是撒谎。
   */
  code: number | null

  /**
   * 服务端 `message` —— **按它展示，不硬编码文案**（`R1:435`）。
   *
   * ⚠️ **唯一为 `null` 的情形是 `kind === 'restricted'`（`code === 5004`）**：
   * `07` §4.2 明令「不展示服务端 message」（它既不解释原因也不给出路），受限卡的文案
   * 走 `04` §5.1 / `09` §3。这是**唯一特判** —— 其余全部原样透传。
   */
  message: string | null

  /** 归一化分类。见 `ErrorKind`。 */
  kind: ErrorKind
}

/** 一次请求的结果 —— 判别联合，`ok` 是唯一的判别键。 */
export type RequestResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: UnifiedError }

/**
 * 一次请求的入参。
 *
 * 刻意**不暴露** `success` / `fail` / `complete` —— 回调式 API 的形状不外泄到调用方，
 * 这正是「Promise 封装 + 拦截器」相对于「回调 + 手写队列」的收益（`07` §4 开头）。
 */
export interface RequestOptions {
  /** HTTP 方法。缺省 `GET`。 */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /**
   * 请求体（`POST` / `PUT` 用）。
   *
   * ⚠️ 类型是 `WxRequestData` 而不是 `unknown`：`unknown` 会在出口处撞上 `wx.request`
   * 自己的入参类型（它只接受可序列化的那几种），迫使实现者写一次断言 ——
   * 那正是「无 `any` 逃逸」（`07` §2）要避免的形状。这里如实收窄到微信认得的集合：
   * 本端所有请求体都是 JSON 对象或字符串，不需要 `ArrayBuffer`。
   */
  data?: WxRequestData
  /** 额外请求头（与请求层自己加的头合并；同名时以调用方为准）。 */
  header?: Record<string, string>
}

/**
 * `wx.request` 的 `data` 入参 —— 本端实际会用到的子集。
 *
 * 刻意**不含** `ArrayBuffer` / `IAnyObject`：一期十六个端点全是 JSON 交换
 * （`07` §7 的手写 DTO 全落在 JSON 上），上传文件的能力不预先编造。
 *
 * ⚠️ 对象那支写成 `object` 而不是 `Record<string, unknown>`：手写 DTO 是 `interface`
 * （如 `LoginRequest`），而 **`interface` 没有隐式索引签名**，因此
 * `interface X {}` 不满足 `Record<string, unknown>`（TS2322）。用 `object` 才如实表达
 * 「任何可 JSON 化的对象」这个意图，且**不需要**调用方为传一个 DTO 而先断言一次。
 */
export type WxRequestData = string | object
