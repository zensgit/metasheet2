import { describe, expect, it } from 'vitest'

import {
  buildRecordsCacheKey,
  decodeRecordCursor,
  encodeRecordCursor,
  listRecords,
  queryRecords,
  queryRecordsWithCursor,
  type MultitableRecordsQueryFn,
} from '../../src/multitable/query-service'

function createQuery(rows: any[] = []): {
  query: MultitableRecordsQueryFn
  calls: Array<{ sql: string; params?: unknown[] }>
} {
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  const query: MultitableRecordsQueryFn = async (sql, params) => {
    calls.push({ sql, params })
    if (sql.includes('FROM meta_sheets')) {
      return { rows: [{ id: 'sheet_1', name: 'Tickets' }], rowCount: 1 }
    }
    if (sql.includes('FROM meta_fields')) {
      return {
        rows: [
          { id: 'title', sheet_id: 'sheet_1', name: 'Title', type: 'string', property: {}, order: 1 },
          { id: 'status', sheet_id: 'sheet_1', name: 'Status', type: 'select', property: {}, order: 2 },
        ],
        rowCount: 2,
      }
    }
    return { rows, rowCount: rows.length }
  }
  return { query, calls }
}

describe('multitable query-service', () => {
  it('keeps cursor and cache helpers available from the query seam', () => {
    const cursor = encodeRecordCursor('rec_1', 'alpha')
    expect(decodeRecordCursor(cursor)).toEqual({ id: 'rec_1', sortValue: 'alpha' })
    expect(buildRecordsCacheKey('sheet_1', { filter: { status: 'open' }, cursor }))
      .toMatch(/^mt:records:sheet_1:[a-f0-9]{16}$/)
  })

  it('lists records through the extracted query service', async () => {
    const { query } = createQuery([
      { id: 'rec_1', sheet_id: 'sheet_1', version: 3, data: { title: 'A' } },
    ])

    await expect(listRecords({ query, sheetId: 'sheet_1' })).resolves.toEqual([
      { id: 'rec_1', sheetId: 'sheet_1', version: 3, data: { title: 'A' } },
    ])
  })

  it('injects readonly system field values from record metadata', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const query: MultitableRecordsQueryFn = async (sql, params) => {
      calls.push({ sql, params })
      if (sql.includes('FROM meta_sheets')) {
        return { rows: [{ id: 'sheet_1', name: 'Tickets' }], rowCount: 1 }
      }
      if (sql.includes('FROM meta_fields')) {
        return {
          rows: [
            { id: 'title', sheet_id: 'sheet_1', name: 'Title', type: 'string', property: {}, order: 1 },
            { id: 'created_at_sys', sheet_id: 'sheet_1', name: 'Created At', type: 'createdTime', property: {}, order: 2 },
            { id: 'updated_at_sys', sheet_id: 'sheet_1', name: 'Updated At', type: 'modifiedTime', property: {}, order: 3 },
            { id: 'created_by_sys', sheet_id: 'sheet_1', name: 'Created By', type: 'createdBy', property: {}, order: 4 },
            { id: 'modified_by_sys', sheet_id: 'sheet_1', name: 'Modified By', type: 'modifiedBy', property: {}, order: 5 },
          ],
          rowCount: 5,
        }
      }
      return {
        rows: [{
          id: 'rec_1',
          sheet_id: 'sheet_1',
          version: 3,
          data: { title: 'A', created_at_sys: 'client-forged' },
          created_at: new Date('2026-04-30T01:02:03.000Z'),
          updated_at: '2026-04-30T02:03:04.000Z',
          created_by: 'user_creator',
          modified_by: 'user_editor',
        }],
        rowCount: 1,
      }
    }

    await expect(listRecords({ query, sheetId: 'sheet_1' })).resolves.toEqual([
      {
        id: 'rec_1',
        sheetId: 'sheet_1',
        version: 3,
        createdAt: '2026-04-30T01:02:03.000Z',
        updatedAt: '2026-04-30T02:03:04.000Z',
        createdBy: 'user_creator',
        modifiedBy: 'user_editor',
        data: {
          title: 'A',
          created_at_sys: '2026-04-30T01:02:03.000Z',
          updated_at_sys: '2026-04-30T02:03:04.000Z',
          created_by_sys: 'user_creator',
          modified_by_sys: 'user_editor',
        },
      },
    ])

    expect(calls.at(-1)?.sql).toContain('created_at, updated_at, created_by, modified_by')
  })

  it('builds filter/search/order SQL without touching write helpers', async () => {
    const { query, calls } = createQuery([
      { id: 'rec_1', sheet_id: 'sheet_1', version: 1, data: JSON.stringify({ title: 'A', status: 'open' }) },
    ])

    await queryRecords({
      query,
      sheetId: 'sheet_1',
      filters: { status: 'open' },
      search: 'alpha',
      orderBy: { fieldId: 'title', direction: 'desc' },
      limit: 10,
      offset: 5,
    })

    const recordQuery = calls.at(-1)
    expect(recordQuery?.sql).toContain('FROM meta_records')
    expect(recordQuery?.sql).toContain('data ->> $2 = $3')
    expect(recordQuery?.sql).toContain('data::text ILIKE $4')
    expect(recordQuery?.sql).toContain('ORDER BY data ->> $5 DESC NULLS LAST, id ASC')
    expect(recordQuery?.sql).toContain('LIMIT $6')
    expect(recordQuery?.sql).toContain('OFFSET $7')
    expect(recordQuery?.params).toEqual(['sheet_1', 'status', 'open', '%alpha%', 'title', 10, 5])
  })

  it('returns cursor pagination metadata from the query seam', async () => {
    const { query } = createQuery([
      { id: 'rec_1', sheet_id: 'sheet_1', version: 1, data: { title: 'A' } },
      { id: 'rec_2', sheet_id: 'sheet_1', version: 1, data: { title: 'B' } },
    ])

    const result = await queryRecordsWithCursor({ query, sheetId: 'sheet_1', limit: 1 })
    expect(result.items).toEqual([
      { id: 'rec_1', sheetId: 'sheet_1', version: 1, data: { title: 'A' } },
    ])
    expect(result.hasMore).toBe(true)
    expect(result.nextCursor).toBe(encodeRecordCursor('rec_1', 'rec_1'))
  })
})
