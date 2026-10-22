// **柜机码三来源收敛** —— `resolveLockerCode()`，柜机页的入口归一化。
//
// ## 这个模块存在的理由：让「用户从哪进来」这个变量消失
//
// `01` §2.2 逐字：
//
// > **三来源收敛**：`q` / `options.code` / `scanCode.result` → `resolveLockerCode()` → `code`。
// > **页面只认 `code`，不关心来源** —— 「用户从哪进来」这个变量在收敛之后从产品里消失。
//
// 三个来源的差别**只在拿法上**，不在语义上 —— 它们指向的是同一个东西（某台柜机的编号）。
// 若页面各自处理三个来源，那条「两条通道表现必须一致」（§2.2）的硬要求就会退化成
// 「记得让两个分支长得一样」—— 而分支一旦存在，分叉只是时间问题。
//
// ⇒ **收敛在进页面之前完成**。页面 `onLoad` 里只有一句 `const code = resolveLockerCode(options)`，
// 之后它看到的就只有一个字符串。
//
// ## 三条形态裁决
//
// 1. **纯函数，不碰 `wx.*`**（票面逐字：「收敛逻辑是纯函数，应可独立测试（不需 `wx.*` 桩）」）。
//    来源由调用方从 `options` 里取好再传进来 —— 本模块**不知道** `wx.scanCode` 存在。
//    这样它就能在测试里被直接驱动，而「两条通道一致」也变成一条**逐字相等**的断言。
//
// 2. **解析不出就返回 `null`，不返回空串、不抛异常。**
//    `null` 在 strict TS 下强迫调用方处理这个分支（`01` §6.1 的「这个码没用」页）；
//    空串则是一个**合法的字符串**，会一路被带到请求层去查一个空柜机码。
//    ⚠️ 畸形 URL 编码（`decodeURIComponent('%')`）会**抛 `URIError`** ——
//    冷启动通道 A 上抛未捕获异常等于白屏，必须收敛成「解析不出」。
//
// 3. **码里不含任何时间戳判断。** `scancode_time` 在签名里出现只为**显式登记它被忽略**
//    （`01` §2.2:38：柜机二维码是静态贴纸，时间戳没有语义）。
//    把它收进类型、并在实现里明确不读，比「签名里没有它」更难被误加回来。

/**
 * 柜机二维码载荷的**路径前缀** —— `01` §2.1：
 *
 * ```
 * https://<域名>/l/{lockerCode}
 * ```
 *
 * ⚠️ **域名不参与匹配**（`01` §2.1 只固定了 `/l/` 这一段）：
 * 一期是联调态 `localhost`、上线后是备案域名（`01` §7 的上线前置项），
 * 而二维码贴纸是**印好的**、域名换不了。把域名写死在这里，会让「换域名」变成
 * 「重新印所有柜机贴纸」—— 而这段路径才是我们真正拥有的那部分。
 */
const LOCKER_PATH_SEGMENT = '/l/'

/**
 * 一次进入柜机页时可能拿到的全部来源 —— 三个来源，一个不落（`01` §2.2 表）。
 *
 * ⚠️ 全部可选：任何一次进入都只会给出其中一个（冷启动给 `q`，小程序内扫码给
 * `scanResult`），而「一个都没有」是一种真实形态 —— 它正是 §6.1 的入口失效。
 */
export interface LockerCodeSources {
  /**
   * 通道 A：微信「扫一扫」直达的 `onLoad(q)` —— **完整链接的 URL 编码**（`01` §2.2）。
   *
   * ⚠️ 需 `decodeURIComponent` **一次**。微信在这个参数上给了两层编码
   * （整个 URL 一次、URL 里的 `:` 与 `/` 又一次），真机上拿到的是
   * `https%3A%2F%2F...` 这样的形态。
   */
  q?: string

  /**
   * 第三个来源：页面参数 `code` —— **裸柜机码**，不是链接（`01` §2.2 表）。
   *
   * ⚠️ 它与另外两个**形状不同**，因此**不做 URL 解析**：按名字与用法，它就是
   * `lockerCode` 本身（如 `WD-01`）。对它跑一遍 URL 解析只会把码解坏。
   */
  code?: string

  /**
   * 通道 B：`wx.scanCode` 的 `result` —— **完整链接**（`01` §2.1 的载荷格式）。
   *
   * ⚠️ 与 `q` 同形但**未经 URL 编码**（微信的 `scanCode` 直接把扫到的原文交出来）。
   * 两者在收敛后必须给出同一个值 —— 那正是「两条通道表现一致」在收敛层的落点。
   */
  scanResult?: string

