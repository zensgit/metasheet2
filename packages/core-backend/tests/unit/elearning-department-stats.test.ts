import { describe, expect, it } from 'vitest'

import {
  ElearningDepartmentStatsError,
  getElearningDepartmentStats,
  type ElearningDepartmentStatsDb,
} from '../../src/services/elearning-department-stats'

const ORG = 'org-department-stats'
const ACTOR = 'actor-department-stats'
const DEPARTMENT = '11111111-1111-4111-8111-111111111111'
const START = '2026-08-01T00:00:00.000Z'
const END = '2026-09-01T00:00:00.000Z'

interface Call {
  sql: string
  params: unknown[]
}

class ScriptDb implements ElearningDepartmentStatsDb {
  readonly calls: Call[] = []

  constructor(
    private readonly aggregate: Record<string, unknown>,
    private readonly scope = {
      scope_count: '1',
      rule_count: '1',
      covered_count: '1',
    },
  ) {}

  async query(sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params })
    if (sql.includes('elearning-admin-access:rule-scope')) {
      return { rows: [this.scope], rowCount: 1 }
    }
    if (sql.includes('elearning-department-stats:aggregate')) {
      return { rows: [this.aggregate], rowCount: 1 }
    }
    throw new Error('unexpected query')
  }
}

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    department_found: true,
    member_count: '5',
    assigned_count: '4',
    completed_count: '3',
    learner_count: '4',
    overdue_count: '1',
    exam_participant_count: '2',
    learning_seconds: '7200',
    credit_total: '25',
    source_version: '2026-08-30T01:02:03.123456Z',
    ...over,
  }
}

function input(over: Partial<Parameters<typeof getElearningDepartmentStats>[1]> = {}) {
  return {
    orgId: ORG,
    actorId: ACTOR,
    isGlobalAdmin: false,
    departmentId: DEPARTMENT,
    periodStart: START,
    periodEnd: END,
    ...over,
  }
}

async function expectCode(
  action: Promise<unknown>,
  code: ElearningDepartmentStatsError['code'],
): Promise<void> {
  try {
    await action
    throw new Error('expected error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningDepartmentStatsError)
    expect((error as ElearningDepartmentStatsError).code).toBe(code)
    expect((error as ElearningDepartmentStatsError).message).toBe(code)
  }
}

describe('e-learning department statistics service', () => {
  it('scope-checks one department and returns aggregate-only metrics', async () => {
    const db = new ScriptDb(row())
    const result = await getElearningDepartmentStats(db, input())
    expect(result.suppressed).toBe(false)
    if (result.suppressed) throw new Error('expected visible result')
    expect(result.metrics).toEqual({
      assignedCount: 4,
      completedCount: 3,
      completionRate: 0.75,
      creditAverage: 5,
      creditTotal: 25,
      examParticipantCount: 2,
      learnerCount: 4,
      learningSeconds: 7200,
      memberCount: 5,
      overdueCount: 1,
    })
    expect(db.calls).toHaveLength(2)
    expect(db.calls[0]?.params).toEqual([
      ORG,
      ACTOR,
      JSON.stringify([{ department_id: DEPARTMENT, include_children: false }]),
    ])
    const aggregate = db.calls[1]
    expect(aggregate?.params).toEqual([ORG, DEPARTMENT, START, END])
    expect(aggregate?.sql).toContain('integration.org_id = $1')
    expect(aggregate?.sql).toContain(
      'account.integration_id = department.integration_id',
    )
    expect(aggregate?.sql).toContain('org_membership.is_active IS TRUE')
    expect(aggregate?.sql).toContain("link.link_status = 'linked'")
    expect(aggregate?.sql).toContain('elearning_completion_evidence')
    expect(aggregate?.sql).toContain('elearning_exam_attempts')
    expect(aggregate?.sql).toContain('elearning_credit_decisions')
    expect(aggregate?.sql).toContain('elearning_credit_adjustments')
    expect(aggregate?.sql).not.toMatch(/paper_snapshot|answer_key|\banswers\b|raw\b/i)
    expect(JSON.stringify(result)).not.toContain(ACTOR)
  })

  it('suppresses every numeric metric below the hard minimum of five', async () => {
    const result = await getElearningDepartmentStats(
      new ScriptDb(row({ member_count: '4' })),
      input({ isGlobalAdmin: true }),
    )
    expect(result.suppressed).toBe(true)
    expect(result).not.toHaveProperty('metrics')
    expect(JSON.stringify(result)).not.toContain('creditTotal')
    expect(JSON.stringify(result)).not.toContain('memberCount')
  })

  it('lets global admins bypass scope coverage but not organization filtering', async () => {
    const db = new ScriptDb(row())
    await getElearningDepartmentStats(db, input({ isGlobalAdmin: true }))
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0]?.sql).toContain('elearning-department-stats:aggregate')
    expect(db.calls[0]?.params[0]).toBe(ORG)
  })

  it('fails closed for absent scope, uncovered and missing departments', async () => {
    await expectCode(
      getElearningDepartmentStats(
        new ScriptDb(row(), { scope_count: '0', rule_count: '1', covered_count: '0' }),
        input(),
      ),
      'forbidden',
    )
    await expectCode(
      getElearningDepartmentStats(
        new ScriptDb(row(), { scope_count: '1', rule_count: '1', covered_count: '0' }),
        input(),
      ),
      'forbidden',
    )
    await expectCode(
      getElearningDepartmentStats(
        new ScriptDb(row({ department_found: false })),
        input({ isGlobalAdmin: true }),
      ),
      'not_found',
    )
  })

  it('rejects malformed input and aggregate rows values-free', async () => {
    for (const over of [
      { departmentId: 'not-a-uuid' },
      { periodStart: '2026-02-30T00:00:00.000Z' },
      { periodEnd: START },
    ]) {
      await expectCode(
        getElearningDepartmentStats(new ScriptDb(row()), input(over)),
        'invalid_input',
      )
    }
    for (const aggregate of [
      row({ member_count: '5.5' }),
      row({ completed_count: '5', assigned_count: '4' }),
      row({ credit_total: 'secret-credit' }),
      row({ department_found: 'true' }),
    ]) {
      await expectCode(
        getElearningDepartmentStats(
          new ScriptDb(aggregate),
          input({ isGlobalAdmin: true }),
        ),
        'unavailable',
      )
    }
  })
})
