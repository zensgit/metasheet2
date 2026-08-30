import { describe, expect, it } from 'vitest'

import {
  ElearningStatsDailyProjectionError,
  elearningStatsDailySql,
  projectElearningDepartmentStatsDaily,
  type ElearningStatsDailyDb,
  type ElearningStatsDailyQueryable,
} from '../../src/services/elearning-stats-daily-projection'

const ORG = 'org-stats-daily'
const DEPARTMENT = '11111111-1111-4111-8111-111111111111'
const INTEGRATION = '22222222-2222-4222-8222-222222222222'
const ENABLED = {
  ELEARNING_ANALYTICS_ENABLED: 'true',
  ELEARNING_ENABLED: 'true',
} as NodeJS.ProcessEnv

interface Call {
  sql: string
  params: unknown[]
}

interface ScriptOptions {
  aggregate?: Record<string, unknown>
  existing?: Record<string, unknown> | null
  identity?: Record<string, unknown> | null
  throwAt?: string
  upsertVersion?: string
}

function aggregate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assigned_count: '4',
    completed_count: '3',
    credit_total: '25',
    department_found: true,
    exam_participant_count: '2',
    learner_count: '4',
    learning_seconds: '7200',
    member_count: '5',
    overdue_count: '1',
    source_version: '2026-08-30T01:02:03.123456Z',
    ...over,
  }
}

class ScriptDb implements ElearningStatsDailyDb, ElearningStatsDailyQueryable {
  readonly calls: Call[] = []
  readonly transactionCalls: Call[] = []

  constructor(private readonly options: ScriptOptions = {}) {}

  async transaction<T>(run: (tx: ElearningStatsDailyQueryable) => Promise<T>): Promise<T> {
    return run({
      query: async (sql, params = []) => {
        this.transactionCalls.push({ sql, params })
        return this.respond(sql)
      },
    })
  }

  async query(sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params })
    return this.respond(sql)
  }

  private respond(sql: string) {
    if (this.options.throwAt && sql.includes(this.options.throwAt)) {
      throw new Error('secret-database-value')
    }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 }
    if (sql.includes('elearning-stats-daily:department-identity')) {
      const row = this.options.identity === undefined
        ? {
            directory_integration_id: INTEGRATION,
            directory_provider: 'dingtalk',
          }
        : this.options.identity
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (sql.includes('elearning-department-stats:aggregate')) {
      return { rows: [this.options.aggregate ?? aggregate()], rowCount: 1 }
    }
    if (sql.includes('elearning-stats-daily:existing')) {
      const row = this.options.existing ?? null
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (sql.includes('elearning-stats-daily:refresh-noop')) {
      return { rows: [{ projected_version: '7' }], rowCount: 1 }
    }
    if (sql.includes('elearning-stats-daily:upsert')) {
      return {
        rows: [{ projected_version: this.options.upsertVersion ?? '1' }],
        rowCount: 1,
      }
    }
    if (sql.includes('elearning-stats-daily:record-error')) {
      return { rows: [], rowCount: 0 }
    }
    throw new Error('unexpected query')
  }
}

function input(over: Record<string, unknown> = {}) {
  return {
    departmentId: DEPARTMENT,
    orgId: ORG,
    statsDate: '2026-08-30',
    ...over,
  }
}

