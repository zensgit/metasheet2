import { describe, expect, it } from 'vitest'

import {
  ElearningStatsDailyReadError,
  elearningStatsDailyReadSql,
  getElearningDepartmentStatsDaily,
  type ElearningStatsDailyReadDb,
} from '../../src/services/elearning-stats-daily-read'

const ORG = 'org-stats-daily-read'
const ACTOR = 'actor-stats-daily-read'
const DEPARTMENT = '11111111-1111-4111-8111-111111111111'

interface Call {
  sql: string
  params: unknown[]
}

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assigned_count: '4',
    completed_count: '3',
    completion_rate: '0.750000000',
    credit_average: '5.000000000',
    credit_total: '25',
    exam_participant_count: '2',
    last_error: null,
    last_projected_at: '2026-08-30T03:04:05.678Z',
    learner_count: '4',
    learning_seconds: '7200',
    member_count: '5',
    min_group_size: 5,
    overdue_count: '1',
    period_end: '2026-08-31T00:00:00.000Z',
    period_start: '2026-08-30T00:00:00.000Z',
    projected_version: '2',
    source_version: '2026-08-30T03:04:05.678901Z',
    stats_date: '2026-08-30',
    suppressed: false,
    ...over,
  }
}

class ScriptDb implements ElearningStatsDailyReadDb {
  readonly calls: Call[] = []

  constructor(
    private readonly stored: Record<string, unknown> | null = row(),
    private readonly scope = {
      covered_count: '1',
      rule_count: '1',
      scope_count: '1',
    },
  ) {}

  async query(sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params })
    if (sql.includes('elearning-admin-access:rule-scope')) {
      return { rows: [this.scope], rowCount: 1 }
    }
    if (sql === elearningStatsDailyReadSql) {
      return {
        rows: this.stored ? [this.stored] : [],
        rowCount: this.stored ? 1 : 0,
      }
    }
    throw new Error('unexpected query')
  }
}

function input(over: Record<string, unknown> = {}) {
  return {
    actorId: ACTOR,
    departmentId: DEPARTMENT,
    isGlobalAdmin: false,
    orgId: ORG,
    statsDate: '2026-08-30',
    ...over,
  }
}

async function expectCode(
  action: Promise<unknown>,
  code: ElearningStatsDailyReadError['code'],
): Promise<void> {
  try {
    await action
    throw new Error('expected stats daily read error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningStatsDailyReadError)
    expect((error as ElearningStatsDailyReadError).code).toBe(code)
    expect((error as Error).message).toBe(code)
  }
}

describe('e-learning stats daily read service', () => {
  it('scope-checks a department and returns a closed visible projection', async () => {
    const db = new ScriptDb()
    await expect(getElearningDepartmentStatsDaily(db, input())).resolves.toEqual({
      departmentId: DEPARTMENT,
      lastErrorCode: null,
      lastProjectedAt: '2026-08-30T03:04:05.678Z',
      metrics: {
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
      },
      minGroupSize: 5,
      periodEnd: '2026-08-31T00:00:00.000Z',
      periodStart: '2026-08-30T00:00:00.000Z',
      projectedVersion: 2,
      sourceVersion: '2026-08-30T03:04:05.678901Z',
      statsDate: '2026-08-30',
      suppressed: false,
    })
    expect(db.calls[0]?.params).toEqual([
      ORG,
      ACTOR,
      JSON.stringify([{ department_id: DEPARTMENT, include_children: false }]),
    ])
    expect(db.calls[1]).toEqual({
      params: [ORG, DEPARTMENT, '2026-08-30'],
      sql: elearningStatsDailyReadSql,
    })
    expect(db.calls[1]?.sql).toContain('stats.org_id = $1')
    expect(db.calls[1]?.sql).not.toMatch(/user_id|answer|heartbeat|raw_snapshot/i)
  })

  it('returns no metric property for a valid suppressed row', async () => {
    const suppressed = row({
      assigned_count: null,
      completed_count: null,
      completion_rate: null,
      credit_average: null,
      credit_total: null,
      exam_participant_count: null,
      learner_count: null,
      learning_seconds: null,
      member_count: null,
      overdue_count: null,
      suppressed: true,
    })
    const result = await getElearningDepartmentStatsDaily(
      new ScriptDb(suppressed),
      input({ isGlobalAdmin: true }),
    )
    expect(result).toEqual({
      departmentId: DEPARTMENT,
      lastErrorCode: null,
      lastProjectedAt: '2026-08-30T03:04:05.678Z',
      minGroupSize: 5,
      periodEnd: '2026-08-31T00:00:00.000Z',
      periodStart: '2026-08-30T00:00:00.000Z',
      projectedVersion: 2,
      sourceVersion: '2026-08-30T03:04:05.678901Z',
      statsDate: '2026-08-30',
      suppressed: true,
    })
    expect(result).not.toHaveProperty('metrics')
  })

  it('lets a global admin bypass scope SQL but never organization filtering', async () => {
    const db = new ScriptDb()
    await getElearningDepartmentStatsDaily(db, input({ isGlobalAdmin: true }))
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0]?.sql).toBe(elearningStatsDailyReadSql)
    expect(db.calls[0]?.params[0]).toBe(ORG)
  })

  it('fails closed for absent scope, missing rows and invalid identity/date', async () => {
    await expectCode(
      getElearningDepartmentStatsDaily(
        new ScriptDb(row(), {
          covered_count: '0',
          rule_count: '1',
          scope_count: '1',
        }),
        input(),
      ),
      'forbidden',
    )
    await expectCode(
      getElearningDepartmentStatsDaily(
        new ScriptDb(null),
        input({ isGlobalAdmin: true }),
      ),
      'not_found',
    )
    for (const over of [
      { departmentId: 'not-a-uuid' },
      { statsDate: '2026-02-30' },
      { orgId: '' },
      { isGlobalAdmin: 'true' },
    ]) {
      await expectCode(
        getElearningDepartmentStatsDaily(new ScriptDb(), input(over)),
        'invalid_input',
      )
    }
  })

  it('rejects malformed visible/suppressed storage without leaking values', async () => {
    for (const stored of [
      row({ completed_count: '5', assigned_count: '4' }),
      row({ completion_rate: '1.1' }),
      row({ last_error: 'secret-error-value' }),
      row({ last_projected_at: '2026-02-30T00:00:00.000Z' }),
      row({ min_group_size: 4 }),
      row({ suppressed: true }),
    ]) {
      await expectCode(
        getElearningDepartmentStatsDaily(
          new ScriptDb(stored),
          input({ isGlobalAdmin: true }),
        ),
        'unavailable',
      )
    }
  })
})
