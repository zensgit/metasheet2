/**
 * D7 number compatibility — FWB stores exact decimal strings; existing condition/agg surfaces
 * must still compare and aggregate them without silent precision loss on the stored value.
 */
import { describe, expect, test } from 'vitest'

import { coerceExactDecimal } from '../../src/multitable/approval-fwb-target-fields'
import {
  coerceComparableNumber,
  evaluateCondition,
  type AutomationCondition,
} from '../../src/multitable/automation-conditions'
import { mapApprovalFormValues } from '../../src/multitable/approval-form-value-mapping'
import { aggregateField, isNumericFieldType } from '../../src/multitable/aggregation-helpers'

describe('D7 exact decimal storage + multitable surface compat', () => {
  test('coerceExactDecimal keeps high-precision strings without Number() rewrite', () => {
    const r = coerceExactDecimal('9007199254740993.12', 2)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.v).toBe('9007199254740993.12')
      // Stored value is a string — not a Number that would lose the low bits.
      expect(typeof r.v).toBe('string')
    }
  })

  test('mapApprovalFormValues writes number targets as decimal strings', () => {
    const mapped = mapApprovalFormValues(
      [{ formFieldId: 'amt', targetFieldId: 't_amt', targetType: 'number', numberPrecision: 4 }],
      { amt: '123.4500' },
    )
    expect(mapped.ok).toBe(true)
    if (mapped.ok) {
      expect(mapped.values.t_amt).toBe('123.45')
      expect(typeof mapped.values.t_amt).toBe('string')
    }
  })

  test('automation conditions compare D7 string fields against numeric condition values', () => {
    const gt: AutomationCondition = { fieldId: 'amt', operator: 'greater_than', value: 100 }
    expect(evaluateCondition(gt, { amt: '150.50' })).toBe(true)
    expect(evaluateCondition(gt, { amt: '50.00' })).toBe(false)

    const eq: AutomationCondition = { fieldId: 'amt', operator: 'equals', value: 12.5 }
    expect(evaluateCondition(eq, { amt: '12.50' })).toBe(true)
    expect(evaluateCondition(eq, { amt: '12.5' })).toBe(true)

    // Storage is never rewritten by comparison helpers.
    const stored = '12.3400'
    expect(coerceComparableNumber(stored)).toBe(12.34)
    expect(stored).toBe('12.3400')
  })

  test('footer aggregation treats D7 decimal strings as numeric', () => {
    expect(isNumericFieldType('number')).toBe(true)
    const sum = aggregateField(['10.25', '5.75', 4], 'sum', 'number')
    expect(sum).toBe(20)
  })
})
