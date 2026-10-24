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
// - **不展示受限的 `auto`（自动 / 人工）归因**：那是内部信息，用户只看到
//   标题 / 正文 / 原因 / 起始时间 / 客服出口。
//
// ## 头像展示与编辑（#75）
//
// - **展示**：`resolveAvatar()` 只认本站文件地址；缓存命中同步换成本地路径，
//   未命中后台下载后替换，失败静默回本地默认图。地址失配（null / 历史外链）零请求。
// - **编辑**：半屏 `van-popup` 的头像位是 `button open-type="chooseAvatar"`；选图后
//   `prepareAvatar()` → `uploadAvatar()`。上传中头像位 spinner、「保存」禁用；失败保留
//   pending（再点保存即重传，不重选）；成功用 pending 本地文件预览并保留 `url`。
// - **保存**：只提交变化字段（`nickname` 和 / 或 `avatar`）。已上传但 `PUT` 失败时保留
//   `url`，下次只重发 `PUT`；成功则把 pending 直接 rename 进缓存（不下载）并重拉 `13.4`。
// - **关闭**：上传中先 `UploadTask.abort()` 再删 pending；已上传未保存只丢弃 `url`
//   （服务端孤儿按 §5 保留）。`avatarGeneration` 守卫挡住所有迟到回调。
// - **零开关**：不引入任何上传开关常量；文案只从 `copy.ts` 取。
//
// ## 昵称编辑
//
// 半屏 `van-popup`：`input type="nickname"` 预填当前值，trim 后 1–64；
// **只提交发生变化的字段**，成功关闭弹层并**重拉 `13.4`**（不做乐观更新），
// 失败留在弹层内一行「保存失败，请重试」；取消直接关闭、丢弃草稿。
//
// ⚠️ 用的是 `Component()` 而不是 `Page()` —— 与全端其余页面同一形态，
// 页面生命周期钩子写在 `methods` 里。

import { uploadAvatar } from '../../api/files'
import { getProfile, updateProfile } from '../../api/profile'
import { CONTACT_EXIT_ID, PAGE_TITLES, PROFILE_COPY, STATIC_EXITS } from '../../startup/copy'
import type { StaticExitId } from '../../startup/copy'
import {
  cleanupAvatarCache,
  parseAvatarFileId,
  promotePendingAvatar,
  resolveAvatar,
} from '../../utils/avatar-cache'
import { discardPendingAvatar, prepareAvatar } from '../../utils/avatar-image'
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
 * 上传限流的业务码 —— 后端 `ErrorCode.RATE_LIMITED(8008)`（HTTP 200 + code）。
 *
 * ⚠️ 与 `2` 一样写成具名常量：`8008` 本身看不出「限流」，而它是上传失败里唯一
 * 需要换一句文案的分支。
 */
