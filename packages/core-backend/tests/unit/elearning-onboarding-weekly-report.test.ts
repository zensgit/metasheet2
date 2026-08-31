import { describe, expect, it } from 'vitest'

import {
  elearningOnboardingWeeklyReportEnqueueSql,
  materializeElearningOnboardingWeeklyReport,
  enqueueElearningOnboardingWeeklyReports,
  type ElearningOnboardingWeeklyReportDb,
  type ElearningOnboardingWeeklyReportQueryable,
} from '../../src/services/elearning-onboarding-weekly-report'

const ORG = 'acme-org'
const POLICY = '22222222-2222-4222-8222-222222222222'
const JOB = '33333333-3333-4333-8333-333333333333'
const REPORT = '44444444-4444-4444-8444-444444444444'
const WEEK = '2026-08-24'

function jobRow(
  status = 'running',
  payload: Record<string, unknown> = { policyId: POLICY, weekStart: WEEK },
) {
  return {
    occurrence_key: `policy:${POLICY}:week:${WEEK}`,
    ref: POLICY,
    status,
    payload,
  }
}

async function expectErrorCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({
    name: 'ElearningOnboardingWeeklyReportError',
    code,
  })
}

function reportRow(overrides: Record<string, unknown> = {}) {
  return {
    report_id: REPORT,
    policy_id: POLICY,
    week_start: WEEK,
    week_end: '2026-08-31',
    suppressed: false,
    min_group_size: 5,
    enqueued_count: '4',
    assigned_user_count: '3',
    failed_count: '1',
    dead_count: '0',
    ...overrides,
  }
}

function materializeDb(query: ElearningOnboardingWeeklyReportQueryable): ElearningOnboardingWeeklyReportDb {
  return {
    ...query,
    async transaction(run) {
      return run(query)
    },
  }
}

