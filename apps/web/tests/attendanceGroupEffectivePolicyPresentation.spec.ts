import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceGroupEffectivePolicyPanel from '../src/views/attendance/AttendanceGroupEffectivePolicyPanel.vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'
import { useLocale } from '../src/composables/useLocale'
import { attendanceSessionGuardKey, createAttendanceSessionGuard } from '../src/composables/useAttendanceSessionGuard'

vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    buildAuthHeaders: () => ({ 'x-tenant-id': 'synthetic-org' }),
    getCurrentUserId: async () => 'synthetic-admin',
    getAccessSnapshot: () => ({ roles: ['admin'], permissions: ['attendance:admin'], isAdmin: true, email: '' }),
    hasAdminAccess: () => true,
  }),
}))
vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([{ name: 'plugin-attendance', status: 'active' }]),
    views: ref([]), navItems: ref([]), loading: ref(false), error: ref(null),
    fetchPlugins: async () => {},
  }),
}))
const gate = ref(true)
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    hasFeature: (key: string) => key === 'attendance' || key === 'attendanceAdmin'
      || (key === 'attendanceGroupEffectivePolicyPanel' && gate.value),
  }),
}))
vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  const router = actual.createRouter({ history: actual.createMemoryHistory(), routes: [] })
  return { ...actual, useRouter: () => router }
})

const groupId = '11111111-2222-4333-8444-555555555555'
const group = { id: groupId, name: 'Synthetic reference group', timezone: 'UTC', attendanceType: 'fixed_shift', memberCount: 0 }
function response(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ ok: true, data }) } as Response
}
function fixture() {
  return {
    groupId, groupType: 'fixed_shift', timezone: 'UTC', activeMemberCount: 2,
    managerPosture: { ownerCount: 1, subOwnerCount: 0 }, calculationPosture: 'legacy',
    domains: {
      membership: { label: 'effective', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'people' } },
      schedule: { label: 'effective', strategy: 'fixed_shift', fixedSchedule: null, reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'schedule' } },
      segments: { label: 'preview_only', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'schedule' } },
      flex: { label: 'preview_only', mode: 'flex_required_duration', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'schedule' } },
      rules: { label: 'org_inherited', source: 'org_default', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'policies' } },
      punchMethod: { label: 'org_inherited', source: 'org_inherited', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'policies' } },
      requestPosture: { label: 'org_inherited', overtime: 'org_inherited', makeupPunch: 'org_inherited', outdoor: 'org_inherited', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'policies' } },
    },
    conflicts: [], evaluatedAt: '2026-10-26T00:00:00.000Z',
  }
}
type Detail = { domain: string; key: string; label: string; value: string }
const englishDetails: Detail[] = [
  { domain: 'schedule', key: 'strategy', label: 'Schedule strategy', value: 'Fixed shift' },
  { domain: 'flex', key: 'mode', label: 'Flex mode', value: 'Required duration' },
  { domain: 'rules', key: 'source', label: 'Rule source', value: 'Organization default rule' },
  { domain: 'punchMethod', key: 'source', label: 'Punch source', value: 'Inherited from organization' },
  { domain: 'requestPosture', key: 'overtime', label: 'Overtime', value: 'Inherited from organization' },
  { domain: 'requestPosture', key: 'makeupPunch', label: 'Makeup punch', value: 'Inherited from organization' },
  { domain: 'requestPosture', key: 'outdoor', label: 'Outdoor', value: 'Inherited from organization' },
]
const flush = async () => { for (let i = 0; i < 8; i += 1) { await Promise.resolve(); await nextTick() } }

