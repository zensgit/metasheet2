import { describe, expect, it } from 'vitest'
import type { FormField } from '../src/types/approval'
import { computeConsistentTotal, numberFieldScale, autoSumTotalFromMapping } from '../src/approvals/amountAutoSum'

// The PARITY harness (design-lock #3189, Decision 6): apps/web cannot import the real backend
// validateAmountTotalConsistency, so we re-state its ALL-NUMERIC accept branch here —
// `round(total·10^scale) === Σ round(cell·10^scale)` — and assert the auto-filled total ALWAYS clears it.
// NOTE: this is NOT a full mirror. The real backend REJECTS a non-numeric amount cell (returns an error;
// it does not treat it as 0). `clearsBackstop` is therefore only ever fed numeric/empty rows, where the
// re-statement is faithful and the assertion is the closed loop. The incomplete-row case
// (cellToScaledInt → 0) keeps the LIVE total useful while typing, but at SUBMIT a non-numeric cell is a
// backend reject — not a "total clears" path — so it is deliberately NOT asserted through clearsBackstop.
function backendScaledSum(rows: Array<Record<string, unknown>>, col: string, scale: number): number {
  return rows.reduce((sum, row) => {
    const cell = row[col]
    return sum + (typeof cell === 'number' && Number.isFinite(cell) ? Math.round(cell * 10 ** scale) : 0)
  }, 0)
}
function clearsBackstop(rows: Array<Record<string, unknown>>, col: string, scale: number): boolean {
  const total = computeConsistentTotal(rows, col, scale)
  return Math.round(total * 10 ** scale) === backendScaledSum(rows, col, scale)
}

describe('computeConsistentTotal — parity with the backend total-check (closed loop)', () => {
  it('round-each-then-sum, NOT sum-then-round: 0.005 + 0.005 at scale 2 → 0.02 (2 minor units), clears', () => {
    const rows = [{ amount: 0.005 }, { amount: 0.005 }]
    // sum-then-round would give 0.01 → backend round(0.01·100)=1 ≠ 2 → REJECT. round-each-then-sum gives 0.02.
    expect(computeConsistentTotal(rows, 'amount', 2)).toBe(0.02)
    expect(backendScaledSum(rows, 'amount', 2)).toBe(2)
    expect(clearsBackstop(rows, 'amount', 2)).toBe(true)
  })
  it('0.1 + 0.2 = 0.3 — no float drift, clears the backstop', () => {
    const rows = [{ amount: 0.1 }, { amount: 0.2 }]
    expect(computeConsistentTotal(rows, 'amount', 2)).toBe(0.3)
    expect(clearsBackstop(rows, 'amount', 2)).toBe(true)
  })
  it('4-decimal column: 0.1234 + 0.1111 = 0.2345 clears at scale 4', () => {
    const rows = [{ amount: 0.1234 }, { amount: 0.1111 }]
    expect(computeConsistentTotal(rows, 'amount', 4)).toBe(0.2345)
    expect(clearsBackstop(rows, 'amount', 4)).toBe(true)
  })
  it('a realistic multi-row purchase clears the backstop', () => {
    const rows = [{ amount: 1999.99 }, { amount: 0.01 }, { amount: 18000 }]
    expect(computeConsistentTotal(rows, 'amount', 2)).toBe(20000)
    expect(clearsBackstop(rows, 'amount', 2)).toBe(true)
  })
  it('empty / non-array detail → 0, and 0 clears the backstop', () => {
    expect(computeConsistentTotal([], 'amount', 2)).toBe(0)
    expect(computeConsistentTotal(undefined, 'amount', 2)).toBe(0)
    expect(clearsBackstop([], 'amount', 2)).toBe(true)
  })
  it('incomplete rows: a not-yet-filled / non-numeric / missing amount cell counts as 0 for the live total', () => {
    const rows = [{ amount: 100 }, { amount: '' }, { other: 1 }, { amount: 50 }, { amount: null }]
    expect(computeConsistentTotal(rows, 'amount', 2)).toBe(150)
  })
})

describe('numberFieldScale — mirrors the backend (props.precision, clamp 0..6, default 2)', () => {
  const f = (precision?: unknown): FormField => ({ id: 'a', type: 'number', label: 'A', ...(precision !== undefined ? { props: { precision } } : {}) } as FormField)
  it('reads an integer precision in 0..6', () => { expect(numberFieldScale(f(4))).toBe(4); expect(numberFieldScale(f(0))).toBe(0) })
  it('defaults to 2 when absent / out-of-range / non-integer', () => {
    expect(numberFieldScale(f())).toBe(2)
    expect(numberFieldScale(f(9))).toBe(2)
    expect(numberFieldScale(f(2.5))).toBe(2)
    expect(numberFieldScale(undefined)).toBe(2)
  })
})

describe('autoSumTotalFromMapping — resolves the amount-column scale from the schema', () => {
  const schema = (precision?: number) => ({
    fields: [
      { id: 'amount', type: 'number', label: '总额' },
      { id: 'items', type: 'detail', label: '明细', columns: [
        { id: 'name', type: 'text', label: '名称' },
        { id: 'amount', type: 'number', label: '金额', ...(precision !== undefined ? { props: { precision } } : {}) },
      ] },
    ],
  }) as never
  const MAP = { totalFieldId: 'amount', detailFieldId: 'items', amountColumnId: 'amount' }
  it('sums at the amount column precision (4-decimal) from a real schema', () => {
    expect(autoSumTotalFromMapping(schema(4), { items: [{ amount: 0.1234 }, { amount: 0.1111 }] }, MAP)).toBe(0.2345)
  })
  it('defaults to scale 2 when the amount column declares no precision', () => {
    expect(autoSumTotalFromMapping(schema(), { items: [{ amount: 100 }, { amount: 200 }] }, MAP)).toBe(300)
  })
})
