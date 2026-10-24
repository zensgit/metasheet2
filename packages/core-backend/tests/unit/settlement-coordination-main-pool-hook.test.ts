/**
 * P1-1 allowed change 2 (r6.1 §3.2 step 11): the production pool notes every connection it hands out.
 * Inside a live coordination context the note is counted in `'count'` mode (production), after which the
 * connection attempt still goes to pg, and refused in `'throw'` mode (tests) before any connection
 * attempt; outside one it does nothing. pg's own `query` borrows through `connect`, so it is noted
 * exactly once, not twice. The pool points at a closed port, so the connections themselves fail fast:
 * only the notes, and whether an attempt reached pg (`totalCount`), are under test.
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  AttendanceCoordinationNestingError,
  runInSettlementCoordinationContextV1,
  setSettlementCoordinationNestingModeV1,
  settlementCoordinationNestedMainPoolAccessesV1,
  type SettlementCoordinationContextV1,
} from '../../src/attendance/coordination/settlement-coordination-context'
import { ConnectionPool } from '../../src/integration/db/connection-pool'

const live: SettlementCoordinationContextV1 = {
  connection: {},
  orgLexical: 'hook-test',
  classZeroHeld: false,
  entryLabel: 'test.hook',
  isLive: () => true,
  covers: () => false,
}

function closedPool(): ConnectionPool {
  return new ConnectionPool({ host: '127.0.0.1', port: 1, max: 2, connectionTimeoutMillis: 500, name: 'hook-test' })
}

afterEach(() => {
  setSettlementCoordinationNestingModeV1('count')
})

describe('production pool: settlement coordination nesting notes (P1-1 allowed change 2)', () => {
  it('count mode: inside a live context a raw connect, a raw query and a ConnectionPool query are each noted once and then let through to pg', async () => {
    // Production behaviour; tests default to 'throw' (tests/setup.ts).
    setSettlementCoordinationNestingModeV1('count')
    const pool = closedPool()
    try {
      const before = settlementCoordinationNestedMainPoolAccessesV1()
      await runInSettlementCoordinationContextV1(live, async () => {
        const raw = pool.getInternalPool()
        // pg-pool creates the client synchronously inside connect (and query / ConnectionPool.query reach
        // connect synchronously), so totalCount 1 right after the call means the attempt reached pg;
        // the failed client is dropped again before the attempt settles.
        const attempts: Array<[string, () => Promise<unknown>]> = [
          ['raw connect', () => Promise.resolve(raw.connect()).then((client) => client.release())],
          ['raw query', () => raw.query('SELECT 1')],
          ['ConnectionPool query', () => pool.query('SELECT 1')],
        ]
        for (const [index, [name, attempt]] of attempts.entries()) {
          expect(raw.totalCount, `${name}: no client before the attempt`).toBe(0)
          const pending = attempt()
          expect(raw.totalCount, `${name}: the attempt reached pg`).toBe(1)
          const reason = await pending.then(() => null, (error: unknown) => error)
          expect(reason, `${name}: counted, not refused`).not.toBeInstanceOf(AttendanceCoordinationNestingError)
          expect(settlementCoordinationNestedMainPoolAccessesV1()).toBe(before + index + 1)
        }
      })
    } finally {
      await pool.getInternalPool().end()
    }
  })

  it('throw mode: inside a live context connect is refused with the main-pool nesting error before any connection attempt, promise and callback forms alike', async () => {
    const pool = closedPool()
    setSettlementCoordinationNestingModeV1('throw')
    try {
      await runInSettlementCoordinationContextV1(live, async () => {
        const raw = pool.getInternalPool()
        const refused = raw.connect()
        expect(raw.totalCount).toBe(0)
        await expect(refused).rejects.toMatchObject({ code: 'ATTENDANCE_COORDINATION_NESTED', kind: 'main-pool' })
        const viaCallback = await new Promise<unknown>((resolve) => {
          ;(raw as unknown as { connect: (callback: (error: unknown) => void) => void }).connect((error) => resolve(error))
        })
        expect(viaCallback).toBeInstanceOf(AttendanceCoordinationNestingError)
        await expect(raw.query('SELECT 1')).rejects.toBeInstanceOf(AttendanceCoordinationNestingError)
        expect(raw.totalCount).toBe(0)
      })
    } finally {
      await pool.getInternalPool().end()
    }
  })

  it('outside any context nothing is noted and nothing is refused, in either mode', async () => {
    const pool = closedPool()
    try {
      const before = settlementCoordinationNestedMainPoolAccessesV1()
      setSettlementCoordinationNestingModeV1('throw')
      const attempt = pool.getInternalPool().connect()
      expect(pool.getInternalPool().totalCount).toBe(1)
      await Promise.resolve(attempt).then((client) => client.release(), (error) => {
        expect(error).not.toBeInstanceOf(AttendanceCoordinationNestingError)
      })
      expect(settlementCoordinationNestedMainPoolAccessesV1()).toBe(before)
    } finally {
      await pool.getInternalPool().end()
    }
  })
})
