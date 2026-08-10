/**
 * W6-1 (#4556) — group effective-policy aggregate service: fake-DB
 * (in-memory) functional proof. Reproduces every `aggregate-*.json`
 * fixture via a scripted query router + a fake FSER service, byte-exact
 * (`toStrictEqual`) against the fixture's `data`.
 *
 * This is the fast, DB-free correctness proof; the real-DB integration
 * test (`tests/integration/attendance-w6-group-effective-policy.db.test.ts`)
 * re-proves the same shapes against real PostgreSQL plus the red-line
 * negative/mutation evidence (R1/R3/R4/R5).
 *
 * Every case below is a plain exact-key `toStrictEqual` against the fixture
 * pack as committed (`tests/fixtures/attendance/w6/`, see that directory's
 * README for what each fixture encodes).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  ATTENDANCE_GROUP_MEMBERSHIP_OVERLAP_SQL_V1,
  createAttendanceGroupEffectivePolicyAggregateService,
  type AttendanceGroupEffectivePolicyFserServiceLike,
  type AttendanceGroupEffectivePolicyQueryFn,
} from '../../src/attendance/w6-group-effective-policy-aggregate'

const FIXTURE_DIR = join(__dirname, '../fixtures/attendance/w6')
function readFixture(name: string): { data: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8'))
}

function makeFser(result: {
  groupId: string
  state: 'not_configured' | 'pending_apply' | 'effective' | 'configuration_changed'
  reasonCodes: string[]
  desired: { shiftId: string; startDate: string; endDate: string | null; revision: number } | null
  coverage: { targetMembers: number; matchingMembers: number; missingMembers: number; nonMemberTargets: number; differentKeyRows: number }
  drift: { unconfiguredManagedRows: number; unpublishedManagedRows: number; managedSets: unknown[] }
  evaluatedAt: string
}): AttendanceGroupEffectivePolicyFserServiceLike {
  return { getEffectiveness: async () => result }
}

const NOW = '2026-08-05T00:00:00.000Z'

describe('W6-1 group effective-policy aggregate (fake-DB, exact fixture reproduction)', () => {
  it('reproduces aggregate-effective-fixed-shift.json', async () => {
    const fixture = readFixture('aggregate-effective-fixed-shift')
    const groupId = 'a4556006-0001-4000-8000-000000000001'
    const shiftId = 'a4556006-0001-4000-8000-000000000101'
    const configId = 'a4556006-0001-4000-8000-000000000102'
    const ruleSetId = 'a4556006-0001-4000-8000-000000000103'

    const query: AttendanceGroupEffectivePolicyQueryFn = async (sql) => {
      const s = sql.toLowerCase()
      if (s.includes('from attendance_groups')) return [{ id: groupId, attendance_type: 'fixed_shift', timezone: 'Asia/Shanghai', rule_set_id: ruleSetId }]
      if (s.includes('count(*)::int as cnt from attendance_group_members')) return [{ cnt: 12 }]
      if (s.includes('from attendance_group_managers')) return [{ role: 'owner', cnt: 1 }, { role: 'sub_owner', cnt: 2 }]
      if (s.includes('from attendance_calculation_rollout_state')) return []
      if (s.includes('from attendance_group_fixed_schedule_configs')) return [{ id: configId }]
      if (s.includes('count(*)::int as cnt from attendance_shift_segments')) return [{ cnt: 1 }]
      if (s.includes('from attendance_shifts')) return [{ flex_mode: 'strict' }]
      if (s.includes('from attendance_calculation_group_memberships')) return []
      if (s.includes('from attendance_rule_sets')) return []
      throw new Error(`unexpected SQL: ${sql}`)
    }

    const fser = makeFser({
      groupId,
      state: 'effective',
      reasonCodes: ['EFFECTIVE'],
      desired: { shiftId, startDate: '2026-08-01', endDate: '2026-08-31', revision: 2 },
      coverage: { targetMembers: 12, matchingMembers: 12, missingMembers: 0, nonMemberTargets: 0, differentKeyRows: 0 },
      drift: { unconfiguredManagedRows: 0, unpublishedManagedRows: 0, managedSets: [] },
      evaluatedAt: NOW,
    })

    const service = createAttendanceGroupEffectivePolicyAggregateService({ query, fser, now: () => NOW })
    const result = await service.getAggregate({ orgId: 'org-1', groupId })
    expect(result).toStrictEqual(fixture.data)
  })

  it('reproduces aggregate-org-inherited-defaults.json', async () => {
    const fixture = readFixture('aggregate-org-inherited-defaults')
    const groupId = 'a4556006-0002-4000-8000-000000000001'

    const query: AttendanceGroupEffectivePolicyQueryFn = async (sql) => {
      const s = sql.toLowerCase()
      if (s.includes('from attendance_groups')) return [{ id: groupId, attendance_type: 'free_time', timezone: 'Asia/Shanghai', rule_set_id: null }]
      if (s.includes('count(*)::int as cnt from attendance_group_members')) return [{ cnt: 3 }]
      if (s.includes('from attendance_group_managers')) return [{ role: 'owner', cnt: 1 }]
      if (s.includes('from attendance_calculation_rollout_state')) return []
      if (s.includes('from attendance_rule_sets')) return [{ '?column?': 1 }] // org HAS a default rule set
      if (s.includes('from attendance_calculation_group_memberships')) return []
      throw new Error(`unexpected SQL: ${sql}`)
    }
    const fser: AttendanceGroupEffectivePolicyFserServiceLike = {
      getEffectiveness: async () => {
        throw new Error('FSER must not be called for a free_time group')
      },
    }
    const service = createAttendanceGroupEffectivePolicyAggregateService({ query, fser, now: () => NOW })
    const result = await service.getAggregate({ orgId: 'org-1', groupId })
    expect(result).toStrictEqual(fixture.data)
  })

  it('reproduces aggregate-preview-only-segments-flex.json', async () => {
    const fixture = readFixture('aggregate-preview-only-segments-flex')
    const groupId = 'a4556006-0003-4000-8000-000000000001'
    const shiftId = 'a4556006-0003-4000-8000-000000000101'
    const configId = 'a4556006-0003-4000-8000-000000000102'
    const ruleSetId = 'a4556006-0003-4000-8000-000000000103'

    const query: AttendanceGroupEffectivePolicyQueryFn = async (sql) => {
      const s = sql.toLowerCase()
      if (s.includes('from attendance_groups')) return [{ id: groupId, attendance_type: 'fixed_shift', timezone: 'Asia/Shanghai', rule_set_id: ruleSetId }]
      if (s.includes('count(*)::int as cnt from attendance_group_members')) return [{ cnt: 8 }]
      if (s.includes('from attendance_group_managers')) return [{ role: 'owner', cnt: 1 }, { role: 'sub_owner', cnt: 1 }]
      if (s.includes('from attendance_calculation_rollout_state')) return []
      if (s.includes('from attendance_group_fixed_schedule_configs')) return [{ id: configId }]
      if (s.includes('count(*)::int as cnt from attendance_shift_segments')) return [{ cnt: 1 }]
      if (s.includes('from attendance_shifts')) return [{ flex_mode: 'flex_required_duration' }]
      if (s.includes('from attendance_calculation_group_memberships')) return []
      if (s.includes('from attendance_rule_sets')) return []
      throw new Error(`unexpected SQL: ${sql}`)
    }
    const fser = makeFser({
      groupId,
      state: 'effective',
      reasonCodes: ['EFFECTIVE'],
      desired: { shiftId, startDate: '2026-08-01', endDate: '2026-08-31', revision: 1 },
      coverage: { targetMembers: 8, matchingMembers: 8, missingMembers: 0, nonMemberTargets: 0, differentKeyRows: 0 },
      drift: { unconfiguredManagedRows: 0, unpublishedManagedRows: 0, managedSets: [] },
      evaluatedAt: NOW,
    })
    const service = createAttendanceGroupEffectivePolicyAggregateService({ query, fser, now: () => NOW })
    const result = await service.getAggregate({ orgId: 'org-1', groupId })
    expect(result).toStrictEqual(fixture.data)
  })

  it('reproduces aggregate-needs-configuration.json', async () => {
    const fixture = readFixture('aggregate-needs-configuration')
    const groupId = 'a4556006-0004-4000-8000-000000000001'

    const query: AttendanceGroupEffectivePolicyQueryFn = async (sql) => {
      const s = sql.toLowerCase()
      if (s.includes('from attendance_groups')) return [{ id: groupId, attendance_type: 'scheduled_shift', timezone: null, rule_set_id: null }]
      if (s.includes('count(*)::int as cnt from attendance_group_members')) return [{ cnt: 5 }]
      if (s.includes('from attendance_group_managers')) return []
      if (s.includes('from attendance_calculation_rollout_state')) return []
      if (s.includes('from attendance_schedule_groups')) return [] // no advanced-scheduling config
      if (s.includes('from attendance_calculation_group_memberships')) return []
      if (s.includes('from attendance_rule_sets')) return [] // no org default either
      throw new Error(`unexpected SQL: ${sql}`)
    }
    const fser: AttendanceGroupEffectivePolicyFserServiceLike = {
      getEffectiveness: async () => {
        throw new Error('FSER must not be called for a scheduled_shift group')
      },
    }
    const service = createAttendanceGroupEffectivePolicyAggregateService({ query, fser, now: () => NOW })
    const result = await service.getAggregate({ orgId: 'org-1', groupId })
    expect(result).toStrictEqual(fixture.data)
  })

  it('reproduces aggregate-conflict-membership-overlap.json', async () => {
    const fixture = readFixture('aggregate-conflict-membership-overlap')
    const groupId = 'a4556006-0005-4000-8000-000000000001'
    const shiftId = 'a4556006-0005-4000-8000-000000000101'
    const configId = 'a4556006-0005-4000-8000-000000000102'

    const query: AttendanceGroupEffectivePolicyQueryFn = async (sql) => {
      const s = sql.toLowerCase()
      if (s.includes('from attendance_groups')) return [{ id: groupId, attendance_type: 'fixed_shift', timezone: 'Asia/Shanghai', rule_set_id: null }]
      if (s.includes('count(*)::int as cnt from attendance_group_members')) return [{ cnt: 10 }]
      if (s.includes('from attendance_group_managers')) return [{ role: 'owner', cnt: 1 }]
      if (s.includes('from attendance_calculation_rollout_state')) return []
      if (s.includes('from attendance_group_fixed_schedule_configs')) return [{ id: configId }]
      if (s.includes('count(*)::int as cnt from attendance_shift_segments')) return [{ cnt: 1 }]
      if (s.includes('from attendance_shifts')) return [{ flex_mode: 'strict' }]
      if (s.includes('select count(*)::int as cnt') && s.includes('this_group')) return [{ cnt: 2 }]
      // Fixture's `rules` domain is org_inherited, which requires an org
      // default rule set — the fixture is silent on this fact, so the org
      // world here honestly HAS one.
      if (s.includes('from attendance_rule_sets')) return [{ exists: 1 }]
      throw new Error(`unexpected SQL: ${sql}`)
    }
    const fser = makeFser({
      groupId,
      state: 'effective',
      reasonCodes: ['EFFECTIVE'],
      desired: { shiftId, startDate: '2026-08-01', endDate: '2026-08-31', revision: 1 },
      coverage: { targetMembers: 10, matchingMembers: 10, missingMembers: 0, nonMemberTargets: 0, differentKeyRows: 0 },
      drift: { unconfiguredManagedRows: 0, unpublishedManagedRows: 0, managedSets: [] },
      evaluatedAt: NOW,
    })
    const service = createAttendanceGroupEffectivePolicyAggregateService({ query, fser, now: () => NOW })
    const result = await service.getAggregate({ orgId: 'org-1', groupId })

    expect(result).toStrictEqual(fixture.data)
  })

  it('reproduces aggregate-conflict-fixed-schedule-changed.json', async () => {
    const fixture = readFixture('aggregate-conflict-fixed-schedule-changed')
    const groupId = 'a4556006-0006-4000-8000-000000000001'
    const shiftId = 'a4556006-0006-4000-8000-000000000101'
    const configId = 'a4556006-0006-4000-8000-000000000102'

    const query: AttendanceGroupEffectivePolicyQueryFn = async (sql) => {
      const s = sql.toLowerCase()
      if (s.includes('from attendance_groups')) return [{ id: groupId, attendance_type: 'fixed_shift', timezone: 'Asia/Shanghai', rule_set_id: null }]
      if (s.includes('count(*)::int as cnt from attendance_group_members')) return [{ cnt: 6 }]
      if (s.includes('from attendance_group_managers')) return [{ role: 'owner', cnt: 1 }, { role: 'sub_owner', cnt: 1 }]
      if (s.includes('from attendance_calculation_rollout_state')) return []
      if (s.includes('from attendance_group_fixed_schedule_configs')) return [{ id: configId }]
      if (s.includes('count(*)::int as cnt from attendance_shift_segments')) return [{ cnt: 1 }]
      if (s.includes('from attendance_shifts')) return [{ flex_mode: 'strict' }]
      if (s.includes('from attendance_calculation_group_memberships')) return []
      if (s.includes('from attendance_rule_sets')) return [{ x: 1 }]
      throw new Error(`unexpected SQL: ${sql}`)
    }
    const fser = makeFser({
      groupId,
      state: 'configuration_changed',
      reasonCodes: ['DIFFERENT_MANAGED_KEY_ACTIVE', 'TARGET_MEMBER_MISSING'],
      desired: { shiftId, startDate: '2026-09-01', endDate: '2026-09-30', revision: 3 },
      coverage: { targetMembers: 6, matchingMembers: 0, missingMembers: 6, nonMemberTargets: 0, differentKeyRows: 6 },
      drift: {
        unconfiguredManagedRows: 0,
        unpublishedManagedRows: 0,
        managedSets: [
          {
            shiftId: 'a4556006-0006-4000-8000-000000000109',
            startDate: '2026-08-01',
            endDate: '2026-08-31',
            producerKey: 'fixed:a4556006-0006-4000-8000-000000000109:2026-08-01:2026-08-31',
            rowCount: 6,
          },
        ],
      },
      evaluatedAt: NOW,
    })
    const service = createAttendanceGroupEffectivePolicyAggregateService({ query, fser, now: () => NOW })
    const result = await service.getAggregate({ orgId: 'org-1', groupId })
    expect(result).toStrictEqual(fixture.data)
  })
})

/**
 * W6-R6: each of the five internal enum reads the service does over data it
 * does not itself validate on the way in (group type, manager role, rollout
 * state, FSER state, shift flex mode) fails closed with a named error code
 * rather than silently mapping an unrecognized value to a label or a
 * default. None of these five is reachable through today's CHECK
 * constraints or FSER's own closed state machine — that is exactly why they
 * are defence in depth. Each case below asserts the specific error code
 * (not a bare `toThrow()`, which would also pass on an unrelated crash) and
 * is built by taking the minimal valid "effective fixed_shift" shape and
 * flipping exactly one field to an out-of-enum value, so a revert of any
 * one guard back to a silent fallback reds exactly its own case.
 */
