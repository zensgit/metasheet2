import { describe, expect, it, vi } from 'vitest'

const { readAttendanceShiftReferenceCapability: read } = require(
  '../../../../plugins/plugin-attendance/lib/attendance-shift-reference-capability.cjs',
) as { readAttendanceShiftReferenceCapability: (db: unknown, port: unknown, orgId: string) => Promise<boolean> }

type Client = { query: (sql: string) => Promise<Record<string, unknown>[]> }

function makeDb(failSet = false) {
  const calls: string[] = [], clients: Client[] = []
  const db = {
    transaction: vi.fn(async (run: (client: Client) => Promise<unknown>) => {
      calls.push('BEGIN')
      const client = {
        query: vi.fn(async (sql: string): Promise<Record<string, unknown>[]> => {
          calls.push(sql)
          if (failSet && sql === 'SET TRANSACTION READ ONLY') throw new Error('SYNTHETIC_PRIVATE_DB_FAILURE')
          return []
        }),
      }
      clients.push(client)
      try {
        const value = await run(client)
        calls.push('COMMIT')
        return value
      } catch (error) {
        calls.push('ROLLBACK')
        throw error
      }
    }),
  }
  return { db, calls, clients }
}

describe('W6 readonly reference-authoring reader', () => {
  it('stays closed without a port and opens no transaction', async () => {
    const { db } = makeDb()
    expect(await read(db, null, 'synthetic-org')).toBe(false)
    expect(db.transaction).not.toHaveBeenCalled()
  })
  it('stays closed when the narrow read method is unavailable', async () => {
    const { db } = makeDb()
    expect(await read(db, {}, 'synthetic-org')).toBe(false)
    expect(db.transaction).not.toHaveBeenCalled()
  })
  it('never falls back to the writer port or fabricates its transaction marker', async () => {
    const { db } = makeDb(), writer = vi.fn(async () => ({ referenceSegments: true }))
    expect(await read(db, { resolveOrgSegmentCalculationPosture: writer }, 'synthetic-org')).toBe(false)
    expect(writer).not.toHaveBeenCalled()
    expect(db.transaction).not.toHaveBeenCalled()
  })
  it('stays closed without a genuine transaction API', async () => {
    const port = { resolveTimezoneSegmentReferencePosture: vi.fn(async () => ({ referenceSegments: true })) }
    expect(await read({ query: vi.fn() }, port, 'synthetic-org')).toBe(false)
    expect(port.resolveTimezoneSegmentReferencePosture).not.toHaveBeenCalled()
  })
  it('sets readonly first and uses exactly the transaction client and original org', async () => {
    const { db, calls, clients } = makeDb()
    const port = {
      resolveTimezoneSegmentReferencePosture: vi.fn(async (client: Client, orgId: string) => {
        expect(client).toBe(clients[0])
        expect(orgId).toBe('synthetic-org')
        calls.push('PORT')
        await client.query('SELECT synthetic_posture')
        return { referenceSegments: true, effectiveState: 'SYNTHETIC_PRIVATE_NOT_RETURNED' }
      }),
    }
    expect(await read(db, port, 'synthetic-org')).toBe(true)
    expect(calls).toEqual(['BEGIN', 'SET TRANSACTION READ ONLY', 'PORT', 'SELECT synthetic_posture', 'COMMIT'])
    expect(Object.keys(clients[0])).toEqual(['query'])
    expect(port.resolveTimezoneSegmentReferencePosture).toHaveBeenCalledTimes(1)
  })
  it('commits a closed posture without inventing admission', async () => {
    const { db, calls } = makeDb()
    expect(await read(db, {
      resolveTimezoneSegmentReferencePosture: async () => ({ referenceSegments: false }),
    }, 'synthetic-org')).toBe(false)
    expect(calls).toEqual(['BEGIN', 'SET TRANSACTION READ ONLY', 'COMMIT'])
  })
  it.each([1, 'true', undefined])('refuses nonliteral admission bit %#', async (referenceSegments) => {
    const { db } = makeDb()
    expect(await read(db, {
      resolveTimezoneSegmentReferencePosture: async () => ({ referenceSegments }),
    }, 'synthetic-org')).toBe(false)
  })
  it('rolls back a rejected posture read and returns only a closed hint', async () => {
    const { db, calls } = makeDb()
    expect(await read(db, {
      resolveTimezoneSegmentReferencePosture: async () => { throw new Error('SYNTHETIC_PRIVATE_PORT_FAILURE') },
    }, 'synthetic-org')).toBe(false)
    expect(calls).toEqual(['BEGIN', 'SET TRANSACTION READ ONLY', 'ROLLBACK'])
  })
  it('does not invoke the port when establishing readonly fails', async () => {
    const { db, calls } = makeDb(true), invoke = vi.fn(async () => ({ referenceSegments: true }))
    expect(await read(db, { resolveTimezoneSegmentReferencePosture: invoke }, 'synthetic-org')).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
    expect(calls).toEqual(['BEGIN', 'SET TRANSACTION READ ONLY', 'ROLLBACK'])
  })
  it('keeps an unavailable database hint closed without leaking an exception', async () => {
    const db = { transaction: vi.fn(async () => { throw new Error('SYNTHETIC_PRIVATE_CONNECT_FAILURE') }) }
    expect(await read(db, {
      resolveTimezoneSegmentReferencePosture: async () => ({ referenceSegments: true }),
    }, 'synthetic-org')).toBe(false)
  })
  it('resolves each actor org on a new transaction instead of caching an admitted hint', async () => {
    const { db, clients } = makeDb(), seen: string[] = []
    const port = { resolveTimezoneSegmentReferencePosture: vi.fn(async (_client: Client, orgId: string) => {
      seen.push(orgId)
      return { referenceSegments: orgId === 'synthetic-admitted' }
    }) }
    expect(await read(db, port, 'synthetic-admitted')).toBe(true)
    expect(await read(db, port, 'synthetic-closed')).toBe(false)
    expect(seen).toEqual(['synthetic-admitted', 'synthetic-closed'])
    expect(db.transaction).toHaveBeenCalledTimes(2)
    expect(clients[0]).not.toBe(clients[1])
  })
  it('does not infer reference permission from unrelated authoritative posture fields', async () => {
    const { db } = makeDb()
    expect(await read(db, {
      resolveTimezoneSegmentReferencePosture: async () => ({ effectiveState: 'authoritative', authoritativeResults: true }),
    }, 'synthetic-org')).toBe(false)
  })
})
