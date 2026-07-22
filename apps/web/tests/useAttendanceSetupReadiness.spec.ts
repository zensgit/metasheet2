// W4-1 (Wave 4 onboarding design-lock 2026-07-21, RATIFIED §4.3/§6.1/§9 W4-1): composable seam
// tests for `useAttendanceSetupReadiness` — HTTP-outcome → discriminator-input folding (403 →
// forbidden, 503 DB_NOT_READY → db_not_ready, 200 valid → ok, everything else → fail-closed load
// error), enum-strict body validation (invalid enum = malformed, never silently defaulted), and
// the §6.1 readiness-derived task-home badge (①②③⑤ gating only; advisory ④⑥ never trigger).
// Wired into .github/workflows/attendance-web-guard.yml (run-list + both path filters).
import { describe, expect, it, vi } from 'vitest'
import {
  ATTENDANCE_SETUP_ADMIN_USERS_ROUTE_PATH,
  ATTENDANCE_SETUP_READINESS_ENDPOINT,
  deriveAttendanceSetupEntryNeedsAttention,
  parseAttendanceSetupReadinessResponse,
  resolveAttendanceSetupAdminUsersHref,
  shouldReloadSetupReadinessOnSurfaceOpen,
  useAttendanceSetupReadiness,
} from '../src/views/attendance/useAttendanceSetupReadiness'
import {
  ATTENDANCE_SETUP_STEP_IDS,
  deriveAttendanceSetupReadinessSteps,
  type AttendanceSetupReadinessResponse,
} from '../src/views/attendance/attendanceSetupReadiness'

const PER_STEP = Object.fromEntries(
  ATTENDANCE_SETUP_STEP_IDS.map((id) => [id, { effectiveTime: { source: 'test', posture: 'immediate' as const } }]),
) as AttendanceSetupReadinessResponse['perStep']

/** Fixture: every gating step (①②③⑤) ready; ④ customized; ⑥ carries its three signals. */
function allReadyResponse(overrides: Partial<AttendanceSetupReadinessResponse> = {}): AttendanceSetupReadinessResponse {
  return {
    directoryLinked: false,
    orgActiveMemberCount: 12,
    groupCount: 3,
    groupsWithMembers: 3,
    shiftCount: 4,
    scheduledShiftGroupCount: 1,
    activeRotationRuleCount: 2,
    hasRotationRules: true,
    approvalFlowCount: 2,
    punchPolicyPosture: 'customized',
    notify: {
      deliveryRuntime: 'unknown',
      orgRecipientBinding: { boundRecipientCount: 5, hasAnyBoundRecipient: true },
      recipientScopeConfig: 'unsupported',
    },
    previewReady: true,
    perStep: PER_STEP,
    ...overrides,
  }
}

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response
}

