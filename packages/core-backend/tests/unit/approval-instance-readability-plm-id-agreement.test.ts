/**
 * Lock-10 (S1) OD-S1-18(b) — the three hand-copied `plm:` id detectors must agree with each other
 * and with the canonical form this slice names. Verbatim from the ratified lock:
 * "The CHECK's predicate was matched against the runtime's own id test, not assumed: the three
 * shipped detectors are `routes/approvals.ts:94-96`, `routes/approval-history.ts:18-20` and
 * `ApprovalBridgeService.ts:113-115`, and all three are exactly `id.startsWith('plm:')`... It is
 * also fragile: the test is hand-copied into three separate private functions, so the implementing
 * slice must either consolidate them or gate the agreement. ... the divergence of any one of them
 * is a P1."
 *
 * This slice does not consolidate the three (that would touch three live route/service files for a
 * behavior this PR does not otherwise change) — it gates their agreement, mechanically, over a
 * fixture of edge-shaped ids, against the canonical `isPlmApprovalId` this module names.
 */
import { describe, expect, it } from 'vitest'

import { isPlmApprovalId as canonicalIsPlmApprovalId } from '../../src/services/approval-instance-readability'
import { isPlmApprovalId as detailIsPlmApprovalId } from '../../src/routes/approvals'
import { isPlmApprovalId as historyIsPlmApprovalId } from '../../src/routes/approval-history'
import { isPlmId as bridgeIsPlmId } from '../../src/services/ApprovalBridgeService'

const FIXTURE_IDS: Array<{ id: string; expected: boolean; label: string }> = [
  { id: 'plm:12345', expected: true, label: 'ordinary plm mirror id' },
  { id: 'plm:', expected: true, label: 'bare plm prefix with empty external id' },
  { id: 'plm:plm:nested', expected: true, label: 'plm prefix containing a second plm: substring' },
  { id: 'afs:12345', expected: false, label: 'after-sales bridge id (different prefix)' },
  { id: 'PLM:12345', expected: false, label: 'wrong case — must not fuzzy-match' },
  { id: 'xplm:12345', expected: false, label: 'plm not at the start of the string' },
  { id: 'platform-plm:12345', expected: false, label: 'plm substring not a prefix' },
  { id: '', expected: false, label: 'empty id' },
  { id: 'plm', expected: false, label: 'prefix without the trailing colon' },
  { id: '  plm:12345', expected: false, label: 'leading whitespace defeats a literal startsWith' },
]

describe('Lock-10 OD-S1-18(b) — plm: id detector agreement (P1 if any diverges)', () => {
  for (const { id, expected, label } of FIXTURE_IDS) {
    it(`all four detectors agree on ${JSON.stringify(id)} (${label}) => ${expected}`, () => {
      expect(canonicalIsPlmApprovalId(id)).toBe(expected)
      expect(detailIsPlmApprovalId(id)).toBe(expected)
      expect(historyIsPlmApprovalId(id)).toBe(expected)
      expect(bridgeIsPlmId(id)).toBe(expected)
    })
  }

  it('DISCRIMINATING: the fixture actually distinguishes true from false (not a vacuously-true fixture)', () => {
    const trueCount = FIXTURE_IDS.filter((f) => f.expected).length
    const falseCount = FIXTURE_IDS.filter((f) => !f.expected).length
    expect(trueCount).toBeGreaterThan(0)
    expect(falseCount).toBeGreaterThan(0)
  })
})
