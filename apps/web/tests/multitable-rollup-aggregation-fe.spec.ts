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
