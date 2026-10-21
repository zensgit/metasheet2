/**
 * Test report 2026-10-08, item T4a (and the adjacent E1): what the REAL Element Plus picker puts into
 * ApprovalNewView's submitted `formData` for `datetime` and `date` fields.
 *
 * approvalNewView.spec.ts replaces `element-plus` wholesale and its ElDatePicker stub never emits,
 * so the picker -> payload seam had no coverage at all. This file mounts the real view with the real
 * Element Plus plugin (only ElMessage is replaced, see its mock) and drives the real date panel.
 * Element Plus renders every date panel eagerly (the picker's tooltip is `persistent`), so the
 * calendar cells and the panel's time box are in the document from mount, without opening a popper.
 *
 * Wall clock: `Date` is faked to a fixed local instant with NON-ZERO seconds and milliseconds before
 * the view mounts, because the datetime `default-time` is read once, at mount. Only `Date` is faked;
 * timers stay real.
 */
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import type { FormField, FormSchema } from '../src/types/approval'
import { mockPendingApproval, mockPublishedTemplate } from './helpers/approval-test-fixtures'

// A real ElMessage toast mounts into document.body and closes itself on a timer that can fire after
// this file's jsdom is torn down (same flake and fix as approval-detail-record-table.spec.ts); no
// test here asserts on a toast, so only ElMessage is replaced and every other export stays real.
vi.mock('element-plus', async () => {
  const actual = await vi.importActual<typeof import('element-plus')>('element-plus')
  return {
    ...actual,
    ElMessage: Object.assign(vi.fn(), {
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      closeAll: vi.fn(),
    }),
  }
})

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn().mockResolvedValue(undefined), back: vi.fn() }),
    useRoute: () => ({ params: { templateId: 'tpl_dates' }, query: {}, path: '/approvals/new/tpl_dates', meta: {} }),
  }
})

vi.mock('../src/approvals/permissions', () => ({
  useApprovalPermissions: () => ({ canWrite: { value: true } }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUser: () => ({ id: 'user_1' }),
    getCurrentUserId: vi.fn().mockResolvedValue('user_1'),
  }),
}))

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    features: {
      get value() {
        return {
          attendance: false,
          workflow: false,
          attendanceAdmin: false,
          attendanceImport: false,
          plm: false,
          approvalMobile: false,
          approvalAttachments: false,
          mode: 'platform',
        }
      },
    },
  }),
}))

vi.mock('../src/approvals/serverFormDraft', () => ({
  loadFormDraftServer: vi.fn(async () => null),
  saveFormDraftServer: vi.fn(async () => undefined),
  clearFormDraftServer: vi.fn(async () => undefined),
  listFormDraftsServer: vi.fn(async () => []),
}))

const mockActiveTemplate = ref<any>(null)
vi.mock('../src/approvals/templateStore', () => ({
  useApprovalTemplateStore: () => ({
    get activeTemplate() { return mockActiveTemplate.value },
    get loading() { return false },
    get error() { return null },
    set error(_v: unknown) { /* noop */ },
    loadTemplate: vi.fn().mockResolvedValue(undefined),
  }),
}))

const submitApprovalSpy = vi.fn()
vi.mock('../src/approvals/store', () => ({
  useApprovalStore: () => ({
    get loading() { return false },
    get error() { return null },
    set error(_v: unknown) { /* noop */ },
    submitApproval: submitApprovalSpy,
  }),
}))

// 2026-10-08 (a Thursday) 14:23:37.456 local time. The seconds and milliseconds are deliberately not
// zero: the fix stores the default time truncated to the minute, and only a non-zero wall clock can
// show that.
const FROZEN_NOW = new Date(2026, 9, 8, 14, 23, 37, 456)

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function topLevelSchema(datetimeOverrides: Partial<FormField> = {}): FormSchema {
  return {
    fields: [
      { id: 'fld_date', type: 'date', label: '出发日期' } as FormField,
      { id: 'fld_dt', type: 'datetime', label: '日期时间', ...datetimeOverrides } as FormField,
    ],
  }
}

