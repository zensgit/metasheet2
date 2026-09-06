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
      { id: 'rec_1', sheetId: 'sheet_1', version: 3, data: { title: 'A' }, locked: false, lockedBy: null, lockedAt: null },
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
        locked: false,
        lockedBy: null,
        lockedAt: null,
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

  // W9: an array filter value is the SET form of the single-value equality above — same `->>`
  // projection, same `String(value)` coercion per element, one statement instead of N.
  it('builds an = ANY(...) predicate for a multi-element filter value list', async () => {
    const { query, calls } = createQuery([
      { id: 'rec_1', sheet_id: 'sheet_1', version: 1, data: { title: 'A', status: 'open' } },
    ])

    await queryRecords({
      query,
      sheetId: 'sheet_1',
      filters: { status: ['open', 'closed', 'held'] },
      limit: 7,
      offset: 0,
    })

    const recordQuery = calls.at(-1)
    expect(recordQuery?.sql).toContain('WHERE sheet_id = $1 AND data ->> $2 = ANY($3::text[])')
    expect(recordQuery?.sql).toContain('ORDER BY id ASC')
    expect(recordQuery?.sql).toContain('LIMIT $4')
    expect(recordQuery?.sql).toContain('OFFSET $5')
    expect(recordQuery?.params).toEqual(['sheet_1', 'status', ['open', 'closed', 'held'], 7, 0])
  })

  it('keeps a single-element list on the same predicate shape, and coerces like the scalar path', async () => {
    const { query, calls } = createQuery([])

    await queryRecords({ query, sheetId: 'sheet_1', filters: { status: [42, true] } })

    const recordQuery = calls.at(-1)
    expect(recordQuery?.sql).toContain('data ->> $2 = ANY($3::text[])')
    // `String(value)` per element — exactly what the single-value branch does to its one value.
    expect(recordQuery?.params).toEqual(['sheet_1', 'status', ['42', 'true']])

    const single = createQuery([])
    await queryRecords({ query: single.query, sheetId: 'sheet_1', filters: { status: ['open'] } })
    expect(single.calls.at(-1)?.sql).toContain('data ->> $2 = ANY($3::text[])')
    expect(single.calls.at(-1)?.params).toEqual(['sheet_1', 'status', ['open']])
  })

  it('answers an empty filter value list with no rows and no records query', async () => {
    const { query, calls } = createQuery([
      { id: 'rec_1', sheet_id: 'sheet_1', version: 1, data: { title: 'A', status: 'open' } },
    ])

    await expect(queryRecords({ query, sheetId: 'sheet_1', filters: { status: [] } })).resolves.toEqual([])
    // The sheet row and the field list were still read — an unknown sheet still raises — but no
    // statement against meta_records was ever sent, because the answer is knowable without one.
    expect(calls.some((call) => call.sql.includes('FROM meta_records'))).toBe(false)
  })

  it('refuses a null element inside a filter value list instead of silently dropping it', async () => {
    const { query, calls } = createQuery([])

    await expect(queryRecords({
      query,
      sheetId: 'sheet_1',
      filters: { status: ['open', null as unknown as string] },
    })).rejects.toThrow(/Filter value list for status/)
    expect(calls.some((call) => call.sql.includes('FROM meta_records'))).toBe(false)

    // An unknown fieldId still loses to the pre-existing check, list or not.
    await expect(queryRecords({
      query,
      sheetId: 'sheet_1',
      filters: { nope: ['open'] },
    })).rejects.toThrow(/Unknown fieldId: nope/)
  })

  it('still refuses a filter value list on the cursor path, which builds its own keyset SQL', async () => {
    const { query, calls } = createQuery([])

    await expect(queryRecordsWithCursor({
      query,
      sheetId: 'sheet_1',
      filter: { status: ['open', 'closed'] as unknown as string },
    })).rejects.toThrow(/Unsupported filter value for status/)
    expect(calls.some((call) => call.sql.includes('FROM meta_records'))).toBe(false)
  })

  it('returns cursor pagination metadata from the query seam', async () => {
    const { query } = createQuery([
      { id: 'rec_1', sheet_id: 'sheet_1', version: 1, data: { title: 'A' } },
      { id: 'rec_2', sheet_id: 'sheet_1', version: 1, data: { title: 'B' } },
    ])

    const result = await queryRecordsWithCursor({ query, sheetId: 'sheet_1', limit: 1 })
    expect(result.items).toEqual([
      { id: 'rec_1', sheetId: 'sheet_1', version: 1, data: { title: 'A' }, locked: false, lockedBy: null, lockedAt: null },
    ])
    expect(result.hasMore).toBe(true)
    expect(result.nextCursor).toBe(encodeRecordCursor('rec_1', 'rec_1'))
  })
})
