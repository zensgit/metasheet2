import { describe, expect, it } from 'vitest'
import type { FormSchema } from '../../src/types/approval-product'
import { validateAmountTotalConsistency } from '../../src/services/amount-total-check'

// Gate A — the pure server-side total-check control. The subtle cases live here (under/over-stated,
// money-safe float, schema-derived scale, fail-closed on malformed input). Hidden/pruned rows are a
// CALLER concern (createApproval prunes before calling) and are covered by Gate B's real-DB test.

const schema = (amountPrecision?: number): FormSchema => ({
  fields: [
    { id: 'amount', type: 'number', label: '总额', ...(amountPrecision !== undefined ? { props: { precision: amountPrecision } } : {}) },
    {
      id: 'items',
      type: 'detail',
      label: '明细',
      columns: [
        { id: 'name', type: 'text', label: '名称' },
        { id: 'amount', type: 'number', label: '金额', ...(amountPrecision !== undefined ? { props: { precision: amountPrecision } } : {}) },
      ],
    },
  ],
})
const MAP = { totalFieldId: 'amount', detailFieldId: 'items', amountColumnId: 'amount' }

describe('validateAmountTotalConsistency (Gate A — pure server-side total-check)', () => {
  it('passes when the total equals the row sum', () => {
    expect(validateAmountTotalConsistency(schema(), { amount: 300, items: [{ amount: 100 }, { amount: 200 }] }, MAP)).toBeNull()
  })
  it('rejects an UNDER-stated total (the bypass it exists to block)', () => {
    expect(validateAmountTotalConsistency(schema(), { amount: 100, items: [{ amount: 100 }, { amount: 200 }] }, MAP)).toMatch(/不一致/)
  })
  it('rejects an over-stated total', () => {
    expect(validateAmountTotalConsistency(schema(), { amount: 500, items: [{ amount: 100 }, { amount: 200 }] }, MAP)).toMatch(/不一致/)
  })
  it('is money-safe: 0.1 + 0.2 === 0.3 (no float-drift phantom mismatch)', () => {
    expect(validateAmountTotalConsistency(schema(), { amount: 0.3, items: [{ amount: 0.1 }, { amount: 0.2 }] }, MAP)).toBeNull()
  })
  it('derives the scale from the amount field precision (4-decimal amounts compare exactly)', () => {
    // 0.1234 + 0.1111 = 0.2345 — passes at precision 4; a fixed-2 scale would have rounded both to 0.12+0.11=0.23 and mis-compared
    expect(validateAmountTotalConsistency(schema(4), { amount: 0.2345, items: [{ amount: 0.1234 }, { amount: 0.1111 }] }, MAP)).toBeNull()
    expect(validateAmountTotalConsistency(schema(4), { amount: 0.234, items: [{ amount: 0.1234 }, { amount: 0.1111 }] }, MAP)).toMatch(/不一致/)
  })
  it('fail-closed on a missing / non-numeric total', () => {
    expect(validateAmountTotalConsistency(schema(), { items: [{ amount: 100 }] }, MAP)).toMatch(/总额.*缺失或非数字/)
    expect(validateAmountTotalConsistency(schema(), { amount: '100', items: [{ amount: 100 }] }, MAP)).toMatch(/总额.*缺失或非数字/)
  })
  it('fail-closed on a non-array detail / non-numeric amount cell', () => {
    expect(validateAmountTotalConsistency(schema(), { amount: 100, items: 'nope' }, MAP)).toMatch(/不是有效的明细数组/)
    expect(validateAmountTotalConsistency(schema(), { amount: 100, items: [{ amount: 'x' }] }, MAP)).toMatch(/明细行金额.*缺失或非数字/)
  })
  it('fail-closed when the mapping points at a missing / wrong-typed field', () => {
    expect(validateAmountTotalConsistency(schema(), { amount: 100, items: [] }, { ...MAP, totalFieldId: 'ghost' })).toMatch(/总额字段.*不存在或非数字/)
    expect(validateAmountTotalConsistency(schema(), { amount: 100, items: [] }, { ...MAP, detailFieldId: 'amount' })).toMatch(/明细字段.*不存在或非明细/)
    expect(validateAmountTotalConsistency(schema(), { amount: 100, items: [] }, { ...MAP, amountColumnId: 'name' })).toMatch(/明细金额列.*不存在或非数字/)
  })
  it('an empty detail with a zero total is consistent; a non-zero total over an empty detail is rejected', () => {
    expect(validateAmountTotalConsistency(schema(), { amount: 0, items: [] }, MAP)).toBeNull()
    expect(validateAmountTotalConsistency(schema(), { amount: 50, items: [] }, MAP)).toMatch(/不一致/)
  })
})
