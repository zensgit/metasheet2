/**
 * Global History — T6-1: restore preview-identity contract goldens (pure unit; no DB, no route).
 *
 * The contract that lets the eventual restore execute (T6-2) confirm "execution matches the preview" (SR-3).
 * T6-1 is the mint/verify module ONLY — verified here against SYNTHETIC expected claims; the execute computing
 * the real diff → expected → verify → write is T6-2.
 */
import { describe, expect, it } from 'vitest'

import {
  hashPreviewChanges,
  hashScope,
  mintRestorePreviewIdentity,
  mintScopedRestorePreviewIdentity,
  verifyRestorePreviewIdentity,
  verifyScopedRestorePreviewIdentity,
  type RestorePreviewIdentityClaims,
  type ScopedRestorePreviewIdentityClaims,
} from '../../src/multitable/restore-preview-identity'

const baseClaims = (): RestorePreviewIdentityClaims => ({
  sheetId: 'sheet_1',
  recordId: 'rec_1',
  targetVersion: 3,
  strategy: 'revert',
  changesHash: hashPreviewChanges([{ fieldId: 'f1', op: 'set', value: 'a' }, { fieldId: 'f2', op: 'unset', value: null }]),
  actorId: 'user_1',
})

describe('restore preview identity — T6-1 contract', () => {
  it('mint → verify roundtrip is valid against the matching expected claims', () => {
    const claims = baseClaims()
    const token = mintRestorePreviewIdentity(claims)
    expect(verifyRestorePreviewIdentity(token, claims)).toEqual({ valid: true })
  })

  it('a tampered token is rejected (signature)', () => {
    const token = mintRestorePreviewIdentity(baseClaims())
    const tampered = token.slice(0, -3) + (token.slice(-3) === 'AAA' ? 'BBB' : 'AAA')
    expect(verifyRestorePreviewIdentity(tampered, baseClaims()).valid).toBe(false)
  })

  it('an expired identity is rejected with reason "expired"', () => {
    const token = mintRestorePreviewIdentity(baseClaims(), '-1s') // already past
    expect(verifyRestorePreviewIdentity(token, baseClaims())).toEqual({ valid: false, reason: 'expired' })
  })

  it('every bound claim must match — a mismatch on any axis is rejected', () => {
    const claims = baseClaims()
    const token = mintRestorePreviewIdentity(claims)
    expect(verifyRestorePreviewIdentity(token, { ...claims, sheetId: 'other' }).reason).toBe('mismatch_sheetId')
    expect(verifyRestorePreviewIdentity(token, { ...claims, recordId: 'other' }).reason).toBe('mismatch_recordId')
    expect(verifyRestorePreviewIdentity(token, { ...claims, targetVersion: 99 }).reason).toBe('mismatch_targetVersion')
    // strategy is a load-bearing SR-3 bind; cast past the v1 `'revert'`-only type so the guard is pinned for
    // when `'reset'` is ever added — a revert identity must never satisfy a reset execution.
    expect(verifyRestorePreviewIdentity(token, { ...claims, strategy: 'reset' as unknown as 'revert' }).reason).toBe('mismatch_strategy')
    expect(verifyRestorePreviewIdentity(token, { ...claims, changesHash: 'deadbeef' }).reason).toBe('mismatch_changesHash') // stale diff → reject
    expect(verifyRestorePreviewIdentity(token, { ...claims, actorId: 'user_2' }).reason).toBe('mismatch_actorId') // B cannot replay A's identity
  })

  it('changesHash is ORDER-INVARIANT (else a restore could never execute — re-hash would always diverge)', () => {
    const a = hashPreviewChanges([{ fieldId: 'f1', op: 'set', value: 1 }, { fieldId: 'f2', op: 'set', value: 2 }])
    const b = hashPreviewChanges([{ fieldId: 'f2', op: 'set', value: 2 }, { fieldId: 'f1', op: 'set', value: 1 }])
    expect(a).toBe(b)
  })

  it('changesHash DISTINGUISHES a different change set (a changed value → different hash)', () => {
    const a = hashPreviewChanges([{ fieldId: 'f1', op: 'set', value: 1 }])
    const b = hashPreviewChanges([{ fieldId: 'f1', op: 'set', value: 2 }])
    expect(a).not.toBe(b)
  })
})

// ── BS-1: scoped (multi-record) identity goldens ──────────────────────────────────────────────────────────────
// The contract that will let the batch execute (BS-3) confirm "execution matches the preview" across a record SET
// (BS-1; D6 discriminated union, D4 scope hash, BS-7 no narrow/widen replay). Pure unit; the execute computing the
// real per-record diffs → expected scope claims → verify → fan-out write is BS-3.

const perRecordDiff = (id: string, version = 2) => ({ recordId: id, changesHash: hashPreviewChanges([{ fieldId: 'f1', op: 'set', value: id }]), version })
const scopedClaims = (recordIds: string[], versions: Record<string, number> = {}): ScopedRestorePreviewIdentityClaims => ({
  sheetId: 'sheet_1',
  scope: { kind: 'records', recordIds },
  targetVersion: 3,
  strategy: 'revert',
  scopeHash: hashScope(recordIds.map((id) => perRecordDiff(id, versions[id] ?? 2))),
  actorId: 'user_1',
})
const singleClaims = (): RestorePreviewIdentityClaims => ({
  sheetId: 'sheet_1', recordId: 'A', targetVersion: 3, strategy: 'revert',
  changesHash: hashPreviewChanges([{ fieldId: 'f1', op: 'set', value: 'A' }]), actorId: 'user_1',
})

