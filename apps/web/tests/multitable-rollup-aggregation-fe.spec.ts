import { describe, expect, it } from 'vitest'
import { normalizeRollupAggregation, normalizeRollupFilters, resolveRollupFieldProperty, rollupResultType } from '../src/multitable/utils/field-config'
import { aggregationLabel } from '../src/multitable/utils/meta-manager-labels'
import { FILTER_OPERATORS_BY_TYPE, effectiveFilterTypeKey } from '../src/multitable/composables/useMultitableGrid'

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

  // The backend parser accepts filters/conditions/filterConditions + filterConjunction/conjunction
  // (case-insensitive). The FE resolver must match, or an alias-authored rollup loses its filter — or
  // flips OR→AND — when the field manager re-saves in its canonical shape.
  it('preserves the filterConditions alias (backend parity)', () => {
    const p = resolveRollupFieldProperty({
      linkFieldId: 'l', targetFieldId: 't', aggregation: 'count',
      filterConditions: [{ fieldId: 'f', operator: 'is', value: 'x' }],
    })
    expect(p.filters).toEqual([{ fieldId: 'f', operator: 'is', value: 'x' }])
  })

  it('honors the conjunction alias and is case-insensitive (uppercase OR is not demoted to and)', () => {
    const viaAlias = resolveRollupFieldProperty({
      linkFieldId: 'l', targetFieldId: 't', aggregation: 'count',
      filters: [{ fieldId: 'f', operator: 'is', value: 'x' }], conjunction: 'or',
    })
    expect(viaAlias.filterConjunction).toBe('or')
    const upper = resolveRollupFieldProperty({
      linkFieldId: 'l', targetFieldId: 't', aggregation: 'count',
      filters: [{ fieldId: 'f', operator: 'is', value: 'x' }], filterConjunction: 'OR',
    })
    expect(upper.filterConjunction).toBe('or')
  })
})

// Slice 2b — string/boolean reducers on the FE: enum/alias parity, result-type, labels, and the
// operator map keyed by a rollup's result kind (so a concatenate rollup offers text ops, an and/or/xor
// rollup equality-only) — matching the backend resolveEffectiveFieldType.
describe('rollup string/boolean reducers (slice 2b) — FE', () => {
  it('normalizeRollupAggregation preserves concatenate/and/or/xor + concat alias', () => {
    for (const a of ['concatenate', 'and', 'or', 'xor'] as const) {
      expect(normalizeRollupAggregation(a)).toBe(a)
    }
    expect(normalizeRollupAggregation('concat')).toBe('concatenate')
  })

  it('rollupResultType: concatenate→string, and/or/xor→boolean, numeric→number', () => {
    expect(rollupResultType('concatenate')).toBe('string')
    expect(rollupResultType('and')).toBe('boolean')
    expect(rollupResultType('or')).toBe('boolean')
    expect(rollupResultType('xor')).toBe('boolean')
    expect(rollupResultType('sum')).toBe('number')
    expect(rollupResultType('countall')).toBe('number')
  })

  it('aggregationLabel covers the 4 new reducers (zh + en)', () => {
    expect(aggregationLabel('concatenate', true)).toBe('拼接')
    expect(aggregationLabel('concatenate', false)).toBe('Concatenate')
    expect(aggregationLabel('and', false)).toBe('All true (AND)')
    expect(aggregationLabel('xor', true)).toBe('奇数为真')
  })

  it('effectiveFilterTypeKey resolves a rollup field by its aggregation result kind', () => {
    const mk = (aggregation: string) => ({ type: 'rollup', property: { linkFieldId: 'l', targetFieldId: 't', aggregation } })
    expect(effectiveFilterTypeKey(mk('concatenate'))).toBe('string')
    expect(effectiveFilterTypeKey(mk('and'))).toBe('boolean')
    expect(effectiveFilterTypeKey(mk('sum'))).toBe('number')
    expect(effectiveFilterTypeKey({ type: 'string' })).toBe('string')
  })

  it('operator map: concatenate rollup offers TEXT ops; and/or/xor rollup offers equality only', () => {
    const concatKey = effectiveFilterTypeKey({ type: 'rollup', property: { linkFieldId: 'l', targetFieldId: 't', aggregation: 'concatenate' } })
    const concatOps = (FILTER_OPERATORS_BY_TYPE[concatKey] ?? []).map((o) => o.value)
    expect(concatOps).toContain('contains')

    const boolKey = effectiveFilterTypeKey({ type: 'rollup', property: { linkFieldId: 'l', targetFieldId: 't', aggregation: 'and' } })
    const boolOps = (FILTER_OPERATORS_BY_TYPE[boolKey] ?? []).map((o) => o.value)
    expect(boolOps).toContain('is')
    expect(boolOps).not.toContain('greater')
  })
})

// Slice 3b — rollup filter builder: normalization + round-trip. The builder edits string-valued rows;
// these lock the field-config side (typed normalize + resolver round-trip) the field manager relies on.
describe('rollup filter conditions — builder normalization + round-trip (slice 3b)', () => {
  it('normalizeRollupFilters keeps well-formed, drops malformed, preserves value presence', () => {
    expect(normalizeRollupFilters([
      { fieldId: 'f1', operator: 'is', value: 'x' },
      { fieldId: ' f2 ', operator: 'isEmpty' },   // trimmed; no value key
      { fieldId: '', operator: 'is' },             // dropped — no fieldId
      { fieldId: 'f3', operator: '' },             // dropped — no operator
      { fieldId: '   ', operator: 'is', value: 1 },// dropped — whitespace fieldId
      'nope', null, 42,                            // dropped — non-object
    ])).toEqual([
      { fieldId: 'f1', operator: 'is', value: 'x' },
      { fieldId: 'f2', operator: 'isEmpty' },
    ])
    expect(normalizeRollupFilters(undefined)).toEqual([])
    expect(normalizeRollupFilters('x')).toEqual([])
  })

  it('resolveRollupFieldProperty round-trips typed filters + conjunction (filters alias, case-insensitive OR)', () => {
    const p = resolveRollupFieldProperty({
      linkFieldId: 'l', targetFieldId: 't', aggregation: 'sum',
      filters: [{ fieldId: 'f', operator: 'greater', value: 5 }], filterConjunction: 'OR',
    })
    expect(p.filters).toEqual([{ fieldId: 'f', operator: 'greater', value: 5 }])
    expect(p.filterConjunction).toBe('or')
  })

  it('resolveRollupFieldProperty honors the filterConditions + conjunction aliases (backend parity)', () => {
    const p = resolveRollupFieldProperty({
      linkFieldId: 'l', targetFieldId: 't', aggregation: 'count',
      filterConditions: [{ fieldId: 'f', operator: 'is', value: 'a' }], conjunction: 'and',
    })
    expect(p.filters).toEqual([{ fieldId: 'f', operator: 'is', value: 'a' }])
    expect(p.filterConjunction).toBe('and')
  })

  it('no filters → filters/filterConjunction absent (unfiltered rollup property unchanged)', () => {
    const p = resolveRollupFieldProperty({ linkFieldId: 'l', targetFieldId: 't', aggregation: 'count' })
    expect(p.filters).toBeUndefined()
    expect(p.filterConjunction).toBeUndefined()
  })
})