describe('W6-1 group effective-policy aggregate — fail-closed enum guards', () => {
  const groupId = 'a4556006-0009-4000-8000-000000000001'
  const shiftId = 'a4556006-0009-4000-8000-000000000101'
  const configId = 'a4556006-0009-4000-8000-000000000102'

  /** A query router for a minimal valid "effective fixed_shift" group,
   * with one override hook per SQL target so each test can flip exactly
   * one field to an out-of-enum value. */
  function makeQuery(overrides: {
    groupType?: unknown
    managerRole?: unknown
    rolloutState?: unknown
    flexMode?: unknown
  }): AttendanceGroupEffectivePolicyQueryFn {
    return async (sql) => {
      const s = sql.toLowerCase()
      if (s.includes('from attendance_groups')) {
        return [{ id: groupId, attendance_type: overrides.groupType ?? 'fixed_shift', timezone: 'Asia/Shanghai', rule_set_id: null }]
      }
      if (s.includes('count(*)::int as cnt from attendance_group_members')) return [{ cnt: 1 }]
      if (s.includes('from attendance_group_managers')) {
        return overrides.managerRole !== undefined ? [{ role: overrides.managerRole, cnt: 1 }] : [{ role: 'owner', cnt: 1 }]
      }
      if (s.includes('from attendance_calculation_rollout_state')) {
        return overrides.rolloutState !== undefined ? [{ state: overrides.rolloutState }] : []
      }
      if (s.includes('from attendance_group_fixed_schedule_configs')) return [{ id: configId }]
      if (s.includes('count(*)::int as cnt from attendance_shift_segments')) return [{ cnt: 1 }]
      if (s.includes('from attendance_shifts')) return [{ flex_mode: overrides.flexMode ?? 'strict' }]
      if (s.includes('from attendance_calculation_group_memberships')) return []
      if (s.includes('from attendance_rule_sets')) return []
      throw new Error(`unexpected SQL: ${sql}`)
    }
  }

  const validFser = makeFser({
    groupId,
    state: 'effective',
    reasonCodes: ['EFFECTIVE'],
    desired: { shiftId, startDate: '2026-08-01', endDate: '2026-08-31', revision: 1 },
    coverage: { targetMembers: 1, matchingMembers: 1, missingMembers: 0, nonMemberTargets: 0, differentKeyRows: 0 },
    drift: { unconfiguredManagedRows: 0, unpublishedManagedRows: 0, managedSets: [] },
    evaluatedAt: NOW,
  })

  it('unrecognized FSER state fails closed with FSER_STATE_UNRECOGNIZED (not a silent needs_configuration)', async () => {
    const query = makeQuery({})
    const fser: AttendanceGroupEffectivePolicyFserServiceLike = {
      getEffectiveness: async () => ({
        groupId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        state: 'quantum' as any,
        reasonCodes: [],
        desired: null,
        coverage: { targetMembers: 0, matchingMembers: 0, missingMembers: 0, nonMemberTargets: 0, differentKeyRows: 0 },
        drift: { unconfiguredManagedRows: 0, unpublishedManagedRows: 0, managedSets: [] },
        evaluatedAt: NOW,
      }),
    }
    const service = createAttendanceGroupEffectivePolicyAggregateService({ query, fser, now: () => NOW })
    await expect(service.getAggregate({ orgId: 'org-1', groupId })).rejects.toMatchObject({
      status: 500,
      code: 'FSER_STATE_UNRECOGNIZED',
    })
  })

  it('unrecognized group attendance_type fails closed with GROUP_TYPE_UNRECOGNIZED (not a silent free_time coercion)', async () => {
    const query = makeQuery({ groupType: 'weird_type' })
    const service = createAttendanceGroupEffectivePolicyAggregateService({ query, fser: validFser, now: () => NOW })
    await expect(service.getAggregate({ orgId: 'org-1', groupId })).rejects.toMatchObject({
      status: 500,
      code: 'GROUP_TYPE_UNRECOGNIZED',
    })
  })

  it('unrecognized manager role fails closed with MANAGER_ROLE_UNRECOGNIZED (not a silent skip)', async () => {
    const query = makeQuery({ managerRole: 'captain' })
    const service = createAttendanceGroupEffectivePolicyAggregateService({ query, fser: validFser, now: () => NOW })
    await expect(service.getAggregate({ orgId: 'org-1', groupId })).rejects.toMatchObject({
      status: 500,
      code: 'MANAGER_ROLE_UNRECOGNIZED',
    })
  })

  it('unrecognized rollout state fails closed with ROLLOUT_STATE_UNRECOGNIZED (not a silent "legacy" default)', async () => {
    const query = makeQuery({ rolloutState: 'partially_enabled' })
    const service = createAttendanceGroupEffectivePolicyAggregateService({ query, fser: validFser, now: () => NOW })
    await expect(service.getAggregate({ orgId: 'org-1', groupId })).rejects.toMatchObject({
      status: 500,
      code: 'ROLLOUT_STATE_UNRECOGNIZED',
    })
  })

  it('unrecognized shift flex_mode fails closed with FLEX_MODE_UNRECOGNIZED (not a silent "strict" default)', async () => {
    const query = makeQuery({ flexMode: 'lunar' })
    const service = createAttendanceGroupEffectivePolicyAggregateService({ query, fser: validFser, now: () => NOW })
    await expect(service.getAggregate({ orgId: 'org-1', groupId })).rejects.toMatchObject({
      status: 500,
      code: 'FLEX_MODE_UNRECOGNIZED',
    })
  })
})

