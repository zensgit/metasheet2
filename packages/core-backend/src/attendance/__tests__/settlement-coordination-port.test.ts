import { afterEach, describe, expect, it } from 'vitest'

import {
  AttendanceCoordinationNestingError,
  currentSettlementCoordinationContextV1,
  noteSettlementCoordinationMainPoolAccessV1,
  setSettlementCoordinationNestingModeV1,
  settlementCoordinationNestedMainPoolAccessesV1,
} from '../coordination/settlement-coordination-context'
import { AttendanceCoordinationCommitNotCommittedError } from '../coordination/settlement-coordination-handover'
import {
  SettlementCoordinationRecheckMismatchV1,
  SettlementCoordinationRestartSignalV1,
  coordinatedTransactionV1,
  settlementCoordinationResultAfterCommitV1,
} from '../coordination/settlement-coordination-port'
import { SettlementCoordinationScopeChangedError } from '../coordination/settlement-coordinator'
import { ORG, REQUEST, serializationError, setupFakeCoordination as setup } from '../../../tests/helpers/settlement-coordination-fakes'

afterEach(() => {
  setSettlementCoordinationNestingModeV1('count')
})

const statements = (calls: readonly string[]) => calls.map((sql) => (sql.startsWith('SELECT idle') ? 'S1' : sql.startsWith('SELECT x_k') ? 'S2' : sql.split(/\s+/)[0]))

