// 启动闸门的**文案** —— 全局失败出口的三要素与骨架屏的口径。
//
// ⚠️ **文案集中在常量里，不散在 wxml 字面量中。** 理由与本仓库既有的两条纪律一致：
// 文案有唯一事实源，类型层与页面层都不该自己造词。
// 更实际的一条：失败出口的说明句是**定稿逐字**，把它拆进 `<view>` 标签里之后，
// 「有没有照抄」这件事就只能靠眼睛看 —— 而它恰恰是本票验收标准里的一条。

/**
 * 全局失败出口的**说明句** —— 两行，定稿逐字。
 *
 * 定稿形态：
 *
 * > **暂时连不上**<br>请检查网络后重试
 *
 * ⚠️ **四类成因共用这一句话**（网络不通 / `wx.login` 失败 / `8001` / 5xx）。
 * 不写「微信登录失败」这类按成因分叉的措辞 —— 用户对成因无能为力，四句话只是把
 * 同一个死胡同说了四遍。也**不出现错误码**（`8001`、`500` 之类）与「鉴权失败」
 * 这类术语（本票 Acceptance criteria、禁用词表）。
 */
export const FAILURE_TITLE = '暂时连不上'

/** 失败出口说明句的第二行 —— 定稿逐字。 */
export const FAILURE_DETAIL = '请检查网络后重试'

/** 重试按钮 —— 定稿逐字。动作 = 重跑启动链。 */
export const RETRY_LABEL = '重试'

/**
 * 页内业务请求失败的统一说明句 —— **定稿逐字**。
 *
 * ⚠️ spec §1 明确要求「页内失败统一一句『加载失败，请重试』（从柜机页提升为共用常量）」。
 * 柜机页、内容页（计费 / 常见问题）的 GET 失败都用这一句；它只描述「重新试一次」这个
 * 唯一可行动信息，不按成因分叉（网络失败 / 5xx / 未知 key 对用户是同一件事）。
 *
 * ⚠️ 它是**界面文案**，不是内容正文；内容正文只从内容端点来，不进本文件。
 */
export const LOAD_FAILED_DETAIL = '加载失败，请重试'

/**
 * 静态出口三件套 —— 定稿逐字。
 *
 * ⚠️ **「两条路一份内容」**：这里的三个出口与「我的」页的静态出口
 * 是**同一份内容**，不是两份长得像的。将来「我的」页实现时**必须**复用这三个条目，
 * 不得另写一份字面量 —— 否则「计费说明」在两个地方各有一份文案，
 * 改一处漏一处的那天就是两条路分叉的那天。
 *
 * ⚠️ **每一项带一个 `id`，而不是靠 `label` 认人。**
 * 这三条路的**载体不同**：「联系客服」是 `open-type="contact"` 的原生按钮，
 * 另两条是本地内容页。模板若写成 `wx:if="{{ item === '联系客服' }}"`，
 * 就是**拿文案当行为选择器** —— 于是本文件的「文案只有一个家」在这句话上自己破了例，
 * 且一旦有人改了那个词（哪怕只是措辞），客服按钮会**静默退化成**一个点了没反应的
 * `<view>`（既定的做法是不做降级，所以这个退化没有任何兜底）。
 * `id` 让「行为」与「措辞」解耦：改词不动行为，改行为不动词。
 */
export const STATIC_EXITS = [
  { id: 'billing', label: '计费说明' },
  { id: 'faq', label: '常见问题' },
  { id: 'contact', label: '联系客服' },
] as const

/** 静态出口里那一件的形状。 */
export type StaticExit = (typeof STATIC_EXITS)[number]

/** 静态出口的标识 —— 行为选择器用它，**不得**用 `label`（见 `STATIC_EXITS` 的说明）。 */
export type StaticExitId = StaticExit['id']

/**
 * 客服那一件的 id —— 模板据此决定渲染 `open-type="contact"` 的按钮。
 *
 * ⚠️ 它是「只做 `open-type="contact"` 一个按钮」这条裁决在模板里的挂点。
 * 写成常量而不是在 wxml 里比对文字，理由见 `STATIC_EXITS`。
 */
export const CONTACT_EXIT_ID: StaticExitId = 'contact'

/**
 * 骨架屏的形状口径 —— 定稿逐字：
 *
 * > **纯图形占位，无文字。** 形状对照真实版式：列表行 = 色条 + 两行短块 + 状态标签位
 *
 * ⚠️ **不得放「加载中」文字盖住骨架**。所以这里**没有**任何
 * 「加载中」常量 —— 不是漏了，是那一句的正确用法就不该落在骨架屏上。
 *
 * 本常量只登记「骨架屏由几行组成」这一件可判定的事，供页面 `wx:for` 出占位块；
 * 形状与配色归页面 scss（token 走设计变量）。
 */
export const SKELETON_ROW_COUNT = 3

/**
 * 闸门放行后，业务数据区在**订单列表落地之前**的占位文案。
 *
 * ⚠️⚠️ **这是本票唯一一处「占位文案」，且它是一笔明确的债。**
 *
 * 文案纪律：用户可见的每一个字都归文案层。这两句**没有定稿出处** ——
 * 它们不是定稿，是本票为了让「闸门通了」这件事**在真机上可被看见**而临时写下的。
 * 订单列表落地时，这块占位由列表的**空态**取代，
 * 届时这两句**必须一起删掉**（空态的定稿是「还没有订单」+「扫码存件」入口）。
 *
 * ⚠️ 第一版把它们直接写在 `index.wxml` 里，且第二句是「订单列表将在后续票中落地」——
 * 那是一句**开发者台词**（它说的是本仓库的排期，不是用户的事），
 * 而它恰好出现在本票唯一会渲染成功的界面上。review 抓到了这一点，已改。
 * 这里保留的措辞只说用户看得懂的事：**已经连上了**、**内容还没有**。
 */
export const DATA_AREA_PLACEHOLDER_TITLE = '已连接'

/**
 * 占位块第二行 —— ⚠️ 与标题同属**过渡期债**，见 `DATA_AREA_PLACEHOLDER_TITLE`。
 *
 * 刻意**不提**任何内部排期（「后续票」/「待开发」一类）：那是开发者台词。
 * 用户看到的是「这里暂时是空的」，而不是「你们还没做完」。
 */
export const DATA_AREA_PLACEHOLDER_HINT = '订单内容稍后在这里出现'

