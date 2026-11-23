import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import UserManagementView from '../src/views/UserManagementView.vue'

const apiFetchMock = vi.fn()
const authState = vi.hoisted(() => ({ adminId: 'admin-actor' }))
const PENDING_KEY = 'metasheet.adminAuthorizationOperation.pending.v1'

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    hasAdminAccess: () => true,
    getCurrentUser: () => (authState.adminId ? { id: authState.adminId } : null),
    getCurrentUserId: async () => authState.adminId || null,
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

type Call = { url: string; method: string; body: Record<string, unknown> | null }
type AdmissionRow = { namespace: string; enabled: boolean; effective: boolean; hasRole: boolean; updatedAt: string | null }

const users = [
  { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true, is_admin: false },
  { id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true, is_admin: false },
]

let calls: Call[] = []
let rolesByUser: Record<string, string[]> = {}
let admissionsByUser: Record<string, AdmissionRow[]> = {}
let commitMode: 'ok' | 'conflict' | 'last-admin' | 'throw' | 'malformed' | 'hold' = 'ok'
let previewMode: 'ok' | 'missing' | 'unavailable' | 'last-admin' = 'ok'
let lookupMode: 'committed' | 'unknown' | 'direct' = 'unknown'
let releaseCommit: (() => void) | null = null
let statusGate: Promise<void> | null = null
let statusMode: 'ok' | 'fail' = 'ok'
let statusUserName = ''
let statusBodyRead = false
let statusContinuationSettled = false
let committedTargetByOperation: Record<string, string> | null = null
let holdAccessCall: { userId: string; index: number } | null = null
let releaseHeldAccess: (() => void) | null = null
let heldAccessEntered = false
let heldAccessSettled = false
let accessReadCounts: Record<string, number> = {}
let applyRoleOnCommit = true
let retainedGrants: unknown[] = []
let richImpact = false

