import { describe, it, expect } from 'vitest'
import {
  encodeRecordCursor,
  decodeRecordCursor,
  buildRecordsCacheKey,
  queryRecordsWithCursor,
  type MultitableRecordsQueryFn,
} from '../../src/multitable/records'

describe('encodeRecordCursor / decodeRecordCursor', () => {
  it('should round-trip encode then decode', () => {
    const id = 'rec_abc123'
    const sortValue = '2026-04-13T00:00:00Z'
    const cursor = encodeRecordCursor(id, sortValue)
    const decoded = decodeRecordCursor(cursor)
    expect(decoded.id).toBe(id)
    expect(decoded.sortValue).toBe(sortValue)
  })

  it('should produce a base64url string without padding', () => {
    const cursor = encodeRecordCursor('rec_1', 'val')
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('should handle empty sort value', () => {
    const cursor = encodeRecordCursor('rec_1', '')
    const decoded = decodeRecordCursor(cursor)
    expect(decoded.id).toBe('rec_1')
    expect(decoded.sortValue).toBe('')
  })

  it('should throw on invalid cursor string', () => {
    expect(() => decodeRecordCursor('not-valid-json!!!')).toThrow('Invalid cursor format')
  })

  it('should throw on structurally wrong payload', () => {
    const bad = Buffer.from(JSON.stringify({ foo: 1 })).toString('base64url')
    expect(() => decodeRecordCursor(bad)).toThrow('Invalid cursor format')
  })
})

describe('buildRecordsCacheKey', () => {
  it('should return a deterministic key for the same params', () => {
    const a = buildRecordsCacheKey('sheet1', { filter: { status: 'active' }, cursor: 'abc' })
    const b = buildRecordsCacheKey('sheet1', { filter: { status: 'active' }, cursor: 'abc' })
    expect(a).toBe(b)
  })

  it('should differ when params differ', () => {
    const a = buildRecordsCacheKey('sheet1', { filter: { status: 'active' } })
    const b = buildRecordsCacheKey('sheet1', { filter: { status: 'inactive' } })
    expect(a).not.toBe(b)
  })

  it('should include sheetId prefix', () => {
    const key = buildRecordsCacheKey('sht_42', {})
    expect(key.startsWith('mt:records:sht_42:')).toBe(true)
  })
})

describe('queryRecordsWithCursor', () => {
  function makeMockQuery(rows: any[]): MultitableRecordsQueryFn {
    return async (sql: string, _params?: unknown[]) => {
      // loadSheetRow check
      if (sql.includes('meta_sheets')) {
        return { rows: [{ id: 'sheet1', name: 'Test' }], rowCount: 1 }
      }
      // loadFieldsForSheet check
      if (sql.includes('meta_fields')) {
        return {
          rows: [
            { id: 'f1', name: 'Name', type: 'string', property: null, sheet_id: 'sheet1', order: 0 },
          ],
          rowCount: 1,
        }
      }
      // The actual records query
      return { rows, rowCount: rows.length }
    }
  }

  it('should return hasMore false and null cursor for empty results', async () => {
    const query = makeMockQuery([])
    const result = await queryRecordsWithCursor({ query, sheetId: 'sheet1' })
    expect(result.items).toHaveLength(0)
    expect(result.hasMore).toBe(false)
    expect(result.nextCursor).toBeNull()
  })

  it('should return hasMore true when extra row exists', async () => {
    // Default limit is 100, so if we return 101 rows we should see hasMore = true
    const rows = Array.from({ length: 101 }, (_, i) => ({
      id: `rec_${i}`,
      sheet_id: 'sheet1',
      version: 1,
      data: JSON.stringify({ f1: `name_${i}` }),
    }))
    const query = makeMockQuery(rows)
    const result = await queryRecordsWithCursor({ query, sheetId: 'sheet1', limit: 100 })
    expect(result.items).toHaveLength(100)
    expect(result.hasMore).toBe(true)
    expect(result.nextCursor).not.toBeNull()
  })

  it('should return hasMore false when exactly at limit', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `rec_${i}`,
      sheet_id: 'sheet1',
      version: 1,
      data: JSON.stringify({ f1: `name_${i}` }),
    }))
    const query = makeMockQuery(rows)
    const result = await queryRecordsWithCursor({ query, sheetId: 'sheet1', limit: 5 })
    expect(result.items).toHaveLength(5)
    expect(result.hasMore).toBe(false)
    expect(result.nextCursor).toBeNull()
  })

  it('should clamp limit to at least 1', async () => {
    const query = makeMockQuery([])
    const result = await queryRecordsWithCursor({ query, sheetId: 'sheet1', limit: -10 })
    expect(result.items).toHaveLength(0)
  })
})