/**
 * **三个列表页的空态** —— 三行**逐字**，`components/empty-state/` 的内容来源。
 *
 * ⚠️ 它们为什么在**这一张表**里、而不是分散在三个页面目录里：三个空态共用一个组件
 * （「空态」是 `components/` 的成员），而组件的 `properties` **不带默认文案**
 * （见 `empty-state.ts` 的裁决 1）—— 于是三组文案必须有**一个共同的来源**交给它。
 * 分散在三个页面里也能跑，但那意味着「空态文案有哪些」这件事在代码里查不到全貌，
 * 而这里恰恰是一张**完整的表**（三行，不多不少）。
 *
 * ⚠️ **`hint` / `actionLabel` 缺省是空串，不是缺失。** 信用分明细的空态
 * 在这张表里**只有标题** —— 别为了「凑齐两行」给它编一句说明或一个按钮。
 * 一句查不到出处的文案就是缺口，该登记而不是自编（文案纪律）。
 *
 * ⚠️ **两个主行动都是「扫码存件」，这是同一个动作，不是两个恰好同名的动作**
 * （同一个动作在全局只能有一个名字）。预约空态**不是**「新建预约」——
 * 已有裁决：创建入口**只在柜机页**（`lockerId` 的唯一来源是扫码），
 * 所以空态的出口**只能是扫码**。两者共用下面同一个常量，正是为了让那条裁决写不出来错。
 */
export const EMPTY_STATES = {
  /** 订单列表空态 —— 逐字（一个空态，不区分「从没下过单」与「清空之后」）。 */
  orders: {
    title: '还没有订单',
    hint: '扫码存件，把东西放进柜子',
    actionLabel: '扫码存件',
  },
  /** 预约列表空态 —— 逐字（出口只能是扫码）。 */
  reservations: {
    title: '还没有预约',
    hint: '到柜机前扫码后可以预约使用时段',
    actionLabel: '扫码存件',
  },
  /** 信用分明细空态 —— 逐字（文案未定，本条是提案）。**只有标题。** */
  scoreLogs: {
    title: '还没有分数变动',
    hint: '',
    actionLabel: '',
  },
} as const satisfies Record<string, { title: string; hint: string; actionLabel: string }>

/**
 * **首页**的全部用户可见文案 —— spec #57 §2「逐字文案」表里属于首页的那几行。
 *
 * ⚠️ 为什么首页的文案要单独成表：首页是**唯一主行动**的承载页，品牌区、主按钮与
 * 两条扫码反馈都挤在第一屏。把它们散在页面 `data` 与 wxml 里，改一句就要翻三处；
 * 更糟的是「非柜机码」与「扫码失败」是**两句不同的提示**，散写最容易在复制粘贴时
 * 让两条失败路径共用同一句话 —— 而那正是票面要区分的两件事。
 *
 * ⚠️ 逐字依据（spec §2）：
 *   • `wordmark` / `tagline` / `scanButton` —— 品牌区与主按钮定稿；
 *   • `notLockerCode` —— 「这不是柜机码，请扫柜机上的二维码」；
 *   • `scanFailed` —— 「扫码没成功，请重试」。
 *
 * ⚠️ **相机权限不在这张表里，也不在任何界面里**：`wx.scanCode` 不写 `authSetting`，
 * `wx.getSetting()` 无法区分「未请求」与「被拒绝」，所以任何「请开启相机权限」
 * 都是假归因（spec §2 末段）。将来若真需要，唯一可靠的路是自绘 `<camera>` 扫码页。
 */
export const HOME_PAGE_COPY = {
  /** 品牌 wordmark —— 逐字。24px / 600，收敛到 `$font-size-hero`。 */
  wordmark: '智能储物柜',
  /** 品牌 tagline —— 逐字。12px / `$color-text-sub`。 */
  tagline: '扫码存件，随时取走',
  /** 扫码主按钮 —— 逐字；同时是整颗圆形按钮的 `aria-label`。 */
  scanButton: '扫码存件',
  /** 扫到非柜机码时的提示 —— 逐字；留在首页、可立刻重扫。 */
  notLockerCode: '这不是柜机码，请扫柜机上的二维码',
  /** 扫码失败（取消之外）的提示 —— 逐字；不按成因分叉。 */
  scanFailed: '扫码没成功，请重试',

  /**
   * 订单区占位 —— ⚠️ **过渡期的债**（#20 留下、#67 接手）。
   *
   * 首页的订单区在本票仍是占位；这两句沿用 #20 已登记的占位文案，
   * 让「闸门通了、首页真的渲染出来了」在真机上一眼可见。
   * ⚠️ #67 落地进行中订单区时，这两句**必须一起删除**（届时由订单区的空态取代），
   * 不要在首页继续保留一段「已连接」的开发者台词。
   */
  ordersPlaceholderTitle: DATA_AREA_PLACEHOLDER_TITLE,
  ordersPlaceholderHint: DATA_AREA_PLACEHOLDER_HINT,
} as const

/**
 * **「我的」页的全部用户可见文案** —— spec #57 §9 的逐字表 + 资料编辑弹层。
 *
 * ⚠️ 为什么单列一张表：本页有**四组**互不相干的文案（身份 / 受限 / 信用分 / 两组入口），
 * 外加一个弹层的校验与失败提示。散在页面 `data`、wxml 与提交处理里，改一句要翻三处；
 * 而受限卡的四行是**逐字定稿**（标题 / 正文 / 原因 / 起始时间），
 * 抄错一个标点就是用户拿着它对客服。
 *
 * ⚠️ **手机号、退出登录、账号注销、发票、优惠券都不在这里**，因为它们**不出现**在页面上
 * （spec §9「明确不做」）。一张没有对应界面的文案表，比缺一行更容易骗过 review。
 *
 * ⚠️ 两个模板串（`restrictedReason` / `restrictedSince`）带 `{占位符}`：格式化动作在页面里做。
 * 占位符是**行为记号**，不是用户可见的字；渲染前必须被替换掉。
 */
