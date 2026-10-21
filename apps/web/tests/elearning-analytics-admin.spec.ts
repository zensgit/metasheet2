import { createApp, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getDailyMock = vi.fn()
vi.mock('../src/services/elearningAnalytics', () => ({
  getElearningDepartmentStatsDaily: (...args: unknown[]) => getDailyMock(...args),
}))

import { ElearningApiError } from '../src/services/elearning'
import ElearningAnalyticsAdminSection from '../src/views/ElearningAnalyticsAdminSection.vue'

const DEPARTMENT = '11111111-1111-4111-8111-111111111111'
const DATE = '2026-08-29'

function projection(suppressed = false) {
  const common = {
    departmentId: DEPARTMENT,
    statsDate: DATE,
    periodStart: '2026-08-29T00:00:00.000Z',
    periodEnd: '2026-08-30T00:00:00.000Z',
    sourceVersion: 'stats-v1',
    minGroupSize: 5,
    projectedVersion: 2,
    lastProjectedAt: '2026-08-30T00:01:02.003Z',
    lastErrorCode: null,
    suppressed,
  }
  return suppressed ? common : {
    ...common,
    metrics: {
      assignedCount: 10,
      completedCount: 8,
      completionRate: 0.8,
      creditAverage: 3.5,
      creditTotal: 35,
      examParticipantCount: 6,
      learnerCount: 10,
      learningSeconds: 7200,
      memberCount: 12,
      overdueCount: 1,
    },
  }
}

function mount() {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(ElearningAnalyticsAdminSection)
  app.mount(root)
  return { app, root }
}

function input(root: HTMLElement, testId: string, value: string): void {
  const element = root.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

async function submit(root: HTMLElement): Promise<void> {
  root.querySelector('[data-testid="elearning-analytics-form"]')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

beforeEach(() => getDailyMock.mockReset())
afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('e-learning analytics admin section', () => {
  it('loads and renders visible department metrics', async () => {
    getDailyMock.mockResolvedValueOnce(projection())
    const { app, root } = mount()
    input(root, 'elearning-analytics-department', DEPARTMENT)
    input(root, 'elearning-analytics-date', DATE)
    await submit(root)

    expect(getDailyMock).toHaveBeenCalledWith(DEPARTMENT, DATE)
    expect(root.querySelector('[data-testid="elearning-analytics-metrics"]')?.textContent)
      .toContain('80.0%')
    expect(root.textContent).toContain('35')
    app.unmount()
  })

  it('renders suppression without exposing numeric metrics', async () => {
    getDailyMock.mockResolvedValueOnce(projection(true))
    const { app, root } = mount()
    input(root, 'elearning-analytics-department', DEPARTMENT)
    input(root, 'elearning-analytics-date', DATE)
    await submit(root)

    expect(root.querySelector('[data-testid="elearning-analytics-suppressed"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="elearning-analytics-metrics"]')).toBeNull()
    app.unmount()
  })

  it('maps scoped failures without retaining a stale result', async () => {
    getDailyMock.mockResolvedValueOnce(projection())
    const { app, root } = mount()
    input(root, 'elearning-analytics-department', DEPARTMENT)
    input(root, 'elearning-analytics-date', DATE)
    await submit(root)
    expect(root.querySelector('[data-testid="elearning-analytics-result"]')).not.toBeNull()

    getDailyMock.mockRejectedValueOnce(new ElearningApiError('forbidden', 403))
    await submit(root)
    expect(root.querySelector('[data-testid="elearning-analytics-result"]')).toBeNull()
    expect(root.querySelector('[data-testid="elearning-analytics-error"]')?.textContent)
      .toContain('management scope')
    app.unmount()
  })
})
