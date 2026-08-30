import { describe, expect, it } from 'vitest'

import {
  ElearningStatsDailyJobProducerError,
  elearningStatsDailyJobProducerSql,
  enqueueElearningStatsDailyJobs,
  type ElearningStatsDailyJobProducerDb,
} from '../../src/services/elearning-stats-daily-job-producer'

const ENABLED = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_ANALYTICS_ENABLED: 'true',
} as NodeJS.ProcessEnv

function dbWith(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = []
  const db: ElearningStatsDailyJobProducerDb = {
    async query(sql, params) {
      calls.push({ sql, params })
      return { rows, rowCount: rows.length }
    },
  }
  return { calls, db }
}

async function expectUnavailable(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: 'ElearningStatsDailyJobProducerError',
    code: 'unavailable',
  })
}

describe('e-learning stats daily job producer', () => {
  it('does no database work unless master and analytics are exact true', async () => {
    for (const env of [
      {},
      { ELEARNING_ENABLED: 'true' },
      { ELEARNING_ENABLED: 'true', ELEARNING_ANALYTICS_ENABLED: 'TRUE' },
    ]) {
      const { calls, db } = dbWith([])
      await expectUnavailable(enqueueElearningStatsDailyJobs(db, env as NodeJS.ProcessEnv))
      expect(calls).toEqual([])
    }
  })

  it('enqueues the completed previous UTC day with stable effect identity', async () => {
    const { calls, db } = dbWith([{
      stats_date: '2026-08-29',
      enqueued_count: '2',
    }])
    await expect(enqueueElearningStatsDailyJobs(db, ENABLED)).resolves.toEqual({
      statsDate: '2026-08-29',
      enqueuedCount: 2,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.params).toBeUndefined()
    expect(calls[0]?.sql).toBe(elearningStatsDailyJobProducerSql)
    expect(calls[0]?.sql).toContain("clock_timestamp() AT TIME ZONE 'UTC'")
    expect(calls[0]?.sql).toContain("integration.status = 'active'")
    expect(calls[0]?.sql).toContain('department.is_active IS TRUE')
    expect(calls[0]?.sql).toContain("'stats_daily_project'")
    expect(calls[0]?.sql).toContain("'department:' || lower(department.id::text)")
    expect(calls[0]?.sql).toContain("jsonb_build_object(\n      'statsDate'")
    expect(calls[0]?.sql).toContain(
      'ON CONFLICT (org_id, kind, occurrence_key) DO NOTHING',
    )
  })

  it('accepts an idempotent no-op and rejects malformed stored results', async () => {
    const replay = dbWith([{ stats_date: '2026-08-29', enqueued_count: '0' }])
    await expect(enqueueElearningStatsDailyJobs(replay.db, ENABLED)).resolves.toEqual({
      statsDate: '2026-08-29',
      enqueuedCount: 0,
    })

    for (const rows of [
      [],
      [
        { stats_date: '2026-08-29', enqueued_count: '0' },
        { stats_date: '2026-08-29', enqueued_count: '0' },
      ],
      [{ stats_date: '2026-02-30', enqueued_count: '0' }],
      [{ stats_date: '2026-08-29', enqueued_count: '-1' }],
      [{ stats_date: '2026-08-29', enqueued_count: '1.5' }],
      [{ stats_date: '2026-08-29', enqueued_count: Number.MAX_SAFE_INTEGER + 1 }],
    ]) {
      await expectUnavailable(enqueueElearningStatsDailyJobs(dbWith(rows).db, ENABLED))
    }
  })

  it('maps database errors to a values-free unavailable code', async () => {
    const db: ElearningStatsDailyJobProducerDb = {
      async query() {
        throw new Error('sensitive database detail')
      },
    }
    await expectUnavailable(enqueueElearningStatsDailyJobs(db, ENABLED))
  })
})