describe('useAttendanceSetupReadiness — HTTP outcome folding', () => {
  it('sends the orgId query param to the exact endpoint (blank org → default)', async () => {
    const apiFetch = vi.fn(async () => jsonResponse(200, { ok: true, data: allReadyResponse() }))
    const readiness = useAttendanceSetupReadiness({ apiFetch })
    await readiness.loadReadiness('  ')
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(apiFetch).toHaveBeenCalledWith(`${ATTENDANCE_SETUP_READINESS_ENDPOINT}?orgId=default`)
    await readiness.loadReadiness('org-b')
    expect(apiFetch).toHaveBeenLastCalledWith(`${ATTENDANCE_SETUP_READINESS_ENDPOINT}?orgId=org-b`)
  })

  it('200 + valid body → kind ok, steps derived, summary exposed', async () => {
    const data = allReadyResponse()
    const apiFetch = vi.fn(async () => jsonResponse(200, { ok: true, data }))
    const readiness = useAttendanceSetupReadiness({ apiFetch })
    await readiness.loadReadiness('org-a')
    expect(readiness.state.value).toBe('loaded')
    expect(readiness.input.value).toEqual({ kind: 'ok', data })
    expect(readiness.steps.value).toEqual(deriveAttendanceSetupReadinessSteps({ kind: 'ok', data }))
    expect(readiness.summary.value).toEqual(data)
  })

  it('403 → whole-endpoint forbidden fold (per-surface signal, §4.3 — no global flag)', async () => {
    const apiFetch = vi.fn(async () => jsonResponse(403, { ok: false, error: { code: 'FORBIDDEN' } }))
    const readiness = useAttendanceSetupReadiness({ apiFetch })
    await readiness.loadReadiness('org-a')
    expect(readiness.state.value).toBe('loaded')
    expect(readiness.input.value).toEqual({ kind: 'forbidden' })
    expect(readiness.steps.value.map((step) => step.status)).toEqual(Array(7).fill('forbidden'))
    expect(readiness.summary.value).toBeNull()
  })

  it('503 with DB_NOT_READY code → db_not_ready fold', async () => {
    const apiFetch = vi.fn(async () => jsonResponse(503, { ok: false, error: { code: 'DB_NOT_READY' } }))
    const readiness = useAttendanceSetupReadiness({ apiFetch })
    await readiness.loadReadiness('org-a')
    expect(readiness.state.value).toBe('loaded')
    expect(readiness.input.value).toEqual({ kind: 'db_not_ready' })
    expect(readiness.steps.value.map((step) => step.status)).toEqual(Array(7).fill('db_not_ready'))
  })

  it('503 WITHOUT the DB_NOT_READY code is a load error, not a db_not_ready claim', async () => {
    const apiFetch = vi.fn(async () => jsonResponse(503, { ok: false, error: { code: 'SOMETHING_ELSE' } }))
    const readiness = useAttendanceSetupReadiness({ apiFetch })
    await readiness.loadReadiness('org-a')
    expect(readiness.state.value).toBe('error')
    expect(readiness.input.value).toBeNull()
    expect(readiness.steps.value).toEqual([])
  })

  it('500 / network failure → fail-closed error state with zero derived steps', async () => {
    const apiFetch = vi.fn(async () => jsonResponse(500, { ok: false, error: { code: 'SETUP_READINESS_FAILED' } }))
    const readiness = useAttendanceSetupReadiness({ apiFetch })
    await readiness.loadReadiness('org-a')
    expect(readiness.state.value).toBe('error')
    expect(readiness.steps.value).toEqual([])

    const throwing = vi.fn(async () => { throw new Error('network down') })
    const readiness2 = useAttendanceSetupReadiness({ apiFetch: throwing })
    await readiness2.loadReadiness('org-a')
    expect(readiness2.state.value).toBe('error')
    expect(readiness2.input.value).toBeNull()
  })

  it('malformed 200 body (missing keys) → error, never a guessed matrix', async () => {
    const apiFetch = vi.fn(async () => jsonResponse(200, { ok: true, data: { orgActiveMemberCount: 3 } }))
    const readiness = useAttendanceSetupReadiness({ apiFetch })
    await readiness.loadReadiness('org-a')
    expect(readiness.state.value).toBe('error')
    expect(readiness.steps.value).toEqual([])
  })

  it('a stale response never overwrites a newer org load', async () => {
    let resolveFirst: ((response: Response) => void) | null = null
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve })
    const dataB = allReadyResponse({ orgActiveMemberCount: 99 })
    const apiFetch = vi.fn(async (path: string) => {
      if (path.includes('org-a')) return first
      return jsonResponse(200, { ok: true, data: dataB })
    })
    const readiness = useAttendanceSetupReadiness({ apiFetch })
    const firstLoad = readiness.loadReadiness('org-a')
    await readiness.loadReadiness('org-b')
    resolveFirst!(jsonResponse(200, { ok: true, data: allReadyResponse({ orgActiveMemberCount: 1 }) }))
    await firstLoad
    expect(readiness.lastOrgId.value).toBe('org-b')
    expect(readiness.summary.value?.orgActiveMemberCount).toBe(99)
  })
})

describe('parseAttendanceSetupReadinessResponse — enum-strict, fail-closed', () => {
  it('accepts the exact locked shape', () => {
    expect(parseAttendanceSetupReadinessResponse(allReadyResponse())).toEqual(allReadyResponse())
  })

  it.each([
    ['punchPolicyPosture out of domain', { punchPolicyPosture: 'totally-custom' }],
    ['deliveryRuntime out of domain', { notify: { deliveryRuntime: 'maybe', orgRecipientBinding: { boundRecipientCount: 0, hasAnyBoundRecipient: false }, recipientScopeConfig: 'unsupported' } }],
    ['recipientScopeConfig not the unsupported constant', { notify: { deliveryRuntime: 'unknown', orgRecipientBinding: { boundRecipientCount: 0, hasAnyBoundRecipient: false }, recipientScopeConfig: 'supported' } }],
    ['negative count', { orgActiveMemberCount: -1 }],
    ['non-integer count', { groupCount: 1.5 }],
  ] as Array<[string, Partial<AttendanceSetupReadinessResponse>]>)('rejects %s (never silently defaults)', (_name, overrides) => {
    const raw = { ...allReadyResponse(), ...overrides }
    expect(parseAttendanceSetupReadinessResponse(raw)).toBeNull()
  })

  it('rejects an out-of-domain effectiveTime posture and a scheduled entry without effectiveAt', () => {
    const badPosture = allReadyResponse()
    const perStep1 = { ...PER_STEP, preview: { effectiveTime: { source: 'test', posture: 'someday' } } }
    expect(parseAttendanceSetupReadinessResponse({ ...badPosture, perStep: perStep1 })).toBeNull()

    const perStep2 = { ...PER_STEP, preview: { effectiveTime: { source: 'test', posture: 'scheduled' } } }
    expect(parseAttendanceSetupReadinessResponse({ ...badPosture, perStep: perStep2 })).toBeNull()

    const perStep3 = {
      ...PER_STEP,
      preview: { effectiveTime: { source: 'test', posture: 'scheduled', effectiveAt: '2026-08-01T00:00:00.000Z' } },
    }
    expect(parseAttendanceSetupReadinessResponse({ ...badPosture, perStep: perStep3 })).not.toBeNull()
  })

  it('rejects a missing perStep entry', () => {
    const { preview: _dropped, ...partial } = PER_STEP as Record<string, unknown>
    expect(parseAttendanceSetupReadinessResponse({ ...allReadyResponse(), perStep: partial })).toBeNull()
  })
})

