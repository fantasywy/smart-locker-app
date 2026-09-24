// 归一化 —— 把「一份原始响应」翻成 `07` §4.2 的统一异常对象。
//
// 契约出处：`docs/spec/07-engineering-form.md` §4.2（含 `kind` 归一化表）、
// `docs/spec/04-blacklist-and-degradation.md` §3（`5004` 特判）。
//
// ⚠️ 本模块是**纯函数**：不碰 `wx.*`、不碰 storage、不弹窗、不抛异常。
// 它是请求层里唯一「有分支」的地方，因此也是唯一值得单独测的地方 ——
// 出口 `request/index.ts` 只负责「附加 token + 调 wx.request + 把结果交给这里」。
//
// 判断同时落在**两个**地方上（`07` §4.2 的硬要求）：
//   • HTTP 状态码 —— 认证/权限用真 `401/403`（`API:44`）
//   • body `code`  —— 业务错误走 `HTTP 200 + code ≠ 0`（`API:1319`）
// 只看任一边都是错的：只看状态码会漏掉全部业务错误；只看 `code` 会把 `403` 当业务错误。

import type { RequestResult, UnifiedError } from './types'

/** `5004` —— 受限。`07` §4.2 的**唯一特判**（走 `04` §4 受限卡，不展示服务端 message）。 */
const CODE_RESTRICTED = 5004

/** 成功码。契约里 `code === 0` 表示成功（`API:1319` 的同一套响应包封）。 */
const CODE_SUCCESS = 0

/**
 * 判一份**到达的 HTTP 响应** —— 成功则解出 DTO，失败则给出统一异常对象。
 *
 * @param statusCode HTTP 状态码
 * @param body 响应体。⚠️ 类型是 `unknown`：契约说「非 JSON 响应」是一条真实分支
 *             （网关回 HTML 错误页），所以这里必须能接住**任何**东西。
 */
export function classifyResponse<T>(statusCode: number, body: unknown): RequestResult<T> {
  const envelope = readEnvelope(body)

  // ⚠️ 分支顺序有讲究，四步**依次**是：读不出 code → `5004` → 认证/权限 → 其余。
  //
  // 1. **「读不出 code」最优先**：网关回了 `<html>502</html>` 时状态码可能是 200，也可能是
  //    502 —— 但无论哪个，我们手里的事实只有「这不是契约响应」，归 `network` 才对
  //    （`07` §4.2「非 JSON 响应」）。若先按状态码分支，`200 + HTML` 会掉进「成功」分支，
  //    把一段 HTML 当成 DTO 交给调用方 —— 那是最坏的结果。
  // 2. **`5004` 其次**：它只看 `code`，不看状态码，所以必须先于状态码分支。详见下面那段注释。
  // 3. **认证/权限再次**：`401` / `403` 是契约里唯二用真 HTTP 状态码承载的错误（`API:44`）。
  // 4. **其余**：非 2xx 归 `network`；`200 + code ≠ 0` 归 `business`。
  if (envelope === null) {
    return networkFailure(statusCode, null, null)
  }

  // ⚠️⚠️ **`5004` 的判定只看 `code`，不看状态码 —— 所以它必须排在状态码分支之前。**
  //
  // `07` §4.2 的触发行写的就是「`code === 5004`」，没有附带任何状态码前提。而 `5004` 的
  // 语义是**账号级受限**（`04` §3），与「HTTP 状态码是多少」无关：后端若在鉴权层就把受限
  // 用户的动作挡掉，返回的是 `403 + 5004`，而不是 `200 + 5004`。
  //
  // 若把这条放在 401/403 之后，`403 + 5004` 会归成 `forbidden` 并把服务端 message
  // **透传出去** —— 而 `5004` 的 message 恰恰是唯一不许透传的那条（它既不解释原因也不给出路）。
  // 「**只有 `5004` 特判**」这句话因此必须在任何状态码上都成立，**顺序就是它的实现**。
  if (envelope.code === CODE_RESTRICTED) {
    // `httpStatus` 原样保留：特判只改 `kind` 与 `message`，不篡改事实。
    return restrictedFailure(statusCode, envelope.code)
  }

  if (statusCode === 401) {
    // `401` 含 `2001`（access 失效）与 `2005`（refresh 失效）—— 两者都归 `unauthorized`，
    // 具体分支由请求层的登录失效处理消费（#19）。⚠️ 本票只负责**分类正确**。
    // ⚠️ 走到这里说明 `code ≠ 5004`（上面已拦走）—— 否则受限用户的 401 会被送去刷 token，
    // 刷完照样受限，用户看到的是「反复重试无果」而不是「你被限制了」。
    return unauthorizedFailure(envelope)
  }

  if (statusCode === 403) {
    // ⚠️ `403` 的 message 照常透传：`07` §4.2 的**特判只有 `5004` 一个**，
    // 不要顺手在这里也吞掉文案 —— 那会让「只有 5004 特判」这条口径名存实亡。
    // （`403 + 5004` 已在上面被拦走，到这里的是别的 `403`，message 该照常带。）
    return forbiddenFailure(envelope)
  }

  // ⚠️⚠️ **非 2xx 的失败不得被 body 的 `code` 洗白。**
  //
  // 契约说业务错误走 `200 + code ≠ 0`（`API:1319`），认证/权限走真 `401/403`（`API:44`）。
  // 但**这两种之外**的失败是真实存在的：网关 5xx、后端未捕获异常、反向代理改写的响应 ——
  // 它们**也带 body**，而那个 body 可能挂着 `code: 0`（框架兜底、或网关原样转发了一个
  // 别处的响应包封）。
  //
  // 若只按 `code === 0` 判成功，`500 + code 0` 会把一个**假 DTO** 交给调用方：页面于是
  // 渲染出「没数据」而不是「出错了」—— 这是最坏的一类失败，静默且方向相反
  // （用户以为一切正常，实际什么都没做成）。
  //
  // 归 `network` 而不是 `business`：`business` 的语义是「服务端按契约解释了一个业务原因，
  // 按 `message` 直出」（`07` §4.2）。5xx 上的 message 是框架/网关话术，没有业务语义 ——
  // 拿它去解释给用户，等于替后端编了一个它没说的原因。`network` 的口径是
  // 「按该动作自身的重试口径处理」，正是 5xx 该有的待遇。
  if (statusCode < 200 || statusCode >= 300) {
    return networkFailure(statusCode, envelope.code, envelope.message)
  }

  if (envelope.code === CODE_SUCCESS) {
    // `data` 原样交给调用方，请求层**不加工**（`07` §4.1：只搬运，不含业务分支）。
    return { ok: true, data: envelope.data as T }
  }

  // 其余 `200 + code ≠ 0` —— **按 message 直出**，在动作点就地解释（`07` §4.2）。
  // ⚠️ 服务端 message 原样携带，**不硬编码、不改写、不兜底成通用文案**（`R1:435`）。
  return businessFailure(statusCode, envelope.code, envelope.message)
}

