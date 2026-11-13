export const FIXED_GROUP = '11111111-1111-4111-8111-111111111111'
export const OTHER_FIXED_GROUP = '33333333-3333-4333-8333-333333333333'
export const FIXED_SHIFT = '22222222-2222-4222-8222-222222222222'
export const FIXED_STATES = ['not_configured', 'configuration_changed', 'pending_apply', 'effective'] as const
export type FixtureFixedState = (typeof FIXED_STATES)[number]
export function fixedScheduleFixture(state: FixtureFixedState = 'pending_apply', self = false, matching = false, groupId = FIXED_GROUP) {
  const data = {
    groupId,
    state,
    reasonCodes: state === 'not_configured' ? ['NO_DESIRED_CONFIG']
      : state === 'configuration_changed' ? ['DIFFERENT_MANAGED_KEY_ACTIVE']
        : state === 'effective' ? ['EFFECTIVE'] : ['TARGET_MEMBER_MISSING'],
    desired: state === 'not_configured' ? null
      : { shiftId: FIXED_SHIFT, startDate: '2026-10-01', endDate: '2026-10-31', revision: 2 },
    evaluatedAt: '2026-10-24T00:00:00.000Z',
  }
  return { ok: true, data: self ? {
    ...data,
    applicability: state === 'not_configured' ? 'not_configured' : state === 'effective' || matching ? 'matching' : 'non_matching',
  } : {
    ...data,
    coverage: { targetMembers: 2, matchingMembers: state === 'effective' ? 2 : 0,
      missingMembers: state === 'effective' ? 0 : 2, nonMemberTargets: 0,
      differentKeyRows: state === 'configuration_changed' ? 1 : 0 },
    drift: { unconfiguredManagedRows: 0, unpublishedManagedRows: 0,
      managedSets: state === 'configuration_changed' ? [{
        shiftId: FIXED_SHIFT, startDate: '2026-09-01', endDate: '2026-09-30',
        producerKey: 'synthetic-old-managed-set', rowCount: 1,
      }] : [] },
  } }
}
