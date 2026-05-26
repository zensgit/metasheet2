import { describe, expect, it } from 'vitest'
import { parseFrozenIds, frozenPrefixCount } from '../src/multitable/utils/frozen-columns'

describe('parseFrozenIds (narrow helper — dirty config never reaches offset math)', () => {
  it('passes a valid string[]', () => {
    expect(parseFrozenIds({ frozenLeftColumnIds: ['a', 'b'] })).toEqual(['a', 'b'])
  })
  it('→ [] for missing field', () => {
    expect(parseFrozenIds({})).toEqual([])
    expect(parseFrozenIds({ other: 1 })).toEqual([])
  })
  it('→ [] for non-array', () => {
    expect(parseFrozenIds({ frozenLeftColumnIds: 'a' })).toEqual([])
    expect(parseFrozenIds({ frozenLeftColumnIds: 3 })).toEqual([])
    expect(parseFrozenIds({ frozenLeftColumnIds: { 0: 'a' } })).toEqual([])
  })
  it('→ [] for array with any non-string element (strict)', () => {
    expect(parseFrozenIds({ frozenLeftColumnIds: ['a', 2] })).toEqual([])
    expect(parseFrozenIds({ frozenLeftColumnIds: [null] })).toEqual([])
    expect(parseFrozenIds({ frozenLeftColumnIds: ['a', { x: 1 }] })).toEqual([])
  })
  it('→ [] for null / undefined config', () => {
    expect(parseFrozenIds(null)).toEqual([])
    expect(parseFrozenIds(undefined)).toEqual([])
  })
  it('→ [] for empty array (no frozen)', () => {
    expect(parseFrozenIds({ frozenLeftColumnIds: [] })).toEqual([])
  })
})

describe('frozenPrefixCount (reorder-robust left-prefix)', () => {
  const order = ['f1', 'f2', 'f3', 'f4']
  it('counts a contiguous left prefix', () => {
    expect(frozenPrefixCount(order, ['f1', 'f2'])).toBe(2)
    expect(frozenPrefixCount(order, ['f1'])).toBe(1)
    expect(frozenPrefixCount(order, [])).toBe(0)
  })
  it('ignores non-prefix frozen ids (after reorder)', () => {
    // f3 frozen but f1/f2 not → no contiguous left prefix
    expect(frozenPrefixCount(order, ['f3'])).toBe(0)
    // f1 + f3 frozen but f2 breaks contiguity → only f1
    expect(frozenPrefixCount(order, ['f1', 'f3'])).toBe(1)
  })
  it('clamps to all columns', () => {
    expect(frozenPrefixCount(order, ['f1', 'f2', 'f3', 'f4', 'gone'])).toBe(4)
  })
})
