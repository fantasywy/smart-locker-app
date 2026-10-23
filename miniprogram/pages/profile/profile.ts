// 「我的」页 —— **账号页**：身份、受限提示、信用分、我的服务与帮助支持。
//
// ## 这一页的三条数据纪律
//
// 1. **进入与每次回到前台只读一次 `13.4`，三块共用同一次结果。**
//    身份区 / 受限卡 / 信用分卡需要的字段全在同一条响应里；拆成三条请求会让三块
//    各自失败、各自重试，页面上出现三种「加载失败」。
//    tab 页的首次进入也走 `onShow`（tab 页一定会触发它），所以**不另写 `onLoad`** ——
//    两个钩子都发请求就是进入时打两次。
//
// 2. **失败只在块内说一句，不把整页塌成失败页。**
//    身份区与信用分卡各自骨架、各自一行「加载失败，请重试」；下方静态出口
//    （我的预约 / 计费说明 / 常见问题 / 联系客服）与网络无关，**照常可用**。
//
// 3. **不做本地业务数据缓存。** 受限状态与信用分属「看到就必须是真的」的数据，
//    每次 `onShow` 都从 `api/` 取；页面零 `storage` 读写。
//
// ## 明确不做的事（spec #57 §9「明确不做」）
//
// - **不展示手机号**：`13.4` 响应里有 `phone`，但页面**不把它搬进 `data`**。
// - **不做退出登录 / 账号注销 / 发票 / 优惠券**：这些能力没有换账号语义或端点未就绪，
//   做出来就是假入口（spec §14.8「不造假入口」）。
// - **头像只读、只用本地默认图**：不发起任何网络请求、不出现加载中、不出现上传入口，
//   也**不引入任何编译期开关 / 常量**（#69 落票勘误：`AVATAR_UPLOAD_ENABLED` 不得存在；
//   上传接线由 #75 接管）。身份区画的是 `icon` 组件的本地默认头像。
// - **不展示受限的 `auto`（自动 / 人工）归因**：那是内部信息，用户只看到
//   标题 / 正文 / 原因 / 起始时间 / 客服出口。
//
// ## 昵称编辑
//
// 半屏 `van-popup`：`input type="nickname"` 预填当前值，trim 后 1–64；
// **只提交发生变化的字段**（本票只有 `nickname`），成功关闭弹层并**重拉 `13.4`**
// （不做乐观更新），失败留在弹层内一行「保存失败，请重试」；取消直接关闭、丢弃草稿。
//
// ⚠️ 用的是 `Component()` 而不是 `Page()` —— 与全端其余页面同一形态，
// 页面生命周期钩子写在 `methods` 里。

import { getProfile, updateProfile } from '../../api/profile'
import { CONTACT_EXIT_ID, PAGE_TITLES, PROFILE_COPY, STATIC_EXITS } from '../../startup/copy'
import type { StaticExitId } from '../../startup/copy'
import { formatRestrictionSince } from '../../utils/datetime'
import { RESERVATION_LIST_PATH, SCORE_LOGS_PATH, STATIC_EXIT_PATHS } from '../../utils/routes'
import type { ProfileResponse } from '../../types/profile'
import type { UserStatus } from '../../types/auth'

/**
 * 昵称长度上限 —— 与 `13.5` 的 `@Size(max = 64)` 逐字对齐。
 *
 * ⚠️ 用 `trimmed.length`（UTF-16 code unit）而不是「看起来几个字」：
 * 后端 `@Size` 数的就是这个单位，客户端若用别的口径，会出现「本地说超了、服务端说没超」
 * 或反过来（而后者会被服务端 `1001` 退回，用户看到一句无原因的失败）。
 */
const NICKNAME_MAX_LENGTH = 64

/**
 * 受限状态的数字码 —— 后端 `UserStatus` 的 `2`。
 *
 * ⚠️ 写成具名常量而不是散落的 `=== 2`：数字码没有自解释性，
 * 而 `status` 的语义（受限）正是这一页唯一按状态分叉的地方。
 */
