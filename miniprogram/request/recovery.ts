// **登录失效处理 + Bearer 头拼装** —— 三条 HTTP 通道共用的一套鉴权。
//
// 本模块从 `index.ts` 抽出（#74）。抽出的理由不是「文件太长」，而是：
//   • `request/index.ts`（`wx.request`）、`request/transfer.ts`（`wx.uploadFile` /
//     `wx.downloadFile`）是**三条独立通道**，却必须共用**同一套** Bearer 与 401 恢复；
//   • 「单一飞行」是**全端唯一**的：上传撞 401 与普通请求撞 401 必须挂到同一个恢复上。
//     若每个通道各自持有一份 `inFlightRecovery`，冷启动时就会打出多次刷新。
//
// 状态机（逐字落地，不重新裁决）：
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

import type { RequestResult, UnifiedError } from './types'
import { clearTokens, getAccessToken, getRefreshToken, saveTokens, setAccessToken } from './token'
import { isAuthExempt } from './config'
// ⚠️ 从 `./auth-endpoints` import，**不是** `../api/auth` —— 后者会构成模块循环
// （`api/auth.ts` 反过来依赖本模块的出口）。理由见 `auth-endpoints.ts` 的头注释，
// 并由 `test/request/conventions.test.ts` 的依赖方向守卫钉住。
import { login, refresh } from './auth-endpoints'

/**
 * 给一次请求的头**补上 Bearer** —— 三条通道共用的唯一拼装点。
 *
 * ⚠️ 免鉴权端点（`13.1` / `13.2` / 内容页）不附加头：这是递归防护的第一道闸门，
 * 且与 `request/index.ts` 的 `withAuth` 显式声明互为兜底。
 *
 * ⚠️ **原地写调用方给的 header 对象**是有意的：调用方（`send()`）随后会把整份头复制
 * 给 `wx.*`，复制发生在这一次调用之后。把「读 token」与「拼头」放在一个函数里，
 * 是为了让 `transfer.ts` 不需要知道 `isAuthExempt` / storage 的任何细节。
 */
export function withAuthHeader(path: string, header: Record<string, string>): Record<string, string> {
  if (isAuthExempt(path)) return header
  const access = getAccessToken()
  if (access !== null) header.Authorization = `Bearer ${access}`
  return header
}

/**
 * 401 的业务码 —— **只有这两个**区分两条恢复路径。
 *
 * ⚠️ 它们是**契约码**，不是 HTTP 状态码：401 只告诉我们「登录态有问题」，
 * 是 `2001`（access 失效，去刷新）还是 `2005`（refresh 失效，直接清态重登）由 body 决定。
 *
 * ⚠️ 传输层（`transfer.ts`）**刻意不读它们**：下载的错误体已落盘、上传的 `data` 是字符串，
 * 读一个错误码要额外读盘 / 解析。那两条通道统一走「先刷（失败转重登）」——
 * 净行为与按码分支一致，且两条通道行为一致。
 */
const CODE_ACCESS_INVALID = 2001
const CODE_REFRESH_INVALID = 2005

/**
 * 飞在半空中的恢复 —— **全端只有一个**。这就是「单一飞行」的全部机制。
 *
 * `null` 表示当前没有恢复在飞（后续撞上 401 的请求会**开启**一次）；
 * 非 `null` 表示已有恢复在飞（后续撞上 401 的请求**挂到它上面**，不再自己起一次）。
 *
 * ⚠️ 为什么不按端点分别排队：冷启动 5 个页面同时发请求是常态，
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
 *   2. 若它返回 `kind === 'unauthorized'`，入请求层的恢复队列：
 *      全端**恰好一次**恢复，成功后重放，失败则丢弃原动作。
 *
 * @param forceRefresh 是否跳过契约码判断、恒定走「先刷（失败转重登）」。
 *        `transfer.ts` 的响应里读不出 `2001` / `2005`（下载错误体已落盘、上传 `data`
 *        是字符串），所以两条文件通道传 `true`；净行为与按码分支一致。
 *        缺省 `false` = 按 `2001` / `2005` 选择，读不出码时如实交出、不猜。
 *
 * ⚠️ `attempt` 是**闭包**而不是 `(path, options)`：重放必须原样重发。
 * 把 path/options 传进来再拼一次，等于重放时重新构造一次请求 —— 那时 `getAccessToken()`
 * 读的是**新**令牌（对），但请求头、body 也得重新拼一遍（就容易漏东西）。
 * 重放「原样」这件事因此由类型系统担保：同一个闭包，同一个 `send` 调用点。
 */
export async function withLoginRecovery<T>(
  attempt: () => Promise<RequestResult<T>>,
  forceRefresh = false,
): Promise<RequestResult<T>> {
  const first = await attempt()
  if (first.ok || first.error.kind !== 'unauthorized') return first

  const trigger = forceRefresh ? 'refresh' : recoveryTriggerFor(first.error)
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

  // 重放（401 由鉴权拦截器在业务逻辑**之前**返回 ⇒ 请求未被服务端执行，
  // 写请求重放不构成重复提交。`AppAuthInterceptor.java:27-37` 源码核实）。
  //
  // ⚠️ 重放**只做一次，且不再消费它的 401**：若重放回来还是 401，那是「刚修好的令牌
  // 又失效了」—— 再修一次就是递归，所以刷新 / 重登**各只做一次**。
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
function recoveryTriggerFor(error: UnifiedError): RecoveryTrigger | null {
  if (error.code === CODE_ACCESS_INVALID) return 'refresh'
  if (error.code === CODE_REFRESH_INVALID) return 'relogin'
  return null
}

type RecoveryTrigger = 'refresh' | 'relogin'

/**
 * 恢复登录态 —— **全端只会在同一时刻跑一次**（由 `inFlightRecovery` 保证）。
 *
 * `refresh` 路径失败时**转** `relogin`（状态机的 `13.2 失败 → 转清态重登`）：
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
 * ⚠️ 重登失败时**绝不后台补发**：原动作就此丢弃，把失败的**成因**如实交回
 * 调用方（网络失败 / `8001` / 后端 5xx —— 登录失败的成因已穷举）。请求层不弹窗、
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
 *     （它也是登录失败的成因之一，且拿不到 `code` 就**根本不该发 13.1**）。
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
