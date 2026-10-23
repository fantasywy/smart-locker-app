// **预约创建页（结构级）** —— 从柜机页「预约」进来，带 `lockerId`（spec #57 §10 / `13.12`）。
//
// ## 这一页只问两个用户答得上的问题
//
// 「什么时候开始」+「要占多久」。结束时刻由两者相加得出 —— 不让用户面对
// 「结束时刻」这个抽象问题，也让 `8006` 的三条规则在 UI 层不可能被触发：
//   • 时长档恒 > 0 ⇒ `end > start`；
//   • 最长档 8h < `maxHours`(24h)；
//   • 档位只渲染未来 ⇒ `planStartAt > now`。
// 服务端 `8006` 仍按 `message` 直出，作为竞态 / 时钟偏差的兜底。
//
// ## 时区口径（硬约束）
//
// 请求体用**无偏移本地 ISO**（`2026-09-22T15:00:00`，后端 `LocalDateTime`）；
// 响应才带 `+08:00`。契约示例里的 `+08:00` 是文档漂移，照抄会让后端解析失败。
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
import { formatDurationSlot, formatSlotTime } from '../../utils/datetime'
import { RESERVATION_LIST_PATH } from '../../utils/routes'

/** 开始档位步长 —— spec #10：30 分钟。 */
const SLOT_STEP_MINUTES = 30

/** 一天 48 个档位（00:00–23:30）。 */
const SLOTS_PER_DAY = (24 * 60) / SLOT_STEP_MINUTES

/** 时长档位 —— 1 / 2 / 4 / 8 小时（定稿）。 */
const DURATION_HOURS: readonly number[] = [1, 2, 4, 8]

/** 四个格口档位 —— 数字码 1–4（与 `13.12` 的 `cellType` 同一值域）。 */
const CELL_TYPES: readonly CellType[] = [1, 2, 3, 4]

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

/** 一个开始档位。 */
interface SlotOption {
  /** 无偏移本地 ISO —— 直接作为 `planStartAt` 发送。 */
  value: string
  /** `HH:mm`（由 `formatSlotTime` 唯一负责写法）。 */
  label: string
}

/** 一个时长档位。 */
interface DurationOption {
  hours: number
  label: string
}

interface ReservationCreateData {
  title: string
  /** 是否有合法的 `lockerId`；false 时整张表单换成一句入口提示。 */
  invalidEntry: boolean
  entryHint: string

  cellTypeSection: string
  startSection: string
  durationSection: string

  cellTypeOptions: { value: CellType; label: string }[]
  selectedCellType: CellType | 0

  dateOptions: { value: number; label: string }[]
  selectedDate: number

  slotOptions: SlotOption[]
  selectedSlot: string
  emptySlotHint: string
  showEmptySlotHint: boolean

