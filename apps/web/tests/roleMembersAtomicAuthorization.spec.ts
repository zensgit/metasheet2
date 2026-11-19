/**
 * Mounted role roster: one preview, one confirm, and GET-only recovery.
 * The user and role shown before confirm stay frozen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, type App } from 'vue'
import { useAuth } from '../src/composables/useAuth'
import { ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY } from '../src/utils/adminAuthorizationOperation'
import RoleMembersPanel from '../src/views/RoleMembersPanel.vue'
import type { AdminAuthorizationImpact } from '../src/utils/adminAuthorizationOperation'

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

const PREVIEW_PATH = '/api/admin/authorization-operations/preview'
const COMMIT_PATH = '/api/admin/authorization-operations'

type Member = { id: string; displayName: string }

type RecordedCall = {
  url: string
  method: string
  body: Record<string, unknown> | null
}

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

function rolePermission(roleId: string): AdminAuthorizationImpact['effectiveAfter'][number] {
  return {
    code: 'attendance:read',
    sources: [{ kind: 'role', id: roleId }],
    effective: true,
  }
}

function impactFor(roleId: string, extras: { derived?: boolean; cleanup?: boolean } = {}): AdminAuthorizationImpact {
  return {
    sourceChanges: [{ source: 'role', id: roleId, operation: 'assign', changed: true }],
    admissionChanges: [
      { namespace: 'attendance', before: null, after: true, cause: 'explicit' },
      ...(extras.derived ? [{ namespace: 'project', before: true, after: false, cause: 'role_revoke' as const }] : []),
    ],
    scopeCleanup: extras.cleanup
      ? [{ namespace: 'attendance', kind: 'department', id: 'dept-1' }]
      : [],
    effectiveBefore: [],
    effectiveAfter: [rolePermission(roleId)],
    retainedOtherGrants: [{
      code: 'sheet:read',
      sources: [{ kind: 'legacy', id: null }],
      effective: false,
    }],
    warnings: [],
  }
}

function previewBody(roleId: string, extras?: { derived?: boolean; cleanup?: boolean }) {
  return {
    expectedVersion: `version-${roleId}`,
    impact: impactFor(roleId, extras),
  }
}

function committedBody(input: {
  id: string
  userId: string
  roleId: string
  kind: 'role.assign' | 'role.revoke'
  extras?: { derived?: boolean; cleanup?: boolean }
}) {
  return {
    status: 'committed',
    clientOperationId: input.id,
    receipt: {
      targetUserId: input.userId,
      action: { kind: input.kind, roleId: input.roleId },
      impact: impactFor(input.roleId, input.extras),
      resultVersion: 'version-2',
    },
  }
}

function previewLine(roleId: string, extras: { derived?: boolean; cleanup?: boolean } = {}): string {
  const derived = extras.derived ? '关闭 project' : '无'
  const cleanup = extras.cleanup ? '1' : '0'
  return `角色来源：${roleId} 显式准入：开通 attendance 派生准入：${derived} 范围清理：${cleanup} 其他仍保留来源：sheet:read`
}

let calls: RecordedCall[] = []
let membersByRole: Record<string, { items: Member[]; total: number }> = {}
let accessRoles: string[] = []
let previewExtras: { derived?: boolean; cleanup?: boolean } = {}
let commitResult: { status: number; body: unknown } | { pending: Array<(value: ReturnType<typeof jsonResponse>) => void> } = {
  status: 200,
  body: {},
}

function authorizationPosts(): RecordedCall[] {
  return calls.filter((call) => call.method === 'POST' && (
    call.url === PREVIEW_PATH || call.url === COMMIT_PATH
  ))
}

function legacyRolePosts(): RecordedCall[] {
  return calls.filter((call) => call.method === 'POST' && (
    call.url.includes('/roles/assign') || call.url.includes('/roles/unassign')
  ))
}

function accessGets(): string[] {
  return calls.filter((call) => call.method === 'GET' && call.url.includes('/access')).map((call) => call.url)
}

function operationGets(): string[] {
  return calls.filter((call) => (
    call.method === 'GET' && call.url.startsWith(`${COMMIT_PATH}/`)
  )).map((call) => call.url)
}

function memberGets(): string[] {
  return calls.filter((call) => call.method === 'GET' && call.url.includes('/members')).map((call) => call.url)
}

async function freeze(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

let container: HTMLElement | null = null
let app: App<Element> | null = null

const state = reactive({
  roleId: 'role-a',
  roleName: '角色甲',
  permissionCodes: ['attendance:read'] as string[],
  expectedUpdatedAt: '2026-11-17T00:00:00.000Z' as string | null,
  namespacesByRoleId: {} as Record<string, unknown>,
  mutationsDisabled: false,
  actionsLocked: false,
  focusUserId: '',
})

function byTestId(id: string): HTMLElement {
  const element = container?.querySelector(`[data-testid="${id}"]`)
  if (!element) throw new Error(`${id} missing`)
  return element as HTMLElement
}

function memberButton(id: string): HTMLButtonElement {
  const button = container?.querySelector(`[data-role-member-row][data-user-id="${id}"]`)
  if (!button) throw new Error(`member ${id} missing`)
  return button as HTMLButtonElement
}

function button(selector: string): HTMLButtonElement {
  const element = container?.querySelector(selector)
  if (!(element instanceof HTMLButtonElement)) throw new Error(`${selector} missing`)
  return element
}

function phaseText(): string {
  return byTestId('role-member-authorization-phase').textContent || ''
}

function previewText(): string {
  return byTestId('role-member-authorization-preview').textContent || ''
}

async function mountPanel(): Promise<void> {
  const Harness = defineComponent({
    name: 'RoleMembersHarness',
    setup() {
      return () => h(RoleMembersPanel, {
        roleId: state.roleId,
        roleName: state.roleName,
        permissionCodes: state.permissionCodes,
        expectedUpdatedAt: state.expectedUpdatedAt,
        namespacesByRoleId: state.namespacesByRoleId,
        mutationsDisabled: state.mutationsDisabled,
        actionsLocked: state.actionsLocked,
        focusUserId: state.focusUserId,
      })
    },
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(Harness)
  app.mount(container)
  await freeze()
}

async function selectMember(id: string): Promise<void> {
  memberButton(id).click()
  await freeze()
}

function resetHarness(): void {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  sessionStorage.removeItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY)
  calls = []
}

beforeEach(() => {
  calls = []
  membersByRole = {
    'role-a': { items: [{ id: 'user-1', displayName: '甲一' }, { id: 'user-2', displayName: '甲二' }], total: 2 },
    'role-b': { items: [{ id: 'user-b', displayName: '乙成员' }], total: 7 },
    admin: { items: [{ id: 'user-1', displayName: '甲一' }], total: 1 },
  }
  accessRoles = []
  previewExtras = {}
  commitResult = { status: 200, body: {} }
  state.roleId = 'role-a'
  state.roleName = '角色甲'
  state.permissionCodes = ['attendance:read']
  state.expectedUpdatedAt = '2026-11-17T00:00:00.000Z'
  state.namespacesByRoleId = {}
  state.mutationsDisabled = false
  state.actionsLocked = false
  state.focusUserId = ''
  sessionStorage.removeItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY)
  useAuth().primeSession({ data: { user: { id: 'principal-1', name: '管理员' } } })
  apiFetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : null
    calls.push({ url: String(url), method, body })
    const parsed = new URL(String(url), 'http://local.test')
    if (parsed.pathname.includes('/members')) {
      const roleId = decodeURIComponent(parsed.pathname.split('/').at(-2) || '')
      const page = membersByRole[roleId] || { items: [], total: 0 }
      return jsonResponse({ ok: true, data: { items: page.items, page: 1, pageSize: 20, total: page.total } })
    }
    if (parsed.pathname.endsWith('/access')) {
      const userId = decodeURIComponent(parsed.pathname.split('/').at(-2) || '')
      return jsonResponse({
        ok: true,
        data: { user: { id: userId, name: '甲一' }, roles: [...accessRoles] },
      })
    }
    if (parsed.pathname === PREVIEW_PATH && method === 'POST') {
      const action = body?.action as { roleId?: string } | undefined
      return jsonResponse(previewBody(action?.roleId || 'role-a', previewExtras))
    }
    if (parsed.pathname === COMMIT_PATH && method === 'POST') {
      const pending = commitResult
      if ('pending' in pending) {
        return new Promise((resolve) => {
          pending.pending.push(resolve)
        })
      }
      const id = typeof body?.clientOperationId === 'string' ? body.clientOperationId : ''
      const action = body?.action as { kind?: 'role.assign' | 'role.revoke'; roleId?: string } | undefined
      const supplied = pending.body
      const empty = !supplied || typeof supplied !== 'object' || Object.keys(supplied).length === 0
      const payload = pending.status >= 200 && pending.status < 300 && empty
        ? committedBody({
          id,
          userId: typeof body?.targetUserId === 'string' ? body.targetUserId : 'user-1',
          roleId: action?.roleId || 'role-a',
          kind: action?.kind || 'role.assign',
          extras: previewExtras,
        })
        : (supplied ?? {})
      return jsonResponse(payload, pending.status)
    }
    if (method === 'GET' && parsed.pathname.startsWith(`${COMMIT_PATH}/`)) {
      return jsonResponse({ status: 'unknown_or_pending', clientOperationId: parsed.pathname.split('/').at(-1) })
    }
    throw new Error(`unexpected ${method} ${url}`)
  })
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  sessionStorage.removeItem(ADMIN_AUTHORIZATION_PENDING_STORAGE_KEY)
  useAuth().primeSession(null)
})

describe('RoleMembersPanel atomic authorization', () => {
  it('sends the role request once and does not post the old role routes', async () => {
    await mountPanel()
    await selectMember('user-1')
    button('[data-role-member-add]').click()
    await freeze()

    expect(phaseText()).toBe('请核对服务器预览后再确认。这次只变更角色。')
    expect(previewText()).toBe(previewLine('role-a'))
    expect(button('[data-testid="admin-authorization-confirm"]').disabled).toBe(false)
    expect(authorizationPosts()).toEqual([{
      url: PREVIEW_PATH,
      method: 'POST',
      body: {
        targetUserId: 'user-1',
        action: { kind: 'role.assign', roleId: 'role-a' },
        admissionChanges: [],
      },
    }])
    expect(legacyRolePosts()).toEqual([])

    button('[data-testid="admin-authorization-confirm"]').click()
    await freeze()
    const commit = authorizationPosts()[1]
    const clientOperationId = commit?.body?.clientOperationId
    expect(authorizationPosts()).toEqual([
      authorizationPosts()[0],
      {
        url: COMMIT_PATH,
        method: 'POST',
        body: {
          targetUserId: 'user-1',
          action: { kind: 'role.assign', roleId: 'role-a' },
          admissionChanges: [],
          clientOperationId,
          expectedVersion: 'version-role-a',
        },
      },
    ])
    expect(commit?.body).not.toHaveProperty('expectedUpdatedAt')
    expect(legacyRolePosts()).toEqual([])

    state.roleId = 'role-b'
    state.roleName = '角色乙'
    await freeze()
    await selectMember('user-b')
    button('[data-role-member-remove]').click()
    await freeze()
    expect(authorizationPosts().at(-1)).toEqual({
      url: PREVIEW_PATH,
      method: 'POST',
      body: {
        targetUserId: 'user-b',
        action: { kind: 'role.revoke', roleId: 'role-b' },
        admissionChanges: [],
      },
    })
    expect(legacyRolePosts()).toEqual([])
  })

  it('verifies a new role read and recovers a failed commit with GET only', async () => {
    accessRoles = []
    await mountPanel()
    await selectMember('user-1')
    button('[data-role-member-add]').click()
    await freeze()
    button('[data-testid="admin-authorization-confirm"]').click()
    await freeze()

    expect(phaseText()).toBe('回执已记录。角色回读还没有对上。')
    expect(accessGets()).toEqual([
      '/api/admin/users/user-1/access',
      '/api/admin/users/user-1/access',
    ])
    expect(authorizationPosts().map((call) => call.url)).toEqual([PREVIEW_PATH, COMMIT_PATH])
    expect(operationGets()).toEqual([])
    expect(legacyRolePosts()).toEqual([])

    accessRoles = ['role-a']
    button('[data-testid="role-member-authorization-reread"]').click()
    await freeze()
    const operationId = authorizationPosts()[1]?.body?.clientOperationId
    expect(phaseText()).toBe('已核对同一用户的角色成员状态。')
    expect(operationGets()).toEqual([`${COMMIT_PATH}/${operationId}`])
    expect(accessGets()).toEqual([
      '/api/admin/users/user-1/access',
      '/api/admin/users/user-1/access',
      '/api/admin/users/user-1/access',
    ])
    expect(authorizationPosts().map((call) => call.url)).toEqual([PREVIEW_PATH, COMMIT_PATH])

    resetHarness()
    accessRoles = []
    commitResult = { status: 503, body: {} }
    await mountPanel()
    await selectMember('user-1')
    button('[data-role-member-add]').click()
    await freeze()
    button('[data-testid="admin-authorization-confirm"]').click()
    await freeze()
    expect(phaseText()).toBe('提交结果还不能确认。请重新读取。不会再次提交。')
    expect(authorizationPosts().map((call) => call.url)).toEqual([PREVIEW_PATH, COMMIT_PATH])
    const failedId = authorizationPosts()[1]?.body?.clientOperationId
    button('[data-testid="role-member-authorization-reread"]').click()
    await freeze()
    expect(operationGets()).toEqual([`${COMMIT_PATH}/${failedId}`])
    expect(authorizationPosts().map((call) => call.url)).toEqual([PREVIEW_PATH, COMMIT_PATH])
    expect(phaseText()).toBe('提交结果还不能确认。请重新读取。不会再次提交。')
  })

  it('keeps a stale confirm off the next role, and draft or leave still blocks the post', async () => {
    const pending: Array<(value: ReturnType<typeof jsonResponse>) => void> = []
    commitResult = { pending }
    await mountPanel()
    await selectMember('user-1')
    button('[data-role-member-add]').click()
    await freeze()
    button('[data-testid="admin-authorization-confirm"]').click()
    await freeze()
    expect(pending).toHaveLength(1)
    const inFlightId = authorizationPosts()[1]?.body?.clientOperationId
    state.roleId = 'role-b'
    state.roleName = '角色乙'
    await freeze()
    expect(memberButton('user-b').textContent).toBe('乙成员')
    const memberReads = memberGets().length
    pending[0]?.(jsonResponse(committedBody({
      id: String(inFlightId),
      userId: 'user-1',
      roleId: 'role-a',
      kind: 'role.assign',
    })))
    await freeze()
    expect(memberGets()).toHaveLength(memberReads)
    expect(container?.querySelector('[data-role-member-row][data-user-id="user-1"]')).toBeNull()
    expect(memberButton('user-b').textContent).toBe('乙成员')
    expect(container?.textContent).toContain('共 7 人')
    expect(legacyRolePosts()).toEqual([])

    resetHarness()
    state.roleId = 'role-a'
    state.roleName = '角色甲'
    state.mutationsDisabled = true
    commitResult = { status: 200, body: {} }
    await mountPanel()
    await selectMember('user-1')
    expect(button('[data-role-member-add]').disabled).toBe(true)
    expect(container?.querySelector('[data-role-members-locked]')?.textContent).toBe('角色权限有未保存修改，成员变更已暂停。')
    button('[data-role-member-add]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await freeze()
    expect(authorizationPosts()).toEqual([])

    state.mutationsDisabled = false
    await freeze()
    button('[data-role-member-add]').click()
    await freeze()
    expect(container?.querySelector('[data-testid="admin-authorization-dialog"]')).not.toBeNull()
    const postsBeforeLeave = authorizationPosts().length
    state.actionsLocked = true
    await freeze()
    expect(container?.querySelector('[data-testid="admin-authorization-dialog"]')).toBeNull()
    expect(authorizationPosts()).toHaveLength(postsBeforeLeave)
    expect(authorizationPosts().map((call) => call.url)).toEqual([PREVIEW_PATH])

    state.actionsLocked = false
    state.roleId = 'admin'
    state.roleName = 'admin'
    await freeze()
    await selectMember('user-1')
    button('[data-role-member-remove]').click()
    await freeze()
    expect(byTestId('admin-authorization-dialog').textContent).toContain('取消平台管理员')
    expect(button('[data-testid="admin-authorization-confirm"]').disabled).toBe(true)
    button('[data-testid="admin-authorization-confirm"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await freeze()
    expect(authorizationPosts().filter((call) => call.url === COMMIT_PATH)).toEqual([])
  })

  it('checks only the role when the receipt has derived admission or scope cleanup', async () => {
    previewExtras = { derived: true, cleanup: true }
    accessRoles = ['role-a']
    await mountPanel()
    await selectMember('user-1')
    button('[data-role-member-add]').click()
    await freeze()
    expect(previewText()).toBe(previewLine('role-a', { derived: true, cleanup: true }))
    button('[data-testid="admin-authorization-confirm"]').click()
    await freeze()
    expect(phaseText()).toBe('已核对同一用户的角色成员状态。这里只核对了角色成员。派生准入和范围清理只记在回执里。')
    expect(phaseText()).not.toContain('准入未开')
    expect(accessGets()).toEqual([
      '/api/admin/users/user-1/access',
      '/api/admin/users/user-1/access',
    ])
  })

  it('reads the stored receipt with GET when the same member is selected again', async () => {
    commitResult = { status: 500, body: {} }
    await mountPanel()
    await selectMember('user-1')
    button('[data-role-member-add]').click()
    await freeze()
    button('[data-testid="admin-authorization-confirm"]').click()
    await freeze()
    expect(phaseText()).toBe('提交结果还不能确认。请重新读取。不会再次提交。')
    const operationId = authorizationPosts()[1]?.body?.clientOperationId
    expect(authorizationPosts().map((call) => call.url)).toEqual([PREVIEW_PATH, COMMIT_PATH])
    button('[data-testid="role-member-authorization-dismiss"]').click()
    await freeze()
    await selectMember('user-2')
    await selectMember('user-1')
    expect(operationGets()).toEqual([`${COMMIT_PATH}/${operationId}`])
    expect(authorizationPosts().map((call) => call.url)).toEqual([PREVIEW_PATH, COMMIT_PATH])
    expect(phaseText()).toBe('提交结果还不能确认。请重新读取。不会再次提交。')
  })
})
