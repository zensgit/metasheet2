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

    it('rejects an unknown kind and a colorScale/iconSet kind lacking its config (valid configs accepted in the A5-2/A5-3 blocks below)', () => {
      // `validBar()` only supplies a `dataBar` config, so flipping the kind alone is still rejected.
      expect(sanitizeScaleRule(validBar({ kind: 'colorScale' }))).toBeNull()
      expect(sanitizeScaleRule(validBar({ kind: 'iconSet' }))).toBeNull()
      expect(sanitizeScaleRule(validBar({ kind: 'gradientNeo' }))).toBeNull()
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

// FE↔BE PARITY: there is no cross-package test harness (core-backend and
// apps/web are separate vitest projects), so the only guard against mirror-drift
// is that the expected sanitized rules + interpolated-hex literals below match
// the canonical backend spec byte-for-byte
// (packages/core-backend/tests/unit/multitable-conditional-formatting.test.ts).
describe('FE conditional-formatting scale mirror (A5-2 color scale)', () => {
  const validColorScale = (over: Record<string, unknown> = {}) => ({
    id: 'cs1', fieldId: 'fld_n', kind: 'colorScale', order: 0, range: { mode: 'auto' },
    colorScale: { stops: [{ at: 'min', color: '#ffffff' }, { at: 'max', color: '#000000' }] },
    ...over,
  })
  const ryg = { stops: [
    { at: 'min', color: '#ff0000' }, { at: 'mid', color: '#ffff00' }, { at: 'max', color: '#00ff00' },
  ] }

  describe('sanitizeScaleRule', () => {
    it('accepts a 2-stop color scale', () => {
      expect(sanitizeScaleRule(validColorScale())).toEqual({
        id: 'cs1', order: 0, fieldId: 'fld_n', kind: 'colorScale', enabled: true, range: { mode: 'auto' },
        colorScale: { stops: [{ at: 'min', color: '#ffffff' }, { at: 'max', color: '#000000' }] },
      })
    })

    it('accepts a 3-stop color scale and normalizes stop order to min→mid→max', () => {
      const r = sanitizeScaleRule(validColorScale({
        colorScale: { stops: [
          { at: 'max', color: '#00ff00' }, { at: 'min', color: '#ff0000' }, { at: 'mid', color: '#ffff00' },
        ] },
      }))
      expect(r?.colorScale?.stops.map((s) => s.at)).toEqual(['min', 'mid', 'max'])
      expect(r?.colorScale?.stops.map((s) => s.color)).toEqual(['#ff0000', '#ffff00', '#00ff00'])
    })

    it('rejects 1 stop / 4 stops / bad anchor / bad hex / missing / duplicate anchor', () => {
      expect(sanitizeScaleRule(validColorScale({ colorScale: { stops: [{ at: 'min', color: '#ffffff' }] } }))).toBeNull()
      expect(sanitizeScaleRule(validColorScale({
        colorScale: { stops: [
          { at: 'min', color: '#ffffff' }, { at: 'mid', color: '#888888' },
          { at: 'max', color: '#000000' }, { at: 'max', color: '#111111' },
        ] },
      }))).toBeNull()
      expect(sanitizeScaleRule(validColorScale({ colorScale: { stops: [{ at: 'min', color: '#fff' }, { at: 'middle', color: '#000' }] } }))).toBeNull()
      expect(sanitizeScaleRule(validColorScale({ colorScale: { stops: [{ at: 'min', color: 'white' }, { at: 'max', color: '#000000' }] } }))).toBeNull()
      expect(sanitizeScaleRule(validColorScale({ colorScale: { stops: [{ at: 'min', color: '#ffffff' }, { at: 'min', color: '#000000' }] } }))).toBeNull()
      expect(sanitizeScaleRule(validColorScale({ colorScale: { stops: [{ at: 'mid', color: '#ffffff' }, { at: 'max', color: '#000000' }] } }))).toBeNull()
    })

    it('rejects a missing colorScale config', () => {
      expect(sanitizeScaleRule({ id: 'x', fieldId: 'f', kind: 'colorScale', order: 0, range: { mode: 'auto' } })).toBeNull()
    })
  })

  describe('buildFieldScaleMap (color scale)', () => {
    const recs = [
      { id: 'r1', data: { fld_n: 0 } },
      { id: 'r2', data: { fld_n: 25 } },
      { id: 'r3', data: { fld_n: 50 } },
      { id: 'r4', data: { fld_n: 100 } },
    ]

    it('interpolates a 2-stop scale at min / interior / mid / max (exact hex)', () => {
      const f = buildFieldScaleMap([sanitizeScaleRule(validColorScale())!], recs).byField.fld_n
      expect([f.min, f.max]).toEqual([0, 100])
      expect(f.byRecordId.r1.scaleColor).toBe('#ffffff')
      expect(f.byRecordId.r2.scaleColor).toBe('#bfbfbf')
      expect(f.byRecordId.r3.scaleColor).toBe('#808080')
      expect(f.byRecordId.r4.scaleColor).toBe('#000000')
      expect(f.byRecordId.r2.barPct).toBeUndefined()
      expect(f.byRecordId.r2.iconKey).toBeUndefined()
    })

    it('interpolates a 3-stop scale piecewise with mid anchored at t=0.5 (exact hex)', () => {
      const f = buildFieldScaleMap([sanitizeScaleRule(validColorScale({ colorScale: ryg }))!], recs).byField.fld_n
      expect(f.byRecordId.r1.scaleColor).toBe('#ff0000')
      expect(f.byRecordId.r2.scaleColor).toBe('#ff8000')
      expect(f.byRecordId.r3.scaleColor).toBe('#ffff00')
      expect(f.byRecordId.r4.scaleColor).toBe('#00ff00')
    })

    it('expands 3-digit shorthand hex before interpolating', () => {
      const f = buildFieldScaleMap(
        [sanitizeScaleRule(validColorScale({ colorScale: { stops: [{ at: 'min', color: '#f00' }, { at: 'max', color: '#00f' }] } }))!],
        [{ id: 'a', data: { fld_n: 0 } }, { id: 'b', data: { fld_n: 100 } }, { id: 'm', data: { fld_n: 50 } }],
      ).byField.fld_n
      expect(f.byRecordId.m.scaleColor).toBe('#800080')
    })

    it('degenerate range → mid color (t=0.5): 3-stop mid, 2-stop midpoint blend', () => {
      const m3 = buildFieldScaleMap([sanitizeScaleRule(validColorScale({ colorScale: ryg }))!], [{ id: 'a', data: { fld_n: 7 } }, { id: 'b', data: { fld_n: 7 } }]).byField.fld_n
      expect(m3.byRecordId.a.scaleColor).toBe('#ffff00')
      expect(m3.byRecordId.b.scaleColor).toBe('#ffff00')
      const m2 = buildFieldScaleMap([sanitizeScaleRule(validColorScale())!], [{ id: 'a', data: { fld_n: 5 } }, { id: 'b', data: { fld_n: 5 } }]).byField.fld_n
      expect(m2.byRecordId.a.scaleColor).toBe('#808080')
    })

    it('handles negatives and skips non-numeric / empty columns', () => {
      const f = buildFieldScaleMap([sanitizeScaleRule(validColorScale())!], [
        { id: 'a', data: { fld_n: -50 } },
        { id: 'b', data: { fld_n: 0 } },
        { id: 'c', data: { fld_n: 50 } },
        { id: 'd', data: { fld_n: 'n/a' } },
      ]).byField.fld_n
      expect([f.min, f.max]).toEqual([-50, 50])
      expect(f.byRecordId.a.scaleColor).toBe('#ffffff')
      expect(f.byRecordId.b.scaleColor).toBe('#808080')
      expect(f.byRecordId.c.scaleColor).toBe('#000000')
      expect(f.byRecordId.d).toBeUndefined()
      expect(buildFieldScaleMap([sanitizeScaleRule(validColorScale())!], [{ id: 'x', data: { fld_n: 'x' } }]).byField.fld_n).toBeUndefined()
    })
  })
})

describe('FE conditional-formatting scale mirror (A5-3 icon set)', () => {
  const validIconSet = (over: Record<string, unknown> = {}) => ({
    id: 'is1', fieldId: 'fld_n', kind: 'iconSet', order: 0, range: { mode: 'auto' },
    iconSet: { set: 'arrows3', thresholds: [10, 20] },
    ...over,
  })

  describe('sanitizeScaleRule', () => {
    it('accepts each valid set with finite ascending thresholds', () => {
      for (const set of ['arrows3', 'traffic3', 'signs3'] as const) {
        expect(sanitizeScaleRule(validIconSet({ iconSet: { set, thresholds: [10, 20] } }))?.iconSet).toEqual({ set, thresholds: [10, 20] })
      }
    })

    it('accepts equal thresholds (t0 === t1)', () => {
      expect(sanitizeScaleRule(validIconSet({ iconSet: { set: 'arrows3', thresholds: [5, 5] } }))?.iconSet?.thresholds).toEqual([5, 5])
    })

    it('rejects unknown set / non-finite / non-monotonic / wrong-arity thresholds / missing config', () => {
      expect(sanitizeScaleRule(validIconSet({ iconSet: { set: 'stars5', thresholds: [10, 20] } }))).toBeNull()
      expect(sanitizeScaleRule(validIconSet({ iconSet: { set: 'arrows3', thresholds: [20, 10] } }))).toBeNull()
      expect(sanitizeScaleRule(validIconSet({ iconSet: { set: 'arrows3', thresholds: [Number.NaN, 20] } }))).toBeNull()
      expect(sanitizeScaleRule(validIconSet({ iconSet: { set: 'arrows3', thresholds: [10, Infinity] } }))).toBeNull()
      expect(sanitizeScaleRule(validIconSet({ iconSet: { set: 'arrows3', thresholds: [10] } }))).toBeNull()
      expect(sanitizeScaleRule(validIconSet({ iconSet: { set: 'arrows3', thresholds: [10, 20, 30] } }))).toBeNull()
      expect(sanitizeScaleRule({ id: 'x', fieldId: 'f', kind: 'iconSet', order: 0, range: { mode: 'auto' } })).toBeNull()
    })
  })

  describe('buildFieldScaleMap (icon set)', () => {
    const rule = sanitizeScaleRule(validIconSet())! // thresholds [10, 20]

    it('bands values by absolute thresholds (v<t0 low / t0<=v<t1 mid / v>=t1 high)', () => {
      const f = buildFieldScaleMap([rule], [
        { id: 'a', data: { fld_n: 5 } },
        { id: 'b', data: { fld_n: 10 } },
        { id: 'c', data: { fld_n: 15 } },
        { id: 'd', data: { fld_n: 20 } },
        { id: 'e', data: { fld_n: 99 } },
      ]).byField.fld_n
      expect(f.byRecordId.a.iconKey).toBe('low')
      expect(f.byRecordId.b.iconKey).toBe('mid')
      expect(f.byRecordId.c.iconKey).toBe('mid')
      expect(f.byRecordId.d.iconKey).toBe('high')
      expect(f.byRecordId.e.iconKey).toBe('high')
      expect(f.byRecordId.c.barPct).toBeUndefined()
      expect(f.byRecordId.c.scaleColor).toBeUndefined()
    })

    it('with equal thresholds the middle band is empty', () => {
      const eq = sanitizeScaleRule(validIconSet({ iconSet: { set: 'arrows3', thresholds: [10, 10] } }))!
      const f = buildFieldScaleMap([eq], [
        { id: 'a', data: { fld_n: 9 } },
        { id: 'b', data: { fld_n: 10 } },
        { id: 'c', data: { fld_n: 11 } },
      ]).byField.fld_n
      expect(f.byRecordId.a.iconKey).toBe('low')
      expect(f.byRecordId.b.iconKey).toBe('high')
      expect(f.byRecordId.c.iconKey).toBe('high')
    })

    it('handles negatives and skips non-numeric / empty columns', () => {
      const f = buildFieldScaleMap([rule], [
        { id: 'a', data: { fld_n: -5 } },
        { id: 'b', data: { fld_n: 'n/a' } },
      ]).byField.fld_n
      expect(f.byRecordId.a.iconKey).toBe('low')
      expect(f.byRecordId.b).toBeUndefined()
      expect(buildFieldScaleMap([rule], [{ id: 'x', data: { fld_n: 'x' } }]).byField.fld_n).toBeUndefined()
    })
  })
})
