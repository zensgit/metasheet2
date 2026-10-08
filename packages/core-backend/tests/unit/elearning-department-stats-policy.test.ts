import { describe, expect, it } from 'vitest'

import {
  ELEARNING_DEPARTMENT_STATS_DOMAIN,
  ElearningDepartmentStatsPolicyError,
  buildElearningDepartmentStatsProjection,
} from '../../src/services/elearning-department-stats-policy'

const SENTINEL = 'secret-department-stat-value'

function counters(overrides: Record<string, unknown> = {}) {
  return {
    assignedCount: 8,
    completedCount: 6,
    creditTotal: 25,
    examParticipantCount: 7,
    learnerCount: 8,
    learningSeconds: 7200,
    memberCount: 10,
    overdueCount: 1,
    ...overrides,
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    counters: counters(),
    departmentId: 'dept-1',
    minGroupSize: null,
    orgId: 'org-1',
    periodEnd: '2026-09-01T00:00:00.000Z',
    periodStart: '2026-08-01T00:00:00.000Z',
    sourceVersion: 'source-v1',
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected department stats policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningDepartmentStatsPolicyError)
    const policyError = error as ElearningDepartmentStatsPolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning department stats policy', () => {
  it('builds an exact immutable visible projection with derived metrics', () => {
    const result = buildElearningDepartmentStatsProjection(input())
    expect(result).toEqual({
      departmentId: 'dept-1',
      domain: ELEARNING_DEPARTMENT_STATS_DOMAIN,
      metrics: {
        assignedCount: 8,
        completedCount: 6,
        completionRate: 0.75,
        creditAverage: 2.5,
        creditTotal: 25,
        examParticipantCount: 7,
        learnerCount: 8,
        learningSeconds: 7200,
        memberCount: 10,
        overdueCount: 1,
      },
      orgId: 'org-1',
      payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      periodEnd: '2026-09-01T00:00:00.000Z',
      periodStart: '2026-08-01T00:00:00.000Z',
      projectionKey: expect.stringMatching(
        new RegExp(`^${ELEARNING_DEPARTMENT_STATS_DOMAIN}:[a-f0-9]{64}$`),
      ),
      sourceVersion: 'source-v1',
      suppressed: false,
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(result.suppressed).toBe(false)
    if (!result.suppressed) expect(Object.isFrozen(result.metrics)).toBe(true)
  })

  it('drops every numeric statistic before a suppressed row is materialized', () => {
    const result = buildElearningDepartmentStatsProjection(input({
      counters: counters({
        assignedCount: 4,
        completedCount: 3,
        creditTotal: 987654,
        examParticipantCount: 3,
        learnerCount: 4,
        learningSeconds: 123456,
        memberCount: 4,
        overdueCount: 1,
      }),
    }))
    expect(result).toEqual({
      departmentId: 'dept-1',
      domain: ELEARNING_DEPARTMENT_STATS_DOMAIN,
      orgId: 'org-1',
      payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      periodEnd: '2026-09-01T00:00:00.000Z',
      periodStart: '2026-08-01T00:00:00.000Z',
      projectionKey: expect.stringMatching(/^[^:]+\.[^:]+:[a-f0-9]{64}$/),
      sourceVersion: 'source-v1',
      suppressed: true,
    })
    expect(Object.values(result).some((value) => typeof value === 'number')).toBe(false)
    expect(result).not.toHaveProperty('metrics')
    expect(result).not.toHaveProperty('groupSize')
    expect(JSON.stringify(result)).not.toContain('987654')
    expect(JSON.stringify(result)).not.toContain('123456')
  })

  it('uses the hard minimum of five and only permits an org to raise it', () => {
    expect(buildElearningDepartmentStatsProjection(input({
      counters: counters({ memberCount: 5 }),
    })).suppressed).toBe(false)
    expect(buildElearningDepartmentStatsProjection(input({
      counters: counters({ memberCount: 9 }),
      minGroupSize: 10,
    })).suppressed).toBe(true)
    expect(buildElearningDepartmentStatsProjection(input({
      counters: counters({ memberCount: 10 }),
      minGroupSize: 10,
    })).suppressed).toBe(false)
    for (const minGroupSize of [0, 4, 4.5, '5', Number.NaN]) {
      expectCode(() => buildElearningDepartmentStatsProjection(input({
        minGroupSize,
      })), 'invalid_threshold')
    }
  })

  it('keeps projection identity stable across source updates and metric changes', () => {
    const original = buildElearningDepartmentStatsProjection(input())
    const updated = buildElearningDepartmentStatsProjection(input({
      counters: counters({ completedCount: 7 }),
      sourceVersion: 'source-v2',
    }))
    expect(updated.projectionKey).toBe(original.projectionKey)
    expect(updated.payloadDigest).not.toBe(original.payloadDigest)
  })

  it('scopes projection identity by organization, department, and period', () => {
    const key = (overrides: Record<string, unknown>) => (
      buildElearningDepartmentStatsProjection(input(overrides)).projectionKey
    )
    const keys = new Set([
      key({}),
      key({ orgId: 'org-2' }),
      key({ departmentId: 'dept-2' }),
      key({
        periodEnd: '2026-10-01T00:00:00.000Z',
        periodStart: '2026-09-01T00:00:00.000Z',
      }),
    ])
    expect(keys.size).toBe(4)
  })

  it('does not encode suppressed metrics in the payload digest', () => {
    const original = buildElearningDepartmentStatsProjection(input({
      counters: counters({ memberCount: 4 }),
    }))
    const changed = buildElearningDepartmentStatsProjection(input({
      counters: counters({
        assignedCount: 2,
        completedCount: 1,
        creditTotal: -100,
        examParticipantCount: 1,
        learnerCount: 2,
        learningSeconds: 60,
        memberCount: 4,
        overdueCount: 0,
      }),
    }))
    expect(changed.suppressed).toBe(true)
    expect(changed.payloadDigest).toBe(original.payloadDigest)
  })

  it('accepts negative finite credit totals but rejects invalid counters', () => {
    const negative = buildElearningDepartmentStatsProjection(input({
      counters: counters({ creditTotal: -5 }),
    }))
    expect(negative.suppressed).toBe(false)
    if (!negative.suppressed) expect(negative.metrics.creditAverage).toBe(-0.5)

    for (const badCounters of [
      counters({ assignedCount: -1 }),
      counters({ completedCount: 9 }),
      counters({ overdueCount: 9 }),
      counters({ learnerCount: 1.5 }),
      counters({ learningSeconds: Number.MAX_SAFE_INTEGER + 1 }),
      counters({ creditTotal: Number.POSITIVE_INFINITY }),
      counters({ creditTotal: Number.MAX_SAFE_INTEGER + 1 }),
      { ...counters(), extra: SENTINEL },
    ]) {
      expectCode(() => buildElearningDepartmentStatsProjection(input({
        counters: badCounters,
      })), 'invalid_counters')
    }
  })

  it('requires a canonical positive UTC period', () => {
    for (const overrides of [
      { periodStart: '2026-08-01T00:00:00Z' },
      { periodStart: 'not-a-date' },
      { periodStart: '2026-09-01T00:00:00.000Z' },
      {
        periodEnd: '2026-08-01T00:00:00.000Z',
        periodStart: '2026-09-01T00:00:00.000Z',
      },
    ]) {
      expectCode(() => buildElearningDepartmentStatsProjection(input(overrides)), (
        'invalid_period'
      ))
    }
  })

  it('rejects malformed and extra top-level input values-free', () => {
    for (const value of [
      null,
      {},
      { ...input(), extra: SENTINEL },
      input({ orgId: `${SENTINEL}\0` }),
      input({ departmentId: '\ud800' }),
      input({ sourceVersion: '' }),
    ]) {
      expectCode(() => buildElearningDepartmentStatsProjection(value), 'invalid_input')
    }

    const hostile = Object.defineProperty(input(), 'sourceVersion', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => buildElearningDepartmentStatsProjection(hostile), 'invalid_input')
    const hostileCounters = Object.defineProperty(counters(), 'memberCount', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => buildElearningDepartmentStatsProjection(input({
      counters: hostileCounters,
    })), 'invalid_counters')
  })

  it('keeps personal and raw-event fields out of both projection shapes', () => {
    for (const row of [
      buildElearningDepartmentStatsProjection(input()),
      buildElearningDepartmentStatsProjection(input({
        counters: counters({ memberCount: 4 }),
      })),
    ]) {
      const serialized = JSON.stringify(row)
      expect(serialized).not.toMatch(/userId|answer|heartbeat|comment|employee/i)
    }
  })
})
