import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import {
  createElearningAnalyticsExport,
  downloadElearningAnalyticsExport,
  elearningAnalyticsExportCsvCell,
  ElearningAnalyticsExportError,
  hashElearningAnalyticsExportRequest,
  materializeElearningAnalyticsExport,
  type ElearningAnalyticsExportDb,
  type ElearningAnalyticsExportQueryable,
} from '../../src/services/elearning-analytics-export'
import {
  deriveElearningAnalyticsExportStorageKey,
  getElearningAnalyticsExportStorage,
  setElearningAnalyticsExportStorageForTest,
} from '../../src/services/elearning-analytics-export-storage'

const ORG = 'org-export'
const ACTOR = 'actor-export'
const REQUEST = '11111111-1111-4111-8111-111111111111'
const EXPORT = '22222222-2222-4222-8222-222222222222'
const DEPARTMENT = '33333333-3333-4333-8333-333333333333'
const PERIOD_START = '2026-08-01T00:00:00.000Z'
const PERIOD_END = '2026-09-01T00:00:00.000Z'
const EXPIRES = '2099-09-07T00:00:00.000Z'
const FLAGS = { ELEARNING_ENABLED: 'true', ELEARNING_ANALYTICS_ENABLED: 'true' }

function storedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    export_id: EXPORT,
    actor_id: ACTOR,
    request_hash: hashElearningAnalyticsExportRequest({
      actorId: ACTOR,
      departmentId: DEPARTMENT,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    }),
    request_hash_version: 1,
    department_id: DEPARTMENT,
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    status: 'pending',
    storage_key: null,
    file_sha256: null,
    file_size_bytes: null,
    expires_at: EXPIRES,
    completed_at: null,
    error_code: null,
    expired_by_clock: false,
    ...overrides,
  }
}

function result(rows: Array<Record<string, unknown>>) {
  return { rows, rowCount: rows.length }
}

function dbFromQuery(
  query: ElearningAnalyticsExportQueryable['query'],
): ElearningAnalyticsExportDb {
  const db = { query } as ElearningAnalyticsExportDb
  db.transaction = async (run) => run(db)
  return db
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    actorId: ACTOR,
    isGlobalAdmin: true,
    requestId: REQUEST,
    departmentId: DEPARTMENT,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    ...overrides,
  }
}

