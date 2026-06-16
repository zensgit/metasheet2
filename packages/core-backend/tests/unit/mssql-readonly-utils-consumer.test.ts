import { describe, expect, it } from 'vitest'
import {
  buildGenericWhereClause,
  normalizeTimeout,
  quoteSqlServerIdentifier,
} from '@metasheet/mssql-readonly-utils'

describe('mssql-readonly-utils package consumption from core-backend TS', () => {
  it('imports the neutral helper by package name and preserves generic where semantics', () => {
    const where = buildGenericWhereClause({
      status: 'open',
      $or: [
        { updated_at: { $gt: '2026-06-01T00:00:00.000Z' } },
        { updated_at: '2026-06-01T00:00:00.000Z', id: { $gt: 42 } },
      ],
    }, {
      quoteIdentifier: (field) => field,
      parameter: (index) => `@p${index - 1}`,
    })

    expect(where.sql).toBe(
      'WHERE status = @p0 AND ((updated_at > @p1) OR (updated_at = @p2 AND id > @p3))'
    )
    expect(where.params).toEqual(['open', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 42])
    expect(quoteSqlServerIdentifier('dbo.orders')).toBe('[dbo].[orders]')
    expect(normalizeTimeout(0, { allowZero: true })).toBe(0)
  })
})