/**
 * 判一次**网络层的失败** —— 网络不通与超时在微信侧都是 `fail`，两者都归 `network`。
 *
 * ⚠️ `code` 与 `httpStatus` 都是 `null`：请求根本没有走完一个 HTTP 往返，
 * 没有任何业务码或状态码可言。`message` 用微信侧的 `errMsg` 原样承载 ——
 * 它是**诊断信息**，不会被直接展示给用户（`09` §7 的全局失败出口有自己的文案）。
 */
export function classifyFailure(errMsg: string): RequestResult<never> {
  // 没有 HTTP 往返 ⇒ 没有状态码、没有业务码；`errMsg` 作为诊断信息承载（不会被直接展示）。
  return networkFailure(null, null, errMsg)
}

/** 成功响应体里我们真正读的两个字段。 */
interface Envelope {
  code: number
  message: string | null
  data: unknown
}

/**
 * 从任意 body 里读出契约包封 —— 读不出来返回 `null`。
 *
 * 「读不出来」的判据是**有没有一个数字型的 `code`**，而不是「像不像 JSON」：
 * 一个 `[]` 或 `"ok"` 都读不出 `code`，与一段 HTML 对归一化而言是同一件事。
 */
function readEnvelope(body: unknown): Envelope | null {
  if (typeof body !== 'object' || body === null) return null
  const candidate = body as Record<string, unknown>
  const code = candidate.code
  if (typeof code !== 'number') return null
  const message = candidate.message
  return {
    code,
    // `message` 只有真的是字符串时才承载 —— 后端不给就如实为 `null`，不编。
    message: typeof message === 'string' ? message : null,
    data: candidate.data,
  }
}

/**
 * ⚠️ `kind` 是**唯一**决定「该带哪些字段」的东西，所以构造面按 `kind` 各开一个函数 ——
 * 而不是让六个调用点各自手写一遍四字段字面量：那样一旦 `UnifiedError` 增删字段，
 * 就得逐处找齐（Shotgun Surgery），也容易在某个分支漏掉「`5004` 不得透出 message」
 * 这类**只差一个 `null`** 的关键差别。
 *
 * 四个函数各自把「这个 kind 的字段口径」写死，调用点只提供它真正知道的东西。
 */
function networkFailure(
  httpStatus: number | null,
  code: number | null,
  message: string | null,
): { ok: false; error: UnifiedError } {
  return { ok: false, error: { httpStatus, code, message, kind: 'network' } }
}

function unauthorizedFailure(envelope: Envelope): { ok: false; error: UnifiedError } {
  // ⚠️ 硬编码 401（而不是把入参透传）：本函数**只在** `statusCode === 401` 时被调用，
  // 传参进来等于给「401 却报出别的状态码」留了可能。message 照常透传 —— `401` 不是特判。
  return { ok: false, error: { httpStatus: 401, code: envelope.code, message: envelope.message, kind: 'unauthorized' } }
}

function forbiddenFailure(envelope: Envelope): { ok: false; error: UnifiedError } {
  // ⚠️ 403 的 message 照常透传：`07` §4.2 的特判**只有 `5004` 一个**。
  return { ok: false, error: { httpStatus: 403, code: envelope.code, message: envelope.message, kind: 'forbidden' } }
}

function restrictedFailure(httpStatus: number, code: number): { ok: false; error: UnifiedError } {
  // ⚠️⚠️ `message: null` 是**唯一特判**的全部内容（`07` §4.2 / `04` §3 / `09` §3）。
  // 刻意**不接** message 参数：调用点无从「顺手把服务端原文传进来」——
  // 这是本票最容易在后续重构中被悄悄推翻的一条。
  return { ok: false, error: { httpStatus, code, message: null, kind: 'restricted' } }
}

function businessFailure(
  httpStatus: number,
  code: number,
  message: string | null,
): { ok: false; error: UnifiedError } {
  // ⚠️ message **原样**携带（`R1:435` 不硬编码文案）。允许为 `null`：后端不给就如实为 `null`，
  // 由动作点决定兜底怎么说 —— 请求层不替它编一句。
  return { ok: false, error: { httpStatus, code, message, kind: 'business' } }
}
