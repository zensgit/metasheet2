import { describe, expect, it } from 'vitest'

import { coordinatedTransactionV1 } from '../coordination/settlement-coordination-port'
import { runAttendanceResultOperationHandedOverV1 } from '../w4c0-operation-registry'
import { acquireAttendanceCalculationRolloutLock, parseCanonicalAttendanceRolloutOrgKeyV1 } from '../w4c0-identity'
import { ORG, REQUEST, serializationError, setupFakeCoordination as setup } from '../../../tests/helpers/settlement-coordination-fakes'

const statements = (calls: readonly string[]) => calls.map((sql) => (sql.startsWith('SELECT idle') ? 'S1' : sql.startsWith('SELECT x_k') ? 'S2' : sql.split(/\s+/)[0]))
const OTHER_ORG = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a'

function recordingClient(sent: string[]) {
  return {
    query: async (sql: string) => {
      sent.push(sql)
      return { rows: [], command: 'SELECT' }
    },
  }
}

describe('W4 runner, handed-over mode (r6.1 §8 W-7)', () => {
  it('is refused outside a coordinated transaction and sends nothing', async () => {
    const sent: string[] = []
    await expect(runAttendanceResultOperationHandedOverV1(recordingClient(sent), async () => 'never')).rejects.toMatchObject({
      code: 'W4C0_CONNECTION_NOT_HANDED_OVER',
    })
    expect(sent).toEqual([])
  })

  it("is refused on any connection other than the context's own", async () => {
    const { coordinator, baseline } = setup()
    const sent: string[] = []
    await expect(
      coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        body: async () => runAttendanceResultOperationHandedOverV1(recordingClient(sent), async () => 'never'),
      }),
    ).rejects.toMatchObject({ code: 'W4C0_CONNECTION_NOT_HANDED_OVER' })
    expect(sent).toEqual([])
    baseline()
  })

  it('runs the body on the handed-over connection and sends nothing of its own (no Gate E, BEGIN, settings, COMMIT or ROLLBACK)', async () => {
    const { pool, coordinator, baseline } = setup()
    const result = await coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async (context) =>
        runAttendanceResultOperationHandedOverV1(context.client, async (trx) => {
          await trx.query('UPDATE t SET v = 1')
          return 'ran'
        }),
    })
    expect(result).toBe('ran')
    expect(statements(pool.clients[0].calls)).toEqual(['S1', 'BEGIN', 'S2', 'UPDATE', 'COMMIT'])
    baseline()
  })

  it('turns 40001 and 40P01 inside the body into a coordination restart; the second attempt commits on a new connection', async () => {
    for (const code of ['40001', '40P01']) {
      const { pool, coordinator, baseline } = setup()
      let runs = 0
      const result = await coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        body: async (context) =>
          runAttendanceResultOperationHandedOverV1(context.client, async (trx) => {
            runs += 1
            if (runs === 1) throw Object.assign(new Error(`test: ${code}`), { code })
            await trx.query('UPDATE t SET v = 2')
            return runs
          }),
      })
      expect(result).toBe(2)
      expect(statements(pool.clients[0].calls)).toEqual(['S1', 'BEGIN', 'S2', 'ROLLBACK'])
      expect(statements(pool.clients[1].calls)).toEqual(['S1', 'BEGIN', 'S2', 'UPDATE', 'COMMIT'])
      baseline()
    }
  })

  it('past the restart limit the caller gets the original 40001 object, never the signal', async () => {
    const { coordinator, baseline } = setup()
    const thrown: unknown[] = []
    const outcome = await coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async (context) =>
        runAttendanceResultOperationHandedOverV1(context.client, async () => {
          const error = serializationError(`attempt ${thrown.length + 1}`)
          thrown.push(error)
          throw error
        }),
    }).then(
      () => null,
      (error) => error,
    )
    expect(thrown).toHaveLength(3)
    expect(outcome).toBe(thrown[2])
    baseline()
  })

  it('rethrows every other error unchanged; the port rolls back', async () => {
    const { pool, coordinator, baseline } = setup()
    const business = Object.assign(new Error('test: business'), { code: 'ATTENDANCE_TEST_BUSINESS' })
    await expect(
      coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        body: async (context) => runAttendanceResultOperationHandedOverV1(context.client, async () => Promise.reject(business)),
      }),
    ).rejects.toBe(business)
    expect(statements(pool.clients[0].calls)).toEqual(['S1', 'BEGIN', 'S2', 'ROLLBACK'])
    baseline()
  })
})

describe('class-00 helper inside a coordinated transaction (r6.1 §3.5)', () => {
  const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(ORG)

  it('is a re-entrant no-op with no round trip when the credential covers the org with class-00', async () => {
    const { pool, coordinator, baseline } = setup()
    await coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async (context) => {
        const before = pool.clients[0].calls.length
        await acquireAttendanceCalculationRolloutLock(context.client, orgKey, 'shared')
        expect(pool.clients[0].calls.length).toBe(before)
        return 'covered'
      },
    })
    baseline()
  })

  it('is refused when the coordinated plan did not take class-00, for another org, on another connection, and in exclusive mode', async () => {
    const { coordinator, baseline } = setup()
    const refusals: unknown[] = []
    const capture = async (attempt: () => Promise<unknown>) => {
      try {
        await attempt()
      } catch (error) {
        refusals.push(error)
      }
    }
    await coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: { ...REQUEST, needsClassZero: false },
      candidate: { org: ORG },
      body: async (context) => {
        await capture(() => acquireAttendanceCalculationRolloutLock(context.client, orgKey, 'shared'))
        return 'dedicated only'
      },
    })
    await coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async (context) => {
        await capture(() => acquireAttendanceCalculationRolloutLock(context.client, parseCanonicalAttendanceRolloutOrgKeyV1(OTHER_ORG), 'shared'))
        await capture(() => acquireAttendanceCalculationRolloutLock(recordingClient([]), orgKey, 'shared'))
        await capture(() => acquireAttendanceCalculationRolloutLock(context.client, orgKey, 'exclusive'))
        return 'refused'
      },
    })
    expect(refusals).toHaveLength(4)
    for (const refusal of refusals) expect(refusal).toMatchObject({ code: 'W4C0_ROLLOUT_LOCK_NOT_COORDINATED' })
    baseline()
  })

  it('outside any coordinated transaction it keeps its own path and takes the lock', async () => {
    const sent: string[] = []
    await acquireAttendanceCalculationRolloutLock(recordingClient(sent), orgKey, 'shared')
    expect(sent.some((sql) => sql.includes('pg_advisory_xact_lock_shared'))).toBe(true)
  })
})