async function expectCode(
  action: Promise<unknown>,
  code: ElearningStatsDailyProjectionError['code'],
): Promise<void> {
  try {
    await action
    throw new Error('expected projection error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningStatsDailyProjectionError)
    expect((error as ElearningStatsDailyProjectionError).code).toBe(code)
    expect((error as Error).message).toBe(code)
    expect(`${String(error)}\n${(error as Error).stack ?? ''}`).not.toContain(
      'secret-database-value',
    )
  }
}

describe('e-learning stats daily projection', () => {
  it('does no database work unless master and analytics flags are exact true', async () => {
    for (const env of [
      {},
      { ELEARNING_ENABLED: 'true' },
      { ELEARNING_ANALYTICS_ENABLED: 'true', ELEARNING_ENABLED: 'TRUE' },
    ]) {
      const db = new ScriptDb()
      await expectCode(
        projectElearningDepartmentStatsDaily(db, input(), env as NodeJS.ProcessEnv),
        'unavailable',
      )
      expect(db.calls).toEqual([])
      expect(db.transactionCalls).toEqual([])
    }
  })

  it('serializes, resolves same-org identity and writes a visible UTC-day row', async () => {
    const db = new ScriptDb()
    await expect(projectElearningDepartmentStatsDaily(db, input(), ENABLED)).resolves.toEqual({
      outcome: 'projected',
      projectedVersion: 1,
      suppressed: false,
    })
    expect(db.transactionCalls.map((call) => call.sql)).toEqual([
      expect.stringContaining('pg_advisory_xact_lock'),
      elearningStatsDailySql.departmentIdentity,
      expect.stringContaining('elearning-department-stats:aggregate'),
      elearningStatsDailySql.existing,
      elearningStatsDailySql.upsert,
    ])
    expect(db.transactionCalls[0]?.params).toEqual([
      `elearning-stats-daily:${ORG}:${DEPARTMENT}:2026-08-30`,
    ])
    expect(db.transactionCalls[1]?.params).toEqual([ORG, DEPARTMENT])
    const write = db.transactionCalls.at(-1)
    expect(write?.params.slice(0, 12)).toEqual([
      ORG,
      INTEGRATION,
      'dingtalk',
      DEPARTMENT,
      '2026-08-30',
      '2026-08-30T00:00:00.000Z',
      '2026-08-31T00:00:00.000Z',
      '2026-08-30T01:02:03.123456Z',
      expect.stringMatching(/^[a-f0-9]{64}$/),
      false,
      5,
      '4',
    ])
    expect(write?.params.slice(12)).toEqual([
      '3',
      '0.750000000',
      '5.000000000',
      '25',
      '2',
      '4',
      '7200',
      '5',
      '1',
    ])
  })

  it('writes no numeric values for a suppressed department', async () => {
    const db = new ScriptDb({ aggregate: aggregate({ member_count: '4' }) })
    await expect(projectElearningDepartmentStatsDaily(db, input(), ENABLED)).resolves.toEqual({
      outcome: 'projected',
      projectedVersion: 1,
      suppressed: true,
    })
    const write = db.transactionCalls.at(-1)
    expect(write?.sql).toBe(elearningStatsDailySql.upsert)
    expect(write?.params[9]).toBe(true)
    expect(write?.params.slice(11)).toEqual(Array.from({ length: 10 }, () => null))
  })

  it('treats identical materialized content as a no-op despite source clock drift', async () => {
    const first = new ScriptDb()
    await projectElearningDepartmentStatsDaily(first, input(), ENABLED)
    const digest = first.transactionCalls.at(-1)?.params[8]
    const replay = new ScriptDb({
      aggregate: aggregate({ source_version: '2026-08-30T02:03:04.123456Z' }),
      existing: {
        last_error: null,
        payload_digest: digest,
        projected_version: '7',
      },
    })
    await expect(
      projectElearningDepartmentStatsDaily(replay, input(), ENABLED),
    ).resolves.toEqual({ outcome: 'noop', projectedVersion: 7, suppressed: false })
    expect(replay.transactionCalls.some((call) => (
      call.sql === elearningStatsDailySql.upsert
    ))).toBe(false)
    expect(replay.transactionCalls.at(-1)).toEqual({
      params: [
        ORG,
        DEPARTMENT,
        '2026-08-30',
        digest,
        '2026-08-30T02:03:04.123456Z',
      ],
      sql: elearningStatsDailySql.refreshNoop,
    })
  })

  it('refreshes successful no-op metadata and clears errors without changing version', async () => {
    const first = new ScriptDb()
    await projectElearningDepartmentStatsDaily(first, input(), ENABLED)
    const replay = new ScriptDb({
      existing: {
        last_error: 'RECONCILE_FAILED',
        payload_digest: first.transactionCalls.at(-1)?.params[8],
        projected_version: '7',
      },
    })
    await expect(
      projectElearningDepartmentStatsDaily(replay, input(), ENABLED),
    ).resolves.toEqual({ outcome: 'noop', projectedVersion: 7, suppressed: false })
    expect(replay.transactionCalls.at(-1)?.sql).toBe(elearningStatsDailySql.refreshNoop)
  })

  it('records a values-free reconcile code when an existing row cannot refresh', async () => {
    const db = new ScriptDb({
      existing: {
        last_error: null,
        payload_digest: '0'.repeat(64),
        projected_version: '1',
      },
      throwAt: 'elearning-stats-daily:upsert',
    })
    await expectCode(projectElearningDepartmentStatsDaily(db, input(), ENABLED), 'unavailable')
    expect(db.calls).toEqual([{
      params: [ORG, DEPARTMENT, '2026-08-30', 'RECONCILE_FAILED'],
      sql: elearningStatsDailySql.recordError,
    }])
  })

  it('fails closed for invalid dates, absent departments and malformed stored rows', async () => {
    for (const statsDate of ['2026-02-30', '2026-8-30', '']) {
      await expectCode(
        projectElearningDepartmentStatsDaily(
          new ScriptDb(),
          input({ statsDate }),
          ENABLED,
        ),
        'invalid_input',
      )
    }
    await expectCode(
      projectElearningDepartmentStatsDaily(
        new ScriptDb({ identity: null }),
        input(),
        ENABLED,
      ),
      'not_found',
    )
    await expectCode(
      projectElearningDepartmentStatsDaily(
        new ScriptDb({ upsertVersion: '0' }),
        input(),
        ENABLED,
      ),
      'unavailable',
    )
  })
})