export const PROFILE_COPY = {
  /** 身份区右侧入口 / 弹层标题 —— 逐字「编辑资料」（同一个动作、同一个词）。 */
  editProfile: '编辑资料',

  /**
   * 昵称为空时的显示名 —— 逐字「微信用户」。
   *
   * ⚠️ 它只是**显示回退**，不是「把昵称写成微信用户」：编辑弹层预填的仍是服务端的
   * 空值，用户不填就保存会被「昵称不能为空」拦住（`13.5` 拒收空串）。
   */
  nicknameFallback: '微信用户',

  /** 受限卡标题 —— 逐字「账号受限」。 */
  restrictedTitle: '账号受限',

  /** 受限卡正文 —— 逐字，**不按成因分叉**（自动 / 人工共用同一段）。 */
  restrictedBody: '暂时不能存件、创建预约或开始使用预约；已有订单仍可正常取件。',

  /** 受限卡原因行 —— 逐字模板「原因：{reason}」；`reason` 为空时整行省略。 */
  restrictedReason: '原因：{reason}',

  /** 受限卡时间行 —— 逐字模板「自 {time} 起」；`time` 用 `formatRestrictionSince` 给出。 */
  restrictedSince: '自 {time} 起',

  /** 受限卡底部客服出口 —— 逐字「如有疑问，请联系客服」；原生 `open-type="contact"`。 */
  restrictedContact: '如有疑问，请联系客服',

  /** 信用分卡标题 —— 逐字「信用分」。 */
  creditTitle: '信用分',

  /** 信用分卡右侧入口 —— 逐字「明细」。 */
  creditDetail: '明细',

  /** 分组标题一 —— 逐字「我的服务」。 */
  servicesTitle: '我的服务',

  /** 分组标题二 —— 逐字「帮助与支持」。 */
  helpTitle: '帮助与支持',

  /** 「我的服务」里唯一一行 —— 逐字「我的预约」。 */
  reservations: '我的预约',

  /** 弹层里的字段标签 —— 逐字「昵称」。 */
  nicknameLabel: '昵称',

  /** 弹层主按钮 —— 逐字「保存」。 */
  save: '保存',

  /** 弹层次按钮 —— 逐字「取消」。 */
  cancel: '取消',

  /** 昵称校验：trim 后为空 —— 逐字「昵称不能为空」。 */
  nicknameEmpty: '昵称不能为空',

  /** 昵称校验：trim 后超过 64 字符 —— 逐字「昵称最多 64 个字符」。 */
  nicknameTooLong: '昵称最多 64 个字符',

  /** 保存失败 —— 逐字「保存失败，请重试」，留在弹层内一行。 */
  saveFailed: '保存失败，请重试',

  /**
   * 块内读取失败 —— 全站共用句（`LOAD_FAILED_DETAIL`），不在这里另造一句。
   *
   * ⚠️ 身份区与信用分**各自**显示这一行：同一次请求失败，但两块各自表述自己的失败，
   * 不让整页塌成一张失败页。
   */
  blockLoadFailed: LOAD_FAILED_DETAIL,
} as const

/**
 * **导航栏**的固定出口文案 —— `navigation-bar` 组件内部使用。
 *
 * ⚠️ 这三句与页面标题不同：它们是**动作 / 出口**的名字，不是页面名。
 * `home` 是栈深 1 时的「首页」出口；`orders` 是「我的订单」出口；`back` 只给
 * 读屏软件（视觉上是返回箭头，没有文字）。三个词都归文案层 —— 组件里不写字面量。
 *
 * ⚠️ `orders` 与 `LOCKER_PAGE_COPY.myOrders` 是**同一句逐字文案**（同一个动作，
 * 全局只有一个名字）。这里单列一份是因为 `navigation-bar` 是**全站**组件，
 * 不该反向依赖柜机页的文案表；两处取值相等由本文件自己保证。
 */
export const NAVIGATION_COPY = {
  home: '首页',
  orders: '我的订单',
  back: '返回',
} as const

/**
 * **确认弹窗的默认按钮** —— 反馈适配层（`utils/feedback.ts`）的兜底文案。
 *
 * ⚠️ 页面有更具体的动作词时（「确认存件」「取消订单」「开始使用」），必须由页面
 * 从 `copy.ts` 传入；这里只兜底最中性的两个词，避免 Vant 默认值成为第二文案源。
 * 确认弹窗的标题 / 说明句永远由调用方传入（不同动作的后果不同，不能有默认值）。
 */
export const CONFIRM_COPY = {
  confirm: '确认',
  cancel: '取消',
} as const

/** 空态文案的形状 —— 键见 `EMPTY_STATES`。 */
export type EmptyStateCopy = (typeof EMPTY_STATES)[keyof typeof EMPTY_STATES]

/**
 * 各页自绘导航栏的**标题** —— 一个页面一个，键 = `app.json` 里注册的 `pages` 路径。
 *
 * ⚠️ **为什么标题也要进文案层**（而不是在 wxml 里写 `title="计费说明"`）：
 * 它是**用户可见的字**，而用户可见的每一个字都归文案层。
 * `test/startup/conventions.test.ts` 有一条守卫从本文件**反推**用户可见文案，
 * 任何一句以字面量出现在别处都会被判违规 —— 它在本票的第一版**确实抓到了**
 * 空壳页里写死的「计费说明」/「常见问题」（那两句恰好也是 `STATIC_EXITS` 的 label）。
 * 守卫是对的：这两个词在「静态出口」与「页面标题」两处出现，
 * 若不并到一处，改一处漏一处的那天就是两条路分叉的那天（与 `STATIC_EXITS` 同一理由）。
 *
 * ⚠️ 本表的取值**多数尚未定稿** —— 它们随各页面票一起收敛：
 *   • `pages/index/index` → 「首页」（逐字；#61 起首页不再承载订单列表，
 *     导航栏本身标题留空，见 spec §2）
 *   • `pages/profile/profile` → 「我的」（tabBar 逐字）
 *   • `pages/billing-info/billing-info` / `pages/faq/faq` → 复用 `STATIC_EXITS` 的措辞（同一份内容）
 *   • 其余为**页面清单里的归属名**，属过渡措辞 —— 页面票拿到定稿后，改这里一处即可。
 * 把这些**集中**在本表，正是为了让那次修正只发生在一个地方。
 */
export const PAGE_TITLES = {
  'pages/index/index': '首页',
  'pages/profile/profile': '我的',
  'pages/locker/locker': '储物柜',
  'pages/order-detail/order-detail': '订单详情',
  'pages/waiting/waiting': '等待关门',
  'pages/reservation-list/reservation-list': '我的预约',
  'pages/reservation-create/reservation-create': '预约存件',
  'pages/score-logs/score-logs': '信用分明细',
  'pages/billing-info/billing-info': '计费说明',
  'pages/faq/faq': '常见问题',
} as const satisfies Record<string, string>

/** `app.json` 里注册的页面路径 —— `PAGE_TITLES` 的键。 */
export type PagePath = keyof typeof PAGE_TITLES

/**
 * 订单列表（= 首页）的页面路径 —— **`wx.switchTab` 的目标**。
 *
 * 设计要求：柜机页顶部固定一个「我的订单」出口，**走 `wx.switchTab` 到订单 tab**。
 * 而柜机页是**冷启动、栈深 1 的非 tab 页**（通道 A：系统返回 = 直接退回微信、
 * 底部 tabBar 不显示）⇒ 这是屏幕上**唯一**通往订单列表的可见路径。
 *
 * ⚠️ **为什么不就地在 `navigation-bar` 里写 `'/pages/index/index'` 字面量**：
 * `wx.switchTab` 的 url **必须**是 `app.json` 的 `tabBar.list[].pagePath` 之一，
 * 差一个字符就是**静默失败**（不跳转、不报错、按钮继续点不动 —— 与它要修的那个死按钮
 * 是同一个症状）。那个路径在 `app.json`（原生配置，引不到 TS）、`PAGE_TITLES` 的键
 * 与调用点三处各有一份。集中到这里，`test/startup/conventions.test.ts` 有一条守卫
 * 读 `app.json` 断言本常量**确实是 tabBar 的一项** —— 那次比对是唯一的兜底。
 */