const RESTRICTED_STATUS: UserStatus = 2

/**
 * 静态出口的行为 id → 语义图标。
 *
 * ⚠️ 键是 `STATIC_EXITS` 的 `id`，不是 `label` —— 改词不该让图标错位。
 * 图标是**界面装饰**，不属于文案层；出口的那几个字仍从 `copy.ts` 来。
 */
const STATIC_EXIT_ICONS: Record<StaticExitId, string> = {
  billing: 'profile.billing',
  faq: 'profile.faq',
  contact: 'profile.contact',
}

/** 渲染用的静态出口行 —— 文案来自 `STATIC_EXITS`，图标在这里配对。 */
const PROFILE_STATIC_EXITS = STATIC_EXITS.map((exit) => ({
  id: exit.id,
  label: exit.label,
  icon: STATIC_EXIT_ICONS[exit.id],
}))

/**
 * 页面实例上不进入 `data` 的私有字段。
 *
 * ⚠️ `profileRequestId` 是**竞态守卫**：`onShow` 可能在上一发请求还没回来时又触发一次
 * （快速切 tab），若两次响应乱序到达，旧响应会把新数据盖回去。只让「最后一次发起的请求」
 * 写界面，代价是一个自增数字。
 */
interface ProfilePageInstance {
  profileRequestId?: number
}

/**
 * 昵称校验 —— trim 后 1–64。
 *
 * @returns 逐字错误文案；合法时返回空串（空串 = 没有错误，不是「错误文案为空」）
 *
 * ⚠️ 校验的是 **trim 后**的值：`13.5` 拒收空串 / 纯空白，客户端必须先拦，
 * 否则用户看到的是服务端 `1001` 的统一失败话术，而不是「昵称不能为空」。
 * 提交时也提交 trim 后的值 —— 服务端「按原值写入」不会替我们去空白。
 */
function validateNickname(trimmed: string): string {
  if (trimmed === '') return PROFILE_COPY.nicknameEmpty
  if (trimmed.length > NICKNAME_MAX_LENGTH) return PROFILE_COPY.nicknameTooLong
  return ''
}

