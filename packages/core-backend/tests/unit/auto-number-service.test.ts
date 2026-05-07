import { describe, expect, it } from 'vitest'

import {
  allocateAutoNumberRange,
  backfillAutoNumberField,
  type AutoNumberQuery,
} from '../../src/multitable/auto-number-service'

function createQuery(rows: Array<{ id: string }> = []): {
  query: AutoNumberQuery
  calls: Array<{ sql: string; params: unknown[] }>
} {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const query: AutoNumberQuery = async (sql, params = []) => {
    calls.push({ sql, params })
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized.includes('SELECT pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 1 }
    }
    if (normalized.startsWith('SELECT id FROM meta_records')) {
      return { rows }
    }
    if (normalized.startsWith('UPDATE meta_records')) {
      return { rows: [], rowCount: 1 }
    }
    if (normalized.startsWith('INSERT INTO meta_field_auto_number_sequences')) {
      const batchSize = typeof params[3] === 'number' ? params[3] : 0
      return {
        rows: batchSize > 0 ? [{ start_value: 25 }] : [],
        rowCount: 1,
      }
    }
    throw new Error(`Unhandled SQL: ${sql}`)
  }
  return { query, calls }
}

describe('auto-number-service', () => {
  it('allocates a contiguous range from a field sequence', async () => {
    const { query, calls } = createQuery()

    const values = await allocateAutoNumberRange(
      query,
      'sheet_1',
      { id: 'fld_seq', type: 'autoNumber', property: { startAt: 10 } },
      3,
    )

    expect(values).toEqual([25, 26, 27])
    expect(calls[0]).toEqual({
      sql: 'SELECT pg_advisory_xact_lock(hashtext($1))',
      params: ['meta:auto-number:sheet_1:fld_seq'],
    })
    expect(calls[1].params).toEqual(['fld_seq', 'sheet_1', 13, 3])
  })

  it('backfills existing records and initializes next_value after the assigned range', async () => {
    const { query, calls } = createQuery([{ id: 'rec_a' }, { id: 'rec_b' }])

    const result = await backfillAutoNumberField(
      query,
      'sheet_1',
      'fld_seq',
      { start: 100, prefix: 'INV-', digits: 4 },
    )

    expect(result).toEqual({ assigned: 2, nextValue: 102 })
    expect(calls[0].params).toEqual(['meta:auto-number:sheet:sheet_1'])
    expect(calls[1].params).toEqual(['meta:auto-number:sheet_1:fld_seq'])
    expect(calls.filter((call) => call.sql.includes('UPDATE meta_records')).map((call) => call.params)).toEqual([
      ['fld_seq', 100, 'sheet_1', 'rec_a'],
      ['fld_seq', 101, 'sheet_1', 'rec_b'],
    ])
    expect(calls.at(-1)?.params).toEqual(['fld_seq', 'sheet_1', 102])
  })
})
