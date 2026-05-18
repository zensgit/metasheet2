import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive, ref, type App } from 'vue'
import AttendancePayrollAdminSection from '../src/views/attendance/AttendancePayrollAdminSection.vue'
import type {
  AttendancePayrollSummaryFieldOption,
  AttendancePayrollTemplate,
} from '../src/views/attendance/useAttendanceAdminPayroll'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

function mountSection(overrides: Partial<Record<string, unknown>> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)

  const summaryFieldOptions = ref<AttendancePayrollSummaryFieldOption[]>([
    { code: 'work_duration', name: '工作时长', unit: 'minutes', source: 'system' },
    { code: 'leave_minutes', name: '请假分钟', unit: 'minutes', source: 'system' },
    { code: 'period_net_minutes', name: '周期净时长', unit: 'minutes', formula: true, source: 'formula' },
  ])
  const selectedCodes = ref(['work_duration', 'period_net_minutes'])
  const selectedFieldOptions = ref<AttendancePayrollSummaryFieldOption[]>([
    { code: 'work_duration', name: '工作时长', unit: 'minutes', source: 'system' },
    { code: 'period_net_minutes', name: '周期净时长', unit: 'minutes', formula: true, source: 'formula' },
  ])
  const payroll = {
    payrollTemplateLoading: ref(false),
    payrollTemplateSaving: ref(false),
    payrollCycleLoading: ref(false),
    payrollCycleSaving: ref(false),
    payrollCycleGenerating: ref(false),
    payrollCycleGenerateResult: ref(null),
    payrollTemplates: ref<AttendancePayrollTemplate[]>([]),
    payrollCycles: ref([]),
    payrollSummaryFieldOptions: summaryFieldOptions,
    payrollSummaryFieldOptionsLoading: ref(false),
    payrollSummarySelectedFieldOptions: selectedFieldOptions,
    payrollTemplateEditingId: ref(null),
    payrollCycleEditingId: ref(null),
    payrollCycleSummary: ref(null),
    payrollTemplateForm: reactive({
      name: '',
      timezone: 'Asia/Shanghai',
      startDay: 1,
      endDay: 30,
      endMonthOffset: 0,
      autoGenerate: true,
      isDefault: false,
      config: '{}',
      summaryFieldCodes: selectedCodes.value,
    }),
    payrollCycleForm: reactive({
      templateId: '',
      name: '',
      anchorDate: '',
      startDate: '',
      endDate: '',
      status: 'open',
    }),
    payrollCycleGenerateForm: reactive({
      templateId: '',
      anchorDate: '2026-05-18',
      count: 1,
      status: 'open',
      namePrefix: '',
      metadata: '{}',
    }),
    payrollTemplateName: vi.fn((id?: string | null) => id || 'Manual'),
    resetPayrollTemplateForm: vi.fn(),
    editPayrollTemplate: vi.fn(),
    isPayrollSummaryFieldSelected: vi.fn((code: string) => selectedCodes.value.includes(code)),
    togglePayrollSummaryFieldCode: vi.fn((code: string, checked?: boolean) => {
      if (checked && !selectedCodes.value.includes(code)) selectedCodes.value.push(code)
      if (checked === false) selectedCodes.value = selectedCodes.value.filter(item => item !== code)
    }),
    movePayrollSummaryFieldCode: vi.fn(),
    loadPayrollSummaryFieldOptions: vi.fn(),
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

  app = createApp(AttendancePayrollAdminSection, {
    tr: (en: string) => en,
    payroll,
    formatStatus: (value: string) => value,
  })
  app.mount(container)
  return { payroll, selectedCodes, selectedFieldOptions }
}

afterEach(() => {
  if (app) app.unmount()
  app = null
  container?.remove()
  container = null
})

describe('AttendancePayrollAdminSection', () => {
  it('renders payroll summary field template options and delegates selection/order actions', async () => {
    const { payroll } = mountSection()

    expect(container!.querySelector('[data-payroll-summary-field-option="work_duration"]')?.textContent).toContain('work_duration')
    expect(container!.querySelector('[data-payroll-summary-field-order]')?.textContent).toContain('period_net_minutes')

    const leaveMinutes = container!.querySelector(
      '[data-payroll-summary-field-option="leave_minutes"] input',
    ) as HTMLInputElement
    leaveMinutes.checked = true
    leaveMinutes.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(payroll.togglePayrollSummaryFieldCode).toHaveBeenCalledWith('leave_minutes', true)

    const downButton = [...container!.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Down')) as HTMLButtonElement
    downButton.click()
    await nextTick()

    expect(payroll.movePayrollSummaryFieldCode).toHaveBeenCalledWith('work_duration', 1)
  })
})
