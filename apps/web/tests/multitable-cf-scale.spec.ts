import { describe, expect, it } from 'vitest'
import {
  buildFieldScaleMap,
  extractScaleRulesFromConfig,
  sanitizeScaleRule,
  sanitizeScaleRules,
} from '../src/multitable/utils/conditional-formatting'
import { CONDITIONAL_FORMATTING_SCALE_RULE_LIMIT } from '../src/multitable/types'

// Frontend mirror of the backend scale-rule tests
// (packages/core-backend/tests/unit/multitable-conditional-formatting.test.ts).
// Keep behaviour identical — the FE builder must match the canonical backend.

const validBar = (over: Record<string, unknown> = {}) => ({
  id: 's1', fieldId: 'fld_n', kind: 'dataBar', order: 0,
  range: { mode: 'auto' }, dataBar: { color: '#2196f3' }, ...over,
})

describe('FE conditional-formatting scale mirror (A5-1 data bar)', () => {
  describe('sanitizeScaleRule', () => {
    it('accepts a valid dataBar rule with auto range', () => {
      expect(sanitizeScaleRule(validBar())).toEqual({
        id: 's1', order: 0, fieldId: 'fld_n', kind: 'dataBar', enabled: true,
        range: { mode: 'auto' }, dataBar: { color: '#2196f3' },
      })
    })

    it('rejects colorScale / iconSet (A5-2 / A5-3)', () => {
      expect(sanitizeScaleRule(validBar({ kind: 'colorScale' }))).toBeNull()
      expect(sanitizeScaleRule(validBar({ kind: 'iconSet' }))).toBeNull()
    })

    it('requires id/fieldId/valid hex color', () => {
      expect(sanitizeScaleRule(validBar({ id: '' }))).toBeNull()
      expect(sanitizeScaleRule(validBar({ dataBar: { color: 'blue' } }))).toBeNull()
    })

    it('normalizes fixed range and rejects degenerate / non-numeric bounds', () => {
      expect(sanitizeScaleRule(validBar({ range: { mode: 'fixed', min: 100, max: 0 } }))?.range)
        .toEqual({ mode: 'fixed', min: 0, max: 100 })
      expect(sanitizeScaleRule(validBar({ range: { mode: 'fixed', min: 5, max: 5 } }))).toBeNull()
      expect(sanitizeScaleRule(validBar({ range: { mode: 'fixed', min: 'x', max: 9 } }))).toBeNull()
    })

    it('caps + order-sorts via sanitizeScaleRules; extractScaleRulesFromConfig reads the key', () => {
      const many = Array.from({ length: CONDITIONAL_FORMATTING_SCALE_RULE_LIMIT + 5 }, (_, i) => validBar({ id: `s${i}`, fieldId: `f${i}`, order: i }))
      expect(sanitizeScaleRules(many)).toHaveLength(CONDITIONAL_FORMATTING_SCALE_RULE_LIMIT)
      expect(extractScaleRulesFromConfig({ conditionalFormattingScaleRules: [validBar()] })).toHaveLength(1)
      expect(extractScaleRulesFromConfig({})).toEqual([])
    })
  })

  describe('buildFieldScaleMap', () => {
    const recs = [
      { id: 'r1', data: { fld_n: 0 } },
      { id: 'r2', data: { fld_n: 50 } },
      { id: 'r3', data: { fld_n: 100 } },
    ]
    const rule = sanitizeScaleRule(validBar())!

    it('maps values to fill percent over auto min/max', () => {
      const f = buildFieldScaleMap([rule], recs).byField.fld_n
      expect([f.min, f.max]).toEqual([0, 100])
      expect(f.byRecordId.r1.barPct).toBe(0)
      expect(f.byRecordId.r2.barPct).toBe(50)
      expect(f.byRecordId.r3.barPct).toBe(100)
    })

    it('full bar on degenerate range; clamps fixed out-of-bounds; skips non-numeric', () => {
      expect(buildFieldScaleMap([rule], [{ id: 'a', data: { fld_n: 7 } }, { id: 'b', data: { fld_n: 7 } }]).byField.fld_n.byRecordId.a.barPct).toBe(100)
      const fixed = sanitizeScaleRule(validBar({ range: { mode: 'fixed', min: 0, max: 100 } }))!
      const m = buildFieldScaleMap([fixed], [
        { id: 'a', data: { fld_n: 'n/a' } },
        { id: 'b', data: { fld_n: 200 } },
        { id: 'c', data: { fld_n: -50 } },
      ]).byField.fld_n
      expect(m.byRecordId.a).toBeUndefined()
      expect(m.byRecordId.b.barPct).toBe(100)
      expect(m.byRecordId.c.barPct).toBe(0)
    })

    it('colors negatives with negativeColor + flags them; first rule per field wins', () => {
      const negRule = sanitizeScaleRule(validBar({ dataBar: { color: '#2196f3', negativeColor: '#f44336' } }))!
      const nm = buildFieldScaleMap([negRule], [{ id: 'a', data: { fld_n: -10 } }, { id: 'b', data: { fld_n: 10 } }]).byField.fld_n
      expect([nm.byRecordId.a.negative, nm.byRecordId.a.barColor]).toEqual([true, '#f44336'])
      expect([nm.byRecordId.b.negative, nm.byRecordId.b.barColor]).toEqual([false, '#2196f3'])

      const r1 = sanitizeScaleRule(validBar({ id: 'a', order: 0, dataBar: { color: '#111111' } }))!
      const r2 = sanitizeScaleRule(validBar({ id: 'b', order: 1, dataBar: { color: '#222222' } }))!
      expect(buildFieldScaleMap([r1, r2], recs).byField.fld_n.rule.id).toBe('a')
    })

    it('returns an empty map when a field has no numeric values', () => {
      expect(buildFieldScaleMap([rule], [{ id: 'a', data: { fld_n: 'x' } }]).byField.fld_n).toBeUndefined()
    })
  })
})
