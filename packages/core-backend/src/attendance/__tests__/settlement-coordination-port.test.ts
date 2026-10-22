import { afterEach, describe, expect, it } from 'vitest'

import {
  AttendanceCoordinationNestingError,
  currentSettlementCoordinationContextV1,
  noteSettlementCoordinationMainPoolAccessV1,
  setSettlementCoordinationNestingModeV1,
  settlementCoordinationNestedMainPoolAccessesV1,
} from '../coordination/settlement-coordination-context'
import {
  AttendanceCoordinationCommitNotCommittedError,
  AttendanceCoordinationConnectionUncertainError,
} from '../coordination/settlement-coordination-handover'
import {
  SettlementCoordinationAttemptAbandonedError,
  SettlementCoordinationRecheckMismatchV1,
  SettlementCoordinationRestartSignalV1,
  coordinatedTransactionV1,
  handOverToSuspendedMethodV1,
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
      transactionDepth: () => 0,
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
      transactionDepth: () => 0,
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
        transactionDepth: () => 0,
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
        transactionDepth: () => 0,
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
      transactionDepth: () => 0,
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
        transactionDepth: () => 0,
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
      coordinatedTransactionV1({ transactionDepth: () => 0, coordinator, request: REQUEST, candidate: { org: ORG }, body: async () => 'never' }),
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
        transactionDepth: () => 0,
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
      transactionDepth: () => 0,
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
      coordinatedTransactionV1({ transactionDepth: () => 0, coordinator, request: REQUEST, candidate: { org: ORG }, body: async () => Promise.reject(error) }),
    ).rejects.toBe(error)
    expect(pool.clients).toHaveLength(1)
    baseline()
  })

  it('a retryable COMMIT restarts with the transaction ended; an entry that must not retry gets its own error', async () => {
    const { pool, coordinator, baseline } = setup()
    let runs = 0
    const result = await coordinatedTransactionV1({
      transactionDepth: () => 0,
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
        transactionDepth: () => 0,
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
      transactionDepth: () => 0,
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
        transactionDepth: () => 0,
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
      transactionDepth: () => 0,
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
    const second = await coordinatedTransactionV1({ transactionDepth: () => 0, coordinator, request: REQUEST, unit, candidate: { org: ORG }, body: async () => 'outer 2' })
    expect(second).toBe('outer 2')
    expect(unit.budget.spentMs).toBe(spent)
    unit.close()
    baseline()
  })

  it('the candidate short read finds the org before the acquisition', async () => {
    const { pool, coordinator, baseline } = setup()
    const result = await coordinatedTransactionV1({
      transactionDepth: () => 0,
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
  // A11 「递归取配额两种模式均拒绝」: the refusal must not depend on the main-pool nesting mode, so the
  // case runs under both. The file's afterEach puts the mode back to 'count' after each run.
  it.each(['count', 'throw'] as const)('a coordinated transaction inside a body is refused, and so is any quota acquisition there - nesting mode %s', async (mode) => {
    const { coordinator, baseline } = setup()
    setSettlementCoordinationNestingModeV1(mode)
    const countedBefore = settlementCoordinationNestedMainPoolAccessesV1()
    const errors: unknown[] = []
    const outer = await coordinatedTransactionV1({
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      transactionDepth: () => 0,
      body: async () => {
        await coordinatedTransactionV1({ coordinator, request: REQUEST, candidate: { org: 'legacy-org-inner' }, transactionDepth: () => 0, body: async () => 'inner' }).catch((error) => errors.push(error))
        try {
          coordinator.openUnit(REQUEST)
        } catch (error) {
          errors.push(error)
        }
        return 'outer'
      },
    })
    expect(outer).toBe('outer')
    expect(errors).toHaveLength(2)
    for (const error of errors) expect(error).toBeInstanceOf(AttendanceCoordinationNestingError)
    expect(
      (errors as AttendanceCoordinationNestingError[]).map((error) => ({ code: error.code, kind: error.kind, detail: error.detail, message: error.message })),
    ).toEqual([
      { code: 'ATTENDANCE_COORDINATION_NESTED', kind: 'context', detail: null, message: 'ATTENDANCE_COORDINATION_NESTED:context' },
      { code: 'ATTENDANCE_COORDINATION_NESTED', kind: 'quota', detail: null, message: 'ATTENDANCE_COORDINATION_NESTED:quota' },
    ])
    // Neither refusal is a main-pool access: nothing is counted in either mode.
    expect(settlementCoordinationNestedMainPoolAccessesV1()).toBe(countedBefore)
    // The mode the case ran under is still the one it set (setting it again returns the previous mode).
    expect(setSettlementCoordinationNestingModeV1(mode)).toBe(mode)
    baseline()
  })

  // S5 G5: in the case above the port's own context check refuses first, so the unit's checks were
  // never reached. Here the unit is opened outside any context and used inside one: only the unit's
  // own `assertNoSettlementCoordinationContextV1('quota')` stands between it and a second quota.
  const quotaNesting = { code: 'ATTENDANCE_COORDINATION_NESTED', kind: 'quota', detail: null, message: 'ATTENDANCE_COORDINATION_NESTED:quota' }
  const describeNesting = (errors: unknown[]) =>
    errors.map((error) => (error instanceof AttendanceCoordinationNestingError ? { code: error.code, kind: error.kind, detail: error.detail, message: error.message } : error))

  it.each(['count', 'throw'] as const)('a unit opened outside any context is refused acquire() inside a body with the quota nesting error, before it takes anything - nesting mode %s (kills S5G-A11-M3s-acquire)', async (mode) => {
    const { pool, coordinator, baseline } = setup()
    setSettlementCoordinationNestingModeV1(mode)
    const countedBefore = settlementCoordinationNestedMainPoolAccessesV1()
    const outside = coordinator.openUnit(REQUEST)
    const errors: unknown[] = []
    const outer = await coordinatedTransactionV1({
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      transactionDepth: () => 0,
      body: async () => {
        await outside.acquire('legacy-org-inner').then(
          () => errors.push('acquired'),
          (error) => errors.push(error),
        )
        return 'outer'
      },
    })
    expect(outer).toBe('outer')
    expect(describeNesting(errors)).toEqual([quotaNesting])
    // Only the outer transaction borrowed; the refused unit took no quota or connection and stays usable.
    expect(pool.connects).toBe(1)
    expect(outside.active).toBe(false)
    expect(settlementCoordinationNestedMainPoolAccessesV1()).toBe(countedBefore)
    outside.close()
    baseline()
  })

  it.each(['count', 'throw'] as const)('a unit opened outside any context is refused readCandidate() inside a body with the quota nesting error, before the read runs - nesting mode %s (kills S5G-A11-M3s-readCandidate)', async (mode) => {
    const { pool, coordinator, baseline } = setup()
    setSettlementCoordinationNestingModeV1(mode)
    const countedBefore = settlementCoordinationNestedMainPoolAccessesV1()
    const outside = coordinator.openUnit(REQUEST)
    const errors: unknown[] = []
    let reads = 0
    const outer = await coordinatedTransactionV1({
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      transactionDepth: () => 0,
      body: async () => {
        await outside
          .readCandidate(async () => {
            reads += 1
            return 'legacy-org-inner'
          })
          .then(
            () => errors.push('read'),
            (error) => errors.push(error),
          )
        return 'outer'
      },
    })
    expect(outer).toBe('outer')
    expect(describeNesting(errors)).toEqual([quotaNesting])
    expect(reads).toBe(0)
    expect(pool.connects).toBe(1)
    expect(settlementCoordinationNestedMainPoolAccessesV1()).toBe(countedBefore)
    outside.close()
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
    // Explicit, not inherited from the previous case's afterEach: the setup files start in 'throw'.
    setSettlementCoordinationNestingModeV1('count')
    const { coordinator, baseline } = setup()
    noteSettlementCoordinationMainPoolAccessV1('test.outside')
    const before = settlementCoordinationNestedMainPoolAccessesV1()
    await coordinatedTransactionV1({
      transactionDepth: () => 0,
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
        transactionDepth: () => 0,
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
      transactionDepth: () => 0,
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
        transactionDepth: () => 0,
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        body: async (context) => Promise.reject(new SettlementCoordinationRecheckMismatchV1(context.orgLexical === ORG ? 'legacy-org-x' : ORG)),
      }),
    ).rejects.toBeInstanceOf(SettlementCoordinationScopeChangedError)
    // S1 note 8: answering the fallback code is never silent.
    expect(coordinator.deps.stats.scopeChangedFallbacks).toBe(1)
    baseline()
  })
})

describe('coordinated transaction port: recheck detail and abandon notices', () => {
  it('the next attempt sees the detail of the recheck mismatch that restarted it', async () => {
    const { coordinator, baseline } = setup()
    const seen: unknown[] = []
    await coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async (context) => {
        seen.push(context.recheck)
        if (context.attempt === 1) throw new SettlementCoordinationRecheckMismatchV1('legacy-org-moved', 'TEST_CONFLICT', { kind: 'moved' })
        return 'second'
      },
    })
    expect(seen).toEqual([null, { kind: 'moved' }])
    baseline()
  })

  it('abandon observers run once when the attempt ends without a commit, and never on a commit', async () => {
    const { pool, coordinator, baseline } = setup()
    const notices: string[] = []
    let runs = 0
    await coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async (context) => {
        runs += 1
        context.onAbandon(() => void notices.push(`abandoned ${runs}`))
        if (runs === 1) throw new SettlementCoordinationRestartSignalV1(serializationError('abandon'))
        if (runs === 2) pool.clients[pool.clients.length - 1].failOnce.set('COMMIT', serializationError('commit'))
        return runs
      },
    })
    expect(notices).toEqual(['abandoned 1', 'abandoned 2'])
    await expect(
      coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        body: async (context) => {
          context.onAbandon(() => void notices.push('abandoned by error'))
          throw new Error('test: business')
        },
      }),
    ).rejects.toThrow('test: business')
    expect(notices).toEqual(['abandoned 1', 'abandoned 2', 'abandoned by error'])
    baseline()
  })
})

