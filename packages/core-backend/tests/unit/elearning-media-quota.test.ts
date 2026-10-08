import { describe, expect, it } from 'vitest'

import {
  elearningMediaQuotaLockKey,
  ElearningMediaQuotaError,
  reserveElearningMediaQuotaAndInsert,
  type ElearningMediaDb,
  type ElearningMediaQueryable,
} from '../../src/services/elearning-media-quota'

function row(over: Partial<{ id: string; sizeBytes: number; orgId: string }> = {}) {
  return {
    id: over.id ?? '11111111-1111-4111-8111-111111111111',
    orgId: over.orgId ?? 'org-a',
    storageKey: 'elearning-media/2026-08/11111111-1111-4111-8111-111111111111.mp4',
    mimeType: 'video/mp4',
    magicMimeType: 'video/mp4',
    sizeBytes: over.sizeBytes ?? 50,
    sha256: 'abc',
    createdBy: 'user-1',
  }
}

function makeDb(state: {
  used?: number
  sumRows?: Array<Record<string, unknown>>
}): { db: ElearningMediaDb; queries: string[]; order: string[] } {
  const queries: string[] = []
  const order: string[] = []
  let lockTail = Promise.resolve()
  const runTx = async <T>(handler: (tx: ElearningMediaQueryable) => Promise<T>): Promise<T> => {
    const prev = lockTail
    let release!: () => void
    lockTail = new Promise<void>((resolve) => { release = resolve })
    await prev
    try {
      return await handler({
        query: async (sql) => {
          queries.push(sql)
          if (sql.includes('pg_advisory_xact_lock')) {
            order.push('lock')
            return { rows: [], rowCount: 1 }
          }
          if (sql.includes('SUM(size_bytes)')) {
            order.push('sum')
            expect(sql).toContain("status IN ('uploading', 'probing', 'ready')")
            if (state.sumRows !== undefined) {
              return { rows: state.sumRows, rowCount: state.sumRows.length }
            }
            return { rows: [{ used: String(state.used ?? 0) }], rowCount: 1 }
          }
          if (sql.includes('INSERT INTO elearning_media')) {
            order.push('insert')
            return { rows: [], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        },
      })
    } finally {
      release()
    }
  }
  return {
    queries,
    order,
    db: {
      query: async () => ({ rows: [], rowCount: 0 }),
      transaction: runTx,
    },
  }
}

describe('elearning media quota reservation', () => {
  it('locks then sums active media then inserts inside one transaction', async () => {
    const { db, order, queries } = makeDb({ used: 10 })
    await reserveElearningMediaQuotaAndInsert(db, row({ sizeBytes: 20 }), 100)
    expect(order).toEqual(['lock', 'sum', 'insert'])
    expect(queries[0]).toContain('pg_advisory_xact_lock')
    expect(elearningMediaQuotaLockKey('org-a')).toBe('elearning-media-quota:org-a')
  })

  it('rejects when used + incoming exceeds the explicit org quota', async () => {
    const { db, order } = makeDb({ used: 80 })
    await expect(reserveElearningMediaQuotaAndInsert(db, row({ sizeBytes: 30 }), 100))
      .rejects.toBeInstanceOf(ElearningMediaQuotaError)
    expect(order).toEqual(['lock', 'sum'])
  })

  it('serializes concurrent reservations so the second observer sees the first insert (contract)', async () => {
    const state = { used: 60 }
    const { db } = makeDb(state)
    const originalTx = db.transaction.bind(db)
    db.transaction = async (handler) => originalTx(async (tx) => {
      const inner = tx.query.bind(tx)
      tx.query = async (sql, params) => {
        const result = await inner(sql, params)
        if (sql.includes('INSERT INTO elearning_media')) {
          const size = Number(params?.[5] ?? 0)
          state.used += size
        }
        return result
      }
      return handler(tx)
    })
    const results = await Promise.allSettled([
      reserveElearningMediaQuotaAndInsert(db, row({ id: 'a', sizeBytes: 30 }), 100),
      reserveElearningMediaQuotaAndInsert(db, row({ id: 'b', sizeBytes: 30 }), 100),
    ])
    const accepted = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(accepted).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ElearningMediaQuotaError)
    expect(state.used).toBe(90)
  })

  it('throws fail-closed when SUM row is missing', async () => {
    const { db, order } = makeDb({ sumRows: [] })
    await expect(reserveElearningMediaQuotaAndInsert(db, row({ sizeBytes: 20 }), 100))
      .rejects.toThrow('elearning_media_quota_sum_unavailable')
    expect(order).toEqual(['lock', 'sum'])
  })

  it('throws fail-closed when SUM used is missing', async () => {
    const { db, order } = makeDb({ sumRows: [{}] })
    await expect(reserveElearningMediaQuotaAndInsert(db, row({ sizeBytes: 20 }), 100))
      .rejects.toThrow('elearning_media_quota_sum_unavailable')
    expect(order).toEqual(['lock', 'sum'])
  })

  it('throws fail-closed when SUM used is null', async () => {
    const { db, order } = makeDb({ sumRows: [{ used: null }] })
    await expect(reserveElearningMediaQuotaAndInsert(db, row({ sizeBytes: 20 }), 100))
      .rejects.toThrow('elearning_media_quota_sum_unavailable')
    expect(order).toEqual(['lock', 'sum'])
  })

  it('throws fail-closed when SUM used is malformed', async () => {
    const { db, order } = makeDb({ sumRows: [{ used: 'not-a-number' }] })
    await expect(reserveElearningMediaQuotaAndInsert(db, row({ sizeBytes: 20 }), 100))
      .rejects.toThrow('elearning_media_quota_sum_unavailable')
    expect(order).toEqual(['lock', 'sum'])
  })
})