function detailSchema(): FormSchema {
  return {
    fields: [
      {
        id: 'items',
        type: 'detail',
        label: '行程明细',
        columns: [
          { id: 'day', type: 'date', label: '日期' },
          { id: 'at', type: 'datetime', label: '到达时间' },
        ],
      } as FormField,
    ],
  }
}

/** Every eagerly rendered date panel; a datetime panel carries `has-time`, a date panel does not. */
function datePanels(): { date: HTMLElement[]; datetime: HTMLElement[] } {
  const panels = Array.from(document.body.querySelectorAll<HTMLElement>('.el-picker-panel.el-date-picker'))
  return {
    date: panels.filter((panel) => !panel.classList.contains('has-time')),
    datetime: panels.filter((panel) => panel.classList.contains('has-time')),
  }
}

/** Clicks the current-month cell for `day` (the panel opens on the frozen month, October 2026). */
async function pickDay(panel: HTMLElement, day: number): Promise<void> {
  const cell = Array.from(panel.querySelectorAll<HTMLElement>('td.available'))
    .find((td) => td.textContent?.trim() === String(day))
  expect(cell, `no current-month cell for day ${day}`).toBeTruthy()
  cell!.click()
  await flushUi()
}

/** Types into the panel's time box (the second header input) and commits it with a change event. */
async function typeTime(panel: HTMLElement, text: string): Promise<void> {
  const inputs = panel.querySelectorAll<HTMLInputElement>('.el-date-picker__time-header input')
  expect(inputs.length).toBe(2)
  const timeInput = inputs[1]
  timeInput.value = text
  timeInput.dispatchEvent(new Event('input', { bubbles: true }))
  timeInput.dispatchEvent(new Event('change', { bubbles: true }))
  await flushUi()
}

beforeEach(() => {
  useLocale().setLocale('zh-CN')
})

