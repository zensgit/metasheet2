import { describe, it, expect } from 'vitest'

import {
  buildRecordFormattingMap,
  composeStyleObject,
  evaluateRule,
  extractRulesFromConfig,
  isOperator,
  operatorRequiresValue,
  sanitizeRule,
  sanitizeRules,
} from '../src/multitable/utils/conditional-formatting'
import type {
  ConditionalFormattingRule,
  MetaField,
  MetaRecord,
} from '../src/multitable/types'

const NUMBER_FIELD: MetaField = { id: 'fld_n', name: 'N', type: 'number' }
const TEXT_FIELD: MetaField = { id: 'fld_t', name: 'T', type: 'string' }
const DATE_FIELD: MetaField = { id: 'fld_d', name: 'D', type: 'date' }
const SELECT_FIELD: MetaField = {
  id: 'fld_s',
  name: 'S',
  type: 'select',
  options: [{ value: 'High' }, { value: 'Low' }],
}

const FIELDS_BY_ID: Record<string, MetaField | undefined> = {
  [NUMBER_FIELD.id]: NUMBER_FIELD,
  [TEXT_FIELD.id]: TEXT_FIELD,
  [DATE_FIELD.id]: DATE_FIELD,
  [SELECT_FIELD.id]: SELECT_FIELD,
}

const FIXED_NOW = new Date(2026, 3, 25, 12).getTime()
const ONE_DAY = 86_400_000

function localDayMs(now: number, offset: number, hour = 12): number {
  const d = new Date(now + offset * ONE_DAY)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour).getTime()
}

function makeRule(partial: Partial<ConditionalFormattingRule> = {}): ConditionalFormattingRule {
  return {
    id: 'r1',
    order: 0,
    fieldId: NUMBER_FIELD.id,
    operator: 'gt',
    value: 0,
    style: { backgroundColor: '#ff0000' },
    enabled: true,
    ...partial,
  }
}

describe('isOperator', () => {
  it('accepts known operators', () => {
    expect(isOperator('gt')).toBe(true)
    expect(isOperator('between')).toBe(true)
    expect(isOperator('is_overdue')).toBe(true)
  })
  it('rejects unknown operators', () => {
    expect(isOperator('banana')).toBe(false)
    expect(isOperator(42)).toBe(false)
  })
})

describe('operatorRequiresValue', () => {
  it('returns false for empty/today/overdue/bool variants', () => {
    expect(operatorRequiresValue('is_empty')).toBe(false)
    expect(operatorRequiresValue('is_overdue')).toBe(false)
    expect(operatorRequiresValue('is_true')).toBe(false)
  })
  it('returns true for comparators', () => {
    expect(operatorRequiresValue('gt')).toBe(true)
    expect(operatorRequiresValue('between')).toBe(true)
    expect(operatorRequiresValue('is_in_last_n_days')).toBe(true)
  })
})

describe('sanitizeRule', () => {
  it('parses a well-formed rule', () => {
    const rule = sanitizeRule({
      id: 'r1', order: 0, fieldId: 'f', operator: 'gt', value: 5,
      style: { backgroundColor: '#abcdef', applyToRow: true },
    })
    expect(rule).toMatchObject({
      id: 'r1', operator: 'gt', value: 5,
      style: { backgroundColor: '#abcdef', applyToRow: true },
    })
  })

  it('rejects unknown operator', () => {
    expect(sanitizeRule({ id: 'r1', order: 0, fieldId: 'f', operator: 'foo', style: {} })).toBeNull()
  })

  it('drops invalid hex colors', () => {
    const rule = sanitizeRule({
      id: 'r1', order: 0, fieldId: 'f', operator: 'gt', value: 5,
      style: { backgroundColor: 'hotpink', textColor: '#abc' },
    })
    expect(rule?.style.backgroundColor).toBeUndefined()
    expect(rule?.style.textColor).toBe('#abc')
  })

  it('rejects gt/between with bad value shapes', () => {
    expect(sanitizeRule({ id: 'r', order: 0, fieldId: 'f', operator: 'gt', style: {} })).toBeNull()
    expect(sanitizeRule({ id: 'r', order: 0, fieldId: 'f', operator: 'between', value: 5, style: {} })).toBeNull()
  })

  it('treats enabled as default-true when omitted', () => {
    const rule = sanitizeRule({ id: 'r1', order: 0, fieldId: 'f', operator: 'is_empty', style: {} })
    expect(rule?.enabled).toBe(true)
  })
})