function jsonResponse(payload: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

function strictAdmissionChanges(admissionChanges: unknown[]): unknown[] {
  return admissionChanges.flatMap((change) => {
    if (!change || typeof change !== 'object') return []
    const row = change as Record<string, unknown>
    if (typeof row.namespace !== 'string' || row.namespace.trim().length === 0) return []
    if (typeof row.after === 'boolean' && (row.cause === 'explicit' || row.cause === 'role_revoke')) {
      return [{
        namespace: row.namespace,
        before: row.before === null || typeof row.before === 'boolean' ? row.before : null,
        after: row.after,
        cause: row.cause,
      }]
    }
    if (typeof row.enabled !== 'boolean') return []
    return [{ namespace: row.namespace, before: null, after: row.enabled, cause: 'explicit' }]
  })
}

function strictRetainedGrants(grants: unknown[]): unknown[] {
  return grants.flatMap((grant) => {
    if (typeof grant === 'string' && grant.trim()) {
      return [{ code: grant.trim(), sources: [], effective: true }]
    }
    if (!grant || typeof grant !== 'object') return []
    return [grant]
  })
}

function emptyImpact(admissionChanges: unknown[] = []) {
  if (richImpact) {
    return {
      sourceChanges: [{ source: 'role', id: 'crm_admin', operation: 'assign', changed: true }],
      admissionChanges: [
        { namespace: 'crm', before: null, after: true, cause: 'explicit' },
        { namespace: 'attendance', before: true, after: false, cause: 'role_revoke' },
      ],
      scopeCleanup: [{ namespace: 'legacy', kind: 'department', id: 'scope-1' }],
      effectiveBefore: [],
      effectiveAfter: [{ code: 'crm:read', sources: [{ kind: 'role', id: 'finance_admin' }], effective: true }],
      retainedOtherGrants: strictRetainedGrants(retainedGrants),
      warnings: [],
    }
  }
  return {
    sourceChanges: [],
    admissionChanges: strictAdmissionChanges(admissionChanges),
    scopeCleanup: [],
    effectiveBefore: [],
    effectiveAfter: [],
    retainedOtherGrants: strictRetainedGrants(retainedGrants),
    warnings: [],
  }
}

function installApi(): void {
  apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method || 'GET').toUpperCase()
    const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) as Record<string, unknown> : null
    calls.push({ url, method, body })
    const pathname = new URL(url, 'http://localhost').pathname
    if (pathname === '/api/admin/roles') {
      return jsonResponse({
        ok: true,
        data: {
          items: [
            { id: 'crm_admin', name: 'CRM 管理员', memberCount: 1, permissions: ['crm:read'], updatedAt: '2026-11-01T00:00:00.000Z', admissionNamespaces: ['crm', 'attendance'] },
            { id: 'finance_admin', name: '财务管理员', memberCount: 1, permissions: ['finance:read'], updatedAt: '2026-11-01T00:00:00.000Z', admissionNamespaces: [] },
            { id: 'admin', name: '平台管理员', memberCount: 1, permissions: [], updatedAt: '2026-11-01T00:00:00.000Z', admissionNamespaces: [] },
          ],
        },
      })
    }
    if (pathname === '/api/admin/access-presets') {
      return jsonResponse({ ok: true, data: { items: [] }, capabilities: { explicitNamespaceAdmission: true } })
    }
    if (pathname === '/api/admin/users' && method === 'GET') {
      return jsonResponse({ ok: true, data: { items: users, total: users.length } })
    }
    if (pathname === '/api/admin/authorization-operations/preview' && method === 'POST') {
      if (previewMode === 'missing') return jsonResponse({ ok: false, error: { message: 'missing' } }, 404)
      if (previewMode === 'unavailable') return jsonResponse({ ok: false, error: { message: 'unavailable' } }, 503)
      if (previewMode === 'last-admin') return jsonResponse({ ok: false, error: { code: 'LAST_PLATFORM_ADMIN' } }, 409)
      return jsonResponse({ expectedVersion: 'member-version-1', impact: emptyImpact(Array.isArray(body?.admissionChanges) ? body.admissionChanges : []) })
    }
    if (pathname === '/api/admin/authorization-operations' && method === 'POST') {
      if (commitMode === 'hold') {
        await new Promise<void>((resolve) => {
          releaseCommit = resolve
        })
      }
      if (commitMode === 'throw') throw new Error('socket closed')
      if (commitMode === 'malformed') return jsonResponse({ status: 'committed' }, 200)
      if (commitMode === 'conflict') return jsonResponse({ ok: false, error: { code: 'ROLE_MODIFIED' } }, 409)
      if (commitMode === 'last-admin') return jsonResponse({ ok: false, error: { code: 'LAST_PLATFORM_ADMIN' } }, 409)
      const action = body?.action as { kind?: string; roleId?: string } | undefined
      const targetUserId = typeof body?.targetUserId === 'string' ? body.targetUserId : ''
      if (applyRoleOnCommit && action?.kind === 'role.assign' && action.roleId) {
        const current = rolesByUser[targetUserId] ?? []
        if (!current.includes(action.roleId)) rolesByUser[targetUserId] = [...current, action.roleId]
      }
      if (applyRoleOnCommit && action?.kind === 'role.revoke' && action.roleId) {
        rolesByUser[targetUserId] = (rolesByUser[targetUserId] ?? []).filter((roleId) => roleId !== action.roleId)
      }
      if (action?.kind === 'admission.set' && Array.isArray(body?.admissionChanges)) {
        const rows = admissionsByUser[targetUserId] ?? []
        for (const change of body.admissionChanges) {
          if (!change || typeof change !== 'object') continue
          const namespace = typeof (change as { namespace?: unknown }).namespace === 'string' ? (change as { namespace: string }).namespace : ''
          const enabled = (change as { enabled?: unknown }).enabled === true
          const existing = rows.find((row) => row.namespace === namespace)
          if (existing) existing.enabled = enabled
          else if (namespace) rows.push({ namespace, enabled, effective: enabled, hasRole: true, updatedAt: null })
        }
        admissionsByUser[targetUserId] = rows
      }
      const clientOperationId = typeof body?.clientOperationId === 'string' ? body.clientOperationId : '11111111-1111-4111-8111-111111111111'
      return jsonResponse({
        status: 'committed',
        clientOperationId,
        receipt: {
          targetUserId,
          action,
          impact: emptyImpact(Array.isArray(body?.admissionChanges) ? body.admissionChanges : []),
          resultVersion: 'member-version-2',
        },
      })
    }
    const operationMatch = pathname.match(/^\/api\/admin\/authorization-operations\/([^/]+)$/)
    if (operationMatch && method === 'GET') {
      const clientOperationId = decodeURIComponent(operationMatch[1] ?? '')
      if (lookupMode === 'unknown') return jsonResponse({ status: 'unknown_or_pending', clientOperationId })
      if (lookupMode === 'direct') {
        return jsonResponse({
          status: 'committed',
          clientOperationId,
          receipt: {
            targetUserId: 'user-1',
            action: { kind: 'direct.grant', code: 'sheet:write' },
            impact: emptyImpact([]),
            resultVersion: 'member-version-2',
          },
        })
      }
      const committedTarget = committedTargetByOperation?.[clientOperationId] ?? 'user-1'
      return jsonResponse({
        status: 'committed',
        clientOperationId,
        receipt: {
          targetUserId: committedTarget,
          action: { kind: 'role.assign', roleId: 'finance_admin' },
          impact: emptyImpact([]),
          resultVersion: 'member-version-2',
        },
      })
    }
    const statusMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/status$/)
    if (statusMatch && method === 'PATCH') {
      const userId = decodeURIComponent(statusMatch[1] ?? '')
      const gate = statusGate
      if (gate) await gate
      const listed = users.find((item) => item.id === userId)
      const payload = statusMode === 'fail'
        ? { ok: false, error: { message: 'status failed' } }
        : {
            ok: true,
            data: {
              user: {
                ...(listed ?? { id: userId, email: '', role: 'user', is_admin: false }),
                id: userId,
                name: statusUserName || listed?.name || userId,
                is_active: body?.isActive === true,
              },
              roles: [...(rolesByUser[userId] ?? [])],
              permissions: [],
              isAdmin: false,
            },
          }
      return {
        ok: statusMode !== 'fail',
        status: statusMode === 'fail' ? 500 : 200,
        json: async () => {
          statusBodyRead = true
          setTimeout(() => {
            statusContinuationSettled = true
          }, 0)
          return payload
        },
      }
    }
    const accessMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/access$/)
    if (accessMatch) {
      const userId = decodeURIComponent(accessMatch[1] ?? '')
      const user = users.find((item) => item.id === userId) ?? { id: userId, name: userId, role: 'user', is_active: true, is_admin: false }
      const accessIndex = accessReadCounts[userId] ?? 0
      accessReadCounts[userId] = accessIndex + 1
      const payload = { ok: true, data: { user, roles: rolesByUser[userId] ?? [], permissions: [], isAdmin: false } }
      if (holdAccessCall && holdAccessCall.userId === userId && holdAccessCall.index === accessIndex) {
        heldAccessEntered = true
        await new Promise<void>((resolve) => {
          releaseHeldAccess = resolve
        })
        return {
          ok: true,
          status: 200,
          json: async () => {
            setTimeout(() => {
              heldAccessSettled = true
            }, 0)
            return payload
          },
        }
      }
      return jsonResponse(payload)
    }
    if (pathname.endsWith('/dingtalk-access')) {
      return jsonResponse({
        ok: true,
        data: {
          provider: 'dingtalk',
          requireGrant: false,
          server: { configured: false, available: false, corpId: null, allowedCorpIds: [], requireGrant: false, autoLinkEmail: false, autoProvision: false, unavailableReason: null },
          grant: { exists: false, enabled: false, grantedBy: null, createdAt: null, updatedAt: null },
          identity: { exists: false, corpId: null, unionId: null, openId: null, hasUnionId: false, hasOpenId: false, lastLoginAt: null, createdAt: null, updatedAt: null },
        },
      })
    }
    const admissionMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/member-admission$/)
    if (admissionMatch) {
      const userId = decodeURIComponent(admissionMatch[1] ?? '')
      return jsonResponse({
        ok: true,
        data: {
          userId,
          accountEnabled: true,
          platformAdminEnabled: false,
          attendanceAdminEnabled: false,
          businessRoleIds: rolesByUser[userId] ?? [],
          directoryMemberships: [],
          dingtalk: {
            provider: 'dingtalk',
            requireGrant: false,
            server: { configured: false, available: false, corpId: null, allowedCorpIds: [], requireGrant: false, autoLinkEmail: false, autoProvision: false, unavailableReason: null },
            grant: { exists: false, enabled: false, grantedBy: null, createdAt: null, updatedAt: null },
            identity: { exists: false, corpId: null, unionId: null, openId: null, hasUnionId: false, hasOpenId: false, lastLoginAt: null, createdAt: null, updatedAt: null },
          },
          namespaceAdmissions: admissionsByUser[userId] ?? [],
          organizations: null,
        },
      })
    }
    if (method === 'GET') return jsonResponse({ ok: true, data: { items: [] } })
    return jsonResponse({ ok: false, error: { message: 'unexpected' } }, 500)
  })
}

