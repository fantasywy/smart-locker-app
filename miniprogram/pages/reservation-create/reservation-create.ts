// **预约创建页（结构级）** —— 从柜机页「预约」进来，带 `lockerId`（spec #57 §10 / `13.12`）。
//
// ## 这一页只问契约里的两个时刻
//
// 用户直接给出**开始时间**与**结束时间** —— 这正是 `13.12` 的两个字段
// （`planStartAt` / `planEndAt`），页面不发明第三个概念。
//
// ⚠️ 早先那版让用户选「30 分钟一档的开始档位」+「1 / 2 / 4 / 8 小时的时长档位」，
// 两者都不在 `13.12` 里，是**编出来的业务选择**（spec §10 逐字：「表单字段与校验
// 严格按 `13.12` 契约」）。现在改成两个原生 `<picker mode="time">`，并把
// `end > start`、`start > now` 两条校验留在本地 —— 于是服务端 `8006` 的三条规则
// （结束不晚于开始 / 超 `maxHours` / 开始已过）在 UI 层不可触发，`8006` 只作竞态兜底。
//
// ## 时区口径（硬约束）
//
// 请求体用**无偏移本地 ISO**（`2026-09-22T15:00:00`，后端 `LocalDateTime`）；
// 响应才带 `+08:00`。契约示例里的 `+08:00` 是文档漂移，照抄会让后端解析失败。
// ⇒ 页面把「日期（今天 / 明天）+ `HH:mm`」拼成无偏移本地 ISO；这一层是**请求口径**，
// 不是展示口径（展示时间的唯一实现是 `utils/datetime.ts`，本页一个格式都不写）。
//
// ## 三条硬约束
//
// 1. **下单前不显示金额。** `13.12` 没有价格字段；本页也没有任何金额 / 预计价格的位置。
// 2. **提交中防重复。** `13.12` 不幂等；`submitting` 是技术性防抖，只由请求飞行态驱动。
// 3. **唯一入口。** 没有 `lockerId` 就拒绝提交（预约创建只能从柜机页扫码进入）。
//
// ⚠️ 页面不读写 storage、不缓存任何业务数据；文案全部来自 `startup/copy.ts`。

import { createReservation } from '../../api/reservations'
import type { CellType } from '../../types/orders'
import {
  LOCKER_PAGE_COPY,
  PAGE_TITLES,
  PROFILE_COPY,
  RESERVATION_CREATE_COPY,
} from '../../startup/copy'
import { RESERVATION_LIST_PATH } from '../../utils/routes'

/** 四个格口档位 —— 数字码 1–4（与 `13.12` 的 `cellType` 同一值域）。 */
const CELL_TYPES: readonly CellType[] = [1, 2, 3, 4]

/** `HH:mm` —— 原生 `<picker mode="time">` 交出来的形态。 */
const TIME_PATTERN = /^(\d{2}):(\d{2})$/

/** `13.12` 柜机不可用（契约 §13.12）。 */
const LOCKER_UNAVAILABLE = 4004

/** `13.12` 该档位无空闲格口（契约 §13.12）。 */
const CELL_TYPE_FULL = 8002

/** `13.12` 同时段已有 `PENDING` 预约（契约 §13.12）。 */
const DUPLICATE_RESERVATION = 8007

/**
 * 提交失败的最小形状 —— 页面**不认识**请求层类型（`pages/` 不得直接 import `request/`）。
 * 只声明归因真正读的三个字段；来源仍是 `RequestResult.error`。
 */
interface ActionFailure {
  code: number | null
  kind: string
  message: string | null
}

interface ReservationCreateData {
  title: string
  /** 是否有合法的 `lockerId`；false 时整张表单换成一句入口提示。 */
  invalidEntry: boolean
  entryHint: string

  cellTypeSection: string
  startSection: string
  endSection: string
  pickTime: string

  cellTypeOptions: { value: CellType; label: string }[]
  selectedCellType: CellType | 0

  dateOptions: { value: number; label: string }[]
  selectedDate: number

  /** 两个时刻都是 `HH:mm`；空串 = 还没选（占位显示 `pickTime`）。 */
  startTime: string
  endTime: string

  submitLabel: string
  submittingLabel: string
  submitting: boolean
  /** 动作点就地解释（含本地校验与服务端失败）；空串 = 不显示。 */
  submitError: string
}

interface ReservationCreateInstance {
  data: ReservationCreateData
  setData(patch: Partial<ReservationCreateData>): void
}

/** 页面会话的私有运行时 —— `lockerId` 与飞行态不进 `data`。 */
interface ReservationCreateRuntime {
  lockerId: number | null
  submitting: boolean
}

const runtimes = new WeakMap<ReservationCreateInstance, ReservationCreateRuntime>()

function runtimeOf(page: ReservationCreateInstance): ReservationCreateRuntime {
  let runtime = runtimes.get(page)
  if (runtime === undefined) {
    runtime = { lockerId: null, submitting: false }
    runtimes.set(page, runtime)
  }
  return runtime
}