describe('sanitizeRules', () => {
  it('drops invalid entries and preserves order ascending', () => {
    const rules = sanitizeRules([
      { id: 'a', order: 5, fieldId: 'f', operator: 'is_empty', style: {} },
      'invalid',
      { id: 'b', order: 1, fieldId: 'f', operator: 'is_empty', style: {} },
    ])
    expect(rules.map((r) => r.id)).toEqual(['b', 'a'])
  })
})

describe('extractRulesFromConfig', () => {
  it('reads rules nested under `conditionalFormattingRules`', () => {
    const rules = extractRulesFromConfig({
      conditionalFormattingRules: [
        { id: 'r1', order: 0, fieldId: 'f', operator: 'is_empty', style: {} },
      ],
    })
    expect(rules).toHaveLength(1)
  })

  it('returns [] when missing or shape is wrong', () => {
    expect(extractRulesFromConfig(undefined)).toEqual([])
    expect(extractRulesFromConfig({ conditionalFormattingRules: 'oops' })).toEqual([])
  })
})

describe('evaluateRule — numeric / text', () => {
  it('gt matches numeric and string-number cells', () => {
    expect(evaluateRule(makeRule({ operator: 'gt', value: 10 }), { fld_n: 11 }, NUMBER_FIELD)).toBe(true)
    expect(evaluateRule(makeRule({ operator: 'gt', value: 10 }), { fld_n: '15' }, NUMBER_FIELD)).toBe(true)
    expect(evaluateRule(makeRule({ operator: 'gt', value: 10 }), { fld_n: 'abc' }, NUMBER_FIELD)).toBe(false)
  })
  it('between is inclusive', () => {
    const rule = makeRule({ operator: 'between', value: [10, 20] })
    expect(evaluateRule(rule, { fld_n: 10 }, NUMBER_FIELD)).toBe(true)
    expect(evaluateRule(rule, { fld_n: 20 }, NUMBER_FIELD)).toBe(true)
    expect(evaluateRule(rule, { fld_n: 21 }, NUMBER_FIELD)).toBe(false)
  })
  it('contains is case-insensitive', () => {
    expect(evaluateRule(
      makeRule({ fieldId: TEXT_FIELD.id, operator: 'contains', value: 'urgent' }),
      { fld_t: 'URGENT - read first' },
      TEXT_FIELD,
    )).toBe(true)
  })
  it('eq on select field matches against any selected option', () => {
    expect(evaluateRule(
      makeRule({ fieldId: SELECT_FIELD.id, operator: 'eq', value: 'High' }),
      { fld_s: ['High'] },
      SELECT_FIELD,
    )).toBe(true)
  })
})

describe('evaluateRule — date variants', () => {
  const onDay = (offset: number, hour = 12) => ({ [DATE_FIELD.id]: localDayMs(FIXED_NOW, offset, hour) })

  it('is_today matches calendar same-day', () => {
    expect(evaluateRule(
      makeRule({ fieldId: DATE_FIELD.id, operator: 'is_today' }),
      onDay(0, 1), DATE_FIELD, { now: FIXED_NOW },
    )).toBe(true)
  })

  it('is_overdue matches dates strictly before today', () => {
    expect(evaluateRule(
      makeRule({ fieldId: DATE_FIELD.id, operator: 'is_overdue' }),
      onDay(-1, 23), DATE_FIELD, { now: FIXED_NOW },
    )).toBe(true)
    expect(evaluateRule(
      makeRule({ fieldId: DATE_FIELD.id, operator: 'is_overdue' }),
      onDay(0, 0), DATE_FIELD, { now: FIXED_NOW },
    )).toBe(false)
  })

  it('is_in_last_n_days inclusive of today / N-1 days back', () => {
    const rule = makeRule({ fieldId: DATE_FIELD.id, operator: 'is_in_last_n_days', value: 7 })
    expect(evaluateRule(rule, onDay(-6), DATE_FIELD, { now: FIXED_NOW })).toBe(true)
    expect(evaluateRule(rule, onDay(-7), DATE_FIELD, { now: FIXED_NOW })).toBe(false)
  })
})

