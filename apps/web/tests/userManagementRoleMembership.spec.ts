import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import UserManagementView from '../src/views/UserManagementView.vue'
import { describeRoleMembershipWrite, roleWriteOutcomeFromPayload, selectedRoleMembershipHint } from '../src/views/adminUserRoleAction'

const apiFetchMock = vi.fn()

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    hasAdminAccess: () => true,
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

  afterEach(() => {
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
    app.component('RouterLink', { props: ['to'], template: '<a><slot /></a>' })
    app.mount(container)
    return container
  }

  function createRoleApi(options: {
    leaveMembershipOnUnassign?: boolean
    delayUnassign?: Promise<void>
    initialMembership?: Record<string, string[]>
    holdAccess?: boolean
    holdRoleWrite?: boolean
    failRoleWrite?: boolean
    failAccessUserIds?: string[]
    roleWriteData?: unknown
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
    const calls: string[] = []
    const pendingAccess: Array<{ userId: string; release: () => void }> = []
    const pendingWrites: Array<{ release: () => void }> = []
    const progress = { roleWritesSettled: 0 }

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
      calls.push(`${method} ${pathname}`)

      if (pathname === '/api/admin/roles') {
        return jsonOk({
          items: [
            { id: 'crm_admin', name: 'CRM 管理员', memberCount: membership.get('user-1')?.includes('crm_admin') ? 1 : 0, permissions: ['crm:admin'] },
            { id: 'finance_admin', name: '财务管理员', memberCount: 0, permissions: ['finance:admin'] },
          ],
        })
      }
      if (pathname === '/api/admin/users') return jsonOk({ items: users })
      if (pathname === '/api/admin/access-presets') return jsonOk({ items: [] })
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
        return jsonOk(body)
      }

      const sideMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/(sessions|dingtalk-access|member-admission)$/)
      if (sideMatch) {
        const kind = sideMatch[2]
        if (kind === 'sessions') return jsonOk({ items: [] })
        if (kind === 'dingtalk-access') {
          return jsonOk({
            provider: 'dingtalk',
            grant: { exists: false, enabled: false, grantedBy: null, createdAt: null, updatedAt: null },
            identity: { exists: false, corpId: null, unionId: null, openId: null, hasUnionId: false, hasOpenId: false, lastLoginAt: null, createdAt: null, updatedAt: null },
          })
        }
        return jsonOk({
          userId: decodeURIComponent(sideMatch[1]),
          accountEnabled: true,
          platformAdminEnabled: false,
          attendanceAdminEnabled: false,
          businessRoleIds: membership.get(decodeURIComponent(sideMatch[1])) || [],
          directoryMemberships: [],
          dingtalk: { grant: { enabled: false } },
          namespaceAdmissions: [],
        })
      }

      const roleMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/roles\/(assign|unassign)$/)
      if (roleMatch && method === 'POST') {
        const userId = decodeURIComponent(roleMatch[1])
        const action = roleMatch[2] as 'assign' | 'unassign'
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { roleId?: string } : {}
        const roleId = String(body.roleId || '')
        if (options.failRoleWrite) {
          return createJsonResponse({ ok: false, error: { message: '保存角色失败' } }, 500)
        }
        if (options.holdRoleWrite) {
          const frozenRoles = [...(membership.get(userId) || [])]
          const user = users.find((item) => item.id === userId) || users[0]
          const frozen = {
            user,
            roles: frozenRoles,
            permissions: frozenRoles.includes('crm_admin') ? ['crm:admin'] : [],
            isAdmin: false,
            changedRoleId: roleId,
            actorId: 'admin-1',
            roleHeld: frozenRoles.includes(roleId),
            membershipChanged: false,
          }
          await new Promise<void>((resolve) => {
            pendingWrites.push({ release: resolve })
          })
          progress.roleWritesSettled += 1
          return jsonOk(frozen)
        }
        if (options.roleWriteData !== undefined) return jsonOk(options.roleWriteData)
        if (action === 'unassign' && options.delayUnassign) await options.delayUnassign
        const current = membership.get(userId) || []
        if (action === 'assign') {
          const changed = !current.includes(roleId)
          const next = changed ? [...current, roleId] : current
          membership.set(userId, next)
          return jsonOk({
            ...accessPayload(userId),
            changedRoleId: roleId,
            actorId: 'admin-1',
            roleHeld: true,
            membershipChanged: changed,
          })
        }
        if (options.leaveMembershipOnUnassign) {
          return jsonOk({
            ...accessPayload(userId),
            changedRoleId: roleId,
            actorId: 'admin-1',
            roleHeld: current.includes(roleId),
            membershipChanged: false,
          })
        }
        const changed = current.includes(roleId)
        membership.set(userId, current.filter((id) => id !== roleId))
        const snapshot = accessPayload(userId)
        return jsonOk({
          ...snapshot,
          changedRoleId: roleId,
          actorId: 'admin-1',
          roleHeld: snapshot.roles.includes(roleId),
          membershipChanged: changed,
        })
      }

      throw new Error(`Unhandled apiFetch call: ${method} ${rawUrl}`)
    })

    return {
      membership,
      calls,
      pendingAccess,
      pendingWrites,
      progress,
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

  it('shows selected-role membership and refuses to call leftover revoke a success', async () => {
    createRoleApi({ leaveMembershipOnUnassign: true })
    const root = mountView()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="user-role-select"]')))

    const select = root.querySelector('[data-testid="user-role-select"]') as HTMLSelectElement
    select.value = 'crm_admin'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    expect(root.querySelector('[data-testid="selected-role-membership"]')?.textContent).toContain('已是角色 crm_admin 的成员')

    const unassign = root.querySelector('[data-testid="unassign-role-button"]') as HTMLButtonElement
    unassign.click()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="role-action-feedback"]')?.textContent?.includes('仍持有角色')))

    const feedback = root.querySelector('[data-testid="role-action-feedback"]')
    expect(feedback?.className).toContain('user-admin__status--error')
    expect(feedback?.textContent).toContain('操作者 admin-1')
    expect(root.textContent).toContain('crm_admin')
  })

  it('clears membership after a persisted unassign and keeps an in-flight result on the initiating user', async () => {
    let release: (() => void) | undefined
    const delayUnassign = new Promise<void>((resolve) => { release = resolve })
    const api = createRoleApi({ delayUnassign })
    const root = mountView()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="user-role-select"]')))

    const select = root.querySelector('[data-testid="user-role-select"]') as HTMLSelectElement
    select.value = 'crm_admin'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    ;(root.querySelector('[data-testid="unassign-role-button"]') as HTMLButtonElement).click()
    await flushUi(4)

    const otherUser = Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes('Bravo'))
    expect(otherUser).toBeTruthy()
    otherUser?.click()
    await waitForCondition(() => (root.querySelector('[data-testid="selected-role-membership"]')?.textContent || '').includes('请选择角色'))

    release?.()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="role-action-feedback"]')?.textContent?.includes('user-1')))

    expect(root.querySelector('[data-testid="role-action-feedback"]')?.textContent).toContain('未覆盖当前选中用户 user-2')
    expect(api.membership.get('user-1')).toEqual([])
    expect(api.membership.get('user-2')).toEqual([])
    expect(root.querySelector('[data-testid="selected-role-membership"]')?.textContent).not.toContain('已是角色 crm_admin 的成员')
  })

  it('refuses leftover platform-admin shortcut disable without a persisted membership drop', async () => {
    createRoleApi({
      leaveMembershipOnUnassign: true,
      initialMembership: { 'user-1': ['admin'], 'user-2': [] },
    })
    const root = mountView()
    await waitForCondition(() => {
      const button = root.querySelector('[data-testid="revoke-platform-admin-button"]') as HTMLButtonElement | null
      return Boolean(button && !button.disabled)
    })

    expect(root.querySelector('[data-testid="platform-admin-chip"]')?.textContent).toContain('已开通平台管理员')
    ;(root.querySelector('[data-testid="revoke-platform-admin-button"]') as HTMLButtonElement).click()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="role-action-feedback"]')?.textContent?.includes('仍持有角色 admin')))

    const feedback = root.querySelector('[data-testid="role-action-feedback"]')
    expect(feedback?.className).toContain('user-admin__status--error')
    expect(feedback?.textContent).not.toContain('已关闭')
    expect(root.querySelector('[data-testid="platform-admin-chip"]')?.textContent).toContain('已开通平台管理员')
  })

  it('keeps an in-flight platform-admin shortcut result on the initiating user', async () => {
    let release: (() => void) | undefined
    const delayUnassign = new Promise<void>((resolve) => { release = resolve })
    const api = createRoleApi({
      delayUnassign,
      initialMembership: { 'user-1': ['admin'], 'user-2': [] },
    })
    const root = mountView()
    await waitForCondition(() => {
      const button = root.querySelector('[data-testid="revoke-platform-admin-button"]') as HTMLButtonElement | null
      return Boolean(button && !button.disabled)
    })

    ;(root.querySelector('[data-testid="revoke-platform-admin-button"]') as HTMLButtonElement).click()
    await flushUi(4)

    const otherUser = Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes('Bravo'))
    expect(otherUser).toBeTruthy()
    otherUser?.click()
    await waitForCondition(() => (root.querySelector('[data-testid="selected-user-heading"]')?.textContent || '').includes('Bravo'))

    release?.()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="role-action-feedback"]')?.textContent?.includes('user-1')))

    expect(root.querySelector('[data-testid="role-action-feedback"]')?.textContent).toContain('未覆盖当前选中用户 user-2')
    expect(root.querySelector('[data-testid="selected-user-heading"]')?.textContent).toContain('Bravo')
    expect(root.querySelector('[data-testid="selected-user-heading"]')?.textContent).not.toContain('Alpha')
    expect(root.querySelector('[data-testid="platform-admin-chip"]')?.textContent).toContain('未开通平台管理员')
    expect(api.membership.get('user-1')).toEqual([])
    expect(api.membership.get('user-2')).toEqual([])
  })

  function clickNamedUser(root: HTMLElement, name: string): void {
    const button = Array.from(root.querySelectorAll('button')).find((item) => item.textContent?.includes(name))
    button?.click()
  }

  it('drops a stale access snapshot across a delayed selection and A to B to A', async () => {
    const api = createRoleApi({
      holdAccess: true,
      initialMembership: { 'user-1': ['admin'], 'user-2': [] },
    })
    const root = mountView()
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
  })

  it('clears the previous user when the next selection read fails and ignores a malformed role readback', async () => {
    createRoleApi({
      failAccessUserIds: ['user-2'],
      initialMembership: { 'user-1': ['crm_admin'], 'user-2': [] },
    })
    const failedRoot = mountView()
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

    createRoleApi({ roleWriteData: {} })
    const malformedRoot = mountView()
    await waitForCondition(() => Boolean(malformedRoot.querySelector('[data-testid="user-role-select"]')))
    const roleSelect = malformedRoot.querySelector('[data-testid="user-role-select"]') as HTMLSelectElement
    roleSelect.value = 'crm_admin'
    roleSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    ;(malformedRoot.querySelector('[data-testid="unassign-role-button"]') as HTMLButtonElement).click()
    await waitForCondition(() => Boolean(malformedRoot.querySelector('[data-testid="user-access-unread"]')))
    const feedback = malformedRoot.querySelector('.user-admin__status')
    expect(feedback?.textContent).toContain('不完整或主体不一致')
    expect(feedback?.textContent).not.toContain('当前未持有')
    expect(feedback?.textContent).not.toContain('已撤销角色')
    expect(malformedRoot.querySelector('[data-testid="selected-role-membership"]')).toBeNull()
    expect(malformedRoot.textContent).not.toContain('已是角色 crm_admin 的成员')
    expect(malformedRoot.querySelector('[data-testid="unassign-role-button"]')).toBeNull()
    expect(malformedRoot.querySelector('[data-testid="revoke-platform-admin-button"]')).toBeNull()
    expect(malformedRoot.querySelector('[data-testid="selected-user-heading"]')).toBeNull()
  })

  it('does not apply an older role write over a newer A to B to A access read', async () => {
    const api = createRoleApi({ holdRoleWrite: true })
    const root = mountView()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="user-role-select"]')))
    const select = root.querySelector('[data-testid="user-role-select"]') as HTMLSelectElement
    select.value = 'crm_admin'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    ;(root.querySelector('[data-testid="unassign-role-button"]') as HTMLButtonElement).click()
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
  })

  it('marks the current role snapshot unread when the role write is rejected', async () => {
    createRoleApi({ failRoleWrite: true })
    const root = mountView()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="user-role-select"]')))
    const select = root.querySelector('[data-testid="user-role-select"]') as HTMLSelectElement
    select.value = 'crm_admin'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(root.querySelector('[data-testid="selected-role-membership"]')?.textContent).toContain('已是角色 crm_admin 的成员')
    ;(root.querySelector('[data-testid="unassign-role-button"]') as HTMLButtonElement).click()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="user-access-unread"]')))
    expect(root.querySelector('.user-admin__status')?.textContent).toContain('保存角色失败')
    expect(root.textContent).not.toContain('已是角色 crm_admin 的成员')
    expect(root.querySelector('[data-testid="assign-role-button"]')).toBeNull()
    expect(root.querySelector('[data-testid="revoke-platform-admin-button"]')).toBeNull()
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
