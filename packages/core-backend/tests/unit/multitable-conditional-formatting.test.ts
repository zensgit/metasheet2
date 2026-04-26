import { describe, expect, it } from 'vitest'

import {
  CONDITIONAL_FORMATTING_RULE_LIMIT,
  evaluateConditionalFormattingRules,
  evaluateRule,
  extractRulesFromConfig,
  sanitizeConditionalFormattingRule,
  sanitizeConditionalFormattingRules,
  type ConditionalFormattingRule,
} from '../../src/multitable/conditional-formatting-service'
import type { MultitableField } from '../../src/multitable/field-codecs'

const FIELD_NUMBER: MultitableField = { id: 'fld_n', name: 'N', type: 'number' }
const FIELD_TEXT: MultitableField = { id: 'fld_t', name: 'T', type: 'string' }
const FIELD_DATE: MultitableField = { id: 'fld_d', name: 'D', type: 'date' }
const FIELD_SELECT: MultitableField = {
  id: 'fld_s',
  name: 'S',
  type: 'select',
  options: [{ value: 'High' }, { value: 'Low' }],
}
const FIELD_BOOL: MultitableField = { id: 'fld_b', name: 'B', type: 'boolean' }

const FIELDS_BY_ID: Record<string, MultitableField | undefined> = {
  [FIELD_NUMBER.id]: FIELD_NUMBER,
  [FIELD_TEXT.id]: FIELD_TEXT,
  [FIELD_DATE.id]: FIELD_DATE,
  [FIELD_SELECT.id]: FIELD_SELECT,
  [FIELD_BOOL.id]: FIELD_BOOL,
}

function makeRule(partial: Partial<ConditionalFormattingRule>): ConditionalFormattingRule {
  return {
    id: 'r1',
    order: 0,
    fieldId: FIELD_NUMBER.id,
    operator: 'gt',
    value: 0,
    style: { backgroundColor: '#ff0000' },
    enabled: true,
    ...partial,
  }
}

// Use the local-timezone midpoint of an arbitrary date so `startOfDay` is
// stable regardless of host timezone (the evaluator uses local-tz day
// boundaries to match what end-users see in their browser).
const FIXED_NOW = new Date(2026, 3, 25, 12, 0, 0, 0).getTime() // 2026-04-25 12:00 local
const ONE_DAY_MS = 86_400_000

function localDayMs(now: number, dayOffset: number, hour = 12): number {
  const ms = new Date(now + dayOffset * ONE_DAY_MS)
  return new Date(ms.getFullYear(), ms.getMonth(), ms.getDate(), hour, 0, 0, 0).getTime()
}

describe('sanitizeConditionalFormattingRule', () => {
  it('accepts a well-formed gt rule', () => {
    const rule = sanitizeConditionalFormattingRule({
      id: 'r1',
      order: 1,
      fieldId: 'fld_n',
      operator: 'gt',
      value: 10,
      style: { backgroundColor: '#ff0000', textColor: '#ffffff' },
      enabled: true,
    })
    expect(rule).not.toBeNull()
    expect(rule?.operator).toBe('gt')
    expect(rule?.value).toBe(10)
    expect(rule?.style).toEqual({ backgroundColor: '#ff0000', textColor: '#ffffff' })
  })

  it('rejects unknown operator', () => {
    expect(sanitizeConditionalFormattingRule({
      id: 'r1', order: 0, fieldId: 'f', operator: 'banana', value: 1, style: {},
    })).toBeNull()
  })

  it('rejects missing id or fieldId', () => {
    expect(sanitizeConditionalFormattingRule({
      order: 0, fieldId: 'f', operator: 'gt', value: 1, style: {},
    })).toBeNull()
    expect(sanitizeConditionalFormattingRule({
      id: 'r1', order: 0, operator: 'gt', value: 1, style: {},
    })).toBeNull()
  })

  it('rejects between rule without two-element value', () => {
    expect(sanitizeConditionalFormattingRule({
      id: 'r1', order: 0, fieldId: 'f', operator: 'between', value: 10, style: {},
    })).toBeNull()
    expect(sanitizeConditionalFormattingRule({
      id: 'r1', order: 0, fieldId: 'f', operator: 'between', value: [1, 2, 3], style: {},
    })).toBeNull()
  })

  it('rejects gt without value', () => {
    expect(sanitizeConditionalFormattingRule({
      id: 'r1', order: 0, fieldId: 'f', operator: 'gt', style: {},
    })).toBeNull()
  })

  it('accepts is_empty without value', () => {
    const rule = sanitizeConditionalFormattingRule({
      id: 'r1', order: 0, fieldId: 'f', operator: 'is_empty', style: {},
    })
    expect(rule?.operator).toBe('is_empty')
    expect(rule?.value).toBeUndefined()
  })

  it('rejects is_in_last_n_days with invalid days', () => {
    expect(sanitizeConditionalFormattingRule({
      id: 'r1', order: 0, fieldId: 'f', operator: 'is_in_last_n_days', value: -1, style: {},
    })).toBeNull()
    expect(sanitizeConditionalFormattingRule({
      id: 'r1', order: 0, fieldId: 'f', operator: 'is_in_last_n_days', value: 'abc', style: {},
    })).toBeNull()
  })

  it('drops invalid hex colors silently', () => {
    const rule = sanitizeConditionalFormattingRule({
      id: 'r1', order: 0, fieldId: 'f', operator: 'gt', value: 1,
      style: { backgroundColor: 'red', textColor: '#abc' },
    })
    expect(rule?.style.backgroundColor).toBeUndefined()
    expect(rule?.style.textColor).toBe('#abc')
  })

  it('preserves applyToRow flag', () => {
    const rule = sanitizeConditionalFormattingRule({
      id: 'r1', order: 0, fieldId: 'f', operator: 'gt', value: 1,
      style: { backgroundColor: '#ffffff', applyToRow: true },
    })
    expect(rule?.style.applyToRow).toBe(true)
  })
})

