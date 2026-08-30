import { createApp, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getPeriodMock = vi.fn()
vi.mock('../src/services/elearningAnalytics', () => ({
  getElearningDepartmentStatsPeriod: (...args: unknown[]) => getPeriodMock(...args),
}))

import { ElearningApiError } from '../src/services/elearning'
import ElearningAnalyticsPeriodSection from '../src/views/ElearningAnalyticsPeriodSection.vue'

const DEPARTMENT = '11111111-1111-4111-8111-111111111111'

function projection(suppressed = false) {
  const common = {
    departmentId: DEPARTMENT,
    periodStart: '2026-08-23T00:00:00.000Z',
    periodEnd: '2026-08-30T00:00:00.000Z',
    sourceVersion: 'period-v1',
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
  const app = createApp(ElearningAnalyticsPeriodSection)
  app.mount(root)
  return { app, root }
}

function input(root: HTMLElement, testId: string, value: string): void {
  const element = root.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

async function submit(root: HTMLElement): Promise<void> {
  root.querySelector('[data-testid="elearning-analytics-period-form"]')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

beforeEach(() => getPeriodMock.mockReset())
afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('e-learning analytics period section', () => {
  it('converts an inclusive date range into an exclusive UTC period', async () => {
    getPeriodMock.mockResolvedValueOnce(projection())
    const { app, root } = mount()
    input(root, 'elearning-analytics-period-department', DEPARTMENT)
    input(root, 'elearning-analytics-period-start', '2026-08-23')
    input(root, 'elearning-analytics-period-end', '2026-08-29')
    await submit(root)

    expect(getPeriodMock).toHaveBeenCalledWith(
      DEPARTMENT,
      '2026-08-23T00:00:00.000Z',
      '2026-08-30T00:00:00.000Z',
    )
    expect(root.querySelector('[data-testid="elearning-analytics-period-metrics"]')?.textContent)
      .toContain('80.0%')
    app.unmount()
  })

  it('keeps suppressed period values out of the page', async () => {
    getPeriodMock.mockResolvedValueOnce(projection(true))
    const { app, root } = mount()
    input(root, 'elearning-analytics-period-department', DEPARTMENT)
    input(root, 'elearning-analytics-period-start', '2026-08-23')
    input(root, 'elearning-analytics-period-end', '2026-08-29')
    await submit(root)

    expect(root.querySelector('[data-testid="elearning-analytics-period-suppressed"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="elearning-analytics-period-metrics"]')).toBeNull()
    app.unmount()
  })

  it('clears a prior result when scope authority rejects the next request', async () => {
    getPeriodMock.mockResolvedValueOnce(projection())
    const { app, root } = mount()
    input(root, 'elearning-analytics-period-department', DEPARTMENT)
    input(root, 'elearning-analytics-period-start', '2026-08-23')
    input(root, 'elearning-analytics-period-end', '2026-08-29')
    await submit(root)
    expect(root.querySelector('[data-testid="elearning-analytics-period-result"]')).not.toBeNull()

    getPeriodMock.mockRejectedValueOnce(new ElearningApiError('forbidden', 403))
    await submit(root)
    expect(root.querySelector('[data-testid="elearning-analytics-period-result"]')).toBeNull()
    expect(root.querySelector('[data-testid="elearning-analytics-period-error"]')?.textContent)
      .toContain('management scope')
    app.unmount()
  })
})