async function flushUi(cycles = 8): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function settleRendered(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

async function waitFor(predicate: () => boolean, attempts = 40): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    await flushUi(2)
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Condition not reached in time')
}

function posts(url: string): Call[] {
  return calls.filter((call) => call.method === 'POST' && new URL(call.url, 'http://localhost').pathname === url)
}

function commits(): Call[] {
  return posts('/api/admin/authorization-operations')
}

function previews(): Call[] {
  return posts('/api/admin/authorization-operations/preview')
}

function oldWrites(): Call[] {
  return calls.filter((call) => {
    const pathname = new URL(call.url, 'http://localhost').pathname
    return pathname.includes('/roles/assign')
      || pathname.includes('/roles/unassign')
      || /\/namespaces\/[^/]+\/admission$/.test(pathname)
  })
}

async function mountView(): Promise<{ app: App<Element>; root: HTMLDivElement }> {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(UserManagementView)
  app.component('RouterLink', { props: { to: { type: [String, Object], default: '' } }, template: '<a :href="typeof to === \'string\' ? to : \'\'"><slot /></a>' })
  app.mount(root)
  await flushUi(20)
  return { app, root }
}

async function openUser(root: HTMLElement, name: string): Promise<void> {
  const row = Array.from(root.querySelectorAll('.user-admin__user')).find((candidate) => candidate.textContent?.includes(name))
  const button = row?.querySelector('button.user-admin__user-body')
  if (!(button instanceof HTMLButtonElement)) throw new Error(`user missing: ${name}`)
  button.click()
  await waitFor(() => root.querySelector('[data-testid="selected-user-heading"]')?.textContent?.includes(name) === true)
}

async function chooseRole(root: HTMLElement, roleId: string): Promise<void> {
  const select = root.querySelector('[data-testid="user-role-select"]')
  if (!(select instanceof HTMLSelectElement)) throw new Error('role select missing')
  select.value = roleId
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await flushUi()
}

