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

vi.mock('../../src/multitable/realtime-publish', () => ({
  publishMultitableSheetRealtime: vi.fn(),
}))

const FLAG = 'AUTOMATION_DURABLE_DELIVERY_ENABLED'

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
}
const access = { userId: 'user_1', permissions: ['multitable:write'], isAdminRole: false }

function createMockEventBus() {
  return { emit: vi.fn(), publish: vi.fn(), subscribe: vi.fn().mockReturnValue('sub_1'), unsubscribe: vi.fn() }
}

type QueryResponse = { rows: unknown[]; rowCount?: number | null }

function createMockPool(): ConnectionPool & { queryMock: ReturnType<typeof vi.fn> } {
  const queryMock = vi.fn(async (sql: string, _params?: unknown[]): Promise<QueryResponse> => {
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
      return { rows: [{ version: 1 }] }
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
    if (sql.includes('SELECT id, version, data, created_by, locked, locked_by FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE')) {
      return { rows: [{ id: 'rec_existing', version: 4, data: { fld_title: 'Before' }, created_by: 'user_1', locked: false, locked_by: null }] }
    }
    if (sql.includes('UPDATE meta_records') && sql.includes('RETURNING version')) {
      return { rows: [{ version: 5 }], rowCount: 1 }
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
})
