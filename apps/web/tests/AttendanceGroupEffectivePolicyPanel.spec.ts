import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceGroupEffectivePolicyPanel from '../src/views/attendance/AttendanceGroupEffectivePolicyPanel.vue'
import { apiFetch } from '../src/utils/api'
import { attendanceSessionGuardKey, createAttendanceSessionGuard } from '../src/composables/useAttendanceSessionGuard'

const pushSpy = vi.fn()
const openGroupStageSpy = vi.fn()
vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  const router = actual.createRouter({
    history: actual.createMemoryHistory(),
    routes: (['schedule', 'calendar', 'rules'] as const).map(step => ({
      path: '/attendance/admin/groups/:groupId/' + step,
      component: { template: '<div />' },
    })),
  })
  return { ...actual, useRouter: () => ({ ...router, push: pushSpy }) }
})

vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({ isZh: ref(false) }),
}))

const GROUP_ID = '11111111-2222-4333-8444-555555555555'
const RETURN_TO = '/attendance?tab=admin&section=attendance-admin-groups'

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

async function flushUi(cycles = 5): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function fullFixture() {
  return {
    ok: true,
    data: {
      groupId: GROUP_ID,
      groupType: 'fixed_shift',
      timezone: 'Asia/Shanghai',
      activeMemberCount: 12,
      managerPosture: { ownerCount: 1, subOwnerCount: 2 },
      calculationPosture: 'legacy',
      domains: {
        membership: { label: 'effective', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'people' } },
        schedule: {
          label: 'effective',
          strategy: 'fixed_shift',
          reasonCodes: [],
          sourceRefs: [],
          fixedSchedule: {
            state: 'effective',
            reasonCodes: ['EFFECTIVE'],
            desired: null,
            coverage: {
              targetMembers: 12,
              matchingMembers: 12,
              missingMembers: 0,
              nonMemberTargets: 0,
              differentKeyRows: 0,
            },
            drift: { unconfiguredManagedRows: 0, unpublishedManagedRows: 0, managedSets: [] },
            evaluatedAt: '2026-08-05T00:00:00.000Z',
          },
          editorRef: { kind: 'group_context_route', step: 'schedule', surface: 'assignments' },
        },
        segments: {
          label: 'preview_only',
          reasonCodes: ['SEGMENT_CALCULATION_NOT_AUTHORITATIVE'],
          editorRef: { kind: 'group_context_route', step: 'schedule', surface: 'shifts' },
        },
        flex: {
          label: 'preview_only',
          mode: 'flex_required_duration',
          reasonCodes: ['SEGMENT_CALCULATION_NOT_AUTHORITATIVE'],
          editorRef: { kind: 'group_context_route', step: 'schedule', surface: 'shifts' },
        },
        rules: {
          label: 'org_inherited',
          source: 'org_default',
          sourceRefs: [],
          reasonCodes: [],
          editorRef: { kind: 'group_context_route', step: 'rules', surface: 'rule-sets' },
        },
        punchMethod: {
          label: 'org_inherited',
          source: 'org_inherited',
          reasonCodes: [],
          editorRef: { kind: 'group_stage', stage: 'policies' },
        },
        requestPosture: {
          label: 'org_inherited',
          overtime: 'org_inherited',
          makeupPunch: 'org_inherited',
          outdoor: 'org_inherited',
          reasonCodes: [],
          editorRef: { kind: 'group_stage', stage: 'policies' },
        },
      },
      conflicts: [
        {
          code: 'CALCULATION_GROUP_MEMBERSHIP_OVERLAP',
          domain: 'membership',
          label: 'conflict_action_required',
          affectedUserCount: 2,
          editorRef: { kind: 'group_stage', stage: 'people' },
        },
      ],
      evaluatedAt: '2026-08-05T00:00:00.000Z',
    },
  }
}

