import { describe, expect, it } from 'vitest'
import type { FormField } from '../src/types/approval'
import {
  applyRowDerivations,
  columnDerivation,
  computeRowDerivation,
  isDerivedColumn,
  isRowDerivationActive,
} from '../src/approvals/lineDerivation'

const col = (derivedFrom?: unknown): FormField =>
  ({ id: 'amount', type: 'number', label: '小计', props: { precision: 2, ...(derivedFrom !== undefined ? { derivedFrom } : {}) } } as FormField)

describe('columnDerivation — defensive parse of props.derivedFrom (FE is the sole validator)', () => {
  it('parses a valid product declaration', () => {
    expect(columnDerivation(col({ operandColumnIds: ['quantity', 'unit_price'], operation: 'product' })))
      .toEqual({ operandColumnIds: ['quantity', 'unit_price'], operation: 'product' })
  })
  it('returns null (→ manual column) for malformed / partial / wrong-typed declarations', () => {
    expect(columnDerivation(col())).toBeNull()
    expect(columnDerivation(col({ operandColumnIds: [], operation: 'product' }))).toBeNull()
    expect(columnDerivation(col({ operandColumnIds: ['quantity', 2], operation: 'product' }))).toBeNull()
    expect(columnDerivation(col({ operandColumnIds: ['quantity'], operation: 'sum' }))).toBeNull()
    expect(columnDerivation(col({ operation: 'product' }))).toBeNull()
    expect(columnDerivation(col('nope'))).toBeNull()
    expect(columnDerivation({ id: 'x', type: 'number', label: 'x' } as FormField)).toBeNull()
    expect(columnDerivation(undefined)).toBeNull()
  })
  it('isDerivedColumn reflects validity', () => {
    expect(isDerivedColumn(col({ operandColumnIds: ['quantity', 'unit_price'], operation: 'product' }))).toBe(true)
    expect(isDerivedColumn(col())).toBe(false)
  })
})

describe('computeRowDerivation — product of operands, rounded to the target scale', () => {
  const decl = { operandColumnIds: ['quantity', 'unit_price'], operation: 'product' as const }
  it('multiplies the operands', () => {
    expect(computeRowDerivation({ quantity: 3, unit_price: 100 }, decl, 2)).toBe(300)
  })
  it('rounds the product to the target column scale', () => {
    expect(computeRowDerivation({ quantity: 3, unit_price: 1.333 }, decl, 2)).toBe(4) // 3.999 → 4.00
    expect(computeRowDerivation({ quantity: 3, unit_price: 1.333 }, decl, 4)).toBe(3.999) // keeps 4-dp precision
  })
  it('partial / non-numeric operands → null (leave the cell manual)', () => {
    expect(computeRowDerivation({ quantity: 3 }, decl, 2)).toBeNull()
    expect(computeRowDerivation({ quantity: 3, unit_price: '' }, decl, 2)).toBeNull()
    expect(computeRowDerivation({ quantity: 3, unit_price: null }, decl, 2)).toBeNull()
  })
  it('a single-operand product is that operand', () => {
    expect(computeRowDerivation({ x: 5 }, { operandColumnIds: ['x'], operation: 'product' }, 2)).toBe(5)
  })
})

describe('row derivation visibility — hidden operands stay manual (#3203 dimension 4)', () => {
  const columns: FormField[] = [
    { id: 'use_quantity', type: 'select', label: '使用数量' },
    {
      id: 'quantity',
      type: 'number',
      label: '数量',
      visibilityRule: { fieldId: 'use_quantity', operator: 'eq', value: true },
    },
    { id: 'unit_price', type: 'number', label: '单价' },
    {
      id: 'amount',
      type: 'number',
      label: '小计',
      props: { precision: 2, derivedFrom: { operandColumnIds: ['quantity', 'unit_price'], operation: 'product' } },
    },
  ]
  const amount = columns.find((column) => column.id === 'amount')

  it('activates only when target and every operand are visible for that row', () => {
    expect(isRowDerivationActive(columns, amount, { use_quantity: true })).toBe(true)
    expect(isRowDerivationActive(columns, amount, { use_quantity: false })).toBe(false)
  })

  it('applies derived amounts only to rows whose operands are visible', () => {
    const formData = {
      items: [
        { use_quantity: true, quantity: 3, unit_price: 100 },
        { use_quantity: false, quantity: 3, unit_price: 100, amount: 999 },
      ],
    }
    applyRowDerivations(
      { fields: [{ id: 'items', type: 'detail', label: '明细', columns }] },
      formData,
      'items',
      'amount',
    )
    expect(formData.items[0].amount).toBe(300)
    expect(formData.items[1].amount).toBe(999)
  })
})