export const ORDER_LIST_PATH: PagePath = 'pages/index/index'

/**
 * **订单状态标签** —— 订单列表与订单详情共用的一张表（spec §6「状态标签」）。
 *
 * ⚠️ **九个标签逐字定稿，一个都不能改**：列表卡与详情页的状态摘要必须说同一句话。
 * 后端枚举名不上屏（「强制结束」只存在于管理端）；`4` 闭单不写「已超时」。
 *
 * ⚠️ 键是**状态语义**，不是后端数字码。数字码 → 语义的判定（`startAt` / `endAt`
 * 参与）只有一处：`utils/order-status.ts`。这样列表与详情不会各写一遍
 * 「`4` 且 `endAt` 有值算超时结束」这种分叉。
 *
 * ⚠️ 色档不在这张表里 —— 它是样式决策，与文案同住在 `utils/order-status.ts`
 * （`ok` / `warn` / `muted` 直接对应 `tone-chip` 的三个档）。
 */
export const ORDER_STATUS_LABELS = {
  pendingPayment: '待支付',
  waitingDrop: '待存入',
  stored: '已存入',
  timeout: '已超时',
  timeoutEnd: '超时结束',
  completed: '已完成',
  ended: '已结束',
  refunded: '已退款',
  cancelled: '已取消',
} as const

/** 状态语义键 —— `ORDER_STATUS_LABELS` 的键。 */
export type OrderStatusKey = keyof typeof ORDER_STATUS_LABELS

/**
 * 订单时间行的「存入」前缀 —— 列表在途行与详情时间轴的 `OPENED` 是**同一个词**。
 *
 * ⚠️ 它不是新文案，而是那个词唯一的家：`utils/datetime.ts` 的
 * `formatOrderTimeInProgress()` 与 `ORDER_COPY.timeline.OPENED` 都从这里取。
 * 两处各写一个「存入」时，文案守卫会把 `datetime.ts` 里的字面量判成违规 ——
 * 那不是误报，它正是「同一个词有两个家」的证据。
 */
export const STORED_TIME_PREFIX = '存入'

/**
 * 订单列表「未存入」行的时间位文案 —— 逐字「关好柜门才算存入」。
 *
 * ⚠️ 它原本写在 `utils/datetime.ts` 的 `formatNotYetStored()` 里。`#64` 把
 * 「存入」收进文案层（时间轴 `OPENED` 与列表前缀共用）之后，这条守卫第一次
 * 照到了它：那句话里含「存入」，却不在 `copy.ts` —— 正是「同一个词两个家」。
 * ⇒ 它从此归文案层，`datetime.ts` 只负责按状态选函数。
 */
export const NOT_YET_STORED_HINT = '关好柜门才算存入'

/**
 * **取消未开门订单**的文案 —— 等待页与订单详情页**同一套**（spec §4 / §7）。
 *
 * ⚠️ 同一个动作在全局只能有一个名字：两页各自写一份「取消这单？」「再想想」
 * 就是两套文案的开始，而这两页取消的是**同一件事**（`13.10`）。
 * 等待页的取消字段直接引用本表，详情页也引用本表 —— 改一处两页一起变。
 *
 * ⚠️ `rejected` 是契约逐字（`13.10` 的 `3002`）：
 * 「柜门已开启，请放入物品后关门，或联系客服」。
 */
export const ORDER_CANCEL_COPY = {
  title: '取消这单？',
  message: '取消后格口会释放，不会产生费用。',
  dismiss: '再想想',
  action: '取消订单',
  success: '订单已取消',
  rejected: '柜门已开启，请放入物品后关门，或联系客服',
} as const

/**
 * 通用的「没收到结果」提示 —— 取消订单（详情页）与重新开门（等待页）失败共用。
 *
 * ⚠️ 两处说的都是同一件事：**请求发出去了，但没拿到结果**，所以既不能承诺动作发生、
 * 也不能说成「失败」。同一句话不各写一份，改一处两处一起变。
 */
export const NO_RESULT_COPY = '没收到结果，请稍后重试'

/**
 * **柜机页**的全部文案 —— 动作词表、失败与重试表，以及柜机页专有文案。
 *
 * ⚠️ **本表没有任何自编字符串**：票面验收逐字要求「文案逐条有据可查，
 * **无自编字符串**」。因此每一项的注释里都写明了依据，
 * **改这里的任何一个字都必须先确认定稿口径**。
 *
 * ⚠️ 为什么集中成一张表而不是散在页面与 wxml 里：与 `FAILURE_*` / `EMPTY_STATES`
 * 同一条纪律（用户可见的每一个字都归文案层）。页面上有
 * **四种非正常进入**、每种都有标题 + 说明 + 出口，散着写必然出现同一句话的两个版本。
 */
