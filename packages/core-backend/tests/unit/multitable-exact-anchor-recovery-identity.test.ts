/**
 * W0-1 v3.7 Lane L6-b — UNIT tests for the EXACT-ANCHOR recovery preview-identity (design-lock #4331 §1.3 /
 * §9 item 6). The signed identity is the destructive-recovery authority: execute takes the TOKEN-BOUND
 * `anchorSeq` and never recomputes `MAX(seq)`, so the token must be unforgeable, non-replayable across
 * sheet/actor, type-disjoint from every sibling preview token, and fail-closed on a malformed anchor. These are
 * pure (no DB); the real-DB resolve/execute path is `tests/integration/multitable-exact-anchor-recovery-realdb.test.ts`.
 */
import { describe, expect, test } from 'vitest'

import {
  hashAnchorRecoveryScope,
  mintExactAnchorRecoveryIdentity,
  verifyExactAnchorRecoveryIdentity,
  mintPitRevertPreviewIdentity,
  type ExactAnchorRecoveryIdentityClaims,
} from '../../src/multitable/restore-preview-identity'

const CLAIMS: ExactAnchorRecoveryIdentityClaims = {
  sheetId: 'sheet_ear_unit',
  anchorOperationId: '11111111-1111-4111-8111-111111111111',
  anchorSeq: '7003',
  checkpointId: 'ckpt_ear_unit',
  scopeHash: 'a'.repeat(64),
  liveSetHash: 'd'.repeat(64),
  actorId: 'user_ear_unit',
  mode: 'revert',
  authorizedScopeHash: 'd'.repeat(64),
}
const expected = { sheetId: CLAIMS.sheetId, actorId: CLAIMS.actorId }

