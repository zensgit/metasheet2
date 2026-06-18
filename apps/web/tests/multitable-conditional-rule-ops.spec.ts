import { describe, expect, it } from 'vitest'
import {
  coerceRuleValue,
  fieldTypeSupportsRule,
  operatorTakesNoValue,
  operatorsForFieldType,
} from '../src/multitable/utils/conditional-rule-ops'

describe('conditional-rule-ops (FE mirror of the backend allowlist)', () => {
  it('returns the operators allowed per field type; empty for unsupported', () => {
    expect(operatorsForFieldType('select')).toContain('contains')
    expect(operatorsForFieldType('number')).toEqual(expect.arrayContaining(['gt', 'lt', 'gte', 'lte']))
    expect(operatorsForFieldType('boolean')).toEqual(['eq', 'neq'])
    expect(operatorsForFieldType('multiSelect')).toEqual(expect.arrayContaining(['hasAny', 'hasNone']))
    expect(operatorsForFieldType('string')).toContain('contains') // basic text supported (alias of BE 'text')
    expect(operatorsForFieldType('link')).toEqual([]) // unsupported
    expect(operatorsForFieldType(undefined)).toEqual([])
    expect(fieldTypeSupportsRule('select')).toBe(true)
    expect(fieldTypeSupportsRule('link')).toBe(false)
  })

  it('coerces values to the evaluator shape', () => {
    expect(coerceRuleValue('number', 'gt', '100')).toBe(100)
    expect(typeof coerceRuleValue('currency', 'gte', '5')).toBe('number')
    expect(coerceRuleValue('number', 'gt', 'abc')).toBe('abc') // non-numeric kept raw so it round-trips/fixable
    expect(coerceRuleValue('multiSelect', 'hasAny', 'a, b ,c')).toEqual(['a', 'b', 'c'])
    expect(coerceRuleValue('select', 'eq', 'secret')).toBe('secret')
    expect(coerceRuleValue('select', 'isEmpty', 'ignored')).toBeUndefined() // empty-ops carry no value
    expect(operatorTakesNoValue('isNotEmpty')).toBe(true)
    expect(operatorTakesNoValue('eq')).toBe(false)
  })
})