export const LOCKER_PAGE_COPY = {
  /**
   * 四档中文档名 —— **数字码 ↔ 中文名的唯一取值来源**。
   *
   * ⚠️⚠️ 键是后端的**数字码**（`13.7` 请求体 `cellType: 1|2|3|4`），不是字符串枚举。
   * 旧三档的 `SMALL` / `MEDIUM` / `LARGE` 已按 spec §3 删除：后端契约里
   * 格口类型就是数字码，`13.6` 的 `cellAvailability` 阶名只是另一套小写键。
   * 三者的对应关系收在柜机页的 `CELL_TYPES` 一张表里 —— 本表只负责
   * 「数字码 → 用户看到的字」，不承担余位键映射。
   *
   * 定稿原文：小格口 / 中格口 / 大格口 / 特大格口。
   */
  cellTypeLabels: {
    1: '小格口',
    2: '中格口',
    3: '大格口',
    4: '特大格口',
  },

  /**
   * 余位文案 —— **逐字**「余 N 个」。
   *
   * ⚠️ 这里是 `{count}` 模板而不是拼好的字符串：格口卡与底栏两处都要显示余位，
   * 各写一遍 `'余 ' + n + ' 个'` 就会在两处产生两种空格 / 标点。
   * 模板只有一个家，格式化动作在页面 / 组件里做。
   */
  remaining: '余 {count} 个',

  /** 售罄卡内的状态字 —— **逐字**「已满」。 */
  soldOut: '已满',

  /** 柜机离线时卡内的状态字 —— **逐字**「不可用」。 */
  unavailable: '不可用',

  /** 站点信息区的离线 pill —— **逐字**「离线」。 */
  offlinePill: '离线',

  /** 未选中底栏第一行 —— **逐字**「请选择格口」。 */
  chooseCell: '请选择格口',

  /** 未选中底栏第二行 —— **逐字**「四档均可存」。 */
  allCellsAvailable: '四档均可存',

  /** 选中底栏第一行 —— 逐字形态「已选 {档名}」。 */
  selectedCell: '已选 {label}',

  /** 主 CTA —— **逐字**「立即存件」。 */
  cta: '立即存件',

  /** 确认弹层标题 —— **逐字**「确认存件」。 */
  confirmTitle: '确认存件',

  /** 确认弹层里站点一行的标签（弹层要展示站点 / 档位 / 余位）。 */
  confirmSiteLabel: '站点',

  /** 确认弹层里档位一行的标签。 */
  confirmCellLabel: '档位',

  /** 确认弹层里余位一行的标签。 */
  confirmRemainingLabel: '余位',

  /** 确认按钮 —— **逐字**「确认存件」。 */
  confirmAction: '确认存件',

  /** 取消按钮 —— **逐字**「取消」。 */
  cancel: '取消',

  /** 提交中 —— **逐字**「正在下单…」。 */
  submitting: '正在下单…',

  /** 提交失败 —— **逐字**「下单失败，请重试」。 */
  submitFailed: '下单失败，请重试',

  /** 加载中底栏第一行 —— **逐字**「正在获取柜机信息」。 */
  loadingBarTitle: '正在获取柜机信息',

  /** 加载中底栏第二行 —— **逐字**「请稍候」。 */
  loadingBarHint: '请稍候',

  /** 加载失败底栏第一行 —— **逐字**「柜机信息未加载」。 */
  loadFailedBarTitle: '柜机信息未加载',

  /** 加载失败底栏第二行 —— **逐字**「重试后再选择格口」。 */
  loadFailedBarHint: '重试后再选择格口',

  /**
   * `13.6` **加载失败**（非 `1002`）的页内说明 —— 与全站共用同一句
   * （`LOAD_FAILED_DETAIL`），柜机页与内容页不各写一份。
   */
  loadFailedDetail: LOAD_FAILED_DETAIL,

  /** 四档全满时的底栏第一行 —— **逐字**「暂无可存格口」。 */
  allSoldOutBarTitle: '暂无可存格口',

  /** 四档全满时的底栏第二行 —— **逐字**「可以换一台柜机」。 */
  allSoldOutBarHint: '可以换一台柜机',

  /** 预约入口在四档全满时的置灰原因 —— **逐字**「暂无可存格口」。 */
  allSoldOutReserveReason: '暂无可存格口',

  /** 柜机离线时的底栏第一行 —— **逐字**「柜机暂不可用」。 */
  offlineBarTitle: '柜机暂不可用',

  /** 柜机离线时的底栏第二行 —— **逐字**「可以换一台或稍后再试」。 */
  offlineBarHint: '可以换一台或稍后再试',

  /**
   * 柜机不可用的置灰原因 —— **逐字**，同时是 `13.7` → `4004` 的就地解释。
   *
   * ⚠️⚠️ **它是「正常响应」的呈现，不是错误**：`online = false` 是服务端
   * 明确回显的正常数据。⇒ 它**必须是页面内的一行说明**，不得做成弹窗 / toast。
   */
  lockerUnavailableReason: '这台柜机暂时不可用，可以换一台或稍后再试',

  /**
   * 某档余位为 0 的原因 —— **逐字**「该规格已满」。
   *
   * 同时是 `13.7` → `8002` 的就地解释（服务端的准入失败与页面上的置灰原因
   * 说的是同一件事，两处措辞必须一致）。
   */
  cellTypeFullReason: '该规格已满',

  /** 事实行一 —— **逐字**「具体格口由柜机分配」。 */
  factCellAssigned: '具体格口由柜机分配',

  /** 事实行二 —— **逐字**「费用在取件时结算，现在不用付款」。 */
  factPaymentLater: '费用在取件时结算，现在不用付款',

  /**
   * 预约入口 —— **逐字**「预约」。
   *
   * 它是**预约创建的唯一切入点**：`lockerId` 的唯一来源是本页的 `13.6`。
   */
  reserve: '预约',

  /** 入口失效页的「我的订单」出口 —— 与导航栏同一句（同一个动作）。 */
  myOrders: '我的订单',

  /** 入口失效页的「重新扫码」出口 —— **逐字**。 */
  rescan: '重新扫码',

  /** 入口失效页标题 —— **逐字**「这个码没用」。 */
  unusableCodeTitle: '这个码没用',

  /** 入口失效页说明 —— 提案，明确用户的动作而不是机制。 */
  unusableCodeDetail: '请用微信扫柜机上的二维码',

  /** `13.6` → `1002` 的标题 —— **逐字**「这个码可能来自旧贴纸」。 */
  staleStickerTitle: '这个码可能来自旧贴纸',

  /** `13.6` → `1002` 的说明 —— **逐字**。 */
  staleStickerDetail: '柜机码已经找不到了，可以扫柜机上现在的码，或联系客服',
} as const

// ⚠️ 这里原来还有一个 `cellAvailabilitySeparator: ''` —— 一个**从未被引用过的空串**，
// 带 10 行解释它「为什么是空的」。review 按「找不到契约依据的字段不写」这条纪律
// （「宁可缺，不可编」）判它违规，已删。
//
// 这条值得记一笔，因为它是一种**很会伪装的** Speculative Generality：那段注释读起来
// 像是在**遵守**同一条纪律（「不写一个字面量」），实际做的却是它的**反面** ——
// 为一个契约根本没提的位置造了一个字段，并给它编了一套理由。
// ⇒ 「查不到出处就不写」的正确落地是**不写**，不是**写一个空的并解释它为什么空**。
// 版面分隔符本来就不需要是个常量：需要时在 wxml 里排就是了。

/**
 * **预约状态标签** —— 预约列表的五种显示态（spec #57 §10）。
 *
 * ⚠️ **五个标签逐字定稿，一个都不能改**：`PENDING` 待使用 / `USED` 已使用 /
 * `CANCELLED` 已取消 / `NOSHOW` 已爽约 / `EXPIRED` 已失效。
 *
 * ⚠️ 键是**状态语义**，不是后端数字码 —— 数字码 → 语义的唯一判定在
 * `utils/reservation-status.ts`。这样列表与将来的任何消费方不会各写一遍
 * 「`1` 是待使用」这种映射。
 *
 * ⚠️ 色档不在这张表里：`PENDING` 正常（ok）/ `NOSHOW` 危险（danger）/
 * 其余中性（muted），与标签同住在 `utils/reservation-status.ts`。
 */