describe('restore preview identity — BS-1 scoped (multi-record) contract', () => {
  it('scoped mint → verify roundtrip is valid against the matching record set', () => {
    const claims = scopedClaims(['A', 'B', 'C'])
    expect(verifyScopedRestorePreviewIdentity(mintScopedRestorePreviewIdentity(claims), claims)).toEqual({ valid: true })
  })

  it('SCOPE KEYSTONE: an identity for {A,B,C} cannot execute a narrowed {A,B} or a widened {A,B,C,D} (BS-7)', () => {
    const token = mintScopedRestorePreviewIdentity(scopedClaims(['A', 'B', 'C']))
    // the execute computes the expected scopeHash FRESH from the actual set it is about to restore → diverges → reject
    expect(verifyScopedRestorePreviewIdentity(token, scopedClaims(['A', 'B'])).reason).toBe('mismatch_scopeHash')
    expect(verifyScopedRestorePreviewIdentity(token, scopedClaims(['A', 'B', 'C', 'D'])).reason).toBe('mismatch_scopeHash')
  })

  it('binds the per-record VERSION: a different submitted version → different scopeHash (anti-CAS-bypass)', () => {
    // same records, same diffs, but B's submitted version is 4 instead of the preview-time 2 — a client trying to
    // submit the CURRENT version to slip past the optimistic-concurrency CAS instead diverges the hash → reject.
    const token = mintScopedRestorePreviewIdentity(scopedClaims(['A', 'B'])) // versions default to 2
    expect(verifyScopedRestorePreviewIdentity(token, scopedClaims(['A', 'B'], { B: 4 })).reason).toBe('mismatch_scopeHash')
  })

  it('hashScope is ORDER-INVARIANT over the record set (else a batch could never execute — re-hash would diverge)', () => {
    const a = hashScope([perRecordDiff('A'), perRecordDiff('B'), perRecordDiff('C')])
    const b = hashScope([perRecordDiff('C'), perRecordDiff('A'), perRecordDiff('B')])
    expect(a).toBe(b)
  })

  it('hashScope DISTINGUISHES a changed per-record diff (one record value moved → different scope hash)', () => {
    const base = hashScope([perRecordDiff('A'), perRecordDiff('B')])
    const moved = hashScope([perRecordDiff('A'), { recordId: 'B', changesHash: hashPreviewChanges([{ fieldId: 'f1', op: 'set', value: 'CHANGED' }]) }])
    expect(base).not.toBe(moved)
  })

  it('every bound claim must match — a mismatch on any axis is rejected', () => {
    const claims = scopedClaims(['A', 'B', 'C'])
    const token = mintScopedRestorePreviewIdentity(claims)
    expect(verifyScopedRestorePreviewIdentity(token, { ...claims, sheetId: 'other' }).reason).toBe('mismatch_sheetId')
    expect(verifyScopedRestorePreviewIdentity(token, { ...claims, targetVersion: 99 }).reason).toBe('mismatch_targetVersion')
    expect(verifyScopedRestorePreviewIdentity(token, { ...claims, strategy: 'reset' as unknown as 'revert' }).reason).toBe('mismatch_strategy')
    // a future `batch`/PIT kind must never satisfy a `records` execute (the kind is bound independently of the hash)
    expect(verifyScopedRestorePreviewIdentity(token, { ...claims, scope: { kind: 'batch' as unknown as 'records', recordIds: claims.scope.recordIds } }).reason).toBe('mismatch_scopeKind')
    expect(verifyScopedRestorePreviewIdentity(token, { ...claims, actorId: 'user_2' }).reason).toBe('mismatch_actorId')
  })

  it('D6 DISJOINTNESS: a single-record token can never satisfy a scoped execute, nor a scoped token a single one', () => {
    const single = mintRestorePreviewIdentity(singleClaims())
    const scoped = mintScopedRestorePreviewIdentity(scopedClaims(['A', 'B', 'C']))
    expect(verifyScopedRestorePreviewIdentity(single, scopedClaims(['A', 'B', 'C'])).reason).toBe('wrong_type')
    expect(verifyRestorePreviewIdentity(scoped, singleClaims()).reason).toBe('wrong_type')
  })

  it('expired + tampered scoped tokens are rejected', () => {
    const claims = scopedClaims(['A', 'B'])
    expect(verifyScopedRestorePreviewIdentity(mintScopedRestorePreviewIdentity(claims, '-1s'), claims)).toEqual({ valid: false, reason: 'expired' })
    const token = mintScopedRestorePreviewIdentity(claims)
    const tampered = token.slice(0, -3) + (token.slice(-3) === 'AAA' ? 'BBB' : 'AAA')
    expect(verifyScopedRestorePreviewIdentity(tampered, claims).valid).toBe(false)
  })
})