  durationOptions: DurationOption[]
  selectedHours: number

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
 * 本函数只服务于「把用户选的档位变成契约字段」这一件事。
 */
function localIsoOf(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:00`
}

/** 今天 / 明天的档位：步长 30 分钟，今天的只保留严格晚于当前时刻的档。 */
function slotsOf(now: Date, dayOffset: number): SlotOption[] {
  const slots: SlotOption[] = []
  for (let index = 0; index < SLOTS_PER_DAY; index += 1) {
    const start = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + dayOffset,
      Math.floor((index * SLOT_STEP_MINUTES) / 60),
      (index * SLOT_STEP_MINUTES) % 60,
      0,
      0,
    )
    // 「起点至少是当前档位的下一个档」：严格大于 now（恰好等于当前档时也排斥）。
    if (dayOffset === 0 && start.getTime() <= now.getTime()) continue
    const value = localIsoOf(start)
    slots.push({ value, label: formatSlotTime(value) })
  }
  return slots
}

/** 在无偏移本地 ISO 上增加小时数 —— `planEndAt = planStartAt + 时长`。 */
function addHours(start: string, hours: number): string {
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(start)
  if (matched === null) return ''
  const date = new Date(
    Number(matched[1]),
    Number(matched[2]) - 1,
    Number(matched[3]),
    Number(matched[4]),
    Number(matched[5]),
    0,
    0,
  )
  return localIsoOf(new Date(date.getTime() + hours * 60 * 60 * 1000))
}

/** 把开始档位落到页面 —— 切换日期后旧选择必须清掉（不能跨天复用）。 */
function applySlots(page: ReservationCreateInstance, now: Date, dayOffset: number): void {
  const slots = slotsOf(now, dayOffset)
  page.setData({
    selectedDate: dayOffset,
    slotOptions: slots,
    selectedSlot: '',
    showEmptySlotHint: dayOffset === 0 && slots.length === 0,
    emptySlotHint: RESERVATION_CREATE_COPY.noSlotsToday,
  })
}

/** 从事件 dataset 里取数字 —— 模板事件不可信，非法值直接忽略。 */
function numberOf(event: { currentTarget: { dataset: Record<string, unknown> } }): number | null {
  const raw = event.currentTarget.dataset['value']
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) ? value : null
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
  if (
    page.data.selectedCellType === 0 ||
    page.data.selectedSlot === '' ||
    page.data.selectedHours === 0
  ) {
    page.setData({ submitError: RESERVATION_CREATE_COPY.selectRequired })
    return
  }

  const planStartAt = page.data.selectedSlot
  const planEndAt = addHours(planStartAt, page.data.selectedHours)
  runtime.submitting = true
  page.setData({ submitting: true, submitError: '' })

  const result = await createReservation({
    lockerId: runtime.lockerId,
    cellType: page.data.selectedCellType,
    planStartAt,
    planEndAt,
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
  onSelectSlot(event: { currentTarget: { dataset: Record<string, unknown> } }): void
  onSelectDuration(event: { currentTarget: { dataset: Record<string, unknown> } }): void
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
    durationSection: RESERVATION_CREATE_COPY.durationSection,

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

    slotOptions: [],
    selectedSlot: '',
    emptySlotHint: RESERVATION_CREATE_COPY.noSlotsToday,
    showEmptySlotHint: false,

    durationOptions: DURATION_HOURS.map((hours) => ({
      hours,
      label: formatDurationSlot(hours),
    })),
    selectedHours: 0,

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
    /** 进页：收敛 `lockerId`，生成今天的未来档位。 */
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
      applySlots(page, new Date(), 0)
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

    /** 切今天 / 明天 —— 重新生成档位并清空旧选择。 */
    onSelectDate(event: { currentTarget: { dataset: Record<string, unknown> } }): void {
      const page = this as unknown as ReservationCreateInstance
      const value = numberOf(event)
      if (value !== 0 && value !== 1) return
      applySlots(page, new Date(), value)
      page.setData({ submitError: '' })
    },

    /** 选开始档位 —— 只接受当前档位表里的值。 */
    onSelectSlot(event: { currentTarget: { dataset: Record<string, unknown> } }): void {
      const page = this as unknown as ReservationCreateInstance
      const raw = event.currentTarget.dataset['value']
      if (typeof raw !== 'string') return
      if (!page.data.slotOptions.some((slot) => slot.value === raw)) return
      page.setData({ selectedSlot: raw, submitError: '' })
    },

    /** 选时长 —— 只接受 1 / 2 / 4 / 8。 */
    onSelectDuration(event: { currentTarget: { dataset: Record<string, unknown> } }): void {
      const page = this as unknown as ReservationCreateInstance
      const value = numberOf(event)
      if (value === null) return
      const hours = DURATION_HOURS.find((candidate) => candidate === value)
      if (hours === undefined) return
      page.setData({ selectedHours: hours, submitError: '' })
    },

    /** 提交 —— 本地校验 → `13.12` → 回我的预约。 */
    onSubmit(): void {
      const page = this as unknown as ReservationCreateInstance
      void submit(page)
    },
  },
})
