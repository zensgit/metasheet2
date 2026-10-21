import { describe, expect, it } from 'vitest'
import {
  ADD_SIGN_APPENDED_ROUND_METADATA_KEY,
  buildAddSignAppendedRoundMetadata,
  readAddSignAppendedRound,
} from '../../src/services/approval-add-sign-after'
import {
  APPROVAL_ADD_SIGN_AGGREGATIONS,
  APPROVAL_ADD_SIGN_MODES,
  isApprovalAddSignAggregation,
  isApprovalAddSignMode,
} from '../../src/types/approval-product'

/**
 * Lock-5 L5-B (F4-S1) — the appended-round carrier, pure half.
 * Source: `approval-lock5-node-operation-policy-20260817.md` OD-L5-4(b), OD-L5-5(a), gate B-5.
 * The real-DB half (the carrier written by an after-sign and read back by the approve path) is
 * `tests/integration/approval-add-sign-honesty.db.test.ts`.
 */
describe('approval-add-sign-after — appended-round carrier', () => {
  const written = buildAddSignAppendedRoundMetadata({ nodeKey: 'approval_a', entryEpoch: 7, aggregation: 'any' })
  const instanceMetadata = { parallelBranchStates: null, [ADD_SIGN_APPENDED_ROUND_METADATA_KEY]: written }

  it('resolves ONLY for the exact node AND epoch it was written for', () => {
    expect(readAddSignAppendedRound(instanceMetadata, 'approval_a', 7)).toEqual({ nodeKey: 'approval_a', entryEpoch: 7, aggregation: 'any' })
    // A later activation of the same node (return / jump) mints a different epoch → authored mode.
    expect(readAddSignAppendedRound(instanceMetadata, 'approval_a', 8)).toBeNull()
    expect(readAddSignAppendedRound(instanceMetadata, 'approval_a', 6)).toBeNull()
    // Another node at the same epoch number is not this round.
    expect(readAddSignAppendedRound(instanceMetadata, 'approval_b', 7)).toBeNull()
    // A legacy (NULL-epoch) round can never be an appended round.
    expect(readAddSignAppendedRound(instanceMetadata, 'approval_a', null)).toBeNull()
    expect(readAddSignAppendedRound(instanceMetadata, null, 7)).toBeNull()
  })

  it('accepts the jsonb round-trip shape (numeric epoch, or a digit string) and nothing looser', () => {
    expect(readAddSignAppendedRound({ [ADD_SIGN_APPENDED_ROUND_METADATA_KEY]: { ...written, entryEpoch: '7' } }, 'approval_a', 7)?.aggregation).toBe('any')
    expect(readAddSignAppendedRound({ [ADD_SIGN_APPENDED_ROUND_METADATA_KEY]: { ...written, entryEpoch: '7.0' } }, 'approval_a', 7)).toBeNull()
    expect(readAddSignAppendedRound({ [ADD_SIGN_APPENDED_ROUND_METADATA_KEY]: { ...written, aggregation: 'most' } }, 'approval_a', 7)).toBeNull()
    expect(readAddSignAppendedRound({ [ADD_SIGN_APPENDED_ROUND_METADATA_KEY]: { ...written, aggregation: undefined } }, 'approval_a', 7)).toBeNull()
    expect(readAddSignAppendedRound({ [ADD_SIGN_APPENDED_ROUND_METADATA_KEY]: 'approval_a:7:any' }, 'approval_a', 7)).toBeNull()
    expect(readAddSignAppendedRound({}, 'approval_a', 7)).toBeNull()
    expect(readAddSignAppendedRound(null, 'approval_a', 7)).toBeNull()
    expect(readAddSignAppendedRound([], 'approval_a', 7)).toBeNull()
  })

  it('B-1 / B-5 vocabularies are the ratified three modes and two aggregations, and the guards are exact', () => {
    expect([...APPROVAL_ADD_SIGN_MODES]).toEqual(['before', 'parallel', 'after'])
    expect([...APPROVAL_ADD_SIGN_AGGREGATIONS]).toEqual(['all', 'any'])
    for (const mode of APPROVAL_ADD_SIGN_MODES) expect(isApprovalAddSignMode(mode)).toBe(true)
    for (const bad of ['', 'After', 'AFTER', 'bogus', null, undefined, 1, {}, ['after']]) expect(isApprovalAddSignMode(bad)).toBe(false)
    for (const aggregation of APPROVAL_ADD_SIGN_AGGREGATIONS) expect(isApprovalAddSignAggregation(aggregation)).toBe(true)
    for (const bad of ['', 'All', 'most', 'threshold', 'sequential', 'single', null, undefined, 2]) expect(isApprovalAddSignAggregation(bad)).toBe(false)
  })
})
