import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'
import { useLocale } from '../src/composables/useLocale'
import {
  ATTENDANCE_PROVISION_ROLES,
  ATTENDANCE_PROVISION_ROLE_PERMISSIONS,
} from '../src/views/attendance/attendanceProvisionRolePermissions'
import {
  buttonByText,
  emptyAttendanceResponse,
  flushUi,
  jsonResponse,
  recordApiCall,
  setInput,
} from './helpers/attendanceA1Harness'

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([{ name: 'plugin-attendance', status: 'active' }]),
    views: ref([]),
    navItems: ref([]),
    loading: ref(false),
    error: ref(null),
    fetchPlugins: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

const USER_ID = '11111111-1111-4111-8111-111111111111'

/** Server ATTENDANCE_ROLE_TEMPLATES permission rows. Hard-coded so dropping a code fails this file. */
const SERVER_TEMPLATE_PERMISSIONS = {
  employee: ['attendance:read', 'attendance:write'],
  approver: ['attendance:read', 'attendance:approve'],
  importer: ['attendance:read', 'attendance:import'],
  admin: ['attendance:read', 'attendance:write', 'attendance:approve', 'attendance:import', 'attendance:admin'],
} as const

describe('attendance provision role template list', () => {
  it('is one exhaustive list matching server templates, including importer and admin import', () => {
    expect([...ATTENDANCE_PROVISION_ROLES]).toEqual(['employee', 'approver', 'importer', 'admin'])
    for (const role of ATTENDANCE_PROVISION_ROLES) {
      expect([...ATTENDANCE_PROVISION_ROLE_PERMISSIONS[role]]).toEqual([...SERVER_TEMPLATE_PERMISSIONS[role]])
    }
    expect(ATTENDANCE_PROVISION_ROLE_PERMISSIONS.importer).toContain('attendance:import')
    expect(ATTENDANCE_PROVISION_ROLE_PERMISSIONS.admin).toContain('attendance:import')
    expect(ATTENDANCE_PROVISION_ROLE_PERMISSIONS.admin).toContain('attendance:admin')
  })
})

