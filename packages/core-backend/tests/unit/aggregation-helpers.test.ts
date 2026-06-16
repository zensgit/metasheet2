/**
 * Unit tests for the pure footer aggregation helpers (no DB).
 * Focus: groupRowsByField partition/ordering/null-key contract (#4-3b-2a) + aggregateField basics.
 */
import { describe, expect, it } from 'vitest'

import { aggregateField, groupRowsByField, groupRowsByFields, isNumericFieldType, type AggregateGroupBucket } from '../../src/multitable/aggregation-helpers'

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
  it('duration sum/avg aggregate over raw seconds (scatter guard — v1 shows seconds)', () => {
    // 1h(3600) + 30m(1800) + 10m(600) = 6000s total; avg 2000s.
    expect(aggregateField([3600, 1800, 600], 'sum', 'duration')).toBe(6000)
    expect(aggregateField([3600, 1800, 600], 'avg', 'duration')).toBe(2000)
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

describe('groupRowsByFields (nested / multi-level grouping)', () => {
  // region (level 1) → city (level 2). Designed so a NAIVE child-rollup of avg/countDistinct DIFFERS
  // from the correct per-level value (locks the non-roll-up-able trap).
  const rows = [
    { region: 'East', city: 'NYC', amt: 10, tag: 'x' },
    { region: 'East', city: 'NYC', amt: 30, tag: 'x' }, // NYC child: avg=20, distinct tag {x}=1
    { region: 'East', city: 'BOS', amt: 50, tag: 'y' }, // BOS child: avg=50, distinct tag {y}=1
    { region: 'West', city: 'LA', amt: 5, tag: 'z' },
  ]

  it('single fieldId equals groupRowsByField (back-compat wrapper) and has NO children', () => {
    const viaSingle = groupRowsByField(rows, 'region')
    const viaList = groupRowsByFields(rows, ['region'])
    expect(viaList.map((b) => b.key)).toEqual(viaSingle.map((b) => b.key))
    expect(viaList.map((b) => b.rows.length)).toEqual(viaSingle.map((b) => b.rows.length))
    expect(viaList.every((b) => b.children === undefined)).toBe(true)
  })

  it('empty fieldIds → no grouping ([])', () => {
    expect(groupRowsByFields(rows, [])).toEqual([])
  })

  it('builds a 2-level tree; Σ leaf-counts === total AND Σ children-counts === parent-count at each level', () => {
    const tree = groupRowsByFields(rows, ['region', 'city'])
    // level 1 partitions the whole set
    expect(tree.reduce((s, b) => s + b.rows.length, 0)).toBe(rows.length)
    expect(tree.map((b) => b.key)).toEqual(['East', 'West']) // numeric-aware string order
    for (const node of tree) {
      expect(node.children).toBeDefined()
      // partition invariant at EVERY level: a parent's rows === Σ its children's rows
      const childSum = node.children!.reduce((s, c) => s + c.rows.length, 0)
      expect(childSum).toBe(node.rows.length)
    }
    const east = tree.find((b) => b.key === 'East')!
    expect(east.rows.length).toBe(3)
    expect(east.children!.map((c) => c.key)).toEqual(['BOS', 'NYC'])
    expect(east.children!.find((c) => c.key === 'NYC')!.rows.length).toBe(2)
  })

  it('empty/null key forms ONE group per level, ordered LAST', () => {
    const tree = groupRowsByFields(
      [
        { a: 'P', b: 'Q' },
        { a: 'P', b: '' }, // empty level-2 → null key, last among P's children
        { a: '', b: 'Q' }, // empty level-1 → null key, last at level 1
      ],
      ['a', 'b'],
    )
    expect(tree.map((b) => b.key)).toEqual(['P', null]) // null-key group LAST at level 1
    const p = tree.find((b) => b.key === 'P')!
    expect(p.children!.map((c) => c.key)).toEqual(['Q', null]) // null-key LAST at level 2 too
  })

  it('complex (array/object) values group by their JSON form per level', () => {
    const tree = groupRowsByFields(
      [
        { sel: ['a'], x: 1 },
        { sel: ['a'], x: 2 },
        { sel: ['b'], x: 3 },
      ],
      ['sel'],
    )
    expect(tree.map((b) => b.key)).toEqual(['["a"]', '["b"]']) // JSON-string keys, distinct
    expect(tree.find((b) => b.key === '["a"]')!.rows.length).toBe(2)
  })

  it('per-level aggregation is INDEPENDENT — avg/countDistinct over node.rows, NOT a child roll-up', () => {
    const tree = groupRowsByFields(rows, ['region', 'city'])
    const east = tree.find((b) => b.key === 'East')!
    // Correct per-level avg over East's full membership (10,30,50) = 30.
    const correctAvg = aggregateField(east.rows.map((r) => r.amt), 'avg', 'number')
    expect(correctAvg).toBe(30)
    // NAIVE child-rollup (unweighted mean of child avgs: NYC=20, BOS=50) = 35 ≠ 30 → proves you can't
    // average the children. The helper aggregates node.rows directly, so it yields 30, not 35.
    const childAvgs = east.children!.map((c) => aggregateField(c.rows.map((r) => r.amt), 'avg', 'number')!)
    const naiveRollup = childAvgs.reduce((a, b) => a + b, 0) / childAvgs.length
    expect(naiveRollup).toBe(35)
    expect(correctAvg).not.toBe(naiveRollup)
    // countDistinct over node.rows: East tags {x,y} = 2. Naive SUM of child distinct counts (NYC {x}=1,
    // BOS {y}=1) = 2 here by coincidence — so use a case where child sets OVERLAP to prove the gap:
    const overlap = groupRowsByFields(
      [
        { g: 'A', sub: '1', t: 'shared' },
        { g: 'A', sub: '2', t: 'shared' }, // same tag across two sub-buckets
        { g: 'A', sub: '2', t: 'other' },
      ],
      ['g', 'sub'],
    )
    const a = overlap.find((b) => b.key === 'A')!
    const correctDistinct = aggregateField(a.rows.map((r) => r.t), 'countDistinct', 'string') // {shared, other} = 2
    expect(correctDistinct).toBe(2)
    const naiveDistinctSum = a.children!
      .map((c) => aggregateField(c.rows.map((r) => r.t), 'countDistinct', 'string')!) // sub1 {shared}=1, sub2 {shared,other}=2
      .reduce((x, y) => x + y, 0) // = 3 (double-counts 'shared')
    expect(naiveDistinctSum).toBe(3)
    expect(correctDistinct).not.toBe(naiveDistinctSum) // 2 ≠ 3 → MUST recompute per level, never sum children
  })

  it('caps deeper levels correctly: a 3-level grouping nests children twice', () => {
    const tree: AggregateGroupBucket[] = groupRowsByFields(rows, ['region', 'city', 'tag'])
    const east = tree.find((b) => b.key === 'East')!
    const nyc = east.children!.find((c) => c.key === 'NYC')!
    expect(nyc.children).toBeDefined() // level-3 present
    expect(nyc.children!.map((c) => c.key)).toEqual(['x']) // both NYC rows tag 'x'
    expect(nyc.children![0].children).toBeUndefined() // no 4th level
  })
})

describe('button field — aggregation exclusion (B1-a0)', () => {
  it('isNumericFieldType excludes button (value-less → never aggregated)', () => {
    expect(isNumericFieldType('button')).toBe(false)
    // sanity: the numeric allowlist still includes the real numeric types
    expect(isNumericFieldType('number')).toBe(true)
    expect(isNumericFieldType('currency')).toBe(true)
    // duration is seconds-backed → numeric (scatter guard for aggregation-helpers set)
    expect(isNumericFieldType('duration')).toBe(true)
  })
})
