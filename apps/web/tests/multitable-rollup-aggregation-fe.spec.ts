import { describe, expect, it } from 'vitest'
import { normalizeRollupAggregation, resolveRollupFieldProperty } from '../src/multitable/utils/field-config'
import { aggregationLabel } from '../src/multitable/utils/meta-manager-labels'

// Rollup aggregation expansion (slice 2a) — FE round-trip lock.
//
// Backend gained two numeric reducers (countall, unique). The FE normalizer is the read-back path:
// before this change `resolveRollupFieldProperty` only recognized count/sum/avg/min/max and silently
// collapsed a stored countall/unique to 'count' — so loading then re-saving the field corrupted the
// aggregation. These tests lock the normalizer + label so the round-trip stays faithful (the #1781
// wire-vs-fixture trap, normalizer-only, no component mount).
describe('rollup aggregation — FE normalizer round-trip', () => {
  it('normalizeRollupAggregation preserves the new numeric reducers', () => {
    expect(normalizeRollupAggregation('countall')).toBe('countall')
    expect(normalizeRollupAggregation('unique')).toBe('unique')
    for (const a of ['count', 'sum', 'avg', 'min', 'max'] as const) {
      expect(normalizeRollupAggregation(a)).toBe(a)
    }
  })

  it('normalizeRollupAggregation honors backend aliases + case/whitespace', () => {
    expect(normalizeRollupAggregation('counta')).toBe('count')
    expect(normalizeRollupAggregation('distinct')).toBe('unique')
    expect(normalizeRollupAggregation('uniquecount')).toBe('unique')
    expect(normalizeRollupAggregation(' CountAll ')).toBe('countall')
  })

  it('unknown / empty aggregation falls back to count', () => {
    expect(normalizeRollupAggregation('concatenate')).toBe('count') // deferred to slice 2b — not yet valid
    expect(normalizeRollupAggregation('bogus')).toBe('count')
    expect(normalizeRollupAggregation('')).toBe('count')
    expect(normalizeRollupAggregation(null)).toBe('count')
  })

  it('resolveRollupFieldProperty does NOT collapse a stored countall/unique to count', () => {
    const countall = resolveRollupFieldProperty({ linkFieldId: 'l', targetFieldId: 't', foreignSheetId: 's', aggregation: 'countall' })
    expect(countall.aggregation).toBe('countall')
    const unique = resolveRollupFieldProperty({ linkFieldId: 'l', targetFieldId: 't', foreignSheetId: 's', aggregation: 'unique' })
    expect(unique.aggregation).toBe('unique')
  })

  it('aggregationLabel returns a distinct label for the new reducers (zh + en)', () => {
    expect(aggregationLabel('countall', true)).toBe('记录数')
    expect(aggregationLabel('unique', true)).toBe('去重计数')
    expect(aggregationLabel('countall', false)).toBe('Count all')
    expect(aggregationLabel('unique', false)).toBe('Unique')
  })
})

// Slice 3 — the rollup filter condition has no builder UI yet, so the field manager carries it OPAQUELY.
// resolveRollupFieldProperty is the load side of that round-trip; if it dropped filters, an unrelated edit
// would clobber an API/template-authored filter on save (the same silent-data-loss class as #1781).
describe('rollup filter condition — opaque FE preservation (slice 3)', () => {
  it('preserves filters + filterConjunction so an edit does not silently drop them', () => {
    const p = resolveRollupFieldProperty({
      linkFieldId: 'l', targetFieldId: 't', foreignSheetId: 's', aggregation: 'countall',
      filters: [{ fieldId: 'f1', operator: 'is', value: 'paid' }], filterConjunction: 'or',
    })
    expect(p.filters).toEqual([{ fieldId: 'f1', operator: 'is', value: 'paid' }])
    expect(p.filterConjunction).toBe('or')
  })

  it('no filters → filters/filterConjunction stay absent (clean config, no spurious dirty)', () => {
    const p = resolveRollupFieldProperty({ linkFieldId: 'l', targetFieldId: 't', aggregation: 'count' })
    expect(p.filters).toBeUndefined()
    expect(p.filterConjunction).toBeUndefined()
  })

  it('filters present without explicit conjunction defaults to and', () => {
    const p = resolveRollupFieldProperty({
      linkFieldId: 'l', targetFieldId: 't', aggregation: 'count',
      filters: [{ fieldId: 'f', operator: 'is', value: 'x' }],
    })
    expect(p.filterConjunction).toBe('and')
  })
})