describe('coordinated transaction port: lifecycle (P11-A10)', () => {
  it('runs the body on the handed-over connection inside the context; COMMIT, one release, both quotas back, then callbacks outside the context', async () => {
    const { pool, coordinator, quota, baseline } = setup()
    setSettlementCoordinationNestingModeV1('throw')
    const seen: Array<Record<string, unknown>> = []
    const result = await coordinatedTransactionV1({
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async (context) => {
        expect(context.client).toBe(pool.clients[0])
        expect(currentSettlementCoordinationContextV1()?.orgLexical).toBe(ORG)
        expect(() => noteSettlementCoordinationMainPoolAccessV1('test.inside')).toThrow(AttendanceCoordinationNestingError)
        await context.client.query('UPDATE t SET v = 1')
        context.afterCommit(() => {
          seen.push({
            held: quota.snapshot().global.short.held,
            orgs: quota.snapshot().orgs.length,
            context: currentSettlementCoordinationContextV1(),
            released: pool.clients[0].released.length,
          })
          // Main-pool access after release is ordinary load, not nesting.
          noteSettlementCoordinationMainPoolAccessV1('test.after-commit')
        })
        return 'done'
      },
    })
    expect(result).toBe('done')
    expect(statements(pool.clients[0].calls)).toEqual(['S1', 'BEGIN', 'S2', 'UPDATE', 'COMMIT'])
    expect(pool.clients[0].released).toEqual([null])
    expect(seen).toEqual([{ held: 0, orgs: 0, context: null, released: 1 }])
    baseline()
  })

  it('a deferred result is computed after release and after the callbacks', async () => {
    const { pool, coordinator, quota, baseline } = setup()
    const order: string[] = []
    const result = await coordinatedTransactionV1({
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async (context) => {
        context.afterCommit(() => void order.push('callback'))
        return settlementCoordinationResultAfterCommitV1(async () => {
          order.push(`result:held=${quota.snapshot().global.short.held}:released=${pool.clients[0].released.length}`)
          return 'approval'
        })
      },
    })
    expect(result).toBe('approval')
    expect(order).toEqual(['callback', 'result:held=0:released=1'])
    baseline()
  })

  it('a business error rolls back once, is rethrown unchanged, and no callback runs', async () => {
    const { pool, coordinator, baseline } = setup()
    const business = Object.assign(new Error('test: 409 business'), { status: 409, code: 'TEST_BUSINESS' })
    let ran = false
    await expect(
      coordinatedTransactionV1({
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        body: async (context) => {
          context.afterCommit(() => {
            ran = true
          })
          throw business
        },
      }),
    ).rejects.toBe(business)
    expect(statements(pool.clients[0].calls)).toEqual(['S1', 'BEGIN', 'S2', 'ROLLBACK'])
    expect(pool.clients[0].released).toEqual([null])
    expect(ran).toBe(false)
    baseline()
  })

  it('a ROLLBACK that fails after a business error destroys the connection but keeps the business error', async () => {
    const { pool, coordinator, baseline } = setup()
    const business = new Error('test: business')
    await expect(
      coordinatedTransactionV1({
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        body: async (context) => {
          pool.clients[0].failOnce.set('ROLLBACK', Object.assign(new Error('test: rollback lost'), { code: '08006' }))
          void context
          throw business
        },
      }),
    ).rejects.toBe(business)
    expect(pool.clients[0].released[0]).toBeInstanceOf(Error)
    expect(pool.clients[0].released[0]).not.toBe(null)
    baseline()
  })

  it('a callback that throws leaves the transaction committed; the other callbacks still run and the failure is reported', async () => {
    const { coordinator, baseline } = setup()
    const reported: unknown[] = []
    const ran: string[] = []
    const failure = new Error('test: callback failed')
    const result = await coordinatedTransactionV1({
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      onCallbackError: (error) => reported.push(error),
      body: async (context) => {
        context.afterCommit(() => {
          ran.push('first')
          throw failure
        })
        context.afterCommit(() => void ran.push('second'))
        return 'committed'
      },
    })
    expect(result).toBe('committed')
    expect(ran).toEqual(['first', 'second'])
    expect(reported).toEqual([failure])
    baseline()
  })

  it('an uncertain COMMIT destroys the connection, runs no callback, does not run the body again, and rethrows the COMMIT error', async () => {
    const { pool, coordinator, baseline } = setup()
    let runs = 0
    let ran = false
    const lost = Object.assign(new Error('test: connection lost at COMMIT'), { code: '08006' })
    await expect(
      coordinatedTransactionV1({
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        body: async (context) => {
          runs += 1
          pool.clients[0].failOnce.set('COMMIT', lost)
          context.afterCommit(() => {
            ran = true
          })
          return 'never'
        },
      }),
    ).rejects.toBe(lost)
    expect(runs).toBe(1)
    expect(ran).toBe(false)
    expect(pool.clients[0].released[0]).toBeInstanceOf(Error)
    baseline()
  })

  it('a COMMIT answered with ROLLBACK is not a commit: destroyed, no callback, the not-committed error is rethrown', async () => {
    const { pool, coordinator, baseline } = setup()
    const realQuery = pool.connect.bind(pool)
    pool.connect = async () => {
      const client = (await realQuery()) as unknown as { query: (sql: string) => Promise<{ rows: unknown[]; command: string }> }
      const query = client.query.bind(client)
      client.query = async (sql: string) => (sql === 'COMMIT' ? { rows: [], command: 'ROLLBACK' } : query(sql))
      return client as never
    }
    await expect(
      coordinatedTransactionV1({ coordinator, request: REQUEST, candidate: { org: ORG }, body: async () => 'never' }),
    ).rejects.toBeInstanceOf(AttendanceCoordinationCommitNotCommittedError)
    expect(pool.clients[0].released[0]).toBeInstanceOf(Error)
    baseline()
  })
})

