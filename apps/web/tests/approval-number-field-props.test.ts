import { describe, expect, it } from 'vitest'
import type { FormField } from '../src/types/approval'
import {
  numberFieldProps,
  amountDisplayProps,
  isAmountWordsField,
  roundToFieldScale,
  formatAmountDisplay,
} from '../src/approvals/numberFieldProps'

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

// L8-C (approval-lock8-field-vocabulary-20260817.md §1.3, OD-L8-6/M10): formatted-number DISPLAY
// props — distinct from numberFieldProps above (these are NOT el-input-number widget attrs).

describe('approvals/amountDisplayProps — L8-C', () => {
  it('extracts a trimmed currencySymbol and thousandsSeparator when both are declared', () => {
    expect(amountDisplayProps(numberField({ props: { currencySymbol: ' ¥ ', thousandsSeparator: true } })))
      .toEqual({ currencySymbol: '¥', thousandsSeparator: true })
  })

  it('omits thousandsSeparator when it is not the exact boolean true (no coercion)', () => {
    expect(amountDisplayProps(numberField({ props: { thousandsSeparator: 1 as unknown as boolean } }))).toEqual({})
    expect(amountDisplayProps(numberField({ props: { thousandsSeparator: 'true' as unknown as boolean } }))).toEqual({})
  })

  it('omits a blank/whitespace-only currencySymbol', () => {
    expect(amountDisplayProps(numberField({ props: { currencySymbol: '   ' } }))).toEqual({})
    expect(amountDisplayProps(numberField({ props: { currencySymbol: '' } }))).toEqual({})
  })

  it('ignores a non-string currencySymbol', () => {
    expect(amountDisplayProps(numberField({ props: { currencySymbol: 5 as unknown as string } }))).toEqual({})
  })

  it('absent/non-object props → {}', () => {
    expect(amountDisplayProps(numberField())).toEqual({})
    expect(amountDisplayProps(undefined)).toEqual({})
    expect(amountDisplayProps(null)).toEqual({})
  })
})

describe('approvals/isAmountWordsField — L8-C per-field 大写 trigger', () => {
  it('true only when type is number AND props.uppercaseCny is exactly true', () => {
    expect(isAmountWordsField(numberField({ props: { uppercaseCny: true } }))).toBe(true)
  })

  it('false for a non-number type even with uppercaseCny true (type-selected, not props-selected)', () => {
    expect(isAmountWordsField({ id: 'x', type: 'text', label: 'x', props: { uppercaseCny: true } } as unknown as FormField)).toBe(false)
  })

  it('false when uppercaseCny is absent, falsy, or truthy-but-not-strictly-true (no coercion)', () => {
    expect(isAmountWordsField(numberField())).toBe(false)
    expect(isAmountWordsField(numberField({ props: { uppercaseCny: false } }))).toBe(false)
    expect(isAmountWordsField(numberField({ props: { uppercaseCny: 1 as unknown as boolean } }))).toBe(false)
    expect(isAmountWordsField(numberField({ props: { uppercaseCny: 'true' as unknown as boolean } }))).toBe(false)
  })

  it('absent/null field → false', () => {
    expect(isAmountWordsField(undefined)).toBe(false)
    expect(isAmountWordsField(null)).toBe(false)
  })
})

describe('approvals/roundToFieldScale', () => {
  it('rounds at the declared scale (mirrors the backend total-check\'s Math.round(value·10^scale)/10^scale)', () => {
    expect(roundToFieldScale(1.011, 2)).toBe(1.01) // rounds down
    expect(roundToFieldScale(1.016, 2)).toBe(1.02) // rounds up
    expect(roundToFieldScale(1.2345, 4)).toBe(1.2345)
    expect(roundToFieldScale(1.23456, 4)).toBe(1.2346)
    expect(roundToFieldScale(1234.5, 0)).toBe(1235)
  })

  it('passes non-finite / non-number input through unchanged', () => {
    expect(roundToFieldScale(NaN, 2)).toBeNaN()
    expect(roundToFieldScale(Infinity, 2)).toBe(Infinity)
    expect(roundToFieldScale('12' as unknown as number, 2)).toBe('12')
    expect(roundToFieldScale(undefined, 2)).toBeUndefined()
  })
})

describe('approvals/formatAmountDisplay — L8-C presentation caption', () => {
  it('zero: currency-only, thousands-only, and both', () => {
    expect(formatAmountDisplay(0, { currencySymbol: '¥' }, 2)).toBe('¥0')
    expect(formatAmountDisplay(0, { thousandsSeparator: true }, 2)).toBe('0')
    expect(formatAmountDisplay(0, { currencySymbol: '¥', thousandsSeparator: true }, 2)).toBe('¥0')
  })

  it('negative values carry a leading "-" before the currency symbol', () => {
    expect(formatAmountDisplay(-1234.5, { currencySymbol: '¥', thousandsSeparator: true }, 2)).toBe('-¥1,234.5')
    expect(formatAmountDisplay(-0.5, { currencySymbol: '$' }, 2)).toBe('-$0.5')
  })

  it('large values group correctly at 4, 6, and 7+ digits (boundary coverage)', () => {
    expect(formatAmountDisplay(1234, { thousandsSeparator: true }, 0)).toBe('1,234')
    expect(formatAmountDisplay(123456, { thousandsSeparator: true }, 0)).toBe('123,456')
    expect(formatAmountDisplay(1234567, { thousandsSeparator: true }, 0)).toBe('1,234,567')
    expect(formatAmountDisplay(100000000, { thousandsSeparator: true }, 0)).toBe('100,000,000')
  })

  it('decimals: the fractional part is preserved and NOT grouped', () => {
    expect(formatAmountDisplay(1234567.89, { thousandsSeparator: true }, 2)).toBe('1,234,567.89')
  })

  it('rounds to the caller-supplied scale before formatting (same rounding as the total-check / roundToFieldScale)', () => {
    expect(formatAmountDisplay(1.016, { currencySymbol: '¥' }, 2)).toBe('¥1.02')
    expect(formatAmountDisplay(1.999, { currencySymbol: '¥' }, 0)).toBe('¥2')
  })

  it('neither currencySymbol nor thousandsSeparator declared → "" (nothing to render, not "0")', () => {
    expect(formatAmountDisplay(1234, {}, 2)).toBe('')
  })

  it('non-finite / non-number value → "" (honest omission, mirrors amountToChineseWords)', () => {
    expect(formatAmountDisplay(NaN, { currencySymbol: '¥' }, 2)).toBe('')
    expect(formatAmountDisplay(Infinity, { currencySymbol: '¥' }, 2)).toBe('')
    expect(formatAmountDisplay('12' as unknown as number, { currencySymbol: '¥' }, 2)).toBe('')
    expect(formatAmountDisplay(undefined, { currencySymbol: '¥' }, 2)).toBe('')
  })
})