/**
 * OD-W6-6(a): the lock's predicate is *"`preview_only` unless the org
 * rollout posture is `authoritative` AND `SEGMENT_CALCULATION_IMPLEMENTED`
 * is true."* This case is built to be single-segment-strict false (3
 * segments, `flex_required_duration`) so `effective` can only be reached
 * via the authoritative-and-implemented disjunct, isolated from the
 * single-segment-strict path covered elsewhere in this suite.
 */
describe('OD-W6-6(a) authoritative-and-implemented branch', () => {
  const groupId = 'a4556006-000a-4000-8000-000000000001'
  const shiftId = 'a4556006-000a-4000-8000-000000000101'
  const configId = 'a4556006-000a-4000-8000-000000000102'

  function makeAuthoritativeQuery(): AttendanceGroupEffectivePolicyQueryFn {
    return async (sql) => {
      const s = sql.toLowerCase()
      if (s.includes('from attendance_groups')) return [{ id: groupId, attendance_type: 'fixed_shift', timezone: 'Asia/Shanghai', rule_set_id: null }]
      if (s.includes('count(*)::int as cnt from attendance_group_members')) return [{ cnt: 4 }]
      if (s.includes('from attendance_group_managers')) return [{ role: 'owner', cnt: 1 }]
      if (s.includes('from attendance_calculation_rollout_state')) return [{ state: 'authoritative' }]
      if (s.includes('from attendance_group_fixed_schedule_configs')) return [{ id: configId }]
      // Deliberately NOT single-segment-strict: 3 segments, flex_required_duration.
      if (s.includes('count(*)::int as cnt from attendance_shift_segments')) return [{ cnt: 3 }]
      if (s.includes('from attendance_shifts')) return [{ flex_mode: 'flex_required_duration' }]
      if (s.includes('from attendance_calculation_group_memberships')) return []
      if (s.includes('from attendance_rule_sets')) return []
      throw new Error(`unexpected SQL: ${sql}`)
    }
  }

  const fser = makeFser({
    groupId,
    state: 'effective',
    reasonCodes: ['EFFECTIVE'],
    desired: { shiftId, startDate: '2026-08-01', endDate: '2026-08-31', revision: 1 },
    coverage: { targetMembers: 4, matchingMembers: 4, missingMembers: 0, nonMemberTargets: 0, differentKeyRows: 0 },
    drift: { unconfiguredManagedRows: 0, unpublishedManagedRows: 0, managedSets: [] },
    evaluatedAt: NOW,
  })

  it('segments/flex land effective via the authoritative-and-implemented disjunct, not the (already-covered) single-segment-strict one', async () => {
    const service = createAttendanceGroupEffectivePolicyAggregateService({
      query: makeAuthoritativeQuery(),
      fser,
      now: () => NOW,
      segmentCalculationImplemented: true,
    })
    const result = await service.getAggregate({ orgId: 'org-1', groupId })
    expect(result.calculationPosture).toBe('authoritative')
    expect(result.domains.segments.label).toBe('effective')
    expect(result.domains.segments.reasonCodes).toEqual([])
    expect(result.domains.flex.label).toBe('effective')
    expect(result.domains.flex.reasonCodes).toEqual([])
  })

  it('the SAME shape with segmentCalculationImplemented: false (authoritative alone is not enough) lands preview_only', async () => {
    const service = createAttendanceGroupEffectivePolicyAggregateService({
      query: makeAuthoritativeQuery(),
      fser,
      now: () => NOW,
      segmentCalculationImplemented: false,
    })
    const result = await service.getAggregate({ orgId: 'org-1', groupId })
    expect(result.domains.segments.label).toBe('preview_only')
    expect(result.domains.segments.reasonCodes).toEqual(['SEGMENT_CALCULATION_NOT_AUTHORITATIVE'])
    expect(result.domains.flex.label).toBe('preview_only')
    expect(result.domains.flex.reasonCodes).toEqual(['SEGMENT_CALCULATION_NOT_AUTHORITATIVE'])
  })
})