describe('deriveAttendanceSetupEntryNeedsAttention — §6.1 badge (readiness-derived, never visit history)', () => {
  it('false when steps are empty (no readiness derived yet → no claim)', () => {
    expect(deriveAttendanceSetupEntryNeedsAttention([])).toBe(false)
  })

  it('false when ①②③⑤ are all ready, even with ④ manual_review_required and ⑥ unsupported (advisory never badges)', () => {
    const steps = deriveAttendanceSetupReadinessSteps({
      kind: 'ok',
      data: allReadyResponse({ punchPolicyPosture: 'default' }),
    })
    expect(steps.find((s) => s.stepId === 'attendance-admin-settings')?.status).toBe('manual_review_required')
    expect(steps.find((s) => s.stepId === 'attendance-admin-notification-deliveries')?.status).toBe('unsupported')
    expect(deriveAttendanceSetupEntryNeedsAttention(steps)).toBe(false)
  })

  it('true for each single non-ready gating step ①②③⑤', () => {
    const cases: Array<Partial<AttendanceSetupReadinessResponse>> = [
      { orgActiveMemberCount: 0 },
      { groupsWithMembers: 0 },
      { shiftCount: 0 },
      { approvalFlowCount: 0 },
    ]
    for (const overrides of cases) {
      const steps = deriveAttendanceSetupReadinessSteps({ kind: 'ok', data: allReadyResponse(overrides) })
      expect(deriveAttendanceSetupEntryNeedsAttention(steps), JSON.stringify(overrides)).toBe(true)
    }
  })

  it('true on whole-endpoint folds (forbidden / db_not_ready are non-ready gating statuses)', () => {
    expect(deriveAttendanceSetupEntryNeedsAttention(deriveAttendanceSetupReadinessSteps({ kind: 'forbidden' }))).toBe(true)
    expect(deriveAttendanceSetupEntryNeedsAttention(deriveAttendanceSetupReadinessSteps({ kind: 'db_not_ready' }))).toBe(true)
  })
})

describe('resolveAttendanceSetupAdminUsersHref — §3① deep link stays operable under sub-path deploys', () => {
  it('root base (and blank/undefined) → the bare canonical path', () => {
    expect(resolveAttendanceSetupAdminUsersHref('/')).toBe('/admin/users')
    expect(resolveAttendanceSetupAdminUsersHref('')).toBe('/admin/users')
    expect(resolveAttendanceSetupAdminUsersHref(undefined)).toBe('/admin/users')
    expect(resolveAttendanceSetupAdminUsersHref(null)).toBe('/admin/users')
  })

  it('sub-path base (VITE_BASE_PATH) → base-prefixed href, single slash, never hash-form', () => {
    expect(resolveAttendanceSetupAdminUsersHref('/metasheet/')).toBe('/metasheet/admin/users')
    expect(resolveAttendanceSetupAdminUsersHref('/metasheet')).toBe('/metasheet/admin/users')
    expect(resolveAttendanceSetupAdminUsersHref('/a/b/')).toBe('/a/b/admin/users')
    expect(resolveAttendanceSetupAdminUsersHref('/metasheet/')).not.toContain('#')
  })

  it('the router-push form stays base-free (the router prepends its own history base)', () => {
    expect(ATTENDANCE_SETUP_ADMIN_USERS_ROUTE_PATH).toBe('/admin/users')
  })
})

describe('shouldReloadSetupReadinessOnSurfaceOpen — §8.3 org 切换 / §6.1 badge freshness', () => {
  it('first open (idle) always loads', () => {
    expect(shouldReloadSetupReadinessOnSurfaceOpen('idle', null, 'default')).toBe(true)
  })

  it('re-open with the SAME loaded org does not force a reload (loaded and error states)', () => {
    expect(shouldReloadSetupReadinessOnSurfaceOpen('loaded', 'default', 'default')).toBe(false)
    expect(shouldReloadSetupReadinessOnSurfaceOpen('error', 'org-a', 'org-a')).toBe(false)
  })

  it('re-open after the org changed (loaded org ≠ current target) MUST reload — the previous org\'s badge verdict never lingers', () => {
    expect(shouldReloadSetupReadinessOnSurfaceOpen('loaded', 'org-a', 'org-b')).toBe(true)
    expect(shouldReloadSetupReadinessOnSurfaceOpen('loaded', 'default', 'org-b')).toBe(true)
    // Never-loaded (null) with any target also reloads regardless of state.
    expect(shouldReloadSetupReadinessOnSurfaceOpen('loaded', null, 'default')).toBe(true)
  })
})
