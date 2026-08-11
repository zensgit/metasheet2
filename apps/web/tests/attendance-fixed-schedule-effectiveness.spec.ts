// #4709 FSER-4 §3 (amendment `docs/development/
// attendance-4709-fser4-member-projection-contract-amendment-20260804.md`, RATIFIED
// `45d71c4209af35a63768ce7ce9f576377f6b8ce4`, OD-4709-2=(a)): pure-parser matrix + fetch-composable
// contract for the ONE shared client/composable both response shapes go through. All fixtures are
// SYNTHETIC (no real user data). Gate references are to the amendment's §4 completion gates.
import { describe, expect, it, vi } from 'vitest'
import {
  ATTENDANCE_FIXED_SCHEDULE_APPLICABILITIES,
  ATTENDANCE_FIXED_SCHEDULE_REASON_CODES,
  ATTENDANCE_FIXED_SCHEDULE_STATES,
  attendanceFixedScheduleApplicabilityLabel,
  attendanceFixedScheduleReasonCodeLabel,
  attendanceFixedScheduleStateClass,
  attendanceFixedScheduleStateLabel,
  isAttendanceFixedScheduleApplicability,
  isAttendanceFixedScheduleReasonCode,
  isAttendanceFixedScheduleState,
  parseAttendanceGroupFixedScheduleAdminResponse,
  parseAttendanceGroupFixedScheduleSelfResponse,
} from '../src/views/attendance/attendanceFixedScheduleEffectiveness'
import {
  buildAttendanceGroupFixedScheduleAdminPath,
  buildAttendanceGroupFixedScheduleSelfPath,
  useAttendanceFixedScheduleEffectiveness,
} from '../src/views/attendance/useAttendanceFixedScheduleEffectiveness'

const trZh = (_en: string, zh: string): string => zh
const trEn = (en: string, _zh: string): string => en

const GROUP_ID = '2f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f'

function adminFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    groupId: GROUP_ID,
    state: 'pending_apply',
    reasonCodes: ['TARGET_MEMBER_MISSING'],
    desired: { shiftId: 'shift-1', startDate: '2026-08-01', endDate: '2026-08-31', revision: 2 },
    coverage: { targetMembers: 12, matchingMembers: 11, missingMembers: 1, nonMemberTargets: 0, differentKeyRows: 0 },
    drift: { unconfiguredManagedRows: 0, unpublishedManagedRows: 0, managedSets: [] },
    evaluatedAt: '2026-08-05T00:00:00.000Z',
    ...overrides,
  }
}

function selfFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    groupId: GROUP_ID,
    state: 'pending_apply',
    reasonCodes: ['TARGET_MEMBER_MISSING'],
    desired: { shiftId: 'shift-1', startDate: '2026-08-01', endDate: '2026-08-31', revision: 2 },
    applicability: 'non_matching',
    evaluatedAt: '2026-08-05T00:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------------------------
// Enum guards
// ---------------------------------------------------------------------------------------------