describe('W6-1 rebuild — fixtures added because their branch was uncovered', () => {
  it('reproduces aggregate-configured-scheduled-shift.json (OD-W6-6(a) on the CONFIGURED scheduled_shift path)', async () => {
    const fixture = readFixture('aggregate-configured-scheduled-shift')
    const groupId = 'a4556006-0007-4000-8000-000000000001'

    const query: AttendanceGroupEffectivePolicyQueryFn = async (sql) => {
      const s = sql.toLowerCase()
      if (s.includes('from attendance_groups')) {
        return [{ id: groupId, attendance_type: 'scheduled_shift', timezone: 'Asia/Shanghai', rule_set_id: null }]
      }
      if (s.includes('count(*)::int as cnt from attendance_group_members')) return [{ cnt: 8 }]
      if (s.includes('from attendance_group_managers')) return [{ role: 'owner', cnt: 1 }, { role: 'sub_owner', cnt: 1 }]
      if (s.includes('from attendance_calculation_rollout_state')) return [{ state: 'legacy' }]
      // CONFIGURED: an active advanced-scheduling row exists.
      if (s.includes('from attendance_schedule_groups')) return [{ ok: 1 }]
      if (s.includes('from attendance_calculation_group_memberships')) return []
      if (s.includes('from attendance_rule_sets')) return [{ exists: 1 }]
      throw new Error(`unexpected SQL: ${sql}`)
    }
    const fser: AttendanceGroupEffectivePolicyFserServiceLike = {
      getEffectiveness: async () => {
        throw new Error('FSER must not be called for a scheduled_shift group')
      },
    }
    const service = createAttendanceGroupEffectivePolicyAggregateService({
      query,
      fser,
      now: () => NOW,
      segmentCalculationImplemented: false,
    })
    expect(await service.getAggregate({ orgId: 'org-1', groupId })).toStrictEqual(fixture.data)
  })

  it('the SAME configured scheduled_shift group under authoritative posture + flag TRUE is effective (proves the gate is the posture, not the branch)', async () => {
    const groupId = 'a4556006-0007-4000-8000-000000000001'
    const query: AttendanceGroupEffectivePolicyQueryFn = async (sql) => {
      const s = sql.toLowerCase()
      if (s.includes('from attendance_groups')) {
        return [{ id: groupId, attendance_type: 'scheduled_shift', timezone: 'Asia/Shanghai', rule_set_id: null }]
      }
      if (s.includes('count(*)::int as cnt from attendance_group_members')) return [{ cnt: 8 }]
      if (s.includes('from attendance_group_managers')) return [{ role: 'owner', cnt: 1 }, { role: 'sub_owner', cnt: 1 }]
      if (s.includes('from attendance_calculation_rollout_state')) return [{ state: 'authoritative' }]
      if (s.includes('from attendance_schedule_groups')) return [{ ok: 1 }]
      if (s.includes('from attendance_calculation_group_memberships')) return []
      if (s.includes('from attendance_rule_sets')) return [{ exists: 1 }]
      throw new Error(`unexpected SQL: ${sql}`)
    }
    const fser: AttendanceGroupEffectivePolicyFserServiceLike = {
      getEffectiveness: async () => {
        throw new Error('FSER must not be called for a scheduled_shift group')
      },
    }
    const service = createAttendanceGroupEffectivePolicyAggregateService({
      query,
      fser,
      now: () => NOW,
      segmentCalculationImplemented: true,
    })
    const result = await service.getAggregate({ orgId: 'org-1', groupId })
    expect(result.domains.segments.label).toBe('effective')
    expect(result.domains.segments.reasonCodes).toEqual([])
    expect(result.domains.flex.label).toBe('effective')
  })

  it('reproduces aggregate-conflict-unpublished-managed-row.json (gives a RATIFIED conflict code its producer; null endDate round-trips)', async () => {
    const fixture = readFixture('aggregate-conflict-unpublished-managed-row')
    const groupId = 'a4556006-0008-4000-8000-000000000001'
    const shiftId = 'a4556006-0008-4000-8000-000000000101'
    const configId = 'a4556006-0008-4000-8000-000000000102'

    const query: AttendanceGroupEffectivePolicyQueryFn = async (sql) => {
      const s = sql.toLowerCase()
      if (s.includes('from attendance_groups')) {
        return [{ id: groupId, attendance_type: 'fixed_shift', timezone: 'Asia/Shanghai', rule_set_id: null }]
      }
      if (s.includes('count(*)::int as cnt from attendance_group_members')) return [{ cnt: 12 }]
      if (s.includes('from attendance_group_managers')) return [{ role: 'owner', cnt: 1 }]
      if (s.includes('from attendance_calculation_rollout_state')) return []
      if (s.includes('from attendance_group_fixed_schedule_configs')) return [{ id: configId }]
      if (s.includes('count(*)::int as cnt from attendance_shift_segments')) return [{ cnt: 1 }]
      if (s.includes('from attendance_shifts')) return [{ flex_mode: 'strict' }]
      if (s.includes('from attendance_calculation_group_memberships')) return []
      if (s.includes('from attendance_rule_sets')) return [{ exists: 1 }]
      throw new Error(`unexpected SQL: ${sql}`)
    }
    const fser = makeFser({
      groupId,
      // FSER's own `effective` predicate deliberately EXCLUDES unpublished
      // rows, so this shape is what FSER really returns for the scenario.
      state: 'effective',
      reasonCodes: ['UNPUBLISHED_MANAGED_ROW', 'EFFECTIVE'],
      desired: { shiftId, startDate: '2026-08-01', endDate: null, revision: 1 },
      coverage: { targetMembers: 12, matchingMembers: 12, missingMembers: 0, nonMemberTargets: 0, differentKeyRows: 0 },
      drift: {
        unconfiguredManagedRows: 0,
        unpublishedManagedRows: 3,
        managedSets: [
          {
            shiftId,
            startDate: '2026-08-01',
            endDate: null,
            producerKey: `attendance_group_fixed_schedule:${groupId}:${shiftId}:2026-08-01:null`,
            rowCount: 3,
          },
        ],
      },
      evaluatedAt: NOW,
    })
    const service = createAttendanceGroupEffectivePolicyAggregateService({ query, fser, now: () => NOW })
    expect(await service.getAggregate({ orgId: 'org-1', groupId })).toStrictEqual(fixture.data)
  })

  it('POSITIVE CONTROL for the null-endDate P1: the byte-identical shape with a NON-null endDate also round-trips', async () => {
    // The P1 was a validator stricter than its producer: a legal open-ended
    // managed row (endDate null) made `getAggregate` throw a 500
    // AGGREGATE_CONTRACT_VIOLATION. This pairs the null case above with the
    // non-null case so a future re-narrowing cannot be mistaken for
    // "the null case never worked".
    const groupId = 'a4556006-0008-4000-8000-000000000001'
    const shiftId = 'a4556006-0008-4000-8000-000000000101'
    const query: AttendanceGroupEffectivePolicyQueryFn = async (sql) => {
      const s = sql.toLowerCase()
      if (s.includes('from attendance_groups')) {
        return [{ id: groupId, attendance_type: 'fixed_shift', timezone: 'Asia/Shanghai', rule_set_id: null }]
      }
      if (s.includes('count(*)::int as cnt from attendance_group_members')) return [{ cnt: 12 }]
      if (s.includes('from attendance_group_managers')) return [{ role: 'owner', cnt: 1 }]
      if (s.includes('from attendance_calculation_rollout_state')) return []
      if (s.includes('from attendance_group_fixed_schedule_configs')) return [{ id: 'a4556006-0008-4000-8000-000000000102' }]
      if (s.includes('count(*)::int as cnt from attendance_shift_segments')) return [{ cnt: 1 }]
      if (s.includes('from attendance_shifts')) return [{ flex_mode: 'strict' }]
      if (s.includes('from attendance_calculation_group_memberships')) return []
      if (s.includes('from attendance_rule_sets')) return [{ exists: 1 }]
      throw new Error(`unexpected SQL: ${sql}`)
    }
    for (const endDate of [null, '2026-08-31']) {
      const fser = makeFser({
        groupId,
        state: 'effective',
        reasonCodes: ['EFFECTIVE'],
        desired: { shiftId, startDate: '2026-08-01', endDate, revision: 1 },
        coverage: { targetMembers: 12, matchingMembers: 12, missingMembers: 0, nonMemberTargets: 0, differentKeyRows: 0 },
        drift: {
          unconfiguredManagedRows: 0,
          unpublishedManagedRows: 0,
          managedSets: [
            {
              shiftId,
              startDate: '2026-08-01',
              endDate,
              producerKey: `attendance_group_fixed_schedule:${groupId}:${shiftId}:2026-08-01:${endDate ?? 'null'}`,
              rowCount: 1,
            },
          ],
        },
        evaluatedAt: NOW,
      })
      const service = createAttendanceGroupEffectivePolicyAggregateService({ query, fser, now: () => NOW })
      const result = await service.getAggregate({ orgId: 'org-1', groupId })
      expect(result.domains.schedule.fixedSchedule?.desired?.endDate).toBe(endDate)
      expect(result.domains.schedule.fixedSchedule?.drift.managedSets[0].endDate).toBe(endDate)
    }
  })
})