describe('coordinated transaction port: restarts (P11-A07)', () => {
  it('the restart signal restarts on a new connection; once the counter is used up the caller gets the original error object, never the signal', async () => {
    const { pool, coordinator, baseline } = setup()
    const errors = ['1', '2', '3'].map((label) => serializationError(label))
    let runs = 0
    await expect(
      coordinatedTransactionV1({
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        body: async () => {
          const error = errors[runs]
          runs += 1
          throw new SettlementCoordinationRestartSignalV1(error)
        },
      }),
    ).rejects.toBe(errors[2])
    expect(runs).toBe(3)
    expect(pool.clients).toHaveLength(3)
    for (const client of pool.clients) {
      expect(statements(client.calls)).toEqual(['S1', 'BEGIN', 'S2', 'ROLLBACK'])
      expect(client.released).toEqual([null])
    }
    baseline()
  })

  it('a restart signal followed by success commits once on the second connection', async () => {
    const { pool, coordinator, baseline } = setup()
    let runs = 0
    const result = await coordinatedTransactionV1({
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async (context) => {
        runs += 1
        if (runs === 1) throw new SettlementCoordinationRestartSignalV1(serializationError('first'))
        expect(context.attempt).toBe(2)
        return 'second'
      },
    })
    expect(result).toBe('second')
    expect(statements(pool.clients[1].calls)).toEqual(['S1', 'BEGIN', 'S2', 'COMMIT'])
    baseline()
  })

  it('a plain 40001 from the body is a business error: rolled back and rethrown, no restart', async () => {
    const { pool, coordinator, baseline } = setup()
    const error = serializationError('plain')
    await expect(
      coordinatedTransactionV1({ coordinator, request: REQUEST, candidate: { org: ORG }, body: async () => Promise.reject(error) }),
    ).rejects.toBe(error)
    expect(pool.clients).toHaveLength(1)
    baseline()
  })

  it('a retryable COMMIT restarts with the transaction ended; an entry that must not retry gets its own error', async () => {
    const { pool, coordinator, baseline } = setup()
    let runs = 0
    const result = await coordinatedTransactionV1({
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async () => {
        runs += 1
        if (runs === 1) pool.clients[0].failOnce.set('COMMIT', serializationError('commit'))
        return runs
      },
    })
    expect(result).toBe(2)
    expect(pool.clients[0].calls.filter((sql) => sql === 'ROLLBACK')).toEqual([])
    const contended = new Error('test: CANCEL_ROUND_DISPATCH_CONTENDED')
    const commitError = serializationError('commit, mapped')
    await expect(
      coordinatedTransactionV1({
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        onRetryableCommit: (error) => {
          expect(error).toBe(commitError)
          return contended
        },
        body: async () => {
          pool.clients[pool.clients.length - 1].failOnce.set('COMMIT', commitError)
          return 'never'
        },
      }),
    ).rejects.toBe(contended)
    expect(pool.clients.at(-1)?.released).toEqual([null])
    baseline()
  })

  it('a recheck mismatch re-acquires under the new org; past the limit it ends with the registered conflict code', async () => {
    const { pool, coordinator, baseline } = setup()
    const orgs: string[] = []
    const result = await coordinatedTransactionV1({
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async (context) => {
        orgs.push(context.orgLexical)
        if (context.orgLexical === ORG) throw new SettlementCoordinationRecheckMismatchV1('legacy-org-moved', 'CANCEL_ROUND_ROLLOUT_LOCK_SCOPE_CHANGED')
        return 'moved'
      },
    })
    expect(result).toBe('moved')
    expect(orgs).toEqual([ORG, 'legacy-org-moved'])
    const moving = ['legacy-org-a', 'legacy-org-b', 'legacy-org-c', 'legacy-org-d']
    await expect(
      coordinatedTransactionV1({
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        body: async (context) => {
          const next = moving[moving.indexOf(context.orgLexical) + 1] ?? moving[0]
          throw new SettlementCoordinationRecheckMismatchV1(next, 'CANCEL_ROUND_ROLLOUT_LOCK_SCOPE_CHANGED')
        },
      }),
    ).rejects.toMatchObject({ code: 'CANCEL_ROUND_ROLLOUT_LOCK_SCOPE_CHANGED' })
    expect(pool.clients.length).toBeGreaterThan(2)
    baseline()
  })

  it('an outer retry passes its unit: the inner counters restart, the budget carries over', async () => {
    const { clock, world, coordinator, baseline } = setup()
    const unit = coordinator.openUnit(REQUEST)
    world.dedicatedBusy = true
    const first = coordinatedTransactionV1({
      coordinator,
      request: REQUEST,
      unit,
      candidate: { org: ORG },
      body: async () => Promise.reject(new SettlementCoordinationRestartSignalV1(serializationError('outer 1'))),
    })
    const settled = first.then(
      () => null,
      (error) => error,
    )
    await clock.advance(0)
    world.dedicatedBusy = false
    await clock.advance(25)
    await clock.advance(0)
    // Three restarts with the counter at 2: the first outer attempt ends with the original error.
    expect(await settled).toMatchObject({ code: '40001' })
    expect(unit.innerRestarts.serialization).toBe(3)
    const spent = unit.budget.spentMs
    expect(spent).toBe(25)
    unit.beginOuterAttempt()
    expect(unit.innerRestarts).toEqual({ serialization: 0, recheck: 0 })
    const second = await coordinatedTransactionV1({ coordinator, request: REQUEST, unit, candidate: { org: ORG }, body: async () => 'outer 2' })
    expect(second).toBe('outer 2')
    expect(unit.budget.spentMs).toBe(spent)
    unit.close()
    baseline()
  })

  it('the candidate short read finds the org before the acquisition', async () => {
    const { pool, coordinator, baseline } = setup()
    const result = await coordinatedTransactionV1({
      coordinator,
      request: REQUEST,
      candidate: {
        read: async (client) => {
          await client.query('SELECT org FROM candidate')
          return 'legacy-org-from-candidate'
        },
      },
      body: async (context) => context.orgLexical,
    })
    expect(result).toBe('legacy-org-from-candidate')
    expect(pool.clients[0].calls).toEqual(['SELECT org FROM candidate'])
    expect(statements(pool.clients[1].calls)).toEqual(['S1', 'BEGIN', 'S2', 'COMMIT'])
    baseline()
  })
})

