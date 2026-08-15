/**
 * W7-0 (#4556) — read-side provenance amendment (OD-W7-5a) value record.
 * See `../w7-read-side-provenance-amendment.ts` header and
 * `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * §4.4, §7 OD-W7-5.
 *
 * UPDATED BY W7-1a-M (ratified per #4556 comments 5293034619 + 5293478713).
 * The W7-0-era statement below — that this module is imported by no production
 * path and that neither live enum is edited — described W7-0 and no longer
 * holds: W7-1a-M wired both recorded values into the live domains, so
 * `../w7-provenance-domain.ts` now imports the two value constants and both
 * `currentMembers` snapshots track the WIDENED live sets. The snapshots are
 * still written independently of the domain module's arrays, so the
 * mutual-extends `tsc` guards they feed remain real comparisons rather than
 * tautologies.
 *
 * Historical W7-0 note: this module was imported by no production path (W7-R9
 * byte-inert), and neither `PROJECTION_OWNERS`
 * (`../../services/AttendanceW4CalculationDetail.ts`) nor
 * `AttendanceDecisionTraceSourceKind`
 * (`../../services/AttendanceDecisionTrace.ts`) was edited by that PR. The
 * real compile-time drift guard lives in the SOURCE file, not here:
 * `packages/core-backend/tsconfig.json`'s `exclude` list keeps every
 * `.test.ts` file and everything under a `__tests__` directory out of
 * `pnpm type-check`'s scope, so a type-level equality assertion placed in
 * THIS file would never actually be checked by `tsc`.
 * `_assertProjectionOwnerSyncV1` / `_assertTraceSourceKindSyncV1` therefore
 * live in `../w7-read-side-provenance-amendment.ts` itself (which IS
 * type-checked); this file's assertions below are runtime VALUE checks only
 * — a weaker, complementary signal, not a substitute for the compile-time
 * guarantee.
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

  it('trace source-kind new value is a fixed string, distinct from the six PRE-widening values', () => {
    expect(ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1).toBe('group_policy_snapshot')
    // The six members the union carried before W7-1a-M. Deliberately still the
    // pre-widening list: the claim is that the new value COLLIDES WITH NONE of
    // them, which is exactly why it could be added.
    const preWidening = ['record', 'snapshot', 'rule_live', 'ledger', 'audit', 'policy_gate']
    expect(preWidening).not.toContain(ATTENDANCE_W7_TRACE_SOURCE_KIND_GROUP_VALUE_V1)
  })

  it('bundled record targets exactly the two named modules/symbols, exact-key shape', () => {
    expect(ATTENDANCE_W7_READ_SIDE_PROVENANCE_AMENDMENT_V1).toEqual({
      projectionOwner: {
        targetFile: 'packages/core-backend/src/services/AttendanceW4CalculationDetail.ts',
        targetConst: 'PROJECTION_OWNERS',
        // W7-1a-M widened the live set; the snapshot follows it.
        currentMembers: ['legacy_untracked', 'w4', 'w4_group'],
        newValue: 'w4_group',
      },
      traceSourceKind: {
        targetFile: 'packages/core-backend/src/services/AttendanceDecisionTrace.ts',
        targetType: 'AttendanceDecisionTraceSourceKind',
        // W7-1a-M widened the live union; the snapshot follows it.
        currentMembers: [
          'record',
          'snapshot',
          'rule_live',
          'ledger',
          'audit',
          'policy_gate',
          'group_policy_snapshot',
        ],
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