describe('W6-R5 — the membership-overlap SQL is pinned, so a choose-first/choose-latest rewrite reds without a DB', () => {
  it('is the exact per-user-dedup shape: GROUP BY, no ORDER BY, no LIMIT, no DISTINCT ON', () => {
    // Text pin FIRST so the diff names the offending rewrite...
    expect(ATTENDANCE_GROUP_MEMBERSHIP_OVERLAP_SQL_V1).toBe(`SELECT COUNT(*)::int AS cnt
         FROM (
           SELECT m.user_id
             FROM attendance_calculation_group_memberships m
            WHERE m.org_id = $1
              AND m.group_id = $2
              AND m.effective_from <= CURRENT_DATE
              AND (m.effective_to IS NULL OR m.effective_to >= CURRENT_DATE)
            GROUP BY m.user_id
         ) this_group
        WHERE (
          SELECT COUNT(*)
            FROM attendance_calculation_group_memberships other
           WHERE other.org_id = $1
             AND other.user_id = this_group.user_id
             AND other.effective_from <= CURRENT_DATE
             AND (other.effective_to IS NULL OR other.effective_to >= CURRENT_DATE)
        ) > 1`)
    // ...and the shape properties separately, so the pin cannot be
    // "repaired" by pasting a mutated string back in without noticing.
    const sql = ATTENDANCE_GROUP_MEMBERSHIP_OVERLAP_SQL_V1.toLowerCase()
    expect(sql).toContain('group by m.user_id')
    expect(sql).toContain('and m.group_id = $2')
    expect(sql).not.toContain('order by')
    expect(sql).not.toContain('limit')
    expect(sql).not.toContain('distinct on')
  })

  it("the service really issues THAT string (the pin is not describing a constant nobody uses)", async () => {
    const seen: string[] = []
    const query: AttendanceGroupEffectivePolicyQueryFn = async (sql) => {
      seen.push(sql)
      const s = sql.toLowerCase()
      if (s.includes('from attendance_groups')) {
        return [{ id: 'g', attendance_type: 'free_time', timezone: 'Asia/Shanghai', rule_set_id: null }]
      }
      if (s.includes('from attendance_group_managers')) return []
      if (s.includes('from attendance_calculation_rollout_state')) return []
      if (s.includes('from attendance_rule_sets')) return [{ exists: 1 }]
      return []
    }
    const fser: AttendanceGroupEffectivePolicyFserServiceLike = {
      getEffectiveness: async () => {
        throw new Error('FSER must not be called for a free_time group')
      },
    }
    const service = createAttendanceGroupEffectivePolicyAggregateService({ query, fser, now: () => NOW })
    await service.getAggregate({ orgId: 'org-1', groupId: 'g' })
    expect(seen).toContain(ATTENDANCE_GROUP_MEMBERSHIP_OVERLAP_SQL_V1)
  })
})