/** 两位补零 —— 本地 ISO 的固定宽度。 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * `Date` → **无偏移本地 ISO**（`YYYY-MM-DDTHH:mm:00`）。
 *
 * ⚠️ 这是**请求**口径，不是展示口径。展示时间的唯一实现是 `utils/datetime.ts`；
 * 本函数只服务于「把用户选的时刻变成契约字段」这一件事。
 */
function localIsoOf(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:00`
}

/**
 * 「日期上下文（今天 / 明天）+ `HH:mm`」→ **无偏移本地 ISO**。
 *
 * 用 `Date` 构造而不是字符串拼接：跨月 / 跨年时 `getDate() + 1` 由平台自己进位，
 * 手拼会造出一个不存在的日期（`2026-12-32`）。非法时刻返回 `null`，由调用方拦下。
 */
function instantOf(now: Date, dayOffset: number, time: string): string | null {
  const matched = TIME_PATTERN.exec(time)
  if (matched === null) return null
  const hours = Number(matched[1])
  const minutes = Number(matched[2])
  if (hours > 23 || minutes > 59) return null
  return localIsoOf(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hours, minutes, 0, 0),
  )
}

/** 从事件 dataset 里取数字 —— 模板事件不可信，非法值直接忽略。 */
function numberOf(event: { currentTarget: { dataset: Record<string, unknown> } }): number | null {
  const raw = event.currentTarget.dataset['value']
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) ? value : null
}

/** 从 `<picker mode="time">` 的 change 事件里取 `HH:mm`。 */
function pickedTime(event: { detail?: { value?: unknown } }): string | null {
  const raw = event.detail?.value
  if (typeof raw !== 'string' || TIME_PATTERN.exec(raw) === null) return null
  return raw
}

/** 失败归因 —— 已知码说人话；`8006` 等按服务端 message 直出；最后兜底。 */
function failureTextOf(error: ActionFailure): string {
  if (error.kind === 'restricted') return PROFILE_COPY.restrictedBody
  if (error.code === LOCKER_UNAVAILABLE) return RESERVATION_CREATE_COPY.lockerUnavailable
  if (error.code === CELL_TYPE_FULL) return RESERVATION_CREATE_COPY.cellTypeFull
  if (error.code === DUPLICATE_RESERVATION) return RESERVATION_CREATE_COPY.duplicate
  if (error.message !== null && error.message !== '') return error.message
  return RESERVATION_CREATE_COPY.submitFailed
}

type ValidationResult =
  | { ok: false; message: string }
  | { ok: true; planStartAt: string; planEndAt: string }

/**
 * 本地校验 —— 通过时顺带把两个「日期 + `HH:mm`」拼成契约要的无偏移本地 ISO。
 *
 * ⚠️ 判据只有契约要求的 `end > start`、以及「今天不能选一个已经过去的开始时刻」。
 * 不判上限 / 不判窗口（`maxHours`、使用窗口都在服务端，C 端拿不到那些数字）。
 */
function validate(page: ReservationCreateInstance, now: Date): ValidationResult {
  if (page.data.startTime === '' || page.data.endTime === '') {
    return { ok: false, message: RESERVATION_CREATE_COPY.selectRequired }
  }
  // `HH:mm` 是定宽字符串，字典序即时间序 —— 不需要构造 `Date` 来比大小。
  if (page.data.endTime <= page.data.startTime) {
    return { ok: false, message: RESERVATION_CREATE_COPY.endBeforeStart }
  }

  const planStartAt = instantOf(now, page.data.selectedDate, page.data.startTime)
  const planEndAt = instantOf(now, page.data.selectedDate, page.data.endTime)
  if (planStartAt === null || planEndAt === null) {
    return { ok: false, message: RESERVATION_CREATE_COPY.selectRequired }
  }
  if (planStartAt <= localIsoOf(now)) {
    return { ok: false, message: RESERVATION_CREATE_COPY.startInPast }
  }
  return { ok: true, planStartAt, planEndAt }
}

/**
 * 提交 `13.12`。
 *
 * ⚠️ `submitting` 在**进入请求之前**置位；同一 tick 的第二次点击会在这里被挡掉。
 * 成功后的去向是「我的预约」——`redirectTo` 替换本页，列表页 `onShow` 自己刷新。
 */
async function submit(page: ReservationCreateInstance): Promise<void> {
  const runtime = runtimeOf(page)
  if (runtime.submitting) return

  if (runtime.lockerId === null) {
    page.setData({ invalidEntry: true, entryHint: RESERVATION_CREATE_COPY.invalidEntry })
    return
  }

  // 先收敛档位 —— 收窄之后 `cellType` 就是契约要的数字码（`0` 是「还没选」的哨兵）。
  const cellType = page.data.selectedCellType
  if (cellType === 0) {
    page.setData({ submitError: RESERVATION_CREATE_COPY.selectRequired })
    return
  }

  const checked = validate(page, new Date())
  if (!checked.ok) {
    page.setData({ submitError: checked.message })
    return
  }

  runtime.submitting = true
  page.setData({ submitting: true, submitError: '' })

  const result = await createReservation({
    lockerId: runtime.lockerId,
    cellType,
    planStartAt: checked.planStartAt,
    planEndAt: checked.planEndAt,
  })

  runtime.submitting = false
  page.setData({ submitting: false })

  if (!result.ok) {
    // 失败在动作点就地解释：不清空选择、不跳转、不弹 toast。
    page.setData({ submitError: failureTextOf(result.error) })
    return
  }

  wx.redirectTo({ url: `/${RESERVATION_LIST_PATH}` })
}

interface ReservationCreateMethods {
  [name: string]: (...args: never[]) => unknown
  onLoad(options: Record<string, string | undefined>): void
  onSelectCellType(event: { currentTarget: { dataset: Record<string, unknown> } }): void
  onSelectDate(event: { currentTarget: { dataset: Record<string, unknown> } }): void
  onPickStart(event: { detail?: { value?: unknown } }): void
  onPickEnd(event: { detail?: { value?: unknown } }): void
  onSubmit(): void
}

Component<
  ReservationCreateData,
  Record<string, never>,
  ReservationCreateMethods,
  Record<string, never>,
  true
>({
  data: {
    title: PAGE_TITLES['pages/reservation-create/reservation-create'],
    invalidEntry: false,
    entryHint: RESERVATION_CREATE_COPY.invalidEntry,

    cellTypeSection: RESERVATION_CREATE_COPY.cellTypeSection,
    startSection: RESERVATION_CREATE_COPY.startSection,
    endSection: RESERVATION_CREATE_COPY.endSection,
    pickTime: RESERVATION_CREATE_COPY.pickTime,

    cellTypeOptions: CELL_TYPES.map((type) => ({
      value: type,
      label: LOCKER_PAGE_COPY.cellTypeLabels[type],
    })),
    selectedCellType: 0,

    dateOptions: [
      { value: 0, label: RESERVATION_CREATE_COPY.today },
      { value: 1, label: RESERVATION_CREATE_COPY.tomorrow },
    ],
    selectedDate: 0,

    startTime: '',
    endTime: '',

    submitLabel: RESERVATION_CREATE_COPY.submit,
    submittingLabel: RESERVATION_CREATE_COPY.submitting,
    submitting: false,
    submitError: '',
  } as ReservationCreateData,

  lifetimes: {
    attached(): void {
      // 有意为空 —— 页面参数只在 onLoad 里拿得到。
    },
  },

  methods: {
    /** 进页：收敛 `lockerId`；两个时刻不预填（不替用户编一个「默认时间」）。 */
    onLoad(options: Record<string, string | undefined>): void {
      const page = this as unknown as ReservationCreateInstance
      const runtime = runtimeOf(page)
      const raw = options['lockerId']
      const lockerId = raw === undefined ? Number.NaN : Number(raw)
      if (!Number.isInteger(lockerId) || lockerId <= 0) {
        page.setData({
          invalidEntry: true,
          entryHint: RESERVATION_CREATE_COPY.invalidEntry,
          submitError: RESERVATION_CREATE_COPY.invalidEntry,
        })
        return
      }
      runtime.lockerId = lockerId
      page.setData({ invalidEntry: false })
    },

    /** 选档位（数字码 1–4）。 */
    onSelectCellType(event: { currentTarget: { dataset: Record<string, unknown> } }): void {
      const page = this as unknown as ReservationCreateInstance
      const value = numberOf(event)
      if (value === null) return
      const type = CELL_TYPES.find((candidate) => candidate === value)
      if (type === undefined) return
      page.setData({ selectedCellType: type, submitError: '' })
    },

    /** 切今天 / 明天 —— 两个时刻本身与日期无关，保留用户的选择。 */
    onSelectDate(event: { currentTarget: { dataset: Record<string, unknown> } }): void {
      const page = this as unknown as ReservationCreateInstance
      const value = numberOf(event)
      if (value !== 0 && value !== 1) return
      page.setData({ selectedDate: value, submitError: '' })
    },

    /** 选开始时间 —— 取值来自原生 time picker，不是页面自造的档位表。 */
    onPickStart(event: { detail?: { value?: unknown } }): void {
      const page = this as unknown as ReservationCreateInstance
      const value = pickedTime(event)
      if (value === null) return
      page.setData({ startTime: value, submitError: '' })
    },

    /** 选结束时间 —— 与开始时间是同一次选择的两个端点。 */
    onPickEnd(event: { detail?: { value?: unknown } }): void {
      const page = this as unknown as ReservationCreateInstance
      const value = pickedTime(event)
      if (value === null) return
      page.setData({ endTime: value, submitError: '' })
    },

    /** 提交 —— 本地校验 → `13.12` → 回我的预约。 */
    onSubmit(): void {
      const page = this as unknown as ReservationCreateInstance
      void submit(page)
    },
  },
})
