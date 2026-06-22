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
  mintRestorePreviewIdentity,
  verifyRestorePreviewIdentity,
  type RestorePreviewIdentityClaims,
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
