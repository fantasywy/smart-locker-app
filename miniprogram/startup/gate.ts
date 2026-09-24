// **启动闸门** —— issue #20 的核心交付物。
//
// 契约出处：`docs/spec/01-entry-and-identity.md` §3.2（冷启动表现）、§3.4（登录态状态机）、
// §4（**全局唯一失败出口**）；`docs/spec/09-copy-and-status.md` §7.1（骨架屏）、§7.2（失败文案）。
//
// ## 这个模块是什么
//
// 冷启动时，页面结构**先**出现（骨架屏），业务数据区**等** token。闸门就是那道门：
// 它只回答两个问题 —— 「登录好了吗」和「登录失败了吗」。**没有第三个状态。**
//
//     'loading'  ──登录成功──▶  'ready'    （放行，业务数据区渲染）
//         │
//         └──登录失败──▶  'failed'   （全局唯一失败出口，含重试）
//                              │
//                              └──重试──▶ 'loading'（**重新走一遍完整登录链**）
//
// ## 三条裁决，逐条都是本模块存在的理由
//
// 1. **失败出口只有一个，且由启动态驱动、不下放到各页面数据区**（`01` §4）。
//    所以「失败」是**闸门的状态**，不是每个页面数据区各自的一个 `if`。
//    若把失败态下放，同一分支会被复制 N 次，且会出现「有的页能重试、有的页不能」。
//    ⚠️ 本模块因此**刻意不提供**「把某个业务错误画成失败出口」的入口 ——
//    业务错误在动作点就地解释（`07` §4.2），只有**登录链本身失败**才进这道门。
//
// 2. **失败成因不分类呈现**（`01` §4）。成因可穷举（网络不通 / `wx.login` 失败 /
//    `13.1` 返回 `8001` / 后端 5xx），但**四类成因在用户面前表现一致** ——
//    都落同一个出口、同一句话、同一个重试按钮。
//    ⇒ 闸门**只保留 `kind` 用于诊断**（它来自请求层的统一异常对象，是给日志与测试看的），
//      **绝不据此分叉 UI**。`8001` 与超时对用户是同一件事：「连不上」。
//
// 3. **`BLACKLISTED` 不构成失败**（`01` §1.4、§3.4）。受限用户的登录**照样成功**，
//    闸门**放行** —— 拦截权只能属于服务端（`04` §5），本地快照会把已解禁用户挡在门外。
//    本模块因此**根本不看** `user.status`：它连读都不读，所以那条错误分叉在类型上写不出来。
//
// ⚠️ **本模块不做本地业务数据缓存**（`01` §3.2）。闸门只持有「登录到哪一步了」这一个
// 变量，不持有任何业务数据 —— 取件码与订单状态属「看到就必须是真的」的数据，
// 缓存说谎比空白更糟。首屏加速靠骨架屏，不靠缓存。

import type { UnifiedError } from '../request/types'
import { ensureLoggedIn } from '../api/session'

/**
 * 闸门的三个状态 —— **只有这三个**。
 *
 * ⚠️ 写成联合类型（而不是 `string` + 布尔标志）的价值：调用方 `switch (state.phase)` 时
 * strict TS 会强制穷尽全部分支，且 `'ready'` 那支**拿不到 `error`**、`'failed'` 那支
 * **必有 `error`** —— 「加载中却显示失败文案」这类状态组合在类型上就不存在。
 */
export type StartupPhase = 'loading' | 'ready' | 'failed'

/**
 * 闸门的状态快照 —— 判别联合，`phase` 是唯一的判别键。
 *
 * ⚠️ `'ready'` **不携带任何业务数据**：登录成功只意味着「token 到位了、可以发业务请求了」，
 * 它**不是**数据本身。业务数据由各页面自己去调 `api/` 拿（`01` §3.2 不缓存）。
 * 把登录响应里的 `user` 挂在这里，就等于开了「把登录时刻的快照当业务数据用」的口子 ——
 * 而那个快照会随信用分变动而过期（`04` §5 明令不做本地 `status` 快照）。
 */
export type StartupState =
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'failed'; error: UnifiedError }

/** 状态变化的通知口 —— 页面把它接到 `setData` 上。 */
export type StartupListener = (state: StartupState) => void

/**
 * 启动闸门 —— 一次冷启动的登录链路 + 它的呈现状态。
 *
 * interface 刻意只有三个成员：读当前态、订阅、重试。**没有** `isLoggedIn()` /
 * `getTokens()` / `getError()` 这类读法 —— 页面需要的一切都在 `state` 里，
 * 多一个读法就多一处「从状态之外推断状态」的机会。
 */
export interface StartupGate {
  /** 当前状态快照。⚠️ 每次状态变化是**换一个新对象**，不是就地改 —— 页面据此判等即可跳过无谓渲染。 */
  readonly state: StartupState

  /**
   * 订阅状态变化，返回退订函数。
   *
   * ⚠️ 订阅**不立即回调**：页面自己在 `onLoad` 里读 `state` 画首帧，
   * 「订阅时补发一次」会让同一个首帧被画两遍，且第二遍发生在页面生命周期之外。
   */
  subscribe(listener: StartupListener): () => void