describe('buildRecordFormattingMap', () => {
  it('returns empty map when no rules', () => {
    const result = buildRecordFormattingMap([], [{ id: 'rec1', version: 1, data: { fld_n: 5 } }], [NUMBER_FIELD])
    expect(result.byRecordId.size).toBe(0)
  })

  it('produces per-record formatting and applies first-match-wins', () => {
    const rules: ConditionalFormattingRule[] = [
      makeRule({ id: 'a', order: 0, operator: 'gt', value: 100, style: { backgroundColor: '#aaaaaa' } }),
      makeRule({ id: 'b', order: 1, operator: 'gt', value: 10, style: { backgroundColor: '#bbbbbb' } }),
    ]
    const records: MetaRecord[] = [
      { id: 'rec_match', version: 1, data: { fld_n: 200 } },
      { id: 'rec_partial', version: 1, data: { fld_n: 50 } },
      { id: 'rec_none', version: 1, data: { fld_n: 1 } },
    ]
    const result = buildRecordFormattingMap(rules, records, [NUMBER_FIELD])
    expect(result.byRecordId.size).toBe(2)
    expect(result.byRecordId.get('rec_match')?.cellStyles[NUMBER_FIELD.id]?.backgroundColor).toBe('#aaaaaa')
    expect(result.byRecordId.get('rec_partial')?.cellStyles[NUMBER_FIELD.id]?.backgroundColor).toBe('#bbbbbb')
    expect(result.byRecordId.get('rec_none')).toBeUndefined()
  })

  it('separates rowStyle from cellStyles', () => {
    const rules: ConditionalFormattingRule[] = [
      makeRule({ id: 'row', order: 0, operator: 'gt', value: 0, style: { backgroundColor: '#cccccc', applyToRow: true } }),
      makeRule({ id: 'cell', order: 1, fieldId: TEXT_FIELD.id, operator: 'eq', value: 'X', style: { backgroundColor: '#dddddd' } }),
    ]
    const result = buildRecordFormattingMap(
      rules,
      [{ id: 'rec1', version: 1, data: { fld_n: 1, fld_t: 'X' } }],
      [NUMBER_FIELD, TEXT_FIELD],
    )
    const entry = result.byRecordId.get('rec1')
    expect(entry?.rowStyle?.backgroundColor).toBe('#cccccc')
    expect(entry?.cellStyles[TEXT_FIELD.id]?.backgroundColor).toBe('#dddddd')
  })
})

describe('composeStyleObject', () => {
  it('merges row and cell styles with cell precedence', () => {
    expect(composeStyleObject(
      { backgroundColor: '#row', textColor: '#row' },
      { backgroundColor: '#cell' },
    )).toEqual({ backgroundColor: '#cell', color: '#row' })
  })
  it('returns undefined when both empty', () => {
    expect(composeStyleObject(undefined, undefined)).toBeUndefined()
    expect(composeStyleObject({}, {})).toBeUndefined()
  })
  it('respects row-only style', () => {
    expect(composeStyleObject({ backgroundColor: '#abc' }, undefined)).toEqual({ backgroundColor: '#abc' })
  })
})

// Reference FIELDS_BY_ID for completeness — surfaces the type without exporting more helpers.
void FIELDS_BY_ID
