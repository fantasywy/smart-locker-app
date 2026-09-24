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
 * 后端基地址。
 *
 * ⚠️ 一期**没有环境切换机制**（不在 #18 的范围）：地址先落成常量，等真有测试环境时
 * 再引入开关。不预先编造 `env` 参数或取值函数 —— 那会造出一个「看起来能配、其实没人配」
 * 的旋钮（ADR-0002 / `07` §2 的克制取向）。
 */
export const BASE_URL = 'https://api.example.com'
