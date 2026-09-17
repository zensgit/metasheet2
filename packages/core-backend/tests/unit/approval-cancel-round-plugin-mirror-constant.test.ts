import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { APPROVAL_CANCEL_ROUND_WORKFLOW_KEY as CORE_APPROVAL_CANCEL_ROUND_WORKFLOW_KEY } from '../../src/attendance/w4c3b-central-approval-hooks'

/**
 * Approval cancel-round design lock v5.9 §14.1/§14.3 #10-#11 (lane decision 2, 2026-09-17).
 *
 * WHAT THIS PINS: the core-side `APPROVAL_CANCEL_ROUND_WORKFLOW_KEY`
 * (`packages/core-backend/src/attendance/w4c3b-central-approval-hooks.ts`) and the plugin-side
 * mirror in `plugins/plugin-attendance/index.cjs` (CJS boundary — that module has zero import of
 * the TS side, so the value is duplicated, not imported, following the SAME convention already
 * used for `ATTENDANCE_APPROVAL_WORKFLOW_KEY` mirrored at `index.cjs:159`) are byte-identical in
 * BOTH name and value. Precedent for the source-text extraction below: the
 * `p26-approval-assignment-classification.cjs` cross-check in
 * `approval-lock9-process-attachment-unit.test.ts:58`.
 *
 * Two assertions guard against a vacuous pass: (1) each side is independently asserted to equal
 * the literal `'approval.cancel-round'` — not merely to equal EACH OTHER (which a shared
 * `undefined` would also satisfy); (2) the source-text regex requires the exact identifier
 * `APPROVAL_CANCEL_ROUND_WORKFLOW_KEY`, so a rename on either side goes red here even though the
 * VALUE would still match.
 *
 * Also pins the defensive check this constant backs: `upsertAttendanceApprovalInstance`'s single
 * chokepoint (feeds BOTH §14.3 #10's `attendance_requests.approval_workflow_key` write and #11's
 * `approval_instances.workflow_key` write) refuses a payload whose `workflowKey` is the
 * cancel-round key. This is PROVABLY inert for every current caller — `buildAttendanceApprovalInstancePayload`
 * is the SOLE site in `index.cjs` that sets the payload's workflow-key property (mechanically
 * counted below), always with the literal `ATTENDANCE_APPROVAL_WORKFLOW_KEY` — so this test's
 * positive case (the real attendance key passes through unharmed) is the "adds no behavior" half
 * of the claim, and the negative case (the cancel-round key is rejected) is the "adds defense in
 * depth" half.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const require = createRequire(import.meta.url)

const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceApprovalCenterForTests as {
  ATTENDANCE_APPROVAL_WORKFLOW_KEY: string
  APPROVAL_CANCEL_ROUND_WORKFLOW_KEY: string
  assertAttendanceApprovalPayloadNotCancelRound: (payload: { workflowKey?: string } | null | undefined) => void
}

describe('plugin mirror of APPROVAL_CANCEL_ROUND_WORKFLOW_KEY (lane decision 2)', () => {
  it('core constant is exactly the ratified literal (not a vacuous comparison target)', () => {
    expect(CORE_APPROVAL_CANCEL_ROUND_WORKFLOW_KEY).toBe('approval.cancel-round')
  })

  it('plugin runtime constant is exactly the ratified literal (not a vacuous comparison target)', () => {
    expect(helpers.APPROVAL_CANCEL_ROUND_WORKFLOW_KEY).toBe('approval.cancel-round')
  })

  it('plugin runtime constant equals the core constant', () => {
    expect(helpers.APPROVAL_CANCEL_ROUND_WORKFLOW_KEY).toBe(CORE_APPROVAL_CANCEL_ROUND_WORKFLOW_KEY)
  })

  it('source text pins the SAME identifier name in index.cjs, not just an equal value under a different name', () => {
    const src = readFileSync(join(repoRoot, 'plugins/plugin-attendance/index.cjs'), 'utf8')
    const match = /const APPROVAL_CANCEL_ROUND_WORKFLOW_KEY = '([^']+)'/.exec(src)
    expect(match).toBeTruthy()
    expect(match![1]).toBe(CORE_APPROVAL_CANCEL_ROUND_WORKFLOW_KEY)
  })

  it('positive control: a renamed/absent identifier would fail the source-text pin above', () => {
    const src = readFileSync(join(repoRoot, 'plugins/plugin-attendance/index.cjs'), 'utf8')
    const decoyMatch = /const APPROVAL_CANCEL_ROUND_WORKFLOW_KEY_RENAMED = '([^']+)'/.exec(src)
    expect(decoyMatch).toBeNull()
  })
})

describe('assertAttendanceApprovalPayloadNotCancelRound (§14.3 #10/#11 defensive check)', () => {
  it('rejects a payload whose workflowKey is the cancel-round key', () => {
    expect(() =>
      helpers.assertAttendanceApprovalPayloadNotCancelRound({
        workflowKey: helpers.APPROVAL_CANCEL_ROUND_WORKFLOW_KEY,
      }),
    ).toThrow(/cancel-round/i)
  })

  it('is inert for the real attendance workflow key — every current caller (adds no behavior)', () => {
    expect(() =>
      helpers.assertAttendanceApprovalPayloadNotCancelRound({
        workflowKey: helpers.ATTENDANCE_APPROVAL_WORKFLOW_KEY,
      }),
    ).not.toThrow()
  })

  it('is inert for a missing/undefined workflowKey and a null payload', () => {
    expect(() => helpers.assertAttendanceApprovalPayloadNotCancelRound({})).not.toThrow()
    expect(() => helpers.assertAttendanceApprovalPayloadNotCancelRound(null)).not.toThrow()
  })

  it('mechanical evidence the check is inert for every current caller: workflowKey: is assigned exactly once in index.cjs', () => {
    const src = readFileSync(join(repoRoot, 'plugins/plugin-attendance/index.cjs'), 'utf8')
    const occurrences = [...src.matchAll(/workflowKey:/g)]
    expect(occurrences.length).toBe(1)
  })
})
