/**
 * W0-1 v3.7 Lane L5 — UNIT tests for the pure trust-checkpoint helpers (exact-bigint seq discipline, the
 * retention floor clamp, the P3-2 enablement precondition, and the server-owned system_kind predicate). The
 * real-DB state-machine / selection / retention goldens live in
 * `tests/integration/multitable-history-trust-checkpoint-realdb.test.ts`.
 */
import { describe, expect, test } from 'vitest'

import {
  clampRetentionCutoffToFloor,
  compareSeq,
  isSeqString,
  minSeq,
  assertSeqString,
  SeqComparatorError,
  SYSTEM_SHEET_KINDS,
} from '../../src/multitable/history-trust-checkpoint'
import {
  RECONSTRUCTION_CAUSALITY_LANDED,
  evaluateStrictEnablementPrecondition,
} from '../../src/multitable/history-trust-precondition'
import { isSystemSheet, isSystemSheetKind } from '../../src/multitable/system-sheet-predicate'

// 2^53 = 9007199254740992 is exact in float64; 2^53+1 collapses to the SAME float64 via Number().
const TWO_POW_53 = '9007199254740992'
const TWO_POW_53_PLUS_1 = '9007199254740993'
// Near int8 upper bound (2^63-1 = 9223372036854775807).
const NEAR_INT8_MAX = '9223372036854775806'
const INT8_MAX = '9223372036854775807'

describe('L5 exact-bigint seq discipline', () => {
  test('isSeqString accepts decimal integer strings, rejects everything else', () => {
    expect(isSeqString('0')).toBe(true)
    expect(isSeqString(INT8_MAX)).toBe(true)
    expect(isSeqString('-1')).toBe(false)
    expect(isSeqString('1.0')).toBe(false)
    expect(isSeqString('abc')).toBe(false)
    expect(isSeqString('')).toBe(false)
    expect(isSeqString(123 as unknown as string)).toBe(false) // a real number, not a string
  })

  test('assertSeqString throws SeqComparatorError (fail-closed, never coerces) on illegal input', () => {
    expect(() => assertSeqString('nope', 'ctx')).toThrow(SeqComparatorError)
    expect(() => assertSeqString('-5', 'ctx')).toThrow(SeqComparatorError)
    // positive control: a legal seq does not throw
    expect(() => assertSeqString('42', 'ctx')).not.toThrow()
  })

  test('compareSeq is EXACT across the 2^53 float64 boundary (Number() would collapse these)', () => {
    // Sanity: the collapse is real in JS — this is exactly what forbids Number()/parseInt for seq.
    expect(Number(TWO_POW_53) === Number(TWO_POW_53_PLUS_1)).toBe(true)
    // compareSeq must still order them strictly.
    expect(compareSeq(TWO_POW_53, TWO_POW_53_PLUS_1)).toBe(-1)
    expect(compareSeq(TWO_POW_53_PLUS_1, TWO_POW_53)).toBe(1)
    expect(compareSeq(TWO_POW_53, TWO_POW_53)).toBe(0)
    // and near the int8 ceiling
    expect(compareSeq(NEAR_INT8_MAX, INT8_MAX)).toBe(-1)
  })

  test('minSeq returns the smaller as its ORIGINAL string (no numeric round-trip)', () => {
    expect(minSeq(TWO_POW_53_PLUS_1, TWO_POW_53)).toBe(TWO_POW_53)
    expect(minSeq(TWO_POW_53, TWO_POW_53_PLUS_1)).toBe(TWO_POW_53)
    expect(minSeq(INT8_MAX, NEAR_INT8_MAX)).toBe(NEAR_INT8_MAX)
  })
})