describe('coordinated transaction port: a method suspended at its own COMMIT', () => {
  it('everything the method does after its COMMIT runs after the port committed and released', async () => {
    const { pool, coordinator, quota, baseline } = setup()
    const order: string[] = []
    const result = await coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async (context) =>
        handOverToSuspendedMethodV1(context, async (commit) => {
          await context.client.query('UPDATE t SET v = 1')
          order.push('before commit')
          await commit()
          order.push(`after commit: held=${quota.snapshot().global.short.held} released=${pool.clients[0].released.length} context=${String(currentSettlementCoordinationContextV1())}`)
          return 'approval read after release'
        }),
    })
    expect(result).toBe('approval read after release')
    expect(order).toEqual(['before commit', 'after commit: held=0 released=1 context=null'])
    expect(pool.clients[0].calls.filter((sql) => sql === 'COMMIT')).toHaveLength(1)
    baseline()
  })

  it('an error before the commit is the body error: the port rolls back and rethrows it', async () => {
    const { pool, coordinator, baseline } = setup()
    const business = new Error('test: 409 before commit')
    await expect(
      coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        body: async (context) => handOverToSuspendedMethodV1(context, async () => Promise.reject(business)),
      }),
    ).rejects.toBe(business)
    expect(pool.clients[0].calls.at(-1)).toBe('ROLLBACK')
    baseline()
  })

  it('an attempt that ends without a commit wakes the suspended method with the abandon error; the next attempt runs the method again', async () => {
    const { pool, coordinator, baseline } = setup()
    const woken: unknown[] = []
    let runs = 0
    const result = await coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async (context) =>
        handOverToSuspendedMethodV1(context, async (commit) => {
          runs += 1
          if (runs === 1) pool.clients[0].failOnce.set('COMMIT', serializationError('commit'))
          try {
            await commit()
          } catch (error) {
            woken.push(error)
            throw error
          }
          return `run ${runs}`
        }),
    })
    expect(result).toBe('run 2')
    expect(woken).toHaveLength(1)
    expect(woken[0]).toBeInstanceOf(SettlementCoordinationAttemptAbandonedError)
    baseline()
  })

  it('a method that returns without asking to commit is refused and rolled back', async () => {
    const { pool, coordinator, baseline } = setup()
    await expect(
      coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        body: async (context) => handOverToSuspendedMethodV1(context, async () => 'no commit'),
      }),
    ).rejects.toThrow(/returned without asking to commit/)
    expect(pool.clients[0].calls.at(-1)).toBe('ROLLBACK')
    baseline()
  })
})

