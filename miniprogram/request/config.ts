// 请求层的**配置** —— 免鉴权端点名单与 baseUrl 解析。
//
// ⚠️ **登录 / 刷新两条**豁免是**源码核实过的事实**，不是推断：
// `java/smart-locker/src/main/java/com/zhichu/common/config/WebMvcConfig.java:46-47`：
//
//     registry.addInterceptor(appAuthInterceptor)
//             .addPathPatterns("/api/app/v1/**")
//             .excludePathPatterns("/api/app/v1/auth/login", "/api/app/v1/auth/refresh")
//
// 用户端路径下**只有这两个**被排除在 `AppAuthInterceptor` 之外。
// （管理端那两行另有 `/api/v1/auth/logout`，与本端无关 —— 别把 `13.3` 抄进来：
//  本端一期不接 `13.3`，且它**不在**用户端豁免名单里。）
//
// ⚠️ **内容端点**（`GET /contents/{key}`）是 spec #57 §13 新定义的**免鉴权**端点
// （后端待建）。免鉴权是硬要求：登录链失败时 `failure-exit` 必须还能打开计费 / FAQ。
// 它不能塞进 `AUTH_EXEMPT_PATHS`：路径带 `{key}`，不是固定串；因此单独维护一个**前缀**名单。

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
 * 内容端点的基路径 —— **免鉴权新端点**（spec #57 §13，后端待建）。
 *
 * ⚠️ 单独导出常量而不是在 `api/contents.ts` 里写一遍：路径只有一个家，
 * 豁免前缀由它派生；两处各写一遍字面量就有「名单放行、请求打偏」的漂移空间。
 *
 * ⚠️ 它**不属于** `AUTH_EXEMPT_PATHS` 那条源码核实过的登录豁免 —— 那条名单的每一项
 * 都必须能在后端 `WebMvcConfig` 里逐字找到。内容端点的免鉴权依据是 spec 的契约硬要求，
 * 后端落地时也必须保持免鉴权；这条注释就是给后端实现者的对照点。
 */
export const CONTENTS_PATH = `${API_PREFIX}/contents`

/**
 * 内容端点的**免鉴权前缀** —— 末尾的 `/` 是刻意的。
 *
 * ⚠️ `isAuthExempt` 用 `startsWith` 判定，若前缀写成 `/contents`，
 * `/contents-evil` 也会被放行。加上 `/` 之后只匹配 `/contents/<key>`。
 */
export const CONTENTS_PATH_PREFIX = `${CONTENTS_PATH}/`

/**
 * ⚠️ **登录 / 刷新**免鉴权端点 —— 硬编码，不是配置项。
 *
 * 把它做成可配置的，等于给「后来者顺手把某个端点加进豁免」留了一个不需要改代码的入口；
 * 而这条名单的正确性完全依赖后端 `WebMvcConfig` 那一行，多一个就是鉴权缺口。
 * 改动它必须同时改后端源码 —— 这个成本是**刻意保留**的。
 *
 * ⚠️ 内容端点**不在**这里：它的路径是动态的，见 `CONTENTS_PATH_PREFIX`。
 */
export const AUTH_EXEMPT_PATHS: readonly string[] = [LOGIN_PATH, REFRESH_PATH]

/**
 * 免鉴权**前缀**名单 —— 那些路径带变量的端点。
 *
 * ⚠️ 目前只有内容端点。新增一项等于给一整棵路径树免鉴权，
 * 必须同时确认后端 `WebMvcConfig` 的 `excludePathPatterns` 覆盖同一批路径。
 */
export const AUTH_EXEMPT_PREFIXES: readonly string[] = [CONTENTS_PATH_PREFIX]

/** 路径是否属于免鉴权豁免（登录 / 刷新 / 内容端点）。 */
export function isAuthExempt(path: string): boolean {
  return (
    AUTH_EXEMPT_PATHS.includes(path) ||
    AUTH_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))
  )
}

/**
 * 后端基地址 —— 本机联调的开发后端（`http://localhost:8080`）。
 *
 * 联调事实：`13.1` 返回 `code:0`。
 *
 * ⚠️ 一期**没有环境切换机制**（不在 #18 的范围）：地址先落成常量，等真有测试环境时
 * 再引入开关。不预先编造 `env` 参数或取值函数 —— 那会造出一个「看起来能配、其实没人配」
 * 的旋钮（ADR-0002 的克制取向）。
 *
 * ⚠️ **裸 `localhost` 只在开发者工具里可用** —— 工具跑在开发机上，`localhost` 就是开发机。
 * **真机不是**：手机上的 `localhost` 指向手机自己，请求会打到手机本机（必然失败）。
 * 真机联调的两种走法见 #22 的走查清单：
 *   1. 把本常量改成开发机的**局域网 IP**（如 `http://192.168.x.x:8080`），手机与开发机同网；
 *   2. 开发者工具「详情 → 本地设置 → **不校验合法域名**」—— 仅对工具内预览/调试生效，
 *      且 `http` 明文 + 非备案域名在**正式版**小程序里一律被拦。
 *
 * ⚠️ 因此本常量是**联调态**，不是可上线态。上线前它必须换成备案的 `https` 域名
 * （上线前置项里的企业主体 / ICP 备案那几条，同属一个性质）。
 */
export const BASE_URL = 'http://localhost:8080'
