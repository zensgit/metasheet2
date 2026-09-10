import { describe, expect, it } from 'vitest'

import {
  ELEARNING_COURSE_STATS_POLICY_VERSION,
  ElearningCourseStatsPolicyError,
  buildElearningCourseStatsSnapshot,
} from '../../src/services/elearning-course-stats-policy'

const COURSE_ID = '10000000-0000-4000-8000-000000000001'
const VERSION_ID = '20000000-0000-4000-8000-000000000001'
const SENTINEL = 'secret-course-stat-value'

function counters(overrides: Record<string, unknown> = {}) {
  return {
    assignedLearnerCount: 8,
    completedCount: 4,
    inProgressCount: 3,
    notStartedCount: 3,
    overdueCount: 2,
    selfStudyLearnerCount: 2,
    ...overrides,
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    counters: counters(),
    courseId: COURSE_ID,
    courseVersionId: VERSION_ID,
    orgId: 'org-1',
    sourceVersion: 'rollup-v1',
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected course stats policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningCourseStatsPolicyError)
    const policyError = error as ElearningCourseStatsPolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning course stats policy', () => {
  it('builds an exact immutable course-version snapshot', () => {
    const result = buildElearningCourseStatsSnapshot(input({
      courseId: COURSE_ID.toUpperCase(),
    }))
    expect(result).toEqual({
      courseId: COURSE_ID,
      courseVersionId: VERSION_ID,
      metrics: {
        assignedLearnerCount: 8,
        completedCount: 4,
        completionRate: 0.4,
        inProgressCount: 3,
        learnerCount: 10,
        notStartedCount: 3,
        overdueCount: 2,
        selfStudyLearnerCount: 2,
        startedCount: 7,
      },
      orgId: 'org-1',
      policyVersion: ELEARNING_COURSE_STATS_POLICY_VERSION,
      sourceVersion: 'rollup-v1',
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.metrics)).toBe(true)
  })

  it('defines an empty course with zero counts and rate', () => {
    const result = buildElearningCourseStatsSnapshot(input({
      counters: counters({
        assignedLearnerCount: 0,
        completedCount: 0,
        inProgressCount: 0,
        notStartedCount: 0,
        overdueCount: 0,
        selfStudyLearnerCount: 0,
      }),
    }))
    expect(result.metrics).toEqual({
      assignedLearnerCount: 0,
      completedCount: 0,
      completionRate: 0,
      inProgressCount: 0,
      learnerCount: 0,
      notStartedCount: 0,
      overdueCount: 0,
      selfStudyLearnerCount: 0,
      startedCount: 0,
    })
  })

  it('requires progress buckets to partition the learner population', () => {
    for (const badCounters of [
      counters({ completedCount: 5 }),
      counters({ notStartedCount: 2 }),
      counters({ inProgressCount: 4 }),
    ]) expectCode(
      () => buildElearningCourseStatsSnapshot(input({ counters: badCounters })),
      'inconsistent_counters',
    )
  })

  it('allows overdue learning only inside the assigned population', () => {
    expectCode(() => buildElearningCourseStatsSnapshot(input({
      counters: counters({ overdueCount: 9 }),
    })), 'inconsistent_counters')
    expectCode(() => buildElearningCourseStatsSnapshot(input({
      counters: counters({
        assignedLearnerCount: 0,
        completedCount: 1,
        inProgressCount: 0,
        notStartedCount: 1,
        overdueCount: 1,
        selfStudyLearnerCount: 2,
      }),
    })), 'inconsistent_counters')
  })

  it('rejects negative, fractional, non-finite, and overflowing counts', () => {
    for (const badCounters of [
      counters({ assignedLearnerCount: -1 }),
      counters({ completedCount: 1.5 }),
      counters({ inProgressCount: Number.NaN }),
      counters({ notStartedCount: Number.POSITIVE_INFINITY }),
      counters({ overdueCount: '2' }),
      counters({
        assignedLearnerCount: Number.MAX_SAFE_INTEGER,
        selfStudyLearnerCount: 1,
      }),
      { ...counters(), extra: SENTINEL },
    ]) expectCode(
      () => buildElearningCourseStatsSnapshot(input({ counters: badCounters })),
      'invalid_counters',
    )
  })

  it('rejects malformed identities, keys, and top-level shapes values-free', () => {
    for (const value of [
      null,
      {},
      { ...input(), extra: SENTINEL },
      input({ courseId: 'course-1' }),
      input({ courseVersionId: 'version-1' }),
      input({ orgId: '' }),
      input({ orgId: `${SENTINEL}\0` }),
      input({ sourceVersion: '\ud800' }),
    ]) expectCode(
      () => buildElearningCourseStatsSnapshot(value),
      'invalid_input',
    )
  })

  it('maps hostile top-level and counter accessors to closed errors', () => {
    const hostile = Object.defineProperty(input(), 'sourceVersion', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(
      () => buildElearningCourseStatsSnapshot(hostile),
      'invalid_input',
    )
    const hostileCounters = Object.defineProperty(counters(), 'completedCount', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => buildElearningCourseStatsSnapshot(input({
      counters: hostileCounters,
    })), 'invalid_counters')
  })

  it('keeps learner identities, answers, scores, and raw events out of the shape', () => {
    const serialized = JSON.stringify(buildElearningCourseStatsSnapshot(input()))
    expect(serialized).not.toMatch(/userId|answer|score|heartbeat|pageView|comment/i)
  })
})
