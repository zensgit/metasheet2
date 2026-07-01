import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive, ref, type App } from 'vue'
import AttendanceRequestCenterSection from '../src/views/attendance/AttendanceRequestCenterSection.vue'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

const anomaly = {
  recordId: 'rec-1',
  workDate: '2026-06-30',
  status: 'late',
  firstInAt: '2026-06-30T09:12:00.000Z',
  lastOutAt: '2026-06-30T18:00:00.000Z',
  workMinutes: 480,
  lateMinutes: 12,
  earlyLeaveMinutes: 0,
  warnings: ['late'],
  state: 'open' as const,
  request: null,
  suggestedRequestType: 'time_correction',
}

function tr(en: string): string {
  return en
}

function mountSection(overrides: Partial<{
  resultEditCapabilityUnknown: boolean
  resultEditDisabledReason: (item: typeof anomaly) => string
  openResultEditModal: (item: typeof anomaly) => void
}> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  const openResultEditModal = overrides.openResultEditModal ?? vi.fn()
  const resultEditDisabledReason = overrides.resultEditDisabledReason ?? vi.fn(() => '')
  const requestCenter = {
    requestForm: reactive({
      workDate: '2026-06-30',
      requestType: 'time_correction',
      requestedInAt: '',
      requestedOutAt: '',
      reason: '',
      leaveTypeId: '',
      overtimeRuleId: '',
      minutes: '',
      attachmentUrl: '',
    }),
    requestSubmitting: ref(false),
    loading: ref(false),
    requests: ref([]),
    anomalies: ref([anomaly]),
    anomaliesLoading: ref(false),
    requestReport: ref([]),
    reportLoading: ref(false),
    leaveTypes: ref([]),
    overtimeRules: ref([]),
    isLeaveRequest: ref(false),
    isOvertimeRequest: ref(false),
    isLeaveOrOvertimeRequest: ref(false),
    submitRequest: vi.fn(),
    loadRequests: vi.fn(),
    cancelRequest: vi.fn(),
    resolveRequest: vi.fn(),
    loadAnomalies: vi.fn(),
    prefillRequestFromAnomaly: vi.fn(),
    resultEditCapabilityUnknown: ref(overrides.resultEditCapabilityUnknown ?? false),
    openResultEditModal,
    resultEditDisabledReason,
    loadRequestReport: vi.fn(),
    focusCalendarMonth: vi.fn(),
    shiftMonth: vi.fn(),
  }
  app = createApp(AttendanceRequestCenterSection, {
    requestCenter,
    calendarDays: [],
    calendarLabel: 'June 2026',
    weekDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    formatDate: (value: string) => value,
    formatDateTime: (value: string) => value,
    formatRequestType: (value: string) => value,
    formatStatus: (value: string) => value,
    formatWarningsShort: (warnings: string[]) => warnings.join(', '),
    tr,
  })
  app.mount(container)
  return { openResultEditModal, resultEditDisabledReason }
}

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

describe('AttendanceRequestCenterSection result edit action', () => {
  it('calls the shared result-edit modal callback from anomaly rows', async () => {
    const { openResultEditModal } = mountSection()
    await nextTick()
    const button = container?.querySelector('[data-attendance-result-edit-open]') as HTMLButtonElement
    expect(button).toBeTruthy()
    expect(button.disabled).toBe(false)
    button.click()
    expect(openResultEditModal).toHaveBeenCalledWith(anomaly)
  })

  it('renders the parent-provided disabled reason without calling the callback', async () => {
    const openResultEditModal = vi.fn()
    mountSection({
      openResultEditModal,
      resultEditDisabledReason: () => 'Admin permission required.',
    })
    await nextTick()
    const button = container?.querySelector('[data-attendance-result-edit-open]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(container?.querySelector('[data-attendance-result-edit-disabled-reason]')?.textContent).toContain('Admin permission required.')
    button.click()
    expect(openResultEditModal).not.toHaveBeenCalled()
  })

  it('renders a probe-only action before capability is known', async () => {
    const openResultEditModal = vi.fn()
    mountSection({
      resultEditCapabilityUnknown: true,
      openResultEditModal,
    })
    await nextTick()
    expect(container?.querySelector('[data-attendance-result-edit-open]')).toBeNull()
    const probe = container?.querySelector('[data-attendance-result-edit-probe]') as HTMLButtonElement
    expect(probe).toBeTruthy()
    expect(container?.querySelector('[data-attendance-result-edit-disabled-reason]')?.textContent).toContain('Check admin permission')
    probe.click()
    expect(openResultEditModal).toHaveBeenCalledWith(anomaly)
  })
})