describe('coordinated transaction port: connection errors while held (S1 note 1; Codex S3-CX-01)', () => {
  const lost = () => new Error('test: connection lost')

  it('an error between two statements of the body: nothing goes unhandled, the next statement fails, the connection is destroyed once, no callback, the listener comes off', async () => {
    const { pool, coordinator, baseline } = setup()
    let ran = false
    const failure = await coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async (context) => {
        context.afterCommit(() => {
          ran = true
        })
        const client = pool.clients[0]
        await new Promise<void>((resolve) =>
          setImmediate(() => {
            client.lose(lost())
            resolve()
          }),
        )
        await context.client.query('UPDATE t SET v = 1')
        return 'never'
      },
    }).then(
      () => null,
      (error) => error,
    )
    const client = pool.clients[0]
    expect((failure as Error).message).toMatch(/not queryable/)
    expect(ran).toBe(false)
    expect(client.calls.filter((sql) => sql === 'COMMIT')).toEqual([])
    expect(client.released).toHaveLength(1)
    expect(client.released[0]).toBeInstanceOf(Error)
    expect(client.listenerCount('error')).toBe(0)
    baseline()
  })

  it('an error after the last statement: no COMMIT is sent, the connection is destroyed once, abandon notices run and the connection error goes up', async () => {
    const { pool, coordinator, baseline } = setup()
    const error = lost()
    let abandoned = 0
    const failure = await coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async (context) => {
        context.onAbandon(() => {
          abandoned += 1
        })
        await context.client.query('UPDATE t SET v = 1')
        pool.clients[0].lose(error)
        return 'never'
      },
    }).then(
      () => null,
      (thrown) => thrown,
    )
    const client = pool.clients[0]
    expect(failure).toBe(error)
    expect(statements(client.calls)).toEqual(['S1', 'BEGIN', 'S2', 'UPDATE'])
    expect(client.released).toHaveLength(1)
    expect(client.released[0]).toBeInstanceOf(AttendanceCoordinationConnectionUncertainError)
    expect(abandoned).toBe(1)
    expect(client.listenerCount('error')).toBe(0)
    baseline()
  })

  it('repeated error events are absorbed: one destroy, the first error is the one reported', async () => {
    const { pool, coordinator, baseline } = setup()
    const first = lost()
    const failure = await coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async () => {
        pool.clients[0].lose(first)
        pool.clients[0].emit('error', new Error('test: second event'))
        return 'never'
      },
    }).then(
      () => null,
      (thrown) => thrown,
    )
    expect(failure).toBe(first)
    expect(pool.clients[0].released).toHaveLength(1)
    expect(pool.clients[0].listenerCount('error')).toBe(0)
    baseline()
  })

  it('an error while the handover is in flight fails the acquisition with the connection destroyed; the body never runs', async () => {
    const { world, pool, coordinator, baseline } = setup()
    world.before.set('SELECT x_k', async () => {
      pool.clients[0].lose(lost())
    })
    let ran = false
    await expect(
      coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        body: async () => {
          ran = true
          return 'never'
        },
      }),
    ).rejects.toBeInstanceOf(AttendanceCoordinationConnectionUncertainError)
    expect(ran).toBe(false)
    expect(pool.clients[0].released).toHaveLength(1)
    expect(pool.clients[0].released[0]).toBeInstanceOf(Error)
    expect(pool.clients[0].listenerCount('error')).toBe(0)
    baseline()
  })

  it('an error during the candidate short read destroys that connection and fails the read', async () => {
    const { pool, coordinator, baseline } = setup()
    const failure = await coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: REQUEST,
      candidate: {
        read: async (client) => {
          pool.clients[0].lose(lost())
          await client.query('SELECT 1')
          return ORG
        },
      },
      body: async () => 'never',
    }).then(
      () => null,
      (thrown) => thrown,
    )
    expect((failure as Error).message).toMatch(/not queryable/)
    expect(pool.clients).toHaveLength(1)
    expect(pool.clients[0].released[0]).toBeInstanceOf(Error)
    expect(pool.clients[0].listenerCount('error')).toBe(0)
    baseline()
  })

  it('a connection that reported an error during a candidate read that still returned is destroyed, not returned to the pool', async () => {
    const { pool, coordinator, baseline } = setup()
    const result = await coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: REQUEST,
      candidate: {
        read: async () => {
          pool.clients[0].lose(lost())
          return ORG
        },
      },
      body: async () => 'committed on the next connection',
    })
    expect(result).toBe('committed on the next connection')
    expect(pool.clients).toHaveLength(2)
    expect(pool.clients[0].released).toHaveLength(1)
    expect(pool.clients[0].released[0]).toBeInstanceOf(Error)
    expect(pool.clients[0].listenerCount('error')).toBe(0)
    expect(pool.clients[1].released).toEqual([null])
    baseline()
  })

  it('a clean commit takes only its own listener off: a listener someone else added stays, and none of ours reaches the next borrower', async () => {
    const { pool, coordinator, baseline } = setup()
    const other = (): void => undefined
    await coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async () => {
        expect(pool.clients[0].listenerCount('error')).toBe(1)
        pool.clients[0].on('error', other)
        return 'first'
      },
    })
    expect(pool.clients[0].released).toEqual([null])
    expect(pool.clients[0].listeners('error')).toEqual([other])
    await coordinatedTransactionV1({ transactionDepth: () => 0, coordinator, request: REQUEST, candidate: { org: ORG }, body: async () => 'second' })
    expect(pool.clients[1].listenerCount('error')).toBe(0)
    baseline()
  })
})

