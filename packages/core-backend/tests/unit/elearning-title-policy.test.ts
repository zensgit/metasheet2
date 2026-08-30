import { describe, expect, it } from 'vitest'
import {
  ElearningTitlePolicyError,
  normalizeElearningTitleThresholdSnapshot,
  resolveElearningTitle,
} from '../../src/services/elearning-title-policy'

const SENTINEL_ID = 'title-senior-architect'
const SENTINEL_NAME = 'Senior Architect'

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningTitlePolicyError)
    const policyError = error as ElearningTitlePolicyError
    expect(policyError.name).toBe('ElearningTitlePolicyError')
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    const surface = `${policyError.message}\n${policyError.stack ?? ''}\n${String(policyError.cause ?? '')}`
    expect(surface).not.toContain(SENTINEL_ID)
    expect(surface).not.toContain(SENTINEL_NAME)
    expect(surface).not.toContain('9001')
  }
}

const baseRows = () => [
  { id: 'title-architect', name: 'Architect', threshold: 500 },
  { id: 'title-novice', name: 'Novice', threshold: 0 },
  { id: SENTINEL_ID, name: SENTINEL_NAME, threshold: 9001 },
]

describe('elearning title policy', () => {
  it('canonicalizes unsorted input into a frozen threshold-ascending snapshot', () => {
    const snapshot = normalizeElearningTitleThresholdSnapshot(baseRows())
    expect(snapshot).toEqual([
      { id: 'title-novice', name: 'Novice', threshold: 0 },
      { id: 'title-architect', name: 'Architect', threshold: 500 },
      { id: SENTINEL_ID, name: SENTINEL_NAME, threshold: 9001 },
    ])
    expect(Object.isFrozen(snapshot)).toBe(true)
    for (const row of snapshot) {
      expect(Object.isFrozen(row)).toBe(true)
      expect(Object.keys(row)).toEqual(['id', 'name', 'threshold'])
    }
  })

  it('trims id and name while keeping threshold exact', () => {
    const snapshot = normalizeElearningTitleThresholdSnapshot([
      { id: '  title-a  ', name: '\tLevel A\n', threshold: 10 },
    ])
    expect(snapshot).toEqual([{ id: 'title-a', name: 'Level A', threshold: 10 }])
  })

  it('is unaffected by later mutation of the caller input', () => {
    const rows = baseRows()
    const snapshot = normalizeElearningTitleThresholdSnapshot(rows)
    rows[0].id = 'mutated-id'
    rows[0].threshold = 1
    rows.push({ id: 'title-injected', name: 'Injected', threshold: 2 })
    expect(snapshot).toEqual([
      { id: 'title-novice', name: 'Novice', threshold: 0 },
      { id: 'title-architect', name: 'Architect', threshold: 500 },
      { id: SENTINEL_ID, name: SENTINEL_NAME, threshold: 9001 },
    ])
    expect(snapshot).toHaveLength(3)
  })

  it('treats an empty snapshot as no configured titles and rejects non-arrays', () => {
    const empty = normalizeElearningTitleThresholdSnapshot([])
    expect(empty).toEqual([])
    expect(Object.isFrozen(empty)).toBe(true)
    expect(resolveElearningTitle(empty, 0)).toBeNull()
    expectCode(() => normalizeElearningTitleThresholdSnapshot(null), 'invalid_snapshot')
    expectCode(() => normalizeElearningTitleThresholdSnapshot({}), 'invalid_snapshot')
    expectCode(() => normalizeElearningTitleThresholdSnapshot('rows'), 'invalid_snapshot')
  })

  it('rejects unknown own enumerable keys and missing keys fail-closed', () => {
    const symbolKey = Symbol('drift')
    expectCode(() => normalizeElearningTitleThresholdSnapshot([
      { id: 'title-a', name: 'A', threshold: 0, extra: 'drift' },
    ]), 'invalid_row')
    expectCode(() => normalizeElearningTitleThresholdSnapshot([
      { id: 'title-a', name: 'A', threshold: 0, [symbolKey]: 'drift' },
    ]), 'invalid_row')
    expectCode(() => normalizeElearningTitleThresholdSnapshot([
      { id: 'title-a', name: 'A' },
    ]), 'invalid_row')
    expectCode(() => normalizeElearningTitleThresholdSnapshot([
      null,
    ]), 'invalid_row')
    expectCode(() => normalizeElearningTitleThresholdSnapshot([
      ['title-a', 'A', 0],
    ]), 'invalid_row')
  })

  it('rejects duplicate normalized ids and duplicate thresholds', () => {
    expectCode(() => normalizeElearningTitleThresholdSnapshot([
      { id: 'title-a', name: 'A', threshold: 0 },
      { id: ' title-a ', name: 'B', threshold: 100 },
    ]), 'duplicate_id')
    expectCode(() => normalizeElearningTitleThresholdSnapshot([
      { id: 'title-a', name: 'A', threshold: 100 },
      { id: 'title-b', name: 'B', threshold: 100 },
    ]), 'duplicate_threshold')
  })

  it('rejects unsafe, non-integer, and negative thresholds', () => {
    for (const threshold of [Number.MAX_SAFE_INTEGER + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -1, '100']) {
      expectCode(() => normalizeElearningTitleThresholdSnapshot([
        { id: 'title-a', name: 'A', threshold },
      ]), 'invalid_row')
    }
  })

  it('rejects blank, overlong, NUL, and malformed-surrogate text', () => {
    const overlong = 'x'.repeat(513)
    for (const bad of ['', '   ', overlong, 'a\0b', '\ud800', '\ud800x', '\udc00', 42]) {
      expectCode(() => normalizeElearningTitleThresholdSnapshot([
        { id: bad, name: 'A', threshold: 0 },
      ]), 'invalid_row')
      expectCode(() => normalizeElearningTitleThresholdSnapshot([
        { id: 'title-a', name: bad, threshold: 0 },
      ]), 'invalid_row')
    }
    expect(normalizeElearningTitleThresholdSnapshot([
      { id: 'title-a', name: 'x'.repeat(512), threshold: 0 },
    ])[0].name).toHaveLength(512)
    expect(normalizeElearningTitleThresholdSnapshot([
      { id: 'title-emoji', name: 'Rocket \ud83d\ude80', threshold: 0 },
    ])[0].name).toBe('Rocket \ud83d\ude80')
  })

  it('resolves the highest threshold at or below the balance', () => {
    const snapshot = normalizeElearningTitleThresholdSnapshot(baseRows())

    // Exact boundary: balance equal to a threshold selects that row (fails if <= becomes <).
    expect(resolveElearningTitle(snapshot, 9001)).toEqual({
      id: SENTINEL_ID, name: SENTINEL_NAME, threshold: 9001,
    })
    expect(resolveElearningTitle(snapshot, 500)).toEqual({
      id: 'title-architect', name: 'Architect', threshold: 500,
    })
    expect(resolveElearningTitle(snapshot, 0)).toEqual({
      id: 'title-novice', name: 'Novice', threshold: 0,
    })

    // Highest-match: between thresholds selects the higher-threshold row below the balance
    // (fails if selection becomes lowest-match).
    expect(resolveElearningTitle(snapshot, 9000)).toEqual({
      id: 'title-architect', name: 'Architect', threshold: 500,
    })
    expect(resolveElearningTitle(snapshot, 9002)).toEqual({
      id: SENTINEL_ID, name: SENTINEL_NAME, threshold: 9001,
    })
    expect(resolveElearningTitle(snapshot, 499)).toEqual({
      id: 'title-novice', name: 'Novice', threshold: 0,
    })
  })

  it('returns null below the first threshold, including negative balances', () => {
    const snapshot = normalizeElearningTitleThresholdSnapshot([
      { id: 'title-a', name: 'A', threshold: 10 },
    ])
    expect(resolveElearningTitle(snapshot, 9)).toBeNull()
    expect(resolveElearningTitle(snapshot, 0)).toBeNull()
    expect(resolveElearningTitle(snapshot, -1)).toBeNull()

    const zeroBased = normalizeElearningTitleThresholdSnapshot(baseRows())
    expect(resolveElearningTitle(zeroBased, -1)).toBeNull()
    expect(resolveElearningTitle(zeroBased, Number.MIN_SAFE_INTEGER)).toBeNull()
    expect(resolveElearningTitle(zeroBased, Number.MAX_SAFE_INTEGER)).toEqual({
      id: SENTINEL_ID, name: SENTINEL_NAME, threshold: 9001,
    })
  })

  it('rejects a balance that is not a safe integer', () => {
    const snapshot = normalizeElearningTitleThresholdSnapshot(baseRows())
    for (const balance of [
      Number.MAX_SAFE_INTEGER + 1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '500',
      null,
      undefined,
    ]) {
      expectCode(() => resolveElearningTitle(snapshot, balance), 'invalid_balance')
    }
  })

  it('returns a newly allocated closed DTO that never leaks input extras', () => {
    const snapshot = normalizeElearningTitleThresholdSnapshot(baseRows())
    const dto = resolveElearningTitle(snapshot, 9001)
    expect(dto).toEqual({ id: SENTINEL_ID, name: SENTINEL_NAME, threshold: 9001 })
    expect(Object.keys(dto ?? {})).toEqual(['id', 'name', 'threshold'])
    expect(dto).not.toBe(snapshot[2])
    expect(resolveElearningTitle(snapshot, 9001)).not.toBe(dto)
  })

  it('keeps throwables values-free across the cause chain', () => {
    const throwingRow = Object.defineProperty({
      id: SENTINEL_ID,
      threshold: 9001,
    }, 'name', {
      enumerable: true,
      get(): never {
        throw new Error(SENTINEL_NAME)
      },
    })
    expectCode(() => normalizeElearningTitleThresholdSnapshot([
      { id: SENTINEL_ID, name: SENTINEL_NAME, threshold: 9001, extra: 'drift' },
    ]), 'invalid_row')
    expectCode(() => normalizeElearningTitleThresholdSnapshot([
      throwingRow,
    ]), 'invalid_row')
    expectCode(() => normalizeElearningTitleThresholdSnapshot([
      { id: SENTINEL_ID, name: 'A', threshold: 0 },
      { id: `${SENTINEL_ID} `, name: 'B', threshold: 1 },
    ]), 'duplicate_id')
    expectCode(() => resolveElearningTitle(
      normalizeElearningTitleThresholdSnapshot(baseRows()),
      9001.5,
    ), 'invalid_balance')
  })
})
