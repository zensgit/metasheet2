/**
 * #7 leave cancellation / 销假 (design-lock #3034) — reverseLeaveBalanceDeduction §3 logic.
 * Unit-level: the trx is mocked (routes by SQL), so this verifies the reversal SEMANTICS without a DB —
 * idempotency (§3b), expired-lot non-resurrection (§3a), source_type mirroring (the comp_time correctness
 * fix), the headroom cap, and the no-op-when-nothing-deducted path. Real-DB enforcement of the migration
 * CHECK + the cancel route is covered by the attendance integration suite / staging smoke (§5/§6).
 */
import { describe, it, expect, vi } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const { reverseLeaveBalanceDeduction } = attendancePlugin.__attendanceLeaveCancellationForTests as {
  reverseLeaveBalanceDeduction: (
    trx: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> },
    args: { orgId: string; userId: string; requestId: string },
  ) => Promise<{ reversed: number; lots: number; unrecoverableExpired: number; alreadyReversed: boolean }>
}

type DeductLot = { id: string; deducted: number; remaining: number; amount: number; sourceType?: string; status?: string; expired?: boolean }

function lot(o: DeductLot) {
  return {
    balance_id: o.id,
    delta_minutes: -o.deducted, // a deduct event stores a negative delta
    source_type: o.sourceType ?? 'annual_leave',
    remaining_minutes: o.remaining,
    amount_minutes: o.amount,
    status: o.status ?? 'exhausted',
    expired: o.expired ?? false,
  }
}

function makeTrx(opts: { alreadyReversed?: boolean; deductRows?: ReturnType<typeof lot>[] }) {
  const updates: unknown[][] = []
  const inserts: unknown[][] = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (/event_type = 'reverse' LIMIT 1/.test(sql)) return opts.alreadyReversed ? [{ exists: 1 }] : []
    if (/event_type = 'deduct'/.test(sql)) return opts.deductRows ?? []
    if (/UPDATE attendance_leave_balances/.test(sql)) { updates.push(params ?? []); return [] }
    if (/INSERT INTO attendance_leave_balance_events/.test(sql)) { inserts.push(params ?? []); return [] }
    return []
  })
  return { trx: { query }, updates, inserts }
}

const ARGS = { orgId: 'default', userId: 'u1', requestId: 'req-1' }

describe('reverseLeaveBalanceDeduction (#7 销假 — §3 semantics)', () => {
  it('restores the deducted lot (exhausted→active), writes a positive reverse event, returns the total', async () => {
    const { trx, updates, inserts } = makeTrx({ deductRows: [lot({ id: 'L1', deducted: 60, remaining: 60, amount: 120 })] })
    const res = await reverseLeaveBalanceDeduction(trx, ARGS)
    expect(res).toMatchObject({ reversed: 60, lots: 1, unrecoverableExpired: 0, alreadyReversed: false })
    expect(updates).toEqual([[120, 'L1']]) // remaining 60 → 120
    // INSERT params: [orgId, userId, balance_id, +delta, source_type, requestId]
    expect(inserts).toEqual([['default', 'u1', 'L1', 60, 'annual_leave', 'req-1']])
  })

  it('CORRECTNESS: mirrors source_type per event — a comp_time leave reverses comp_time_leave (not hardcoded annual)', async () => {
    const { trx, inserts } = makeTrx({ deductRows: [lot({ id: 'Lc', deducted: 30, remaining: 0, amount: 30, sourceType: 'comp_time_leave' })] })
    const res = await reverseLeaveBalanceDeduction(trx, ARGS)
    expect(res.reversed).toBe(30)
    expect(inserts[0][4]).toBe('comp_time_leave')
  })

  it('§3b idempotency: a prior reverse exists → no-op (no UPDATE / no INSERT)', async () => {
    const { trx, updates, inserts } = makeTrx({ alreadyReversed: true, deductRows: [lot({ id: 'L1', deducted: 60, remaining: 60, amount: 120 })] })
    const res = await reverseLeaveBalanceDeduction(trx, ARGS)
    expect(res).toMatchObject({ alreadyReversed: true, reversed: 0, lots: 0 })
    expect(updates).toEqual([])
    expect(inserts).toEqual([])
  })

  it('§3a expired lot is NOT resurrected — skipped, counted as unrecoverableExpired, no ledger write', async () => {
    const { trx, updates, inserts } = makeTrx({ deductRows: [lot({ id: 'Le', deducted: 45, remaining: 0, amount: 45, expired: true })] })
    const res = await reverseLeaveBalanceDeduction(trx, ARGS)
    expect(res).toMatchObject({ reversed: 0, lots: 0, unrecoverableExpired: 45 })
    expect(updates).toEqual([])
    expect(inserts).toEqual([])
  })

  it('mixed multi-lot: restores valid lots, skips the expired one (partial restore + unrecoverable surfaced)', async () => {
    const { trx, updates, inserts } = makeTrx({ deductRows: [
      lot({ id: 'L1', deducted: 40, remaining: 0, amount: 40 }),
      lot({ id: 'Le', deducted: 20, remaining: 0, amount: 20, expired: true }),
    ] })
    const res = await reverseLeaveBalanceDeduction(trx, ARGS)
    expect(res).toMatchObject({ reversed: 40, lots: 1, unrecoverableExpired: 20 })
    expect(updates).toEqual([[40, 'L1']])
    expect(inserts).toHaveLength(1)
  })

  it('restore is capped at the lot headroom (never exceeds amount_minutes)', async () => {
    // lot already partly restored by another source: remaining 100, amount 120 → headroom 20; this deduct was 60
    const { trx, updates } = makeTrx({ deductRows: [lot({ id: 'L1', deducted: 60, remaining: 100, amount: 120 })] })
    const res = await reverseLeaveBalanceDeduction(trx, ARGS)
    expect(res.reversed).toBe(20) // capped at headroom 20, not 60
    expect(updates).toEqual([[120, 'L1']]) // remaining 100 → 120 (== amount)
  })

  it('nothing deducted for the request (policy off → no deduct events) → clean no-op', async () => {
    const { trx, updates, inserts } = makeTrx({ deductRows: [] })
    const res = await reverseLeaveBalanceDeduction(trx, ARGS)
    expect(res).toMatchObject({ reversed: 0, lots: 0, unrecoverableExpired: 0, alreadyReversed: false })
    expect(updates).toEqual([])
    expect(inserts).toEqual([])
  })
})