describe('coordinated transaction port: a failing error reporter (Codex S3-CX-05)', () => {
  it('a reporter that throws neither stops the remaining callbacks nor leaves a method suspended at its COMMIT hanging', async () => {
    const { pool, coordinator, baseline } = setup()
    const ran: string[] = []
    let resumed = false
    const result = await coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      onCallbackError: () => {
        throw new Error('test: reporter failed')
      },
      body: async (context) =>
        handOverToSuspendedMethodV1(context, async (commit) => {
          context.afterCommit(() => {
            ran.push('first')
            throw new Error('test: callback failed')
          })
          context.afterCommit(() => void ran.push('second'))
          await commit()
          resumed = true
          return 'resumed'
        }),
    })
    expect(result).toBe('resumed')
    expect(resumed).toBe(true)
    expect(ran).toEqual(['first', 'second'])
    expect(pool.clients[0].calls.filter((sql) => sql === 'COMMIT')).toHaveLength(1)
    baseline()
  })
})

describe('coordinated transaction port: review round 1, Opus findings', () => {
  it('two coordinated transactions running at once each see only their own context (A11; Opus P2-3)', async () => {
    const { coordinator, baseline } = setup()
    const OTHER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a'
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let arrived = 0
    const seen: Record<string, string[]> = { [ORG]: [], [OTHER]: [] }
    const run = (org: string) =>
      coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator,
        request: REQUEST,
        candidate: { org },
        body: async () => {
          seen[org].push(String(currentSettlementCoordinationContextV1()?.orgLexical))
          arrived += 1
          if (arrived === 2) release()
          await barrier
          seen[org].push(String(currentSettlementCoordinationContextV1()?.orgLexical))
          return org
        },
      })
    await expect(Promise.all([run(ORG), run(OTHER)])).resolves.toEqual([ORG, OTHER])
    expect(seen).toEqual({ [ORG]: [ORG, ORG], [OTHER]: [OTHER, OTHER] })
    baseline()
  })

  it('a post-commit callback of one transaction runs outside every context while another transaction\'s body runs', async () => {
    const { coordinator, baseline } = setup()
    const OTHER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a'
    let inCallback: unknown = 'not run'
    let release!: () => void
    const bodyHeld = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const otherEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const other = coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: REQUEST,
      candidate: { org: OTHER },
      body: async () => {
        entered()
        await bodyHeld
        return currentSettlementCoordinationContextV1()?.orgLexical
      },
    })
    await otherEntered
    await coordinatedTransactionV1({
      transactionDepth: () => 0,
      coordinator,
      request: REQUEST,
      candidate: { org: ORG },
      body: async (context) => {
        context.afterCommit(() => {
          inCallback = currentSettlementCoordinationContextV1()
        })
        return 'first'
      },
    })
    release()
    await expect(other).resolves.toBe(OTHER)
    expect(inCallback).toBeNull()
    baseline()
  })

  it('an error the suspended method throws after its COMMIT reaches the caller; the transaction stays committed and the resources are back (Opus P3-3, OM-B1)', async () => {
    const { pool, coordinator, baseline } = setup()
    const after = new Error('test: post-commit work failed')
    await expect(
      coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        body: async (context) =>
          handOverToSuspendedMethodV1(context, async (commit) => {
            await commit()
            throw after
          }),
      }),
    ).rejects.toBe(after)
    expect(pool.clients[0].calls.filter((sql) => sql === 'COMMIT')).toHaveLength(1)
    expect(pool.clients[0].released).toEqual([null])
    baseline()
  })

  it('a second commit() in one attempt is refused as a programming error: the first one still commits once, and the error reaches the caller (Opus NIT-2)', async () => {
    const { pool, coordinator, baseline } = setup()
    await expect(
      coordinatedTransactionV1({
        transactionDepth: () => 0,
        coordinator,
        request: REQUEST,
        candidate: { org: ORG },
        body: async (context) =>
          handOverToSuspendedMethodV1(context, async (commit) => {
            void commit()
            await commit()
            return 'never'
          }),
      }),
    ).rejects.toThrow('commit() called twice')
    expect(pool.clients[0].calls.filter((sql) => sql === 'COMMIT')).toHaveLength(1)
    expect(pool.clients[0].released).toEqual([null])
    baseline()
  })

  it('the nesting mode accepts only its two values (Opus P3-9)', () => {
    expect(() => setSettlementCoordinationNestingModeV1('loud' as never)).toThrow(TypeError)
    expect(setSettlementCoordinationNestingModeV1('count')).toBe('count')
  })
})