export const RESERVATION_STATUS_LABELS = {
  pending: '待使用',
  used: '已使用',
  cancelled: '已取消',
  noshow: '已爽约',
  expired: '已失效',
} as const

/** 预约状态语义键 —— `RESERVATION_STATUS_LABELS` 的键。 */
export type ReservationStatusKey = keyof typeof RESERVATION_STATUS_LABELS

/**
 * **我的预约页**的全部用户可见文案 —— spec #57 §10。
 *
 * ⚠️ 两个二次确认是**逐字定稿**：标题 / 说明 / 两个按钮都必须与 spec 一致。
 * 说明句里「预约不可恢复」是事实（`13.15` 转单不可逆、`13.14` 释放格口后不可回退），
 * 不是吓唬话术。
 *
 * ⚠️ `windowRejected` 是 `6202`（窗口外 / 状态已变）在**动作点**的唯一说法：
 * **不写分钟数、不置灰、不倒计时**。使用窗口的两个端点（`holdMinutes` /
 * `noShowMinutes`）不在 C 端契约里，客户端算不出来 —— 任何「还有 N 分钟」都是编的。
 *
 * ⚠️ 爽约与失效**分开讲**：`NOSHOW` 是用户没去（已扣信用分），`EXPIRED` 是柜机故障
 * （不扣信用分）。两者混用会让用户去查一个根本没被扣过的信用分，或者以为自己爽约了。
 *
 * ⚠️ 本表**没有预约单号 / 订单 ID / 分钟数 / 扣分数**：这些要么对用户无意义，
 * 要么 C 端根本拿不到。
 */
export const RESERVATION_LIST_COPY = {
  /** 分组标题一 —— 逐字「待使用」（与状态标签同一个词，引用它）。 */
  groupPending: RESERVATION_STATUS_LABELS.pending,
  /** 分组标题二 —— 逐字「已结束」。 */
  groupEnded: '已结束',
  /** 五种状态标签 —— 与全局表同一份。 */
  statusLabels: RESERVATION_STATUS_LABELS,

  /** 待使用行的主行动 —— 逐字「开始使用」。 */
  startAction: '开始使用',
  /** 待使用行的次行动 —— 逐字「取消预约」。 */
  cancelAction: '取消预约',
  /** 已使用且有订单时的入口 —— 逐字「查看订单」。 */
  viewOrderAction: '查看订单',

  /** 开始使用二次确认 · 标题 —— 逐字。 */
  startTitle: '开始使用？',
  /** 开始使用二次确认 · 说明 —— 逐字。 */
  startMessage: '开始使用后会生成存件订单，柜门将打开；预约不可恢复。',
  /** 开始使用二次确认 · 取消按钮 —— 逐字「取消」。 */
  startDismiss: CONFIRM_COPY.cancel,
  /** 开始使用二次确认 · 确认按钮 —— 逐字「开始使用」。 */
  startConfirm: '开始使用',

  /** 取消预约二次确认 · 标题 —— 逐字。 */
  cancelTitle: '取消预约？',
  /** 取消预约二次确认 · 说明 —— 逐字。 */
  cancelMessage: '取消后格口会被释放，预约不可恢复。',
  /** 取消预约二次确认 · 取消按钮 —— 逐字「再想想」。 */
  cancelDismiss: '再想想',
  /** 取消预约二次确认 · 确认按钮 —— 逐字「取消预约」。 */
  cancelConfirm: '取消预约',

  /**
   * `6202` 的动作点提示 —— 逐字。
   *
   * ⚠️ 只陈述「现在不行、时段前后再试」，不猜窗口端点、不给倒计时。
   */
  windowRejected: '现在还不能开始使用，请在预约时段前后再试',

  /** `NOSHOW` 卡内说明 —— 逐字；用户责任，已扣分。 */
  noshowNote: '爽约，已扣信用分',
  /** `EXPIRED` 卡内说明 —— 逐字；柜机责任，不扣分。 */
  expiredNote: '柜机故障，预约已失效，不扣信用分',

  /** 转单 `4004` —— 格口已分配给这个预约，换不了，只能联系客服。 */
  lockerUnavailable: '预约的柜机暂时不可用，请联系客服',

  /** 页内失败句 —— 全站共用（`LOAD_FAILED_DETAIL`）。 */
  loadFailed: LOAD_FAILED_DETAIL,
  /** 页内重试按钮 —— 全站共用（`RETRY_LABEL`）。 */
  retry: RETRY_LABEL,
  /** 其他动作失败的兜底（服务端没给 message 时）—— 不承诺动作发生过。 */
  actionFailed: NO_RESULT_COPY,
} as const

/**
 * **预约创建页**的全部用户可见文案 —— spec #57 §10（结构级）+ 契约 `13.12`。
 *
 * ⚠️ 本页只让用户回答两个他能答的问题：**什么时候开始** + **要占多久**。
 * 结束时刻由两者相加得出，不让用户面对「结束时刻」这个抽象问题。
 *
 * ⚠️ **下单前不显示金额**：契约 `13.12` 没有价格字段，本表也**没有**
 * 「参考金额 / 预计价格」之类的任何一个字。预订不是下单，费用在取件时结算。
 *
 * ⚠️ `8007` / `8002` 的句子按既有定稿引用；`8006` 是竞态兜底，按服务端
 * `message` 直出（正常路径上档位形态让三条规则都不可触发）。
 */
export const RESERVATION_CREATE_COPY = {
  /** 档位分组标题。 */
  cellTypeSection: '格口档位',
  /** 开始时间分组标题。 */
  startSection: '开始时间',
  /** 使用时长分组标题。 */
  durationSection: '使用时长',

  /** 日期上下文一 —— 逐字「今天」。 */
  today: '今天',
  /** 日期上下文二 —— 逐字「明天」。 */
  tomorrow: '明天',

  /** 今天已过完所有档位时的说明 —— 指路到明天，不编一个不存在的档。 */
  noSlotsToday: '今天没有可预约的时段，请选明天',

  /** 提交按钮 —— 逐字「确定预约」。 */
  submit: '确定预约',
  /** 提交中 —— 逐字「正在预约…」。 */
  submitting: '正在预约…',

  /** 本地校验：三个必选项没选齐。 */
  selectRequired: '请选择格口、开始时间和使用时长',

  /** 入口参数缺失 —— 预约只能从柜机页扫码进入。 */
  invalidEntry: '请从柜机页扫码进入',

  /** 提交失败兜底（网络 / 未知业务码且无 message）。 */
  submitFailed: '预约失败，请重试',

  /** `8002` 无空闲格口 —— 定稿口径：换类型或换柜机。 */
  cellTypeFull: '该类型格口已满，换一种类型或换一台柜机',

  /** `8007` 同时段已有 `PENDING` 预约 —— 逐字定稿。 */
  duplicate: '你在这个时段已经有一个预约了',

  /** `4004` 柜机不可用 —— 与柜机页同一句（同一种处境只有一个名字）。 */
  lockerUnavailable: LOCKER_PAGE_COPY.lockerUnavailableReason,
} as const

