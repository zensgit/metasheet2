import { approvedCorrectionFixture } from './attendance-approved-correction-fixture'
import { routeFrozenAttendanceContextV1 } from '../../src/attendance/w4c1-segment-calculator'

// Frozen JSON support fixture. The public router proves the v2 branch; this
// neither imports a private issuer nor claims group source-emission evidence.
export function approvedCorrectionGroupV2Fixture(
  orgId = 'org-A', userId = 'user-A', workDate = '2049-08-21',
  calculationGroupId = '00000000-0000-4000-8000-000000000020',
) {
  const base = approvedCorrectionFixture(orgId, userId, workDate)
  const candidate = {
    ...base.context, schemaVersion: 2 as const, selector: 'group_effective' as const, calculationGroupId,
  }
  const routed = routeFrozenAttendanceContextV1(candidate)
  if (routed.kind !== 'v2' || routed.context.selector !== 'group_effective') {
    throw new Error('APPROVED_CORRECTION_GROUP_V2_FIXTURE_UNSUPPORTED')
  }
  return { ...base, context: routed.context }
}
