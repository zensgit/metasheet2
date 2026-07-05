import { describe, expect, it } from 'vitest'
import type { FormField } from '../src/types/approval'
import { numberFieldProps } from '../src/approvals/numberFieldProps'

function numberField(overrides: Partial<FormField> = {}): FormField {
  return { id: 'amount', type: 'number', label: '金额', ...overrides }
}

describe('approvals/numberFieldProps — B2-02', () => {
  it('passes through valid numeric props (leave-days preset: min/step)', () => {
    expect(numberFieldProps(numberField({ props: { min: 0.5, step: 0.5 } }))).toEqual({
      min: 0.5,
      step: 0.5,
    })
  })

  it('passes through all four recognized keys', () => {
    expect(numberFieldProps(numberField({ props: { min: 0, max: 100, step: 1, precision: 2 } }))).toEqual({
      min: 0,
      max: 100,
      step: 1,
      precision: 2,
    })
  })

  it('ignores non-numeric junk values per key (string/bool/object/null)', () => {
    expect(
      numberFieldProps(
        numberField({ props: { min: '0', step: true, precision: {}, max: null } as unknown as Record<string, unknown> }),
      ),
    ).toEqual({})
  })

  it('ignores NaN and Infinity', () => {
    expect(numberFieldProps(numberField({ props: { min: NaN, max: Infinity, step: -Infinity } }))).toEqual({})
  })

  it('drops unrelated props keys (e.g. detail-column derivedFrom) while keeping valid numeric ones', () => {
    expect(
      numberFieldProps(
        numberField({
          props: {
            min: 0,
            derivedFrom: { operandColumnIds: ['qty', 'price'], operation: 'product' },
          },
        }),
      ),
    ).toEqual({ min: 0 })
  })

  it('mixed valid + invalid keeps only the valid ones', () => {
    expect(numberFieldProps(numberField({ props: { min: 0.5, max: 'ten' as unknown as number } }))).toEqual({
      min: 0.5,
    })
  })

  it('absent/empty/nullish props → {}', () => {
    expect(numberFieldProps(numberField())).toEqual({})
    expect(numberFieldProps(numberField({ props: {} }))).toEqual({})
    expect(numberFieldProps(undefined)).toEqual({})
    expect(numberFieldProps(null)).toEqual({})
  })

  it('non-object props value → {}', () => {
    expect(numberFieldProps(numberField({ props: 'nonsense' as unknown as Record<string, unknown> }))).toEqual({})
  })
})
