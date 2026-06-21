import { describe, expect, it } from 'vitest'
import {
  buildFieldScaleMap,
  decideScaleStatsRefetch,
  extractScaleRulesFromConfig,
  sanitizeScaleRule,
  sanitizeScaleRules,
  scaleStatsFieldIds,
  lerpHexColor,
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

    it('rejects colorScale / iconSet kinds without a matching config', () => {
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

describe('FE conditional-formatting scale mirror (A5-2 color scale)', () => {
  const validScale = (over: Record<string, unknown> = {}) => ({
    id: 'cs1', fieldId: 'fld_n', kind: 'colorScale', order: 0,
    range: { mode: 'auto' },
    colorScale: { stops: [{ at: 'min', color: '#000000' }, { at: 'max', color: '#ffffff' }] },
    ...over,
  })
  const recs = [
    { id: 'r1', data: { fld_n: 0 } },
    { id: 'r2', data: { fld_n: 50 } },
    { id: 'r3', data: { fld_n: 100 } },
  ]

  it('accepts 2-stop and 3-stop scales and rejects malformed ones', () => {
    expect(sanitizeScaleRule(validScale())).toEqual({
      id: 'cs1', order: 0, fieldId: 'fld_n', kind: 'colorScale', enabled: true,
      range: { mode: 'auto' },
      colorScale: { stops: [{ at: 'min', color: '#000000' }, { at: 'max', color: '#ffffff' }] },
    })
    expect(sanitizeScaleRule(validScale({ colorScale: { stops: [
      { at: 'min', color: '#ff0000' }, { at: 'mid', color: '#ffff00' }, { at: 'max', color: '#00ff00' },
    ] } }))?.colorScale?.stops).toHaveLength(3)
    // missing max
    expect(sanitizeScaleRule(validScale({ colorScale: { stops: [{ at: 'min', color: '#000000' }, { at: 'mid', color: '#808080' }] } }))).toBeNull()
    // non-hex
    expect(sanitizeScaleRule(validScale({ colorScale: { stops: [{ at: 'min', color: 'black' }, { at: 'max', color: '#ffffff' }] } }))).toBeNull()
    // duplicate
    expect(sanitizeScaleRule(validScale({ colorScale: { stops: [{ at: 'min', color: '#000000' }, { at: 'min', color: '#111111' }] } }))).toBeNull()
  })

  it('maps endpoints + midpoint and never emits barPct (Trap E)', () => {
    const rule = sanitizeScaleRule(validScale())!
    const f = buildFieldScaleMap([rule], recs).byField.fld_n
    expect(f.byRecordId.r1.scaleColor).toBe('#000000')
    expect(f.byRecordId.r2.scaleColor).toBe('#808080')
    expect(f.byRecordId.r3.scaleColor).toBe('#ffffff')
    expect(f.byRecordId.r2.barPct).toBeUndefined()
    expect(f.byRecordId.r2.barColor).toBeUndefined()
  })

  it('maps every value to the max stop on a degenerate range; skips non-numeric', () => {
    const rule = sanitizeScaleRule(validScale())!
    const m = buildFieldScaleMap([rule], [{ id: 'a', data: { fld_n: 7 } }, { id: 'b', data: { fld_n: 'x' } }]).byField.fld_n
    expect(m.byRecordId.a.scaleColor).toBe('#ffffff')
    expect(m.byRecordId.b).toBeUndefined()
  })
})

describe('FE conditional-formatting scale mirror (A5-3 icon set)', () => {
  const validIcon = (over: Record<string, unknown> = {}) => ({
    id: 'is1', fieldId: 'fld_n', kind: 'iconSet', order: 0,
    range: { mode: 'auto' },
    iconSet: { set: 'arrows3', thresholds: [10, 20] },
    ...over,
  })

  it('accepts known sets with monotonic thresholds and rejects malformed ones', () => {
    expect(sanitizeScaleRule(validIcon())?.iconSet).toEqual({ set: 'arrows3', thresholds: [10, 20] })
    expect(sanitizeScaleRule(validIcon({ iconSet: { set: 'stars5', thresholds: [1, 2] } }))).toBeNull()
    expect(sanitizeScaleRule(validIcon({ iconSet: { set: 'arrows3', thresholds: [1] } }))).toBeNull()
    expect(sanitizeScaleRule(validIcon({ iconSet: { set: 'arrows3', thresholds: [20, 10] } }))).toBeNull()
  })

  it('buckets values at the absolute thresholds and never emits barPct/scaleColor', () => {
    const rule = sanitizeScaleRule(validIcon())!
    const f = buildFieldScaleMap([rule], [
      { id: 'a', data: { fld_n: 5 } },
      { id: 'b', data: { fld_n: 10 } },
      { id: 'c', data: { fld_n: 20 } },
    ]).byField.fld_n.byRecordId
    expect(f.a.iconKey).toBe('arrows3:0')
    expect(f.b.iconKey).toBe('arrows3:1')
    expect(f.c.iconKey).toBe('arrows3:2')
    expect(f.b.barPct).toBeUndefined()
    expect(f.b.scaleColor).toBeUndefined()
  })
})

describe('FE lerpHexColor parity', () => {
  it('matches the backend interpolation', () => {
    expect(lerpHexColor('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(lerpHexColor('#000', '#fff', 0.5)).toBe('#808080')
    expect(lerpHexColor('#000000ff', '#ffffff00', 0.5)).toBe('#808080')
    expect(lerpHexColor('#000000', '#ffffff', -1)).toBe('#000000')
    expect(lerpHexColor('#000000', '#ffffff', 2)).toBe('#ffffff')
  })
})

// ===========================================================================
// A5 full-column scale stats: when the caller passes server min/max (the whole
// filtered column), the AUTO-range builder uses THOSE endpoints instead of the
// page-local min/max — so the gradient/bar is correct across pages.
// ===========================================================================

describe('A5 buildFieldScaleMap uses server stats for the auto-range endpoints', () => {
  // The loaded PAGE only has values 10..20, but the full column (server) is 0..100.
  const page = [
    { id: 'r1', data: { fld_n: 10 } },
    { id: 'r2', data: { fld_n: 20 } },
  ]

  it('data-bar: page-local would be 10/20; server 0..100 → r1=10%, r2=20% (full column)', () => {
    const rule = sanitizeScaleRule(validBar())! // auto range
    // Sanity: WITHOUT server stats the page-local endpoints make r1=0%, r2=100%.
    const local = buildFieldScaleMap([rule], page).byField.fld_n
    expect([local.min, local.max]).toEqual([10, 20])
    expect([local.byRecordId.r1.barPct, local.byRecordId.r2.barPct]).toEqual([0, 100])
    // WITH server stats the endpoints become the full column 0..100.
    const f = buildFieldScaleMap([rule], page, { fld_n: { min: 0, max: 100, count: 50 } }).byField.fld_n
    expect([f.min, f.max]).toEqual([0, 100])
    expect(f.byRecordId.r1.barPct).toBe(10) // 10 / 100
    expect(f.byRecordId.r2.barPct).toBe(20) // 20 / 100
  })

  it('color-scale: interpolates against the server min/max, not the page min/max', () => {
    const rule = sanitizeScaleRule({
      id: 'cs', fieldId: 'fld_n', kind: 'colorScale', order: 0, range: { mode: 'auto' },
      colorScale: { stops: [{ at: 'min', color: '#000000' }, { at: 'max', color: '#ffffff' }] },
    })!
    // Full column 0..100 → value 10 sits at t=0.1 → #1a1a1a (not #000000 it would be at page-local min).
    const f = buildFieldScaleMap([rule], page, { fld_n: { min: 0, max: 100 } }).byField.fld_n
    expect(f.byRecordId.r1.scaleColor).toBe(lerpHexColor('#000000', '#ffffff', 0.1))
    expect(f.byRecordId.r1.scaleColor).not.toBe('#000000') // would be #000000 with page-local min=10
  })

  it('a FIXED range ignores server stats (uses its own bounds)', () => {
    const fixed = sanitizeScaleRule(validBar({ range: { mode: 'fixed', min: 0, max: 50 } }))!
    const f = buildFieldScaleMap([fixed], page, { fld_n: { min: 0, max: 100 } }).byField.fld_n
    expect([f.min, f.max]).toEqual([0, 50]) // fixed bounds win over server stats
    expect(f.byRecordId.r2.barPct).toBe(40) // 20 / 50, NOT 20 / 100
  })

  it('falls back to page-local min/max when the field has no server entry', () => {
    const rule = sanitizeScaleRule(validBar())!
    const f = buildFieldScaleMap([rule], page, { other_field: { min: 0, max: 100 } }).byField.fld_n
    expect([f.min, f.max]).toEqual([10, 20]) // no fld_n entry → page-local
  })

  it('ignores a server entry with non-finite bounds (defensive) → page-local', () => {
    const rule = sanitizeScaleRule(validBar())!
    const f = buildFieldScaleMap([rule], page, { fld_n: { min: NaN, max: 100 } as { min: number; max: number } }).byField.fld_n
    expect([f.min, f.max]).toEqual([10, 20])
  })
})

describe('A5 scaleStatsFieldIds — the lazy fetch gate', () => {
  const numericTypes = { fld_n: 'number', fld_cur: 'currency', fld_str: 'text' }

  it('includes only auto-range data-bar / color-scale on a numeric field', () => {
    const bar = sanitizeScaleRule(validBar({ id: 'b', fieldId: 'fld_n' }))!
    const cs = sanitizeScaleRule({
      id: 'c', fieldId: 'fld_cur', kind: 'colorScale', order: 1, range: { mode: 'auto' },
      colorScale: { stops: [{ at: 'min', color: '#000000' }, { at: 'max', color: '#ffffff' }] },
    })!
    expect(scaleStatsFieldIds([bar, cs], numericTypes)).toEqual(['fld_cur', 'fld_n']) // sorted, de-duped
  })

  it('excludes iconSet (absolute thresholds), fixed range, and non-numeric / unknown fields', () => {
    const icon = sanitizeScaleRule({
      id: 'i', fieldId: 'fld_n', kind: 'iconSet', order: 0, range: { mode: 'auto' },
      iconSet: { set: 'arrows3', thresholds: [10, 20] },
    })!
    const fixedBar = sanitizeScaleRule(validBar({ id: 'fx', fieldId: 'fld_cur', range: { mode: 'fixed', min: 0, max: 9 } }))!
    const strBar = sanitizeScaleRule(validBar({ id: 's', fieldId: 'fld_str' }))! // string field
    const unknownBar = sanitizeScaleRule(validBar({ id: 'u', fieldId: 'fld_missing' }))!
    expect(scaleStatsFieldIds([icon, fixedBar, strBar, unknownBar], numericTypes)).toEqual([])
  })

  it('excludes disabled rules', () => {
    const disabled = sanitizeScaleRule(validBar({ id: 'd', fieldId: 'fld_n', enabled: false }))!
    expect(scaleStatsFieldIds([disabled], numericTypes)).toEqual([])
  })
})

describe('A5 decideScaleStatsRefetch — idle-gated refetch decision', () => {
  it('does not fetch while loading (persist may be in flight)', () => {
    expect(decideScaleStatsRefetch({ loading: true, key: 'B', lastKey: 'A' })).toEqual({ fetch: false })
  })

  it('does not fetch when the key is unchanged (pagination / no-op re-fire)', () => {
    expect(decideScaleStatsRefetch({ loading: false, key: 'A', lastKey: 'A' })).toEqual({ fetch: false })
  })

  it('fetches + adopts the new key when idle and the key changed', () => {
    expect(decideScaleStatsRefetch({ loading: false, key: 'B', lastKey: 'A' })).toEqual({ fetch: true, key: 'B' })
  })

  // The regression this guards: a DRAFT filter edit (no apply) must NOT advance lastKey, otherwise the
  // real post-apply fetch is suppressed and the scale renders B's rows with A's (stale) min/max. The
  // workbench only INVOKES this on idle-safe triggers (the grid.loading edge + view/search/fields), never
  // on a draft filter ref change — so a draft edit never reaches this decision. We simulate the full flow:
  // the only calls that happen are at the loading edges; the draft mutation in between is a no-call.
  it('draft-edit-then-apply still fetches with the POST-APPLY key (no stale suppression)', () => {
    let lastKey = ''
    const apply = (loading: boolean, key: string) => {
      const d = decideScaleStatsRefetch({ loading, key, lastKey })
      if (d.fetch) lastKey = d.key
      return d.fetch
    }
    // 1) Filter A applied: loading goes true (no fetch) then false (fetch A).
    expect(apply(true, 'K_A')).toBe(false)
    expect(apply(false, 'K_A')).toBe(true)
    expect(lastKey).toBe('K_A')
    // 2) User edits a DRAFT filter to B with NO apply → the workbench does NOT call decide at all (the
    //    filter refs are not watch triggers). lastKey stays K_A. (No invocation = nothing to assert here.)
    // 3) User clicks apply: loading true (no fetch), persist B, loading false → the key is now K_B (the
    //    handler reads the just-persisted refs) → fetch fires for B. This is the bug fix.
    expect(apply(true, 'K_B')).toBe(false)
    expect(apply(false, 'K_B')).toBe(true)
    expect(lastKey).toBe('K_B')
  })

  // Counter-proof: if a draft edit WERE allowed to call decide (the buggy wiring), it would advance lastKey
  // to K_B before apply, and the post-apply call would be suppressed → stale. This documents WHY the
  // workbench must not put the draft filter refs in the watch source list.
  it('counter-proof: a draft edit reaching decide would suppress the post-apply fetch (the bug)', () => {
    let lastKey = ''
    const apply = (loading: boolean, key: string) => {
      const d = decideScaleStatsRefetch({ loading, key, lastKey })
      if (d.fetch) lastKey = d.key
      return d.fetch
    }
    expect(apply(false, 'K_A')).toBe(true) // A applied + fetched
    expect(apply(false, 'K_B')).toBe(true) // BUGGY: draft edit reaches decide while idle → advances to K_B
    expect(apply(false, 'K_B')).toBe(false) // post-apply: key already K_B → SUPPRESSED (stale stats)
  })
})