const AVATAR_RATE_LIMIT_CODE = 8008

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
  /**
   * 选图 / 上传的**代号** —— 每次打开弹层、重新选图、关闭弹层都 +1。
   *
   * 上传是异步的，关闭弹层后回调仍会回来；只让「当前代号」的回调写界面，
   * 迟到的成功 / 失败都不能把已关闭的弹层重新点亮，也不能复活已丢弃的草稿。
   */
  avatarGeneration?: number
  /** 当前在飞的 `wx.uploadFile` task —— 关闭弹层时 abort。 */
  avatarUploadTask?: WechatMiniprogram.UploadTask | null
  /** 已选图并落盘的 pending 路径；未选图为 null。 */
  pendingAvatarPath?: string | null
  /**
   * 最近一次开始写 `upload/{槽位}` 的 prepare 代号。
   *
   * `prepareAvatar()` 是异步的：关闭弹层删掉 pending 后，它仍可能把压缩产物 copyFile
   * 回同一槽位。迟到结果到达时，只有这个字段仍等于自己的代号，才说明槽位没有更新的
   * 活草稿在占用 —— 这时才能再删一次；否则会误删用户刚选的新图。
   */
  pendingPrepareGeneration?: number
  /** 上传成功后拿到的 `url`；未上传 / 已丢弃为 null。 */
  uploadedAvatarUrl?: string | null
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
     * 身份区头像的**本地路径**；空串 = 本地默认图。
     *
     * 首帧只可能是「缓存命中」或空串（默认图）；未命中时后台下载，成功后由
     * `resolveAvatar()` 的回调换成缓存路径。地址失配（null / 历史外链）永远空串。
     */
    avatarPath: '',

    /**
     * 服务端的头像地址原值 —— 只用于比较「头像有没有变化」，不上屏。
     *
     * ⚠️ 不能拿 `avatarPath` 比较：它是本地缓存路径 / 空串，与 server 的 url 不同域。
     */
    savedAvatarUrl: null as string | null,

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

    // ── 资料编辑弹层 ──────────────────────────────────────────────────────
    popupVisible: false,
    /** 草稿 —— 预填当前值；取消时丢弃，不写回。 */
    nicknameDraft: '',
    /** 弹层内的昵称校验 / 保存失败提示；空串 = 不渲染。 */
    nicknameError: '',
    /** 保存进行中 —— 防重复提交；按钮同时 loading / disabled。 */
    saving: false,

    /** 弹层头像预览：已上传成功的 pending 本地文件；未选图时是当前头像。 */
    avatarPreviewPath: '',
    /** 头像上传中 —— 头像位 spinner，且「保存」禁用。 */
    avatarUploading: false,
    /** 头像相关失败提示（上传失败 / 过大 / 限流）；空串 = 不渲染。 */
    avatarError: '',
  },

  methods: {
    /**
     * 每次回到前台读一次 `13.4`。
     *
     * ⚠️ **不另写 `onLoad`**：tab 页首次进入也会触发 `onShow`，两个钩子都发请求
     * 就是「进入时打两次」，直接违反「进入与每次回到前台只调一次」。
     */
    onShow(): void {
      // 缓存清理只归 `onShow`：保存后的重拉不再顺手做一遍（那是 spec 之外的副作用）。
      void this.loadProfile({ cleanupCache: true })
    },

    /**
     * 读 `13.4` —— 三块共用这一次结果。
     *
     * @param options.cleanupCache 是否在画界面前清理头像缓存。只有 `onShow` 传 `true`；
     *        保存成功后的重拉不清理（避免把刚转正 / 刚起飞的下载当成过期文件）。
     *
     * ⚠️ 失败**不弹窗**：身份区与信用分卡各自显示一行「加载失败，请重试」，
     * 下方静态出口照常可用。受限卡按 `status` 条件出现，失败时自然不出现。
     */
    async loadProfile(options: { cleanupCache?: boolean } = {}): Promise<void> {
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
      const currentAvatarId = parseAvatarFileId(result.data.avatar)
      if (options.cleanupCache === true) {
        // ⚠️ 先清理、后 applyProfile：`applyProfile()` 会启动后台下载，刚写出的 `.part`
        // 若落在这轮清理之后就会被删掉，下载成功也 rename 不回来。
        // 弹层开着时 pending 是活草稿 —— 失败 / 8008 后「重试不重选」全靠它。
        await cleanupAvatarCache(currentAvatarId, { keepPending: this.data.popupVisible })
        // 清理是异步的：期间可能又发起了一次 `onShow`，旧结果不得再画上去。
        if (requestId !== page.profileRequestId) return
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
      const page = this as unknown as ProfilePageInstance
      const nickname = (profile.nickname ?? '').trim()
      const restricted = profile.status === RESTRICTED_STATUS
      // ⚠️ 契约里正常用户是 `null`；这里把 `undefined` 也收敛成 `null`，
      // 避免「字段缺失」被当成一条有值的记录去读 `createdAt`。
      const record = restricted ? (profile.blacklistRecord ?? null) : null
      const reason = (record?.reason ?? '').trim()
      const since = record === null ? '' : formatRestrictionSince(record.createdAt)
      const requestId = page.profileRequestId
      // 同步拿缓存路径；未命中时它立即返回 null 并后台下载，成功后回调换图。
      const cachedAvatar = resolveAvatar(profile.avatar, (localPath) => {
        // 迟到的下载不得盖掉一次更新的 13.4。
        if (page.profileRequestId !== requestId) return
        this.setData({ avatarPath: localPath })
      })

      this.setData({
        phase: 'ready',
        nickname: nickname === '' ? PROFILE_COPY.nicknameFallback : nickname,
        savedNickname: nickname,
        avatarPath: cachedAvatar ?? '',
        savedAvatarUrl: profile.avatar,
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
      const page = this as unknown as ProfilePageInstance
      // 新一次编辑：作废上一轮所有在飞 / 迟到回调，并清空上一轮的草稿引用。
      page.avatarGeneration = (page.avatarGeneration ?? 0) + 1
      page.avatarUploadTask = null
      page.pendingAvatarPath = null
      page.uploadedAvatarUrl = null
      this.setData({
        popupVisible: true,
        nicknameDraft: this.data.savedNickname,
        nicknameError: '',
        avatarPreviewPath: this.data.avatarPath,
        avatarUploading: false,
        avatarError: '',
      })
    },

    /**
     * 选了一张头像 —— 先压缩落 pending，再立即上传。
     *
     * ⚠️ `bindchooseavatar` **可能合法地不触发**（2.24.4 起用户取消 / 内容安全未过）：
     * 事件里没有 `avatarUrl` 时必须**静默返回** —— 不卡 loading、不发请求、弹层不变。
     *
     * 失败分支：`too-large` 用「图片过大」并零上传；其它失败用「图片上传失败」。
     * 两者都保留原头像；pending 只在 `prepareAvatar()` 成功后才有。
     */
    async onChooseAvatar(event: WechatMiniprogram.CustomEvent<{ avatarUrl?: string }>): Promise<void> {
      const tempPath = event.detail?.avatarUrl
      if (tempPath === undefined || tempPath === '') return
      if (this.data.avatarUploading) return

      const page = this as unknown as ProfilePageInstance
      page.avatarGeneration = (page.avatarGeneration ?? 0) + 1
      const generation = page.avatarGeneration
      page.pendingAvatarPath = null
      page.uploadedAvatarUrl = null
      page.pendingPrepareGeneration = generation
      // 选图期间先保持原预览；上传成功后才换成 pending 预览。
      this.setData({ avatarUploading: true, avatarError: '', avatarPreviewPath: this.data.avatarPath })

      const prepared = await prepareAvatar(tempPath)
      if (generation !== page.avatarGeneration) {
        // 关闭弹层 / 已重新选图后，流水线可能刚刚把 pending 又写了出来 —— 再删一次。
        // 但若槽位已被更新的一代 prepare 认领，删掉会误伤活草稿，必须放过。
        if (page.pendingPrepareGeneration === generation) {
          page.pendingPrepareGeneration = undefined
          await discardPendingAvatar()
        }
        return
      }
      if (!prepared.ok) {
        this.setData({
          avatarUploading: false,
          avatarError:
            prepared.reason === 'too-large'
              ? PROFILE_COPY.avatarTooLarge
              : PROFILE_COPY.avatarUploadFailed,
        })
        return
      }

      page.pendingAvatarPath = prepared.filePath
      await this.uploadDraftAvatar(generation)
    },

    /** 昵称输入 —— 草稿实时更新；用户开始改就不再显示上一次的错误。 */
    onNicknameInput(event: WechatMiniprogram.CustomEvent<{ value: string }>): void {
      this.setData({
        nicknameDraft: event.detail.value ?? '',
        nicknameError: '',
      })
    },

    /**
     * 上传当前 pending —— 选图后立即调一次；保存时若还没上传成功再调一次（重试不重选）。
     *
     * @returns 成功时的服务端 `url`；失败 / 这一代已作废时 `null`
     *
     * ⚠️ 失败**不删 pending**：用户再点「保存」就是一次重传，不需要重新选图。
     * ⚠️ `8008` 与普通失败都停在弹层内，但文案不同；**绝不自动重试**。
     */
    async uploadDraftAvatar(generation: number): Promise<string | null> {
      const page = this as unknown as ProfilePageInstance
      const pendingPath = page.pendingAvatarPath
      if (pendingPath === null || pendingPath === undefined) return null

      this.setData({ avatarUploading: true, avatarError: '' })
      const result = await uploadAvatar(pendingPath, {
        onTask: (task) => {
          // 弹层已关闭 / 已重新选图 —— 这一发不再属于当前草稿，立刻 abort。
          if (generation !== page.avatarGeneration) {
            task.abort()
            return
          }
          page.avatarUploadTask = task
        },
      })

      // 迟到的回调：不得写任何界面状态（弹层可能已经关了）。
      if (generation !== page.avatarGeneration) return null
      page.avatarUploadTask = null

      if (!result.ok) {
        const rateLimited =
          result.error.kind === 'business' && result.error.code === AVATAR_RATE_LIMIT_CODE
        this.setData({
          avatarUploading: false,
          avatarError: rateLimited ? PROFILE_COPY.avatarRateLimited : PROFILE_COPY.avatarUploadFailed,
        })
        return null
      }

      page.uploadedAvatarUrl = result.data.url
      this.setData({ avatarUploading: false, avatarPreviewPath: pendingPath, avatarError: '' })
      return result.data.url
    },

    /**
     * 保存资料 —— **只提交发生变化的字段**（`nickname` 和 / 或 `avatar`）。
     *
     * 头像有两条额外规则（#75）：
     *   • 选过图但还没上传成功（失败 / `8008`）⇒ 先重传，成功后才 `PUT`；重传不重选；
     *   • 上传成功但 `PUT` 失败 ⇒ 保留已上传 `url` 与 pending，下一次只重发 `PUT`
     *     （0 次 `uploadFile`），弹层不关。
     *
     * 成功：promote pending 进缓存（不下载）→ 关闭弹层 → 重拉 `13.4`。
     * 没有变化：直接关闭，不发空更新。
     */
    async onSaveProfile(): Promise<void> {
      if (this.data.saving || this.data.avatarUploading) return

      const trimmed = this.data.nicknameDraft.trim()
      const error = validateNickname(trimmed)
      if (error !== '') {
        this.setData({ nicknameError: error })
        return
      }

      const page = this as unknown as ProfilePageInstance
      const generation = page.avatarGeneration ?? 0
      const nicknameChanged = trimmed !== this.data.savedNickname
      const pendingPath = page.pendingAvatarPath ?? null
      const uploadedUrl = page.uploadedAvatarUrl ?? null
      const savedAvatarUrl = (this.data.savedAvatarUrl as string | null | undefined) ?? null
      /**
       * 唯一判据：这个头像地址相对服务端原值是否算一次变化。
       *
       * 上传前 / 重试后各判一次，但规则只有这一份 —— 两处各写一遍 `!== saved` 时，
       * 只要有一处漏掉 `null` 判断就会把「没换头像」发成一次空更新。
       */
      const hasAvatarChange = (url: string | null): boolean =>
        url !== null && url !== savedAvatarUrl
      const hasPendingAvatar = pendingPath !== null && uploadedUrl === null

      if (!nicknameChanged && !hasAvatarChange(uploadedUrl) && !hasPendingAvatar) {
        this.closeEditor()
        return
      }

      this.setData({ saving: true, nicknameError: '', avatarError: '' })

      // 选过图但没传成功 —— 保存就是「重试上传」的触发点，而不是重新选图。
      if (hasPendingAvatar) {
        const retriedUrl = await this.uploadDraftAvatar(generation)
        if (retriedUrl === null) {
          // 弹层若已关闭（代次变了），状态早被 closeEditor 收口，别在这里复活它。
          if (generation === page.avatarGeneration) this.setData({ saving: false })
          return
        }
      }

      const finalUrl = page.uploadedAvatarUrl ?? null
      const shouldSendAvatar = hasAvatarChange(finalUrl)
      const body: { nickname?: string; avatar?: string } = {}
      if (nicknameChanged) body.nickname = trimmed
      if (shouldSendAvatar && finalUrl !== null) body.avatar = finalUrl

      // 极端退化：上传回来的 url 与服务端原值相同（等于没换）且昵称没变 —— 不发空更新。
      if (body.nickname === undefined && body.avatar === undefined) {
        this.closeEditor()
        return
      }

      const result = await updateProfile(body)
      if (!result.ok) {
        this.setData({ saving: false, nicknameError: PROFILE_COPY.saveFailed })
        return
      }

      if (shouldSendAvatar && finalUrl !== null) {
        const fileId = parseAvatarFileId(finalUrl)
        // 显式消费转正结果：`false` 不能当成功。
        const promoted = fileId !== null && (await promotePendingAvatar(fileId))
        if (!promoted) {
          // 安全兜底（允许一次下载）：PUT 已成功，服务端手里就是这张图 —— 本地没转正
          // 不该让保存失败，也不该卡住弹层。下面的重拉会走 `resolveAvatar()` 的下载路径
          // （`downloadFile` 恰好 1 次、两段式落盘），成功后屏上仍是新头像。
          // pending 随后由 `closeEditor()` 删除，不留下跨会话垃圾。
        }
      }

      this.closeEditor()
      await this.loadProfile()
    },

    /** 取消 —— 关闭并**丢弃草稿**，不保留未保存修改。 */
    onCancelEdit(): void {
      this.closeEditor()
    },

    /**
     * 关闭弹层的唯一实现 —— 草稿回到服务端原值。
     *
     * 头像侧的三条清理（#75）：
     *   • 上传进行中 → `UploadTask.abort()`，随后删 pending；
     *   • 已上传未保存 → 只丢弃本地 `url`，**不调服务端删除**（孤儿按后端 §5 保留）；
     *   • 作废当前代号 → 迟到的上传回调不得再写界面。
     */
    closeEditor(): void {
      const page = this as unknown as ProfilePageInstance
      page.avatarGeneration = (page.avatarGeneration ?? 0) + 1
      const task = page.avatarUploadTask
      page.avatarUploadTask = null
      if (task !== null && task !== undefined) task.abort()
      page.pendingAvatarPath = null
      page.uploadedAvatarUrl = null
      // 无论 pending 引用是否还在都清一遍固定槽位：`prepareAvatar()` 失败（如过大）
      // 也可能已经落过盘，取消编辑同样不该把它留到下次启动。
      void discardPendingAvatar()
      this.setData({
        popupVisible: false,
        nicknameDraft: this.data.savedNickname,
        nicknameError: '',
        avatarPreviewPath: '',
        avatarUploading: false,
        avatarError: '',
        saving: false,
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