describe('e-learning onboarding weekly aggregate report', () => {
  it('enqueues only active report-enabled policies with a stable occurrence identity', async () => {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = []
    const db: ElearningOnboardingWeeklyReportQueryable = {
      async query(sql, params) {
        calls.push({ sql, params })
        return { rows: [{ week_start: WEEK, enqueued_count: '2' }] }
      },
    }

    await expect(enqueueElearningOnboardingWeeklyReports(db, { weekStart: WEEK })).resolves.toEqual({
      weekStart: WEEK,
      enqueuedCount: 2,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sql).toBe(elearningOnboardingWeeklyReportEnqueueSql)
    expect(calls[0]?.params).toEqual([WEEK])
    expect(calls[0]?.sql).toContain("policy.status = 'active'")
    expect(calls[0]?.sql).toContain('policy.weekly_report_enabled IS TRUE')
    expect(calls[0]?.sql).toContain("'policy:' || policy.id::text || ':week:'")
    expect(calls[0]?.sql).toContain("'onboarding_weekly_report'")
    expect(calls[0]?.sql).toContain(
      'ON CONFLICT (org_id, kind, occurrence_key) DO NOTHING',
    )
  })

  it('accepts an idempotent enqueue no-op without changing the identity', async () => {
    const db: ElearningOnboardingWeeklyReportQueryable = {
      async query() {
        return { rows: [{ week_start: WEEK, enqueued_count: '0' }] }
      },
    }
    await expect(enqueueElearningOnboardingWeeklyReports(db, { weekStart: WEEK })).resolves.toEqual({
      weekStart: WEEK,
      enqueuedCount: 0,
    })
  })

  it('rejects noncanonical dates and malformed closed job payloads', async () => {
    const baseQuery: ElearningOnboardingWeeklyReportQueryable = {
      async query(sql) {
        if (sql.includes('lock-weekly-report-job')) {
          return { rows: [{ payload: { policyId: POLICY, weekStart: '2026-02-30' } }] }
        }
        return { rows: [] }
      },
    }
    await expectErrorCode(enqueueElearningOnboardingWeeklyReports(baseQuery, { weekStart: '2026-02-30' }), 'invalid_input')
    await expectErrorCode(materializeElearningOnboardingWeeklyReport(materializeDb(baseQuery), { orgId: ORG, jobId: JOB }), 'invalid_input')

    const extraKeyQuery: ElearningOnboardingWeeklyReportQueryable = {
      async query(sql) {
        if (sql.includes('lock-weekly-report-job')) {
          return { rows: [{ payload: { policyId: POLICY, weekStart: WEEK, secret: 'never' } }] }
        }
        return { rows: [] }
      },
    }
    await expectErrorCode(materializeElearningOnboardingWeeklyReport(materializeDb(extraKeyQuery), { orgId: ORG, jobId: JOB }), 'invalid_input')
  })

  it('locks job and policy, aggregates counts only, and returns a closed DTO', async () => {
    const calls: string[] = []
    const db: ElearningOnboardingWeeklyReportQueryable = {
      async query(sql) {
        calls.push(sql)
        if (sql.includes('lock-weekly-report-job')) {
          return { rows: [jobRow()] }
        }
        if (sql.includes('lock-weekly-report-policy')) {
          return { rows: [{ status: 'active', weekly_report_enabled: true }] }
        }
        if (sql.includes('load-weekly-report')) return { rows: [] }
        if (sql.includes('aggregate-weekly-report')) {
          return { rows: [{ suppressed: false, min_group_size: 5, enqueued_count: '4', assigned_user_count: '3', failed_count: '1', dead_count: '0' }] }
        }
        if (sql.includes('insert-weekly-report')) return { rows: [reportRow()] }
        throw new Error('unexpected query')
      },
    }

    const result = await materializeElearningOnboardingWeeklyReport(materializeDb(db), { orgId: ORG, jobId: JOB })
    expect(result).toEqual({
      reportId: REPORT,
      policyId: POLICY,
      weekStart: WEEK,
      weekEnd: '2026-08-31',
      suppressed: false,
      minGroupSize: 5,
      enqueuedCount: 4,
      assignedUserCount: 3,
      failedCount: 1,
      deadCount: 0,
      duplicate: false,
    })
    expect(Object.keys(result).sort()).toEqual([
      'assignedUserCount',
      'deadCount',
      'duplicate',
      'enqueuedCount',
      'failedCount',
      'minGroupSize',
      'policyId',
      'reportId',
      'suppressed',
      'weekEnd',
      'weekStart',
    ])
    expect(calls[0]).toContain('FOR UPDATE')
    expect(calls[1]).toContain('FOR UPDATE')
    const aggregate = calls.find((sql) => sql.includes('aggregate-weekly-report'))!
    expect(aggregate).toContain('count(*)')
    expect(aggregate).toContain('count(effect.id)')
    expect(aggregate).toContain('effect.job_occurrence_key = job.occurrence_key')
    expect(aggregate).toContain("job.kind = 'onboarding_assign'")
    expect(aggregate).toContain('count(job.id) < 5')
    expect(aggregate).not.toContain('answer')
    expect(aggregate).not.toContain('score')
  })

  it('replays an immutable report without re-aggregating changed sources', async () => {
    const calls: string[] = []
    const db: ElearningOnboardingWeeklyReportQueryable = {
      async query(sql) {
        calls.push(sql)
        if (sql.includes('lock-weekly-report-job')) {
          return { rows: [jobRow()] }
        }
        if (sql.includes('lock-weekly-report-policy')) {
          return { rows: [{ status: 'retired', weekly_report_enabled: false }] }
        }
        if (sql.includes('load-weekly-report')) return { rows: [reportRow()] }
        throw new Error('source changes must not be queried during replay')
      },
    }

    await expect(materializeElearningOnboardingWeeklyReport(materializeDb(db), { orgId: ORG, jobId: JOB })).resolves.toEqual({
      ...reportRowToDto(),
      duplicate: true,
    })
    expect(calls.some((sql) => sql.includes('aggregate-weekly-report'))).toBe(false)
  })

  it('maps missing policy/job and malformed stored counts to closed errors', async () => {
    const missingJob: ElearningOnboardingWeeklyReportQueryable = {
      async query() { return { rows: [] } },
    }
    await expectErrorCode(materializeElearningOnboardingWeeklyReport(materializeDb(missingJob), { orgId: ORG, jobId: JOB }), 'not_found')

    const badCount: ElearningOnboardingWeeklyReportQueryable = {
      async query(sql) {
        if (sql.includes('lock-weekly-report-job')) return { rows: [jobRow()] }
        if (sql.includes('lock-weekly-report-policy')) return { rows: [{ status: 'active', weekly_report_enabled: true }] }
        if (sql.includes('load-weekly-report')) return { rows: [reportRow({ enqueued_count: '-1' })] }
        return { rows: [] }
      },
    }
    await expectErrorCode(materializeElearningOnboardingWeeklyReport(materializeDb(badCount), { orgId: ORG, jobId: JOB }), 'unavailable')
  })

  it('requires a running persisted job and suppresses all counts below five', async () => {
    const notRunning: ElearningOnboardingWeeklyReportQueryable = {
      async query(sql) {
        if (sql.includes('lock-weekly-report-job')) {
          return { rows: [jobRow('succeeded')] }
        }
        return { rows: [] }
      },
    }
    await expectErrorCode(
      materializeElearningOnboardingWeeklyReport(materializeDb(notRunning), { orgId: ORG, jobId: JOB }),
      'conflict',
    )

    const wrongOccurrence: ElearningOnboardingWeeklyReportQueryable = {
      async query(sql) {
        if (sql.includes('lock-weekly-report-job')) {
          return { rows: [{ ...jobRow(), occurrence_key: 'policy:wrong:week:2026-08-24' }] }
        }
        return { rows: [] }
      },
    }
    await expectErrorCode(
      materializeElearningOnboardingWeeklyReport(
        materializeDb(wrongOccurrence),
        { orgId: ORG, jobId: JOB },
      ),
      'conflict',
    )

    const suppressed: ElearningOnboardingWeeklyReportQueryable = {
      async query(sql) {
        if (sql.includes('lock-weekly-report-job')) {
          return { rows: [jobRow()] }
        }
        if (sql.includes('lock-weekly-report-policy')) {
          return { rows: [{ status: 'active', weekly_report_enabled: true }] }
        }
        if (sql.includes('load-weekly-report')) return { rows: [] }
        if (sql.includes('aggregate-weekly-report')) {
          return { rows: [{ suppressed: true, min_group_size: 5, enqueued_count: null, assigned_user_count: null, failed_count: null, dead_count: null }] }
        }
        if (sql.includes('insert-weekly-report')) {
          return { rows: [reportRow({ suppressed: true, enqueued_count: null, assigned_user_count: null, failed_count: null, dead_count: null })] }
        }
        return { rows: [] }
      },
    }
    await expect(materializeElearningOnboardingWeeklyReport(materializeDb(suppressed), { orgId: ORG, jobId: JOB })).resolves.toEqual({
      reportId: REPORT,
      policyId: POLICY,
      weekStart: WEEK,
      weekEnd: '2026-08-31',
      suppressed: true,
      minGroupSize: 5,
      enqueuedCount: null,
      assignedUserCount: null,
      failedCount: null,
      deadCount: null,
      duplicate: false,
    })
  })
})

function reportRowToDto() {
  return {
    reportId: REPORT,
    policyId: POLICY,
    weekStart: WEEK,
    weekEnd: '2026-08-31',
    suppressed: false,
    minGroupSize: 5,
    enqueuedCount: 4,
    assignedUserCount: 3,
    failedCount: 1,
    deadCount: 0,
  }
}
