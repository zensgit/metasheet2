import { createApp, nextTick, type App as VueApp } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  createPolicy: vi.fn(),
  retirePolicy: vi.fn(),
  getReport: vi.fn(),
}))

vi.mock('../src/services/elearningOnboarding', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearningOnboarding')>(
    '../src/services/elearningOnboarding',
  )
  return {
    ...actual,
    createElearningOnboardingPolicy: h.createPolicy,
    retireElearningOnboardingPolicy: h.retirePolicy,
    getElearningOnboardingWeeklyReport: h.getReport,
  }
})

import { ElearningApiError } from '../src/services/elearning'
import ElearningOnboardingAdminSection from '../src/views/ElearningOnboardingAdminSection.vue'

const POLICY = '11111111-1111-4111-8111-111111111111'
const PLAN = '22222222-2222-4222-8222-222222222222'
const DEPARTMENT = '33333333-3333-4333-8333-333333333333'
const REQUEST_ONE = '44444444-4444-4444-8444-444444444444'
const REQUEST_TWO = '55555555-5555-4555-8555-555555555555'
const REQUEST_THREE = '77777777-7777-4777-8777-777777777777'

function policy(status: 'active' | 'retired' = 'active') {
  return {
    policyId: POLICY,
    trainingPlanId: PLAN,
    matchRules: [{ subjectType: 'department', subjectRef: DEPARTMENT, includeChildren: false }],
    hireWindowDays: 30,
    deadlineDays: 30,
    weeklyReportEnabled: true,
    status,
    createdAt: '2026-08-31T01:02:03.000Z',
    retiredAt: status === 'retired' ? '2026-08-31T02:03:04.000Z' : null,
    duplicate: false,
  }
}

function report(suppressed: boolean) {
  return {
    reportId: '66666666-6666-4666-8666-666666666666',
    policyId: POLICY,
    weekStart: '2026-08-24',
    weekEnd: '2026-08-31',
    suppressed,
    minGroupSize: 5,
    enqueuedCount: suppressed ? null : 8,
    assignedUserCount: suppressed ? null : 6,
    failedCount: suppressed ? null : 1,
    deadCount: suppressed ? null : 0,
    duplicate: false,
  }
}

async function flush(cycles = 8): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function input(root: HTMLElement, testId: string, value: string): void {
  const element = root.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

async function click(root: HTMLElement, testId: string): Promise<void> {
  ;(root.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click()
  await flush()
}

describe('ElearningOnboardingAdminSection', () => {
  let app: VueApp<Element> | null = null
  let root: HTMLDivElement | null = null
  let randomUuid: ReturnType<typeof vi.spyOn> | null = null

  function mount(assignmentEnabled: boolean, analyticsEnabled: boolean): HTMLDivElement {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(ElearningOnboardingAdminSection, { assignmentEnabled, analyticsEnabled })
    app.mount(root)
    return root
  }

  beforeEach(() => {
    h.createPolicy.mockReset()
    h.retirePolicy.mockReset()
    h.getReport.mockReset()
    randomUuid = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(REQUEST_ONE)
      .mockReturnValueOnce(REQUEST_TWO)
      .mockReturnValue(REQUEST_THREE)
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
    randomUuid?.mockRestore()
    vi.clearAllMocks()
  })

  it('isolates assignment and analytics surfaces by capability', () => {
    const assignmentOnly = mount(true, false)
    expect(assignmentOnly.querySelector('[data-testid="elearning-onboarding-policy-form"]')).not.toBeNull()
    expect(assignmentOnly.querySelector('[data-testid="elearning-onboarding-report-form"]')).toBeNull()
    app?.unmount()
    assignmentOnly.remove()

    const analyticsOnly = mount(false, true)
    expect(analyticsOnly.querySelector('[data-testid="elearning-onboarding-policy-form"]')).toBeNull()
    expect(analyticsOnly.querySelector('[data-testid="elearning-onboarding-report-form"]')).not.toBeNull()
    expect(analyticsOnly.textContent).toContain('privacy-suppressed weekly onboarding reports')
    expect(analyticsOnly.textContent).not.toContain('Assign an active training plan')
  })

  it('reuses a failed policy request id and rotates on payload change and success', async () => {
    h.createPolicy
      .mockRejectedValueOnce(new ElearningApiError('network_error', 0))
      .mockResolvedValueOnce(policy())
      .mockResolvedValueOnce(policy())
      .mockResolvedValueOnce(policy())
    const view = mount(true, false)
    input(view, 'elearning-onboarding-plan', PLAN)
    input(view, 'elearning-onboarding-subject-ref', DEPARTMENT)

    await click(view, 'elearning-onboarding-create')
    await click(view, 'elearning-onboarding-create')
    expect(h.createPolicy.mock.calls[0]?.[0].requestId).toBe(REQUEST_ONE)
    expect(h.createPolicy.mock.calls[1]?.[0].requestId).toBe(REQUEST_ONE)

    input(view, 'elearning-onboarding-deadline', '45')
    await click(view, 'elearning-onboarding-create')
    expect(h.createPolicy.mock.calls[2]?.[0].requestId).toBe(REQUEST_TWO)

    await click(view, 'elearning-onboarding-create')
    expect(h.createPolicy.mock.calls[3]?.[0].requestId).toBe(REQUEST_THREE)
  })

  it('retires the returned policy without accepting a free-form target', async () => {
    h.createPolicy.mockResolvedValueOnce(policy())
    h.retirePolicy.mockResolvedValueOnce(policy('retired'))
    const view = mount(true, false)
    input(view, 'elearning-onboarding-plan', PLAN)
    input(view, 'elearning-onboarding-subject-ref', DEPARTMENT)
    await click(view, 'elearning-onboarding-create')
    await click(view, 'elearning-onboarding-retire')
    expect(h.retirePolicy).toHaveBeenCalledWith(POLICY)
    expect(view.querySelector('[data-testid="elearning-onboarding-policy-result"]')?.textContent)
      .toContain('retired')
  })

  it('renders no numeric values for a suppressed weekly report', async () => {
    h.getReport.mockResolvedValueOnce(report(true))
    const view = mount(false, true)
    input(view, 'elearning-onboarding-report-policy', POLICY)
    input(view, 'elearning-onboarding-week-start', '2026-08-24')
    await click(view, 'elearning-onboarding-report-load')
    expect(h.getReport).toHaveBeenCalledWith(POLICY, '2026-08-24')
    expect(view.querySelector('[data-testid="elearning-onboarding-report-suppressed"]')).not.toBeNull()
    expect(view.querySelector('[data-testid="elearning-onboarding-report-counts"]')).toBeNull()
  })
})
