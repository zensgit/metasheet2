import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import UserManagementView from '../src/views/UserManagementView.vue'
import { describeRoleMembershipWrite, roleWriteOutcomeFromPayload, selectedRoleMembershipHint } from '../src/views/adminUserRoleAction'

const apiFetchMock = vi.fn()
const authState = vi.hoisted(() => ({ adminId: 'admin-1' }))
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

async function flushUi(cycles = 8): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function waitForCondition(predicate: () => boolean, attempts = 40): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    await flushUi(2)
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Condition not reached in time')
}

function createJsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

function jsonOk(data: unknown) {
  return createJsonResponse({ ok: true, data })
}

describe('adminUserRoleAction', () => {
  it('describes selected role membership for none, held, and not-held', () => {
    expect(selectedRoleMembershipHint('', ['crm_admin']).state).toBe('none')
    expect(selectedRoleMembershipHint('crm_admin', ['crm_admin'])).toEqual({
      state: 'held',
      text: '当前用户已是角色 crm_admin 的成员',
    })
    expect(selectedRoleMembershipHint('finance_admin', ['crm_admin']).state).toBe('not-held')
  })

  it('treats unassign as failure when persisted membership still holds the role', () => {
    const outcome = describeRoleMembershipWrite({
      action: 'unassign',
      requestedUserId: 'user-1',
      selectedUserId: 'user-1',
      roleId: 'crm_admin',
      persistedRoleIds: ['crm_admin'],
      roleHeld: true,
      membershipChanged: false,
      actorId: 'admin-1',
      ok: true,
    })
    expect(outcome.tone).toBe('error')
    expect(outcome.applySnapshot).toBe(true)
    expect(outcome.message).toContain('仍持有角色 crm_admin')
    expect(outcome.message).toContain('操作者 admin-1')
  })

  it('reports revoke persisted+effective success only when the role is gone', () => {
    const outcome = describeRoleMembershipWrite({
      action: 'unassign',
      requestedUserId: 'user-1',
      selectedUserId: 'user-1',
      roleId: 'crm_admin',
      persistedRoleIds: [],
      roleHeld: false,
      membershipChanged: true,
      actorId: 'admin-1',
      ok: true,
    })
    expect(outcome.tone).toBe('info')
    expect(outcome.message).toContain('已撤销角色 crm_admin')
    expect(outcome.message).toContain('当前未持有该角色')
  })

  it('does not claim a change when unassign was a no-op', () => {
    const outcome = describeRoleMembershipWrite({
      action: 'unassign',
      requestedUserId: 'user-1',
      selectedUserId: 'user-1',
      roleId: 'finance_admin',
      persistedRoleIds: ['crm_admin'],
      roleHeld: false,
      membershipChanged: false,
      ok: true,
    })
    expect(outcome.message).toContain('成员关系未变化')
    expect(outcome.message).not.toContain('已撤销角色')
  })

  it('keeps an in-flight response off a later selected user', () => {
    const outcome = describeRoleMembershipWrite({
      action: 'unassign',
      requestedUserId: 'user-1',
      selectedUserId: 'user-2',
      roleId: 'crm_admin',
      persistedRoleIds: [],
      roleHeld: false,
      membershipChanged: true,
      actorId: 'admin-1',
      ok: true,
    })
    expect(outcome.applySnapshot).toBe(false)
    expect(outcome.message).toContain('用户 user-1')
    expect(outcome.message).toContain('未覆盖当前选中用户 user-2')
  })

  it('treats named-role shortcut unassign as failure when membership still holds admin', () => {
    const outcome = describeRoleMembershipWrite({
      action: 'unassign',
      requestedUserId: 'user-1',
      selectedUserId: 'user-1',
      roleId: 'admin',
      persistedRoleIds: ['admin'],
      roleHeld: true,
      membershipChanged: false,
      actorId: 'admin-1',
      ok: true,
    })
    expect(outcome.tone).toBe('error')
    expect(outcome.applySnapshot).toBe(true)
    expect(outcome.message).toContain('仍持有角色 admin')
    expect(outcome.message).not.toContain('已关闭')
  })

  it('does not treat a missing, partial, or wrong-subject role readback as verified removal', () => {
    const missing = roleWriteOutcomeFromPayload({}, {
      action: 'unassign',
      requestedUserId: 'user-1',
      selectedUserId: 'user-1',
      roleId: 'crm_admin',
    })
    expect(missing.snapshot).toBeNull()
    expect(missing.outcome.applySnapshot).toBe(false)
    expect(missing.outcome.tone).toBe('error')
    expect(missing.outcome.message).not.toContain('当前未持有')
    expect(missing.outcome.message).not.toContain('已撤销角色')

    const partial = roleWriteOutcomeFromPayload({
      user: { id: 'user-1' },
      roles: ['crm_admin', null],
      permissions: [],
      isAdmin: false,
      roleHeld: false,
      membershipChanged: true,
      changedRoleId: 'crm_admin',
    }, {
      action: 'unassign',
      requestedUserId: 'user-1',
      selectedUserId: 'user-1',
      roleId: 'crm_admin',
    })
    expect(partial.snapshot).toBeNull()
    expect(partial.outcome.message).not.toContain('当前未持有')

    const wrongSubject = roleWriteOutcomeFromPayload({
      user: { id: 'user-2' },
      roles: [],
      permissions: [],
      isAdmin: false,
      roleHeld: false,
      membershipChanged: true,
      changedRoleId: 'crm_admin',
    }, {
      action: 'unassign',
      requestedUserId: 'user-1',
      selectedUserId: 'user-1',
      roleId: 'crm_admin',
    })
    expect(wrongSubject.snapshot).toBeNull()
    expect(wrongSubject.outcome.applySnapshot).toBe(false)
    expect(wrongSubject.outcome.message).toContain('不完整或主体不一致')

    const wrongRole = roleWriteOutcomeFromPayload({
      user: { id: 'user-1', name: 'Alpha' },
      roles: [],
      permissions: [],
      isAdmin: false,
      roleHeld: false,
      membershipChanged: true,
      changedRoleId: 'finance_admin',
    }, {
      action: 'unassign',
      requestedUserId: 'user-1',
      selectedUserId: 'user-1',
      roleId: 'crm_admin',
    })
    expect(wrongRole.snapshot).toBeNull()
    expect(wrongRole.outcome.message).not.toContain('已撤销角色')
  })
})

