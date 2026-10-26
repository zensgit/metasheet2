import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import AttendanceGroupPolicyWorkspace, { useAttendanceGroupPolicyWorkspace } from '../src/views/attendance/AttendanceGroupPolicyWorkspace'
import { navigateAttendanceGroupPolicyWorkspace, type AttendanceGroupPolicyWorkspaceSource } from '../src/views/attendance/attendanceGroupPolicyWorkspaceBridge'
import { attendanceSessionGuardKey, createAttendanceSessionGuard } from '../src/composables/useAttendanceSessionGuard'
import { apiFetch } from '../src/utils/api'
import { resolveAttendanceGroupEffectivePolicyEditorNavigationV1 } from '../src/views/attendance/attendanceGroupEffectivePolicyLabels'

const enabled = ref(false)
const push = vi.fn()
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({ hasFeature: () => enabled.value }),
}))
vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))
vi.mock('../src/composables/useLocale', () => ({ useLocale: () => ({ isZh: ref(false) }) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

const A = '11111111-2222-4333-8444-555555555555'
const B = '66666666-7777-4888-8999-000000000000'
const source = (groupId = A, revision = 1): AttendanceGroupPolicyWorkspaceSource =>
  Object.freeze({ groupId, revision, orgId: 'synthetic-org' })
const names = ['membership', 'schedule', 'segments', 'flex', 'rules', 'punchMethod', 'requestPosture']
const labels = ['effective', 'org_inherited', 'preview_only', 'needs_configuration', 'conflict_action_required', 'org_inherited', 'effective']
function fixture(groupId = A) {
  return { ok: true, data: {
    groupId, groupType: 'scheduled_shift', timezone: 'UTC', activeMemberCount: 0,
    managerPosture: { ownerCount: 0, subOwnerCount: 0 }, calculationPosture: 'legacy',
    domains: Object.fromEntries(names.map((key, i) => [key, {
      label: labels[i], reasonCodes: [], editorRef: key === 'rules'
        ? { kind: 'group_context_route', step: 'rules', surface: 'rule-sets' }
        : { kind: 'group_stage', stage: 'people' },
    }])),
    conflicts: [], evaluatedAt: '2026-10-26T00:00:00.000Z',
  } }
}
const response = (status = 200, body: unknown = fixture()) =>
  ({ ok: status === 200, status, json: async () => body }) as Response
async function flush() { for (let i = 0; i < 8; i += 1) { await Promise.resolve(); await nextTick() } }

let app: App | null
let container: HTMLDivElement
let guard: ReturnType<typeof createAttendanceSessionGuard>
beforeEach(() => {
  vi.clearAllMocks()
  enabled.value = false
  guard = createAttendanceSessionGuard('synthetic-org', () => 'synthetic-session')
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.mocked(apiFetch).mockResolvedValue(response())
})
afterEach(() => {
  app?.unmount()
  app = null
  container.remove()
  expect(push).not.toHaveBeenCalled()
  // This new surface has no read-only POST exception: every call is the existing aggregate GET.
  for (const [path, init] of vi.mocked(apiFetch).mock.calls) {
    expect(String(path)).toMatch(/^\/api\/attendance\/groups\/[^/]+\/effective-policy$/)
    expect(init?.method ?? 'GET').toBe('GET')
  }
})
const legacy = () => h('section', { class: 'legacy', 'data-legacy': '' }, [
  h('strong', 'Original summary'), h('button', { type: 'button' }, 'Original action'),
])
const cards = [{
  key: 'tools', title: 'Rule policy', value: 'LOCAL_VALUE_MUST_NOT_RENDER', detail: 'LOCAL_DETAIL_MUST_NOT_RENDER',
  actions: [{ key: 'original-action', label: 'Original tool', drawer: 'rule-policy' }],
}]
function mount(options: { canonical?: boolean; unsaved?: boolean; bare?: boolean } = {}) {
  const selected = ref(options.unsaved ? '' : A)
  const org = ref('synthetic-org')
  const canonical = ref(options.canonical ?? false)
  const route = vi.fn()
  const stage = vi.fn()
  const tool = vi.fn()
  let workspace!: ReturnType<typeof useAttendanceGroupPolicyWorkspace>
  let toolCallback!: (action: (typeof cards)[number]['actions'][number]) => void
  const Root = defineComponent({
    setup() {
      workspace = useAttendanceGroupPolicyWorkspace({
        groupId: () => selected.value, orgId: () => org.value, canonical: () => canonical.value,
        stale: () => guard.stale.value, isCurrent: guard.isCurrent, openRoute: route, openStage: stage,
      })
      return () => options.bare ? legacy() : h(AttendanceGroupPolicyWorkspace, {
        enabled: workspace.enabled.value, visible: true, canonical: canonical.value,
        source: workspace.source.value, returnTo: '/attendance?tab=admin',
        onNavigate: workspace.navigate, onTool: tool,
      }, {
        legacy: () => [legacy()],
        tools: ({ openTool }: { openTool: typeof toolCallback }) => {
          toolCallback = openTool
          return [h('div', { 'data-attendance-group-policy-tools': '' }, cards.map(card =>
            h('button', {
              type: 'button',
              'data-attendance-group-summary-action': card.actions[0].key,
              onClick: () => openTool(card.actions[0]),
            }, card.actions[0].label),
          ))]
        },
      })
    },
  })
  app = createApp(Root)
  app.provide(attendanceSessionGuardKey, guard)
  app.mount(container)
  return { selected, org, route, stage, tool, workspace: () => workspace, toolCallback: () => toolCallback }
}
function click(selector: string) { container.querySelector<HTMLButtonElement>(selector)!.click() }

describe('W6 generic policy workspace', () => {
  it('OFF returns the one legacy VNode without extra DOM or aggregate GET', async () => {
    mount({ bare: true })
    await flush()
    const expected = container.innerHTML
    app!.unmount()
    app = null
    mount()
    await flush()
    expect(container.innerHTML).toBe(expected)
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('ON unsaved is neutral; canonical host owns its sole panel', async () => {
    enabled.value = true
    const state = mount({ unsaved: true })
    await flush()
    expect(container.querySelector('[data-attendance-group-policy-save-first]')?.textContent)
      .toBe('Save the attendance group before viewing effective policy.')
    expect(container.querySelector('[data-attendance-w6-effective-policy-panel]')).toBeNull()
    state.selected.value = A
    await flush()
    expect(container.querySelectorAll('[data-attendance-w6-effective-policy-panel]')).toHaveLength(1)
    expect(apiFetch).not.toHaveBeenCalled()
    // Re-mount a canonical workspace: the actual host is covered by its existing integration spec.
    app!.unmount()
    app = null
    mount({ canonical: true })
    await flush()
    expect(container.querySelector('[data-attendance-w6-effective-policy-panel]')).toBeNull()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('uses server labels after one explicit GET; refresh sends one more and tools keep the original object', async () => {
    enabled.value = true
    const state = mount()
    expect(apiFetch).not.toHaveBeenCalled()
    expect(container.querySelector('[data-legacy]')).toBeNull()
    expect(container.textContent).not.toContain('LOCAL_VALUE_MUST_NOT_RENDER')
    expect(container.textContent).not.toContain('LOCAL_DETAIL_MUST_NOT_RENDER')
    click('[data-attendance-w6-effective-policy-open]')
    await flush()
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect([...container.querySelectorAll('.attendance-group-effective-policy-panel__domain-label')]
      .map(node => node.textContent)).toEqual([
      'Effective', 'Inherited from organization', 'Preview only', 'Needs configuration',
      'Conflict - action required', 'Inherited from organization', 'Effective',
    ])
    click('[data-attendance-w6-effective-policy-domain-nav="rules"]')
    expect(state.route.mock.calls).toEqual([['rules', 'rule-sets']])
    click('[data-attendance-w6-effective-policy-domain-nav="membership"]')
    expect(state.stage.mock.calls).toEqual([[{ groupId: A, stage: 'people' }]])
    click('[data-attendance-group-summary-action="original-action"]')
    expect(state.tool.mock.calls[0][0]).toBe(cards[0].actions[0])
    click('[data-attendance-w6-effective-policy-refresh]')
    await flush()
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it.each([403, 404])('denial %s renders no source/effect labels or navigation', async status => {
    enabled.value = true
    vi.mocked(apiFetch).mockResolvedValue(response(status))
    mount()
    click('[data-attendance-w6-effective-policy-open]')
    await flush()
    expect(container.querySelector('[data-attendance-w6-effective-policy-unavailable]')).toBeTruthy()
    expect(container.querySelector('[data-attendance-w6-effective-policy-domains]')).toBeNull()
  })

  it('does not silently map an unknown server label to a closed status', async () => {
    enabled.value = true
    const invalid = fixture()
    invalid.data.domains.rules.label = 'invented_status'
    vi.mocked(apiFetch).mockResolvedValue(response(200, invalid))
    mount()
    click('[data-attendance-w6-effective-policy-open]')
    await flush()
    expect([...container.querySelectorAll('.attendance-group-effective-policy-panel__domain-label')][4]?.textContent)
      .toBe('Unrecognized')
  })

  it('rejects old A payload/actions/source objects after A -> B -> A', async () => {
    enabled.value = true
    let finish!: (value: Response) => void
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const state = mount()
    const oldSource = state.workspace().source.value!
    click('[data-attendance-w6-effective-policy-open]')
    state.selected.value = B
    await flush()
    state.selected.value = A
    await flush()
    expect(state.workspace().source.value).not.toBe(oldSource)
    finish(response())
    await flush()
    expect(container.querySelector('[data-attendance-w6-effective-policy-content]')).toBeNull()
    state.workspace().navigate({ groupId: A, editorRef: { kind: 'group_stage', stage: 'people' } }, oldSource)
    expect(state.stage).not.toHaveBeenCalled()
    click('[data-attendance-w6-effective-policy-open]')
    await flush()
    const oldButton = container.querySelector<HTMLButtonElement>('[data-attendance-w6-effective-policy-domain-nav="membership"]')!
    state.selected.value = B
    await flush()
    oldButton.click()
    expect(state.stage).not.toHaveBeenCalled()
  })

  it('renews the panel source on organization changes without reusing labels or fetching on mount', async () => {
    enabled.value = true
    const state = mount()
    const oldSource = state.workspace().source.value!
    click('[data-attendance-w6-effective-policy-open]')
    await flush()
    expect(container.querySelector('[data-attendance-w6-effective-policy-content]')).toBeTruthy()
    state.org.value = 'synthetic-other-org'
    await flush()
    expect(container.querySelector('[data-attendance-w6-effective-policy-content]')).toBeNull()
    expect(apiFetch).toHaveBeenCalledTimes(1)
    state.workspace().navigate({ groupId: A, editorRef: { kind: 'group_stage', stage: 'people' } }, oldSource)
    expect(state.stage).not.toHaveBeenCalled()
  })

  it('rejects the captured old-source tool callback while a reused live B button works', async () => {
    enabled.value = true
    const state = mount()
    const oldCallback = state.toolCallback()
    const liveButton = container.querySelector<HTMLButtonElement>('[data-attendance-group-summary-action]')!
    state.selected.value = B
    await flush()
    oldCallback(cards[0].actions[0])
    expect(state.tool).not.toHaveBeenCalled()
    // The same keyed DOM button is live B. Its updated invoker must remain usable.
    expect(container.querySelector('[data-attendance-group-summary-action]')).toBe(liveButton)
    liveButton.click()
    expect(state.tool.mock.calls).toEqual([[cards[0].actions[0]]])
    state.tool.mockClear()
    const currentCallback = state.toolCallback()
    guard.invalidate()
    await flush()
    currentCallback(cards[0].actions[0])
    expect(state.tool).not.toHaveBeenCalled()
    app!.unmount()
    app = null
    currentCallback(cards[0].actions[0])
    expect(state.tool).not.toHaveBeenCalled()
    expect(apiFetch).not.toHaveBeenCalled()
  })
})

describe('closed editorRef bridge', () => {
  it.each([
    ['schedule', 'schedule'],
    ['policies', 'rules'],
  ] as const)('maps group_stage %s through the shared canonical target into AV openRoute', (input, step) => {
    const a = source()
    const route = vi.fn()
    const stage = vi.fn()
    navigateAttendanceGroupPolicyWorkspace(
      { groupId: A, editorRef: { kind: 'group_stage', stage: input } },
      a, a, true, route, stage,
    )
    expect(route.mock.calls).toEqual([[step, null]])
    expect(stage).not.toHaveBeenCalled()
    expect(resolveAttendanceGroupEffectivePolicyEditorNavigationV1(
      { kind: 'group_stage', stage: input }, { groupId: A, returnTo: '/attendance?tab=admin' },
    )).toEqual({
      kind: 'route',
      href: '/attendance/admin/groups/' + A + '/' + step + '?returnTo=%2Fattendance%3Ftab%3Dadmin',
      sameRouteStage: { groupId: A, stage: input },
    })
  })

  it.each(['basics', 'people'] as const)('preserves the legitimate local %s stage', input => {
    const a = source()
    const route = vi.fn()
    const stage = vi.fn()
    navigateAttendanceGroupPolicyWorkspace(
      { groupId: A, editorRef: { kind: 'group_stage', stage: input } },
      a, a, true, route, stage,
    )
    expect(stage.mock.calls).toEqual([[{ groupId: A, stage: input }]])
    expect(route).not.toHaveBeenCalled()
  })

  it('requires the exact source instance, current session/group and a valid closed ref', () => {
    const a = source()
    const route = vi.fn()
    const stage = vi.fn()
    const target = { groupId: A, editorRef: { kind: 'group_stage', stage: 'people' } } as const
    navigateAttendanceGroupPolicyWorkspace(target, a, source(), true, route, stage)
    navigateAttendanceGroupPolicyWorkspace(target, a, a, false, route, stage)
    navigateAttendanceGroupPolicyWorkspace({ ...target, groupId: B }, a, a, true, route, stage)
    navigateAttendanceGroupPolicyWorkspace(
      { ...target, editorRef: { kind: 'group_stage', stage: 'unknown' } } as unknown as typeof target,
      a, a, true, route, stage,
    )
    expect(stage).not.toHaveBeenCalled()
    expect(route).not.toHaveBeenCalled()
    navigateAttendanceGroupPolicyWorkspace(target, a, a, true, route, stage)
    expect(stage.mock.calls).toEqual([[{ groupId: A, stage: 'people' }]])
  })
})