describe('W6 authoritative summary presentation', () => {
  let app: App<Element> | null
  let host: HTMLDivElement
  let originalScroll: typeof HTMLElement.prototype.scrollIntoView
  beforeEach(() => {
    app = null
    host = document.createElement('div')
    document.body.appendChild(host)
    gate.value = true
    window.localStorage.clear()
    useLocale().setLocale('en')
    window.history.replaceState({}, '', '/attendance')
    originalScroll = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = vi.fn()
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const path = String(input)
      if (init?.method && init.method !== 'GET') throw new Error('UNEXPECTED_WRITE')
      if (path.endsWith('/effective-policy')) return response(fixture())
      if (path.startsWith('/api/attendance/groups?')) return response({ items: [group], total: 1, scope: 'org' })
      if (path === '/api/attendance/groups/' + groupId) return response(group)
      if (path === '/api/attendance/settings') return response({ ipAllowlist: [], minPunchIntervalMinutes: 1 })
      return response({ items: [], total: 0 })
    })
  })
  afterEach(() => {
    app?.unmount()
    host.remove()
    HTMLElement.prototype.scrollIntoView = originalScroll
    window.history.replaceState({}, '', '/attendance')
    window.localStorage.clear()
  })
  const click = async (selector: string) => {
    const button = host.querySelector<HTMLButtonElement>(selector)
    expect(button, selector).toBeTruthy()
    button!.click()
    await flush()
  }
  async function mountPanel(data = fixture()) {
    vi.mocked(apiFetch).mockResolvedValue(response(data))
    app = createApp(AttendanceGroupEffectivePolicyPanel, { groupId, returnTo: '/attendance?tab=admin&section=attendance-admin-groups' })
    app.provide(attendanceSessionGuardKey, createAttendanceSessionGuard('synthetic-org', () => 'synthetic-epoch'))
    app.mount(host)
    await flush()
  }
  const readDetails = (): Detail[] => [...host.querySelectorAll<HTMLElement>('[data-attendance-w6-effective-policy-detail]')]
    .map(row => ({
      domain: row.closest('.attendance-group-effective-policy-panel__domain-row')?.querySelector('[data-attendance-w6-effective-policy-domain-nav]')?.getAttribute('data-attendance-w6-effective-policy-domain-nav') || '',
      key: row.getAttribute('data-attendance-w6-effective-policy-detail') || '',
      label: row.querySelector('dt')?.textContent?.trim() || '',
      value: row.querySelector('dd')?.textContent?.trim() || '',
    }))
  async function mountGroup() {
    app = createApp(AttendanceView, { mode: 'admin', initialSectionId: 'attendance-admin-groups' })
    app.mount(host)
    await flush()
    await click('[data-attendance-group-row] .attendance__group-list-main')
    expect(host.querySelector<HTMLInputElement>('#attendance-group-name')?.value).toBe(group.name)
    await click('[data-attendance-group-workflow-step="policies"]')
  }

  it('keeps explicit-open semantics as the original positive control', async () => {
    await mountPanel()
    expect(apiFetch).not.toHaveBeenCalled()
    await click('[data-attendance-w6-effective-policy-open]')
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/groups/' + groupId + '/effective-policy')
    expect(host.querySelectorAll('.attendance-group-effective-policy-panel__domain-row')).toHaveLength(7)
    expect(host.textContent).toContain('Legacy')
  })

  it('renders existing saved domain facts without inferred domains or extra IO', async () => {
    await mountPanel()
    await click('[data-attendance-w6-effective-policy-open]')
    expect(readDetails()).toEqual(englishDetails)
    expect(host.querySelectorAll('.attendance-group-effective-policy-panel__domain-row')).toHaveLength(7)
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it('distinguishes absent optional flex mode from a strict mode default', async () => {
    const data = fixture()
    delete (data.domains.flex as Record<string, unknown>).mode
    await mountPanel(data)
    await click('[data-attendance-w6-effective-policy-open]')
    expect(readDetails().find(row => row.domain === 'flex')).toEqual({
      domain: 'flex', key: 'mode', label: 'Flex mode', value: 'Not provided',
    })
    expect(host.querySelector('[data-attendance-w6-effective-policy-domain-nav="flex"]')?.closest('.attendance-group-effective-policy-panel__domain-row')?.querySelector('.attendance-group-effective-policy-panel__domain-label')?.textContent).toBe('Preview only')
  })

  it('renders unknown required facts as unrecognized without echoing their raw values', async () => {
    const data = fixture()
    const domains = data.domains as Record<string, Record<string, unknown>>
    domains.schedule!.strategy = 'SYNTHETIC_PRIVATE_STRATEGY'
    domains.rules!.source = 'SYNTHETIC_PRIVATE_SOURCE'
    delete domains.punchMethod!.source
    domains.requestPosture!.outdoor = 'SYNTHETIC_PRIVATE_POSTURE'
    await mountPanel(data)
    await click('[data-attendance-w6-effective-policy-open]')
    expect(readDetails().filter(row => ['schedule', 'rules', 'punchMethod'].includes(row.domain)
      || row.key === 'outdoor').map(row => row.value)).toEqual(['Unrecognized', 'Unrecognized', 'Unrecognized', 'Unrecognized'])
    expect(host.textContent).not.toContain('SYNTHETIC_PRIVATE_')
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it('uses the parent literal English closed label wording', async () => {
    const data = fixture()
    data.domains.membership.label = 'conflict_action_required'
    await mountPanel(data)
    await click('[data-attendance-w6-effective-policy-open]')
    const labels = [...host.querySelectorAll('.attendance-group-effective-policy-panel__domain-label')]
      .map(row => row.textContent?.trim())
    expect(labels).toContain('Inherited from organization')
    expect(labels).toContain('Conflict - action required')
  })

  it('clearly separates the ON rule configuration reference from saved-group effect', async () => {
    await mountGroup()
    await click('[data-attendance-group-summary-action="open-rule-policy-drawer"]')
    const drawer = host.querySelector('[data-attendance-group-rule-policy-drawer]')!
    expect(drawer.querySelector('h6')?.textContent?.trim()).toBe('Rule configuration reference')
    expect(drawer.textContent).toContain('current editor/catalog values')
    expect(drawer.textContent).toContain("not the saved group's effective policy")
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method && init.method !== 'GET')).toEqual([])
  })

  it('clearly separates the ON punch configuration reference from saved-group effect', async () => {
    await mountGroup()
    await click('[data-attendance-group-summary-action="open-punch-method-drawer"]')
    const drawer = host.querySelector('[data-attendance-group-punch-method-drawer]')!
    expect(drawer.querySelector('h6')?.textContent?.trim()).toBe('Punch configuration reference')
    expect(drawer.textContent).toContain('loaded organization settings')
    expect(drawer.textContent).toContain("does not evaluate the selected group's current effective policy")
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method && init.method !== 'GET')).toEqual([])
  })

  it('retains original OFF drawer copy and never requests the aggregate', async () => {
    gate.value = false
    await mountGroup()
    await click('[data-attendance-group-summary-action="open-rule-policy-drawer"]')
    const rule = host.querySelector('[data-attendance-group-rule-policy-drawer]')!
    expect(rule.querySelector('h6')?.textContent?.trim()).toBe('Rule policy settings')
    expect(rule.textContent).toContain('This drawer summarizes the group rule link; rule contents remain in Rule Sets.')
    await click('[data-attendance-group-rule-policy-close]')
    await click('[data-attendance-group-summary-action="open-punch-method-drawer"]')
    const punch = host.querySelector('[data-attendance-group-punch-method-drawer]')!
    expect(punch.querySelector('h6')?.textContent?.trim()).toBe('Punch method settings')
    expect(punch.textContent).toContain('Current enforcement comes from workspace settings; this drawer is read-only for attendance groups.')
    expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).endsWith('/effective-policy'))).toEqual([])
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method && init.method !== 'GET')).toEqual([])
  })
})
