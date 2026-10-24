import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'
import { useLocale } from '../src/composables/useLocale'
import { FIXED_GROUP, OTHER_FIXED_GROUP, FIXED_STATES, fixedScheduleFixture, type FixtureFixedState } from './fixtures/fixedScheduleEffectiveness'
import { FIXED_ORG, FIXED_USER, fixedSurfaceResponse } from './fixtures/fixedScheduleSurfaces'

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({ plugins: ref([{ name: 'plugin-attendance', status: 'active' }]),
    views: ref([]), navItems: ref([]), loading: ref(false), error: ref(null),
    fetchPlugins: vi.fn().mockResolvedValue(undefined) }),
}))
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUserId: () => Promise.resolve('synthetic-fser-self'),
    buildAuthHeaders: () => ({ 'x-tenant-id': 'synthetic-fser-org' }),
    getAccessSnapshot: () => ({ isAdmin: true, permissions: ['attendance:read', 'attendance:admin'] }),
  }),
}))
vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))
const response = (payload: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status,
  json: async () => payload, text: async () => JSON.stringify(payload),
  blob: async () => new Blob([JSON.stringify(payload)]) }) as Response
async function flushUi() { for (let i = 0; i < 40; i += 1) { await Promise.resolve(); await nextTick() } }
type Surface = 'employee' | 'self-trace' | 'group' | 'admin-trace' | 'report'
describe('FSER4 actual AttendanceView hosts', () => {
  let app: App<Element> | undefined
  let container: HTMLDivElement
  let state: FixtureFixedState
  let matching: boolean
  let effectivenessStatus: number
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem('auth_token', 'synthetic-fser-session')
    localStorage.setItem('user_roles', JSON.stringify(['admin']))
    useLocale().setLocale('en')
    state = 'pending_apply'; matching = false; effectivenessStatus = 200
    vi.mocked(apiFetch).mockImplementation(async input => {
      const path = String(input)
      return response(fixedSurfaceResponse(path, state, matching),
        path.includes('/fixed-schedule/effectiveness') ? effectivenessStatus : 200)
    })
    container = document.createElement('div')
    document.body.append(container)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  })
  afterEach(() => { app?.unmount(); app = undefined; container.remove(); localStorage.clear() })
  async function mount(mode: 'overview' | 'admin' | 'reports') {
    window.history.replaceState({}, '', '/attendance?tab=' + mode)
    app = createApp(AttendanceView, { mode, initialSectionId: mode === 'admin' ? 'attendance-admin-decision-trace' : '' })
    app.mount(container)
    await flushUi()
  }
  function projection(surface: Surface) {
    const node = container.querySelector<HTMLElement>('[data-fser4-surface="' + surface + '"]')
    expect(node, 'FSER4_MOUNT_' + surface).not.toBeNull()
    return node!
  }
  function expectState(surface: Surface, wanted: FixtureFixedState) {
    const node = projection(surface)
    expect(node.querySelector('[data-fser4-state]')?.getAttribute('data-fser4-state'), 'FSER4_STATE_' + surface).toBe(wanted)
    expect(node.querySelector('[data-fser4-unavailable]')).toBeNull()
    return node
  }
  function zeroWrites() {
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init?.method ?? 'GET').toUpperCase() !== 'GET')).toEqual([])
  }
  it('executes both new specs in the domain guard and unconditional required lane', () => {
    const workflow = readFileSync(resolve(process.cwd(), '../../.github/workflows/attendance-web-guard.yml'), 'utf8')
    const runner = readFileSync(resolve(process.cwd(), 'scripts/run-required-web-tests.sh'), 'utf8')
    const workflowCommands = workflow.split('\n').filter(line => /^\s*run: pnpm --filter @metasheet\/web exec vitest run /.test(line))
    const requiredCommands = runner.split('\n').filter(line => /^(?:NODE_OPTIONS=\S+ )?(?:exec )?npx vitest run /.test(line))
    for (const name of ['attendance-fixed-schedule-effectiveness', 'attendance-fixed-schedule-surfaces']) {
      expect(workflowCommands.some(line => line.trim().split(/\s+/).includes(name)), 'FSER4_DOMAIN_EXEC_' + name).toBe(true)
      expect(requiredCommands.some(line => line.trim().split(/\s+/).includes(name)), 'FSER4_REQUIRED_EXEC_' + name).toBe(true)
      expect(workflow.split('\n').some(line => line.trim() === "- 'apps/web/tests/" + name + ".spec.ts'")).toBe(true)
      expect(workflow.split('\n').some(line => line.trim() === 'apps/web/tests/' + name + '.spec.ts|\\')).toBe(true)
    }
  })
  it.each(FIXED_STATES)('overview hosts %s', async wanted => {
    state = wanted
    await mount('overview')
    for (const surface of ['employee', 'self-trace'] as const) {
      const node = expectState(surface, wanted)
      expect(node.querySelector('[data-fser4-coverage]')).toBeNull()
      expect(node.querySelector('[data-fser4-drift]')).toBeNull()
      expect(node.querySelector('[data-fser4-producer-comparison]')).toBeNull()
      expect(node.textContent).not.toContain(FIXED_USER)
    }
    const requests = vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).includes('/fixed-schedule/effectiveness'))
    expect(requests).toHaveLength(2)
    for (const [url, init] of requests) {
      expect(url).toBe('/api/attendance/groups/' + FIXED_GROUP + '/fixed-schedule/effectiveness/me')
      expect(init).not.toHaveProperty('body')
    }
    zeroWrites()
  })
  it.each(FIXED_STATES)('admin hosts %s', async wanted => {
    state = wanted
    await mount('admin')
    const group = expectState('group', wanted)
    const trace = expectState('admin-trace', wanted)
    expect(group.querySelector('[data-fser4-coverage]')).not.toBeNull()
    expect(trace.querySelector('[data-fser4-producer-comparison]')).not.toBeNull()
    expect(trace.querySelector('[data-fser4-coverage]')).toBeNull()
    expect(container.querySelector('[data-attendance-group-fixed-schedule-config]')).not.toBeNull()
    zeroWrites()
  })
  it.each(FIXED_STATES)('report host %s', async wanted => {
    state = wanted
    await mount('reports')
    const report = expectState('report', wanted)
    expect(report.closest('[data-reports-layout="table-first"]')).not.toBeNull()
    expect(report.querySelector('[data-fser4-coverage]')).not.toBeNull()
    expect(report.querySelector('[data-fser4-desired]')).toBeNull()
    expect(report.querySelector('[data-fser4-reasons]')).toBeNull()
    expect(report.querySelector('[data-fser4-producer-comparison]')).toBeNull()
    expect(report.textContent).not.toContain(FIXED_USER)
    zeroWrites()
  })
  it.each([true, false])('both self hosts show own applicability matching=%s', async ownMatching => {
    matching = ownMatching
    await mount('overview')
    for (const surface of ['employee', 'self-trace'] as const) {
      expect(projection(surface).querySelector('[data-fser4-applicability]')?.getAttribute('data-fser4-applicability'))
        .toBe(ownMatching ? 'matching' : 'non_matching')
    }
  })
  it.each([false, true])('membership refresh removes a selected group and rejects its late reply (failed=%s)', async failed => {
    let refreshed = false
    const late: Array<(value: Response) => void> = []
    vi.mocked(apiFetch).mockImplementation(async input => {
      const url = String(input)
      const path = new URL(url, 'https://fixture.invalid').pathname
      if (path === '/api/attendance/rules/me') {
        if (refreshed && failed) return response({ ok: false, error: { code: 'UNAVAILABLE' } }, 503)
        const original = fixedSurfaceResponse(url, state, matching) as { ok: true; data: { assignment: { attendanceGroups: Array<Record<string, unknown>> } } }
        if (!refreshed) original.data.assignment.attendanceGroups.push({
          ...original.data.assignment.attendanceGroups[0], id: OTHER_FIXED_GROUP, name: 'Synthetic second group',
        })
        return response(original)
      }
      if (path.includes('/groups/' + OTHER_FIXED_GROUP + '/fixed-schedule/effectiveness/me')) {
        return new Promise<Response>(resolve => late.push(resolve))
      }
      return response(fixedSurfaceResponse(url, state, matching))
    })
    await mount('overview')
    for (const surface of ['employee', 'self-trace'] as const) {
      expectState(surface, 'pending_apply')
      const picker = projection(surface).querySelector<HTMLSelectElement>('[data-fser4-group-select]')!
      expect(Array.from(picker.options).map(option => option.value)).toContain(OTHER_FIXED_GROUP)
      picker.value = OTHER_FIXED_GROUP
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    }
    await flushUi()
    expect(late, 'FSER4_BOTH_OLD_GROUP_REQUESTS_SENT').toHaveLength(2)
    refreshed = true
    const refresh = container.querySelector<HTMLButtonElement>('button.attendance-ew__history-filter-control')
    expect(refresh, 'FSER4_REAL_OVERVIEW_REFRESH').not.toBeNull()
    refresh!.click()
    await flushUi()
    for (const settle of late) settle(response(fixedScheduleFixture('effective', true, true, OTHER_FIXED_GROUP)))
    await flushUi()
    for (const surface of ['employee', 'self-trace'] as const) {
      const node = projection(surface)
      const picker = node.querySelector<HTMLSelectElement>('[data-fser4-group-select]')!
      expect(Array.from(picker.options).map(option => option.value), 'FSER4_REMOVED_MEMBERSHIP_' + surface).not.toContain(OTHER_FIXED_GROUP)
      if (failed) {
        expect(node.querySelector('[data-fser4-state]'), 'FSER4_FAILED_MEMBERSHIP_CLEARS_' + surface).toBeNull()
        expect(node.querySelector('[data-fser4-unavailable]')).not.toBeNull()
      } else {
        expect(picker.value).toBe(FIXED_GROUP)
        expectState(surface, 'pending_apply')
      }
    }
    zeroWrites()
  })
  it('an aggregate 403 does not replace the editor read or clear its saved candidate', async () => {
    effectivenessStatus = 403
    await mount('admin')
    expect(projection('group').querySelector('[data-fser4-unavailable]')).not.toBeNull()
    expect(projection('group').querySelector('[data-fser4-state]')).toBeNull()
    const editor = container.querySelector('[data-attendance-group-fixed-schedule-config]')!
    expect(editor).not.toBeNull()
    expect(editor.querySelector('[data-attendance-group-fixed-schedule-config-error]')).toBeNull()
    const reads = vi.mocked(apiFetch).mock.calls.map(([url]) => String(url))
    expect(reads.some(url => url.includes('/fixed-schedule/editor?'))).toBe(true)
    const start = container.querySelector<HTMLInputElement>('#attendance-group-fixed-schedule-start')
    expect(start?.value).toBe('2026-10-01')
    expect(projection('admin-trace').querySelector('[data-fser4-unavailable]')).not.toBeNull()
    zeroWrites()
  })
  it('self trace does not query a selected foreign organization with the current signed session', async () => {
    await mount('overview')
    expectState('self-trace', 'pending_apply')
    const input = container.querySelector<HTMLInputElement>('#attendance-decision-trace-self-org')
    // This existing W5 input appears only after the multi-org prompt; use the actual
    // trace error response to expose it, never fabricate a replacement input.
    if (!input) {
      vi.mocked(apiFetch).mockImplementation(async input => String(input).startsWith('/api/attendance/decision-trace?')
        ? response({ ok: false, error: { code: 'ORG_ID_REQUIRED' } }, 400)
        : response(fixedSurfaceResponse(String(input), state, matching)))
      container.querySelector<HTMLButtonElement>('[data-decision-trace-self-load]')!.click()
      await flushUi()
    }
    const picker = container.querySelector<HTMLInputElement>('#attendance-decision-trace-self-org')
    expect(picker).not.toBeNull()
    vi.mocked(apiFetch).mockClear()
    picker!.value = 'synthetic-other-org'
    picker!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect(projection('self-trace').querySelector('[data-fser4-state]')).toBeNull()
    expect(projection('self-trace').querySelector('[data-fser4-unavailable]')).not.toBeNull()
    expect(vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).includes('/fixed-schedule/effectiveness')), 'FSER4_FOREIGN_ORG_NEW_READS').toEqual([])
    expect(FIXED_ORG).not.toBe('synthetic-other-org')
  })
})
