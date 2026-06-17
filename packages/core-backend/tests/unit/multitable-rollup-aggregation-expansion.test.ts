/**
 * Rollup aggregation expansion slice 2a (numeric reducers only) — pure-reducer unit tests.
 *
 * Locks the exported pure fn `aggregateRollup(values, count, aggregation)`. Every reducer returns
 * number|null (the string/boolean reducers concatenate/and/or/xor are deferred to slice 2b):
 *   - count       -> values.length (non-null target values, ≡ COUNTA)
 *   - countall    -> the `count` arg (resolved linked records incl. empty target — INDEPENDENT of
 *                    values.length)
 *   - unique      -> distinct count (primitives by identity; 1 vs "1" distinct; objects keyed by
 *                    JSON.stringify so structurally-equal duplicates collapse; null stays null)
 *   - sum/avg/min/max -> over numeric values (toComparableNumber); null when no numeric values;
 *                        numeric-string coercion; non-numerics filtered out
 *
 * `aggregateRollup` is the masked-safe caller's reducer: the route passes null instead of calling it
 * when the foreign sheet/field is masked, so these tests exercise the un-masked numeric/value paths.
 */
import { describe, test, expect } from 'vitest'
import { aggregateRollup } from '../../src/routes/univer-meta'

describe('aggregateRollup — rollup reducer expansion', () => {
  describe('count (≡ COUNTA: non-blank target values)', () => {
    test('counts present, non-blank values', () => {
      expect(aggregateRollup([1, 2, 3], 3, 'count')).toBe(3)
      expect(aggregateRollup(['a', 'b'], 5, 'count')).toBe(2)
    })
    test('drops blank targets — null/undefined/""/"   "/[] — THIS is the count-vs-countall boundary', () => {
      expect(aggregateRollup(['x', '', '   ', [], 'y'], 5, 'count')).toBe(2) // only 'x','y'
      expect(aggregateRollup([null, undefined, ''], 3, 'count')).toBe(0)
      // countall over the SAME data counts every resolved row — the distinction the reviewer flagged:
      expect(aggregateRollup(['x', '', '   ', [], 'y'], 5, 'countall')).toBe(5)
    })
    test('keeps falsy-but-present scalars 0 and false (NOT blank)', () => {
      expect(aggregateRollup([0, false, 1], 3, 'count')).toBe(3)
    })
    test('empty values -> 0 (independent of count arg)', () => {
      expect(aggregateRollup([], 0, 'count')).toBe(0)
      expect(aggregateRollup([], 4, 'count')).toBe(0)
    })
  })

  describe('countall (resolved linked records incl. empty target)', () => {
    test('uses the count arg, INDEPENDENT of values.length', () => {
      // 3 records resolved, only 1 had a non-empty target value.
      expect(aggregateRollup([1], 3, 'countall')).toBe(3)
      expect(aggregateRollup([1], 1, 'count')).toBe(1) // sibling count over the same data
    })
    test('empty values still reports the resolved-record count', () => {
      expect(aggregateRollup([], 4, 'countall')).toBe(4)
      expect(aggregateRollup([], 0, 'countall')).toBe(0)
    })
    test('more values than count is still driven purely by count', () => {
      expect(aggregateRollup([1, 2, 3, 4], 2, 'countall')).toBe(2)
    })
  })

  describe('unique (distinct count)', () => {
    test('distinct primitives', () => {
      expect(aggregateRollup([1, 1, 2, 3, 3, 3], 6, 'unique')).toBe(3)
      expect(aggregateRollup(['a', 'b', 'a'], 3, 'unique')).toBe(2)
    })
    test('1 (number) and "1" (string) are distinct', () => {
      expect(aggregateRollup([1, '1'], 2, 'unique')).toBe(2)
    })
    test('structurally-equal objects collapse via JSON.stringify', () => {
      expect(aggregateRollup([{ a: 1 }, { a: 1 }, { a: 2 }], 3, 'unique')).toBe(2)
    })
    test('blank values (null / "" / "   " / []) are excluded, consistent with count', () => {
      expect(aggregateRollup([null, null], 2, 'unique')).toBe(0)
      expect(aggregateRollup([null, 1, null], 3, 'unique')).toBe(1) // just {1}
      expect(aggregateRollup(['', '   ', 'a', 'a'], 4, 'unique')).toBe(1) // just {a}
    })
    test('empty values -> 0', () => {
      expect(aggregateRollup([], 0, 'unique')).toBe(0)
    })
  })

  describe('sum (numeric)', () => {
    test('sums numeric values', () => {
      expect(aggregateRollup([1, 2, 3], 3, 'sum')).toBe(6)
    })
    test('coerces numeric strings', () => {
      expect(aggregateRollup(['1', '2', 3], 3, 'sum')).toBe(6)
    })
    test('mixed string+number filters non-numeric strings', () => {
      expect(aggregateRollup([1, 'x', 2, 'nope', 3], 5, 'sum')).toBe(6)
    })
    test('null when no numeric values', () => {
      expect(aggregateRollup(['x', 'y'], 2, 'sum')).toBeNull()
      expect(aggregateRollup([], 0, 'sum')).toBeNull()
    })
  })

  describe('avg (numeric)', () => {
    test('averages numeric values (divides by numeric count only)', () => {
      expect(aggregateRollup([2, 4, 6], 3, 'avg')).toBe(4)
      expect(aggregateRollup([1, 'x', 3], 3, 'avg')).toBe(2) // mean of [1,3], non-numeric excluded
    })
    test('null when no numeric values', () => {
      expect(aggregateRollup(['a'], 1, 'avg')).toBeNull()
      expect(aggregateRollup([], 0, 'avg')).toBeNull()
    })
  })

  describe('min / max (numeric)', () => {
    test('min returns the smallest numeric value', () => {
      expect(aggregateRollup([3, 1, 2], 3, 'min')).toBe(1)
      expect(aggregateRollup([5, 'x', '2'], 3, 'min')).toBe(2) // numeric-string coercion
    })
    test('max returns the largest numeric value', () => {
      expect(aggregateRollup([3, 1, 2], 3, 'max')).toBe(3)
      expect(aggregateRollup([5, 'x', '20'], 3, 'max')).toBe(20)
    })
    test('null when no numeric values', () => {
      expect(aggregateRollup(['x'], 1, 'min')).toBeNull()
      expect(aggregateRollup(['x'], 1, 'max')).toBeNull()
      expect(aggregateRollup([], 0, 'min')).toBeNull()
      expect(aggregateRollup([], 0, 'max')).toBeNull()
    })
  })
})
