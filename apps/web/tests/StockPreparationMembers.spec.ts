import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// 备料「成员与权限」— S5b (ADR adr-stock-prep-project-sheets-20261008 §11.4–11.6; register R-39).
//
//   SMW-CLIENT  the members read: 404 ⇒ disabled, 403 ROLE_DELEGATION_SCOPE_REQUIRED ⇒ scope-required,
//               a 200 that is not the page (no `enabled: true`) is NOT the page, any other refusal throws;
//               the custom-role calls send exactly their closed bodies; appoint = assign then admission;
//               revoke = unassign; the main administrator is refused before any request.
//   SMW-CLAMP   the server cannot make the page offer the main administrator; only stock-prep codes pass.
//   SMW-SHELL   the 「成员与权限」 rail item exists only when the read answered (switch on, admitted
//               caller) — hidden for the switch-off 404, for a non-delegated stock-prep:admin holder's 403
//               and while unknown; nobody below the workbench-admin tier even issues the read; a
//               `?tab=members` deep link with the switch off lands elsewhere.
//   SMW-PAGE    built-ins read-only (no save control), the main administrator never appointable, custom
//               roles editable within the grantor's codes, the add-tables control only when project
//               sheets can be listed, the 「不能移除」 line, the scope-required notice alone.
//   SMW-ALIGN   the four members.* manifest rows are byte-equal to the plugin's, and every members control
//               the page renders is one the SERVER grants this actor.
//
// Synthetic ids only.

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  permissions: ['stock-prep:admin'] as string[],
  roles: [] as string[],
  route: { path: '/stock-prep', fullPath: '/stock-prep', meta: {} as Record<string, unknown>, query: {} as Record<string, unknown> },
  router: { push: vi.fn(), replace: vi.fn() },
  apiFetch: vi.fn(),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({ locale: ref(h.locale), isZh: ref(h.locale === 'zh-CN'), setLocale: vi.fn() }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: () => 'session-token',
    clearToken: vi.fn(),
    getAccessSnapshot: () => ({ isAdmin: h.roles.includes('admin'), email: '', roles: h.roles, permissions: h.permissions }),
    hasAdminAccess: () => h.roles.includes('admin'),
    hasPermission: (permission: string) => h.permissions.includes(permission),
  }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return { ...actual, apiFetch: h.apiFetch, clearStoredAuthState: vi.fn(), getApiBase: () => 'https://api.example.com' }
})

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return { ...actual, useRoute: () => h.route, useRouter: () => h.router }
})

import StockPreparationMembersView from '../src/components/integration/stockPreparation/StockPreparationMembersView.vue'
import StockPreparationWorkspace from '../src/components/integration/stockPreparation/StockPreparationWorkspace.vue'
import {
  STOCK_PREP_MEMBERS_ERROR_PLAIN,
  StockPrepMembersCallError,
  addStockPrepCustomRoleProjectTargets,
  appointStockPrepMember,
  clampStockPrepMembersView,
  createStockPrepCustomRole,
  readStockPrepMembers,
  revokeStockPrepMember,
  updateStockPrepCustomRole,
  type StockPrepMembersReadOutcome,
} from '../src/services/integration/stockPreparation/members'
import {
  STOCK_PREP_WORKBENCH_CAPABILITIES,
  canOpenStockPrepMembersPage,
  visibleStockPrepControls,
} from '../src/services/integration/stockPreparation/workbenchAccess'
import { resetStockPreparationOperatorHomeDirectoryThrottle } from '../src/services/integration/stockPreparation/operatorHomeDirectory'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const backendAccess = require('../../../plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs')

const SCOPE = { tenantId: 'tenant-syn', workspaceId: 'workspace-syn' }
const CUSTOM = 'stock-prep_c_0a1b2c3d'
const SHEET_A = 'sheet_syn_a'
const SHEET_B = 'sheet_syn_b'
const MEMBERS_URL = '/api/integration/stock-preparation/members'

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status })
}

function refused(status: number, code: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message: 'synthetic refusal' } }), { status })
}

function role(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: id.startsWith('stock-prep_c_') ? 'custom' : 'builtin',
    installed: true,
    name: id,
    permissionCodes: ['stock-prep:read'],
    otherCodeCount: 0,
    editable: id.startsWith('stock-prep_c_'),
    appointable: id !== 'stock-prep_admin',
    members: [],
    outOfScopeMemberCount: 0,
    ...overrides,
  }
}

function membersPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    actor: { isPlatformAdmin: false, delegated: true, scopeConfigured: true },
    grantableCodes: ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull'],
    selectableCodes: ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull'],
    builtInRoles: [
      role('stock-prep_admin', { permissionCodes: ['stock-prep:admin'], appointable: false, members: [{ userId: 'u_main', name: '主管', email: null, username: null, admitted: true }] }),
      role('stock-prep_puller', { permissionCodes: ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull'] }),
      role('stock-prep_developer', { installed: false, appointable: false }),
      role('stock-prep_frontline', { permissionCodes: ['stock-prep:read', 'stock-prep:operate'], members: [{ userId: 'u_floor', name: '甲', email: null, username: null, admitted: false }], outOfScopeMemberCount: 2 }),
    ],
    customRoles: [role(CUSTOM, { name: '仓库只填两张表', sheetIds: [SHEET_A], otherSheetCount: 1 })],
    otherRoles: [],
    audit: { available: true, entries: [{ at: '2026-10-09T00:00:00.000Z', action: 'grant', resourceType: 'user-role', userId: 'u_floor', roleId: 'stock-prep_frontline' }] },
    ...overrides,
  }
}

async function flush(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((done) => { setTimeout(done, 0) })
    await nextTick()
  }
}

/** Route every read the shell and the page make; `members` is the ONE answer under test. */
function answer(members: () => Response, extra: (url: string, init?: RequestInit) => Response | null = () => null): void {
  h.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const target = String(url)
    const custom = extra(target, init)
    if (custom) return custom
    if (target === MEMBERS_URL) return members()
    if (target.includes('/stock-preparation/project-targets')) {
      return ok({ count: 2, limit: 200, items: [
        { projectNo: 'PRJ-SYN-A', status: 'active', sheetId: SHEET_A },
        { projectNo: 'PRJ-SYN-B', status: 'active', sheetId: SHEET_B },
        { projectNo: 'PRJ-SYN-C', status: 'archived', sheetId: 'sheet_syn_c' },
      ] })
    }
    if (target.includes('/stock-preparation/preflight')) return ok({ ready: false, blockerCount: 1, blockers: [], posture: {} })
    if (target.includes('/operator/projects')) {
      return ok({ tenantId: 't1', directoryReady: true, ledgerReady: true, projectCount: 0, pendingProjectCount: 0, projects: [] })
    }
    return ok({ eligibleSources: [] })
  })
}

function membersCalls(): string[] {
  return h.apiFetch.mock.calls.map((call) => String(call[0])).filter((url) => url.startsWith(MEMBERS_URL) || url.includes('/role-delegation/'))
}

