// 请求层的**唯一出口** —— 全端只有这里碰 `wx.request`（`07` §3 硬规则 1）。
//
// 契约出处：`docs/spec/07-engineering-form.md` §4（请求层逐条已定）、§4.1（只归一化、不弹窗）、
// §4.2（必须同时看 HTTP 状态码与 body `code`）、§4.3（登录失效处理：单一飞行 + 全局排队重放，
// 含四条硬约束与豁免名单）、§4.4（token 口径）。
// 上游：`docs/spec/01-entry-and-identity.md` §3（登录链）、§4（全局失败出口）。
//
// 职责边界（`07` §4.1，刻意收窄）：
//   负责：附加 token → 发请求 → 判 HTTP 状态 + body `code` → 归一化成统一异常对象 → 交给调用方。
//   不负责：弹 toast、弹 modal、决定跳哪儿、决定置灰谁。**一行 UI 副作用都没有。**
//
// ⚠️ 唯一的例外是登录失效处理（`07` §4.3）—— 它确实是全局的，所以它**在请求层内部被消费**，
// 页面完全不用管（`07` §8 的验收自查表：「登录失效怎么办 → 不用管，请求层已处理」）。
// 即便如此，请求层也**不弹窗、不跳转**：它只负责「修好登录态然后重放」；修不好就把失败的
// 成因如实返回，呈现交给 #20 的启动闸门 / 全局失败出口。

import type { RequestOptions, RequestResult, UnifiedError } from './types'
import { classifyFailure, classifyResponse } from './normalize'
import { clearTokens, getAccessToken, getRefreshToken, saveTokens, setAccessToken } from './token'
import { BASE_URL, isAuthExempt } from './config'
// ⚠️ 从 `./auth-endpoints` import，**不是** `../api/auth` —— 后者会构成模块循环
// （`api/auth.ts` 反过来依赖本模块的出口）。理由见 `auth-endpoints.ts` 的头注释，
// 并由 `test/request/conventions.test.ts` 的依赖方向守卫钉住。
import { login, refresh } from './auth-endpoints'

/**
 * 发一条 HTTP 请求 —— **全端唯一的 `wx.request` 调用点**。
 *
 * @param path 端点路径（如 `/api/app/v1/orders`），**不含** baseUrl
 * @param options 方法 / 请求体 / 额外头
 * @returns 成功时 `{ ok: true, data }`（`data` 是契约响应体里 `data` 字段的原样 DTO）；
 *          失败时 `{ ok: false, error }`（统一异常对象四字段，`07` §4.2）
 *
 * ⚠️ **不抛异常、不弹窗**。异常以 `{ ok: false, error }` 的形式**返回**给调用方 ——
 * 这是 `07` §4.1 的落地：页面拿到的永远是异常对象，由页面决定怎么讲人话
 * （toast / 受限卡 / 就地行内说明）。
 *
 * 为什么是判别联合而不是 `throw`：`04` §3 的「点击后解释」与 `06` §4.4 的就地解释要求
 * 调用点自己选形态；`throw` 会诱导出「到处 try/catch 然后弹 toast」的写法，而那正是
 * `07` §4.1 明令禁止的（互相覆盖的 toast 会把受限卡提前弹掉）。判别联合还让 strict TS
 * 强迫调用方处理失败分支 —— 漏了就是编译错。
 * `401` **不会**从这里漏出去给页面：它由 `withLoginRecovery` 在内部消费掉（`07` §4.3）。
 * 页面能拿到的失败只有「恢复登录态这件事本身失败了」那一类（§4.3 硬约束 3）。
 *
 * ⚠️ **豁免名单内的路径不挂恢复逻辑**（硬约束 4 的第二道闸门）。`auth-endpoints.ts` 走的是
 * `requestWithoutAuth`（第一道），但后来者用 `request()` 直接调 `13.1` / `13.2` 是很自然的
 * 写法（它「也是个端点」）—— 那时若照常挂上恢复，一次刷新失败会去刷新「这次刷新」，
 * 立刻打出无限递归。两道闸门都要能独立挡住。
 */
export function request<T>(path: string, options: RequestOptions = {}): Promise<RequestResult<T>> {
  const attempt = (): Promise<RequestResult<T>> => send<T>(path, options, true)
  return isAuthExempt(path) ? attempt() : withLoginRecovery<T>(attempt)
}

