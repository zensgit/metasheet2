import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  deriveElearningOnboardingOccurrenceKey,
  deriveElearningOnboardingPlanSourceKey,
  enqueueElearningOnboardingForUser,
  processElearningOnboardingAssignment,
  type ElearningOnboardingAssignmentDb,
} from '../../src/services/elearning-onboarding-assignment'

const ORG = 'org-onboarding-assignment'
const USER = 'user-onboarding-assignment'
const POLICY = randomUUID()
const JOB = randomUUID()
const EFFECT = randomUUID()
const PLAN_ASSIGNMENT = randomUUID()
const HIRE_DATE = '2026-08-20'
const EVENT_AT = '2026-08-31T10:00:00.000Z'

class RoutingDb implements ElearningOnboardingAssignmentDb {
  readonly statements: string[] = []
  constructor(
    private readonly route: (
      sql: string,
      params: unknown[] | undefined,
    ) => Array<Record<string, unknown>>,
  ) {}
  async query(sql: string, params?: unknown[]) {
    this.statements.push(sql)
    const rows = this.route(sql, params)
    return { rows, rowCount: rows.length }
  }
  async transaction<T>(run: (tx: this) => Promise<T>): Promise<T> {
    return run(this)
  }
}

function keyInput(overrides: Partial<{
  orgId: string
  policyId: string
  userId: string
  hireDate: string
}> = {}) {
  return { orgId: ORG, policyId: POLICY, userId: USER, hireDate: HIRE_DATE, ...overrides }
}

function runningJob(overrides: Record<string, unknown> = {}) {
  return {
    occurrence_key: deriveElearningOnboardingOccurrenceKey(keyInput()),
    ref: POLICY,
    payload: { policyId: POLICY, userId: USER, hireDate: HIRE_DATE },
    due_at: EVENT_AT,
    status: 'running',
    ...overrides,
  }
}

describe('e-learning onboarding assignment', () => {
  it('derives stable bounded identities and rotates on logical payload changes', () => {
    const occurrence = deriveElearningOnboardingOccurrenceKey(keyInput())
    const source = deriveElearningOnboardingPlanSourceKey(keyInput())
    expect(occurrence).toMatch(/^onboarding-assign-v1:[a-f0-9]{64}$/)
    expect(source).toMatch(/^elearning-onboarding-plan-v1:[a-f0-9]{64}$/)
    expect(deriveElearningOnboardingOccurrenceKey(keyInput())).toBe(occurrence)
    expect(deriveElearningOnboardingPlanSourceKey(keyInput())).toBe(source)
    expect(deriveElearningOnboardingOccurrenceKey(keyInput({ userId: `${USER}-2` })))
      .not.toBe(occurrence)
    expect(deriveElearningOnboardingPlanSourceKey(keyInput({ hireDate: '2026-08-21' })))
      .not.toBe(source)
  })

  it('requires an active same-org principal before policy evaluation', async () => {
    const db = new RoutingDb((sql) => {
      if (sql.includes('enqueue:principal')) return [{ hire_date: HIRE_DATE }]
      if (sql.includes('enqueue:policies')) return []
      throw new Error('unexpected query')
    })
    await expect(enqueueElearningOnboardingForUser(db, {
      orgId: ORG,
      userId: USER,
      eventAt: EVENT_AT,
    })).resolves.toEqual({ matchedPolicyCount: 0, enqueuedCount: 0 })
    expect(db.statements[0]).toContain('membership.org_id = $1')
    expect(db.statements[0]).toContain('membership.is_active = TRUE')
  })

  it('fails closed when the principal is absent or timestamp is noncanonical', async () => {
    const missing = new RoutingDb(() => [])
    await expect(enqueueElearningOnboardingForUser(missing, {
      orgId: ORG, userId: USER, eventAt: EVENT_AT,
    })).rejects.toMatchObject({ code: 'not_eligible' })
    const untouched = new RoutingDb(() => {
      throw new Error('database must not be called')
    })
    await expect(enqueueElearningOnboardingForUser(untouched, {
      orgId: ORG, userId: USER, eventAt: '2026-08-31T10:00:00Z',
    })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('replays an exact existing effect without reassigning the plan', async () => {
    const db = new RoutingDb((sql) => {
      if (sql.includes('process:job')) return [runningJob()]
      if (sql.includes('process:effect-lock')) return []
      if (sql.includes('process:existing')) {
        return [{
          id: EFFECT,
          hire_date: HIRE_DATE,
          source_key: deriveElearningOnboardingPlanSourceKey(keyInput()),
          training_plan_assignment_id: PLAN_ASSIGNMENT,
        }]
      }
      throw new Error('unexpected query')
    })
    await expect(processElearningOnboardingAssignment(db, {
      orgId: ORG, jobId: JOB,
    })).resolves.toEqual({
      effectId: EFFECT,
      policyId: POLICY,
      userId: USER,
      planAssignmentId: PLAN_ASSIGNMENT,
      duplicate: true,
    })
    expect(db.statements.some((sql) => sql.includes('training-plan-assign'))).toBe(false)
  })

  it('rejects stale or tampered persisted job/effect identities', async () => {
    const pending = new RoutingDb((sql) => (
      sql.includes('process:job') ? [runningJob({ status: 'pending' })] : []
    ))
    await expect(processElearningOnboardingAssignment(pending, {
      orgId: ORG, jobId: JOB,
    })).rejects.toMatchObject({ code: 'conflict' })

    const tamperedJob = new RoutingDb((sql) => (
      sql.includes('process:job') ? [runningJob({ ref: randomUUID() })] : []
    ))
    await expect(processElearningOnboardingAssignment(tamperedJob, {
      orgId: ORG, jobId: JOB,
    })).rejects.toMatchObject({ code: 'conflict' })

    const tamperedEffect = new RoutingDb((sql) => {
      if (sql.includes('process:job')) return [runningJob()]
      if (sql.includes('process:effect-lock')) return []
      if (sql.includes('process:existing')) {
        return [{
          id: EFFECT,
          hire_date: HIRE_DATE,
          source_key: 'wrong',
          training_plan_assignment_id: PLAN_ASSIGNMENT,
        }]
      }
      return []
    })
    await expect(processElearningOnboardingAssignment(tamperedEffect, {
      orgId: ORG, jobId: JOB,
    })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('requires a closed persisted job payload', async () => {
    const db = new RoutingDb((sql) => (
      sql.includes('process:job')
        ? [runningJob({
            payload: {
              policyId: POLICY,
              userId: USER,
              hireDate: HIRE_DATE,
              memberIds: [USER],
            },
          })]
        : []
    ))
    await expect(processElearningOnboardingAssignment(db, {
      orgId: ORG, jobId: JOB,
    })).rejects.toMatchObject({ code: 'unavailable' })
  })
})
