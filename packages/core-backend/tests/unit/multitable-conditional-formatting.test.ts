import { describe, expect, it } from 'vitest'

import {
  CONDITIONAL_FORMATTING_RULE_LIMIT,
  evaluateConditionalFormattingRules,
  evaluateRule,
  extractRulesFromConfig,
  sanitizeConditionalFormattingRule,
  sanitizeConditionalFormattingRules,
  type ConditionalFormattingRule,
  CONDITIONAL_FORMATTING_SCALE_RULE_LIMIT,
  buildFieldScaleMap,
  extractScaleRulesFromConfig,
  sanitizeConditionalFormattingScaleRule,
  sanitizeConditionalFormattingScaleRules,
  lerpHexColor,
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

describe('conditional formatting — range-based SCALE rules (A5-1 data bar)', () => {
  const validBar = (over: Record<string, unknown> = {}) => ({
    id: 's1', fieldId: 'fld_n', kind: 'dataBar', order: 0,
    range: { mode: 'auto' }, dataBar: { color: '#2196f3' }, ...over,
  })

  describe('sanitizeConditionalFormattingScaleRule', () => {
    it('accepts a valid dataBar rule with auto range', () => {
      const r = sanitizeConditionalFormattingScaleRule(validBar())
      expect(r).toEqual({ id: 's1', order: 0, fieldId: 'fld_n', kind: 'dataBar', enabled: true, range: { mode: 'auto' }, dataBar: { color: '#2196f3' } })
    })

    it('rejects colorScale / iconSet kinds that carry no valid config (A5-2 / A5-3 land in their own blocks)', () => {
      // validBar only supplies a dataBar config; switching `kind` without a
      // matching colorScale/iconSet config must still be rejected.
      expect(sanitizeConditionalFormattingScaleRule(validBar({ kind: 'colorScale' }))).toBeNull()
      expect(sanitizeConditionalFormattingScaleRule(validBar({ kind: 'iconSet' }))).toBeNull()
    })

    it('requires id, fieldId, and a valid hex bar color', () => {
      expect(sanitizeConditionalFormattingScaleRule(validBar({ id: '' }))).toBeNull()
      expect(sanitizeConditionalFormattingScaleRule(validBar({ fieldId: '  ' }))).toBeNull()
      expect(sanitizeConditionalFormattingScaleRule(validBar({ dataBar: { color: 'blue' } }))).toBeNull()
      expect(sanitizeConditionalFormattingScaleRule(validBar({ dataBar: {} }))).toBeNull()
    })

    it('normalizes a fixed range and rejects a degenerate (min === max) one', () => {
      const r = sanitizeConditionalFormattingScaleRule(validBar({ range: { mode: 'fixed', min: 100, max: 0 } }))
      expect(r?.range).toEqual({ mode: 'fixed', min: 0, max: 100 })
      expect(sanitizeConditionalFormattingScaleRule(validBar({ range: { mode: 'fixed', min: 5, max: 5 } }))).toBeNull()
      // fixed mode with non-numeric bounds → reject (no silent fallback to auto)
      expect(sanitizeConditionalFormattingScaleRule(validBar({ range: { mode: 'fixed', min: 'x', max: 9 } }))).toBeNull()
    })

    it('carries negativeColor + showValue when valid', () => {
      const r = sanitizeConditionalFormattingScaleRule(validBar({ dataBar: { color: '#2196f3', negativeColor: '#f44336', showValue: true } }))
      expect(r?.dataBar).toEqual({ color: '#2196f3', negativeColor: '#f44336', showValue: true })
    })

    it('caps and order-sorts via sanitizeConditionalFormattingScaleRules', () => {
      const many = Array.from({ length: CONDITIONAL_FORMATTING_SCALE_RULE_LIMIT + 5 }, (_, i) => validBar({ id: `s${i}`, fieldId: `f${i}`, order: i }))
      expect(sanitizeConditionalFormattingScaleRules(many)).toHaveLength(CONDITIONAL_FORMATTING_SCALE_RULE_LIMIT)
      const sorted = sanitizeConditionalFormattingScaleRules([validBar({ id: 'b', fieldId: 'f2', order: 5 }), validBar({ id: 'a', fieldId: 'f1', order: 1 })])
      expect(sorted.map((r) => r.id)).toEqual(['a', 'b'])
    })

    it('extractScaleRulesFromConfig reads the conditionalFormattingScaleRules key', () => {
      const rules = extractScaleRulesFromConfig({ conditionalFormattingScaleRules: [validBar()] })
      expect(rules).toHaveLength(1)
      expect(extractScaleRulesFromConfig({})).toEqual([])
    })
  })

  describe('buildFieldScaleMap (data bar)', () => {
    const recs = [
      { id: 'r1', data: { fld_n: 0 } },
      { id: 'r2', data: { fld_n: 50 } },
      { id: 'r3', data: { fld_n: 100 } },
    ]
    const rule = sanitizeConditionalFormattingScaleRule(validBar())!

    it('maps values to fill percent over the auto min/max', () => {
      const map = buildFieldScaleMap([rule], recs)
      const f = map.byField.fld_n
      expect(f.min).toBe(0)
      expect(f.max).toBe(100)
      expect(f.byRecordId.r1.barPct).toBe(0)
      expect(f.byRecordId.r2.barPct).toBe(50)
      expect(f.byRecordId.r3.barPct).toBe(100)
      expect(f.byRecordId.r2.barColor).toBe('#2196f3')
    })

    it('renders a full bar for a degenerate (all-equal) range', () => {
      const map = buildFieldScaleMap([rule], [{ id: 'a', data: { fld_n: 7 } }, { id: 'b', data: { fld_n: 7 } }])
      expect(map.byField.fld_n.byRecordId.a.barPct).toBe(100)
      expect(map.byField.fld_n.byRecordId.b.barPct).toBe(100)
    })

    it('colors negatives with negativeColor and flags them', () => {
      const negRule = sanitizeConditionalFormattingScaleRule(validBar({ dataBar: { color: '#2196f3', negativeColor: '#f44336' } }))!
      const map = buildFieldScaleMap([negRule], [{ id: 'a', data: { fld_n: -10 } }, { id: 'b', data: { fld_n: 10 } }])
      expect(map.byField.fld_n.byRecordId.a.negative).toBe(true)
      expect(map.byField.fld_n.byRecordId.a.barColor).toBe('#f44336')
      expect(map.byField.fld_n.byRecordId.b.negative).toBe(false)
      expect(map.byField.fld_n.byRecordId.b.barColor).toBe('#2196f3')
    })

    it('skips non-numeric values (no bar) and clamps fixed-range out-of-bounds', () => {
      const fixed = sanitizeConditionalFormattingScaleRule(validBar({ range: { mode: 'fixed', min: 0, max: 100 } }))!
      const map = buildFieldScaleMap([fixed], [
        { id: 'a', data: { fld_n: 'n/a' } },
        { id: 'b', data: { fld_n: 200 } }, // above max → clamp 100
        { id: 'c', data: { fld_n: -50 } }, // below min → clamp 0
      ])
      expect(map.byField.fld_n.byRecordId.a).toBeUndefined()
      expect(map.byField.fld_n.byRecordId.b.barPct).toBe(100)
      expect(map.byField.fld_n.byRecordId.c.barPct).toBe(0)
    })

    it('first rule per field wins (mirrors cell-style precedence)', () => {
      const r1 = sanitizeConditionalFormattingScaleRule(validBar({ id: 'a', order: 0, dataBar: { color: '#111111' } }))!
      const r2 = sanitizeConditionalFormattingScaleRule(validBar({ id: 'b', order: 1, dataBar: { color: '#222222' } }))!
      const map = buildFieldScaleMap([r1, r2], recs)
      expect(map.byField.fld_n.rule.id).toBe('a')
      expect(map.byField.fld_n.byRecordId.r2.barColor).toBe('#111111')
    })

    it('returns an empty map when a field has no numeric values', () => {
      const map = buildFieldScaleMap([rule], [{ id: 'a', data: { fld_n: 'x' } }])
      expect(map.byField.fld_n).toBeUndefined()
    })
  })
})

describe('conditional formatting — color scale SCALE rules (A5-2)', () => {
  const validScale = (over: Record<string, unknown> = {}) => ({
    id: 'cs1', fieldId: 'fld_n', kind: 'colorScale', order: 0,
    range: { mode: 'auto' },
    colorScale: { stops: [{ at: 'min', color: '#000000' }, { at: 'max', color: '#ffffff' }] },
    ...over,
  })

  describe('sanitizeConditionalFormattingScaleRule (color scale)', () => {
    it('accepts a 2-stop (min/max) color scale and round-trips it', () => {
      const r = sanitizeConditionalFormattingScaleRule(validScale())
      expect(r).toEqual({
        id: 'cs1', order: 0, fieldId: 'fld_n', kind: 'colorScale', enabled: true,
        range: { mode: 'auto' },
        colorScale: { stops: [{ at: 'min', color: '#000000' }, { at: 'max', color: '#ffffff' }] },
      })
    })

    it('accepts a 3-stop (min/mid/max) color scale', () => {
      const r = sanitizeConditionalFormattingScaleRule(validScale({
        colorScale: { stops: [
          { at: 'min', color: '#ff0000' }, { at: 'mid', color: '#ffff00' }, { at: 'max', color: '#00ff00' },
        ] },
      }))
      expect(r?.colorScale?.stops).toHaveLength(3)
      expect(r?.dataBar).toBeUndefined()
      expect(r?.iconSet).toBeUndefined()
    })

    it('rejects a stop count other than 2 or 3', () => {
      expect(sanitizeConditionalFormattingScaleRule(validScale({
        colorScale: { stops: [{ at: 'min', color: '#000000' }] },
      }))).toBeNull()
      expect(sanitizeConditionalFormattingScaleRule(validScale({
        colorScale: { stops: [
          { at: 'min', color: '#000000' }, { at: 'mid', color: '#808080' },
          { at: 'max', color: '#ffffff' }, { at: 'max', color: '#eeeeee' },
        ] },
      }))).toBeNull()
    })

    it('rejects a non-hex stop color', () => {
      expect(sanitizeConditionalFormattingScaleRule(validScale({
        colorScale: { stops: [{ at: 'min', color: 'black' }, { at: 'max', color: '#ffffff' }] },
      }))).toBeNull()
    })

    it('rejects an unknown or duplicate stop position', () => {
      expect(sanitizeConditionalFormattingScaleRule(validScale({
        colorScale: { stops: [{ at: 'low', color: '#000000' }, { at: 'max', color: '#ffffff' }] },
      }))).toBeNull()
      expect(sanitizeConditionalFormattingScaleRule(validScale({
        colorScale: { stops: [{ at: 'min', color: '#000000' }, { at: 'min', color: '#111111' }] },
      }))).toBeNull()
    })

    it('requires min + max (and mid when 3-stop)', () => {
      // 2 stops but missing max
      expect(sanitizeConditionalFormattingScaleRule(validScale({
        colorScale: { stops: [{ at: 'min', color: '#000000' }, { at: 'mid', color: '#808080' }] },
      }))).toBeNull()
      // stops not an array
      expect(sanitizeConditionalFormattingScaleRule(validScale({ colorScale: { stops: 'x' } }))).toBeNull()
      // colorScale config missing entirely
      expect(sanitizeConditionalFormattingScaleRule(validScale({ colorScale: undefined }))).toBeNull()
    })
  })

  describe('buildFieldScaleMap (color scale)', () => {
    const recs = [
      { id: 'r1', data: { fld_n: 0 } },
      { id: 'r2', data: { fld_n: 50 } },
      { id: 'r3', data: { fld_n: 100 } },
    ]

    it('maps endpoints to the exact stop colors and the midpoint to the interpolated color', () => {
      const rule = sanitizeConditionalFormattingScaleRule(validScale())!
      const map = buildFieldScaleMap([rule], recs)
      const f = map.byField.fld_n
      expect(f.min).toBe(0)
      expect(f.max).toBe(100)
      expect(f.byRecordId.r1.scaleColor).toBe('#000000')
      expect(f.byRecordId.r3.scaleColor).toBe('#ffffff')
      // #000000 -> #ffffff at t=0.5 = #808080
      expect(f.byRecordId.r2.scaleColor).toBe('#808080')
    })

    it('a color-scale presentation sets scaleColor and never barPct/barColor (Trap B/E)', () => {
      const rule = sanitizeConditionalFormattingScaleRule(validScale())!
      const map = buildFieldScaleMap([rule], recs)
      const cell = map.byField.fld_n.byRecordId.r2
      expect(cell.scaleColor).toBeDefined()
      expect(cell.barPct).toBeUndefined()
      expect(cell.barColor).toBeUndefined()
      expect(cell.negative).toBeUndefined()
      expect(cell.iconKey).toBeUndefined()
    })

    it('splits a 3-stop scale at the midpoint', () => {
      const rule = sanitizeConditionalFormattingScaleRule(validScale({
        colorScale: { stops: [
          { at: 'min', color: '#000000' }, { at: 'mid', color: '#ff0000' }, { at: 'max', color: '#ffffff' },
        ] },
      }))!
      const map = buildFieldScaleMap([rule], recs)
      const f = map.byField.fld_n
      // exactly at the mid value resolves to the mid stop
      expect(f.byRecordId.r2.scaleColor).toBe('#ff0000')
      // quarter point (value 25) interpolates min->mid at t*2 = 0.5: #000000 -> #ff0000 = #800000
      const map2 = buildFieldScaleMap([rule], [{ id: 'q', data: { fld_n: 25 } }, ...recs])
      expect(map2.byField.fld_n.byRecordId.q.scaleColor).toBe('#800000')
    })

    it('maps every value to the max stop for a degenerate (all-equal) range', () => {
      const rule = sanitizeConditionalFormattingScaleRule(validScale())!
      const map = buildFieldScaleMap([rule], [{ id: 'a', data: { fld_n: 7 } }, { id: 'b', data: { fld_n: 7 } }])
      expect(map.byField.fld_n.byRecordId.a.scaleColor).toBe('#ffffff')
      expect(map.byField.fld_n.byRecordId.b.scaleColor).toBe('#ffffff')
    })

    it('skips non-numeric values (no presentation)', () => {
      const rule = sanitizeConditionalFormattingScaleRule(validScale())!
      const map = buildFieldScaleMap([rule], [
        { id: 'a', data: { fld_n: 'n/a' } },
        { id: 'b', data: { fld_n: 100 } },
      ])
      expect(map.byField.fld_n.byRecordId.a).toBeUndefined()
      expect(map.byField.fld_n.byRecordId.b.scaleColor).toBe('#ffffff')
    })
  })
})

describe('conditional formatting — icon set SCALE rules (A5-3)', () => {
  const validIcon = (over: Record<string, unknown> = {}) => ({
    id: 'is1', fieldId: 'fld_n', kind: 'iconSet', order: 0,
    range: { mode: 'auto' },
    iconSet: { set: 'arrows3', thresholds: [10, 20] },
    ...over,
  })

  describe('sanitizeConditionalFormattingScaleRule (icon set)', () => {
    it('accepts each known set with monotonic thresholds and round-trips it', () => {
      for (const set of ['arrows3', 'traffic3', 'signs3']) {
        const r = sanitizeConditionalFormattingScaleRule(validIcon({ iconSet: { set, thresholds: [1, 2] } }))
        expect(r?.iconSet).toEqual({ set, thresholds: [1, 2] })
        expect(r?.dataBar).toBeUndefined()
        expect(r?.colorScale).toBeUndefined()
      }
    })

    it('rejects an unknown set name', () => {
      expect(sanitizeConditionalFormattingScaleRule(validIcon({ iconSet: { set: 'stars5', thresholds: [1, 2] } }))).toBeNull()
    })

    it('rejects thresholds that are not exactly two numbers', () => {
      expect(sanitizeConditionalFormattingScaleRule(validIcon({ iconSet: { set: 'arrows3', thresholds: [1] } }))).toBeNull()
      expect(sanitizeConditionalFormattingScaleRule(validIcon({ iconSet: { set: 'arrows3', thresholds: [1, 2, 3] } }))).toBeNull()
      expect(sanitizeConditionalFormattingScaleRule(validIcon({ iconSet: { set: 'arrows3', thresholds: ['a', 2] } }))).toBeNull()
    })

    it('rejects non-monotonic thresholds (no silent swap)', () => {
      expect(sanitizeConditionalFormattingScaleRule(validIcon({ iconSet: { set: 'arrows3', thresholds: [20, 10] } }))).toBeNull()
      expect(sanitizeConditionalFormattingScaleRule(validIcon({ iconSet: { set: 'arrows3', thresholds: [10, 10] } }))).toBeNull()
    })

    it('rejects a missing iconSet config', () => {
      expect(sanitizeConditionalFormattingScaleRule(validIcon({ iconSet: undefined }))).toBeNull()
    })
  })

  describe('buildFieldScaleMap (icon set)', () => {
    const rule = sanitizeConditionalFormattingScaleRule(validIcon())! // thresholds [10, 20]

    it('buckets values into 3 icon indices at the absolute thresholds', () => {
      const map = buildFieldScaleMap([rule], [
        { id: 'a', data: { fld_n: 5 } },   // < t0 -> 0
        { id: 'b', data: { fld_n: 10 } },  // == t0 -> 1
        { id: 'c', data: { fld_n: 15 } },  // t0..t1 -> 1
        { id: 'd', data: { fld_n: 20 } },  // == t1 -> 2
        { id: 'e', data: { fld_n: 25 } },  // >= t1 -> 2
      ])
      const f = map.byField.fld_n.byRecordId
      expect(f.a.iconKey).toBe('arrows3:0')
      expect(f.b.iconKey).toBe('arrows3:1')
      expect(f.c.iconKey).toBe('arrows3:1')
      expect(f.d.iconKey).toBe('arrows3:2')
      expect(f.e.iconKey).toBe('arrows3:2')
    })

    it('an icon-set presentation sets iconKey and never barPct/scaleColor', () => {
      const map = buildFieldScaleMap([rule], [{ id: 'a', data: { fld_n: 15 } }])
      const cell = map.byField.fld_n.byRecordId.a
      expect(cell.iconKey).toBe('arrows3:1')
      expect(cell.barPct).toBeUndefined()
      expect(cell.barColor).toBeUndefined()
      expect(cell.scaleColor).toBeUndefined()
    })

    it('skips non-numeric values (no presentation)', () => {
      const map = buildFieldScaleMap([rule], [{ id: 'a', data: { fld_n: 'x' } }, { id: 'b', data: { fld_n: 30 } }])
      expect(map.byField.fld_n.byRecordId.a).toBeUndefined()
      expect(map.byField.fld_n.byRecordId.b.iconKey).toBe('arrows3:2')
    })
  })
})

describe('lerpHexColor (A5-2 helper)', () => {
  it('returns the endpoints at t=0 and t=1', () => {
    expect(lerpHexColor('#000000', '#ffffff', 0)).toBe('#000000')
    expect(lerpHexColor('#000000', '#ffffff', 1)).toBe('#ffffff')
  })

  it('interpolates the midpoint', () => {
    expect(lerpHexColor('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(lerpHexColor('#ff0000', '#0000ff', 0.5)).toBe('#800080')
  })

  it('clamps t outside [0,1]', () => {
    expect(lerpHexColor('#000000', '#ffffff', -1)).toBe('#000000')
    expect(lerpHexColor('#000000', '#ffffff', 2)).toBe('#ffffff')
  })

  it('expands 3-digit hex and strips 8-digit alpha', () => {
    expect(lerpHexColor('#000', '#fff', 0.5)).toBe('#808080')
    expect(lerpHexColor('#000000ff', '#ffffff00', 0.5)).toBe('#808080')
  })
})
