/**
 * Trust-checkpoint activation — canary allowlist parser (pure, no DB).
 *
 * The FAIL-CLOSED direction is the whole point: an unset or empty
 * `MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST` must refuse EVERY sheet, so the operator has to
 * designate the canary explicitly before any trust checkpoint can be minted anywhere. These cases
 * pin that direction and the exact-match rule; the real-DB legs in
 * tests/integration/multitable-l5wire-checkpoint-activation-realdb.test.ts pin the route behavior.
 *
 * Env is passed EXPLICITLY (the functions take a `NodeJS.ProcessEnv`), so these cases never mutate
 * `process.env` and cannot leak posture into a neighboring suite.
 */
import { describe, expect, it } from 'vitest'

import {
  isTrustCheckpointSheetAllowlisted,
  resolveTrustCheckpointSheetAllowlist,
  TRUST_CHECKPOINT_SHEET_ALLOWLIST_ENV,
} from '../../src/multitable/trust-checkpoint-activation-authz'

const env = (value?: string): NodeJS.ProcessEnv =>
  (value === undefined ? {} : { [TRUST_CHECKPOINT_SHEET_ALLOWLIST_ENV]: value })

describe('trust-checkpoint canary allowlist (fail-closed)', () => {
  it('the env var name is the manifest-registered literal', () => {
    expect(TRUST_CHECKPOINT_SHEET_ALLOWLIST_ENV).toBe('MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST')
  })

  it('UNSET ⇒ empty list ⇒ no sheet is allowlisted', () => {
    expect(resolveTrustCheckpointSheetAllowlist(env())).toEqual([])
    expect(isTrustCheckpointSheetAllowlisted('sheet_a', env())).toBe(false)
  })

  it('EMPTY string ⇒ empty list ⇒ no sheet is allowlisted', () => {
    expect(resolveTrustCheckpointSheetAllowlist(env(''))).toEqual([])
    expect(isTrustCheckpointSheetAllowlisted('sheet_a', env(''))).toBe(false)
  })

  it("separator-only / whitespace-only (' , , ') ⇒ empty list, NOT a list containing ''", () => {
    expect(resolveTrustCheckpointSheetAllowlist(env(' , , '))).toEqual([])
    expect(resolveTrustCheckpointSheetAllowlist(env('   '))).toEqual([])
    expect(resolveTrustCheckpointSheetAllowlist(env(','))).toEqual([])
    // the discriminating consequence: a blank sheet id must never match a blank entry
    expect(isTrustCheckpointSheetAllowlisted('', env(' , , '))).toBe(false)
    expect(isTrustCheckpointSheetAllowlisted('   ', env(' , , '))).toBe(false)
  })

  it('entries are trimmed; a whitespace-padded id still matches exactly', () => {
    expect(resolveTrustCheckpointSheetAllowlist(env('  sheet_a , sheet_b  '))).toEqual(['sheet_a', 'sheet_b'])
    expect(isTrustCheckpointSheetAllowlisted('sheet_a', env('  sheet_a , sheet_b  '))).toBe(true)
    expect(isTrustCheckpointSheetAllowlisted('sheet_b', env('  sheet_a , sheet_b  '))).toBe(true)
    expect(isTrustCheckpointSheetAllowlisted(' sheet_a ', env('sheet_a'))).toBe(true)
  })

  it('match is EXACT — no prefix, no substring, no case folding', () => {
    const listed = env('sheet_canary')
    expect(isTrustCheckpointSheetAllowlisted('sheet_canary', listed)).toBe(true)
    expect(isTrustCheckpointSheetAllowlisted('sheet_canary_2', listed)).toBe(false)
    expect(isTrustCheckpointSheetAllowlisted('sheet_cana', listed)).toBe(false)
    expect(isTrustCheckpointSheetAllowlisted('SHEET_CANARY', listed)).toBe(false)
    expect(isTrustCheckpointSheetAllowlisted('*', listed)).toBe(false)
  })

  it('a designated list does NOT admit some other sheet (positive + negative in one posture)', () => {
    const listed = env('sheet_a,sheet_b')
    expect(isTrustCheckpointSheetAllowlisted('sheet_a', listed)).toBe(true)
    expect(isTrustCheckpointSheetAllowlisted('sheet_c', listed)).toBe(false)
  })

  it('a non-string env value (deleted key present as undefined) is treated as unset', () => {
    expect(resolveTrustCheckpointSheetAllowlist({ [TRUST_CHECKPOINT_SHEET_ALLOWLIST_ENV]: undefined })).toEqual([])
  })
})