  /**
   * 跑一遍完整登录链（`api/session.ts` 的 `ensureLoggedIn`）—— 冷启动与**重试**共用它。
   *
   * ⚠️ **重试就是再跑一次这个函数**，不是「重发上一次失败的请求」（`01` §4 的
   * 「重跑启动链（`wx.login` → `13.1`）」、`09` §6 第 33 条逐字）。
   * 两者的区别在失败成因是 `wx.login` 失败时最要紧 —— 那时**根本没有请求可重发**。
   *
   * 并发调用**共用同一次飞行**：冷启动与用户手速极快的重试同时到达时，
   * 不会打出两条登录链（与请求层 `07` §4.3 的「单一飞行」同一取向）。
   *
   * @returns 落地后的状态 —— `ensureLoggedIn` 的成与败**都会**反映到它上面
   */
  start(): Promise<StartupState>
}

/**
 * 造一个启动闸门。
 *
 * ⚠️ **依赖是注入的，不是内部 new 的**（`codebase-design` 的 testability 第 1 条）：
 * `ensureLogin` 缺省是真实的登录链，测试传一个可控的替身即可驱动「成功 / 四类失败」，
 * 不必去编排 `wx.login` 与 `wx.request` 的时序。
 * 参数名与 `api/session.ts` 的导出**同名**（`ensureLoggedIn`），所以缺省值一眼可知。
 */
export function createStartupGate(
  ensureLogin: () => Promise<EnsureLoginResult> = ensureLoggedIn,
): StartupGate {
  // ⚠️ 让出一次微任务**不是**为了「等一会儿更好看」，而是为了让 `start()` 的调用方
  // 能先拿到 `'loading'` 那一帧：页面 `onLoad` 里 `start()` 是**同步**被调起的，
  // 若登录链在这里同步跑完，骨架屏永远不会出现在任何一帧里 —— 而这正是本票的一半内容
  // （`01` §3.2「页面结构先出现」）。`ensureLoggedIn` 本身是 async，所以实践中
  // 它总是异步的；这一行是**把那个事实变成契约**，而不是依赖实现细节。
  let inFlight: Promise<StartupState> | null = null

  let state: StartupState = { phase: 'loading' }
  const listeners = new Set<StartupListener>()

  /** 换上新状态并广播 —— 内部唯一的写入口，保证「变了就一定通知」。 */
  function setState(next: StartupState): StartupState {
    state = next
    for (const listener of listeners) listener(next)
    return next
  }

  return {
    get state(): StartupState {
      return state
    },

    subscribe(listener: StartupListener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    start(): Promise<StartupState> {
      // ⚠️⚠️ **已经 ready 就什么都不做** —— 直接返回当前态，**不重跑登录链**。
      //
      // 这一条不是优化，是一个**修掉的缺陷**（review 逼出来的，见下）：
      // `run()` 的第一行会把状态设回 `loading`，于是「对一个已 ready 的闸门调 start()」
      // 会让界面**退回骨架屏**，并把整条登录链（`wx.login` + `13.1`）重跑一遍。
      //
      // 触发路径是**页面重建**：闸门是模块级单例（见 `pages/index/index.ts`），
      // 用户退出首页再进来时 `attached` 会再调一次 `start()` ——
      // 一个已登录用户于是看到一次无谓的骨架屏闪烁 + 一次多余的登录往返。
      // 冷启动本身不会走到这里（那时状态就是 `loading`）。
      //
      // ⚠️ **只短路 `ready`，不短路 `failed`** —— 失败态必须能重试
      // （`01` §4 的重试就是重跑启动链）。这正是 `09` §6 第 33 条的语义：
      // 重试针对的是**失败**，不是「再登录一次」。
      if (state.phase === 'ready') return Promise.resolve(state)

      // 单一飞行：已有一次登录链在跑时**挂到它上面**，不再起第二条。
      inFlight ??= run().finally(() => {
        inFlight = null
      })
      return inFlight
    },
  }

  async function run(): Promise<StartupState> {
    setState({ phase: 'loading' })

    const result = await ensureLogin()

    if (!result.ok) {
      // ⚠️ **不按 `kind` 分叉**（本文件头三条裁决的第 2 条）。`error` 原样带住：
      // 它进不了界面（失败出口的文案是 `09` §7.2 的定稿，不含错误码），
      // 只供诊断与测试断言「四类成因确实都落到了这里」。
      return setState({ phase: 'failed', error: result.error })
    }

    // ⚠️ **不看 `result.data.user.status`** —— `BLACKLISTED` 照样放行（`01` §1.4）。
    // 这里连读都不读，所以那条错误分叉在类型上也写不出来（见文件头裁决 3）。
    return setState({ phase: 'ready' })
  }
}

/**
 * 登录链的结果形状 —— **与 `api/session.ts` 的 `EnsureLoggedInResult` 结构一致**。
 *
 * ⚠️ 刻意**不 import 那个类型**，而是就地声明一份结构相同的：本模块只需要「成 / 败」，
 * 不需要知道成功的 `data` 里有什么（`LoginResponse | null`）。就地声明让**闸门对登录链
 * 的依赖收窄到两个字段**，也因此不需要在测试里造一份 `LoginResponse` —— 而那个 DTO
 * 里还挂着 `user.status` 这类与本模块无关的字段。
 *
 * ⚠️ 代价是「结构相同」这件事**没有编译期担保**：`api/session.ts` 改了形状而这里没跟上，
 * 只会在**调用点**（`createStartupGate()` 的缺省值）报错。真实调用点只有那一处，
 * 且它就在本仓库里、由 `pnpm typecheck` 覆盖 —— 这个代价是可接受的。
 */
export type EnsureLoginResult =
  | { ok: true; data: unknown }
  | { ok: false; error: UnifiedError }