describe('L5 retention floor clamp (clampRetentionCutoffToFloor)', () => {
  test('a requested cutoff ABOVE the floor is clamped DOWN to the floor (the load-bearing guard)', () => {
    // requested 200 > floor 100 ⇒ clamp to 100. Mutation "return requestedCutoffSeq" ⇒ this reds.
    expect(clampRetentionCutoffToFloor('200', '100')).toBe('100')
  })

  test('a requested cutoff BELOW the floor passes through unchanged', () => {
    expect(clampRetentionCutoffToFloor('50', '100')).toBe('50')
  })

  test('clamp is EXACT across the 2^53 boundary', () => {
    // floor = 2^53, requested = 2^53+1 ⇒ clamp to 2^53. Number()-based min would treat them as equal.
    expect(clampRetentionCutoffToFloor(TWO_POW_53_PLUS_1, TWO_POW_53)).toBe(TWO_POW_53)
  })

  test('no active checkpoint (floorSeq null) ⇒ fail-closed cutoff "0" (prunes nothing)', () => {
    expect(clampRetentionCutoffToFloor('999999', null)).toBe('0')
  })

  test('an illegal requested cutoff fails closed (SeqComparatorError, never coerced)', () => {
    expect(() => clampRetentionCutoffToFloor('not-a-seq', '100')).toThrow(SeqComparatorError)
  })
})

describe('L5 P3-2 strict-enablement precondition (pure)', () => {
  test('the L6 seam is still OFF — reconstruction is not yet causal', () => {
    expect(RECONSTRUCTION_CAUSALITY_LANDED).toBe(false)
  })

  test('both conditions unmet ⇒ canEnable false, both listed', () => {
    const r = evaluateStrictEnablementPrecondition({ hasActiveCheckpoint: false, reconstructionIsCausal: false })
    expect(r.canEnable).toBe(false)
    expect([...r.unmet].sort()).toEqual(['no_active_checkpoint', 'reconstruction_non_causal'])
  })

  test('DISTINGUISHES the two conditions: active checkpoint present but reconstruction non-causal ⇒ ONLY reconstruction listed', () => {
    // Proves the guard evaluates the checkpoint half independently (not a count-only guard). This is the
    // real pre-L6 production shape: a sheet DOES have an active checkpoint, but L6 has not landed.
    const r = evaluateStrictEnablementPrecondition({ hasActiveCheckpoint: true, reconstructionIsCausal: false })
    expect(r.canEnable).toBe(false)
    expect(r.unmet).toEqual(['reconstruction_non_causal'])
  })

  test('checkpoint absent but reconstruction causal ⇒ ONLY no_active_checkpoint listed', () => {
    const r = evaluateStrictEnablementPrecondition({ hasActiveCheckpoint: false, reconstructionIsCausal: true })
    expect(r.canEnable).toBe(false)
    expect(r.unmet).toEqual(['no_active_checkpoint'])
  })

  test('POSITIVE CONTROL: both conditions met ⇒ canEnable true (proves the guard is not fail-everything)', () => {
    const r = evaluateStrictEnablementPrecondition({ hasActiveCheckpoint: true, reconstructionIsCausal: true })
    expect(r.canEnable).toBe(true)
    expect(r.unmet).toEqual([])
  })
})

describe('L5 server-owned system_kind predicate (non-forgeable authority)', () => {
  test('isSystemSheetKind recognizes exactly the server-owned kinds', () => {
    expect(SYSTEM_SHEET_KINDS).toContain('people_directory')
    expect(isSystemSheetKind('people_directory')).toBe(true)
    expect(isSystemSheetKind('approval_projection')).toBe(true)
    expect(isSystemSheetKind('user')).toBe(false)
    expect(isSystemSheetKind('')).toBe(false)
    expect(isSystemSheetKind(undefined)).toBe(false)
  })

  test('a recognized systemKind makes isSystemSheet true regardless of description/base', () => {
    expect(isSystemSheet({ systemKind: 'people_directory', description: 'anything', baseId: 'base_user' })).toBe(true)
  })

  test('legacy signals still work (backward compat): approval base id and People description', () => {
    expect(isSystemSheet({ baseId: 'base_apr_projection' })).toBe(true)
    expect(isSystemSheet({ description: '__metasheet_system:people__' })).toBe(true)
  })

  test('an ordinary user sheet (no systemKind, ordinary base/description) is NOT a system sheet', () => {
    expect(isSystemSheet({ systemKind: null, baseId: 'base_user', description: 'My sheet' })).toBe(false)
    expect(isSystemSheet({})).toBe(false)
  })
})