describe('e-learning analytics export authority', () => {
  it('fails closed unless master and analytics are exact true', async () => {
    const db = dbFromQuery(vi.fn())
    for (const env of [
      {},
      { ELEARNING_ENABLED: 'true' },
      { ELEARNING_ENABLED: 'true', ELEARNING_ANALYTICS_ENABLED: 'TRUE' },
    ]) {
      await expect(createElearningAnalyticsExport(db, createInput(), env)).rejects.toMatchObject({
        code: 'disabled',
      })
    }
  })

  it('derives an org-opaque storage key and has no production storage fallback', async () => {
    const key = deriveElearningAnalyticsExportStorageKey({ orgId: ORG, exportId: EXPORT })
    expect(key).toMatch(
      new RegExp(`^elearning-analytics-exports/[0-9a-f]{32}/${EXPORT}\\.csv$`),
    )
    expect(key).not.toContain(ORG)
    setElearningAnalyticsExportStorageForTest(null)
    try {
      await expect(getElearningAnalyticsExportStorage({ NODE_ENV: 'production' }).put(
        key,
        Buffer.from('not-written'),
      )).rejects.toMatchObject({ code: 'unavailable' })
    } finally {
      setElearningAnalyticsExportStorageForTest(null)
    }
  })

  it('creates request and both durable jobs in one transaction', async () => {
    const statements: string[] = []
    const enqueueParams: unknown[][] = []
    const db = dbFromQuery(async (sql, params) => {
      statements.push(sql)
      if (sql.includes('elearning-analytics-export:actor')) return result([{ ok: 1 }])
      if (sql.includes('elearning-analytics-export:request')) return result([])
      if (sql.includes('elearning-analytics-export:create')) return result([storedRow()])
      if (sql.includes('elearning-analytics-export:enqueue')) enqueueParams.push(params ?? [])
      return result([])
    })
    await expect(createElearningAnalyticsExport(db, createInput(), FLAGS)).resolves.toEqual({
      exportId: EXPORT,
      departmentId: DEPARTMENT,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      status: 'pending',
      expiresAt: EXPIRES,
      completedAt: null,
      errorCode: null,
      duplicate: false,
    })
    expect(statements.some((sql) => sql.includes('elearning-analytics-export:enqueue'))).toBe(true)
    expect(enqueueParams).toEqual([expect.arrayContaining([
      'analytics_export',
      'analytics_export_cleanup',
    ])])
  })

  it('replays the same hash and rejects a changed payload values-free', async () => {
    const replayDb = dbFromQuery(async (sql) => {
      if (sql.includes('elearning-analytics-export:actor')) return result([{ ok: 1 }])
      if (sql.includes('elearning-analytics-export:request')) return result([storedRow()])
      return result([])
    })
    await expect(createElearningAnalyticsExport(replayDb, createInput(), FLAGS)).resolves.toMatchObject({
      duplicate: true,
      exportId: EXPORT,
    })
    await expect(createElearningAnalyticsExport(replayDb, createInput({
      periodEnd: '2026-10-01T00:00:00.000Z',
    }), FLAGS)).rejects.toEqual(new ElearningAnalyticsExportError('conflict'))
  })

  it('materializes suppression-safe formula-safe CSV with an idempotent storage effect', async () => {
    const writes: Array<{ key: string; content: Buffer }> = []
    const db = dbFromQuery(async (sql) => {
      if (sql.includes('materialize-lock')) return result([storedRow()])
      if (sql.includes('elearning-analytics-export:stats')) {
        return result([{
          stats_date: '2026-08-01',
          period_start: '2026-08-01T00:00:00.000Z',
          period_end: '2026-08-02T00:00:00.000Z',
          source_version: '=unsafe',
          suppressed: true,
          min_group_size: 5,
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
        }])
      }
      if (sql.includes('materialize-claim') || sql.includes('materialize-complete')) {
        return result([{ id: EXPORT }])
      }
      return result([])
    })
    const storage = {
      async put(key: string, content: Buffer) {
        writes.push({ key, content })
      },
      async get() {
        throw new Error('not expected')
      },
      async delete() {},
    }
    await expect(materializeElearningAnalyticsExport(
      db,
      { orgId: ORG, exportId: EXPORT },
      storage,
      FLAGS,
    )).resolves.toEqual({ outcome: 'materialized', exportId: EXPORT })
    expect(writes).toHaveLength(1)
    expect(writes[0]?.key).toMatch(/^elearning-analytics-exports\/[0-9a-f]{32}\//)
    const csv = writes[0]?.content.toString('utf8') ?? ''
    expect(csv).toContain('"true","5","",""')
    expect(csv).toContain('"\'=unsafe"')
    expect(csv).not.toContain('answer')
    expect(csv).not.toContain('grade')
  })

  it('reuses an identical already-written object after an uncertain storage effect', async () => {
    let content = Buffer.alloc(0)
    const db = dbFromQuery(async (sql, params) => {
      if (sql.includes('materialize-lock')) return result([storedRow()])
      if (sql.includes('elearning-analytics-export:stats')) return result([])
      if (sql.includes('materialize-claim')) {
        content = Buffer.from('\uFEFF' + '"departmentId","statsDate","periodStart","periodEnd","sourceVersion","suppressed","minGroupSize","assignedCount","completedCount","completionRate","creditAverage","creditTotal","examParticipantCount","learnerCount","learningSeconds","memberCount","overdueCount"\r\n')
        expect(params?.[3]).toBe(createHash('sha256').update(content).digest('hex'))
        return result([{ id: EXPORT }])
      }
      if (sql.includes('materialize-complete')) return result([{ id: EXPORT }])
      return result([])
    })
    const storage = {
      async put() {
        throw new Error('outcome unknown')
      },
      async get() {
        return content
      },
      async delete() {},
    }
    await expect(materializeElearningAnalyticsExport(
      db,
      { orgId: ORG, exportId: EXPORT },
      storage,
      FLAGS,
    )).resolves.toMatchObject({ outcome: 'materialized' })
  })

  it('rejects a suppressed projection if any protected metric is present', async () => {
    const storagePut = vi.fn()
    const db = dbFromQuery(async (sql) => {
      if (sql.includes('materialize-lock')) return result([storedRow()])
      if (sql.includes('elearning-analytics-export:stats')) {
        return result([{
          stats_date: '2026-08-01',
          period_start: '2026-08-01T00:00:00.000Z',
          period_end: '2026-08-02T00:00:00.000Z',
          source_version: 'projection',
          suppressed: true,
          min_group_size: 5,
          assigned_count: '1',
          completed_count: null,
          completion_rate: null,
          credit_average: null,
          credit_total: null,
          exam_participant_count: null,
          learner_count: null,
          learning_seconds: null,
          member_count: null,
          overdue_count: null,
        }])
      }
      if (sql.includes('materialize-claim')) return result([{ id: EXPORT }])
      return result([])
    })
    await expect(materializeElearningAnalyticsExport(
      db,
      { orgId: ORG, exportId: EXPORT },
      { put: storagePut, get: vi.fn(), delete: vi.fn() },
      FLAGS,
    )).rejects.toMatchObject({ code: 'unavailable' })
    expect(storagePut).not.toHaveBeenCalled()
  })

  it('rechecks actor and current scope before a digest-checked download', async () => {
    const content = Buffer.from('aggregate-only', 'utf8')
    const row = storedRow({
      status: 'succeeded',
      storage_key: `elearning-analytics-exports/a/${EXPORT}.csv`,
      file_sha256: createHash('sha256').update(content).digest('hex'),
      file_size_bytes: content.length,
      completed_at: '2026-08-30T00:00:00.000Z',
    })
    const db = dbFromQuery(async (sql) => {
      if (sql.includes('elearning-analytics-export:actor')) return result([{ ok: 1 }])
      if (sql.includes('elearning-analytics-export:read')) return result([row])
      return result([])
    })
    await expect(downloadElearningAnalyticsExport(
      db,
      { orgId: ORG, actorId: ACTOR, isGlobalAdmin: true, exportId: EXPORT },
      { put: vi.fn(), get: async () => content, delete: vi.fn() },
      FLAGS,
    )).resolves.toEqual({
      exportId: EXPORT,
      filename: `elearning-department-stats-${EXPORT}.csv`,
      contentType: 'text/csv; charset=utf-8',
      content,
    })
  })

  it('formula-protects every spreadsheet control prefix', () => {
    for (const value of ['=1+1', '+cmd', '-2', '@name', '\tcell', '\rcell']) {
      expect(elearningAnalyticsExportCsvCell(value)).toBe(`"'${value}"`)
    }
    expect(elearningAnalyticsExportCsvCell('plain')).toBe('"plain"')
  })
})