  /**
   * 微信在通道 A 上附带的时间戳。
   *
   * ⚠️⚠️ **它不参与任何业务判断**（`01` §2.2:38 逐字）。柜机二维码是**静态贴纸**，
   * 时间戳没有语义。它出现在这个类型里，是为了让「实现者以为它该被读」这件事
   * **有一处可以明确否决** —— 签名里收着、实现里不读、测试里断言「换一个时间戳结果不变」。
   * 直接删掉它反而会让后来者重新加一个「太旧就作废」的分支。
   */
  scancode_time?: string
}

/**
 * 收敛成一个柜机码 —— 页面只认它的返回值。
 *
 * @param sources 三来源（`01` §2.2 表）。**可以全空** —— 那是 §6.1 的入口失效。
 * @returns 柜机码（如 `WD-01`）；**解析不出时为 `null`**（调用方走「这个码没用」页）
 *
 * 优先级：`code` → `q` → `scanResult`。
 * `code` 在最前，因为它是**页面参数直给**的（少两道转换：解码 + 解析）；
 * 另外两个之间不存在真实的重叠场景，取 `q` 只是为了让规则**确定**而非任意。
 *
 * ⚠️ **空串 / 纯空白不算「给了来源」**。否则一次 `onLoad({ q: '' })` 会走「有值」那条路，
 * 把空串当柜机码带到请求层去。三个来源在这一条上必须一致 —— 否则优先级规则会退化成
 * 「谁先出现用谁」，而空串恰恰是「出现了但没给东西」。
 */
export function resolveLockerCode(sources: LockerCodeSources): string | null {
  // ⚠️ 顺序即优先级，且 `normalize` 在每一支里各判一次「空」——
  // 先取出「第一个非空来源」再统一处理，会让优先级与「空串不算来源」两件事
  // 纠缠在一个表达式里，读的人要同时想两个变量。
  const direct = normalizeDirectCode(sources.code)
  if (direct !== null) return direct

  const fromQuery = extractFromUrl(sources.q)
  if (fromQuery !== null) return fromQuery

  return extractFromUrl(sources.scanResult)
}

/**
 * `options.code` 这一支 —— **裸码，不做 URL 解析**（见 `LockerCodeSources.code`）。
 *
 * ⚠️ 只裁空白，不改写内容：柜机码是印在贴纸上的编号，客户端对它唯一的合法动作是
 * 「原样交给服务端」。大小写归一、去掉中间的连字符之类都是**替服务端改契约**。
 */
function normalizeDirectCode(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 从「链接形态」的来源里刨出柜机码 —— `q` 与 `scanResult` 共用这一支。
 *
 * ⚠️ **共用是刻意的，不是顺手**：`01` §2.2 的「两条通道表现必须一致」在实现层
 * 唯一可靠的落地方式，就是**它们走同一段代码**。写成两个函数（哪怕今天逐字相同），
 * 下一次改动只会落在其中一个上。
 *
 * 认不出就返回 `null`（见文件头裁决 2）：一个不匹配 `https://<域名>/l/{code}` 形状的串
 * **不是柜机码**，从中截一段当码用等于替用户猜他扫了什么。
 */
function extractFromUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null

  // ⚠️ **解码必须 try/catch。** `decodeURIComponent('%')` 抛 `URIError`，
  // 而这条路位于冷启动通道 A 上 —— 一个未捕获异常等于白屏，用户看不到
  // `01` §6.1 的「这个码没用」页，只看到一片空白。
  //
  // ⚠️ 只解**一次**（票面逐字）。未编码的形态（`https://...`）解一次是无害的恒等变换 ——
  // 微信在工具与真机上给的形态并不一致（见下方 q 的说明与对应测试），
  // 因此这里不预判「是不是已编码」，直接解一次，两种形态都能接住。
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }

  const trimmed = decoded.trim()
  if (trimmed === '') return null

  const index = trimmed.indexOf(LOCKER_PATH_SEGMENT)
  if (index === -1) return null

  // 码 = `/l/` 之后的**整段剩余内容**。
  //
  // ⚠️ 这里**不做「只取到下一个 `/` 为止」的截断**：柜机码里不含 `/`（`WD-01` 这样的
  // 编号），而多截一层会引入一个「码到哪儿结束」的判断 —— 那个判断没有契约依据。
  // 拿整段、再靠「非空」兜底，是这条路径上唯一有出处的一条规则。
  const tail = trimmed.slice(index + LOCKER_PATH_SEGMENT.length).trim()
  return tail === '' ? null : tail
}