/**
 * **等待关门页**的全部用户可见文案 —— spec #57 §4「逐字文案」表。
 *
 * ⚠️ 这张表是**契约逐字**的落点：主陈述、停滞说明、手动核对、取消弹窗、
 * 重新开门、九种终局与金额四词，都只在这里各有一份。页面 `data` 只做转手，
 * wxml 不写任何字面量 —— 这样「同一个动作只有一个名字」在等待页上也成立。
 *
 * ⚠️ **唯一可以说出口的事实是「已发出开门指令」**：`mainStatement` 陈述的是
 * 「我们刚请服务端生成了一条开门指令」，不是「门开了」。任何可达状态都不得出现
 * 「门已开 / 开门成功 / 取件成功 / 已付清」—— 源码守卫会扫描全仓。
 *
 * ⚠️ **终局金额只用两个词**：普通单 `实付`，`TIMEOUT` 单 `已付`。
 * 非终局一律不渲染金额；`estimatedAmount` 在本页没有出场机会。
 * ⚠️ 本表**没有倒计时 / 分钟数 / 指令状态 / 进度条**的任何一个字 —— 不是漏了，
 * 是这些信息在 C 端不可观测，`openTimeoutMinutes` 只接收、不消费。
 */
export const WAITING_PAGE_COPY = {
  /** 主陈述 —— 逐字。等待期唯一能说的事实。 */
  mainStatement: '已发出开门指令',

  /** 存入路径的下一步 —— 逐字。 */
  dropNext: '请放入物品，然后关好柜门',

  /** 取件路径的下一步 —— 逐字。 */
  pickupNext: '请取出物品，然后关好柜门',

  /** 自动更新的说明 —— 逐字（仅轮询仍在进行时出现）。 */
  autoUpdate: '柜门关闭后，页面会自动更新',

  /** 60 秒未终局的停滞说明 —— 逐字。 */
  stalledHint: '如果柜门已经关好，这里可能不会立刻变化；可以稍后在订单里查看',

  /** 手动核对按钮 —— 逐字。 */
  manualCheck: '我关好门了，再核对一次',

  /** 核对进行中 —— 逐字；手动按钮禁用时显示。 */
  checking: '正在核对…',

  /** 手动核对仍无变化 —— 逐字；3 秒后消失，页面保持停滞。 */
  noUpdate: '暂时没有更新，可以稍后在订单里查看',

  /** 连续两次核对失败 —— 逐字；不改主陈述，轮询继续。 */
  networkHint: '网络不太顺，正在重试',

  /** 页面的固定出口 —— 逐字。 */
  backToOrders: '回订单列表',

  /** 存入终局 —— 逐字。 */
  storedTitle: '已存入',

  /** 取件码块的标签 —— 逐字。 */
  pickupCodeLabel: '取件码',

  /** 存入终局的说明 —— 逐字。 */
  storedHint: '取件码已生成，可在订单里随时查看',

  /** 取件终局 —— 逐字。 */
  pickedTitle: '已完成取件',

  /** `TIMEOUT` 单补缴取件后的状态 chip —— 逐字。 */
  timeoutChip: '超时结束',

  /** 普通单终局金额词 —— **实付**（累计实收，已定格）。 */
  paidLabel: '实付',

  /** `TIMEOUT` 单终局金额词 —— **已付**（不得写「已付清」）。 */
  timeoutPaidLabel: '已付',

  /** 取消终局 —— 逐字。 */
  cancelledTitle: '订单已取消',

  /** 取消终局说明 —— 逐字。 */
  cancelledHint: '没有产生费用',

  /** 取消终局的额外出口 —— 逐字（扫到柜机码后替换本页进柜机页）。 */
  rescan: '重新扫码',

  /** 强制结束终局 —— 逐字。 */
  endedTitle: '已结束',

  /** 退款终局 —— 逐字。 */
  refundedTitle: '已退款',

  /** 结束 / 退款终局的说明 —— 逐字。 */
  endedHint: '如有疑问请联系客服',

  /** 订单不存在 / 非本人 / 已删除 —— 统一一句，逐字。 */
  missingTitle: '订单不存在或已删除',

  /** 取消二次确认的标题 —— 引用共享的取消文案（与订单详情页同一套）。 */
  cancelTitle: ORDER_CANCEL_COPY.title,

  /** 取消二次确认的说明 —— 引用共享的取消文案。 */
  cancelMessage: ORDER_CANCEL_COPY.message,

  /** 取消二次确认的取消按钮 —— 引用共享的取消文案（「再想想」，不是中性的「取消」）。 */
  cancelDismiss: ORDER_CANCEL_COPY.dismiss,

  /** 取消二次确认的确认按钮 —— 引用共享的取消文案。 */
  cancelAction: ORDER_CANCEL_COPY.action,

  /** 取消成功轻提示 —— 引用共享的取消文案。 */
  cancelSuccess: ORDER_CANCEL_COPY.success,

  /** 服务端 `3002`（开门指令已回执）—— 契约逐字，引用共享的取消文案。 */
  cancelRejected: ORDER_CANCEL_COPY.rejected,

  /** 取件停滞的重新开门入口 —— 逐字。 */
  reopenLink: '柜门没有反应？重新开门',

  /** 重新开门二次确认的标题 —— 逐字。 */
  reopenTitle: '重新开门？',

  /** 重新开门二次确认的说明 —— 逐字。 */
  reopenMessage: '将再次向柜机发出开门指令，请确认您仍在柜机前。',

  /** 重新开门二次确认的取消按钮 —— 逐字。 */
  reopenCancel: '取消',

  /** 重新开门二次确认的确认按钮 —— 逐字。 */
  reopenAction: '重新开门',

  /** 重新开门成功轻提示 —— 逐字。 */
  reopenSuccess: '已重新发出开门指令',

  /** 重新开门失败轻提示 —— 逐字（没有收到结果，不承诺门开了）。 */
  reopenFailed: NO_RESULT_COPY,
} as const

