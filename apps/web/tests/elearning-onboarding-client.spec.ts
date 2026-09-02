import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import {
  createElearningOnboardingPolicy,
  getElearningOnboardingWeeklyReport,
  retireElearningOnboardingPolicy,
} from '../src/services/elearningOnboarding'

const POLICY = '11111111-1111-4111-8111-111111111111'
const PLAN = '22222222-2222-4222-8222-222222222222'
const DEPARTMENT = '33333333-3333-4333-8333-333333333333'
const REQUEST = '44444444-4444-4444-8444-444444444444'
const REPORT = '55555555-5555-4555-8555-555555555555'
const CREATED = '2026-08-31T01:02:03.000Z'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function policy(over: Record<string, unknown> = {}) {
  return {
    policyId: POLICY,
    trainingPlanId: PLAN,
    matchRules: [{
      subjectType: 'department',
      subjectRef: DEPARTMENT,
      includeChildren: true,
    }],
    hireWindowDays: 30,
    deadlineDays: 45,
    weeklyReportEnabled: true,
    status: 'active',
    createdAt: CREATED,
    retiredAt: null,
    duplicate: false,
    ...over,
  }
}

function report(suppressed = false, over: Record<string, unknown> = {}) {
  return {
    reportId: REPORT,
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
    ...over,
  }
}

function command() {
  return {
    requestId: REQUEST,
    trainingPlanId: PLAN,
    matchRules: [{
      subjectType: 'department' as const,
      subjectRef: DEPARTMENT,
      includeChildren: true,
    }],
    hireWindowDays: 30,
    deadlineDays: 45,
    weeklyReportEnabled: true,
  }
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe('e-learning onboarding client', () => {
  it('sends a closed policy command and accepts create replay status', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, policy({ duplicate: true })))

    await expect(createElearningOnboardingPolicy(command())).resolves.toEqual(
      policy({ duplicate: true }),
    )
    const [path, options] = apiFetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/elearning/admin/onboarding/policies')
    expect(options.method).toBe('POST')
    expect(JSON.parse(String(options.body))).toEqual(command())
  })

  it('retires only the requested policy and validates the returned lifecycle', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, policy({
      status: 'retired',
      retiredAt: '2026-08-31T02:03:04.000Z',
    })))

    await expect(retireElearningOnboardingPolicy(POLICY)).resolves.toMatchObject({
      policyId: POLICY,
      status: 'retired',
    })
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(
      `/api/elearning/admin/onboarding/policies/${POLICY}/retire`,
    )
  })

  it('keeps suppressed weekly counts closed and absent from usable values', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, report(true)))
    const result = await getElearningOnboardingWeeklyReport(POLICY, '2026-08-24')
    expect(result).toEqual(report(true))
    expect(result.suppressed).toBe(true)
    expect(result.enqueuedCount).toBeNull()
  })

  it.each([
    policy({ answerKey: ['leak'] }),
    policy({ status: 'retired', retiredAt: null }),
    policy({ createdAt: '2026-02-31T00:00:00.000Z' }),
    policy({ matchRules: [{ subjectType: 'position', subjectRef: 'Engineer', includeChildren: true }] }),
    policy({ matchRules: [
      { subjectType: 'position', subjectRef: 'B', includeChildren: false },
      { subjectType: 'department', subjectRef: DEPARTMENT, includeChildren: false },
    ] }),
  ])('rejects malformed or leaky policy responses', async (body) => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(201, body))
    await expect(createElearningOnboardingPolicy(command())).rejects.toMatchObject({
      code: 'invalid_response',
      status: 201,
    })
  })

  it.each([
    report(true, { enqueuedCount: 0 }),
    report(false, { assignedUserCount: null }),
    report(false, { weekEnd: '2026-08-30' }),
    report(false, { minGroupSize: 4 }),
    report(false, { enqueuedCount: 5, assignedUserCount: 3, failedCount: 4, deadCount: 2 }),
    report(false, { rawAssignments: [] }),
  ])('rejects malformed, unsuppressed, or leaky weekly report shapes', async (body) => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, body))
    await expect(getElearningOnboardingWeeklyReport(POLICY, '2026-08-24'))
      .rejects.toMatchObject({ code: 'invalid_response', status: 200 })
  })

  it('rejects extra command keys and preserves values-free server errors', async () => {
    await expect(createElearningOnboardingPolicy({
      ...command(),
      extra: true,
    } as ReturnType<typeof command>)).rejects.toMatchObject({
      code: 'invalid_input',
      status: 400,
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(409, { error: 'conflict' }))
    await expect(createElearningOnboardingPolicy(command())).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    })
  })
})
