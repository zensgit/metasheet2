/**
 * Unit tests for the pure footer aggregation helpers (no DB).
 * Focus: groupRowsByField partition/ordering/null-key contract (#4-3b-2a) + aggregateField basics.
 */
import { describe, expect, it } from 'vitest'

import { aggregateField, groupRowsByField, isNumericFieldType } from '../../src/multitable/aggregation-helpers'

describe('aggregateField (locked fns)', () => {
  it('sum/avg/min/max over numeric, skipping non-numeric', () => {
    const vals = [1, 2, '3', 'x', null]
    expect(aggregateField(vals, 'sum', 'number')).toBe(6)
    expect(aggregateField(vals, 'avg', 'number')).toBe(2)
    expect(aggregateField(vals, 'min', 'number')).toBe(1)
    expect(aggregateField(vals, 'max', 'number')).toBe(3)
  })
  it('sum on a non-numeric field type is not applicable → null (caller omits)', () => {
    expect(aggregateField(['a', 'b'], 'sum', 'string')).toBeNull()
  })
  it('countNonEmpty treats null/undefined/""/[] as empty', () => {
    expect(aggregateField(['x', '', null, undefined, [], 'y'], 'countNonEmpty', 'string')).toBe(2)
  })
})

describe('groupRowsByField (#4-3b-2a)', () => {
  const rows = [
    { cat: 'A', qty: 1 },
    { cat: 'B', qty: 2 },
    { cat: 'A', qty: 3 },
    { cat: '', qty: 4 }, // empty → null-key group
    { cat: null, qty: 5 }, // also empty → same null-key group
  ]

  it('partitions all rows (Σ buckets === input length)', () => {
    const buckets = groupRowsByField(rows, 'cat')
    expect(buckets.reduce((s, b) => s + b.rows.length, 0)).toBe(rows.length)
  })

  it('empty/null values collapse into a single key:null group, ordered LAST', () => {
    const buckets = groupRowsByField(rows, 'cat')
    expect(buckets.map((b) => b.key)).toEqual(['A', 'B', null]) // non-null first (sorted), null last
    const nullBucket = buckets.find((b) => b.key === null)!
    expect(nullBucket.rows.length).toBe(2) // '' and null
  })

  it('numeric-aware key ordering (2 before 10)', () => {
    const buckets = groupRowsByField(
      [{ g: 10 }, { g: 2 }, { g: 1 }],
      'g',
    )
    expect(buckets.map((b) => b.key)).toEqual([1, 2, 10])
  })

  it('a primitive value and its JSON form do not collide', () => {
    const buckets = groupRowsByField([{ g: 1 }, { g: '1' }], 'g')
    expect(buckets.length).toBe(2) // number 1 and string "1" are distinct groups
  })
})

describe('button field — aggregation exclusion (B1-a0)', () => {
  it('isNumericFieldType excludes button (value-less → never aggregated)', () => {
    expect(isNumericFieldType('button')).toBe(false)
    // sanity: the numeric allowlist still includes the real numeric types
    expect(isNumericFieldType('number')).toBe(true)
    expect(isNumericFieldType('currency')).toBe(true)
  })
})