describe('NIT-2 — one injected clock feeds both timestamps in a response', () => {
  it('the aggregate evaluatedAt and the embedded fixedSchedule evaluatedAt come from the SAME injected now()', async () => {
    const groupId = 'a4556006-0009-4000-8000-000000000001'
    const shiftId = 'a4556006-0009-4000-8000-000000000101'
    let ticks = 0
    // A clock that ADVANCES on every read: if the two timestamps came from
    // two different clocks (the shipped defect) this test could still pass by
    // luck with a constant clock, so the clock is made discriminating.
    const now = () => `2026-08-05T00:00:0${ticks++}.000Z`
    const stamp = now()
    ticks = 0
    const query: AttendanceGroupEffectivePolicyQueryFn = async (sql) => {
      const s = sql.toLowerCase()
      if (s.includes('from attendance_groups')) {
        return [{ id: groupId, attendance_type: 'fixed_shift', timezone: 'Asia/Shanghai', rule_set_id: null }]
      }
      if (s.includes('count(*)::int as cnt from attendance_group_members')) return [{ cnt: 1 }]
      if (s.includes('from attendance_group_managers')) return []
      if (s.includes('from attendance_calculation_rollout_state')) return []
      if (s.includes('from attendance_group_fixed_schedule_configs')) return [{ id: 'cfg' }]
      if (s.includes('count(*)::int as cnt from attendance_shift_segments')) return [{ cnt: 1 }]
      if (s.includes('from attendance_shifts')) return [{ flex_mode: 'strict' }]
      if (s.includes('from attendance_calculation_group_memberships')) return []
      if (s.includes('from attendance_rule_sets')) return [{ exists: 1 }]
      throw new Error(`unexpected SQL: ${sql}`)
    }
    // The FSER stand-in reads the SAME injected clock the route now hands it.
    const fser: AttendanceGroupEffectivePolicyFserServiceLike = {
      getEffectiveness: async () => ({
        groupId,
        state: 'effective' as const,
        reasonCodes: ['EFFECTIVE'],
        desired: { shiftId, startDate: '2026-08-01', endDate: null, revision: 1 },
        coverage: { targetMembers: 1, matchingMembers: 1, missingMembers: 0, nonMemberTargets: 0, differentKeyRows: 0 },
        drift: { unconfiguredManagedRows: 0, unpublishedManagedRows: 0, managedSets: [] },
        evaluatedAt: now(),
      }),
    }
    const service = createAttendanceGroupEffectivePolicyAggregateService({ query, fser, now })
    const result = await service.getAggregate({ orgId: 'org-1', groupId })
    expect(stamp).toBe('2026-08-05T00:00:00.000Z')
    // Same clock source => the two stamps are consecutive reads of ONE
    // sequence, never two unrelated sequences both starting at tick 0.
    expect(result.evaluatedAt).toBe('2026-08-05T00:00:00.000Z')
    expect(result.domains.schedule.fixedSchedule?.evaluatedAt).toBe('2026-08-05T00:00:01.000Z')
  })
})

