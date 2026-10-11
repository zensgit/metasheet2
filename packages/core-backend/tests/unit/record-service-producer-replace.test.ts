/**
 * P2 durable-delivery P1 #2b — family 4 (record-service CRUD) REPLACE wiring, pure-unit (no DB).
 *
 * The real-DB family-4 suite (`multitable-automation-producer-family4-realdb.test.ts`) is the site golden;
 * it only runs inside the DATABASE_URL-gated CI step. THIS file keeps the load-bearing suppression guard in
 * the default no-DB unit job: with `AUTOMATION_DURABLE_DELIVERY_ENABLED=true`, the REAL createRecord /
 * patchRecord / deleteRecord must (a) NOT emit on the legacy bus (REPLACE, not keep-both) and (b) attempt
 * the same-transaction outbox enqueue (positive control — "no emit" alone could be faked by a dead site).
 * With the flag OFF (default), the legacy emit fires byte-identically and the outbox is never touched.
 *
 * The mock pool answers the seam's runtime xid probe (`pg_current_xact_id`) with a constant xid, which is
 * exactly what a REAL in-transaction handle looks like to the probe — the services hand the seam their
 * `pool.transaction` handle, so both probe statements go through one "connection".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RecordService, type ConnectionPool, type QueryFn } from '../../src/multitable/record-service'
import * as producerEmit from '../../src/multitable/automation-producer-emit'

vi.mock('../../src/multitable/realtime-publish', () => ({
  publishMultitableSheetRealtime: vi.fn(),
}))

const FLAG = 'AUTOMATION_DURABLE_DELIVERY_ENABLED'
const SCHEMA_REVISION = '12345678-1234-4234-8234-123456789abc'

const fullCapabilities = {
  canRead: true,
  canCreateRecord: true,
  canEditRecord: true,
  canDeleteRecord: true,
  canManageFields: true,
  canManageSheetAccess: true,
  canManageViews: true,
  canComment: true,
  canManageAutomation: true,
  canExport: true,
  canSendNotification: false,
  canSubmitApproval: false,
}
const access = { userId: 'user_1', permissions: ['multitable:write'], isAdminRole: false }

function createMockEventBus() {
  return { emit: vi.fn(), publish: vi.fn(), subscribe: vi.fn().mockReturnValue('sub_1'), unsubscribe: vi.fn() }
}

type QueryResponse = { rows: unknown[]; rowCount?: number | null }

function createMockPool(afterImages: { created?: unknown; updated?: unknown; oversized?: boolean } = {}): ConnectionPool & { queryMock: ReturnType<typeof vi.fn> } {
  const queryMock = vi.fn(async (sql: string, _params?: unknown[]): Promise<QueryResponse> => {
    if (sql === "SELECT current_setting('transaction_isolation') AS isolation") return { rows: [{ isolation: 'read committed' }] }
    if (/^(?:SAVEPOINT|RELEASE SAVEPOINT) automation_record_schema_capture$/u.test(sql)) return { rows: [] }
    if (sql.startsWith('LOCK TABLE meta_sheets, meta_fields,')) return { rows: [] }
    if (sql.includes('pg_catalog.pg_locks') && sql.includes('AS held')) return { rows: [{ held: true }] }
    if (sql.includes('pg_catalog.pg_class') && sql.includes('AS consistent')) return { rows: [{ consistent: true }] }
    if (sql === 'SELECT id, deleted_at FROM meta_sheets WHERE id = $1') return { rows: [{ id: _params?.[0], deleted_at: null }] }
    if (sql.includes('SELECT revision FROM automation_read_material_epochs')) return { rows: [{ revision: SCHEMA_REVISION }] }
    if (sql.includes('INSERT INTO meta_automation_record_after_images')) {
      return { rows: [{ outbox_id: _params?.[0] }], rowCount: 1 }
    }
    // P1#2 seam: the pg-transaction-guard probe — a constant xid means "one ongoing transaction".
    if (sql.includes('pg_current_xact_id')) {
      return { rows: [{ xid: '4242' }] }
    }
    if (sql.includes('INSERT INTO meta_automation_outbox_consumer')) {
      return { rows: [], rowCount: 2 }
    }
    if (sql.includes('INSERT INTO meta_automation_outbox')) {
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
      return { rows: [{ id: 'sheet_ops' }] }
    }
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1')) {
      return { rows: [{ id: 'fld_title', name: 'Title', type: 'string', property: {} }] }
    }
    if (sql.includes('SELECT pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO meta_records') && sql.includes('RETURNING version')) {
      return { rows: [{ version: 1,
        ...(Object.hasOwn(afterImages, 'created') ? { automation_after_image_json: afterImages.created } : {}),
        automation_after_image_oversized: afterImages.oversized === true,
      }] }
    }
    if (sql.includes('INSERT INTO meta_record_revisions')) {
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('FROM meta_record_subscriptions')) {
      return { rows: [] }
    }
    if (sql.includes('SELECT id, sheet_id, created_by, locked, locked_by') && sql.includes('FROM meta_records WHERE id = $1')) {
      return {
        rows: [{ id: 'rec_existing', sheet_id: 'sheet_ops', created_by: 'user_1', locked: false, locked_by: null, created_at: null, updated_at: null }],
      }
    }
    if (sql.includes('SELECT id, sheet_id, version, data FROM meta_records WHERE id = $1 FOR UPDATE')) {
      return { rows: [{ id: 'rec_existing', sheet_id: 'sheet_ops', version: 4, data: { fld_title: 'Before' } }] }
    }
    if (sql.startsWith('SELECT id, version, data, created_by, locked, locked_by') && sql.includes('FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE')) {
      return { rows: [{ id: 'rec_existing', version: 4, data: { fld_title: 'Before' }, automation_after_image_json: '{"fld_title": "Before", "precise": 9007199254740993}', created_by: 'user_1', locked: false, locked_by: null }] }
    }
    if (sql.includes('UPDATE meta_records') && sql.includes('RETURNING version')) {
      return { rows: [{ version: 5,
        ...(Object.hasOwn(afterImages, 'updated') ? { automation_after_image_json: afterImages.updated } : {}),
        automation_after_image_oversized: afterImages.oversized === true,
      }], rowCount: 1 }
    }
    if (sql.includes('SELECT id, config FROM meta_views WHERE sheet_id = $1 AND type = $2')) {
      return { rows: [] }
    }
    if (sql.includes('DELETE FROM meta_links WHERE record_id = $1 OR foreign_record_id = $1')) {
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('DELETE FROM meta_records WHERE id = $1')) {
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('SELECT base_id FROM meta_sheets WHERE id = $1')) {
      return { rows: [{ base_id: 'base_ops' }] }
    }
    if (sql.includes('INSERT INTO meta_records_trash')) {
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Unhandled SQL in test: ${sql}`)
  })
  return {
    query: queryMock as unknown as QueryFn,
    queryMock,
    transaction: async <T>(handler: (client: { query: QueryFn }) => Promise<T>) =>
      handler({ query: queryMock as unknown as QueryFn }),
  }
}

const outboxInsertsOf = (pool: ReturnType<typeof createMockPool>) =>
  pool.queryMock.mock.calls.filter(
    ([sql]) => String(sql).includes('INSERT INTO meta_automation_outbox') && !String(sql).includes('outbox_consumer'),
  )

describe('P1#2b family 4 — record-service REPLACE wiring (unit, no DB)', () => {
  let pool: ReturnType<typeof createMockPool>
  let eventBus: ReturnType<typeof createMockEventBus>

  beforeEach(() => {
    vi.clearAllMocks()
    pool = createMockPool()
    eventBus = createMockEventBus()
  })

  afterEach(() => {
    delete process.env[FLAG]
  })

  const svc = () => new RecordService(pool, eventBus as never)

  describe('flag ON — durable enqueue REPLACES the legacy emit at the real site', () => {
    beforeEach(() => {
      process.env[FLAG] = 'true'
    })

    it('createRecord: legacy bus SUPPRESSED; same-txn outbox enqueue attempted (positive control)', async () => {
      await svc().createRecord({ sheetId: 'sheet_ops', data: { fld_title: 'Alpha' }, actorId: 'user_1', capabilities: { ...fullCapabilities } })
      expect(eventBus.emit).not.toHaveBeenCalled()
      expect(outboxInsertsOf(pool).length).toBeGreaterThan(0)
      expect(pool.queryMock).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO meta_automation_outbox_consumer'), expect.anything())
    })

    it('patchRecord: legacy bus SUPPRESSED; same-txn outbox enqueue attempted', async () => {
      await svc().patchRecord({ recordId: 'rec_existing', sheetId: 'sheet_ops', data: { fld_title: 'After' }, actorId: 'user_1', access, capabilities: { ...fullCapabilities } })
      expect(eventBus.emit).not.toHaveBeenCalled()
      expect(outboxInsertsOf(pool).length).toBeGreaterThan(0)
    })

    it('create captures the schema after the sheet fence and before field validation/DML, then persists its original revision', async () => {
      pool = createMockPool({ created: '{"fld_title": "Alpha"}' })
      await svc().createRecord({ sheetId: 'sheet_ops', data: { fld_title: 'Alpha' }, actorId: 'user_1', capabilities: { ...fullCapabilities } })
      const statements = pool.queryMock.mock.calls.map(([sql]) => String(sql))
      const captureIndex = statements.indexOf('SAVEPOINT automation_record_schema_capture')
      expect(captureIndex).toBeGreaterThan(statements.findIndex(sql => sql.includes('SELECT pg_advisory_xact_lock')))
      expect(captureIndex).toBeLessThan(statements.findIndex(sql => sql.includes('FROM meta_fields WHERE sheet_id = $1')))
      expect(captureIndex).toBeLessThan(statements.findIndex(sql => sql.includes('INSERT INTO meta_records')))
      expect(statements.filter(sql => sql === 'SAVEPOINT automation_record_schema_capture')).toHaveLength(1)
      const capture = pool.queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO meta_automation_record_after_images'))
      expect(capture?.[1]?.[8]).toBe(SCHEMA_REVISION)
      expect(JSON.parse(String(outboxInsertsOf(pool)[0]?.[1]?.[2]))).not.toHaveProperty('schema')
    })

    it.each([{ fld_title: 'After' }, {}])('patch captures once before the locked source row, including no-op input %j', async data => {
      pool = createMockPool({ updated: '{"fld_title": "After"}' })
      await svc().patchRecord({ recordId: 'rec_existing', sheetId: 'sheet_ops', data, actorId: 'user_1', access, capabilities: { ...fullCapabilities } })
      const statements = pool.queryMock.mock.calls.map(([sql]) => String(sql))
      expect(statements.filter(sql => sql === 'SAVEPOINT automation_record_schema_capture')).toHaveLength(1)
      expect(statements.indexOf('SAVEPOINT automation_record_schema_capture')).toBeLessThan(statements.findIndex(sql => sql.startsWith('SELECT id, version, data') && sql.includes('FOR UPDATE')))
      const capture = pool.queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO meta_automation_record_after_images'))
      expect(capture?.[1]?.[8]).toBe(SCHEMA_REVISION)
      expect(eventBus.emit).not.toHaveBeenCalled()
    })

    it('deleteRecord: legacy bus SUPPRESSED; same-txn outbox enqueue attempted', async () => {
      await svc().deleteRecord({
        recordId: 'rec_existing',
        actorId: 'user_1',
        access,
        resolveSheetAccess: async () => ({ capabilities: { ...fullCapabilities } }),
      })
      expect(eventBus.emit).not.toHaveBeenCalled()
      expect(outboxInsertsOf(pool).length).toBeGreaterThan(0)
    })
  })

  describe('flag OFF (default) — legacy emit byte-identical, outbox never touched', () => {
    it('createRecord: emits the legacy created event; no outbox statement', async () => {
      const result = await svc().createRecord({ sheetId: 'sheet_ops', data: { fld_title: 'Alpha' }, actorId: 'user_1', capabilities: { ...fullCapabilities } })
      expect(eventBus.emit).toHaveBeenCalledTimes(1)
      expect(eventBus.emit).toHaveBeenCalledWith('multitable.record.created', {
        sheetId: 'sheet_ops',
        recordId: result.recordId,
        data: { fld_title: 'Alpha' },
        actorId: 'user_1',
        _eventId: expect.any(String),
      })
      expect(outboxInsertsOf(pool)).toHaveLength(0)
      expect(pool.queryMock.mock.calls.some(([sql]) => String(sql).includes('automation_record_schema'))).toBe(false)
    })

    it('patchRecord: emits the legacy updated event; no outbox statement', async () => {
      await svc().patchRecord({ recordId: 'rec_existing', sheetId: 'sheet_ops', data: { fld_title: 'After' }, actorId: 'user_1', access, capabilities: { ...fullCapabilities } })
      expect(eventBus.emit).toHaveBeenCalledTimes(1)
      expect(eventBus.emit).toHaveBeenCalledWith('multitable.record.updated', {
        sheetId: 'sheet_ops',
        recordId: 'rec_existing',
        data: { fld_title: 'After' },
        actorId: 'user_1',
        _eventId: expect.any(String),
      })
      expect(outboxInsertsOf(pool)).toHaveLength(0)
      expect(pool.queryMock.mock.calls.some(([sql]) => String(sql).includes('automation_record_schema'))).toBe(false)
    })

    it('deleteRecord: emits the legacy deleted event; no outbox statement', async () => {
      await svc().deleteRecord({
        recordId: 'rec_existing',
        actorId: 'user_1',
        access,
        resolveSheetAccess: async () => ({ capabilities: { ...fullCapabilities } }),
      })
      expect(eventBus.emit).toHaveBeenCalledTimes(1)
      expect(eventBus.emit).toHaveBeenCalledWith('multitable.record.deleted', {
        sheetId: 'sheet_ops',
        recordId: 'rec_existing',
        actorId: 'user_1',
        _eventId: expect.any(String),
      })
      expect(outboxInsertsOf(pool)).toHaveLength(0)
    })
  })

  describe('private after-image producer arguments (mocked seam, not PostgreSQL evidence)', () => {
    afterEach(() => { vi.restoreAllMocks() })

    it('create and patch pass actual bounded RETURNING JSON text without putting it in the event or public result', async () => {
      const enqueue = vi.spyOn(producerEmit, 'enqueueRecordEventIfDurable').mockResolvedValue(true)
      const created = '{"fld_title": "Canonical create", "precise": 9007199254740993}'
      const updated = '{"fld_title": "Canonical patch", "untouched": 9007199254740993}'
      pool = createMockPool({ created, updated })
      const result = await svc().createRecord({ sheetId: 'sheet_ops', data: { fld_title: 'Alpha' }, actorId: 'user_1', capabilities: { ...fullCapabilities } })
      expect(enqueue.mock.calls[0]?.[4]).toEqual({ sheetId: 'sheet_ops', recordId: result.recordId, recordVersion: 1, data: undefined, rawJson: created, oversized: false })
      expect(enqueue.mock.calls[0]?.[2].data).toEqual({ fld_title: 'Alpha' })
      expect(result.data).toEqual({ fld_title: 'Alpha' })
      await svc().patchRecord({ recordId: 'rec_existing', sheetId: 'sheet_ops', data: { fld_title: 'After' }, actorId: 'user_1', access, capabilities: { ...fullCapabilities } })
      expect(enqueue.mock.calls[1]?.[4]).toEqual({ sheetId: 'sheet_ops', recordId: 'rec_existing', recordVersion: 5, data: undefined, rawJson: updated, oversized: false })
      expect(enqueue.mock.calls[1]?.[2].data).toEqual({ fld_title: 'After' })
      const writes = pool.queryMock.mock.calls.filter(([sql]) => /(?:INSERT INTO|UPDATE) meta_records/.test(String(sql)))
      expect(writes).toHaveLength(2)
      for (const [sql] of writes) expect(sql).toContain('CASE WHEN octet_length(data::text)')
    })

    it('missing bounded RETURNING column is never replaced with the input patch', async () => {
      const enqueue = vi.spyOn(producerEmit, 'enqueueRecordEventIfDurable').mockResolvedValue(true)
      await svc().createRecord({ sheetId: 'sheet_ops', data: { fld_title: 'Alpha' }, actorId: 'user_1', capabilities: { ...fullCapabilities } })
      await svc().patchRecord({ recordId: 'rec_existing', sheetId: 'sheet_ops', data: { fld_title: 'After' }, actorId: 'user_1', access, capabilities: { ...fullCapabilities } })
      expect(enqueue.mock.calls).toHaveLength(2)
      for (const call of enqueue.mock.calls) {
        expect(call[4]?.data).toBeUndefined()
        expect(call[4]?.rawJson).toBeUndefined()
      }
    })

    it('zero-field patch passes the locked existing row/version without another row read or update', async () => {
      const enqueue = vi.spyOn(producerEmit, 'enqueueRecordEventIfDurable').mockResolvedValue(true)
      await svc().patchRecord({ recordId: 'rec_existing', sheetId: 'sheet_ops', data: {}, actorId: 'user_1', access, capabilities: { ...fullCapabilities } })
      expect(enqueue.mock.calls[0]?.[4]).toEqual({ sheetId: 'sheet_ops', recordId: 'rec_existing', recordVersion: 4, data: undefined, rawJson: '{"fld_title": "Before", "precise": 9007199254740993}', oversized: false })
      expect(pool.queryMock.mock.calls.filter(([sql]) => String(sql).includes('SELECT id, version, data'))).toHaveLength(1)
      expect(pool.queryMock.mock.calls.find(([sql]) => String(sql).includes('SELECT id, version, data'))?.[0]).toContain('CASE WHEN octet_length(data::text)<=262144 THEN data::text ELSE NULL END AS automation_after_image_json')
      expect(pool.queryMock.mock.calls.some(([sql]) => String(sql).includes('UPDATE meta_records'))).toBe(false)
    })

    it('bounded database oversized marker is retained, with no patch fallback', async () => {
      const enqueue = vi.spyOn(producerEmit, 'enqueueRecordEventIfDurable').mockResolvedValue(true)
      pool = createMockPool({ created: null, updated: null, oversized: true })
      await svc().createRecord({ sheetId: 'sheet_ops', data: { fld_title: 'Alpha' }, actorId: 'user_1', capabilities: { ...fullCapabilities } })
      await svc().patchRecord({ recordId: 'rec_existing', sheetId: 'sheet_ops', data: { fld_title: 'After' }, actorId: 'user_1', access, capabilities: { ...fullCapabilities } })
      for (const call of enqueue.mock.calls) expect(call[4]).toMatchObject({ data: undefined, rawJson: null, oversized: true })
    })

    it('real enqueue/capture functions retain the returned image separately from the unchanged outbox payload', async () => {
      process.env[FLAG] = 'true'
      const created = '{"fld_title": "Canonical create", "untouched": 9007199254740993}'
      pool = createMockPool({ created })
      await svc().createRecord({ sheetId: 'sheet_ops', data: { fld_title: 'Alpha' }, actorId: 'user_1', capabilities: { ...fullCapabilities } })
      const captures = pool.queryMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO meta_automation_record_after_images'))
      expect(captures).toHaveLength(1)
      expect(captures[0]?.[1]?.[6]).toBe(created)
      expect(captures[0]?.[1]?.[7]).toBeNull()
      const outboxes = outboxInsertsOf(pool)
      expect(outboxes).toHaveLength(1)
      expect(JSON.parse(String(outboxes[0]?.[1]?.[2])).data).toEqual({ fld_title: 'Alpha' })
      expect(captures[0]?.[1]?.[0]).toBe(outboxes[0]?.[1]?.[0])
    })
  })
})