describe('coordinated transaction port: nesting (P11-A11)', () => {
  it('a coordinated transaction inside a body is refused, and so is any quota acquisition there', async () => {
    const { coordinator, baseline } = setup()
    const errors: unknown[] = []
    await coordinatedTransactionV1({
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async () => {
        await coordinatedTransactionV1({ coordinator, request: REQUEST, candidate: { org: 'legacy-org-inner' }, body: async () => 'inner' }).catch((error) => errors.push(error))
        try {
          coordinator.openUnit(REQUEST)
        } catch (error) {
          errors.push(error)
        }
        return 'outer'
      },
    })
    expect(errors).toHaveLength(2)
    for (const error of errors) expect(error).toBeInstanceOf(AttendanceCoordinationNestingError)
    expect((errors as AttendanceCoordinationNestingError[]).map((error) => error.kind)).toEqual(['context', 'quota'])
    baseline()
  })

  it('the port refuses to start inside a pool transaction', async () => {
    const { pool, coordinator, baseline } = setup()
    await expect(
      coordinatedTransactionV1({ coordinator, request: REQUEST, candidate: { org: ORG }, transactionDepth: () => 1, body: async () => 'never' }),
    ).rejects.toMatchObject({ code: 'ATTENDANCE_COORDINATION_NESTED', kind: 'pool-transaction' })
    expect(pool.connects).toBe(0)
    baseline()
  })

  it('main-pool access inside the body counts in production mode and throws in test mode; outside a body nothing happens', async () => {
    const { coordinator, baseline } = setup()
    noteSettlementCoordinationMainPoolAccessV1('test.outside')
    const before = settlementCoordinationNestedMainPoolAccessesV1()
    await coordinatedTransactionV1({
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async () => {
        noteSettlementCoordinationMainPoolAccessV1('test.counted')
        return 'counted'
      },
    })
    expect(settlementCoordinationNestedMainPoolAccessesV1()).toBe(before + 1)
    setSettlementCoordinationNestingModeV1('throw')
    await expect(
      coordinatedTransactionV1({
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        body: async () => {
          noteSettlementCoordinationMainPoolAccessV1('test.thrown')
          return 'never'
        },
      }),
    ).rejects.toMatchObject({ kind: 'main-pool', detail: 'test.thrown' })
    baseline()
  })

  it('a timer started inside the body that fires after commit is outside the context', async () => {
    const { coordinator, baseline } = setup()
    let later: Promise<unknown> | null = null
    await coordinatedTransactionV1({
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async () => {
        later = new Promise((resolve) => setImmediate(() => resolve(currentSettlementCoordinationContextV1())))
        return 'committed'
      },
    })
    expect(await later).toBe(null)
    baseline()
  })

  it('the restart limit on the recheck path names the fallback code when the entry registered none', async () => {
    const { coordinator, baseline } = setup()
    await expect(
      coordinatedTransactionV1({
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        body: async (context) => Promise.reject(new SettlementCoordinationRecheckMismatchV1(context.orgLexical === ORG ? 'legacy-org-x' : ORG)),
      }),
    ).rejects.toBeInstanceOf(SettlementCoordinationScopeChangedError)
    baseline()
  })
})