describe('备料「成员与权限」(S5b, R-39)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.permissions = ['stock-prep:admin']
    h.roles = []
    h.route = { path: '/stock-prep', fullPath: '/stock-prep', meta: {}, query: {} }
    h.apiFetch.mockReset()
    resetStockPreparationOperatorHomeDirectoryThrottle()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  async function mountShell(): Promise<HTMLDivElement> {
    app = createApp(StockPreparationWorkspace as Component)
    app.mount(container!)
    await flush()
    return container!
  }

  async function mountPage(outcome: StockPrepMembersReadOutcome): Promise<HTMLDivElement> {
    app = createApp(StockPreparationMembersView as Component, { scope: SCOPE, initialOutcome: outcome })
    app.mount(container!)
    await flush()
    return container!
  }

  // ── SMW-CLIENT ────────────────────────────────────────────────────────────────────────────────

  it('SMW-CLIENT: the read maps 404 to disabled, scope-required to its own outcome, and refuses a 200 that is not the page', async () => {
    h.apiFetch.mockResolvedValueOnce(refused(404, 'STOCK_PREP_MEMBERS_PAGE_DISABLED'))
    expect(await readStockPrepMembers()).toEqual({ kind: 'disabled' })
    h.apiFetch.mockResolvedValueOnce(refused(403, 'ROLE_DELEGATION_SCOPE_REQUIRED'))
    expect(await readStockPrepMembers()).toEqual({ kind: 'scope-required' })
    h.apiFetch.mockResolvedValueOnce(ok(membersPayload()))
    const ready = await readStockPrepMembers()
    expect(ready.kind).toBe('ready')
    // A generic envelope (what an unrelated mock or an older host answers) is NOT the page.
    h.apiFetch.mockResolvedValueOnce(ok({ eligibleSources: [] }))
    await expect(readStockPrepMembers()).rejects.toBeInstanceOf(StockPrepMembersCallError)
    h.apiFetch.mockResolvedValueOnce(refused(403, 'STOCK_PREP_MEMBERS_FORBIDDEN'))
    await expect(readStockPrepMembers()).rejects.toMatchObject({ status: 403, code: 'STOCK_PREP_MEMBERS_FORBIDDEN' })
    // The read carries no query and no body.
    expect(h.apiFetch.mock.calls[0]).toEqual([MEMBERS_URL])
  })

  it('SMW-CLIENT: the custom-role calls send exactly their closed bodies, no query', async () => {
    h.apiFetch.mockImplementation(async () => ok({ roleId: CUSTOM }, 201))
    await createStockPrepCustomRole('采购只读', ['stock-prep:read'])
    await updateStockPrepCustomRole(CUSTOM, { permissionCodes: ['stock-prep:read', 'stock-prep:operate'] })
    await updateStockPrepCustomRole(CUSTOM, { name: '改名' })
    await addStockPrepCustomRoleProjectTargets(CUSTOM, ['PRJ-SYN-A'])
    const calls = h.apiFetch.mock.calls.map(([url, init]) => [url, (init as RequestInit).method, JSON.parse(String((init as RequestInit).body))])
    expect(calls).toEqual([
      [`${MEMBERS_URL}/custom-roles`, 'POST', { name: '采购只读', permissionCodes: ['stock-prep:read'] }],
      [`${MEMBERS_URL}/custom-roles/${CUSTOM}`, 'PATCH', { permissionCodes: ['stock-prep:read', 'stock-prep:operate'] }],
      [`${MEMBERS_URL}/custom-roles/${CUSTOM}`, 'PATCH', { name: '改名' }],
      [`${MEMBERS_URL}/custom-roles/${CUSTOM}/project-targets`, 'POST', { projectNos: ['PRJ-SYN-A'] }],
    ])
  })

  it('SMW-CLIENT: appoint = the existing assign route then the stock-prep admission; revoke = unassign; the main administrator never leaves the browser', async () => {
    h.apiFetch.mockImplementation(async () => ok({}))
    expect(await appointStockPrepMember('u_x', 'stock-prep_frontline')).toEqual({ admitted: true })
    await revokeStockPrepMember('u_x', 'stock-prep_frontline')
    expect(h.apiFetch.mock.calls.map(([url, init]) => [url, (init as RequestInit).method, JSON.parse(String((init as RequestInit).body))])).toEqual([
      ['/api/admin/role-delegation/users/u_x/roles/assign', 'POST', { roleId: 'stock-prep_frontline' }],
      ['/api/admin/role-delegation/users/u_x/namespaces/stock-prep/admission', 'PATCH', { enabled: true }],
      ['/api/admin/role-delegation/users/u_x/roles/unassign', 'POST', { roleId: 'stock-prep_frontline' }],
    ])
    h.apiFetch.mockClear()
    await expect(appointStockPrepMember('u_x', 'stock-prep_admin')).rejects.toMatchObject({ code: 'STOCK_PREP_MAIN_ADMIN_NOT_APPOINTABLE_HERE' })
    await expect(revokeStockPrepMember('u_x', 'stock-prep_admin')).rejects.toMatchObject({ code: 'STOCK_PREP_MAIN_ADMIN_NOT_APPOINTABLE_HERE' })
    expect(h.apiFetch).not.toHaveBeenCalled()
    // A role that landed while the admission failed reports it, rather than claiming success.
    h.apiFetch.mockReset()
    h.apiFetch.mockResolvedValueOnce(ok({})).mockResolvedValueOnce(refused(403, 'ROLE_DELEGATION_USER_OUT_OF_SCOPE'))
    expect(await appointStockPrepMember('u_x', 'stock-prep_puller')).toEqual({ admitted: false })
    // Every code this page can meet has its own plain sentence.
    for (const code of ['STOCK_PREP_MEMBERS_FORBIDDEN', 'ROLE_DELEGATION_SCOPE_REQUIRED', 'STOCK_PREP_CUSTOM_ROLE_PLATFORM_CODE_FORBIDDEN', 'STOCK_PREP_CUSTOM_ROLE_EXCEEDS_GRANTOR', 'STOCK_PREP_CUSTOM_ROLE_SHEET_NOT_READABLE', 'STOCK_PREP_BUILTIN_ROLE_READ_ONLY', 'STOCK_PREP_CUSTOM_ROLE_MEMBERS_OUT_OF_SCOPE', 'STOCK_PREP_CUSTOM_ROLE_LIMIT']) {
      expect(STOCK_PREP_MEMBERS_ERROR_PLAIN[code], code).toBeTruthy()
    }
  })

  // ── SMW-CLAMP ─────────────────────────────────────────────────────────────────────────────────

  it('SMW-CLAMP: a server flag cannot make the page offer the main administrator; only stock-prep codes pass', () => {
    const view = clampStockPrepMembersView(membersPayload({
      builtInRoles: [role('stock-prep_admin', { appointable: true, permissionCodes: ['stock-prep:admin', 'multitable:write', '*:*'] })],
    }))
    expect(view?.builtInRoles[0].appointable).toBe(false)
    expect(view?.builtInRoles[0].permissionCodes).toEqual(['stock-prep:admin'])
    expect(clampStockPrepMembersView({ ...membersPayload(), enabled: false })).toBeNull()
  })

  // ── SMW-SHELL ─────────────────────────────────────────────────────────────────────────────────

  it('SMW-SHELL: switch off (404) ⇒ no 「成员与权限」 item, for a workbench admin and a platform admin', async () => {
    for (const actor of [{ permissions: ['stock-prep:admin'], roles: [] as string[] }, { permissions: ['integration:admin'], roles: ['admin'] }]) {
      h.permissions = actor.permissions
      h.roles = actor.roles
      answer(() => refused(404, 'STOCK_PREP_MEMBERS_PAGE_DISABLED'))
      const root = await mountShell()
      expect(membersCalls(), 'the shell asked once').toEqual([MEMBERS_URL])
      expect(root.querySelector('[data-testid="stock-prep-tab-members"]')).toBeNull()
      expect(root.querySelector('[data-testid="stock-prep-tab-ops"]')).not.toBeNull()
      app!.unmount()
      app = null
      container!.innerHTML = ''
      h.apiFetch.mockReset()
    }
  })

  it('SMW-SHELL: the item exists once the server answered (200, or the scope-required 403), and not for a refusing host', async () => {
    answer(() => ok(membersPayload()))
    let root = await mountShell()
    const tab = root.querySelector('[data-testid="stock-prep-tab-members"]') as HTMLButtonElement | null
    expect(tab).not.toBeNull()
    tab!.click()
    await flush()
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).toBe('members')
    expect(root.querySelector('[data-testid="stock-prep-members-page"]')).not.toBeNull()
    app!.unmount()
    app = null
    container!.innerHTML = ''

    answer(() => refused(403, 'ROLE_DELEGATION_SCOPE_REQUIRED'))
    root = await mountShell()
    ;(root.querySelector('[data-testid="stock-prep-tab-members"]') as HTMLButtonElement).click()
    await flush()
    expect(root.querySelector('[data-testid="stock-prep-members-scope-required"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-members-page"]')).toBeNull()
    app!.unmount()
    app = null
    container!.innerHTML = ''

    // A stock-prep:admin holder who is NOT the delegated admin: the host port refuses ⇒ hidden.
    answer(() => refused(403, 'STOCK_PREP_MEMBERS_FORBIDDEN'))
    root = await mountShell()
    expect(root.querySelector('[data-testid="stock-prep-tab-members"]')).toBeNull()
  })

  it('SMW-SHELL: below the workbench-admin tier the read is never issued and the item never renders', async () => {
    for (const permissions of [['stock-prep:read'], ['stock-prep:read', 'stock-prep:operate'], ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull']]) {
      h.permissions = permissions
      h.roles = []
      expect(canOpenStockPrepMembersPage({ roles: [], permissions })).toBe(false)
      answer(() => ok(membersPayload()))
      const root = await mountShell()
      expect(membersCalls(), permissions.join('+')).toEqual([])
      expect(root.querySelector('[data-testid="stock-prep-tab-members"]')).toBeNull()
      app!.unmount()
      app = null
      container!.innerHTML = ''
      h.apiFetch.mockReset()
    }
  })

  it('SMW-SHELL: ?tab=members with the switch off lands on the admin landing, never on the page', async () => {
    h.route = { path: '/stock-prep', fullPath: '/stock-prep?tab=members', meta: {}, query: { tab: 'members' } }
    answer(() => refused(404, 'STOCK_PREP_MEMBERS_PAGE_DISABLED'))
    const root = await mountShell()
    expect(root.querySelector('[data-testid="stock-prep-panel"]')?.getAttribute('data-active')).not.toBe('members')
    expect(root.querySelector('[data-testid="stock-prep-members"]')).toBeNull()
  })

  // ── SMW-PAGE ──────────────────────────────────────────────────────────────────────────────────

  it('SMW-PAGE: built-ins read-only, the main administrator never appointable, custom roles editable, tables add-only', async () => {
    answer(() => ok(membersPayload()))
    const root = await mountPage({ kind: 'ready', view: clampStockPrepMembersView(membersPayload())! })
    const admin = root.querySelector('[data-testid="stock-prep-members-role-stock-prep_admin"]')!
    expect(admin.querySelector('[data-testid="stock-prep-members-main-admin-note"]')).not.toBeNull()
    expect(admin.querySelector('[data-testid="stock-prep-members-appoint-form-stock-prep_admin"]')).toBeNull()
    expect(admin.querySelector('[data-testid="stock-prep-members-revoke"]')).toBeNull()
    expect(admin.querySelector('[data-testid="stock-prep-members-custom-role-save"]')).toBeNull()
    const puller = root.querySelector('[data-testid="stock-prep-members-role-stock-prep_puller"]')!
    expect(puller.querySelector('[data-testid="stock-prep-members-appoint-form-stock-prep_puller"]')).not.toBeNull()
    expect(puller.querySelector('[data-testid="stock-prep-members-custom-role-save"]')).toBeNull()
    const developer = root.querySelector('[data-testid="stock-prep-members-role-stock-prep_developer"]')!
    expect(developer.getAttribute('data-installed')).toBe('false')
    expect(developer.querySelector('[data-testid="stock-prep-members-role-not-installed"]')).not.toBeNull()
    const frontline = root.querySelector('[data-testid="stock-prep-members-role-stock-prep_frontline"]')!
    expect(frontline.querySelector('[data-testid="stock-prep-members-admit"]')).not.toBeNull()
    expect(frontline.querySelector('[data-testid="stock-prep-members-out-of-scope"]')?.textContent).toContain('2')
    const custom = root.querySelector(`[data-testid="stock-prep-members-role-${CUSTOM}"]`)!
    expect(custom.querySelector('[data-testid="stock-prep-members-custom-role-save"]')).not.toBeNull()
    expect(custom.querySelector('[data-testid="stock-prep-members-custom-role-sheets"]')?.textContent).toContain('PRJ-SYN-A')
    // Only ACTIVE sheets the role does not hold yet are offered; nothing offers a removal.
    expect(custom.querySelector(`[data-testid="stock-prep-members-custom-role-table-${CUSTOM}-PRJ-SYN-B"]`)).not.toBeNull()
    expect(custom.querySelector(`[data-testid="stock-prep-members-custom-role-table-${CUSTOM}-PRJ-SYN-A"]`)).toBeNull()
    expect(custom.querySelector(`[data-testid="stock-prep-members-custom-role-table-${CUSTOM}-PRJ-SYN-C"]`)).toBeNull()
    expect(custom.querySelector('[data-testid="stock-prep-members-custom-role-add-tables"]')).not.toBeNull()
    expect(root.textContent).toContain('第一步不支持从角色上移除项目表')
    expect(root.querySelector('[data-testid="stock-prep-members-audit"]')).not.toBeNull()
    // Never shown: credentials, platform switches, platform codes.
    for (const forbidden of ['multitable:', 'integration:', 'workflow:', 'roles:', 'password', '_ENABLED']) {
      expect(root.textContent, forbidden).not.toContain(forbidden)
    }
  })

  it('SMW-PAGE: the editor offers only the codes this grantor may hand out, and a create sends exactly them', async () => {
    const view = clampStockPrepMembersView(membersPayload({ grantableCodes: ['stock-prep:read'] }))!
    answer(() => ok(membersPayload({ grantableCodes: ['stock-prep:read'] })), (url) => (url === `${MEMBERS_URL}/custom-roles` ? ok({ roleId: 'stock-prep_c_ffffffff' }, 201) : null))
    const root = await mountPage({ kind: 'ready', view })
    expect(root.querySelector('[data-testid="stock-prep-members-custom-role-new-code-stock-prep:read"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-members-custom-role-new-code-stock-prep:operate"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-members-custom-role-new-code-stock-prep:admin"]')).toBeNull()
    const name = root.querySelector('[data-testid="stock-prep-members-custom-role-new-name"]') as HTMLInputElement
    name.value = '采购只读'
    name.dispatchEvent(new Event('input'))
    ;(root.querySelector('[data-testid="stock-prep-members-custom-role-new-code-stock-prep:read"]') as HTMLInputElement).click()
    await flush()
    ;(root.querySelector('[data-testid="stock-prep-members-custom-role-create"]') as HTMLButtonElement).click()
    await flush()
    const create = h.apiFetch.mock.calls.find(([url]) => url === `${MEMBERS_URL}/custom-roles`)
    expect(create).toBeTruthy()
    expect(JSON.parse(String((create![1] as RequestInit).body))).toEqual({ name: '采购只读', permissionCodes: ['stock-prep:read'] })
    // After a write the page re-reads the server.
    expect(h.apiFetch.mock.calls.filter(([url]) => url === MEMBERS_URL).length).toBeGreaterThanOrEqual(1)
  })

  it('SMW-PAGE: the add-tables control only exists when project sheets can be listed', async () => {
    answer(() => ok(membersPayload()), (url) => (url.includes('/project-targets') ? refused(404, 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED') : null))
    const root = await mountPage({ kind: 'ready', view: clampStockPrepMembersView(membersPayload())! })
    expect(root.querySelector('[data-testid="stock-prep-members-custom-role-add-tables"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-members-custom-role-save"]')).not.toBeNull()
  })

  it('SMW-PAGE: scope-required renders the notice and no control at all', async () => {
    const root = await mountPage({ kind: 'scope-required' })
    expect(root.querySelector('[data-testid="stock-prep-members-scope-required"]')).not.toBeNull()
    for (const capability of STOCK_PREP_WORKBENCH_CAPABILITIES.filter((entry) => entry.capability.startsWith('members.'))) {
      expect(root.querySelector(`[data-testid="${capability.control}"]`), capability.control!).toBeNull()
    }
  })

  // ── SMW-ALIGN ─────────────────────────────────────────────────────────────────────────────────

  it('SMW-ALIGN: the members rows are byte-equal to the plugin manifest, and every rendered members control is one the SERVER grants', async () => {
    const pick = (rows: readonly Record<string, unknown>[]) => rows.filter((row) => String(row.capability).startsWith('members.'))
    expect(JSON.stringify(pick(STOCK_PREP_WORKBENCH_CAPABILITIES as unknown as Record<string, unknown>[])))
      .toBe(JSON.stringify(pick(backendAccess.STOCK_PREP_WORKBENCH_CAPABILITIES)))
    const membersControls = STOCK_PREP_WORKBENCH_CAPABILITIES.filter((entry) => entry.capability.startsWith('members.')).map((entry) => entry.control as string)
    for (const actor of [{ roles: [] as string[], permissions: ['stock-prep:admin'] }, { roles: ['admin'], permissions: ['integration:admin'] }]) {
      h.roles = actor.roles
      h.permissions = actor.permissions
      answer(() => ok(membersPayload()))
      const root = await mountPage({ kind: 'ready', view: clampStockPrepMembersView(membersPayload())! })
      const rendered = membersControls.filter((control) => root.querySelector(`[data-testid="${control}"]`) !== null).sort()
      const serverGranted = (backendAccess.grantedStockPrepCapabilities([...actor.permissions, ...actor.roles.map((r) => `role:${r}`)]) as string[])
      const grantedControls = STOCK_PREP_WORKBENCH_CAPABILITIES.filter((entry) => serverGranted.includes(entry.capability)).map((entry) => entry.control)
      for (const control of rendered) expect(grantedControls, `${control} must be server-granted`).toContain(control)
      // With a custom role and listable sheets the page renders all four: nothing granted is hidden.
      expect(rendered).toEqual([...membersControls].sort())
      expect(visibleStockPrepControls(actor)).toEqual(expect.arrayContaining(membersControls))
      app!.unmount()
      app = null
      container!.innerHTML = ''
    }
    // Below the tier nobody is granted any members capability, on either side.
    for (const permissions of [['stock-prep:read'], ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull'], ['stock-prep:*'], ['*:*']]) {
      expect((backendAccess.grantedStockPrepCapabilities(permissions) as string[]).filter((id) => id.startsWith('members.')), permissions.join('+')).toEqual([])
      expect(visibleStockPrepControls({ roles: [], permissions }).filter((control) => membersControls.includes(control))).toEqual([])
    }
  })
})
