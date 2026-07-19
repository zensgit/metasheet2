/**
 * D7 number compatibility — FWB stores exact decimal strings.
 * Condition comparisons use exact canonical decimal math (no JS Number above 2^53).
 * Aggregation still uses JS Number (footer surface) — do NOT claim no-precision-loss there.
 * Formula engine: ordinary decimals work; high-precision fails closed (#NUM!), never wrong.
 */
import { describe, expect, test } from 'vitest'

import {
  compareExactDecimal,
  coerceExactDecimal,
  isExactlyRepresentableAsJsNumber,
} from '../../src/multitable/approval-fwb-target-fields'
import {
  coerceComparableNumber,
  evaluateCondition,
  type AutomationCondition,
} from '../../src/multitable/automation-conditions'
import { mapApprovalFormValues } from '../../src/multitable/approval-form-value-mapping'
import { aggregateField, isNumericFieldType } from '../../src/multitable/aggregation-helpers'
import { MultitableFormulaEngine } from '../../src/multitable/formula-engine'

describe('D7 exact decimal storage + multitable surface compat', () => {
  test('coerceExactDecimal keeps high-precision strings without Number() rewrite', () => {
    const r = coerceExactDecimal('9007199254740993.12', 2)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.v).toBe('9007199254740993.12')
      expect(typeof r.v).toBe('string')
    }
  })

  test('coerceExactDecimal rejects already-lossy JS numbers', () => {
    expect(coerceExactDecimal(Number.MAX_SAFE_INTEGER + 1, undefined).ok).toBe(false)
    expect(coerceExactDecimal(12.34, undefined).ok).toBe(false)
    expect(coerceExactDecimal(12, undefined)).toEqual({ ok: true, v: '12' })
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

  test('exact canonical decimal comparison (no Number) — equals and ordering above 2^53', () => {
    // Discriminating high-precision pair: JS Number collapses both to the same float.
    const a = '9007199254740993'
    const b = '9007199254740992'
    expect(Number(a) === Number(b)).toBe(true) // IEEE-754 collapses — Number path is wrong
    expect(compareExactDecimal(a, b)).toBe(1)
    expect(compareExactDecimal(b, a)).toBe(-1)
    expect(compareExactDecimal(a, a)).toBe(0)
    expect(compareExactDecimal('12.50', '12.5')).toBe(0)
    expect(compareExactDecimal('12.51', '12.5')).toBe(1)
    expect(compareExactDecimal('-1.5', '-1.4')).toBe(-1)
  })

  test('automation conditions compare D7 string fields via exact decimal (high-precision safe)', () => {
    const gt: AutomationCondition = { fieldId: 'amt', operator: 'greater_than', value: 100 }
    expect(evaluateCondition(gt, { amt: '150.50' })).toBe(true)
    expect(evaluateCondition(gt, { amt: '50.00' })).toBe(false)

    const eq: AutomationCondition = { fieldId: 'amt', operator: 'equals', value: 12.5 }
    expect(evaluateCondition(eq, { amt: '12.50' })).toBe(true)
    expect(evaluateCondition(eq, { amt: '12.5' })).toBe(true)

    // Above 2^53: Number-coerced equals would wrongly treat these as equal.
    const highEq: AutomationCondition = {
      fieldId: 'amt',
      operator: 'equals',
      value: '9007199254740993',
    }
    expect(evaluateCondition(highEq, { amt: '9007199254740993' })).toBe(true)
    expect(evaluateCondition(highEq, { amt: '9007199254740992' })).toBe(false)

    const highGt: AutomationCondition = {
      fieldId: 'amt',
      operator: 'greater_than',
      value: '9007199254740992',
    }
    expect(evaluateCondition(highGt, { amt: '9007199254740993' })).toBe(true)

    // Storage is never rewritten by comparison helpers.
    const stored = '12.3400'
    expect(coerceComparableNumber(stored)).toBe(12.34)
    expect(stored).toBe('12.3400')
  })

  test('footer aggregation handles ordinary D7 decimals and fails closed on inexact values', () => {
    expect(isNumericFieldType('number')).toBe(true)
    const sum = aggregateField(['10.25', '5.75', 4], 'sum', 'number')
    expect(sum).toBe(20)
    // Never silently skip or round a valid high-precision numeric cell.
    const hi = aggregateField(['9007199254740993', '1'], 'sum', 'number')
    expect(hi).toBeNull()
  })

  test('isExactlyRepresentableAsJsNumber: ordinary yes, high-precision no', () => {
    expect(isExactlyRepresentableAsJsNumber('12.34')).toBe(true)
    expect(isExactlyRepresentableAsJsNumber('100')).toBe(true)
    expect(isExactlyRepresentableAsJsNumber('9007199254740993')).toBe(false)
    expect(isExactlyRepresentableAsJsNumber('9007199254740993.12')).toBe(false)
  })

  test('formula engine: ordinary FWB decimal arithmetic works; high-precision fails closed', async () => {
    const engine = new MultitableFormulaEngine()
    // Multitable field refs must use the fld_ prefix pattern the engine resolves.
    const fields = [
      { id: 'fld_a', type: 'number', name: 'A' },
      { id: 'fld_b', type: 'number', name: 'B' },
    ]

    const ordinary = await engine.evaluateField(
      '{fld_a}+{fld_b}',
      { fld_a: '10.25', fld_b: '5.75' },
      fields,
    )
    expect(ordinary).toBe(16)

    // High-precision must NEVER silently return a wrong numeric result.
    const high = await engine.evaluateField(
      '{fld_a}+{fld_b}',
      { fld_a: '9007199254740993', fld_b: '1' },
      fields,
    )
    // Fail closed (#NUM!) rather than 9007199254740992+1 wrong answer.
    expect(high).toBe('#NUM!')
    expect(high).not.toBe(9007199254740994)
    expect(high).not.toBe(9007199254740992)
  })
})
