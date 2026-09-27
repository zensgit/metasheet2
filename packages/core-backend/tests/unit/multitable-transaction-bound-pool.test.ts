/**
 * `createTransactionBoundPool` — the RecordService facade the copy-sheet transaction hands to
 * `new RecordService(...)` (ADR §7.2, no prior precedent in the repo).
 *
 * What is pinned:
 *   F1 `transaction(handler)` runs the handler on the CALLER's query handle — the same function object,
 *      not a wrapper around a different connection — and issues no BEGIN / COMMIT / ROLLBACK of its own.
 *   F2 a throw inside the handler propagates unchanged (the caller's `pool.transaction` is what rolls back).
 *   F3 `query` forwards sql + params verbatim to the bound handle.
 *   F4 END-TO-END: `RecordService.createRecord` built on the facade writes every statement (fence, mint,
 *      field read, INSERT, revision) through the ONE bound handle — nothing reaches any other pool.
 */
import { describe, expect, it, vi } from 'vitest'

import { createTransactionBoundPool } from '../../src/multitable/transaction-bound-pool'
import {
  COPY_SHEET_RECORD_CAPABILITIES,
  RecordService,
  type QueryFn,
} from '../../src/multitable/record-service'

vi.mock('../../src/multitable/realtime-publish', () => ({
  publishMultitableSheetRealtime: vi.fn(),
}))

describe('createTransactionBoundPool', () => {
  it('F1/F3: transaction() and query() both run on the caller handle, with no BEGIN/COMMIT/ROLLBACK', async () => {
    const statements: string[] = []
    const txQuery: QueryFn = vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push(sql)
      return { rows: [{ sql, params }], rowCount: 1 }
    })
    const pool = createTransactionBoundPool(txQuery)

    const direct = await pool.query('SELECT 1 WHERE $1 = $1', ['a'])
    expect(direct.rows).toEqual([{ sql: 'SELECT 1 WHERE $1 = $1', params: ['a'] }])

    const inner = await pool.transaction(async ({ query }) => {
      const r = await query('INSERT INTO t VALUES ($1)', [42])
      return r.rows[0]
    })
    expect(inner).toEqual({ sql: 'INSERT INTO t VALUES ($1)', params: [42] })

    expect(statements).toEqual(['SELECT 1 WHERE $1 = $1', 'INSERT INTO t VALUES ($1)'])
    expect(statements.some((s) => /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(s))).toBe(false)
    expect(txQuery).toHaveBeenCalledTimes(2)
  })

  it('F2: a throw inside the handler propagates unchanged and issues no ROLLBACK statement', async () => {
    const statements: string[] = []
    const txQuery: QueryFn = async (sql) => { statements.push(sql); return { rows: [] } }
    const pool = createTransactionBoundPool(txQuery)
    const boom = new Error('row 7 failed')
    await expect(pool.transaction(async () => { throw boom })).rejects.toBe(boom)
    expect(statements).toEqual([])
  })

  it('F4: RecordService.createRecord on the facade writes every statement through the one bound handle', async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = []
    const txQuery: QueryFn = vi.fn(async (sql: string, params: unknown[] = []) => {
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
      if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) return { rows: [{ id: 'sheet_new' }] }
      if (sql.includes('FROM meta_fields WHERE sheet_id = $1')) {
        return { rows: [{ id: 'fld_title', name: 'Title', type: 'string', property: {} }] }
      }
      if (sql.includes('INSERT INTO meta_records') && sql.includes('RETURNING version')) return { rows: [{ version: 1 }] }
      return { rows: [], rowCount: 1 }
    })
    const service = new RecordService(createTransactionBoundPool(txQuery), { emit: vi.fn() } as never)
    const startedAt = new Date('2026-09-27T00:00:00.000Z')

    const result = await service.createRecord({
      sheetId: 'sheet_new',
      data: { fld_title: 'Alpha' },
      actorId: 'user_copier',
      capabilities: COPY_SHEET_RECORD_CAPABILITIES,
      copy: { batchId: 'batch_1', ordinal: 0, startedAt, createdBy: 'user_source' },
    })

    expect(result.recordId).toMatch(/^rec_/)
    const sqlTexts = statements.map((s) => s.sql)
    // fence (canonical advisory lock), field read, INSERT, revision — all on the same handle.
    expect(sqlTexts.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true)
    expect(sqlTexts.some((s) => s.startsWith('INSERT INTO meta_records ('))).toBe(true)
    expect(sqlTexts.some((s) => s.startsWith('INSERT INTO meta_record_revisions'))).toBe(true)
    expect(sqlTexts.some((s) => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(s))).toBe(false)
  })
})
