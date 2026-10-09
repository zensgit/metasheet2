import { describe, expect, it } from 'vitest'
import { parseFrozenTopRowCount, MAX_FROZEN_TOP_ROWS } from '../src/multitable/utils/frozen-rows'

describe('parseFrozenTopRowCount (narrow helper — dirty config never reaches offset math)', () => {
  it('passes a valid integer in range', () => {
    expect(parseFrozenTopRowCount({ frozenTopRowCount: 0 })).toBe(0)
    expect(parseFrozenTopRowCount({ frozenTopRowCount: 3 })).toBe(3)
    expect(parseFrozenTopRowCount({ frozenTopRowCount: MAX_FROZEN_TOP_ROWS })).toBe(MAX_FROZEN_TOP_ROWS)
  })
  it('→ 0 for missing field', () => {
    expect(parseFrozenTopRowCount({})).toBe(0)
    expect(parseFrozenTopRowCount({ other: 1 })).toBe(0)
  })
  it('→ 0 for null / undefined config', () => {
    expect(parseFrozenTopRowCount(null)).toBe(0)
    expect(parseFrozenTopRowCount(undefined)).toBe(0)
  })
  it('→ 0 for a negative count', () => {
    expect(parseFrozenTopRowCount({ frozenTopRowCount: -1 })).toBe(0)
  })
  // Mutation-relevant: the cap is a real product boundary (owner-set MAX_FROZEN_TOP_ROWS = 10), not
  // decorative — a config value over the cap must be treated as invalid (0), not clamped down to the
  // cap, so a corrupted/attacker-supplied huge value can never partially "work".
  it('→ 0 for a count over MAX_FROZEN_TOP_ROWS (not clamped — rejected)', () => {
    expect(parseFrozenTopRowCount({ frozenTopRowCount: MAX_FROZEN_TOP_ROWS + 1 })).toBe(0)
    expect(parseFrozenTopRowCount({ frozenTopRowCount: 50 })).toBe(0)
  })
  it('→ 0 for a non-integer / non-number value', () => {
    expect(parseFrozenTopRowCount({ frozenTopRowCount: 2.5 })).toBe(0)
    expect(parseFrozenTopRowCount({ frozenTopRowCount: '2' })).toBe(0)
    expect(parseFrozenTopRowCount({ frozenTopRowCount: NaN })).toBe(0)
    expect(parseFrozenTopRowCount({ frozenTopRowCount: null })).toBe(0)
  })
})