describe('L6-b exact-anchor recovery identity — mint/verify', () => {
  test('round-trip: a valid token verifies and returns the exact TOKEN-BOUND claims', () => {
    const r = verifyExactAnchorRecoveryIdentity(mintExactAnchorRecoveryIdentity(CLAIMS), expected)
    expect(r.valid).toBe(true)
    expect(r.claims).toEqual(CLAIMS) // execute reads anchorSeq/checkpointId/scopeHash from here — must be exact
  })

  test('cross-sheet replay is refused (mismatch_sheetId): a token for sheet A cannot drive sheet B', () => {
    const r = verifyExactAnchorRecoveryIdentity(mintExactAnchorRecoveryIdentity(CLAIMS), { sheetId: 'sheet_other', actorId: CLAIMS.actorId })
    expect(r).toMatchObject({ valid: false, reason: 'mismatch_sheetId' })
    expect(r.claims).toBeUndefined()
  })

  test('cross-actor replay is refused (mismatch_actorId): a preview minted for A is unusable by B', () => {
    const r = verifyExactAnchorRecoveryIdentity(mintExactAnchorRecoveryIdentity(CLAIMS), { sheetId: CLAIMS.sheetId, actorId: 'user_other' })
    expect(r).toMatchObject({ valid: false, reason: 'mismatch_actorId' })
  })

  test('token confusion is refused (wrong_type): a sibling restore-preview token cannot be replayed as an anchor token', () => {
    // Same server secret, valid signature, but a DIFFERENT type — the disjoint `type` check rejects it.
    const pitRevert = mintPitRevertPreviewIdentity({
      sheetId: CLAIMS.sheetId, asOf: '2026-06-01T00:00:00Z', strategy: 'revert',
      scopeHash: 'b'.repeat(64), resurrectScopeHash: 'c'.repeat(64), actorId: CLAIMS.actorId,
    })
    expect(verifyExactAnchorRecoveryIdentity(pitRevert, expected)).toMatchObject({ valid: false, reason: 'wrong_type' })
  })

  test('malformed anchorSeq fails closed (malformed_anchorSeq): a signed-but-garbage anchor never reaches ::bigint', () => {
    const bad = mintExactAnchorRecoveryIdentity({ ...CLAIMS, anchorSeq: 'not-a-number' })
    expect(verifyExactAnchorRecoveryIdentity(bad, expected)).toMatchObject({ valid: false, reason: 'malformed_anchorSeq' })
    // an empty required token-authority field is malformed too (the shape guard covers all four).
    const emptyCkpt = mintExactAnchorRecoveryIdentity({ ...CLAIMS, checkpointId: '' })
    expect(verifyExactAnchorRecoveryIdentity(emptyCkpt, expected)).toMatchObject({ valid: false, reason: 'malformed_anchorSeq' })
    // a NEGATIVE seq is not a decimal bigint string either.
    const neg = mintExactAnchorRecoveryIdentity({ ...CLAIMS, anchorSeq: '-1' })
    expect(verifyExactAnchorRecoveryIdentity(neg, expected)).toMatchObject({ valid: false, reason: 'malformed_anchorSeq' })
    // the L8 preview-freshness hash is a REQUIRED token-authority field too (fail-closed if absent/empty).
    const noLive = mintExactAnchorRecoveryIdentity({ ...CLAIMS, liveSetHash: '' })
    expect(verifyExactAnchorRecoveryIdentity(noLive, expected)).toMatchObject({ valid: false, reason: 'malformed_anchorSeq' })
  })

  test('P1 token contract — mode is REQUIRED and closed-vocabulary: a pre-contract token (no mode) and a garbage mode both fail closed', () => {
    // A token signed under the PRE-contract shape (its destructive semantics were caller-chosen) must
    // verify INVALID — deliberate hard cutover; the module is unwired so no live token predates this.
    const { mode: _m, ...noMode } = CLAIMS
    const preContract = mintExactAnchorRecoveryIdentity(noMode as unknown as ExactAnchorRecoveryIdentityClaims)
    expect(verifyExactAnchorRecoveryIdentity(preContract, expected)).toMatchObject({ valid: false, reason: 'malformed_anchorSeq' })
    // A signed-but-out-of-vocabulary mode never reaches the apply's mode switch.
    const badMode = mintExactAnchorRecoveryIdentity({ ...CLAIMS, mode: 'purge' as unknown as ExactAnchorRecoveryIdentityClaims['mode'] })
    expect(verifyExactAnchorRecoveryIdentity(badMode, expected)).toMatchObject({ valid: false, reason: 'malformed_anchorSeq' })
  })

  test('P1 token contract — authorizedScopeHash is REQUIRED: a token without the signed authorization basis fails closed', () => {
    const { authorizedScopeHash: _a, ...noAuth } = CLAIMS
    const preContract = mintExactAnchorRecoveryIdentity(noAuth as unknown as ExactAnchorRecoveryIdentityClaims)
    expect(verifyExactAnchorRecoveryIdentity(preContract, expected)).toMatchObject({ valid: false, reason: 'malformed_anchorSeq' })
    const empty = mintExactAnchorRecoveryIdentity({ ...CLAIMS, authorizedScopeHash: '' })
    expect(verifyExactAnchorRecoveryIdentity(empty, expected)).toMatchObject({ valid: false, reason: 'malformed_anchorSeq' })
  })

  test('round-trip carries mode + authorizedScopeHash EXACTLY (execute obeys the token, never the request)', () => {
    const reset = verifyExactAnchorRecoveryIdentity(mintExactAnchorRecoveryIdentity({ ...CLAIMS, mode: 'reset' }), expected)
    expect(reset.valid).toBe(true)
    expect(reset.claims?.mode).toBe('reset')
    expect(reset.claims?.authorizedScopeHash).toBe(CLAIMS.authorizedScopeHash)
  })

  test('an expired token is refused (expired), not silently accepted', () => {
    const r = verifyExactAnchorRecoveryIdentity(mintExactAnchorRecoveryIdentity(CLAIMS, -10), expected)
    expect(r).toMatchObject({ valid: false, reason: 'expired' })
  })

  test('a signature-tampered token is refused (invalid)', () => {
    const token = mintExactAnchorRecoveryIdentity(CLAIMS)
    const tampered = token.slice(0, -1) + (token.slice(-1) === 'A' ? 'B' : 'A')
    expect(verifyExactAnchorRecoveryIdentity(tampered, expected)).toMatchObject({ valid: false, reason: 'invalid' })
  })
})

describe('L6-b hashAnchorRecoveryScope — order-invariant, drift-sensitive', () => {
  const a = { recordId: 'r-a', exists: true, version: 1 }
  const b = { recordId: 'r-b', exists: true, version: 3 }
  const del = { recordId: 'r-c', exists: false, version: null }

  test('order-invariant: the same set in a different order hashes identically', () => {
    expect(hashAnchorRecoveryScope([a, b, del])).toBe(hashAnchorRecoveryScope([del, b, a]))
  })

  test('drift-sensitive: a changed version, changed existence, or added/removed record changes the hash', () => {
    const base = hashAnchorRecoveryScope([a, b])
    expect(hashAnchorRecoveryScope([{ ...a, version: 2 }, b])).not.toBe(base) // version bump
    expect(hashAnchorRecoveryScope([{ ...a, exists: false, version: null }, b])).not.toBe(base) // deleted
    expect(hashAnchorRecoveryScope([a, b, del])).not.toBe(base) // a post-anchor record appears (the MAX-recompute drift)
  })

  test('a deleted record contributes a null version (it has none as of the anchor)', () => {
    // exists:false with any stored version must hash the same as exists:false with null — a delete has no version.
    expect(hashAnchorRecoveryScope([{ recordId: 'r', exists: false, version: 9 }]))
      .toBe(hashAnchorRecoveryScope([{ recordId: 'r', exists: false, version: null }]))
  })
})
