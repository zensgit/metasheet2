import { createApp, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getPeriodMock = vi.fn()
const createExportMock = vi.fn()
const getExportMock = vi.fn()
const downloadExportMock = vi.fn()
const exportAvailabilityMock = vi.fn()
vi.mock('../src/services/elearningAnalytics', () => ({
  getElearningAnalyticsExportAvailability: (...args: unknown[]) => exportAvailabilityMock(...args),
  getElearningDepartmentStatsPeriod: (...args: unknown[]) => getPeriodMock(...args),
  createElearningAnalyticsExport: (...args: unknown[]) => createExportMock(...args),
  getElearningAnalyticsExport: (...args: unknown[]) => getExportMock(...args),
  downloadElearningAnalyticsExport: (...args: unknown[]) => downloadExportMock(...args),
}))

import { ElearningApiError } from '../src/services/elearning'
import ElearningAnalyticsPeriodSection from '../src/views/ElearningAnalyticsPeriodSection.vue'
import { elearningErrorMessage } from '../src/views/elearningLabels'

const STORAGE_UNAVAILABLE_ZH = '当前部署未配置导出存储，分析导出不可用；需要导出请联系运维配置对象存储'
const STORAGE_UNAVAILABLE_EN = 'no export storage configured'

const DEPARTMENT = '11111111-1111-4111-8111-111111111111'
const REQUEST_ONE = '22222222-2222-4222-8222-222222222222'
const REQUEST_TWO = '33333333-3333-4333-8333-333333333333'
const REQUEST_THREE = '44444444-4444-4444-8444-444444444444'
const EXPORT = '55555555-5555-4555-8555-555555555555'

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

function exportResult(status = 'pending') {
  return {
    exportId: EXPORT,
    departmentId: DEPARTMENT,
    periodStart: '2026-08-23T00:00:00.000Z',
    periodEnd: '2026-08-30T00:00:00.000Z',
    status,
    expiresAt: '2026-09-06T00:00:00.000Z',
    completedAt: status === 'succeeded' ? '2026-08-30T00:01:02.003Z' : null,
    errorCode: null,
    duplicate: false,
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

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function click(root: HTMLElement, testId: string): Promise<void> {
  ;(root.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click()
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

beforeEach(() => {
  getPeriodMock.mockReset()
  createExportMock.mockReset()
  getExportMock.mockReset()
  downloadExportMock.mockReset()
  exportAvailabilityMock.mockReset().mockResolvedValue({ available: true })
})
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

  it('reuses request identity after failure, rotates for payload changes and after success', async () => {
    const randomUuid = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(REQUEST_ONE)
      .mockReturnValueOnce(REQUEST_TWO)
      .mockReturnValueOnce(REQUEST_THREE)
    createExportMock
      .mockRejectedValueOnce(new ElearningApiError('network_error', 0))
      .mockResolvedValueOnce(exportResult())
      .mockResolvedValueOnce(exportResult())
      .mockResolvedValueOnce(exportResult())
    const { app, root } = mount()
    input(root, 'elearning-analytics-period-department', DEPARTMENT)
    input(root, 'elearning-analytics-period-start', '2026-08-23')
    input(root, 'elearning-analytics-period-end', '2026-08-29')

    await click(root, 'elearning-analytics-export-create')
    await click(root, 'elearning-analytics-export-create')
    expect(createExportMock.mock.calls[0]?.[0].requestId).toBe(REQUEST_ONE)
    expect(createExportMock.mock.calls[1]?.[0].requestId).toBe(REQUEST_ONE)

    input(root, 'elearning-analytics-period-end', '2026-08-30')
    await click(root, 'elearning-analytics-export-create')
    expect(createExportMock.mock.calls[2]?.[0].requestId).toBe(REQUEST_TWO)

    await click(root, 'elearning-analytics-export-create')
    expect(createExportMock.mock.calls[3]?.[0].requestId).toBe(REQUEST_THREE)
    expect(randomUuid).toHaveBeenCalledTimes(3)
    randomUuid.mockRestore()
    app.unmount()
  })

  it('refreshes manually and downloads only a succeeded export', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce(REQUEST_ONE)
    const createObjectUrl = vi.fn(() => 'blob:elearning-analytics')
    const revokeObjectUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    createExportMock.mockResolvedValueOnce(exportResult())
    getExportMock.mockResolvedValueOnce(exportResult('succeeded'))
    downloadExportMock.mockResolvedValueOnce({
      blob: new Blob(['csv'], { type: 'text/csv' }),
      filename: 'elearning.csv',
    })
    const { app, root } = mount()
    input(root, 'elearning-analytics-period-department', DEPARTMENT)
    input(root, 'elearning-analytics-period-start', '2026-08-23')
    input(root, 'elearning-analytics-period-end', '2026-08-29')

    await click(root, 'elearning-analytics-export-create')
    expect((root.querySelector('[data-testid="elearning-analytics-export-download"]') as HTMLButtonElement).disabled)
      .toBe(true)
    await click(root, 'elearning-analytics-export-refresh')
    expect(getExportMock).toHaveBeenCalledWith(EXPORT)
    expect(root.querySelector('[data-testid="elearning-analytics-export-status"]')?.textContent)
      .toBe('succeeded')
    await click(root, 'elearning-analytics-export-download')
    expect(downloadExportMock).toHaveBeenCalledWith(EXPORT)
    expect(createObjectUrl).toHaveBeenCalledTimes(1)
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:elearning-analytics')

    clicked.mockRestore()
    vi.restoreAllMocks()
    app.unmount()
  })

  it('disables export creation up front with an explanation when export storage is unavailable', async () => {
    exportAvailabilityMock.mockReset().mockResolvedValue({ available: false, reason: 'storage_unavailable' })
    const { app, root } = mount()
    await flush()
    expect(exportAvailabilityMock).toHaveBeenCalledTimes(1)
    const button = root.querySelector('[data-testid="elearning-analytics-export-create"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(root.querySelector('[data-testid="elearning-analytics-export-unavailable"]')?.textContent)
      .toContain(STORAGE_UNAVAILABLE_EN)
    input(root, 'elearning-analytics-period-department', DEPARTMENT)
    await click(root, 'elearning-analytics-export-create')
    expect(createExportMock).not.toHaveBeenCalled()
    app.unmount()
  })

  it('keeps export creation enabled when storage is available or availability is unknown', async () => {
    const available = mount()
    await flush()
    expect((available.root.querySelector('[data-testid="elearning-analytics-export-create"]') as HTMLButtonElement).disabled)
      .toBe(false)
    expect(available.root.querySelector('[data-testid="elearning-analytics-export-unavailable"]')).toBeNull()
    available.app.unmount()

    exportAvailabilityMock.mockReset().mockRejectedValue(new ElearningApiError('network_error', 0))
    const unknown = mount()
    await flush()
    expect((unknown.root.querySelector('[data-testid="elearning-analytics-export-create"]') as HTMLButtonElement).disabled)
      .toBe(false)
    expect(unknown.root.querySelector('[data-testid="elearning-analytics-export-unavailable"]')).toBeNull()
    unknown.app.unmount()
  })

  it('turns a server-side storage-unavailable refusal into the standing notice', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce(REQUEST_ONE)
    createExportMock.mockRejectedValueOnce(
      new ElearningApiError('ANALYTICS_EXPORT_STORAGE_UNAVAILABLE', 409),
    )
    const { app, root } = mount()
    await flush()
    input(root, 'elearning-analytics-period-department', DEPARTMENT)
    await click(root, 'elearning-analytics-export-create')
    expect(createExportMock).toHaveBeenCalledTimes(1)
    expect(root.querySelector('[data-testid="elearning-analytics-export-error"]')).toBeNull()
    expect(root.querySelector('[data-testid="elearning-analytics-export-unavailable"]')?.textContent)
      .toContain(STORAGE_UNAVAILABLE_EN)
    expect((root.querySelector('[data-testid="elearning-analytics-export-create"]') as HTMLButtonElement).disabled)
      .toBe(true)
    vi.restoreAllMocks()
    app.unmount()
  })

  it('maps ANALYTICS_EXPORT_STORAGE_UNAVAILABLE to the same explanation in both locales', () => {
    expect(elearningErrorMessage('ANALYTICS_EXPORT_STORAGE_UNAVAILABLE', 409, true))
      .toContain(STORAGE_UNAVAILABLE_ZH)
    expect(elearningErrorMessage('ANALYTICS_EXPORT_STORAGE_UNAVAILABLE', 409, false))
      .toContain(STORAGE_UNAVAILABLE_EN)
    expect(elearningErrorMessage('ANALYTICS_EXPORT_STORAGE_UNAVAILABLE', 409, true))
      .not.toContain('ANALYTICS_EXPORT_STORAGE_UNAVAILABLE')
    // Only the exact 409 code is explained; anything else keeps the generic failure text.
    expect(elearningErrorMessage('ANALYTICS_EXPORT_STORAGE_UNAVAILABLE', 503, true))
      .toContain('ANALYTICS_EXPORT_STORAGE_UNAVAILABLE')
  })
})