async function confirmWhenReady(root: HTMLElement, phrase?: string): Promise<HTMLButtonElement> {
  await waitFor(() => Boolean(root.querySelector('[data-testid="admin-authorization-confirm"]')))
  if (phrase) {
    const input = root.querySelector('[data-testid="admin-authorization-phrase"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('phrase missing')
    input.value = phrase
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
  }
  await waitFor(() => {
    const button = root.querySelector('[data-testid="admin-authorization-confirm"]')
    return button instanceof HTMLButtonElement && !button.disabled
  })
  return root.querySelector('[data-testid="admin-authorization-confirm"]') as HTMLButtonElement
}

describe('member page atomic authorization', () => {
  let app: App<Element> | null = null
  let root: HTMLDivElement | null = null

  beforeEach(() => {
    calls = []
    rolesByUser = { 'user-1': ['crm_admin'], 'user-2': [] }
    admissionsByUser = {
      'user-1': [{ namespace: 'crm', enabled: true, effective: true, hasRole: true, updatedAt: null }],
      'user-2': [{ namespace: 'crm', enabled: true, effective: false, hasRole: false, updatedAt: null }],
    }
    commitMode = 'ok'
    previewMode = 'ok'
    lookupMode = 'unknown'
    releaseCommit = null
    statusGate = null
    statusMode = 'ok'
    statusUserName = ''
    statusBodyRead = false
    statusContinuationSettled = false
    committedTargetByOperation = null
    holdAccessCall = null
    releaseHeldAccess = null
    heldAccessEntered = false
    heldAccessSettled = false
    accessReadCounts = {}
    applyRoleOnCommit = true
    retainedGrants = []
    richImpact = false
    authState.adminId = 'admin-actor'
    sessionStorage.removeItem(PENDING_KEY)
    installApi()
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
    sessionStorage.removeItem(PENDING_KEY)
    authState.adminId = 'admin-actor'
  })

  it('leaves role admissions unchecked and sends one combined commit for an explicit check', async () => {
    ;({ app, root } = await mountView())
    await openUser(root!, 'Alpha')
    await chooseRole(root!, 'crm_admin')
    ;(root!.querySelector('[data-testid="assign-role-button"]') as HTMLButtonElement).click()
    await waitFor(() => previews().length >= 1)
    const boxes = Array.from(root!.querySelectorAll<HTMLInputElement>('[data-testid="role-assign-admission"]'))
    expect(boxes.map((box) => box.checked)).toEqual([false, false])
    expect(previews().at(-1)?.body?.admissionChanges).toEqual([])
    const crm = boxes.find((box) => box.parentElement?.textContent?.includes('crm'))
    if (!crm) throw new Error('crm checkbox missing')
    crm.checked = true
    crm.dispatchEvent(new Event('change', { bubbles: true }))
    await waitFor(() => previews().some((call) => JSON.stringify(call.body?.admissionChanges) === JSON.stringify([{ namespace: 'crm', enabled: true }])))
    const confirm = await confirmWhenReady(root!)
    confirm.click()
    await waitFor(() => commits().length === 1)
    expect(commits()[0]?.body?.action).toEqual({ kind: 'role.assign', roleId: 'crm_admin' })
    expect(commits()[0]?.body?.admissionChanges).toEqual([{ namespace: 'crm', enabled: true }])
    expect(oldWrites()).toEqual([])
    expect(root!.querySelector('[data-testid="admin-authorization-dialog"]')).toBeTruthy()
  })

  it('previews an independent admission close before any commit', async () => {
    ;({ app, root } = await mountView())
    await openUser(root!, 'Alpha')
    const close = Array.from(root!.querySelectorAll('button')).find((button) => button.textContent?.trim() === '关闭插件使用')
    if (!(close instanceof HTMLButtonElement)) throw new Error('close admission missing')
    close.click()
    await waitFor(() => previews().some((call) => (call.body?.action as { kind?: string } | undefined)?.kind === 'admission.set'))
    const preview = previews().find((call) => (call.body?.action as { kind?: string } | undefined)?.kind === 'admission.set')
    expect(preview?.body?.admissionChanges).toEqual([{ namespace: 'crm', enabled: false }])
    expect(commits()).toEqual([])
    expect(oldWrites()).toEqual([])
    expect(root!.textContent).toContain('只关闭「crm」的插件使用。')
  })

  it('keeps a rejected 409 behind Close until a fresh preview can submit', async () => {
    commitMode = 'conflict'
    ;({ app, root } = await mountView())
    await openUser(root!, 'Alpha')
    await chooseRole(root!, 'finance_admin')
    ;(root!.querySelector('[data-testid="assign-role-button"]') as HTMLButtonElement).click()
    const confirm = await confirmWhenReady(root!)
    const previewsBefore = previews().length
    confirm.click()
    confirm.click()
    await waitFor(() => root!.textContent?.includes('角色目录已变化，本次未写入。请刷新角色后再确认。') === true)
    expect(commits()).toHaveLength(1)
    expect(previews()).toHaveLength(previewsBefore)
    expect(oldWrites()).toEqual([])
    const confirmAfter = root!.querySelector('[data-testid="admin-authorization-confirm"]') as HTMLButtonElement
    const close = root!.querySelector('[data-testid="admin-authorization-close"]') as HTMLButtonElement
    expect(confirmAfter.disabled).toBe(true)
    expect(close.disabled).toBe(false)
    confirmAfter.click()
    await flushUi()
    expect(commits()).toHaveLength(1)
    expect(previews()).toHaveLength(previewsBefore)
    expect((root!.querySelector('[data-testid="assign-role-button"]') as HTMLButtonElement).disabled).toBe(true)
    close.click()
    await flushUi()
    expect(root!.querySelector('[data-testid="admin-authorization-dialog"]')).toBeNull()

    commitMode = 'ok'
    ;(root!.querySelector('[data-testid="assign-role-button"]') as HTMLButtonElement).click()
    const again = await confirmWhenReady(root!)
    again.click()
    await waitFor(() => root!.textContent?.includes('角色已分配，准入未开') === true)
    expect(commits()).toHaveLength(2)
    expect(commits()[0]?.body?.clientOperationId).not.toBe(commits()[1]?.body?.clientOperationId)
    expect(previews().length).toBeGreaterThan(previewsBefore)
    const settledConfirm = root!.querySelector('[data-testid="admin-authorization-confirm"]') as HTMLButtonElement
    expect(settledConfirm.disabled).toBe(true)
    expect(root!.querySelector('[data-testid="admin-authorization-dialog"]')).toBeTruthy()
    expect(oldWrites()).toEqual([])
  })

  it('keeps a lost commit pending and recovers with GET only', async () => {
    commitMode = 'malformed'
    ;({ app, root } = await mountView())
    await openUser(root!, 'Alpha')
    await chooseRole(root!, 'finance_admin')
    ;(root!.querySelector('[data-testid="assign-role-button"]') as HTMLButtonElement).click()
    const confirm = await confirmWhenReady(root!)
    confirm.click()
    await waitFor(() => root!.textContent?.includes('还不能确认这次授权是否已经提交') === true)
    expect(commits()).toHaveLength(1)
    expect(root!.querySelector('[data-testid="admin-authorization-dialog"]')).toBeTruthy()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushUi()
    expect(root!.querySelector('[data-testid="admin-authorization-dialog"]')).toBeTruthy()
    expect(root!.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Alpha')
    const readAgain = root!.querySelector('[data-testid="admin-authorization-read-again"]') as HTMLButtonElement
    readAgain.click()
    await waitFor(() => calls.some((call) => call.method === 'GET' && call.url.includes('/api/admin/authorization-operations/')))
    expect(commits()).toHaveLength(1)
    expect(oldWrites()).toEqual([])

    app?.unmount()
    root?.remove()
    calls = []
    commitMode = 'ok'
    ;({ app, root } = await mountView())
    await openUser(root!, 'Alpha')
    await waitFor(() => calls.some((call) => call.method === 'GET' && /\/api\/admin\/authorization-operations\/[0-9a-f-]+$/i.test(new URL(call.url, 'http://localhost').pathname)))
    expect(commits()).toEqual([])
    expect(root!.textContent).toContain('还不能确认这次授权是否已经提交')
    expect(root!.querySelector('[data-testid="admin-authorization-dialog"]')).toBeTruthy()
  })

  it('does not call a receipt verified when the fresh read misses the role', async () => {
    applyRoleOnCommit = false
    ;({ app, root } = await mountView())
    await openUser(root!, 'Alpha')
    await chooseRole(root!, 'finance_admin')
    ;(root!.querySelector('[data-testid="assign-role-button"]') as HTMLButtonElement).click()
    const confirm = await confirmWhenReady(root!)
    confirm.click()
    await waitFor(() => root!.textContent?.includes('还没有核对成功') === true)
    expect(root!.textContent).not.toContain('权限已全部生效')
    expect(root!.textContent).not.toContain('角色已分配，准入未开')
    expect(commits()).toHaveLength(1)
  })

  it('does not mix a late commit into the next member or the next principal', async () => {
    commitMode = 'hold'
    ;({ app, root } = await mountView())
    await openUser(root!, 'Alpha')
    await chooseRole(root!, 'finance_admin')
    ;(root!.querySelector('[data-testid="assign-role-button"]') as HTMLButtonElement).click()
    const confirm = await confirmWhenReady(root!)
    confirm.click()
    await waitFor(() => releaseCommit !== null)
    await openUser(root!, 'Bravo')
    expect(root!.textContent).toContain('确认对象已变化，这次结果不会写入当前成员。')
    releaseCommit?.()
    releaseCommit = null
    await flushUi(12)
    expect(commits()).toHaveLength(1)
    expect(root!.textContent).not.toContain('角色已分配，准入未开')
    expect(root!.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Bravo')
    expect(root!.querySelector('[data-testid="admin-authorization-dialog"]')).toBeTruthy()

    ;(root!.querySelector('[data-testid="admin-authorization-close"]') as HTMLButtonElement).click()
    await flushUi()
    sessionStorage.removeItem(PENDING_KEY)
    commitMode = 'hold'
    await openUser(root!, 'Alpha')
    await chooseRole(root!, 'finance_admin')
    ;(root!.querySelector('[data-testid="assign-role-button"]') as HTMLButtonElement).click()
    const again = await confirmWhenReady(root!)
    again.click()
    await waitFor(() => releaseCommit !== null)
    authState.adminId = 'other-admin'
    window.dispatchEvent(new Event('focus'))
    await flushUi()
    expect(root!.textContent).toContain('登录身份已变化，这次结果不会写入当前成员。')
    releaseCommit?.()
    await flushUi(12)
    expect(commits()).toHaveLength(2)
    expect(root!.querySelector('[data-testid="admin-authorization-dialog"]')).toBeTruthy()
  })

  it('keeps the confirmation panel and focus through a fast double-click', async () => {
    ;({ app, root } = await mountView())
    await openUser(root!, 'Alpha')
    await chooseRole(root!, 'finance_admin')
    ;(root!.querySelector('[data-testid="assign-role-button"]') as HTMLButtonElement).click()
    const confirm = await confirmWhenReady(root!)
    confirm.click()
    confirm.click()
    await waitFor(() => root!.textContent?.includes('角色已分配，准入未开') === true)
    expect(commits()).toHaveLength(1)
    expect(root!.querySelector('[data-testid="admin-authorization-dialog"]')).toBeTruthy()
    const confirmAfter = root!.querySelector('[data-testid="admin-authorization-confirm"]') as HTMLButtonElement
    expect(confirmAfter.disabled).toBe(true)
    const close = root!.querySelector('[data-testid="admin-authorization-close"]') as HTMLButtonElement
    expect(document.activeElement).toBe(close)
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(root!.querySelector('[data-testid="admin-authorization-dialog"]')?.contains(document.activeElement)).toBe(true)
    expect(oldWrites()).toEqual([])
  })

  it('says a role-only assign left admission closed and names retained sources after revoke', async () => {
    rolesByUser['user-1'] = []
    ;({ app, root } = await mountView())
    await openUser(root!, 'Alpha')
    await chooseRole(root!, 'finance_admin')
    ;(root!.querySelector('[data-testid="assign-role-button"]') as HTMLButtonElement).click()
    ;(await confirmWhenReady(root!)).click()
    await waitFor(() => root!.textContent?.includes('角色已分配，准入未开') === true)
    expect(root!.textContent).not.toContain('权限已全部生效')
    ;(root!.querySelector('[data-testid="admin-authorization-close"]') as HTMLButtonElement).click()
    await flushUi()

    retainedGrants = ['admin']
    rolesByUser['user-1'] = ['finance_admin']
    await chooseRole(root!, 'finance_admin')
    ;(root!.querySelector('[data-testid="unassign-role-button"]') as HTMLButtonElement).click()
    ;(await confirmWhenReady(root!)).click()
    await waitFor(() => root!.textContent?.includes('提交时回执记录其他来源：admin') === true)
    expect(root!.textContent).toContain('当前的角色和准入读取不能确认这些来源是否仍在')
    expect(root!.textContent).not.toContain('当前仍保留')
    expect(root!.textContent).not.toContain('其他来源仍保留')
    expect(root!.textContent).not.toContain('访问已撤销')
    expect(rolesByUser['user-1']).not.toContain('admin')
    expect(oldWrites()).toEqual([])
  })

  it('does not verify or clear a restored direct grant for the same member', async () => {
    const operationId = '22222222-2222-4222-8222-222222222222'
    lookupMode = 'direct'
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({
      formatVersion: 1,
      entries: [{ principalId: 'admin-actor', targetId: 'user-1', clientOperationId: operationId }],
    }))
    ;({ app, root } = await mountView())
    await openUser(root!, 'Alpha')
    await waitFor(() => Boolean(root!.querySelector('[data-testid="authorization-foreign-receipt"]')))
    const link = root!.querySelector('[data-testid="authorization-foreign-receipt-link"]')
    expect(link?.textContent).toContain('权限来源与例外')
    expect(link?.getAttribute('href')).toBe('/admin/permissions?userId=user-1')
    expect(root!.textContent).not.toContain('当前仍保留')
    expect(root!.textContent).not.toContain('权限已全部生效')
    expect(root!.textContent).not.toContain('角色已分配，准入未开')
    expect(sessionStorage.getItem(PENDING_KEY)).toContain(operationId)
    expect(commits()).toEqual([])
    expect(oldWrites()).toEqual([])
  })

  it('shows the server impact and refuses a failed preview', async () => {
    richImpact = true
    ;({ app, root } = await mountView())
    await openUser(root!, 'Alpha')
    await chooseRole(root!, 'crm_admin')
    ;(root!.querySelector('[data-testid="assign-role-button"]') as HTMLButtonElement).click()
    await waitFor(() => Boolean(root!.querySelector('[data-testid="admin-authorization-server-impact"]')))
    expect(root!.querySelector('[data-testid="admin-authorization-role-sources"]')?.textContent).toContain('finance_admin')
    expect(root!.querySelector('[data-testid="admin-authorization-explicit-admissions"]')?.textContent).toContain('开通 crm')
    expect(root!.querySelector('[data-testid="admin-authorization-derived-admissions"]')?.textContent).toContain('关闭 attendance')
    expect(root!.querySelector('[data-testid="admin-authorization-scope-cleanup"]')?.textContent).toContain('1')
    ;(root!.querySelector('[data-testid="admin-authorization-cancel"]') as HTMLButtonElement).click()
    await flushUi()

    previewMode = 'unavailable'
    ;(root!.querySelector('[data-testid="assign-role-button"]') as HTMLButtonElement).click()
    await waitFor(() => root!.textContent?.includes('服务器预览没有成功，本次没有提交。') === true)
    expect(commits()).toEqual([])
    const confirm = root!.querySelector('[data-testid="admin-authorization-confirm"]') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    previewMode = 'missing'
    ;(root!.querySelector('[data-testid="admin-authorization-cancel"]') as HTMLButtonElement).click()
    await flushUi()
    ;(root!.querySelector('[data-testid="assign-role-button"]') as HTMLButtonElement).click()
    await waitFor(() => root!.textContent?.includes('本次没有提交。') === true)
    expect(commits()).toEqual([])
    expect(oldWrites()).toEqual([])
  })

  it('labels batch role replacement as its own flow', async () => {
    ;({ app, root } = await mountView())
    const checkbox = root!.querySelector('.user-admin__user input[type="checkbox"]')
    if (!(checkbox instanceof HTMLInputElement)) throw new Error('row checkbox missing')
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    const bulkRole = root!.querySelector('select[aria-label="批量角色"]')
    if (!(bulkRole instanceof HTMLSelectElement)) throw new Error('bulk role missing')
    bulkRole.value = 'finance_admin'
    bulkRole.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    const apply = Array.from(root!.querySelectorAll('button')).find((button) => button.textContent?.trim() === '应用角色')
    apply?.click()
    await waitFor(() => Boolean(root!.querySelector('[data-testid="bulk-independent-flow"]')))
    expect(root!.querySelector('[data-testid="bulk-independent-flow"]')?.textContent).toContain('这是独立的批量流程，不会生成成员页单次授权的回执。')
    expect(commits()).toEqual([])
  })

  function pageStatusText(root: HTMLElement): string {
    const nodes = Array.from(root.querySelectorAll('section.user-admin > p.user-admin__status'))
    const status = nodes.find((node) => node.getAttribute('data-testid') !== 'authorization-foreign-receipt')
    return status?.textContent?.trim() || ''
  }

  it('drops a preview refusal when the selected member changes and does not restore it', async () => {
    previewMode = 'last-admin'
    ;({ app, root } = await mountView())
    await openUser(root!, 'Alpha')
    await chooseRole(root!, 'finance_admin')
    ;(root!.querySelector('[data-testid="assign-role-button"]') as HTMLButtonElement).click()
    await waitFor(() => pageStatusText(root!).includes('不能取消最后一名平台管理员'))
    expect(root!.querySelector('[data-testid="role-action-feedback"]')).toBeNull()

    await openUser(root!, 'Bravo')
    expect(pageStatusText(root!)).not.toContain('不能取消最后一名平台管理员')
    expect(root!.querySelector('[data-testid="role-action-feedback"]')?.textContent || '').not.toContain('不能取消最后一名平台管理员')
    expect(root!.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Bravo')

    await openUser(root!, 'Alpha')
    expect(pageStatusText(root!)).not.toContain('不能取消最后一名平台管理员')
    expect(root!.querySelector('[data-testid="admin-authorization-dialog"]')).toBeNull()
    expect(commits()).toEqual([])
  })

  it('drops another page receipt when the selected member has none, and reads it again only from storage', async () => {
    const operationId = '22222222-2222-4222-8222-222222222222'
    lookupMode = 'direct'
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({
      formatVersion: 1,
      entries: [{ principalId: 'admin-actor', targetId: 'user-1', clientOperationId: operationId }],
    }))
    ;({ app, root } = await mountView())
    await openUser(root!, 'Alpha')
    await waitFor(() => Boolean(root!.querySelector('[data-testid="authorization-foreign-receipt"]')))
    expect(root!.querySelector('[data-testid="authorization-foreign-receipt-link"]')?.getAttribute('href')).toBe('/admin/permissions?userId=user-1')

    await openUser(root!, 'Bravo')
    expect(root!.querySelector('[data-testid="authorization-foreign-receipt"]')).toBeNull()
    expect(root!.textContent).not.toContain('这次回执不是成员页的角色或准入变更')
    expect(root!.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Bravo')

    await openUser(root!, 'Alpha')
    await waitFor(() => Boolean(root!.querySelector('[data-testid="authorization-foreign-receipt"]')))
    expect(root!.querySelector('[data-testid="authorization-foreign-receipt-link"]')?.getAttribute('href')).toBe('/admin/permissions?userId=user-1')

    await openUser(root!, 'Bravo')
    expect(root!.querySelector('[data-testid="authorization-foreign-receipt"]')).toBeNull()
    sessionStorage.removeItem(PENDING_KEY)
    await openUser(root!, 'Alpha')
    await settleRendered()
    expect(root!.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Alpha')
    expect(root!.querySelector('[data-testid="authorization-foreign-receipt"]')).toBeNull()
    expect(root!.textContent).not.toContain('这次回执不是成员页的角色或准入变更')
    expect(commits()).toEqual([])
  })

  function accountStatusButton(root: HTMLElement): HTMLButtonElement {
    const button = Array.from(root.querySelectorAll('button')).find((item) => {
      const label = item.textContent?.trim()
      return label === '停用账号' || label === '启用账号'
    })
    if (!(button instanceof HTMLButtonElement)) throw new Error('account status button missing')
    return button
  }

  function holdAccountStatus(): () => void {
    let release: () => void = () => {}
    statusBodyRead = false
    statusContinuationSettled = false
    statusGate = new Promise<void>((resolve) => {
      release = () => {
        statusGate = null
        resolve()
      }
    })
    return release
  }

  it('ignores a late account-status success for the previous member', async () => {
    statusUserName = 'Stale Alpha'
    ;({ app, root } = await mountView())
    await openUser(root!, 'Alpha')
    const release = holdAccountStatus()
    accountStatusButton(root!).click()
    await waitFor(() => calls.some((call) => call.method === 'PATCH' && call.url.includes('/users/user-1/status')))

    await openUser(root!, 'Bravo')
    release()
    await waitFor(() => statusContinuationSettled)
    await settleRendered()

    expect(root!.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Bravo')
    expect(root!.querySelector('[data-testid="selected-user-heading"]')?.textContent).not.toContain('Stale')
    expect(pageStatusText(root!)).not.toContain('账号已停用')
    expect(pageStatusText(root!)).not.toContain('账号已启用')
    expect(accountStatusButton(root!).textContent?.trim()).toBe('停用账号')
  })

  it('ignores a late account-status failure for the previous member', async () => {
    statusMode = 'fail'
    ;({ app, root } = await mountView())
    await openUser(root!, 'Alpha')
    const release = holdAccountStatus()
    accountStatusButton(root!).click()
    await waitFor(() => calls.some((call) => call.method === 'PATCH' && call.url.includes('/users/user-1/status')))

    await openUser(root!, 'Bravo')
    release()
    await waitFor(() => statusContinuationSettled)
    await settleRendered()

    expect(root!.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Bravo')
    expect(pageStatusText(root!)).not.toContain('更新用户状态失败')
    expect(pageStatusText(root!)).not.toContain('status failed')
    expect(accountStatusButton(root!).textContent?.trim()).toBe('停用账号')
  })

  it('ignores the first account-status response when that member is selected again', async () => {
    statusUserName = 'Stale Alpha'
    ;({ app, root } = await mountView())
    await openUser(root!, 'Alpha')
    const release = holdAccountStatus()
    accountStatusButton(root!).click()
    await waitFor(() => calls.some((call) => call.method === 'PATCH' && call.url.includes('/users/user-1/status')))

    await openUser(root!, 'Bravo')
    await openUser(root!, 'Alpha')
    expect(root!.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Alpha')
    expect(root!.querySelector('[data-testid="selected-user-heading"]')?.textContent).not.toContain('Stale')

    release()
    await waitFor(() => statusContinuationSettled)
    await settleRendered()

    expect(root!.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Alpha')
    expect(root!.querySelector('[data-testid="selected-user-heading"]')?.textContent).not.toContain('Stale')
    expect(pageStatusText(root!)).not.toContain('账号已停用')
    expect(accountStatusButton(root!).textContent?.trim()).toBe('停用账号')
  })

  it('verifies the next member after the previous verification releases its latch', async () => {
    const alphaOperationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const bravoOperationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    lookupMode = 'committed'
    committedTargetByOperation = {
      [alphaOperationId]: 'user-1',
      [bravoOperationId]: 'user-2',
    }
    rolesByUser['user-2'] = ['finance_admin']
    holdAccessCall = { userId: 'user-1', index: 1 }
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({
      formatVersion: 1,
      entries: [
        { principalId: 'admin-actor', targetId: 'user-1', clientOperationId: alphaOperationId },
        { principalId: 'admin-actor', targetId: 'user-2', clientOperationId: bravoOperationId },
      ],
    }))
    ;({ app, root } = await mountView())
    try {
      await openUser(root!, 'Alpha')
      await waitFor(() => heldAccessEntered && Boolean(root!.querySelector('[data-testid="admin-authorization-dialog"]')))
      const close = root!.querySelector('[data-testid="admin-authorization-close"]')
      if (!(close instanceof HTMLButtonElement) || close.disabled) throw new Error('close missing')
      close.click()
      await waitFor(() => root!.querySelector('[data-testid="admin-authorization-dialog"]') === null)

      await openUser(root!, 'Bravo')
      await waitFor(() => calls.some((call) => call.url.includes(bravoOperationId)))
      await settleRendered()
      expect(root!.querySelector('[data-testid="admin-authorization-dialog"]')).toBeTruthy()
      expect(root!.querySelector('[data-testid="admin-authorization-read-again"]')).toBeTruthy()
      expect(root!.textContent).not.toContain('角色已分配，准入未开')

      releaseHeldAccess?.()
      await waitFor(() => heldAccessSettled && root!.textContent?.includes('角色已分配，准入未开') === true)
      await settleRendered()
      expect(root!.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Bravo')
      expect(root!.textContent).toContain('角色已分配，准入未开')
      expect(root!.querySelector('[data-testid="admin-authorization-read-again"]')).toBeNull()
    } finally {
      releaseHeldAccess?.()
    }
  })
})