describe('ApprovalNewView — real date/datetime pickers (test report 2026-10-08 T4a / E1)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(FROZEN_NOW)
    submitApprovalSpy.mockReset()
    submitApprovalSpy.mockResolvedValue(mockPendingApproval({ id: 'apv_dates_1' }))
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  async function mountView(formSchema: FormSchema): Promise<void> {
    mockActiveTemplate.value = mockPublishedTemplate({ id: 'tpl_dates', formSchema })
    const { default: ApprovalNewView } = await import('../src/views/approval/ApprovalNewView.vue')
    const Host = defineComponent({ setup: () => () => h(ApprovalNewView as any) })
    app = createApp(Host)
    app.use(ElementPlus)
    app.mount(container!)
    await flushUi(10)
  }

  async function submit(): Promise<Record<string, unknown>> {
    const button = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('提交审批'))
    expect(button).toBeTruthy()
    button!.click()
    await flushUi(10)
    expect(submitApprovalSpy).toHaveBeenCalledTimes(1)
    return (submitApprovalSpy.mock.calls[0][0] as { formData: Record<string, unknown> }).formData
  }

  function editorInput(fieldLabel: string): HTMLInputElement {
    const item = Array.from(container!.querySelectorAll<HTMLElement>('.el-form-item'))
      .find((el) => el.querySelector('.el-form-item__label')?.textContent?.includes(fieldLabel))
    expect(item, `no form item labelled ${fieldLabel}`).toBeTruthy()
    const input = item!.querySelector<HTMLInputElement>('.el-date-editor input')
    expect(input).toBeTruthy()
    return input!
  }

  it('datetime: picking only a calendar day carries the default time (form-open time, truncated to the minute), never 00:00', async () => {
    await mountView(topLevelSchema())
    const panels = datePanels()
    expect(panels.datetime).toHaveLength(1)

    await pickDay(panels.datetime[0], 15)
    const formData = await submit()

    const value = formData.fld_dt
    expect(value).toBeInstanceOf(Date)
    const picked = value as Date
    expect([picked.getFullYear(), picked.getMonth(), picked.getDate()]).toEqual([2026, 9, 15])
    // The tester's symptom was exactly this pair reading 0/0.
    expect([picked.getHours(), picked.getMinutes(), picked.getSeconds(), picked.getMilliseconds()]).toEqual([14, 23, 0, 0])
    // The stored format is unchanged: a Date, i.e. a UTC ISO instant on the wire.
    expect(JSON.parse(JSON.stringify(formData)).fld_dt).toBe(new Date(2026, 9, 15, 14, 23, 0, 0).toISOString())
  })

  it('datetime: the input shows minute granularity (YYYY-MM-DD HH:mm), the granularity the default time is stored at', async () => {
    await mountView(topLevelSchema())
    await pickDay(datePanels().datetime[0], 15)
    expect(editorInput('日期时间').value).toBe('2026-10-15 14:23')
  })

  it('datetime: a time typed as HH:mm in the panel time box is kept (it was silently dropped before)', async () => {
    await mountView(topLevelSchema())
    const panel = datePanels().datetime[0]
    await pickDay(panel, 15)
    await typeTime(panel, '10:30')
    const formData = await submit()

    const picked = formData.fld_dt as Date
    expect(picked).toBeInstanceOf(Date)
    expect([picked.getDate(), picked.getHours(), picked.getMinutes()]).toEqual([15, 10, 30])
  })

  it('datetime: the empty input asks for a date AND a time; an author-written placeholder still wins', async () => {
    await mountView(topLevelSchema())
    expect(editorInput('日期时间').getAttribute('placeholder')).toBe('请选择日期和时间')
    // The date-only field keeps its own placeholder.
    expect(editorInput('出发日期').getAttribute('placeholder')).toBe('请选择出发日期')

    app!.unmount()
    app = null
    await mountView(topLevelSchema({ placeholder: '请填写航班起飞时间' }))
    expect(editorInput('日期时间').getAttribute('placeholder')).toBe('请填写航班起飞时间')
  })

  it('date (E1): the picker submits the strict YYYY-MM-DD calendar string the server validates, not a Date instant', async () => {
    await mountView(topLevelSchema())
    const panels = datePanels()
    expect(panels.date).toHaveLength(1)

    await pickDay(panels.date[0], 15)
    const formData = await submit()

    expect(formData.fld_date).toBe('2026-10-15')
    expect(JSON.parse(JSON.stringify(formData)).fld_date).toBe('2026-10-15')
  })

  it('明细 cells: a date cell submits YYYY-MM-DD and a datetime cell carries the default time', async () => {
    await mountView(detailSchema())
    const addRow = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('添加一行'))
    expect(addRow).toBeTruthy()
    addRow!.click()
    await flushUi(10)

    // ElTableColumn also renders its cell slot once against an EMPTY placeholder row inside the
    // table's hidden column registry, so every cell editor exists twice; the placeholder copies
    // mount with the table, the real row's copies mount when the row is added — i.e. last.
    const panels = datePanels()
    expect(panels.date).toHaveLength(2)
    expect(panels.datetime).toHaveLength(2)
    await pickDay(panels.date[1], 15)
    await pickDay(panels.datetime[1], 16)
    // The visible row's editors show the picks, so the panels above were the real row's.
    const rowEditors = container!.querySelectorAll<HTMLInputElement>('.el-table__body .el-date-editor input')
    expect(Array.from(rowEditors, (input) => input.value)).toEqual(['2026-10-15', '2026-10-16 14:23'])
    // Gate r1 NIT-1: a 明细 cell's placeholder is its column label, for the datetime cell as for every
    // sibling cell (the date cell included); only the top-level datetime field uses the generic ask.
    expect(Array.from(rowEditors, (input) => input.getAttribute('placeholder'))).toEqual(['日期', '到达时间'])
    const formData = await submit()

    const rows = formData.items as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].day).toBe('2026-10-15')
    const at = rows[0].at as Date
    expect(at).toBeInstanceOf(Date)
    expect([at.getDate(), at.getHours(), at.getMinutes(), at.getSeconds()]).toEqual([16, 14, 23, 0])
  })
})