/**
 * 发一条**免鉴权**请求 —— 不带 `Authorization`，且**不读** storage 里的 access。
 *
 * 只给 `13.1` 与 `13.2` 用（`WebMvcConfig.java:46-47`，见 `config.ts` 的豁免名单）。
 *
 * ⚠️ 为什么不靠「url 命中豁免名单就不加头」一条路走完：那样 `13.1` / `13.2` 仍会去读
 * storage 里的 access，一旦 storage 桩未被编排，就会在登录链路上炸出一个与登录无关的错。
 * 显式分成两条路，让「登录链不依赖登录态」这件事在**调用形状上**就成立。
 *
 * ⚠️ 它也**不挂**登录失效处理 —— 这正是 `07` §4.3 硬约束 4 的落地（递归防护）。
 * 若 `13.2` 也走那套逻辑，一次刷新失败会去刷新「这次刷新」，立刻打出无限递归。
 */
export function requestWithoutAuth<T>(
  path: string,
  options: RequestOptions = {},
): Promise<RequestResult<T>> {
  return send<T>(path, options, false)
}

function send<T>(
  path: string,
  options: RequestOptions,
  withAuth: boolean,
): Promise<RequestResult<T>> {
  const header: Record<string, string> = { 'content-type': 'application/json' }
  for (const [key, value] of Object.entries(options.header ?? {})) header[key] = value

  // ⚠️ 免鉴权端点**硬编码豁免**（`07` §4.3 硬约束 5）：契约里只有 `/auth/login` 与
  // `/auth/refresh` 两个。两道闸门都必须放行才附加头 —— `withAuth` 是调用点的显式声明，
  // `isAuthExempt` 是名单兜底（第二道用在 `request()` 上，见那里的注释）。
  if (withAuth && !isAuthExempt(path)) {
    const access = getAccessToken()
    if (access !== null) header.Authorization = `Bearer ${access}`
  }

  return dispatch<T>(`${BASE_URL}${path}`, options, header)
}

