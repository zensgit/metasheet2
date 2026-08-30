import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import { getElearningDepartmentStatsDaily } from '../src/services/elearningAnalytics'

const DEPARTMENT = '11111111-1111-4111-8111-111111111111'
const DATE = '2026-08-29'
const START = '2026-08-29T00:00:00.000Z'
const END = '2026-08-30T00:00:00.000Z'
const PROJECTED = '2026-08-30T00:01:02.003Z'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function base(over: Record<string, unknown> = {}) {
  return {
    departmentId: DEPARTMENT,
    statsDate: DATE,
    periodStart: START,
    periodEnd: END,
    sourceVersion: 'stats-v1',
    minGroupSize: 5,
    projectedVersion: 2,
    lastProjectedAt: PROJECTED,
    lastErrorCode: null,
    suppressed: false,
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
    ...over,
  }
}

beforeEach(() => apiFetchMock.mockReset())
afterEach(() => vi.clearAllMocks())

describe('e-learning analytics client', () => {
  it('requests the exact daily path and parses a closed visible projection', async () => {
    apiFetchMock.mockResolvedValueOnce(response(base()))
    await expect(getElearningDepartmentStatsDaily(DEPARTMENT.toUpperCase(), DATE)).resolves.toEqual(base())
    expect(apiFetchMock).toHaveBeenCalledWith(
      `/api/elearning/admin/analytics/departments/${DEPARTMENT}/daily/${DATE}`,
      { method: 'GET' },
    )
  })

  it('parses a suppressed projection without numeric metrics', async () => {
    const { metrics: _metrics, ...suppressed } = base({ suppressed: true })
    apiFetchMock.mockResolvedValueOnce(response(suppressed))
    await expect(getElearningDepartmentStatsDaily(DEPARTMENT, DATE)).resolves.toEqual(suppressed)
  })

  it.each([
    base({ extra: true }),
    base({ statsDate: '2026-02-30' }),
    base({ periodStart: '2026-08-29T00:00:00Z' }),
    base({ periodEnd: '2026-08-31T00:00:00.000Z' }),
    base({ lastProjectedAt: '2026-08-30T00:01:02Z' }),
    base({ minGroupSize: 4 }),
    base({ metrics: { ...base().metrics, completionRate: 1.1 } }),
    base({ metrics: { ...base().metrics, completedCount: 11 } }),
    base({ metrics: { ...base().metrics, assignedCount: 1.5 } }),
    (() => {
      const { metrics: _metrics, ...suppressed } = base({ suppressed: true })
      return { ...suppressed, metrics: base().metrics }
    })(),
  ])('rejects malformed daily projection %#', async (payload) => {
    apiFetchMock.mockResolvedValueOnce(response(payload))
    await expect(getElearningDepartmentStatsDaily(DEPARTMENT, DATE)).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
  })

  it('rejects invalid input before network access and keeps API errors values-free', async () => {
    await expect(getElearningDepartmentStatsDaily('not-a-uuid', DATE)).rejects.toMatchObject({
      code: 'invalid_input',
      status: 400,
    })
    await expect(getElearningDepartmentStatsDaily(DEPARTMENT, '2026-02-30')).rejects.toMatchObject({
      code: 'invalid_input',
      status: 400,
    })
    expect(apiFetchMock).not.toHaveBeenCalled()

    apiFetchMock.mockResolvedValueOnce(response({ error: 'forbidden', detail: 'sensitive' }, 403))
    await expect(getElearningDepartmentStatsDaily(DEPARTMENT, DATE)).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    })
  })
})
