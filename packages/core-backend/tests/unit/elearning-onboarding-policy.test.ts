import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  createElearningOnboardingPolicy,
  ElearningOnboardingPolicyError,
  hashElearningOnboardingPolicyRequest,
  normalizeElearningOnboardingMatchRules,
  retireElearningOnboardingPolicy,
  type ElearningOnboardingPolicyDb,
} from '../../src/services/elearning-onboarding-policy'

const ORG = 'org-onboarding-policy'
const ACTOR = 'actor-onboarding-policy'
const PLAN = randomUUID()
const POLICY = randomUUID()
const REQUEST = randomUUID()
const DEPARTMENT = randomUUID()
const CREATED_AT = '2026-08-31T10:00:00.000Z'
const RULES = [{
  subjectType: 'department' as const,
  subjectRef: DEPARTMENT,
  includeChildren: true,
}]

function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: POLICY,
    training_plan_id: PLAN,
    match_rules: RULES,
    hire_window_days: 30,
    deadline_days: 14,
    weekly_report_enabled: true,
    status: 'active',
    created_at: CREATED_AT,
    retired_at: null,
    ...overrides,
  }
}

class SequenceDb implements ElearningOnboardingPolicyDb {
  readonly statements: string[] = []
  constructor(private readonly results: Array<Array<Record<string, unknown>>>) {}
  async query(sql: string) {
    this.statements.push(sql)
    const rows = this.results.shift()
    if (!rows) throw new Error('unexpected query')
    return { rows, rowCount: rows.length }
  }
  async transaction<T>(run: (tx: this) => Promise<T>): Promise<T> {
    return run(this)
  }
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    actorId: ACTOR,
    requestId: REQUEST,
    trainingPlanId: PLAN,
    matchRules: RULES,
    hireWindowDays: 30,
    deadlineDays: 14,
    weeklyReportEnabled: true,
    ...overrides,
  }
}

describe('e-learning onboarding policy', () => {
  it('accepts only normalized department/position predicates', () => {
    expect(normalizeElearningOnboardingMatchRules([
      { subjectType: 'position', subjectRef: 'Engineer', includeChildren: false },
      ...RULES,
    ]).map((rule) => rule.subjectType)).toEqual(['department', 'position'])
    expect(() => normalizeElearningOnboardingMatchRules([
      { subjectType: 'all', subjectRef: null, includeChildren: false },
    ])).toThrowError(ElearningOnboardingPolicyError)
    expect(() => normalizeElearningOnboardingMatchRules([
      { subjectType: 'user', subjectRef: ACTOR, includeChildren: false },
    ])).toThrowError(ElearningOnboardingPolicyError)
  })

  it('creates after same-org actor and active plan checks', async () => {
    const db = new SequenceDb([
      [], [{ id: ACTOR }], [], [{ id: PLAN }], [policyRow()],
    ])
    await expect(createElearningOnboardingPolicy(db, command())).resolves.toEqual({
      policyId: POLICY,
      trainingPlanId: PLAN,
      matchRules: RULES,
      hireWindowDays: 30,
      deadlineDays: 14,
      weeklyReportEnabled: true,
      status: 'active',
      createdAt: CREATED_AT,
      retiredAt: null,
      duplicate: false,
    })
    expect(db.statements.join('\n')).toContain('elearning-onboarding-policy:actor')
    expect(db.statements.join('\n')).toContain('elearning-onboarding-policy:plan')
  })

  it('replays the same request and returns values-free conflict for changed payload', async () => {
    const requestHash = hashElearningOnboardingPolicyRequest({
      trainingPlanId: PLAN,
      matchRules: RULES,
      hireWindowDays: 30,
      deadlineDays: 14,
      weeklyReportEnabled: true,
    })
    const replay = new SequenceDb([
      [], [{ id: ACTOR }], [policyRow({ request_hash: requestHash, request_hash_version: 1 })],
    ])
    await expect(createElearningOnboardingPolicy(replay, command())).resolves.toMatchObject({
      policyId: POLICY,
      duplicate: true,
    })
    const conflict = new SequenceDb([
      [], [{ id: ACTOR }], [policyRow({ request_hash: requestHash, request_hash_version: 1 })],
    ])
    await expect(createElearningOnboardingPolicy(
      conflict,
      command({ deadlineDays: 15 }),
    )).rejects.toMatchObject({ code: 'conflict', message: 'conflict' })
  })

  it('rejects replay after the actor loses active same-org membership', async () => {
    const requestHash = hashElearningOnboardingPolicyRequest({
      trainingPlanId: PLAN,
      matchRules: RULES,
      hireWindowDays: 30,
      deadlineDays: 14,
      weeklyReportEnabled: true,
    })
    const revoked = new SequenceDb([
      [],
      [],
      [policyRow({ request_hash: requestHash, request_hash_version: 1 })],
    ])
    await expect(createElearningOnboardingPolicy(revoked, command()))
      .rejects.toMatchObject({ code: 'forbidden', message: 'forbidden' })
    expect(revoked.statements.some((sql) => sql.includes('load-request'))).toBe(false)
  })

  it('retires once and replays an already retired policy', async () => {
    const retiredAt = '2026-08-31T11:00:00.000Z'
    const first = new SequenceDb([
      [{ id: ACTOR }], [policyRow()],
      [policyRow({ status: 'retired', retired_at: retiredAt })],
    ])
    await expect(retireElearningOnboardingPolicy(first, {
      orgId: ORG, actorId: ACTOR, policyId: POLICY,
    })).resolves.toMatchObject({ status: 'retired', retiredAt, duplicate: false })
    const replay = new SequenceDb([
      [{ id: ACTOR }], [policyRow({ status: 'retired', retired_at: retiredAt })],
    ])
    await expect(retireElearningOnboardingPolicy(replay, {
      orgId: ORG, actorId: ACTOR, policyId: POLICY,
    })).resolves.toMatchObject({ status: 'retired', retiredAt, duplicate: true })
  })
})