describe('W6-R4 — the schedule label is a PURE FUNCTION of FSER state (no parallel predicate)', () => {
  /**
   * The caller inventory cannot catch a hand-rolled parallel state machine
   * that never references FSER by name, and the real-DB fidelity leg compares
   * the EMBEDDED object — which stays verbatim even when a second predicate
   * hijacks the LABEL. Proven by mutation: replacing the mapping with
   * `fser.coverage.differentKeyRows > 0 ? conflict : mapping(state)` left every
   * suite green, including the real-DB fidelity test, because no fixture drives
   * that field on a state where the two disagree.
   *
   * This matrix closes it: for each FSER state, every OTHER field of the FSER
   * result is varied across values a plausible second predicate would key on,
   * and the label must not move. The ONE intentional second input is
   * `drift.unpublishedManagedRows` (§4.2's orphaned conflict code, given a
   * producer in this rebuild), so it is held at 0 here and pinned by its own
   * fixture instead.
   */
  const STATE_TO_LABEL = {
    effective: 'effective',
    not_configured: 'needs_configuration',
    pending_apply: 'conflict_action_required',
    configuration_changed: 'conflict_action_required',
  } as const

  const HIJACK_VECTORS = [
    { label: 'baseline', coverage: {}, drift: {} },
    { label: 'differentKeyRows > 0', coverage: { differentKeyRows: 2 }, drift: {} },
    { label: 'missingMembers > 0', coverage: { missingMembers: 3 }, drift: {} },
    { label: 'nonMemberTargets > 0', coverage: { nonMemberTargets: 1 }, drift: {} },
    { label: 'matchingMembers = 0', coverage: { matchingMembers: 0 }, drift: {} },
    { label: 'unconfiguredManagedRows > 0', coverage: {}, drift: { unconfiguredManagedRows: 4 } },
  ]

  const groupId = 'a4556006-000c-4000-8000-000000000001'
  const shiftId = 'a4556006-000c-4000-8000-000000000101'

  const query: AttendanceGroupEffectivePolicyQueryFn = async (sql) => {
    const s = sql.toLowerCase()
    if (s.includes('from attendance_groups')) {
      return [{ id: groupId, attendance_type: 'fixed_shift', timezone: 'Asia/Shanghai', rule_set_id: null }]
    }
    if (s.includes('count(*)::int as cnt from attendance_group_members')) return [{ cnt: 4 }]
    if (s.includes('from attendance_group_managers')) return []
    if (s.includes('from attendance_calculation_rollout_state')) return []
    if (s.includes('from attendance_group_fixed_schedule_configs')) return [{ id: 'cfg-1' }]
    if (s.includes('count(*)::int as cnt from attendance_shift_segments')) return [{ cnt: 1 }]
    if (s.includes('from attendance_shifts')) return [{ flex_mode: 'strict' }]
    if (s.includes('from attendance_calculation_group_memberships')) return []
    if (s.includes('from attendance_rule_sets')) return [{ exists: 1 }]
    throw new Error(`unexpected SQL: ${sql}`)
  }

  for (const [state, expectedLabel] of Object.entries(STATE_TO_LABEL)) {
    for (const vector of HIJACK_VECTORS) {
      it(`state=${state} + ${vector.label} still labels ${expectedLabel}`, async () => {
        const fser = makeFser({
          groupId,
          state: state as keyof typeof STATE_TO_LABEL,
          reasonCodes: state === 'effective' ? ['EFFECTIVE'] : ['TARGET_MEMBER_MISSING'],
          desired:
            state === 'not_configured'
              ? null
              : { shiftId, startDate: '2026-08-01', endDate: '2026-08-31', revision: 1 },
          coverage: {
            targetMembers: 4,
            matchingMembers: 4,
            missingMembers: 0,
            nonMemberTargets: 0,
            differentKeyRows: 0,
            ...vector.coverage,
          },
          drift: { unconfiguredManagedRows: 0, unpublishedManagedRows: 0, managedSets: [], ...vector.drift },
          evaluatedAt: NOW,
        })
        const service = createAttendanceGroupEffectivePolicyAggregateService({ query, fser, now: () => NOW })
        const result = await service.getAggregate({ orgId: 'org-1', groupId })
        expect(result.domains.schedule.label).toBe(expectedLabel)
      })
    }
  }

  it('POSITIVE CONTROL: the matrix IS sensitive to the state itself (so "label never moves" is not vacuous)', async () => {
    const labels = new Set(Object.values(STATE_TO_LABEL))
    expect(labels.size).toBeGreaterThan(1)
  })
})
