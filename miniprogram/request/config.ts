// 请求层的**配置** —— 唯二免鉴权端点的硬编码豁免名单，与 baseUrl 解析。
//
// 契约出处：`docs/spec/07-engineering-form.md` §4.3 硬约束 5。
//
// ⚠️ 豁免名单是**源码核实过的事实**，不是推断：
// `java/smart-locker/src/main/java/com/zhichu/common/config/WebMvcConfig.java:46-47`：
//
//     registry.addInterceptor(appAuthInterceptor)
//             .addPathPatterns("/api/app/v1/**")
//             .excludePathPatterns("/api/app/v1/auth/login", "/api/app/v1/auth/refresh")
//
// 用户端路径下**只有这两个**被排除在 `AppAuthInterceptor` 之外。
// （管理端那两行另有 `/api/v1/auth/logout`，与本端无关 —— 别把 `13.3` 抄进来：
//  本端一期不接 `13.3`，且它**不在**用户端豁免名单里。）

/** 用户端 API 前缀。`WebMvcConfig` 的拦截范围是 `/api/app/v1/**`。 */
export const API_PREFIX = '/api/app/v1'

/**
 * `13.1` 登录的路径 —— **豁免名单里那两个**。
 *
 * ⚠️ 之所以单独导出常量（而不只是塞在 `AUTH_EXEMPT_PATHS` 数组里）：`api/auth.ts`
 * 要用同一个字符串去发请求，两边各写一遍字面量就有漂移空间 —— 而**豁免名单错了就是
 * 鉴权缺口**。路径只有一个家，`api/` 从这里 import。
 */
export const LOGIN_PATH = `${API_PREFIX}/auth/login`

/** `13.2` 刷新的路径。见 `LOGIN_PATH` 的注释。 */
export const REFRESH_PATH = `${API_PREFIX}/auth/refresh`

/**
 * ⚠️ **唯二**免鉴权端点 —— 硬编码，不是配置项。
 *
 * 把它做成可配置的，等于给「后来者顺手把某个端点加进豁免」留了一个不需要改代码的入口；
 * 而这条名单的正确性完全依赖后端 `WebMvcConfig` 那一行，多一个就是鉴权缺口。
 * 改动它必须同时改后端源码 —— 这个成本是**刻意保留**的。
 */
export const AUTH_EXEMPT_PATHS: readonly string[] = [LOGIN_PATH, REFRESH_PATH]

/** 路径是否属于免鉴权豁免（`13.1` / `13.2`）。 */
export function isAuthExempt(path: string): boolean {
  return AUTH_EXEMPT_PATHS.includes(path)
}

/**
 * 后端基地址 —— 本机联调的开发后端（`http://localhost:8080`）。
 *
 * 契约出处：`docs/spec/07-engineering-form.md` §4.3；联调事实见 issue #22
 * （charting 实测 `13.1` 返回 `code:0`）。
 *
 * ⚠️ 一期**没有环境切换机制**（不在 #18 的范围）：地址先落成常量，等真有测试环境时
 * 再引入开关。不预先编造 `env` 参数或取值函数 —— 那会造出一个「看起来能配、其实没人配」
 * 的旋钮（ADR-0002 / `07` §2 的克制取向）。
 *
 * ⚠️ **裸 `localhost` 只在开发者工具里可用** —— 工具跑在开发机上，`localhost` 就是开发机。
 * **真机不是**：手机上的 `localhost` 指向手机自己，请求会打到手机本机（必然失败）。
 * 真机联调的两种走法见 #22 的走查清单：
 *   1. 把本常量改成开发机的**局域网 IP**（如 `http://192.168.x.x:8080`），手机与开发机同网；
 *   2. 开发者工具「详情 → 本地设置 → **不校验合法域名**」—— 仅对工具内预览/调试生效，
 *      且 `http` 明文 + 非备案域名在**正式版**小程序里一律被拦。
 *
 * ⚠️ 因此本常量是**联调态**，不是可上线态。上线前它必须换成备案的 `https` 域名
 * （`01` §7 的上线前置项里已有企业主体 / ICP 备案那几条，同属一个性质）。
 */
export const BASE_URL = 'http://localhost:8080'
