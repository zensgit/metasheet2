import { describe, expect, it } from 'vitest'

import {
  allocateAutoNumberRange,
  backfillAutoNumberField,
  type AutoNumberQuery,
} from '../../src/multitable/auto-number-service'

function createQuery(options: { backfillRowCount?: number } = {}): {
  query: AutoNumberQuery
  calls: Array<{ sql: string; params: unknown[] }>
} {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const backfillRowCount = options.backfillRowCount ?? 0
  const query: AutoNumberQuery = async (sql, params = []) => {
    calls.push({ sql, params })
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized.includes('SELECT pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 1 }
    }
    if (normalized.startsWith('UPDATE meta_records mr')) {
      const startValue = typeof params[1] === 'number' ? params[1] : 0
      return {
        rows: Array.from({ length: backfillRowCount }, (_, idx) => ({ value: startValue + idx })),
        rowCount: backfillRowCount,
      }
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

  it('backfills existing records via a single window-function UPDATE and initializes next_value', async () => {
    const { query, calls } = createQuery({ backfillRowCount: 2 })

    const result = await backfillAutoNumberField(
      query,
      'sheet_1',
      'fld_seq',
      { start: 100, prefix: 'INV-', digits: 4 },
    )

    expect(result).toEqual({ assigned: 2, nextValue: 102 })
    expect(calls[0].params).toEqual(['meta:auto-number:sheet:sheet_1'])
    expect(calls[1].params).toEqual(['meta:auto-number:sheet_1:fld_seq'])

    const updateCalls = calls.filter((call) => call.sql.includes('UPDATE meta_records'))
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].params).toEqual(['fld_seq', 100, 'sheet_1', false])
    expect(updateCalls[0].sql).toContain('ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC)')

    expect(calls.at(-1)?.params).toEqual(['fld_seq', 'sheet_1', 102])
  })

  it('forwards overwrite=true to the UPDATE so existing field values are reassigned', async () => {
    const { query, calls } = createQuery({ backfillRowCount: 3 })

    const result = await backfillAutoNumberField(
      query,
      'sheet_1',
      'fld_seq',
      { start: 50 },
      { overwrite: true },
    )

    expect(result).toEqual({ assigned: 3, nextValue: 53 })
    const updateCall = calls.find((call) => call.sql.includes('UPDATE meta_records'))
    expect(updateCall?.params).toEqual(['fld_seq', 50, 'sheet_1', true])
  })

  it('returns assigned=0 and nextValue=start when there are no eligible records', async () => {
    const { query, calls } = createQuery({ backfillRowCount: 0 })

    const result = await backfillAutoNumberField(
      query,
      'sheet_1',
      'fld_seq',
      { start: 7 },
    )

    expect(result).toEqual({ assigned: 0, nextValue: 7 })
    const updateCalls = calls.filter((call) => call.sql.includes('UPDATE meta_records'))
    expect(updateCalls).toHaveLength(1)
    expect(calls.at(-1)?.params).toEqual(['fld_seq', 'sheet_1', 7])
  })
})