describe('enum guards — closed sets, unknown values rejected', () => {
  it('accepts every declared state and rejects unknowns', () => {
    for (const state of ATTENDANCE_FIXED_SCHEDULE_STATES) {
      expect(isAttendanceFixedScheduleState(state)).toBe(true)
    }
    expect(isAttendanceFixedScheduleState('applied')).toBe(false)
    expect(isAttendanceFixedScheduleState('PENDING_APPLY')).toBe(false)
    expect(isAttendanceFixedScheduleState(null)).toBe(false)
    expect(isAttendanceFixedScheduleState(undefined)).toBe(false)
    expect(isAttendanceFixedScheduleState(1)).toBe(false)
  })

  it('accepts every declared reason code and rejects unknowns', () => {
    for (const code of ATTENDANCE_FIXED_SCHEDULE_REASON_CODES) {
      expect(isAttendanceFixedScheduleReasonCode(code)).toBe(true)
    }
    expect(isAttendanceFixedScheduleReasonCode('UNKNOWN_REASON')).toBe(false)
    expect(isAttendanceFixedScheduleReasonCode('')).toBe(false)
  })

  it('accepts every declared applicability and rejects unknowns', () => {
    for (const value of ATTENDANCE_FIXED_SCHEDULE_APPLICABILITIES) {
      expect(isAttendanceFixedScheduleApplicability(value)).toBe(true)
    }
    expect(isAttendanceFixedScheduleApplicability('applicable')).toBe(false)
    expect(isAttendanceFixedScheduleApplicability('MATCHING')).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// Admin aggregate parser
// ---------------------------------------------------------------------------------------------

describe('parseAttendanceGroupFixedScheduleAdminResponse', () => {
  it('parses a fully valid fixture into the exact typed shape', () => {
    expect(parseAttendanceGroupFixedScheduleAdminResponse(adminFixture())).toEqual({
      groupId: GROUP_ID,
      state: 'pending_apply',
      reasonCodes: ['TARGET_MEMBER_MISSING'],
      desired: { shiftId: 'shift-1', startDate: '2026-08-01', endDate: '2026-08-31', revision: 2 },
      coverage: { targetMembers: 12, matchingMembers: 11, missingMembers: 1, nonMemberTargets: 0, differentKeyRows: 0 },
      drift: { unconfiguredManagedRows: 0, unpublishedManagedRows: 0, managedSets: [] },
      evaluatedAt: '2026-08-05T00:00:00.000Z',
    })
  })

  it('accepts a null desired (not_configured) and a populated managedSets entry', () => {
    const fixture = adminFixture({
      state: 'not_configured',
      reasonCodes: ['NO_DESIRED_CONFIG'],
      desired: null,
      drift: {
        unconfiguredManagedRows: 2,
        unpublishedManagedRows: 0,
        managedSets: [{ shiftId: 'shift-9', startDate: '2026-07-01', endDate: '2026-07-31', producerKey: 'k1', rowCount: 3 }],
      },
    })
    const parsed = parseAttendanceGroupFixedScheduleAdminResponse(fixture)
    expect(parsed?.desired).toBeNull()
    expect(parsed?.drift.managedSets).toEqual([
      { shiftId: 'shift-9', startDate: '2026-07-01', endDate: '2026-07-31', producerKey: 'k1', rowCount: 3 },
    ])
  })

  it('rejects a non-object payload', () => {
    expect(parseAttendanceGroupFixedScheduleAdminResponse(null)).toBeNull()
    expect(parseAttendanceGroupFixedScheduleAdminResponse('nope')).toBeNull()
    expect(parseAttendanceGroupFixedScheduleAdminResponse([adminFixture()])).toBeNull()
  })

  it('rejects an unknown state value (enum-strict — never falls back to a default state)', () => {
    expect(parseAttendanceGroupFixedScheduleAdminResponse(adminFixture({ state: 'applied' }))).toBeNull()
  })

  it('rejects an unknown reasonCodes entry', () => {
    expect(parseAttendanceGroupFixedScheduleAdminResponse(adminFixture({ reasonCodes: ['NOT_A_REAL_CODE'] }))).toBeNull()
  })

  it.each(['groupId', 'coverage', 'drift', 'evaluatedAt'])('rejects a payload missing required field %s', (field) => {
    const fixture = adminFixture()
    delete (fixture as any)[field]
    expect(parseAttendanceGroupFixedScheduleAdminResponse(fixture)).toBeNull()
  })

  it('rejects a coverage object with a non-numeric field', () => {
    expect(
      parseAttendanceGroupFixedScheduleAdminResponse(
        adminFixture({ coverage: { targetMembers: '12', matchingMembers: 11, missingMembers: 1, nonMemberTargets: 0, differentKeyRows: 0 } }),
      ),
    ).toBeNull()
  })

  it('rejects a malformed managedSets entry', () => {
    expect(
      parseAttendanceGroupFixedScheduleAdminResponse(
        adminFixture({ drift: { unconfiguredManagedRows: 0, unpublishedManagedRows: 0, managedSets: [{ shiftId: 'x' }] } }),
      ),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// Self projection parser — gate 6 (exact-key rejection at any nesting depth)
// ---------------------------------------------------------------------------------------------

describe('parseAttendanceGroupFixedScheduleSelfResponse', () => {
  it('parses a fully valid fixture into the exact typed shape', () => {
    expect(parseAttendanceGroupFixedScheduleSelfResponse(selfFixture())).toEqual({
      groupId: GROUP_ID,
      state: 'pending_apply',
      reasonCodes: ['TARGET_MEMBER_MISSING'],
      desired: { shiftId: 'shift-1', startDate: '2026-08-01', endDate: '2026-08-31', revision: 2 },
      applicability: 'non_matching',
      evaluatedAt: '2026-08-05T00:00:00.000Z',
    })
  })

  it('rejects an unknown applicability value (enum-strict)', () => {
    expect(parseAttendanceGroupFixedScheduleSelfResponse(selfFixture({ applicability: 'applicable' }))).toBeNull()
  })

  it.each(['coverage', 'drift', 'managedSets', 'producerKey', 'userId', 'user_id', 'subjectId', 'targetUserId', 'members'])(
    'gate 6: rejects a top-level forbidden key %s even when every required field is otherwise valid',
    (key) => {
      const fixture = selfFixture({ [key]: key === 'managedSets' || key === 'members' ? [] : 'leak' })
      expect(parseAttendanceGroupFixedScheduleSelfResponse(fixture)).toBeNull()
    },
  )

  it('gate 6: rejects a forbidden key nested inside `desired` (any nesting depth)', () => {
    const fixture = selfFixture({
      desired: { shiftId: 'shift-1', startDate: '2026-08-01', endDate: '2026-08-31', revision: 2, producerKey: 'leak' },
    })
    expect(parseAttendanceGroupFixedScheduleSelfResponse(fixture)).toBeNull()
  })

  it('gate 6: rejects a forbidden key nested inside an array element at any depth', () => {
    const fixture = selfFixture({ nested: [{ inner: { userId: 'leak' } }] })
    expect(parseAttendanceGroupFixedScheduleSelfResponse(fixture)).toBeNull()
  })

  it('does NOT fail on an unrecognized, non-forbidden extra key — parser is strict on named fields, not narrower than the contract', () => {
    const fixture = selfFixture({ futureOptionalField: 'anything' })
    expect(parseAttendanceGroupFixedScheduleSelfResponse(fixture)).toEqual({
      groupId: GROUP_ID,
      state: 'pending_apply',
      reasonCodes: ['TARGET_MEMBER_MISSING'],
      desired: { shiftId: 'shift-1', startDate: '2026-08-01', endDate: '2026-08-31', revision: 2 },
      applicability: 'non_matching',
      evaluatedAt: '2026-08-05T00:00:00.000Z',
    })
  })

  it('rejects a payload missing a required field', () => {
    const fixture = selfFixture()
    delete (fixture as any).applicability
    expect(parseAttendanceGroupFixedScheduleSelfResponse(fixture)).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// Gate 5 (frontend analogue): the two parse paths agree over the same fixture/instant.
// The real-DB parity assertion lives in
// packages/core-backend/tests/integration/attendance-group-fixed-schedule-self-effectiveness.db.test.ts
// ("PARITY"); this proves OUR parser doesn't introduce disagreement on the client side.
// ---------------------------------------------------------------------------------------------

describe('gate 5 (frontend) — admin and self parse paths agree over one fixture/instant', () => {
  it('state, reasonCodes, and desired.revision are identical across both parsed results', () => {
    const admin = parseAttendanceGroupFixedScheduleAdminResponse(adminFixture())
    const self = parseAttendanceGroupFixedScheduleSelfResponse(selfFixture())
    expect(admin).not.toBeNull()
    expect(self).not.toBeNull()
    expect(self!.state).toBe(admin!.state)
    expect(self!.reasonCodes).toEqual(admin!.reasonCodes)
    expect(self!.desired).toEqual(admin!.desired)
    expect(self!.evaluatedAt).toBe(admin!.evaluatedAt)
  })
})

// ---------------------------------------------------------------------------------------------
// Display tables — every state/applicability/reasonCode has a label; classes are stable strings.
// ---------------------------------------------------------------------------------------------

describe('display tables (zh + en legs)', () => {
  it('every state has a non-empty label and a stable class in both locales', () => {
    for (const state of ATTENDANCE_FIXED_SCHEDULE_STATES) {
      expect(attendanceFixedScheduleStateLabel(state, trEn).length).toBeGreaterThan(0)
      expect(attendanceFixedScheduleStateLabel(state, trZh).length).toBeGreaterThan(0)
      expect(attendanceFixedScheduleStateClass(state)).toMatch(/^attendance-fs-state--/)
    }
  })

  it('every applicability has a non-empty label in both locales', () => {
    for (const value of ATTENDANCE_FIXED_SCHEDULE_APPLICABILITIES) {
      expect(attendanceFixedScheduleApplicabilityLabel(value, trEn).length).toBeGreaterThan(0)
      expect(attendanceFixedScheduleApplicabilityLabel(value, trZh).length).toBeGreaterThan(0)
    }
  })

  it('every reason code has a non-empty label in both locales', () => {
    for (const code of ATTENDANCE_FIXED_SCHEDULE_REASON_CODES) {
      expect(attendanceFixedScheduleReasonCodeLabel(code, trEn).length).toBeGreaterThan(0)
      expect(attendanceFixedScheduleReasonCodeLabel(code, trZh).length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Path builders — GET only, groupId in the path, ZERO query string.
// ---------------------------------------------------------------------------------------------

describe('path builders — no query string, no body, ever', () => {
  it('builds the admin aggregate path from a bare groupId', () => {
    expect(buildAttendanceGroupFixedScheduleAdminPath(GROUP_ID)).toBe(`/api/attendance/groups/${GROUP_ID}/fixed-schedule/effectiveness`)
  })

  it('builds the self path from a bare groupId', () => {
    expect(buildAttendanceGroupFixedScheduleSelfPath(GROUP_ID)).toBe(`/api/attendance/groups/${GROUP_ID}/fixed-schedule/effectiveness/me`)
  })

  it('rejects a non-UUID groupId locally (zero wire traffic)', () => {
    expect(buildAttendanceGroupFixedScheduleAdminPath('not-a-uuid')).toBeNull()
    expect(buildAttendanceGroupFixedScheduleSelfPath('not-a-uuid')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// Composable — HTTP folding, stale-response suppression, fail-closed error posture.
// ---------------------------------------------------------------------------------------------

describe('useAttendanceFixedScheduleEffectiveness — HTTP folding', () => {
  function jsonResponse(status: number, payload: unknown): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => payload } as unknown as Response
  }

  it('loadGroupEffectiveness: exactly one GET, path-only, no query string, no body', async () => {
    const apiFetch = vi.fn(async () => jsonResponse(200, { ok: true, data: adminFixture() }))
    const composable = useAttendanceFixedScheduleEffectiveness({ apiFetch })
    await composable.loadGroupEffectiveness(GROUP_ID)
    expect(composable.state.value).toBe('loaded')
    expect(composable.admin.value).toEqual(parseAttendanceGroupFixedScheduleAdminResponse(adminFixture()))
    expect(composable.unavailableReason.value).toBeNull()
    expect(apiFetch.mock.calls).toHaveLength(1)
    expect(apiFetch.mock.calls[0]).toHaveLength(1)
    expect(String(apiFetch.mock.calls[0][0])).toBe(`/api/attendance/groups/${GROUP_ID}/fixed-schedule/effectiveness`)
  })

  it('loadSelfEffectiveness: exactly one GET to the /me path', async () => {
    const apiFetch = vi.fn(async () => jsonResponse(200, { ok: true, data: selfFixture() }))
    const composable = useAttendanceFixedScheduleEffectiveness({ apiFetch })
    await composable.loadSelfEffectiveness(GROUP_ID)
    expect(composable.state.value).toBe('loaded')
    expect(composable.self.value).toEqual(parseAttendanceGroupFixedScheduleSelfResponse(selfFixture()))
    expect(String(apiFetch.mock.calls[0][0])).toBe(`/api/attendance/groups/${GROUP_ID}/fixed-schedule/effectiveness/me`)
  })

  it('folds 401/403/404/503 into the closed unavailableReason set — never one of the four states', async () => {
    const cases: Array<[Response, string]> = [
      [jsonResponse(401, { ok: false, error: { code: 'UNAUTHORIZED' } }), 'unauthorized'],
      [jsonResponse(403, { ok: false, error: { code: 'FORBIDDEN' } }), 'forbidden'],
      [jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND' } }), 'not_found'],
      [jsonResponse(503, { ok: false, error: { code: 'DB_NOT_READY' } }), 'db_not_ready'],
      [jsonResponse(500, { ok: false, error: { code: 'INTERNAL_ERROR' } }), 'error'],
    ]
    for (const [response, expected] of cases) {
      const apiFetch = vi.fn(async () => response)
      const composable = useAttendanceFixedScheduleEffectiveness({ apiFetch })
      await composable.loadGroupEffectiveness(GROUP_ID)
      expect(composable.state.value).toBe('error')
      expect(composable.unavailableReason.value).toBe(expected)
      expect(composable.admin.value).toBeNull()
    }
  })

  it('malformed JSON body (json() throws) folds to malformed', async () => {
    const apiFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } } as unknown as Response))
    const composable = useAttendanceFixedScheduleEffectiveness({ apiFetch })
    await composable.loadGroupEffectiveness(GROUP_ID)
    expect(composable.state.value).toBe('error')
    expect(composable.unavailableReason.value).toBe('malformed')
  })

  it('an unknown state value in an otherwise-200 body folds to shape_mismatch, never a default state', async () => {
    const apiFetch = vi.fn(async () => jsonResponse(200, { ok: true, data: adminFixture({ state: 'applied' }) }))
    const composable = useAttendanceFixedScheduleEffectiveness({ apiFetch })
    await composable.loadGroupEffectiveness(GROUP_ID)
    expect(composable.state.value).toBe('error')
    expect(composable.unavailableReason.value).toBe('shape_mismatch')
    expect(composable.admin.value).toBeNull()
  })

  it('gate 6 (composable level): a self response smuggling `coverage` folds to shape_mismatch, never exposed via `self`', async () => {
    const apiFetch = vi.fn(async () => jsonResponse(200, { ok: true, data: { ...selfFixture(), coverage: { targetMembers: 1 } } }))
    const composable = useAttendanceFixedScheduleEffectiveness({ apiFetch })
    await composable.loadSelfEffectiveness(GROUP_ID)
    expect(composable.state.value).toBe('error')
    expect(composable.unavailableReason.value).toBe('shape_mismatch')
    expect(composable.self.value).toBeNull()
  })

  it('response-shape mismatch (missing required field) folds to shape_mismatch', async () => {
    const broken = adminFixture()
    delete (broken as any).coverage
    const apiFetch = vi.fn(async () => jsonResponse(200, { ok: true, data: broken }))
    const composable = useAttendanceFixedScheduleEffectiveness({ apiFetch })
    await composable.loadGroupEffectiveness(GROUP_ID)
    expect(composable.unavailableReason.value).toBe('shape_mismatch')
  })

  it('network failure folds to error, never a fabricated result', async () => {
    const apiFetch = vi.fn(async () => { throw new Error('offline') })
    const composable = useAttendanceFixedScheduleEffectiveness({ apiFetch })
    await composable.loadGroupEffectiveness(GROUP_ID)
    expect(composable.state.value).toBe('error')
    expect(composable.unavailableReason.value).toBe('error')
    expect(composable.admin.value).toBeNull()
  })

  it('an invalid groupId fails locally with ZERO wire traffic', async () => {
    const apiFetch = vi.fn(async () => jsonResponse(200, { ok: true, data: adminFixture() }))
    const composable = useAttendanceFixedScheduleEffectiveness({ apiFetch })
    await composable.loadGroupEffectiveness('not-a-uuid')
    expect(composable.state.value).toBe('error')
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('stale-response suppression: an older in-flight response never overwrites a newer target\'s state', async () => {
    let resolveFirst: (response: Response) => void = () => {}
    let resolveSecond: (response: Response) => void = () => {}
    const apiFetch = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveSecond = resolve }))
    const composable = useAttendanceFixedScheduleEffectiveness({ apiFetch })

    const firstCall = composable.loadGroupEffectiveness(GROUP_ID)
    const secondGroupId = '9c4d2b1a-7e6f-4a3b-8c5d-1e2f3a4b5c6d'
    const secondCall = composable.loadGroupEffectiveness(secondGroupId)

    // Resolve the SECOND (newer) request first, then the stale first request.
    resolveSecond(jsonResponse(200, { ok: true, data: adminFixture({ groupId: secondGroupId, state: 'effective', reasonCodes: ['EFFECTIVE'] }) }))
    await secondCall
    resolveFirst(jsonResponse(200, { ok: true, data: adminFixture({ groupId: GROUP_ID, state: 'not_configured', desired: null, reasonCodes: ['NO_DESIRED_CONFIG'] }) }))
    await firstCall

    expect(composable.state.value).toBe('loaded')
    expect(composable.admin.value?.groupId).toBe(secondGroupId)
    expect(composable.admin.value?.state).toBe('effective')
  })

  it('reset() returns to idle and drops any still-pending stale response', async () => {
    let resolvePending: (response: Response) => void = () => {}
    const apiFetch = vi.fn(() => new Promise<Response>(resolve => { resolvePending = resolve }))
    const composable = useAttendanceFixedScheduleEffectiveness({ apiFetch })
    const pending = composable.loadGroupEffectiveness(GROUP_ID)
    composable.reset()
    expect(composable.state.value).toBe('idle')
    resolvePending(jsonResponse(200, { ok: true, data: adminFixture() }))
    await pending
    expect(composable.state.value).toBe('idle')
    expect(composable.admin.value).toBeNull()
  })
})