/** `wx.request` 的一次调用 —— 包成 Promise，把原始事实交给归一化。 */
function dispatch<T>(
  url: string,
  options: RequestOptions,
  header: Record<string, string>,
): Promise<RequestResult<T>> {
  return new Promise<RequestResult<T>>((resolve) => {
    wx.request({
      url,
      method: options.method ?? 'GET',
      data: options.data,
      // ⚠️ `{ ...header }` **必须复制一份**，不能把 `send()` 手里那个对象直接交出去。
      // 重放走的是同一个 `send()`，它会往同一个对象上再写一次 `Authorization`
      // —— 于是「第一次请求」交出去的那个引用会被后来的重放就地改写：
      // 记录里第一次请求带着的是**刷新后**的新令牌（测试据此断言「重放带新 access」会看到
      // 两个请求带的是同一个值，从而永远测不出令牌有没有真的换掉），
      // 更糟的是「第一次请求发了什么」这个事实在测试里被永久污染。
      // 一行复制换来「一次 `wx.request` 的入参在发出后不再变化」这个不变量。
      header: { ...header },
      success: (res) => {
        resolve(classifyResponse<T>(res.statusCode, res.data))
      },
      // ⚠️ 网络不通与超时在微信侧**都是 fail**（`07` §4.2 的 `network` 前两个触发）。
      // 两者在客户端无法区分，也不该假装能区分 —— 都归 `network`。
      fail: (err) => {
        resolve(classifyFailure(err.errMsg))
      },
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 登录失效处理 —— `07` §4.3 的「单一飞行 + 全局排队重放」
// ─────────────────────────────────────────────────────────────────────────────
//
// 状态机（`07` §4.3 原文，逐字落地，不重新裁决）：
//
//     带 access 发请求
//     ├─ 2xx ──────────→ 正常返回
//     ├─ 401 + 2001 ───→ 【入队】刷新一次（13.2，带 X-Refresh-Token）
//     │                    ├─ 成功 → 重放原请求
//     │                    └─ 失败 → 转「清态重登」
//     └─ 401 + 2005 ───→ 【入队】清登录态 → wx.login → 13.1 重登一次
//                          ├─ 成功 → 重放原请求
//                          └─ 失败 → 【全局失败出口】，丢弃原动作
//
// ⚠️ **整段是真模块，不是「拦截器链」。** #15 已裁决形态是「Promise 封装 + 拦截器，
// 不用回调 + 手写队列」—— 那句话里的「拦截器」指的是**能力**（请求被包一层、401 在到达
// 调用方之前被处理），落在原生小程序 TS 上就是这个函数：一次 `attempt` 一次 `recover`，
// 排队靠共享的 Promise。**不引入拦截器链表抽象**：那是 web 框架的既有概念，本端没有
// 第二处会用它（codebase-design 的「One adapter means a hypothetical seam」）。

/**
 * 401 的业务码 —— **只有这两个**区分两条恢复路径（`07` §4.3）。
 *
 * ⚠️ 它们是**契约码**，不是 HTTP 状态码：401 只告诉我们「登录态有问题」，
 * 是 `2001`（access 失效，去刷新）还是 `2005`（refresh 失效，直接清态重登）由 body 决定。
 */
const CODE_ACCESS_INVALID = 2001
const CODE_REFRESH_INVALID = 2005

/**
 * 飞在半空中的恢复 —— **全端只有一个**。这就是硬约束 1 的全部机制。
 *
 * `null` 表示当前没有恢复在飞（后续撞上 401 的请求会**开启**一次）；
 * 非 `null` 表示已有恢复在飞（后续撞上 401 的请求**挂到它上面**，不再自己起一次）。
 *
 * ⚠️ 为什么不按端点分别排队（硬约束 1 明令禁止）：冷启动 5 个页面同时发请求是常态，
 * 按端点排队等于每个页面各刷一次 —— 那就是刷新风暴本身。队列必须**全局唯一**。
 */
let inFlightRecovery: Promise<RecoveryOutcome> | null = null

/** 一次恢复的结果：修好了（重放），还是修不好（丢弃原动作、把失败成因交回调用方）。 */
type RecoveryOutcome = { ok: true } | { ok: false; error: UnifiedError }

/**
 * 发一条需要鉴权的请求，并**消费掉**它的 401。
 *
 * 两件事按顺序发生：
 *   1. `attempt()` 发一次请求；
 *   2. 若它返回 `kind === 'unauthorized'`（且带得出 `2001` / `2005`），入请求层的恢复队列：
 *      全端**恰好一次**恢复，成功后重放，失败则丢弃原动作。
 *
 * ⚠️ `attempt` 是**闭包**而不是 `(path, options)`：重放必须原样重发。
 * 把 path/options 传进来再拼一次，等于重放时重新构造一次请求 —— 那时 `getAccessToken()`
 * 读的是**新**令牌（对），但请求头、body 也得重新拼一遍（就容易漏东西）。
 * 重放「原样」这件事因此由类型系统担保：同一个闭包，同一个 `send` 调用点。
 */
async function withLoginRecovery<T>(
  attempt: () => Promise<RequestResult<T>>,
): Promise<RequestResult<T>> {
  const first = await attempt()
  if (first.ok || first.error.kind !== 'unauthorized') return first

  const trigger = recoveryTriggerFor(first.error.code)
  // 读不出 `2001` / `2005` 的 401（网关页面、契约漂移）**不猜分支**：替它选一条路
  // 会白刷一次甚至误清登录态 —— 如实交出比猜安全。它照常落在 `unauthorized` 上。
  if (trigger === null) return first

  // ⚠️ 这两行就是「单一飞行」：无论多少个请求同时走到这里，都只会 `??=` 出**一个** Promise，
  // 于是 `recover()` 只会被调用一次（这一点由「13.2 恰好一次」的外部断言锁住）。
  inFlightRecovery ??= recover(trigger).finally(() => {
    // 恢复结束 —— 下一次 401 是一轮**新的**恢复。清空必须在 finally，
    // 否则一次失败会把后续所有请求永久挂到一个已经结束的 Promise 上。
    inFlightRecovery = null
  })
  const outcome = await inFlightRecovery
  if (!outcome.ok) return { ok: false, error: outcome.error }

  // 重放（硬约束 2：401 由鉴权拦截器在业务逻辑**之前**返回 ⇒ 请求未被服务端执行，
  // 写请求重放不构成重复提交。`AppAuthInterceptor.java:27-37` 源码核实）。
  //
  // ⚠️ 重放**只做一次，且不再消费它的 401**：若重放回来还是 401，那是「刚修好的令牌
  // 又失效了」—— 再修一次就是递归，而 `07` §4.3 的口径是「刷新 / 重登**各一次**」。
  // 如实把那个 401 交给调用方，比无限修下去安全。
  return attempt()
}

/**
 * 这个 401 该走哪条恢复路径 —— 读不出契约码时返回 `null`（不猜）。
 *
 * | `code` | 路径 |
 * |---|---|
 * | `2001` | 刷新一次（`13.2`，带 `X-Refresh-Token`） |
 * | `2005` | 清态重登（跳过刷新 —— refresh 已经失效，刷它没有意义） |
 */
function recoveryTriggerFor(code: number | null): RecoveryTrigger | null {
  if (code === CODE_ACCESS_INVALID) return 'refresh'
  if (code === CODE_REFRESH_INVALID) return 'relogin'
  return null
}

type RecoveryTrigger = 'refresh' | 'relogin'

/**
 * 恢复登录态 —— **全端只会在同一时刻跑一次**（由 `inFlightRecovery` 保证）。
 *
 * `refresh` 路径失败时**转** `relogin`（`07` §4.3 状态机的 `13.2 失败 → 转清态重登`）：
 * 「刷新失败」不等于「登录身份没了」—— refresh 可能只是过期，重登一次往往就能恢复。
 * 把它实现成「刷新失败就报错」是本张票最容易犯的错。
 */
async function recover(trigger: RecoveryTrigger): Promise<RecoveryOutcome> {
  if (trigger === 'refresh' && (await tryRefresh())) return { ok: true }
  return relogin()
}

/**
 * `13.2` 刷新一次 —— 成功返回 `true`。
 *
 * ⚠️ **只写 access，refresh 原值保留。** `13.2` 的响应里**没有** `refreshToken`
 * （`types/auth.ts` 的 `RefreshResponse`）—— 它是续期 access、不轮换 refresh。
 * 写成「把响应整个覆盖回 token 结构」会把 refresh 变成 `undefined`，下一次请求就会提前
 * 撞上 `2005` 而被迫重登 —— **把一个 30 天的会话缩成一次刷新**。
 * `setAccessToken()` 只接一个参数，正是为了让那种写法在类型上就写不出来。
 */
async function tryRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken()
  if (refreshToken === null) return false

  const result = await refresh(refreshToken)
  if (!result.ok) return false

  setAccessToken(result.data.accessToken)
  return true
}

/**
 * 清登录态 → `wx.login` → `13.1` 重登一次。
 *
 * ⚠️ **清态在重登之前**，且重登**失败时保持清态**：否则会留下一个「refresh 看起来还在、
 * 其实已经失效」的假登录态，下次冷启动被 `api/session.ts` 直接放行，用户被永久卡在
 * 每次都 401 的死循环里。
 *
 * ⚠️ 重登失败时**绝不后台补发**（硬约束 3）：原动作就此丢弃，把失败的**成因**如实交回
 * 调用方（网络失败 / `8001` / 后端 5xx —— `01` §4 已把登录失败的成因穷举）。请求层不弹窗、
 * 不跳转，呈现归 #20 的全局失败出口。
 */
async function relogin(): Promise<RecoveryOutcome> {
  clearTokens()

  const result = await login({ code: await readLoginCode() })
  if (!result.ok) return { ok: false, error: result.error }

  saveTokens(result.data.accessToken, result.data.refreshToken)
  return { ok: true }
}

/**
 * `wx.login` 取临时 `code` —— 取不到时**兜一个空串**。
 *
 * ⚠️ 这里与 `api/session.ts` 的同名逻辑**刻意不同**，不是重复代码：
 *   • `session.ts` 那条路是冷启动的**入口**，它必须把 `wx.login` 失败如实上报
 *     （`01` §4 的成因穷举里有它，且它拿不到 `code` 就**根本不该发 13.1**）。
 *   • 这条路是**恢复**：`13.1` 的契约把「code 为空或无效」判为 `8001`（HTTP 200、业务错误，
 *     `types/auth.ts` 的 `LoginRequest.code` 已写死这条口径）。空串走同一条契约分支，
 *     于是失败成因从**契约**里读出来，而不是在这里另造一套错误对象。
 *     重登本来就要失败，`8001` 正是它该有的长相。
 */
function readLoginCode(): Promise<string> {
  return new Promise<string>((resolve) => {
    wx.login({
      success: (res) => {
        resolve(res.code)
      },
      fail: () => {
        resolve('')
      },
    })
  })
}
