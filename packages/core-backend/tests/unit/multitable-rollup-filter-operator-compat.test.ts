/**
 * Rollup filter operator/type compatibility (slice 3 hardening).
 *
 * evaluateMetaFilterCondition's per-type catch-all returns `true` (match-all) for an operator that
 * doesn't fit the field type — e.g. a number field with `contains`, a boolean field with `greater`.
 * Saving such a condition would silently aggregate ALL linked rows. isRollupFilterOperatorCompatible is
 * the save-time gate that rejects those; this locks it per type so the validator stays in lockstep with
 * the evaluator's branches.
 */
import { describe, test, expect } from 'vitest'
import { isRollupFilterOperatorCompatible } from '../../src/routes/univer-meta'

describe('isRollupFilterOperatorCompatible', () => {
  test('numeric/date: comparison operators allowed, text operators rejected', () => {
    for (const t of ['number', 'currency', 'percent', 'rating', 'duration', 'date']) {
      expect(isRollupFilterOperatorCompatible(t, 'is')).toBe(true)
      expect(isRollupFilterOperatorCompatible(t, 'greater')).toBe(true)
      expect(isRollupFilterOperatorCompatible(t, 'lessequal')).toBe(true)
      expect(isRollupFilterOperatorCompatible(t, 'contains')).toBe(false) // catch-all match-all otherwise
      expect(isRollupFilterOperatorCompatible(t, 'doesnotcontain')).toBe(false)
    }
  })

  test('boolean: equality only, comparison/text rejected', () => {
    expect(isRollupFilterOperatorCompatible('boolean', 'is')).toBe(true)
    expect(isRollupFilterOperatorCompatible('boolean', 'isnot')).toBe(true)
    expect(isRollupFilterOperatorCompatible('boolean', 'greater')).toBe(false)
    expect(isRollupFilterOperatorCompatible('boolean', 'contains')).toBe(false)
  })

  test('string: equality + contains, comparison rejected', () => {
    expect(isRollupFilterOperatorCompatible('string', 'is')).toBe(true)
    expect(isRollupFilterOperatorCompatible('string', 'contains')).toBe(true)
    expect(isRollupFilterOperatorCompatible('string', 'doesnotcontain')).toBe(true)
    expect(isRollupFilterOperatorCompatible('string', 'greater')).toBe(false)
    expect(isRollupFilterOperatorCompatible('string', 'lessequal')).toBe(false)
  })

  test('isempty/isnotempty are universal', () => {
    for (const t of ['number', 'boolean', 'string', 'date']) {
      expect(isRollupFilterOperatorCompatible(t, 'isempty')).toBe(true)
      expect(isRollupFilterOperatorCompatible(t, 'isnotempty')).toBe(true)
    }
  })

  test('unknown operator rejected for every type', () => {
    expect(isRollupFilterOperatorCompatible('string', 'bogus')).toBe(false)
    expect(isRollupFilterOperatorCompatible('number', 'xyz')).toBe(false)
    expect(isRollupFilterOperatorCompatible('boolean', '')).toBe(false)
  })

  test('case-insensitive', () => {
    expect(isRollupFilterOperatorCompatible('number', 'GREATER')).toBe(true)
    expect(isRollupFilterOperatorCompatible('string', 'Contains')).toBe(true)
    expect(isRollupFilterOperatorCompatible('number', ' is ')).toBe(true)
  })
})