/**
 * **订单详情页**的全部用户可见文案 —— spec §7「六块」+ §14 金额 / 时间口径。
 *
 * ⚠️ 这里只放**详情页专属**的字：状态标签在 `ORDER_STATUS_LABELS`，取件码标签与
 * 金额四词在 `WAITING_PAGE_COPY`（同一个东西只有一个名字），取消文案在
 * `ORDER_CANCEL_COPY`。本表引用它们，而不是各抄一份。
 *
 * ⚠️ **金额四词**：`referenceLabel` 永远带「参考」；`paidLabel` 是普通单的「实付」；
 * `timeoutPaidLabel` 是 `TIMEOUT` 单的「已付」；`paymentLabel` 只用于支付记录。
 * 详情页不写「应付 / 预估价 / 锁定价 / 已付清 / 还需支付」。
 *
 * ⚠️ **时间轴只消费事件码**：`timeline` 把 `13.9` 的六个 `event` 值翻成本地文案，
 * 后端下发的 `title` 一律不上屏（那是第二文案源）。`FINISHED` 与 `FORCE_ENDED`
 * 在这里都是「结束」—— 后端枚举的差别对用户没有意义。
 */
export const ORDER_COPY = {
  /** 取件码标签 —— 与等待页同一个词（同一个东西只有一个名字）。 */
  pickupCodeLabel: WAITING_PAGE_COPY.pickupCodeLabel,

  /** 未支付 / `TIMEOUT` 未取件时的金额词 —— **永远带「参考」**。 */
  referenceLabel: '参考金额',

  /** 未支付时唯一的一句说明 —— 不必自己算，也不必说「还需支付」。 */
  referenceNote: '以取件支付时服务端计算为准',

  /** 已支付明细的三行标签。 */
  baseFeeLabel: '基础费',
  overtimeFeeLabel: '超时费',
  discountLabel: '优惠',

  /** 普通单的累计实收词。 */
  paidLabel: WAITING_PAGE_COPY.paidLabel,

  /** `TIMEOUT` 单的累计实收词（不得写「已付清」）。 */
  timeoutPaidLabel: WAITING_PAGE_COPY.timeoutPaidLabel,

  /** 支付记录每行的金额词 —— 只出现在详情页（首次支付成功态用同一个词）。 */
  paymentLabel: '本次支付',

  /** 柜机信息的两行标签。 */
  lockerNoLabel: '柜机码',
  cellLabel: '格口',

  /** 待存入的主行动 —— 回等待页继续等关门。 */
  continueWaiting: '继续等待关门',

  /** 历史单底部的次级出口 —— 与首页同一个动作，沿用首页的叫法。 */
  scanEntry: HOME_PAGE_COPY.scanButton,

  /** 订单不存在 / 非本人 / 已删除 —— 与等待页统一一句，不区分成因。 */
  missingTitle: WAITING_PAGE_COPY.missingTitle,

  /** 缺失 / 失败出口的动作词。 */
  backToOrders: WAITING_PAGE_COPY.backToOrders,
  loadFailed: LOAD_FAILED_DETAIL,
  retry: RETRY_LABEL,

  /** 取消的通用失败（非 `3002`）—— 「没收到结果」不承诺动作发生过。 */
  cancelFailed: NO_RESULT_COPY,

  /** 时间轴事件码 → 本地文案（六码，逐字）。 */
  timeline: {
    CREATED: '下单',
    OPENED: STORED_TIME_PREFIX,
    FINISHED: '结束',
    CANCELLED: '取消',
    FORCE_ENDED: '结束',
    REFUNDED: '退款',
  },
} as const

/**
 * **支付取件确认层**（共享 `pickup-sheet`）的全部用户可见文案 —— spec #57 §5。
 *
 * ⚠️ 取件层是**弹层，不是支付页**：这里只有「确认取件」这一件事的字。
 * 金额四词与状态标签从既有表引用（同一个东西只有一个名字），本表只补
 * 取件层专属的三条说明句、三态成功文案与五类失败归因。
 *
 * ⚠️ **逐字定稿**（spec §5 表）：首笔参考金额说明、幂等重开说明、超时补缴说明、
 * 成功副行「柜门关闭后，订单才会结束」、失败五句 —— 改一个字都要先改 spec。
 *
 * ⚠️ 本表**没有订单号 / 支付单号 / 渠道 / 手机号**，也没有「门已开 / 开门成功 /
 * 取件成功 / 已付清 / 应付 / 预估价 / 锁定价」—— 全站禁用词守卫会扫描最终源码。
 */
export const PICKUP_SHEET_COPY = {
  /** 参考金额 —— 永远带「参考」，引用详情页同一个词。 */
  referenceLabel: ORDER_COPY.referenceLabel,

  /** 普通单已支付（幂等重开）的金额词 —— 实付。 */
  actualPaidLabel: ORDER_COPY.paidLabel,

  /** `TIMEOUT` 单的累计已付金额词 —— 已付（不得写「已付清」）。 */
  paidLabel: ORDER_COPY.timeoutPaidLabel,

  /** 首次支付分支的说明句 —— 逐字。 */
  firstNote: '参考金额不是最终金额，实际以支付时服务端计算为准',

  /** 幂等重开分支的说明句 —— 逐字。 */
  reopenNote: '无需再次支付，确认后会重新开门',

  /** 超时补缴分支的说明句 —— 逐字。 */
  topUpNote: '超时订单需补缴差额，金额以支付时服务端计算为准',

  /** 首次支付 / 幂等重开的主按钮 —— 逐字。 */
  pickupAction: '取件开门',

  /** 超时补缴的主按钮 —— 逐字。 */
  topUpAction: '补缴并开门',

  /** 支付进行中 —— 逐字；主按钮不可再点，遮罩不可关。 */
  paying: '支付中…',

  /** 成功态标题（首次支付 / 超时补缴）—— 逐字。 */
  successTitle: '支付成功',

  /** 成功态标题（幂等重开）—— 逐字。它只是「指令已发出」，不是「门开了」。 */
  reopenSuccessTitle: '已发出开门指令',

  /** 成功态的金额词 —— 只给首次支付用（引用详情页同一个词）。 */
  successAmountLabel: ORDER_COPY.paymentLabel,

  /** 成功态副行 —— 三态统一，逐字。 */
  successHint: '柜门关闭后，订单才会结束',

  /** 成功态唯一出口 —— 逐字；必须由用户点，不自动跳转。 */
  know: '知道了',

  /** 网络不确定时的核对态 —— 逐字。 */
  reconciling: '正在核对支付结果…',

  /** `3002` —— 逐字；关闭并刷新来源页。 */
  stateChanged: '订单状态已变化，请返回订单刷新',

  /** `6001` —— 逐字；停留，可重试。 */
  feeUnavailable: '暂时无法计算费用，请联系客服',

  /** `3001` / `8003` —— 与订单页统一一句，逐字；关闭且来源页回列表。 */
  missing: ORDER_COPY.missingTitle,

  /** 其他业务码且服务端没给 message 时的兜底 —— 逐字；停留，可重试。 */
  fallback: '请稍后重试',

  /** 网络核对后确认没有支付 —— 逐字；停留，可重试。 */
  noPayment: '没有查询到支付结果，请重试',
} as const