describe('AttendanceGroupEffectivePolicyPanel', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  function mount(guard = createAttendanceSessionGuard('synthetic-org', () => 'synthetic-epoch')): void {
    app = createApp(AttendanceGroupEffectivePolicyPanel, {
      groupId: GROUP_ID,
      returnTo: RETURN_TO,
      onOpenGroupStage: openGroupStageSpy,
    })
    app.provide(attendanceSessionGuardKey, guard)
    app.mount(container!)
  }

  function click(selector: string): void {
    container!.querySelector<HTMLButtonElement>(selector)!.click()
  }

  it('starts idle and issues zero fetches on mount (§5.4: no auto-fetch)', async () => {
    mount()
    await flushUi()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-panel]')).toBeTruthy()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-panel][data-attendance-w6-effective-policy-status="idle"]')).toBeTruthy()
    expect(apiFetch).not.toHaveBeenCalled()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-open]')).toBeTruthy()
  })

  it('preserves idle state and sends nothing when an old page opens the panel', async () => {
    const guard = createAttendanceSessionGuard('synthetic-org', () => 'synthetic-epoch')
    mount(guard)
    guard.invalidate()
    click('[data-attendance-w6-effective-policy-open]')
    await flushUi()
    expect(apiFetch).not.toHaveBeenCalled()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-status="idle"]')).toBeTruthy()
  })

  it('does not render a late body or overwrite state from a stale catch', async () => {
    const guard = createAttendanceSessionGuard('synthetic-org', () => 'synthetic-epoch')
    let finish!: (value: unknown) => void
    const json = vi.fn(() => new Promise(resolve => { finish = resolve }))
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json } as unknown as Response)
    mount(guard)
    click('[data-attendance-w6-effective-policy-open]')
    await vi.waitFor(() => expect(json).toHaveBeenCalledTimes(1))
    guard.invalidate()
    finish(fullFixture())
    await flushUi()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-content]')).toBeNull()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-status="loading"]')).toBeTruthy()
  })

  it('does not apply a late transport error before an identity-change notification arrives', async () => {
    let identity = 'synthetic-first'
    const guard = createAttendanceSessionGuard('synthetic-org', () => identity)
    let reject!: (error: Error) => void
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    mount(guard)
    click('[data-attendance-w6-effective-policy-open]')
    identity = 'synthetic-second'
    reject(new Error('synthetic transport failure'))
    await flushUi()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-status="loading"]')).toBeTruthy()
    expect(guard.stale.value).toBe(true)
  })

  it('fetches exactly once per explicit open click and renders the fixture 1:1 from the closed unions', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(response(200, fullFixture()))
    mount()
    await flushUi()
    click('[data-attendance-w6-effective-policy-open]')
    await flushUi()

    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(apiFetch).toHaveBeenCalledWith(`/api/attendance/groups/${GROUP_ID}/effective-policy`)
    expect(container!.querySelector('[data-attendance-w6-effective-policy-content]')).toBeTruthy()
    expect(container!.textContent).toContain('Fixed shift')
    expect(container!.textContent).toContain('Legacy')
    expect(container!.textContent).toContain('Overlapping calculation-group membership')
    expect(container!.querySelectorAll('[data-attendance-w6-effective-policy-conflict-row]')).toHaveLength(1)
    expect(container!.querySelector('[data-attendance-w6-effective-policy-fser]')).toBeTruthy()
    expect(container!.textContent).toContain('12')
  })

  it('issues exactly one additional GET per explicit refresh click, never automatically', async () => {
    vi.mocked(apiFetch).mockResolvedValue(response(200, fullFixture()))
    mount()
    await flushUi()
    click('[data-attendance-w6-effective-policy-open]')
    await flushUi()
    expect(apiFetch).toHaveBeenCalledTimes(1)

    click('[data-attendance-w6-effective-policy-refresh]')
    await flushUi()
    expect(apiFetch).toHaveBeenCalledTimes(2)

    // No further calls without another explicit click.
    await flushUi()
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it.each([403, 404])('maps a %d response to the same unavailable posture, not a fabricated status', async (status) => {
    vi.mocked(apiFetch).mockResolvedValueOnce(response(status))
    mount()
    await flushUi()
    click('[data-attendance-w6-effective-policy-open]')
    await flushUi()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-unavailable]')).toBeTruthy()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-content]')).toBeNull()
  })

  it('goes to the error state (with retry) on a 500 and on a malformed envelope', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(response(500))
    mount()
    await flushUi()
    click('[data-attendance-w6-effective-policy-open]')
    await flushUi()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-error]')).toBeTruthy()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-retry]')).toBeTruthy()

    vi.mocked(apiFetch).mockResolvedValueOnce(response(200, { ok: true }))
    click('[data-attendance-w6-effective-policy-retry]')
    await flushUi()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-error]')).toBeTruthy()
  })

  it('renders a fail-closed "unrecognized" indicator for an unrecognized label — never a fabricated valid one', async () => {
    const fixture = fullFixture()
    ;(fixture.data.domains.membership as { label: string }).label = 'not_a_real_label'
    vi.mocked(apiFetch).mockResolvedValueOnce(response(200, fixture))
    mount()
    await flushUi()
    click('[data-attendance-w6-effective-policy-open]')
    await flushUi()

    const rows = Array.from(container!.querySelectorAll('.attendance-group-effective-policy-panel__domain-row'))
    const membershipRow = rows.find((row) => row.textContent?.includes('Membership'))
    expect(membershipRow?.textContent).toContain('Unrecognized')
    expect(membershipRow?.textContent).not.toMatch(/Effective|Org default|Preview only|Needs configuration|Conflict/)
  })

  it('navigates via the injected router for a group_context_route editorRef (schedule domain)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(response(200, fullFixture()))
    mount()
    await flushUi()
    click('[data-attendance-w6-effective-policy-open]')
    await flushUi()

    click('[data-attendance-w6-effective-policy-domain-nav="schedule"]')
    await flushUi()
    expect(pushSpy).toHaveBeenCalledWith(
      `/attendance/admin/groups/${GROUP_ID}/schedule?surface=assignments&returnTo=${encodeURIComponent(RETURN_TO)}`,
    )
  })

  it.each([
    ['basics', 'conflict'],
    ['people', 'domain'],
    ['people', 'conflict'],
  ] as const)('emits the exact group and %s stage from a %s action', async (stage, source) => {
    const fixture = fullFixture()
    if (stage === 'basics') {
      fixture.data.conflicts[0] = {
        ...fixture.data.conflicts[0],
        code: 'TIMEZONE_MISSING',
        domain: 'basics',
        editorRef: { kind: 'group_stage', stage },
      }
    }
    vi.mocked(apiFetch).mockResolvedValueOnce(response(200, fixture))
    mount()
    click('[data-attendance-w6-effective-policy-open]')
    await flushUi()

    click(source === 'domain'
      ? '[data-attendance-w6-effective-policy-domain-nav="membership"]'
      : '[data-attendance-w6-effective-policy-conflict-nav="0"]')
    await flushUi()

    expect(openGroupStageSpy.mock.calls).toEqual([[{ groupId: GROUP_ID, stage }]])
    expect(pushSpy).not.toHaveBeenCalled()
    expect(vi.mocked(apiFetch).mock.calls).toEqual([[`/api/attendance/groups/${GROUP_ID}/effective-policy`]])
  })

  it.each([
    ['schedule', 'schedule', 'domain'],
    ['schedule', 'schedule', 'conflict'],
    ['policies', 'rules', 'domain'],
    ['policies', 'rules', 'conflict'],
  ] as const)('routes group_stage %s to /%s from a %s action', async (stage, step, source) => {
    const fixture = fullFixture()
    const payload = {
      ...fixture,
      data: {
        ...fixture.data,
        domains: {
          ...fixture.data.domains,
          schedule: { ...fixture.data.domains.schedule, editorRef: { kind: 'group_stage', stage: 'schedule' } },
        },
        conflicts: [{
          ...fixture.data.conflicts[0],
          code: stage === 'schedule' ? 'FIXED_SCHEDULE_PENDING_APPLY' : 'RULE_SOURCE_MISSING',
          domain: stage === 'schedule' ? 'schedule' : 'rules',
          editorRef: { kind: 'group_stage', stage },
        }],
      },
    }
    vi.mocked(apiFetch).mockResolvedValueOnce(response(200, payload))
    mount()
    click('[data-attendance-w6-effective-policy-open]')
    await flushUi()

    click(source === 'conflict'
      ? '[data-attendance-w6-effective-policy-conflict-nav="0"]'
      : `[data-attendance-w6-effective-policy-domain-nav="${stage === 'schedule' ? 'schedule' : 'punchMethod'}"]`)
    await flushUi()

    expect(pushSpy.mock.calls).toEqual([[
      `/attendance/admin/groups/${GROUP_ID}/${step}?returnTo=${encodeURIComponent(RETURN_TO)}`,
    ]])
    expect(openGroupStageSpy).not.toHaveBeenCalled()
    expect(vi.mocked(apiFetch).mock.calls).toEqual([[`/api/attendance/groups/${GROUP_ID}/effective-policy`]])
  })


  it('retains canonical group_context_route navigation for a conflict action', async () => {
    const fixture = fullFixture()
    const payload = {
      ...fixture,
      data: {
        ...fixture.data,
        conflicts: [{
          ...fixture.data.conflicts[0],
          code: 'RULE_SOURCE_MISSING',
          domain: 'rules',
          editorRef: { kind: 'group_context_route', step: 'rules', surface: 'rule-sets' },
        }],
      },
    }
    vi.mocked(apiFetch).mockResolvedValueOnce(response(200, payload))
    mount()
    click('[data-attendance-w6-effective-policy-open]')
    await flushUi()
    click('[data-attendance-w6-effective-policy-conflict-nav="0"]')
    await flushUi()

    expect(pushSpy.mock.calls).toEqual([[
      `/attendance/admin/groups/${GROUP_ID}/rules?surface=rule-sets&returnTo=${encodeURIComponent(RETURN_TO)}`,
    ]])
    expect(openGroupStageSpy).not.toHaveBeenCalled()
  })

  it('renders no domain or conflict action for an unknown group stage', async () => {
    const fixture = fullFixture()
    fixture.data.domains.membership.editorRef.stage = 'archived'
    fixture.data.conflicts[0].editorRef.stage = 'archived'
    vi.mocked(apiFetch).mockResolvedValueOnce(response(200, fixture))
    mount()
    click('[data-attendance-w6-effective-policy-open]')
    await flushUi()

    expect(container!.querySelector('[data-attendance-w6-effective-policy-content]')).toBeTruthy()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-domain-nav="membership"]')).toBeNull()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-conflict-nav="0"]')).toBeNull()
    expect(pushSpy).not.toHaveBeenCalled()
    expect(openGroupStageSpy).not.toHaveBeenCalled()
    expect(vi.mocked(apiFetch).mock.calls).toEqual([[`/api/attendance/groups/${GROUP_ID}/effective-policy`]])
  })

  it.each([403, 404])('rejects a held action after refresh makes the group unavailable (%d)', async (status) => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(response(200, fullFixture()))
      .mockResolvedValueOnce(response(status))
    mount()
    click('[data-attendance-w6-effective-policy-open]')
    await flushUi()
    const held = container!.querySelector<HTMLButtonElement>('[data-attendance-w6-effective-policy-domain-nav="membership"]')!
    click('[data-attendance-w6-effective-policy-refresh]')
    await flushUi()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-unavailable]')).toBeTruthy()
    held.click()
    await flushUi()
    expect(pushSpy).not.toHaveBeenCalled()
    expect(openGroupStageSpy).not.toHaveBeenCalled()
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it('rejects an aggregate naming a different group before offering editor actions', async () => {
    const fixture = fullFixture()
    fixture.data.groupId = '66666666-7777-4888-8999-000000000000'
    vi.mocked(apiFetch).mockResolvedValueOnce(response(200, fixture))
    mount()
    click('[data-attendance-w6-effective-policy-open]')
    await flushUi()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-error]')).toBeTruthy()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-content]')).toBeNull()
    expect(pushSpy).not.toHaveBeenCalled()
    expect(openGroupStageSpy).not.toHaveBeenCalled()
  })

  it.each(['domain', 'conflict'] as const)('does not dispatch an old %s action after session invalidation', async (source) => {
    vi.mocked(apiFetch).mockResolvedValueOnce(response(200, fullFixture()))
    const guard = createAttendanceSessionGuard('synthetic-org', () => 'synthetic-epoch')
    mount(guard)
    click('[data-attendance-w6-effective-policy-open]')
    await flushUi()
    const action = container!.querySelector<HTMLButtonElement>(source === 'domain'
      ? '[data-attendance-w6-effective-policy-domain-nav="membership"]'
      : '[data-attendance-w6-effective-policy-conflict-nav="0"]')!
    guard.invalidate()
    action.click()
    await flushUi()
    expect(pushSpy).not.toHaveBeenCalled()
    expect(openGroupStageSpy).not.toHaveBeenCalled()
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it('renders "No conflicts." when the conflicts array is empty', async () => {
    const fixture = fullFixture()
    fixture.data.conflicts = []
    vi.mocked(apiFetch).mockResolvedValueOnce(response(200, fixture))
    mount()
    await flushUi()
    click('[data-attendance-w6-effective-policy-open]')
    await flushUi()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-no-conflicts]')).toBeTruthy()
  })
})