Component({
  data: {
    /** 自绘导航栏标题 —— 唯一的家是 `startup/copy.ts` 的 `PAGE_TITLES`。 */
    title: PAGE_TITLES['pages/profile/profile'],

    // ── 身份 / 受限 / 信用分 ──────────────────────────────────────────────
    /** 三块共用的读取状态：loading 时各自骨架，failed 时各自一行提示。 */
    phase: 'loading' as 'loading' | 'ready' | 'failed',

    /** 身份区显示名 —— 服务端昵称为空时回退「微信用户」。 */
    nickname: '',

    /**
     * 服务端的昵称原值（已 trim）—— **只用于比较「有没有变化」**，不上屏。
     *
     * ⚠️ 不能拿显示名去比较：显示名可能是回退值「微信用户」，而服务端原值是空。
     * 用户把它改成「微信用户」是一次真实的变化，应当提交。
     */
    savedNickname: '',

    /** 信用分 —— 只显示分数，不显示满分 / 档位 / 分母。 */
    score: 0,

    /** 是否受限 —— **只有 `status === 2` 才渲染受限卡**。 */
    restricted: false,

    /** 受限原因行（已拼好、为空则不渲染）；不展示 `auto` 归因。 */
    restrictionReason: '',

    /** 受限时间行（「自 … 起」）；解析不出时刻时留空，整行不渲染。 */
    restrictionSince: '',

    // ── 文案（全部来自 `PROFILE_COPY` / `STATIC_EXITS`） ────────────────
    editProfileLabel: PROFILE_COPY.editProfile,
    restrictedTitle: PROFILE_COPY.restrictedTitle,
    restrictedBody: PROFILE_COPY.restrictedBody,
    restrictedContact: PROFILE_COPY.restrictedContact,
    creditTitle: PROFILE_COPY.creditTitle,
    creditDetail: PROFILE_COPY.creditDetail,
    servicesTitle: PROFILE_COPY.servicesTitle,
    helpTitle: PROFILE_COPY.helpTitle,
    reservationsLabel: PROFILE_COPY.reservations,
    nicknameLabel: PROFILE_COPY.nicknameLabel,
    saveLabel: PROFILE_COPY.save,
    cancelLabel: PROFILE_COPY.cancel,
    blockLoadFailed: PROFILE_COPY.blockLoadFailed,

    /** 静态出口三件套 —— 复用 `STATIC_EXITS`，不另写一份文案。 */
    staticExits: PROFILE_STATIC_EXITS,

    /** 客服那一件的行为 id —— 模板据此决定渲染原生 `open-type="contact"` 按钮。 */
    contactExitId: CONTACT_EXIT_ID,

    // ── 昵称编辑弹层 ──────────────────────────────────────────────────────
    popupVisible: false,
    /** 草稿 —— 预填当前值；取消时丢弃，不写回。 */
    nicknameDraft: '',
    /** 弹层内的校验 / 保存失败提示；空串 = 不渲染。 */
    nicknameError: '',
    /** 保存进行中 —— 防重复提交；按钮同时 loading / disabled。 */
    saving: false,
  },

  methods: {
    /**
     * 每次回到前台读一次 `13.4`。
     *
     * ⚠️ **不另写 `onLoad`**：tab 页首次进入也会触发 `onShow`，两个钩子都发请求
     * 就是「进入时打两次」，直接违反「进入与每次回到前台只调一次」。
     */
    onShow(): void {
      void this.loadProfile()
    },

    /**
     * 读 `13.4` —— 三块共用这一次结果。
     *
     * ⚠️ 失败**不弹窗**：身份区与信用分卡各自显示一行「加载失败，请重试」，
     * 下方静态出口照常可用。受限卡按 `status` 条件出现，失败时自然不出现。
     */
    async loadProfile(): Promise<void> {
      const page = this as unknown as ProfilePageInstance
      page.profileRequestId = (page.profileRequestId ?? 0) + 1
      const requestId = page.profileRequestId

      // ⚠️ 受限卡**不在骨架里**，所以必须在这里显式收回：否则重拉期间会继续展示
      // 上一次的「账号受限」，而重拉失败时它会**永远留在屏上**（spec §9：受限卡在
      // 数据回来后按 status 条件出现；失败只该在块内说一句）。
      this.setData({
        phase: 'loading',
        restricted: false,
        restrictionReason: '',
        restrictionSince: '',
      })
      const result = await getProfile()
      // 旧请求回来得太晚 —— 丢弃，别把新数据盖回去。
      if (requestId !== page.profileRequestId) return
      if (!result.ok) {
        this.setData({ phase: 'failed' })
        return
      }
      this.applyProfile(result.data)
    },

    /**
     * 把 `13.4` 的响应画到三块上。
     *
     * ⚠️ `phone` 与 `avatar` **都不搬进 `data`**：前者不展示，后者本票只画本地默认图。
     * 少搬一个字段，就少一条「后来者顺手把它画上屏」的路。
     */
    applyProfile(profile: ProfileResponse): void {
      const nickname = (profile.nickname ?? '').trim()
      const restricted = profile.status === RESTRICTED_STATUS
      // ⚠️ 契约里正常用户是 `null`；这里把 `undefined` 也收敛成 `null`，
      // 避免「字段缺失」被当成一条有值的记录去读 `createdAt`。
      const record = restricted ? (profile.blacklistRecord ?? null) : null
      const reason = (record?.reason ?? '').trim()
      const since = record === null ? '' : formatRestrictionSince(record.createdAt)

      this.setData({
        phase: 'ready',
        nickname: nickname === '' ? PROFILE_COPY.nicknameFallback : nickname,
        savedNickname: nickname,
        score: profile.score,
        restricted,
        restrictionReason:
          reason === '' ? '' : PROFILE_COPY.restrictedReason.replace('{reason}', () => reason),
        restrictionSince: since,
      })
    },

    /**
     * 身份区整行 → 打开「编辑资料」弹层。
     *
     * ⚠️ **受限用户照样能改资料**：`13.5` 不被黑名单拦截（spec §9）。
     * ⚠️ 读取失败时不打开：此刻没有可信的服务端昵称可预填，拿空串去「编辑」会把
     * 「不知道」伪装成「是空的」。
     */
    onEditProfile(): void {
      if (this.data.phase !== 'ready') return
      this.setData({
        popupVisible: true,
        nicknameDraft: this.data.savedNickname,
        nicknameError: '',
      })
    },

    /** 昵称输入 —— 草稿实时更新；用户开始改就不再显示上一次的错误。 */
    onNicknameInput(event: WechatMiniprogram.CustomEvent<{ value: string }>): void {
      this.setData({
        nicknameDraft: event.detail.value ?? '',
        nicknameError: '',
      })
    },

    /**
     * 保存昵称 —— **只提交发生变化的字段**。
     *
     * 成功：关闭弹层 + 重拉 `13.4`（服务端回显才是事实，不做乐观更新）。
     * 失败：**留在弹层内**一行「保存失败，请重试」，草稿不丢。
     * 没有变化：直接关闭，不发一次空更新。
     */
    async onSaveProfile(): Promise<void> {
      if (this.data.saving) return

      const trimmed = this.data.nicknameDraft.trim()
      const error = validateNickname(trimmed)
      if (error !== '') {
        this.setData({ nicknameError: error })
        return
      }

      if (trimmed === this.data.savedNickname) {
        this.closeEditor()
        return
      }

      this.setData({ saving: true, nicknameError: '' })
      const result = await updateProfile({ nickname: trimmed })
      if (!result.ok) {
        this.setData({ saving: false, nicknameError: PROFILE_COPY.saveFailed })
        return
      }

      this.setData({ saving: false, popupVisible: false, nicknameDraft: '', nicknameError: '' })
      await this.loadProfile()
    },

    /** 取消 —— 关闭并**丢弃草稿**，不保留未保存修改。 */
    onCancelEdit(): void {
      this.closeEditor()
    },

    /** 关闭弹层的唯一实现 —— 草稿回到服务端原值。 */
    closeEditor(): void {
      this.setData({
        popupVisible: false,
        nicknameDraft: this.data.savedNickname,
        nicknameError: '',
      })
    },

    /** 信用分卡「明细 ›」→ 信用分明细页。 */
    onScoreLogs(): void {
      wx.navigateTo({ url: `/${SCORE_LOGS_PATH}` })
    },

    /** 「我的服务 → 我的预约」→ 我的预约页。 */
    onReservations(): void {
      wx.navigateTo({ url: `/${RESERVATION_LIST_PATH}` })
    },

    /**
     * 静态出口里「计费说明」/「常见问题」的点击。
     *
     * ⚠️ 按 `id` 选目标、不按 `label`（`STATIC_EXITS` 的 id 是行为选择器）。
     * ⚠️ 「联系客服」不走这里：它是 `open-type="contact"` 原生按钮，不做运行时降级。
     * ⚠️ 内容端点免鉴权，所以即便资料读取失败，这两页也真的能打开。
     */
    onStaticExit(event: WechatMiniprogram.TouchEvent): void {
      const exitId: unknown = event.currentTarget.dataset['exitId']
      if (exitId !== 'billing' && exitId !== 'faq') return
      const target = STATIC_EXIT_PATHS[exitId]
      if (target === undefined) return
      wx.navigateTo({ url: `/${target}` })
    },
  },
})