describe('sanitizeConditionalFormattingRules', () => {
  it('returns empty array for non-array input', () => {
    expect(sanitizeConditionalFormattingRules(null)).toEqual([])
    expect(sanitizeConditionalFormattingRules({})).toEqual([])
  })

  it('drops invalid entries and keeps valid ones', () => {
    const rules = sanitizeConditionalFormattingRules([
      { id: 'r1', order: 0, fieldId: 'f', operator: 'gt', value: 1, style: {} },
      'not-an-object',
      { id: 'r2', order: 1, fieldId: 'f', operator: 'unknown', style: {} },
      { id: 'r3', order: 2, fieldId: 'f', operator: 'is_empty', style: {} },
    ])
    expect(rules.map((r) => r.id)).toEqual(['r1', 'r3'])
  })

  it('caps results at the rule limit', () => {
    const items = Array.from({ length: CONDITIONAL_FORMATTING_RULE_LIMIT + 5 }, (_, i) => ({
      id: `r${i}`, order: i, fieldId: 'f', operator: 'is_empty', style: {},
    }))
    const out = sanitizeConditionalFormattingRules(items)
    expect(out).toHaveLength(CONDITIONAL_FORMATTING_RULE_LIMIT)
  })

  it('orders by `order` ascending and stable on ties', () => {
    const out = sanitizeConditionalFormattingRules([
      { id: 'a', order: 5, fieldId: 'f', operator: 'is_empty', style: {} },
      { id: 'b', order: 1, fieldId: 'f', operator: 'is_empty', style: {} },
      { id: 'c', order: 1, fieldId: 'f', operator: 'is_empty', style: {} },
    ])
    expect(out.map((r) => r.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('extractRulesFromConfig', () => {
  it('returns empty array when config has no rules', () => {
    expect(extractRulesFromConfig(undefined)).toEqual([])
    expect(extractRulesFromConfig({})).toEqual([])
    expect(extractRulesFromConfig({ conditionalFormattingRules: 'oops' })).toEqual([])
  })

  it('extracts and sanitizes rules nested under config', () => {
    const rules = extractRulesFromConfig({
      conditionalFormattingRules: [
        { id: 'r1', order: 0, fieldId: 'f', operator: 'gt', value: 1, style: { backgroundColor: '#ff0000' } },
      ],
    })
    expect(rules).toHaveLength(1)
    expect(rules[0].id).toBe('r1')
  })
})

describe('evaluateRule — number operators', () => {
  it('gt matches when cell > value', () => {
    expect(evaluateRule(makeRule({ operator: 'gt', value: 10 }), { fld_n: 11 }, FIELD_NUMBER)).toBe(true)
    expect(evaluateRule(makeRule({ operator: 'gt', value: 10 }), { fld_n: 10 }, FIELD_NUMBER)).toBe(false)
    expect(evaluateRule(makeRule({ operator: 'gt', value: 10 }), { fld_n: '15' }, FIELD_NUMBER)).toBe(true)
    expect(evaluateRule(makeRule({ operator: 'gt', value: 10 }), { fld_n: 'abc' }, FIELD_NUMBER)).toBe(false)
  })

  it('gte matches inclusively', () => {
    expect(evaluateRule(makeRule({ operator: 'gte', value: 10 }), { fld_n: 10 }, FIELD_NUMBER)).toBe(true)
  })

  it('lt and lte respect strictness', () => {
    expect(evaluateRule(makeRule({ operator: 'lt', value: 10 }), { fld_n: 9 }, FIELD_NUMBER)).toBe(true)
    expect(evaluateRule(makeRule({ operator: 'lt', value: 10 }), { fld_n: 10 }, FIELD_NUMBER)).toBe(false)
    expect(evaluateRule(makeRule({ operator: 'lte', value: 10 }), { fld_n: 10 }, FIELD_NUMBER)).toBe(true)
  })

  it('between is inclusive and order-tolerant', () => {
    const rule = makeRule({ operator: 'between', value: [10, 20] })
    expect(evaluateRule(rule, { fld_n: 15 }, FIELD_NUMBER)).toBe(true)
    expect(evaluateRule(rule, { fld_n: 10 }, FIELD_NUMBER)).toBe(true)
    expect(evaluateRule(rule, { fld_n: 20 }, FIELD_NUMBER)).toBe(true)
    expect(evaluateRule(rule, { fld_n: 9 }, FIELD_NUMBER)).toBe(false)
    expect(evaluateRule(makeRule({ operator: 'between', value: [20, 10] }), { fld_n: 15 }, FIELD_NUMBER)).toBe(true)
  })
})

describe('evaluateRule — text/select operators', () => {
  it('eq matches strings case-sensitively', () => {
    expect(evaluateRule(
      makeRule({ fieldId: FIELD_TEXT.id, operator: 'eq', value: 'Open' }),
      { [FIELD_TEXT.id]: 'Open' },
      FIELD_TEXT,
    )).toBe(true)
    expect(evaluateRule(
      makeRule({ fieldId: FIELD_TEXT.id, operator: 'eq', value: 'Open' }),
      { [FIELD_TEXT.id]: 'open' },
      FIELD_TEXT,
    )).toBe(false)
  })

  it('contains is case-insensitive', () => {
    expect(evaluateRule(
      makeRule({ fieldId: FIELD_TEXT.id, operator: 'contains', value: 'urgent' }),
      { [FIELD_TEXT.id]: 'This is URGENT.' },
      FIELD_TEXT,
    )).toBe(true)
  })

  it('not_contains returns true for non-matching cell', () => {
    expect(evaluateRule(
      makeRule({ fieldId: FIELD_TEXT.id, operator: 'not_contains', value: 'foo' }),
      { [FIELD_TEXT.id]: 'bar' },
      FIELD_TEXT,
    )).toBe(true)
  })

  it('eq on select field matches against any selected option', () => {
    expect(evaluateRule(
      makeRule({ fieldId: FIELD_SELECT.id, operator: 'eq', value: 'High' }),
      { [FIELD_SELECT.id]: ['High', 'Tagged'] },
      FIELD_SELECT,
    )).toBe(true)
    expect(evaluateRule(
      makeRule({ fieldId: FIELD_SELECT.id, operator: 'eq', value: 'High' }),
      { [FIELD_SELECT.id]: 'Low' },
      FIELD_SELECT,
    )).toBe(false)
  })

  it('contains on array values searches each entry', () => {
    expect(evaluateRule(
      makeRule({ fieldId: FIELD_TEXT.id, operator: 'contains', value: 'gh' }),
      { [FIELD_TEXT.id]: ['low', 'high'] },
      FIELD_TEXT,
    )).toBe(true)
  })
})

describe('evaluateRule — empty/boolean operators', () => {
  it('is_empty handles undefined, empty string, empty array', () => {
    const rule = makeRule({ operator: 'is_empty' })
    expect(evaluateRule(rule, {}, FIELD_NUMBER)).toBe(true)
    expect(evaluateRule(rule, { fld_n: null }, FIELD_NUMBER)).toBe(true)
    expect(evaluateRule(rule, { fld_n: '' }, FIELD_NUMBER)).toBe(true)
    expect(evaluateRule(rule, { fld_n: '   ' }, FIELD_NUMBER)).toBe(true)
    expect(evaluateRule(rule, { fld_n: [] }, FIELD_NUMBER)).toBe(true)
    expect(evaluateRule(rule, { fld_n: 0 }, FIELD_NUMBER)).toBe(false)
    expect(evaluateRule(rule, { fld_n: 'a' }, FIELD_NUMBER)).toBe(false)
  })

  it('is_not_empty mirror of is_empty', () => {
    expect(evaluateRule(makeRule({ operator: 'is_not_empty' }), { fld_n: 1 }, FIELD_NUMBER)).toBe(true)
    expect(evaluateRule(makeRule({ operator: 'is_not_empty' }), {}, FIELD_NUMBER)).toBe(false)
  })

  it('is_true / is_false coerce common truthy/falsy representations', () => {
    expect(evaluateRule(
      makeRule({ fieldId: FIELD_BOOL.id, operator: 'is_true' }),
      { [FIELD_BOOL.id]: true }, FIELD_BOOL,
    )).toBe(true)
    expect(evaluateRule(
      makeRule({ fieldId: FIELD_BOOL.id, operator: 'is_true' }),
      { [FIELD_BOOL.id]: 'true' }, FIELD_BOOL,
    )).toBe(true)
    expect(evaluateRule(
      makeRule({ fieldId: FIELD_BOOL.id, operator: 'is_false' }),
      { [FIELD_BOOL.id]: 0 }, FIELD_BOOL,
    )).toBe(true)
    expect(evaluateRule(
      makeRule({ fieldId: FIELD_BOOL.id, operator: 'is_false' }),
      { [FIELD_BOOL.id]: true }, FIELD_BOOL,
    )).toBe(false)
  })
})

describe('evaluateRule — date operators', () => {
  const onDay = (offset: number, hour = 12) => ({ [FIELD_DATE.id]: localDayMs(FIXED_NOW, offset, hour) })

  it('is_today matches a same-day timestamp', () => {
    const rule = makeRule({ fieldId: FIELD_DATE.id, operator: 'is_today' })
    expect(evaluateRule(rule, onDay(0, 3), FIELD_DATE, { now: FIXED_NOW })).toBe(true)
    expect(evaluateRule(rule, onDay(-1, 23), FIELD_DATE, { now: FIXED_NOW })).toBe(false)
  })

  it('is_in_last_n_days includes today and back N-1 days', () => {
    const rule = makeRule({ fieldId: FIELD_DATE.id, operator: 'is_in_last_n_days', value: 7 })
    expect(evaluateRule(rule, onDay(0), FIELD_DATE, { now: FIXED_NOW })).toBe(true)
    expect(evaluateRule(rule, onDay(-6), FIELD_DATE, { now: FIXED_NOW })).toBe(true)
    expect(evaluateRule(rule, onDay(-7), FIELD_DATE, { now: FIXED_NOW })).toBe(false)
    expect(evaluateRule(rule, onDay(1), FIELD_DATE, { now: FIXED_NOW })).toBe(false)
  })

  it('is_in_next_n_days includes today and N forward days', () => {
    const rule = makeRule({ fieldId: FIELD_DATE.id, operator: 'is_in_next_n_days', value: 3 })
    expect(evaluateRule(rule, onDay(0), FIELD_DATE, { now: FIXED_NOW })).toBe(true)
    expect(evaluateRule(rule, onDay(2), FIELD_DATE, { now: FIXED_NOW })).toBe(true)
    expect(evaluateRule(rule, onDay(3), FIELD_DATE, { now: FIXED_NOW })).toBe(false)
  })

  it('is_overdue matches dates strictly before today', () => {
    const rule = makeRule({ fieldId: FIELD_DATE.id, operator: 'is_overdue' })
    expect(evaluateRule(rule, onDay(-1, 23), FIELD_DATE, { now: FIXED_NOW })).toBe(true)
    expect(evaluateRule(rule, onDay(0, 0), FIELD_DATE, { now: FIXED_NOW })).toBe(false)
    expect(evaluateRule(rule, { [FIELD_DATE.id]: 'not-a-date' }, FIELD_DATE, { now: FIXED_NOW })).toBe(false)
  })

  it('disabled rules never match', () => {
    expect(evaluateRule(
      makeRule({ enabled: false, operator: 'gt', value: 0 }),
      { fld_n: 100 }, FIELD_NUMBER,
    )).toBe(false)
  })
})

describe('evaluateConditionalFormattingRules — first-match-wins', () => {
  it('returns empty result for empty rules', () => {
    const result = evaluateConditionalFormattingRules([], { id: 'rec1', data: { fld_n: 5 } }, FIELDS_BY_ID)
    expect(result.matchedRuleIds).toEqual([])
    expect(result.cellStyles).toEqual({})
    expect(result.rowStyle).toBeUndefined()
  })

  it('first matching cell rule per field wins', () => {
    const rules: ConditionalFormattingRule[] = [
      makeRule({ id: 'a', order: 0, operator: 'gt', value: 10, style: { backgroundColor: '#aaa' } }),
      makeRule({ id: 'b', order: 1, operator: 'gt', value: 5, style: { backgroundColor: '#bbb' } }),
    ]
    const result = evaluateConditionalFormattingRules(rules, { data: { fld_n: 100 } }, FIELDS_BY_ID)
    expect(result.matchedRuleIds).toEqual(['a', 'b'])
    expect(result.cellStyles[FIELD_NUMBER.id]?.backgroundColor).toBe('#aaa')
  })

  it('first matching applyToRow rule wins for rowStyle', () => {
    const rules: ConditionalFormattingRule[] = [
      makeRule({
        id: 'r-row1',
        order: 0,
        operator: 'gt',
        value: 0,
        style: { backgroundColor: '#fff000', applyToRow: true },
      }),
      makeRule({
        id: 'r-row2',
        order: 1,
        operator: 'gt',
        value: 50,
        style: { backgroundColor: '#0000ff', applyToRow: true },
      }),
    ]
    const result = evaluateConditionalFormattingRules(rules, { data: { fld_n: 100 } }, FIELDS_BY_ID)
    expect(result.rowStyle?.backgroundColor).toBe('#fff000')
  })

  it('rowStyle and cellStyles compose independently', () => {
    const rules: ConditionalFormattingRule[] = [
      makeRule({
        id: 'row',
        order: 0,
        fieldId: FIELD_NUMBER.id,
        operator: 'gt',
        value: 0,
        style: { backgroundColor: '#eeeeee', applyToRow: true },
      }),
      makeRule({
        id: 'cell',
        order: 1,
        fieldId: FIELD_TEXT.id,
        operator: 'eq',
        value: 'Open',
        style: { backgroundColor: '#abcdef' },
      }),
    ]
    const result = evaluateConditionalFormattingRules(
      rules,
      { data: { fld_n: 1, fld_t: 'Open' } },
      FIELDS_BY_ID,
    )
    expect(result.rowStyle?.backgroundColor).toBe('#eeeeee')
    expect(result.cellStyles[FIELD_TEXT.id]?.backgroundColor).toBe('#abcdef')
    expect(result.matchedRuleIds).toEqual(['row', 'cell'])
  })

  it('non-matching rules do not contribute styles', () => {
    const rules: ConditionalFormattingRule[] = [
      makeRule({ id: 'a', operator: 'gt', value: 10000, style: { backgroundColor: '#ff0000' } }),
    ]
    const result = evaluateConditionalFormattingRules(rules, { data: { fld_n: 1 } }, FIELDS_BY_ID)
    expect(result.matchedRuleIds).toEqual([])
    expect(result.cellStyles[FIELD_NUMBER.id]).toBeUndefined()
  })

  it('accepts a Map for fieldsById', () => {
    const map = new Map<string, MultitableField>([[FIELD_NUMBER.id, FIELD_NUMBER]])
    const result = evaluateConditionalFormattingRules(
      [makeRule({ id: 'x', operator: 'gt', value: 0 })],
      { data: { fld_n: 1 } },
      map,
    )
    expect(result.matchedRuleIds).toEqual(['x'])
  })

  it('treats raw record-without-data wrapper transparently', () => {
    const result = evaluateConditionalFormattingRules(
      [makeRule({ id: 'x', operator: 'gt', value: 0 })],
      { fld_n: 5 } as unknown as Record<string, unknown>,
      FIELDS_BY_ID,
    )
    expect(result.matchedRuleIds).toEqual(['x'])
  })
})
