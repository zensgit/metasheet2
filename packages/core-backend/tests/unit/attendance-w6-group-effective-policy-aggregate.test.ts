/**
 * W6-1 (#4556) — group effective-policy aggregate service: fake-DB
 * (in-memory) functional proof. Reproduces every `aggregate-*.json`
 * fixture from the W6-0 pack via a scripted query router + a fake FSER
 * service, byte-exact (`toStrictEqual`) against the fixture's `data`.
 *
 * This is the fast, DB-free correctness proof; the real-DB integration
 * test (`tests/integration/attendance-w6-group-effective-policy.db.test.ts`)
 * re-proves the same shapes against real PostgreSQL plus the red-line
 * negative/mutation evidence (R1/R3/R4/R5).
 *
 * KNOWN FIXTURE DEVIATION (flagged, not silently reproduced): the W6-0
 * `aggregate-conflict-membership-overlap.json` fixture's
 * `domains.schedule.sourceRefs` omits the `fixed_schedule_config` ref that
 * every other `fixed_shift`+FSER-effective fixture (1 and 6) includes,
 * despite an identical `fixedSchedule.desired` shape. No trigger condition
 * distinguishes it; this looks like an authoring omission in the
 * never-executed PROPOSED pack (README: "nothing here comes from
 * production"). This suite reproduces the CONSISTENT rule (always include
 * `fixed_schedule_config` once a config row is resolved) and asserts
 * against a corrected expectation for that one field only — see the test
 * named accordingly.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildFixedScheduleProducerKey,
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
  desired: { shiftId: string; startDate: string; endDate: string; revision: number } | null
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

  it('reproduces aggregate-conflict-membership-overlap.json EXCEPT the flagged sourceRefs deviation', async () => {
    const fixture = readFixture('aggregate-conflict-membership-overlap')
    const groupId = 'a4556006-0005-4000-8000-000000000001'
    const shiftId = 'a4556006-0005-4000-8000-000000000101'
    const configId = 'a4556006-0005-4000-8000-000000000199' // synthetic — fixture omits this ref (see file header)

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

    const expected = structuredClone(fixture.data) as Record<string, unknown>
    const domains = expected.domains as Record<string, unknown>
    ;(domains.schedule as Record<string, unknown>).sourceRefs = [
      { kind: 'shift', id: shiftId },
      { kind: 'fixed_schedule_config', id: configId },
    ]
    expect(result).not.toStrictEqual(fixture.data) // proves the deviation is real, not a typo
    expect(result).toStrictEqual(expected)
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
 * W6-R6 (#4814 P2-1): "a silent-fallback mutation (unknown → `needs_configuration`
 * or unknown → default) turns a test red." Each of the five internal
 * enum reads the service does over data it does NOT itself validate on the
 * way in (group type, manager role, rollout state, FSER state, shift flex
 * mode) fails closed with a named error code rather than silently mapping
 * an unrecognized value to a label or a default. None of these five is
 * reachable through today's CHECK constraints or FSER's own closed state
 * machine — that is exactly why they are defence in depth, and exactly why
 * an untested one can rot silently (gate M1/M2). Each case below asserts
 * the SPECIFIC error code (not a bare `toThrow()`, which would also pass on
 * an unrelated crash) and is built by taking the minimal valid "effective
 * fixed_shift" shape and flipping exactly one field to an out-of-enum
 * value, so a revert of any one guard back to a silent fallback reds
 * exactly its own case.
 */
describe('W6-1 group effective-policy aggregate — fail-closed enum guards (#4814 P2-1)', () => {
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

  it('M1 — unrecognized FSER state fails closed with FSER_STATE_UNRECOGNIZED (not a silent needs_configuration)', async () => {
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

  it('unrecognized shift flex_mode fails closed with FLEX_MODE_UNRECOGNIZED (not a silent "strict" default — #4814 P3-4)', async () => {
    const query = makeQuery({ flexMode: 'lunar' })
    const service = createAttendanceGroupEffectivePolicyAggregateService({ query, fser: validFser, now: () => NOW })
    await expect(service.getAggregate({ orgId: 'org-1', groupId })).rejects.toMatchObject({
      status: 500,
      code: 'FLEX_MODE_UNRECOGNIZED',
    })
  })
})

/**
 * OD-W6-6(a) (#4814 P3-2a): the lock's predicate is *"`preview_only` unless
 * the org rollout posture is `authoritative` AND
 * `SEGMENT_CALCULATION_IMPLEMENTED` is true."* Every `aggregate-*.json`
 * fixture leaves `attendance_calculation_rollout_state` empty (posture
 * always `legacy`) and no test injects `segmentCalculationImplemented:
 * true`, so the `authoritativeAndImplemented` half of the disjunct in
 * `getAggregate` never executed in this suite — a mutation neutering it
 * would have stayed green. This case is built to be single-segment-strict
 * FALSE (3 segments, `flex_required_duration`) so `effective` can ONLY be
 * reached via the authoritative-and-implemented disjunct, isolating it
 * from the already-covered single-segment-strict path.
 */
describe('OD-W6-6(a) authoritative-and-implemented branch (#4814 P3-2a — was untested)', () => {
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

/**
 * `buildFixedScheduleProducerKey`'s own doc comment (this file's module
 * header, ~L138-141) cites "the parity test
 * (`attendance-w6-group-effective-policy-aggregate.test.ts`, 'producer key
 * parity')" as where its equivalence-to-the-canonical-builder claim is
 * proven — no such test existed (an asserted invariant with no test is a
 * hidden bug waiting to happen). This is that test: it LITERALLY PINS the
 * exact output format, so a format change (separator, field order,
 * null-handling) reds here directly, rather than only being
 * discriminated indirectly through a real-DB seed/match round-trip (as
 * confirmed separately: mutating the join separator from ':' to '|' reds
 * the real-DB happy-path fidelity test too, via FSER's own producer-key
 * row-matching — this unit test is the FAST, DB-free version of that same
 * discrimination).
 */
describe('producer key parity — buildFixedScheduleProducerKey literal pin', () => {
  it('joins groupId:shiftId:startDate:endDate with the canonical "attendance_group_fixed_schedule" prefix', () => {
    expect(
      buildFixedScheduleProducerKey({
        groupId: 'a4556006-000b-4000-8000-000000000001',
        shiftId: 'a4556006-000b-4000-8000-000000000101',
        startDate: '2026-08-01',
        endDate: '2026-08-31',
      }),
    ).toBe('attendance_group_fixed_schedule:a4556006-000b-4000-8000-000000000001:a4556006-000b-4000-8000-000000000101:2026-08-01:2026-08-31')
  })

  it('a null endDate is joined as the literal string "null"', () => {
    expect(
      buildFixedScheduleProducerKey({
        groupId: 'a4556006-000b-4000-8000-000000000001',
        shiftId: 'a4556006-000b-4000-8000-000000000101',
        startDate: '2026-08-01',
        endDate: null,
      }),
    ).toBe('attendance_group_fixed_schedule:a4556006-000b-4000-8000-000000000001:a4556006-000b-4000-8000-000000000101:2026-08-01:null')
  })
})
