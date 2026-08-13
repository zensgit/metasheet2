/**
 * W7-0 (#4556) — read-side provenance amendment (OD-W7-5a) value record.
 * See `../w7-read-side-provenance-amendment.ts` header and
 * `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * §4.4, §7 OD-W7-5.
 *
 * This module is not imported by any production path (W7-R9 byte-inert):
 * neither `PROJECTION_OWNERS`
 * (`../../services/AttendanceW4CalculationDetail.ts`) nor
 * `AttendanceDecisionTraceSourceKind`
 * (`../../services/AttendanceDecisionTrace.ts`) is edited by this PR. The
 * real compile-time drift guard lives in the source file itself
 * (`_assertProjectionOwnerSyncV1` / `_assertTraceSourceKindSyncV1`, checked
 * by `pnpm type-check`, which — unlike `vitest` — does NOT exclude this
 * `__tests__` directory, so this file's own assertions below are a runtime
 * echo of that compile-time guarantee, not a substitute for it).
 */
import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1,
  ATTENDANCE_W7_READ_SIDE_PROVENANCE_AMENDMENT_V1,
  ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1,
} from '../w7-read-side-provenance-amendment'

describe('W7-0 read-side provenance amendment: recorded values', () => {
  it('projectionOwner new value is a fixed string, distinct from both current legacy/w4 values', () => {
    expect(ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1).toBe('w4_group')
    expect(ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1).not.toBe('legacy_untracked')
    expect(ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1).not.toBe('w4')
  })

  it('trace source-kind new value is a fixed string, distinct from all six current values', () => {
    expect(ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1).toBe('group_policy_snapshot')
    const current = ['record', 'snapshot', 'rule_live', 'ledger', 'audit', 'policy_gate']
    expect(current).not.toContain(ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1)
  })

  it('bundled record targets exactly the two named modules/symbols, exact-key shape', () => {
    expect(ATTENDANCE_W7_READ_SIDE_PROVENANCE_AMENDMENT_V1).toEqual({
      projectionOwner: {
        targetFile: 'packages/core-backend/src/services/AttendanceW4CalculationDetail.ts',
        targetConst: 'PROJECTION_OWNERS',
        currentMembers: ['legacy_untracked', 'w4'],
        newValue: 'w4_group',
      },
      traceSourceKind: {
        targetFile: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts',
        targetType: 'AttendanceDecisionTraceSourceKind',
        currentMembers: ['record', 'snapshot', 'rule_live', 'ledger', 'audit', 'policy_gate'],
        newValue: 'group_policy_snapshot',
      },
    })
  })

  it('is a different enum family from the W6-owned source-label union (OD-W6-3a) — no overlap in spelling', () => {
    // W6's own closed set (verbatim, from w6-group-effective-policy-contract.ts) — reproduced as a
    // literal here (not imported: that module is W6's, and importing its VALUE export would be an
    // unrelated live-module edge for this W7-0 PR to carry for no reason). §4.4: W7 adopts these
    // spellings and mints none of its own for that family, so none of this file's new values may
    // collide with them.
    const w6SourceLabels = ['effective', 'org_inherited', 'preview_only', 'needs_configuration', 'conflict_action_required']
    expect(w6SourceLabels).not.toContain(ATTENDANCE_W7_PROJECTION_OWNER_GROUP_VALUE_V1)
    expect(w6SourceLabels).not.toContain(ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1)
  })
})
