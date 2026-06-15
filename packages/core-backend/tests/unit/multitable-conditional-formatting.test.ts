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

    it('rejects an unknown kind, and a colorScale/iconSet kind lacking its own config (A5-2/A5-3 add valid configs below)', () => {
      // `validBar()` only supplies a `dataBar` config, so flipping the kind alone is still rejected.
      expect(sanitizeConditionalFormattingScaleRule(validBar({ kind: 'colorScale' }))).toBeNull()
      expect(sanitizeConditionalFormattingScaleRule(validBar({ kind: 'iconSet' }))).toBeNull()
      // An unrecognised kind is still rejected (forward-dated-config guard).
      expect(sanitizeConditionalFormattingScaleRule(validBar({ kind: 'gradientNeo' }))).toBeNull()
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

describe('conditional formatting — SCALE rules (A5-2 color scale)', () => {
  const validColorScale = (over: Record<string, unknown> = {}) => ({
    id: 'cs1', fieldId: 'fld_n', kind: 'colorScale', order: 0, range: { mode: 'auto' },
    colorScale: { stops: [{ at: 'min', color: '#ffffff' }, { at: 'max', color: '#000000' }] },
    ...over,
  })
  // 3-stop classic red→yellow→green (min/mid/max).
  const ryg = { stops: [
    { at: 'min', color: '#ff0000' }, { at: 'mid', color: '#ffff00' }, { at: 'max', color: '#00ff00' },
  ] }

  describe('sanitizeConditionalFormattingScaleRule', () => {
    it('accepts a 2-stop (min/max) color scale', () => {
      const r = sanitizeConditionalFormattingScaleRule(validColorScale())
      expect(r).toEqual({
        id: 'cs1', order: 0, fieldId: 'fld_n', kind: 'colorScale', enabled: true, range: { mode: 'auto' },
        colorScale: { stops: [{ at: 'min', color: '#ffffff' }, { at: 'max', color: '#000000' }] },
      })
    })

    it('accepts a 3-stop (min/mid/max) color scale and normalizes stop order', () => {
      // Supply stops out of order — sanitizer must sort min→mid→max.
      const r = sanitizeConditionalFormattingScaleRule(validColorScale({
        colorScale: { stops: [
          { at: 'max', color: '#00ff00' }, { at: 'min', color: '#ff0000' }, { at: 'mid', color: '#ffff00' },
        ] },
      }))
      expect(r?.colorScale?.stops.map((s) => s.at)).toEqual(['min', 'mid', 'max'])
      expect(r?.colorScale?.stops.map((s) => s.color)).toEqual(['#ff0000', '#ffff00', '#00ff00'])
    })

    it('rejects 1 stop and 4 stops', () => {
      expect(sanitizeConditionalFormattingScaleRule(validColorScale({
        colorScale: { stops: [{ at: 'min', color: '#ffffff' }] },
      }))).toBeNull()
      expect(sanitizeConditionalFormattingScaleRule(validColorScale({
        colorScale: { stops: [
          { at: 'min', color: '#ffffff' }, { at: 'mid', color: '#888888' },
          { at: 'max', color: '#000000' }, { at: 'max', color: '#111111' },
        ] },
      }))).toBeNull()
    })

    it('rejects a bad anchor, a bad hex color, and a missing/duplicate anchor', () => {
      // bad anchor token
      expect(sanitizeConditionalFormattingScaleRule(validColorScale({
        colorScale: { stops: [{ at: 'min', color: '#fff' }, { at: 'middle', color: '#000' }] },
      }))).toBeNull()
      // bad hex color
      expect(sanitizeConditionalFormattingScaleRule(validColorScale({
        colorScale: { stops: [{ at: 'min', color: 'white' }, { at: 'max', color: '#000000' }] },
      }))).toBeNull()
      // 2-stop with min+min (duplicate, missing max)
      expect(sanitizeConditionalFormattingScaleRule(validColorScale({
        colorScale: { stops: [{ at: 'min', color: '#ffffff' }, { at: 'min', color: '#000000' }] },
      }))).toBeNull()
      // 2-stop with mid+max (missing required min)
      expect(sanitizeConditionalFormattingScaleRule(validColorScale({
        colorScale: { stops: [{ at: 'mid', color: '#ffffff' }, { at: 'max', color: '#000000' }] },
      }))).toBeNull()
      // 3-stop missing mid (min+max+max)
      expect(sanitizeConditionalFormattingScaleRule(validColorScale({
        colorScale: { stops: [
          { at: 'min', color: '#ffffff' }, { at: 'max', color: '#000000' }, { at: 'max', color: '#111111' },
        ] },
      }))).toBeNull()
    })

    it('rejects a missing colorScale config entirely', () => {
      expect(sanitizeConditionalFormattingScaleRule({ id: 'x', fieldId: 'f', kind: 'colorScale', order: 0, range: { mode: 'auto' } })).toBeNull()
    })
  })

  describe('buildFieldScaleMap (color scale)', () => {
    const recs = [
      { id: 'r1', data: { fld_n: 0 } },
      { id: 'r2', data: { fld_n: 25 } },
      { id: 'r3', data: { fld_n: 50 } },
      { id: 'rU', data: { fld_n: 75 } },
      { id: 'r4', data: { fld_n: 100 } },
    ]

    it('interpolates a 2-stop scale at min / interior / mid / max (exact hex)', () => {
      const rule = sanitizeConditionalFormattingScaleRule(validColorScale())!
      const f = buildFieldScaleMap([rule], recs).byField.fld_n
      expect(f.min).toBe(0)
      expect(f.max).toBe(100)
      expect(f.byRecordId.r1.scaleColor).toBe('#ffffff') // t=0  → min color
      expect(f.byRecordId.r2.scaleColor).toBe('#bfbfbf') // t=0.25
      expect(f.byRecordId.r3.scaleColor).toBe('#808080') // t=0.5
      expect(f.byRecordId.r4.scaleColor).toBe('#000000') // t=1  → max color
      // dataBar-only fields are absent on a colorScale presentation
      expect(f.byRecordId.r2.barPct).toBeUndefined()
      expect(f.byRecordId.r2.iconKey).toBeUndefined()
    })

    it('interpolates a 3-stop scale piecewise with mid anchored at t=0.5 (exact hex)', () => {
      const rule = sanitizeConditionalFormattingScaleRule(validColorScale({ colorScale: ryg }))!
      const f = buildFieldScaleMap([rule], recs).byField.fld_n
      expect(f.byRecordId.r1.scaleColor).toBe('#ff0000') // t=0    → min (red)
      expect(f.byRecordId.r2.scaleColor).toBe('#ff8000') // t=0.25 → min↔mid halfway (orange)
      expect(f.byRecordId.r3.scaleColor).toBe('#ffff00') // t=0.5  → mid (yellow)
      expect(f.byRecordId.rU.scaleColor).toBe('#80ff00') // t=0.75 → mid↔max halfway (upper-segment interior)
      expect(f.byRecordId.r4.scaleColor).toBe('#00ff00') // t=1    → max (green)
    })

    it('expands 3-digit shorthand hex before interpolating', () => {
      const rule = sanitizeConditionalFormattingScaleRule(validColorScale({
        colorScale: { stops: [{ at: 'min', color: '#f00' }, { at: 'max', color: '#00f' }] },
      }))!
      const f = buildFieldScaleMap([rule], [{ id: 'a', data: { fld_n: 0 } }, { id: 'b', data: { fld_n: 100 } }, { id: 'm', data: { fld_n: 50 } }]).byField.fld_n
      expect(f.byRecordId.m.scaleColor).toBe('#800080') // halfway #ff0000 ↔ #0000ff
    })

    it('degenerate (all-equal) range → mid color (t=0.5)', () => {
      // 3-stop degenerate → the mid (yellow) stop.
      const three = sanitizeConditionalFormattingScaleRule(validColorScale({ colorScale: ryg }))!
      const m3 = buildFieldScaleMap([three], [{ id: 'a', data: { fld_n: 7 } }, { id: 'b', data: { fld_n: 7 } }]).byField.fld_n
      expect(m3.byRecordId.a.scaleColor).toBe('#ffff00')
      expect(m3.byRecordId.b.scaleColor).toBe('#ffff00')
      // 2-stop degenerate → midpoint blend (#808080 for white↔black).
      const two = sanitizeConditionalFormattingScaleRule(validColorScale())!
      const m2 = buildFieldScaleMap([two], [{ id: 'a', data: { fld_n: 5 } }, { id: 'b', data: { fld_n: 5 } }]).byField.fld_n
      expect(m2.byRecordId.a.scaleColor).toBe('#808080')
    })

    it('handles negatives across the range and skips non-numeric / empty columns', () => {
      const rule = sanitizeConditionalFormattingScaleRule(validColorScale())!
      const f = buildFieldScaleMap([rule], [
        { id: 'a', data: { fld_n: -50 } }, // min
        { id: 'b', data: { fld_n: 0 } },   // midpoint of [-50, 50] → #808080
        { id: 'c', data: { fld_n: 50 } },  // max
        { id: 'd', data: { fld_n: 'n/a' } }, // skipped
      ]).byField.fld_n
      expect([f.min, f.max]).toEqual([-50, 50])
      expect(f.byRecordId.a.scaleColor).toBe('#ffffff')
      expect(f.byRecordId.b.scaleColor).toBe('#808080')
      expect(f.byRecordId.c.scaleColor).toBe('#000000')
      expect(f.byRecordId.d).toBeUndefined()
      // all-non-numeric column → field omitted
      expect(buildFieldScaleMap([rule], [{ id: 'x', data: { fld_n: 'x' } }]).byField.fld_n).toBeUndefined()
    })
  })
})

describe('conditional formatting — SCALE rules (A5-3 icon set)', () => {
  const validIconSet = (over: Record<string, unknown> = {}) => ({
    id: 'is1', fieldId: 'fld_n', kind: 'iconSet', order: 0, range: { mode: 'auto' },
    iconSet: { set: 'arrows3', thresholds: [10, 20] },
    ...over,
  })

  describe('sanitizeConditionalFormattingScaleRule', () => {
    it('accepts each valid set with finite ascending thresholds', () => {
      for (const set of ['arrows3', 'traffic3', 'signs3'] as const) {
        const r = sanitizeConditionalFormattingScaleRule(validIconSet({ iconSet: { set, thresholds: [10, 20] } }))
        expect(r?.kind).toBe('iconSet')
        expect(r?.iconSet).toEqual({ set, thresholds: [10, 20] })
      }
    })

    it('accepts equal thresholds (t0 === t1, monotonic non-strict)', () => {
      const r = sanitizeConditionalFormattingScaleRule(validIconSet({ iconSet: { set: 'arrows3', thresholds: [5, 5] } }))
      expect(r?.iconSet?.thresholds).toEqual([5, 5])
    })

    it('rejects an unknown set', () => {
      expect(sanitizeConditionalFormattingScaleRule(validIconSet({ iconSet: { set: 'stars5', thresholds: [10, 20] } }))).toBeNull()
    })

    it('rejects non-finite or non-monotonic thresholds, and wrong-arity threshold tuples', () => {
      expect(sanitizeConditionalFormattingScaleRule(validIconSet({ iconSet: { set: 'arrows3', thresholds: [20, 10] } }))).toBeNull() // descending
      expect(sanitizeConditionalFormattingScaleRule(validIconSet({ iconSet: { set: 'arrows3', thresholds: [Number.NaN, 20] } }))).toBeNull()
      expect(sanitizeConditionalFormattingScaleRule(validIconSet({ iconSet: { set: 'arrows3', thresholds: [10, Infinity] } }))).toBeNull()
      expect(sanitizeConditionalFormattingScaleRule(validIconSet({ iconSet: { set: 'arrows3', thresholds: [10] } }))).toBeNull()
      expect(sanitizeConditionalFormattingScaleRule(validIconSet({ iconSet: { set: 'arrows3', thresholds: [10, 20, 30] } }))).toBeNull()
    })

    it('rejects a missing iconSet config entirely', () => {
      expect(sanitizeConditionalFormattingScaleRule({ id: 'x', fieldId: 'f', kind: 'iconSet', order: 0, range: { mode: 'auto' } })).toBeNull()
    })
  })

  describe('buildFieldScaleMap (icon set)', () => {
    const rule = sanitizeConditionalFormattingScaleRule(validIconSet())! // thresholds [10, 20]

    it('bands values by absolute thresholds (v<t0 low / t0<=v<t1 mid / v>=t1 high)', () => {
      const f = buildFieldScaleMap([rule], [
        { id: 'a', data: { fld_n: 5 } },   // < 10 → low
        { id: 'b', data: { fld_n: 10 } },  // == t0 → mid (lower bound inclusive)
        { id: 'c', data: { fld_n: 15 } },  // in [10,20) → mid
        { id: 'd', data: { fld_n: 20 } },  // == t1 → high (upper bound inclusive)
        { id: 'e', data: { fld_n: 99 } },  // > t1 → high
      ]).byField.fld_n
      expect(f.byRecordId.a.iconKey).toBe('low')
      expect(f.byRecordId.b.iconKey).toBe('mid')
      expect(f.byRecordId.c.iconKey).toBe('mid')
      expect(f.byRecordId.d.iconKey).toBe('high')
      expect(f.byRecordId.e.iconKey).toBe('high')
      // dataBar fields absent on an iconSet presentation
      expect(f.byRecordId.c.barPct).toBeUndefined()
      expect(f.byRecordId.c.scaleColor).toBeUndefined()
    })

    it('with equal thresholds the middle band is empty (low or high only)', () => {
      const eq = sanitizeConditionalFormattingScaleRule(validIconSet({ iconSet: { set: 'arrows3', thresholds: [10, 10] } }))!
      const f = buildFieldScaleMap([eq], [
        { id: 'a', data: { fld_n: 9 } },   // < 10 → low
        { id: 'b', data: { fld_n: 10 } },  // 10 < 10 false, 10 < 10 false → high
        { id: 'c', data: { fld_n: 11 } },  // high
      ]).byField.fld_n
      expect(f.byRecordId.a.iconKey).toBe('low')
      expect(f.byRecordId.b.iconKey).toBe('high')
      expect(f.byRecordId.c.iconKey).toBe('high')
    })

    it('handles negatives and skips non-numeric / empty columns', () => {
      const f = buildFieldScaleMap([rule], [
        { id: 'a', data: { fld_n: -5 } },   // < 10 → low
        { id: 'b', data: { fld_n: 'n/a' } }, // skipped
      ]).byField.fld_n
      expect(f.byRecordId.a.iconKey).toBe('low')
      expect(f.byRecordId.b).toBeUndefined()
      expect(buildFieldScaleMap([rule], [{ id: 'x', data: { fld_n: 'x' } }]).byField.fld_n).toBeUndefined()
    })
  })
})
