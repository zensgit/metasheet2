import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, reactive, ref, type App, type Ref } from 'vue'
import AttendancePayrollAdminSection from '../src/views/attendance/AttendancePayrollAdminSection.vue'
import type {
  AttendancePayrollCycle,
  AttendancePayrollSummary,
  AttendancePayrollTemplate,
} from '../src/views/attendance/useAttendanceAdminPayroll'

type MaybePromise<T> = T | Promise<T>

interface PayrollTemplateFormState {
  name: string
  timezone: string
  startDay: number
  endDay: number
  endMonthOffset: number
  autoGenerate: boolean
  isDefault: boolean
  config: string
}

interface PayrollCycleFormState {
  templateId: string
  name: string
  anchorDate: string
  startDate: string
  endDate: string
  status: string
}

interface PayrollCycleGenerateFormState {
  templateId: string
  anchorDate: string
  count: number
  status: string
  namePrefix: string
  metadata: string
}

interface PayrollBindings {
  payrollTemplateLoading: Ref<boolean>
  payrollTemplateSaving: Ref<boolean>
  payrollCycleLoading: Ref<boolean>
  payrollCycleSaving: Ref<boolean>
  payrollCycleGenerating: Ref<boolean>
  payrollCycleGenerateResult: Ref<{ created: number; skipped: number } | null>
  payrollTemplates: Ref<AttendancePayrollTemplate[]>
  payrollCycles: Ref<AttendancePayrollCycle[]>
  payrollTemplateEditingId: Ref<string | null>
  payrollCycleEditingId: Ref<string | null>
  payrollCycleSummary: Ref<AttendancePayrollSummary | null>
  payrollTemplateForm: PayrollTemplateFormState
  payrollCycleForm: PayrollCycleFormState
  payrollCycleGenerateForm: PayrollCycleGenerateFormState
  payrollTemplateName: (templateId?: string | null) => string
  resetPayrollTemplateForm: () => MaybePromise<void>
  editPayrollTemplate: (item: AttendancePayrollTemplate) => MaybePromise<void>
  loadPayrollTemplates: () => MaybePromise<void>
  savePayrollTemplate: () => MaybePromise<void>
  deletePayrollTemplate: (id: string) => MaybePromise<void>
  resetPayrollCycleForm: () => MaybePromise<void>
  resetPayrollCycleGenerateForm: () => MaybePromise<void>
  editPayrollCycle: (item: AttendancePayrollCycle) => MaybePromise<void>
  loadPayrollCycles: () => MaybePromise<void>
  generatePayrollCycles: () => MaybePromise<void>
  savePayrollCycle: () => MaybePromise<void>
  deletePayrollCycle: (id: string) => MaybePromise<void>
  loadPayrollCycleSummary: () => MaybePromise<void>
  exportPayrollCycleSummary: () => MaybePromise<void>
}

function flushUi(): Promise<void> {
  return Promise.resolve()
}

function createPayrollBindings(overrides: Partial<PayrollBindings> = {}): PayrollBindings {
  const payrollTemplates = ref<AttendancePayrollTemplate[]>([
    {
      id: 'tpl-cn',
      name: 'CN Payroll',
      timezone: 'Asia/Shanghai',
      startDay: 1,
      endDay: 30,
      endMonthOffset: 0,
      autoGenerate: true,
      isDefault: true,
    },
  ])

  return {
    payrollTemplateLoading: ref(false),
    payrollTemplateSaving: ref(false),
    payrollCycleLoading: ref(false),
    payrollCycleSaving: ref(false),
    payrollCycleGenerating: ref(false),
    payrollCycleGenerateResult: ref(null),
    payrollTemplates,
    payrollCycles: ref<AttendancePayrollCycle[]>([]),
    payrollTemplateEditingId: ref('tpl-cn'),
    payrollCycleEditingId: ref('cycle-1'),
    payrollCycleSummary: ref<AttendancePayrollSummary | null>(null),
    payrollTemplateForm: reactive<PayrollTemplateFormState>({
      name: 'CN Payroll',
      timezone: 'Asia/Shanghai',
      startDay: 1,
      endDay: 30,
      endMonthOffset: 0,
      autoGenerate: true,
      isDefault: true,
      config: '{}',
    }),
    payrollCycleForm: reactive<PayrollCycleFormState>({
      templateId: 'tpl-cn',
      name: 'March payroll',
      anchorDate: '2026-03-01',
      startDate: '2026-03-01',
      endDate: '2026-03-31',
      status: 'open',
    }),
    payrollCycleGenerateForm: reactive<PayrollCycleGenerateFormState>({
      templateId: '',
      anchorDate: '2026-03-01',
      count: 2,
      status: 'open',
      namePrefix: '',
      metadata: '{}',
    }),
    payrollTemplateName: (templateId?: string | null) => {
      if (!templateId) return 'Manual'
      return payrollTemplates.value.find(item => item.id === templateId)?.name ?? templateId
    },
    resetPayrollTemplateForm: vi.fn(),
    editPayrollTemplate: vi.fn(),
    loadPayrollTemplates: vi.fn(),
    savePayrollTemplate: vi.fn(),
    deletePayrollTemplate: vi.fn(),
    resetPayrollCycleForm: vi.fn(),
    resetPayrollCycleGenerateForm: vi.fn(),
    editPayrollCycle: vi.fn(),
    loadPayrollCycles: vi.fn(),
    generatePayrollCycles: vi.fn(),
    savePayrollCycle: vi.fn(),
    deletePayrollCycle: vi.fn(),
    loadPayrollCycleSummary: vi.fn(),
    exportPayrollCycleSummary: vi.fn(),
    ...overrides,
  }
}

describe('AttendancePayrollAdminSection', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  const tr = (en: string, _zh: string) => en
  const formatStatus = (value: string) => value

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  it('shows timezone context for template, cycle, and batch generation selectors', async () => {
    const payroll = createPayrollBindings()

    app = createApp(AttendancePayrollAdminSection, {
      tr,
      formatStatus,
      payroll,
    })
    app.mount(container!)
    await flushUi()

    const templateTimezone = container!.querySelector<HTMLSelectElement>('#attendance-payroll-template-timezone')
    const cycleTemplate = container!.querySelector<HTMLSelectElement>('#attendance-payroll-cycle-template')
    const generateTemplate = container!.querySelector<HTMLSelectElement>('#attendance-payroll-cycle-gen-template')
    expect(templateTimezone).toBeTruthy()
    expect(cycleTemplate).toBeTruthy()
    expect(generateTemplate).toBeTruthy()
    expect(templateTimezone!.selectedOptions[0]?.textContent).toContain('Asia/Shanghai (UTC+08:00)')
    expect(cycleTemplate!.selectedOptions[0]?.textContent).toContain('CN Payroll (UTC+08:00 · Asia/Shanghai)')
    expect(generateTemplate!.selectedOptions[0]?.textContent).toContain('Default template (CN Payroll · UTC+08:00 · Asia/Shanghai)')
    expect(Array.from(templateTimezone!.querySelectorAll('optgroup')).map((group) => group.label)).toContain('Common timezones')

    expect(container!.textContent).toContain('Current: UTC+08:00 · Asia/Shanghai')
    expect(container!.textContent).toContain('Cycle template timezone: CN Payroll (UTC+08:00 · Asia/Shanghai)')
    expect(container!.textContent).toContain('Generate timezone context: CN Payroll (UTC+08:00 · Asia/Shanghai)')
  })
})