describe('UserManagementView role membership', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    authState.adminId = 'admin-1'
    sessionStorage.removeItem(PENDING_KEY)
  })

  afterEach(() => {
    sessionStorage.removeItem(PENDING_KEY)
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    apiFetchMock.mockReset()
  })

  function mountView(): HTMLDivElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(UserManagementView)
    app.component('RouterLink', {
      props: { to: { type: [String, Object], default: '' } },
      template: '<a><slot /></a>',
    })
    app.mount(container)
    return container
  }

  async function openListedUser(root: HTMLElement, name: string): Promise<void> {
    await waitForCondition(() => {
      const row = Array.from(root.querySelectorAll('.user-admin__user')).find((item) => item.textContent?.includes(name))
      return row?.querySelector('button.user-admin__user-body') instanceof HTMLButtonElement
    })
    const row = Array.from(root.querySelectorAll('.user-admin__user')).find((item) => item.textContent?.includes(name))
    const button = row?.querySelector('button.user-admin__user-body')
    if (!(button instanceof HTMLButtonElement)) throw new Error(`user row missing: ${name}`)
    button.click()
    await waitForCondition(() => (root.querySelector('[data-testid="selected-user-heading"]')?.textContent || '').includes(name))
  }

  async function confirmAuthorization(root: HTMLElement, phrase?: string): Promise<void> {
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="admin-authorization-confirm"]')))
    if (phrase) {
      const input = root.querySelector('[data-testid="admin-authorization-phrase"]')
      if (!(input instanceof HTMLInputElement)) throw new Error('authorization phrase input missing')
      input.value = phrase
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flushUi()
    }
    await waitForCondition(() => {
      const button = root.querySelector('[data-testid="admin-authorization-confirm"]')
      return button instanceof HTMLButtonElement && !button.disabled
    })
    ;(root.querySelector('[data-testid="admin-authorization-confirm"]') as HTMLButtonElement).click()
  }

  function authorizationImpact(roleId: string, operation: 'assign' | 'revoke', changed: boolean) {
    return {
      sourceChanges: roleId
        ? [{ source: 'role' as const, id: roleId, operation, changed }]
        : [],
      admissionChanges: [],
      scopeCleanup: [],
      effectiveBefore: [],
      effectiveAfter: [],
      retainedOtherGrants: [],
      warnings: [],
    }
  }

  function dingtalkAccessBody() {
    return {
      provider: 'dingtalk',
      requireGrant: false,
      server: {
        configured: false,
        available: false,
        corpId: null,
        allowedCorpIds: [],
        requireGrant: false,
        autoLinkEmail: false,
        autoProvision: false,
        unavailableReason: null,
      },
      grant: { exists: false, enabled: false, grantedBy: null, createdAt: null, updatedAt: null },
      identity: {
        exists: false,
        corpId: null,
        unionId: null,
        openId: null,
        hasUnionId: false,
        hasOpenId: false,
        lastLoginAt: null,
        createdAt: null,
        updatedAt: null,
      },
    }
  }

  function createRoleApi(options: {
    leaveMembershipOnUnassign?: boolean
    delayUnassign?: Promise<void>
    initialMembership?: Record<string, string[]>
    holdAccess?: boolean
    holdRoleWrite?: boolean
    failCommit?: 'conflict' | 'forbidden' | null
    malformedLiveRead?: boolean
    failAccessUserIds?: string[]
  } = {}) {
    const membership = new Map<string, string[]>(Object.entries({
      'user-1': ['crm_admin'],
      'user-2': [],
      ...(options.initialMembership || {}),
    }))
    const users = [
      { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true, is_admin: false },
      { id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true, is_admin: false },
    ]
    const calls: Array<{ method: string; pathname: string; body: Record<string, unknown> | null }> = []
    const pendingAccess: Array<{ userId: string; release: () => void }> = []
    const pendingWrites: Array<{ release: () => void }> = []
    const returnedAccessSubjects: string[] = []
    const progress = { roleWritesSettled: 0 }
    let corruptNextAccess = false

    const accessPayload = (userId: string) => {
      const user = users.find((item) => item.id === userId) || users[0]
      const roles = membership.get(userId) || []
      return {
        user,
        roles,
        permissions: roles.includes('crm_admin') ? ['crm:admin'] : [],
        isAdmin: false,
      }
    }

    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const rawUrl = String(input)
      const url = new URL(rawUrl, 'http://localhost')
      const pathname = url.pathname
      const method = (init?.method || 'GET').toUpperCase()
      const parsedBody = typeof init?.body === 'string' && init.body.length > 0
        ? JSON.parse(init.body) as Record<string, unknown>
        : null
      calls.push({ method, pathname, body: parsedBody })

      if (pathname === '/api/admin/roles') {
        return jsonOk({
          items: [
            { id: 'crm_admin', name: 'CRM 管理员', memberCount: membership.get('user-1')?.includes('crm_admin') ? 1 : 0, permissions: ['crm:admin'], admissionNamespaces: [] },
            { id: 'finance_admin', name: '财务管理员', memberCount: 0, permissions: ['finance:admin'], admissionNamespaces: [] },
            { id: 'admin', name: '平台管理员', memberCount: membership.get('user-1')?.includes('admin') ? 1 : 0, permissions: [], admissionNamespaces: [] },
          ],
        })
      }
      if (pathname === '/api/admin/users') return jsonOk({ items: users })
      if (pathname === '/api/admin/access-presets') {
        return jsonOk({ items: [], capabilities: { explicitNamespaceAdmission: true } })
      }
      if (pathname.startsWith('/api/admin/invites')) return jsonOk({ items: [] })
      if (pathname === '/api/attendance/groups' || pathname === '/api/attendance/shifts') return jsonOk({ items: [] })
      if (pathname === '/api/auth/session-orgs') {
        return createJsonResponse({ success: true, data: { orgs: ['org-alpha'], currentOrgId: null } })
      }

      const accessMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/access$/)
      if (accessMatch) {
        const userId = decodeURIComponent(accessMatch[1])
        const body = accessPayload(userId)
        if (options.holdAccess) {
          await new Promise<void>((resolve) => {
            pendingAccess.push({ userId, release: resolve })
          })
        }
        if (options.failAccessUserIds?.includes(userId)) {
          return createJsonResponse({ ok: false, error: { message: '加载用户权限失败' } }, 500)
        }
        if (corruptNextAccess) {
          corruptNextAccess = false
          returnedAccessSubjects.push('user-2')
          return jsonOk({
            user: { id: 'user-2', name: 'Bravo', role: 'user', is_active: true, is_admin: false },
            roles: [],
            permissions: [],
            isAdmin: false,
          })
        }
        returnedAccessSubjects.push(userId)
        return jsonOk(body)
      }

      const sideMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/(sessions|dingtalk-access|member-admission)$/)
      if (sideMatch) {
        const kind = sideMatch[2]
        if (kind === 'sessions') return jsonOk({ items: [] })
        if (kind === 'dingtalk-access') return jsonOk(dingtalkAccessBody())
        const admittedUserId = decodeURIComponent(sideMatch[1])
        return jsonOk({
          userId: admittedUserId,
          accountEnabled: true,
          platformAdminEnabled: (membership.get(admittedUserId) || []).includes('admin'),
          attendanceAdminEnabled: false,
          businessRoleIds: membership.get(admittedUserId) || [],
          directoryMemberships: [],
          dingtalk: dingtalkAccessBody(),
          namespaceAdmissions: [],
          organizations: null,
        })
      }

      const actionRecord = parsedBody?.action
      const action = actionRecord && typeof actionRecord === 'object'
        ? actionRecord as { kind?: string; roleId?: string }
        : undefined
      const roleId = typeof action?.roleId === 'string' ? action.roleId : ''
      const operation = action?.kind === 'role.assign' ? 'assign' : 'revoke'
      if (pathname === '/api/admin/authorization-operations/preview' && method === 'POST') {
        return createJsonResponse({
          expectedVersion: 'member-version-1',
          impact: authorizationImpact(roleId, operation, !options.leaveMembershipOnUnassign),
        })
      }
      if (pathname === '/api/admin/authorization-operations' && method === 'POST') {
        const userId = typeof parsedBody?.targetUserId === 'string' ? parsedBody.targetUserId : ''
        if (options.failCommit === 'forbidden') {
          return createJsonResponse({ ok: false, error: { code: 'FORBIDDEN' } }, 403)
        }
        if (options.failCommit === 'conflict') {
          return createJsonResponse({ ok: false, error: { code: 'ROLE_MODIFIED' } }, 409)
        }
        if (options.holdRoleWrite) {
          await new Promise<void>((resolve) => {
            pendingWrites.push({ release: resolve })
          })
        }
        if (options.delayUnassign) await options.delayUnassign
        const current = membership.get(userId) || []
        const changed = options.leaveMembershipOnUnassign
          ? false
          : operation === 'assign'
            ? !current.includes(roleId)
            : current.includes(roleId)
        if (!options.leaveMembershipOnUnassign && operation === 'assign' && changed) {
          membership.set(userId, [...current, roleId])
        }
        if (!options.leaveMembershipOnUnassign && operation === 'revoke' && changed) {
          membership.set(userId, current.filter((id) => id !== roleId))
        }
        if (options.malformedLiveRead) corruptNextAccess = true
        progress.roleWritesSettled += 1
        const clientOperationId = typeof parsedBody?.clientOperationId === 'string'
          ? parsedBody.clientOperationId
          : '11111111-1111-4111-8111-111111111111'
        return createJsonResponse({
          status: 'committed',
          clientOperationId,
          receipt: {
            targetUserId: userId,
            action: action?.kind === 'role.assign'
              ? { kind: 'role.assign', roleId }
              : { kind: 'role.revoke', roleId },
            impact: authorizationImpact(roleId, operation, changed),
            resultVersion: 'member-version-2',
          },
        })
      }

      if (method === 'GET' && pathname.startsWith('/api/admin/authorization-operations/')) {
        return createJsonResponse({ ok: false, error: { code: 'NOT_FOUND' } }, 404)
      }

      throw new Error(`Unhandled apiFetch call: ${method} ${rawUrl}`)
    })

    const authorizationPosts = (pathname: string) => calls.filter((call) => call.method === 'POST' && call.pathname === pathname)

    return {
      membership,
      calls,
      pendingAccess,
      pendingWrites,
      returnedAccessSubjects,
      progress,
      previews: () => authorizationPosts('/api/admin/authorization-operations/preview'),
      commits: () => authorizationPosts('/api/admin/authorization-operations'),
      oldWrites: () => calls.filter((call) => call.pathname.includes('/roles/assign') || call.pathname.includes('/roles/unassign')),
      releaseOldestAccess() {
        pendingAccess.shift()?.release()
      },
      releaseOldestWrite() {
        pendingWrites.shift()?.release()
      },
    }
  }

  function roleSectionText(root: HTMLElement): string {
    const heading = Array.from(root.querySelectorAll('h3')).find((item) => item.textContent === '角色')
    return heading?.parentElement?.textContent || ''
  }

  function expectOneRoleCommand(
    api: ReturnType<typeof createRoleApi>,
    roleId: string,
  ): void {
    expect(api.oldWrites()).toEqual([])
    expect(api.previews()).toHaveLength(1)
    expect(api.commits()).toHaveLength(1)
    const preview = api.previews()[0]?.body
    const commit = api.commits()[0]?.body
    expect(preview?.clientOperationId).toBeUndefined()
    expect(preview?.expectedVersion).toBeUndefined()
    expect(preview?.targetUserId).toBe('user-1')
    expect(preview?.action).toEqual({ kind: 'role.revoke', roleId })
    expect(preview?.admissionChanges).toEqual([])
    expect(commit?.targetUserId).toBe('user-1')
    expect(commit?.action).toEqual({ kind: 'role.revoke', roleId })
    expect(commit?.admissionChanges).toEqual([])
    expect(commit?.expectedVersion).toBe('member-version-1')
    expect(typeof commit?.clientOperationId).toBe('string')
    expect(api.calls.findIndex((call) => call.pathname.endsWith('/preview'))).toBeLessThan(
      api.calls.findIndex((call) => call.method === 'POST' && call.pathname === '/api/admin/authorization-operations'),
    )
  }

  async function expectCheckedFailure(root: HTMLElement, message: string): Promise<void> {
    await waitForCondition(() => {
      const feedback = root.querySelector('[data-testid="role-action-feedback"]')?.textContent || ''
      const close = root.querySelector('[data-testid="admin-authorization-close"]')
      return feedback.includes(message) && close instanceof HTMLButtonElement && !close.disabled
    })
    const feedback = root.querySelector('[data-testid="role-action-feedback"]')
    expect(feedback?.className).toContain('user-admin__status--error')
    expect(feedback?.textContent).toContain(message)
    expect(feedback?.textContent).not.toContain('已撤销角色')
    expect(feedback?.textContent).not.toContain('当前未持有')
    expect(feedback?.textContent).not.toContain('已关闭')
    const confirm = root.querySelector('[data-testid="admin-authorization-confirm"]') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(root.querySelector('[data-testid="admin-authorization-dialog"]')).toBeTruthy()
  }

  it('shows selected-role membership and refuses to call leftover revoke a success', async () => {
    const api = createRoleApi({ leaveMembershipOnUnassign: true })
    const root = mountView()
    await openListedUser(root, 'Alpha')
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="user-role-select"]')))

    const select = root.querySelector('[data-testid="user-role-select"]') as HTMLSelectElement
    select.value = 'crm_admin'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    expect(root.querySelector('[data-testid="selected-role-membership"]')?.textContent).toContain('已是角色 crm_admin 的成员')

    const unassign = root.querySelector('[data-testid="unassign-role-button"]') as HTMLButtonElement
    unassign.click()
    await waitForCondition(() => (root.querySelector('[data-testid="admin-authorization-role-sources"]')?.textContent || '').includes('crm_admin'))
    expect(api.previews()).toHaveLength(1)
    expect(api.commits()).toEqual([])
    expect(api.membership.get('user-1')).toEqual(['crm_admin'])
    await confirmAuthorization(root)
    await expectCheckedFailure(root, '还没有核对成功')

    expect(document.activeElement).toBe(root.querySelector('[data-testid="admin-authorization-close"]'))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(root.querySelector('[data-testid="admin-authorization-dialog"]')?.contains(document.activeElement)).toBe(true)
    expectOneRoleCommand(api, 'crm_admin')
    expect(api.membership.get('user-1')).toEqual(['crm_admin'])
    expect(root.querySelector('[data-testid="selected-role-membership"]')?.textContent).toContain('已是角色 crm_admin 的成员')
    expect(root.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Alpha')
  })

  it('clears membership after a persisted unassign and keeps an in-flight result on the initiating user', async () => {
    let release: (() => void) | undefined
    const delayUnassign = new Promise<void>((resolve) => { release = resolve })
    const api = createRoleApi({ delayUnassign })
    const root = mountView()
    await openListedUser(root, 'Alpha')
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="user-role-select"]')))

    const select = root.querySelector('[data-testid="user-role-select"]') as HTMLSelectElement
    select.value = 'crm_admin'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    ;(root.querySelector('[data-testid="unassign-role-button"]') as HTMLButtonElement).click()
    await confirmAuthorization(root)
    await waitForCondition(() => api.previews().length === 1 && api.commits().length === 1 && api.progress.roleWritesSettled === 0)
    expect(api.membership.get('user-1')).toEqual(['crm_admin'])

    const otherUser = Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes('Bravo'))
    expect(otherUser).toBeTruthy()
    otherUser?.click()
    await waitForCondition(() => (root.textContent || '').includes('确认对象已变化，这次结果不会写入当前成员。'))

    release?.()
    await waitForCondition(() => api.progress.roleWritesSettled === 1 && api.commits().length === 1)
    await flushUi()

    expect(root.querySelector('[data-testid="admin-authorization-outcome"]')?.textContent).toContain('确认对象已变化，这次结果不会写入当前成员。')
    expect(root.textContent).not.toContain('角色已从该成员移除')
    expect(root.textContent).not.toContain('已撤销角色')
    expect(root.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Bravo')
    expect(api.membership.get('user-1')).toEqual([])
    expect(api.membership.get('user-2')).toEqual([])
    expect(root.querySelector('[data-testid="selected-role-membership"]')?.textContent).not.toContain('已是角色 crm_admin 的成员')
    expect(root.querySelector('[data-testid="admin-authorization-dialog"]')).toBeTruthy()
    expectOneRoleCommand(api, 'crm_admin')
  })

  it('refuses leftover platform-admin shortcut disable without a persisted membership drop', async () => {
    const api = createRoleApi({
      leaveMembershipOnUnassign: true,
      initialMembership: { 'user-1': ['admin'], 'user-2': [] },
    })
    const root = mountView()
    await openListedUser(root, 'Alpha')
    await waitForCondition(() => {
      const button = root.querySelector('[data-testid="revoke-platform-admin-button"]') as HTMLButtonElement | null
      return Boolean(button && !button.disabled)
    })

    expect(root.querySelector('[data-testid="platform-admin-chip"]')?.textContent).toContain('已开通平台管理员')
    ;(root.querySelector('[data-testid="revoke-platform-admin-button"]') as HTMLButtonElement).click()
    await confirmAuthorization(root, '取消平台管理员')
    await expectCheckedFailure(root, '还没有核对成功')

    expect(root.querySelector('[data-testid="platform-admin-chip"]')?.textContent).toContain('已开通平台管理员')
    expect(api.membership.get('user-1')).toEqual(['admin'])
    expectOneRoleCommand(api, 'admin')
  })

  it('keeps an in-flight platform-admin shortcut result on the initiating user', async () => {
    let release: (() => void) | undefined
    const delayUnassign = new Promise<void>((resolve) => { release = resolve })
    const api = createRoleApi({
      delayUnassign,
      initialMembership: { 'user-1': ['admin'], 'user-2': [] },
    })
    const root = mountView()
    await openListedUser(root, 'Alpha')
    await waitForCondition(() => {
      const button = root.querySelector('[data-testid="revoke-platform-admin-button"]') as HTMLButtonElement | null
      return Boolean(button && !button.disabled)
    })

    ;(root.querySelector('[data-testid="revoke-platform-admin-button"]') as HTMLButtonElement).click()
    await confirmAuthorization(root, '取消平台管理员')
    await waitForCondition(() => api.previews().length === 1 && api.commits().length === 1 && api.progress.roleWritesSettled === 0)

    const otherUser = Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes('Bravo'))
    expect(otherUser).toBeTruthy()
    otherUser?.click()
    await waitForCondition(() => (root.querySelector('[data-testid="selected-user-heading"]')?.textContent || '').includes('Bravo'))

    release?.()
    await waitForCondition(() => api.progress.roleWritesSettled === 1)
    await flushUi()

    expect(root.querySelector('[data-testid="admin-authorization-outcome"]')?.textContent).toContain('确认对象已变化，这次结果不会写入当前成员。')
    expect(root.textContent).not.toContain('已关闭')
    expect(root.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Bravo')
    expect(root.querySelector('[data-testid="selected-user-heading"]')?.textContent).not.toContain('Alpha')
    expect(root.querySelector('[data-testid="platform-admin-chip"]')?.textContent).toContain('未开通平台管理员')
    expect(api.membership.get('user-1')).toEqual([])
    expect(api.membership.get('user-2')).toEqual([])
    expect(root.querySelector('[data-testid="admin-authorization-dialog"]')).toBeTruthy()
    expectOneRoleCommand(api, 'admin')
  })

  function clickNamedUser(root: HTMLElement, name: string): void {
    const row = Array.from(root.querySelectorAll('.user-admin__user')).find((item) => item.textContent?.includes(name))
    const button = row?.querySelector('button.user-admin__user-body')
    if (button instanceof HTMLButtonElement) button.click()
  }

  it('drops a stale access snapshot across a delayed selection and A to B to A', async () => {
    const api = createRoleApi({
      holdAccess: true,
      initialMembership: { 'user-1': ['admin'], 'user-2': [] },
    })
    const root = mountView()
    await waitForCondition(() => root.textContent?.includes('Alpha') ?? false)
    clickNamedUser(root, 'Alpha')
    await waitForCondition(() => api.pendingAccess.length >= 1)
    api.membership.set('user-1', [])
    clickNamedUser(root, 'Bravo')
    await waitForCondition(() => api.pendingAccess.some((item) => item.userId === 'user-2'))
    clickNamedUser(root, 'Alpha')
    await waitForCondition(() => api.pendingAccess.filter((item) => item.userId === 'user-1').length >= 2)

    expect(root.querySelector('[data-testid="user-access-unread"]')).toBeTruthy()
    expect(root.querySelector('[data-testid="platform-admin-chip"]')).toBeNull()
    expect(root.querySelector('[data-testid="selected-user-heading"]')).toBeNull()

    api.releaseOldestAccess()
    await flushUi()
    expect(root.querySelector('[data-testid="platform-admin-chip"]')).toBeNull()
    expect(root.querySelector('[data-testid="selected-user-heading"]')).toBeNull()
    expect(root.querySelector('[data-testid="user-access-unread"]')).toBeTruthy()

    const bravo = api.pendingAccess.findIndex((item) => item.userId === 'user-2')
    api.pendingAccess.splice(bravo, 1)[0]?.release()
    await flushUi()
    expect(root.querySelector('[data-testid="selected-user-heading"]')).toBeNull()
    expect(root.textContent).not.toContain('已开通平台管理员')

    api.releaseOldestAccess()
    await waitForCondition(() => (root.querySelector('[data-testid="selected-user-heading"]')?.textContent || '').includes('Alpha'))
    expect(root.querySelector('[data-testid="platform-admin-chip"]')?.textContent).toContain('未开通平台管理员')
    expect(root.querySelector('[data-testid="selected-user-heading"]')?.textContent).not.toContain('Bravo')
    expect(api.previews()).toEqual([])
    expect(api.commits()).toEqual([])
    expect(api.oldWrites()).toEqual([])
  })

  it('clears the previous user when the next selection read fails and ignores a malformed role readback', async () => {
    createRoleApi({
      failAccessUserIds: ['user-2'],
      initialMembership: { 'user-1': ['crm_admin'], 'user-2': [] },
    })
    const failedRoot = mountView()
    await openListedUser(failedRoot, 'Alpha')
    await waitForCondition(() => (failedRoot.querySelector('[data-testid="selected-role-membership"]')?.textContent || '').includes('请选择角色'))
    const select = failedRoot.querySelector('[data-testid="user-role-select"]') as HTMLSelectElement
    select.value = 'crm_admin'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(failedRoot.querySelector('[data-testid="selected-role-membership"]')?.textContent).toContain('已是角色 crm_admin 的成员')
    clickNamedUser(failedRoot, 'Bravo')
    await waitForCondition(() => Boolean(failedRoot.querySelector('[data-testid="user-access-unread"]')))
    expect(failedRoot.querySelector('[data-testid="selected-user-heading"]')).toBeNull()
    expect(failedRoot.querySelector('[data-testid="selected-role-membership"]')).toBeNull()
    expect(failedRoot.querySelector('[data-testid="platform-admin-chip"]')).toBeNull()
    expect(failedRoot.textContent).not.toContain('已是角色 crm_admin 的成员')
    app?.unmount()
    container?.remove()
    app = null
    container = null
    apiFetchMock.mockReset()

    const malformed = createRoleApi({ malformedLiveRead: true })
    const malformedRoot = mountView()
    await openListedUser(malformedRoot, 'Alpha')
    await waitForCondition(() => Boolean(malformedRoot.querySelector('[data-testid="user-role-select"]')))
    const roleSelect = malformedRoot.querySelector('[data-testid="user-role-select"]') as HTMLSelectElement
    roleSelect.value = 'crm_admin'
    roleSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    ;(malformedRoot.querySelector('[data-testid="unassign-role-button"]') as HTMLButtonElement).click()
    await confirmAuthorization(malformedRoot)
    await expectCheckedFailure(malformedRoot, '还没有核对成功')
    expect(malformed.returnedAccessSubjects).toContain('user-2')
    expect(malformedRoot.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Alpha')
    expect(malformedRoot.querySelector('[data-testid="selected-role-membership"]')?.textContent).toContain('已是角色 crm_admin 的成员')
    expect(malformedRoot.querySelector('[data-testid="user-access-unread"]')).toBeNull()
    expect(roleSectionText(malformedRoot)).toContain('CRM 管理员')
    expectOneRoleCommand(malformed, 'crm_admin')
  })

  it('does not apply an older role write over a newer A to B to A access read', async () => {
    const api = createRoleApi({ holdRoleWrite: true })
    const root = mountView()
    await openListedUser(root, 'Alpha')
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="user-role-select"]')))
    const select = root.querySelector('[data-testid="user-role-select"]') as HTMLSelectElement
    select.value = 'crm_admin'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    ;(root.querySelector('[data-testid="unassign-role-button"]') as HTMLButtonElement).click()
    await confirmAuthorization(root)
    await waitForCondition(() => api.pendingWrites.length === 1)

    clickNamedUser(root, 'Bravo')
    await waitForCondition(() => (root.querySelector('[data-testid="selected-user-heading"]')?.textContent || '').includes('Bravo'))
    api.membership.set('user-1', [])
    clickNamedUser(root, 'Alpha')
    await waitForCondition(() => roleSectionText(root).includes('未分配角色'))
    expect(roleSectionText(root)).not.toContain('crm_admin')

    api.releaseOldestWrite()
    await waitForCondition(() => api.progress.roleWritesSettled === 1)
    await flushUi()
    expect(root.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Alpha')
    expect(roleSectionText(root)).toContain('未分配角色')
    expect(roleSectionText(root)).not.toContain('crm_admin')
    expect(roleSectionText(root)).not.toContain('CRM 管理员')
    expect(root.querySelector('[data-testid="admin-authorization-outcome"]')?.textContent).toContain('确认对象已变化，这次结果不会写入当前成员。')
    expect(root.textContent).not.toContain('角色已从该成员移除')
    expectOneRoleCommand(api, 'crm_admin')
  })

  it('keeps the current member visible when the role command is rejected', async () => {
    const conflict = createRoleApi({ failCommit: 'conflict' })
    const root = mountView()
    await openListedUser(root, 'Alpha')
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="user-role-select"]')))
    const select = root.querySelector('[data-testid="user-role-select"]') as HTMLSelectElement
    select.value = 'crm_admin'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(root.querySelector('[data-testid="selected-role-membership"]')?.textContent).toContain('已是角色 crm_admin 的成员')
    ;(root.querySelector('[data-testid="unassign-role-button"]') as HTMLButtonElement).click()
    await confirmAuthorization(root)
    await waitForCondition(() => {
      const close = root.querySelector('[data-testid="admin-authorization-close"]')
      const feedback = root.querySelector('[data-testid="role-action-feedback"]')?.textContent || ''
      return close instanceof HTMLButtonElement && !close.disabled && feedback.includes('角色目录已变化，本次未写入。请刷新角色后再确认。')
    })
    await flushUi()
    expect(root.querySelector('[data-testid="role-action-feedback"]')?.textContent).toContain('角色目录已变化，本次未写入。请刷新角色后再确认。')
    expect(root.textContent).not.toContain('已撤销角色')
    expect((root.querySelector('[data-testid="admin-authorization-confirm"]') as HTMLButtonElement).disabled).toBe(true)
    expect(root.querySelector('[data-testid="user-access-unread"]')).toBeNull()
    expect(root.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Alpha')
    expect(root.querySelector('[data-testid="selected-role-membership"]')?.textContent).toContain('已是角色 crm_admin 的成员')
    expect(conflict.membership.get('user-1')).toEqual(['crm_admin'])
    expectOneRoleCommand(conflict, 'crm_admin')
    expect(conflict.previews()).toHaveLength(1)

    app?.unmount()
    container?.remove()
    app = null
    container = null
    apiFetchMock.mockReset()

    const forbidden = createRoleApi({ failCommit: 'forbidden' })
    const forbiddenRoot = mountView()
    await openListedUser(forbiddenRoot, 'Alpha')
    await waitForCondition(() => Boolean(forbiddenRoot.querySelector('[data-testid="user-role-select"]')))
    const forbiddenSelect = forbiddenRoot.querySelector('[data-testid="user-role-select"]') as HTMLSelectElement
    forbiddenSelect.value = 'crm_admin'
    forbiddenSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    ;(forbiddenRoot.querySelector('[data-testid="unassign-role-button"]') as HTMLButtonElement).click()
    await confirmAuthorization(forbiddenRoot)
    await waitForCondition(() => {
      const close = forbiddenRoot.querySelector('[data-testid="admin-authorization-close"]')
      const feedback = forbiddenRoot.querySelector('[data-testid="role-action-feedback"]')?.textContent || ''
      return close instanceof HTMLButtonElement && !close.disabled && feedback.includes('没有执行这次授权的权限。本次没有提交。')
    })
    expect(forbiddenRoot.textContent).not.toContain('已撤销角色')
    expect(forbiddenRoot.querySelector('[data-testid="user-access-unread"]')).toBeNull()
    expect(forbiddenRoot.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Alpha')
    expect(forbiddenRoot.querySelector('[data-testid="selected-role-membership"]')?.textContent).toContain('已是角色 crm_admin 的成员')
    expect((forbiddenRoot.querySelector('[data-testid="admin-authorization-confirm"]') as HTMLButtonElement).disabled).toBe(true)
    expect(forbidden.membership.get('user-1')).toEqual(['crm_admin'])
    expect(forbidden.oldWrites()).toEqual([])
    expectOneRoleCommand(forbidden, 'crm_admin')
  })

  it('wires this spec into the required web lane and the approval domain guard', () => {
    const script = readFileSync(resolve(join(__dirname, '..', 'scripts', 'run-required-web-tests.sh')), 'utf8')
    const guard = readFileSync(resolve(join(__dirname, '..', '..', '..', '.github/workflows/approval-web-guard.yml')), 'utf8')
    expect(script).toContain('userManagementRoleMembership')
    expect(guard).toContain('userManagementRoleMembership')
    expect(guard).toContain('permissionManagementView')
    expect(guard.split('apps/web/tests/userManagementRoleMembership.spec.ts').length - 1).toBeGreaterThanOrEqual(2)
    expect(guard.split('apps/web/tests/permissionManagementView.spec.ts').length - 1).toBeGreaterThanOrEqual(2)
  })
})
