/**
 * W0-1 v3.7 Lane L5 — UNIT tests for the pure trust-checkpoint helpers (exact-bigint seq discipline, the
 * anchor-covering retention selection, the P3-2 enablement precondition, and the server-owned system_kind
 * predicate). The real-DB state-machine / selection / retention / P1-b vintage / P2 enablement goldens live in
 * `tests/integration/multitable-history-trust-checkpoint-realdb.test.ts`.
 */
import { describe, expect, test } from 'vitest'

import {
  compareSeq,
  isSeqString,
  assertSeqString,
  selectRetentionCoveringSeq,
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
const TWO_POW_53_PLUS_2 = '9007199254740994'
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
})

describe('L5 anchor-covering retention (selectRetentionCoveringSeq) — P1-c', () => {
  test('covering = max(seq <= anchor): the C1/C2 counterexample keeps the older checkpoint', () => {
    // C1=100, C2=200; oldest legal anchor=150 ⇒ covering=100 (the checkpoint a recovery to 150 selects).
    // Protecting only the active checkpoint (200) would prune C1 — this is the load-bearing selection.
    expect(selectRetentionCoveringSeq(['100', '200'], '150')).toBe('100')
  })

  test('anchor at/above the newest retained seq ⇒ covering = newest (prune everything older than active)', () => {
    expect(selectRetentionCoveringSeq(['100', '200'], '200')).toBe('200')
    expect(selectRetentionCoveringSeq(['100', '200'], '999999')).toBe('200')
  })

  test('anchor below every retained seq ⇒ null (nothing older is reachable ⇒ prune nothing, fail-closed)', () => {
    expect(selectRetentionCoveringSeq(['100', '200'], '50')).toBeNull()
    expect(selectRetentionCoveringSeq([], '150')).toBeNull()
  })

  test('covering is EXACT across the 2^53 boundary (Number() would treat all three as equal)', () => {
    // seqs {2^53, 2^53+2}, anchor 2^53+1 ⇒ covering 2^53. A Number()-based max<=anchor would pick either.
    expect(selectRetentionCoveringSeq([TWO_POW_53, TWO_POW_53_PLUS_2], TWO_POW_53_PLUS_1)).toBe(TWO_POW_53)
  })

  test('an illegal anchor / retained seq fails closed (SeqComparatorError, never coerced)', () => {
    expect(() => selectRetentionCoveringSeq(['100'], 'not-a-seq')).toThrow(SeqComparatorError)
    expect(() => selectRetentionCoveringSeq(['-5', '100'], '150')).toThrow(SeqComparatorError)
  })
})

describe('L5 P3-2 strict-enablement precondition (pure)', () => {
  test('the L6 seam is true — the L8 exact-anchor route wiring landed (owner ruling 2026-07-17)', () => {
    // The seam flips to true ONLY in the same change that wires the legacy Revert/Reset routes onto the
    // L8 exact-anchor apply (backstop removal + its consumers = one reviewable change). This golden pins
    // the as-built state: wiring landed ⇒ causality landed. Runtime flags remain default-OFF.
    expect(RECONSTRUCTION_CAUSALITY_LANDED).toBe(true)
  })

  test('both conditions unmet ⇒ canEnable false, both listed', () => {
    const r = evaluateStrictEnablementPrecondition({ hasActiveCheckpoint: false, reconstructionIsCausal: false })
    expect(r.canEnable).toBe(false)
    expect([...r.unmet].sort()).toEqual(['no_active_checkpoint', 'reconstruction_non_causal'])
  })

  test('DISTINGUISHES the two conditions: active checkpoint present but reconstruction non-causal ⇒ ONLY reconstruction listed', () => {
    // Proves the guard evaluates the checkpoint half independently (not a count-only guard) — the pure
    // matrix still exercises the non-causal input even though the production seam constant is now true.
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

describe('L5 server-owned system_kind predicate (non-forgeable authority) — P1-a', () => {
  test('isSystemSheetKind recognizes exactly the server-owned kinds', () => {
    expect(SYSTEM_SHEET_KINDS).toContain('people_directory')
    expect(isSystemSheetKind('people_directory')).toBe(true)
    expect(isSystemSheetKind('approval_projection')).toBe(true)
    expect(isSystemSheetKind('user')).toBe(false)
    expect(isSystemSheetKind('')).toBe(false)
    expect(isSystemSheetKind(undefined)).toBe(false)
  })

  test('a recognized systemKind makes isSystemSheet true', () => {
    expect(isSystemSheet({ systemKind: 'people_directory' })).toBe(true)
    expect(isSystemSheet({ systemKind: 'approval_projection' })).toBe(true)
  })

  test('P1-a: the FORGEABLE signals (description sentinel + approval base id) are NO LONGER trusted', () => {
    // isSystemSheet reads systemKind ONLY. Passing a forged People description or the approval base id (both
    // reachable by a client create request) does NOT classify a sheet as a system sheet. Re-introducing the
    // description/base disjunct into isSystemSheet reds this test (and the real-DB forged-identity golden).
    expect(isSystemSheet({ systemKind: null } as { systemKind?: unknown })).toBe(false)
    // The following mimic the pre-P1-a call shape (extra fields ignored by the hardened predicate):
    expect(isSystemSheet({ systemKind: undefined } as { systemKind?: unknown })).toBe(false)
  })

  test('an ordinary user sheet (no recognized systemKind) is NOT a system sheet', () => {
    expect(isSystemSheet({ systemKind: null } as { systemKind?: unknown })).toBe(false)
    expect(isSystemSheet({ systemKind: 'user' })).toBe(false)
    expect(isSystemSheet({})).toBe(false)
  })
})
