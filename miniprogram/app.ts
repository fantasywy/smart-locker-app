// 小程序入口 —— 只做**启动态的承载**，不做登录。
//
// 契约出处：`docs/spec/01-entry-and-identity.md` §3（登录链）、§4（全局失败出口）；
// `docs/spec/07-engineering-form.md` §6（状态管理：不引 store）。
//
// ⚠️ **登录链不在这里。** 它在 `api/session.ts` 的 `ensureLoggedIn()` ——
// 冷启动 `wx.login` → `13.1` → 双 token 落 `storage`（`01` §3.4 状态机）。
// 本文件**刻意不调它**：启动闸门与「骨架先出现、数据区等 token」的呈现属 #20，
// 本票（#18）只交付请求层与登录链本身。
//
// 为什么把 quickstart 骨架里那段 `wx.login` 删掉了：它取到 `code` 之后只 `console.log`，
// 是个**会误导后来者的示范** —— 正确的用法（把 code 交给 `13.1`、把双 token 落 storage）
// 现在有一处真实实现可看，入口文件不该同时存在一份丢弃结果的旧写法。
//
// ⚠️ `globalData` 保持为空：`07` §6 规定它**仅供请求层自用**（token 句柄、单一飞行队列状态），
// **不放业务数据**。而本票连请求层都没用到它 —— token 走 `storage`（§4.4 定案）。
App<IAppOption>({
  globalData: {},
})