describe('AttendanceView mounted provisioning templates', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let legacyUnavailable = true
  let revokeMissesRemaining = 0
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined
  let originalFetch: typeof globalThis.fetch | undefined

  function clearSessionStorage(): void {
    localStorage.removeItem('user_roles')
    localStorage.removeItem('user_permissions')
    localStorage.removeItem('tenantId')
    localStorage.removeItem('workspaceId')
    localStorage.removeItem('auth_token')
    localStorage.removeItem('jwt')
    localStorage.removeItem('devToken')
  }

  // Mount clears stored roles when no token exists, and the platform-admin
  // computed reads that snapshot. A fixture token keeps the snapshot, and the
  // session read is stubbed so it cannot replace the role.
  function installPlatformAdmin(): void {
    localStorage.setItem('auth_token', 'platform-admin-fixture')
    localStorage.setItem('user_roles', JSON.stringify(['admin']))
  }

  beforeEach(() => {
    legacyUnavailable = true
    revokeMissesRemaining = 0
    useLocale().setLocale('en')
    window.history.replaceState({}, '', '/attendance')
    clearSessionStorage()
    originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/auth/me')) {
        return new Response(JSON.stringify({
          user: { id: 'fixture-user', role: 'admin', roles: ['admin'] },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof globalThis.fetch
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const call = recordApiCall(input, init)
      if (call.url.includes('/roles/assign') || call.url.includes('/roles/unassign')) {
        if (!legacyUnavailable) {
          return jsonResponse(200, {
            ok: true,
            data: {
              user: { id: USER_ID, email: 'person@example.com', name: 'Person' },
              roles: ['attendance_employee'],
              permissions: ['attendance:read', 'attendance:write'],
              isAdmin: false,
            },
          })
        }
        return jsonResponse(404, { message: 'Not Found' })
      }
      if (call.url === '/api/permissions/grant') {
        return jsonResponse(200, { ok: true })
      }
      if (call.url === '/api/permissions/revoke') {
        if (revokeMissesRemaining > 0) {
          revokeMissesRemaining -= 1
          return jsonResponse(404, { message: 'Not Found' })
        }
        return jsonResponse(200, { ok: true })
      }
      if (call.url.startsWith('/api/permissions/user/')) {
        return jsonResponse(200, {
          userId: USER_ID,
          permissions: ['attendance:read'],
          isAdmin: false,
        })
      }
      return emptyAttendanceResponse()
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: originalScrollIntoView })
    }
    app = null
    container = null
    clearSessionStorage()
    if (originalFetch) globalThis.fetch = originalFetch
    useLocale().setLocale('en')
  })

  async function mountAdmin(): Promise<HTMLElement> {
    app = createApp(AttendanceView, { mode: 'admin', initialSectionId: 'attendance-admin-user-access' })
    app.mount(container!)
    await flushUi(12)
    return container!
  }

  function setSelect(root: HTMLElement, selector: string, value: string): void {
    const select = root.querySelector<HTMLSelectElement>(selector)
    if (!select) throw new Error(`expected select ${selector}`)
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function setTextArea(root: HTMLElement, selector: string, value: string): void {
    const input = root.querySelector<HTMLTextAreaElement>(selector)
    if (!input) throw new Error(`expected textarea ${selector}`)
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function recordedCalls() {
    return vi.mocked(apiFetch).mock.calls.map(([input, init]) => recordApiCall(input, init))
  }

  function permissionBodies(path: string): string[] {
    return recordedCalls()
      .filter((call) => call.url === path && call.method === 'POST')
      .map((call) => String(call.body?.permission || ''))
  }

  async function waitForOutcome(section: Element, path: string, expected: readonly string[], statusIncludes: string): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await flushUi(2)
      const permissions = permissionBodies(path)
      const status = section.querySelector('.attendance__status')?.textContent || ''
      if (permissions.length === expected.length && status.includes(statusIncludes)) return
    }
    const status = section.querySelector('.attendance__status')?.textContent || ''
    throw new Error(`timed out waiting for ${path} ${JSON.stringify(permissionBodies(path))} status=${status}`)
  }

  it('renders importer beside employee, approver, and admin on both mounted role selects', async () => {
    const root = await mountAdmin()
    for (const selector of ['#attendance-provision-role', '#attendance-provision-batch-role']) {
      const select = root.querySelector<HTMLSelectElement>(selector)
      expect(select, selector).toBeTruthy()
      expect(Array.from(select!.options).map((option) => option.value)).toEqual([
        'employee',
        'approver',
        'importer',
        'admin',
      ])
      expect(select!.value).toBe('employee')
      expect(select!.options[2].textContent?.trim()).toBe('importer')
    }
  })

  it('keeps the modern assign request and does not grant permissions when the template endpoint succeeds', async () => {
    installPlatformAdmin()
    legacyUnavailable = false
    const root = await mountAdmin()
    setInput(root, '#attendance-provision-user-id', USER_ID)
    setSelect(root, '#attendance-provision-role', 'importer')
    await flushUi(2)
    vi.mocked(apiFetch).mockClear()
    const modernSection = root.querySelector('#attendance-admin-user-access')!
    buttonByText(modernSection, 'Assign role').click()
    await waitForOutcome(modernSection, '/api/permissions/grant', [], "Role 'importer' assigned.")

    const assign = recordedCalls().find((call) => call.url.endsWith('/roles/assign'))
    expect(assign?.method).toBe('POST')
    expect(assign?.body).toEqual({ template: 'importer', scope: 'global' })
    expect(recordedCalls().some((call) => call.url === '/api/permissions/grant')).toBe(false)
  })

  it('grants every template permission through the platform 404 fallback, including importer and admin', async () => {
    installPlatformAdmin()
    const root = await mountAdmin()
    const section = root.querySelector('#attendance-admin-user-access')!
    setInput(root, '#attendance-provision-user-id', USER_ID)

    for (const role of ['employee', 'approver', 'importer', 'admin'] as const) {
      setSelect(root, '#attendance-provision-role', role)
      await flushUi(2)
      vi.mocked(apiFetch).mockClear()
      buttonByText(section, 'Assign role').click()
      await waitForOutcome(section, '/api/permissions/grant', SERVER_TEMPLATE_PERMISSIONS[role], `Role '${role}' granted.`)

      const assign = recordedCalls().find((call) => call.url.endsWith('/roles/assign'))
      expect(assign?.body).toEqual({ template: role, scope: 'global' })
      expect(permissionBodies('/api/permissions/grant')).toEqual([...SERVER_TEMPLATE_PERMISSIONS[role]])
      expect(recordedCalls().some((call) => call.url === `/api/permissions/user/${encodeURIComponent(USER_ID)}`)).toBe(true)
    }
  })

  it('revokes importer and admin permissions on the platform 404 fallback, and treats a missing permission as already gone', async () => {
    installPlatformAdmin()
    const root = await mountAdmin()
    const section = root.querySelector('#attendance-admin-user-access')!
    setInput(root, '#attendance-provision-user-id', USER_ID)

    setSelect(root, '#attendance-provision-role', 'importer')
    await flushUi(2)
    vi.mocked(apiFetch).mockClear()
    buttonByText(section, 'Remove role').click()
    await waitForOutcome(section, '/api/permissions/revoke', SERVER_TEMPLATE_PERMISSIONS.importer, "Role 'importer' revoked.")
    expect(recordedCalls().find((call) => call.url.endsWith('/roles/unassign'))?.body).toEqual({
      template: 'importer',
      scope: 'global',
    })
    expect(permissionBodies('/api/permissions/revoke')).toEqual([...SERVER_TEMPLATE_PERMISSIONS.importer])

    setSelect(root, '#attendance-provision-role', 'admin')
    await flushUi(2)
    revokeMissesRemaining = 1
    vi.mocked(apiFetch).mockClear()
    buttonByText(section, 'Remove role').click()
    await waitForOutcome(section, '/api/permissions/revoke', SERVER_TEMPLATE_PERMISSIONS.admin, "Role 'admin' revoked.")
    expect(permissionBodies('/api/permissions/revoke')).toEqual([...SERVER_TEMPLATE_PERMISSIONS.admin])
    expect(root.querySelector('#attendance-admin-user-access .attendance__status')?.textContent).toContain("Role 'admin' revoked.")
  })

  it('uses the same list for batch assign and batch remove fallbacks', async () => {
    installPlatformAdmin()
    const root = await mountAdmin()
    const section = root.querySelector('#attendance-admin-batch-provisioning')!
    setTextArea(root, '#attendance-provision-batch-user-ids', USER_ID)

    setSelect(root, '#attendance-provision-batch-role', 'importer')
    await flushUi(2)
    vi.mocked(apiFetch).mockClear()
    buttonByText(section, 'Assign role (batch)').click()
    await waitForOutcome(section, '/api/permissions/grant', SERVER_TEMPLATE_PERMISSIONS.importer, "Role 'importer' assigned to")
    const batchAssign = recordedCalls().find((call) => call.url.endsWith('/batch/roles/assign'))
    expect(batchAssign?.body).toEqual({ userIds: [USER_ID], template: 'importer', scope: 'global' })
    const perUserAssign = recordedCalls().find((call) => call.url.endsWith(`/users/${encodeURIComponent(USER_ID)}/roles/assign`))
    expect(perUserAssign?.body).toEqual({ template: 'importer', scope: 'global' })
    expect(permissionBodies('/api/permissions/grant')).toEqual([...SERVER_TEMPLATE_PERMISSIONS.importer])

    setSelect(root, '#attendance-provision-batch-role', 'admin')
    await flushUi(2)
    vi.mocked(apiFetch).mockClear()
    buttonByText(section, 'Remove role (batch)').click()
    await waitForOutcome(section, '/api/permissions/revoke', SERVER_TEMPLATE_PERMISSIONS.admin, "Role 'admin' removed from")
    expect(recordedCalls().find((call) => call.url.endsWith('/batch/roles/unassign'))?.body).toEqual({
      userIds: [USER_ID],
      template: 'admin',
      scope: 'global',
    })
    expect(permissionBodies('/api/permissions/revoke')).toEqual([...SERVER_TEMPLATE_PERMISSIONS.admin])
  })

  it('does not turn an org-scoped 404 into legacy permission grants', async () => {
    localStorage.setItem('tenantId', 'org-fixture')
    const root = await mountAdmin()
    setInput(root, '#attendance-provision-user-id', USER_ID)
    setSelect(root, '#attendance-provision-role', 'admin')
    await flushUi(2)
    vi.mocked(apiFetch).mockClear()
    const orgSection = root.querySelector('#attendance-admin-user-access')!
    buttonByText(orgSection, 'Assign role').click()
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await flushUi(2)
      if (orgSection.querySelector('.attendance__status--error')) break
    }

    const assign = recordedCalls().find((call) => call.url.endsWith('/roles/assign'))
    expect(assign?.body).toEqual({ template: 'admin', orgId: 'org-fixture' })
    expect(recordedCalls().some((call) => call.url === '/api/permissions/grant')).toBe(false)
    expect(root.querySelector('#attendance-admin-user-access .attendance__status--error')).toBeTruthy()
  })
})
