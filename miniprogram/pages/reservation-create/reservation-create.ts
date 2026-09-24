// reservation-create 页 —— **空壳**（issue #22 铺的骨架，页面本身归各自的功能票）。
//
// ⚠️ 这里**刻意什么都不做**：没有 `api/` 调用、没有生命周期逻辑、没有业务 `data`。
//     空壳的全部职责是「让 `app.json` 注册的路径真实存在、编译得过」——
//     `07` §5 的页面清单因此一次落地，页面票不必再动 `app.json`。
//
// ⚠️ 唯一的 `data` 是 `title`，且它**从文案层取**（`startup/copy.ts`），
//     不是在本目录里写一份字面量。理由见 wxml 的注释。
//
// ⚠️ 用 `Component()` 而不是 `Page()` —— 与仓库既有页面一致，且 `Component`
//     的 `lifetimes` 给页面票留了明确的挂载点（订阅在 `attached`、退订在 `detached`）。
//
// 出处：`docs/spec/05-reservation.md` §6。

import { PAGE_TITLES } from '../../startup/copy'

Component({
  data: {
    /** 自绘导航栏标题 —— 唯一的家是 `startup/copy.ts` 的 `PAGE_TITLES`。 */
    title: PAGE_TITLES['pages/reservation-create/reservation-create'],
  },
})
