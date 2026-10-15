import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import PermissionManagementView from '../src/views/PermissionManagementView.vue'
import {
  describePermissionTemplateApply,
  describePermissionWrite,
  describeSelectedPermissionHint,
  permissionUserPayloadUnavailable,
  readPermissionTemplateApplyAcknowledgement,
  readPermissionWriteAcknowledgement,
  readUserPermissionInspection,
} from '../src/views/adminPermissionGrantDisplay'

const apiFetchMock = vi.fn()

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

describe('adminPermissionGrantDisplay', () => {
  it('keeps a direct namespaced grant visible when effective readback is empty', () => {
    const inspection = readUserPermissionInspection({
      userId: 'user-1',
      permissions: [],
      isAdmin: false,
      direct: ['crm:read'],
      inherited: ['crm:write'],
      legacy: [],
      effective: [],
      blockedByNamespaceAdmission: ['crm:read', 'crm:write'],
    }, 'user-1')
    expect(inspection.hasSourceBreakdown).toBe(true)
    expect(inspection.direct).toEqual(['crm:read'])
    expect(inspection.effective).toEqual([])
    expect(inspection.blockedByNamespaceAdmission).toContain('crm:read')
  })

  it('does not relabel an old effective-only payload as direct grants', () => {
    const inspection = readUserPermissionInspection({
      userId: 'user-1',
      permissions: ['workflow:read'],
      isAdmin: false,
    }, 'user-1')
    expect(inspection.hasSourceBreakdown).toBe(false)
    expect(inspection.direct).toEqual([])
    expect(inspection.effective).toEqual(['workflow:read'])
  })

  it('explains a grant that persisted but is blocked by namespace admission', () => {
    const inspection = readUserPermissionInspection({
      userId: 'user-1',
      permissions: [],
      direct: ['crm:read'],
      inherited: [],
      legacy: [],
      effective: [],
      blockedByNamespaceAdmission: ['crm:read'],
    }, 'user-1')
    const outcome = describePermissionWrite({
      action: 'grant',
      requestedUserId: 'user-1',
      selectedUserId: 'user-1',
      permission: 'crm:read',
      ok: true,
      inspection,
    })
    expect(outcome.tone).toBe('info')
    expect(outcome.message).toContain('已写入用户 user-1 的直接授予 crm:read')
    expect(outcome.message).toContain('未自动开通准入')
    expect(describeSelectedPermissionHint('crm:read', inspection)).toContain('未生效')
  })

  it('does not treat inherited-only revoke 404 as a silent success', () => {
    const outcome = describePermissionWrite({
      action: 'revoke',
      requestedUserId: 'user-1',
      selectedUserId: 'user-1',
      permission: 'crm:admin',
      ok: false,
      httpStatus: 404,
      errorMessage: 'Permission not found for user',
    })
    expect(outcome.tone).toBe('error')
    expect(outcome.message).toContain('不是用户 user-1 的直接授予')
    expect(outcome.message).toContain('角色继承请到用户管理撤销角色')
  })

  it('does not treat a degraded inspection as verified empty grants', () => {
    const inspection = readUserPermissionInspection({
      userId: 'user-1',
      permissions: [],
      isAdmin: false,
      degraded: true,
      unavailable: true,
      direct: [],
      inherited: [],
      legacy: [],
      effective: [],
      blockedByNamespaceAdmission: [],
    }, 'user-1')
    expect(inspection.degraded).toBe(true)
    expect(inspection.hasSourceBreakdown).toBe(false)
    const outcome = describePermissionWrite({
      action: 'revoke',
      requestedUserId: 'user-1',
      selectedUserId: 'user-1',
      permission: 'workflow:read',
      ok: true,
      inspection,
    })
    expect(outcome.tone).toBe('error')
    expect(outcome.applyInspection).toBe(false)
    expect(outcome.message).toContain('权限来源暂时不可用')
    expect(describeSelectedPermissionHint('workflow:read', inspection)).toContain('权限来源暂时不可用')
  })

  it('does not treat unavailable fail-open arrays as proven grants or absence', () => {
    const inspection = readUserPermissionInspection({
      userId: 'user-1',
      permissions: ['crm:read', 'workflow:read'],
      isAdmin: false,
      unavailable: true,
      direct: ['crm:read'],
      inherited: ['crm:write'],
      legacy: [],
      effective: ['crm:read', 'workflow:read'],
      blockedByNamespaceAdmission: [],
    }, 'user-1')
    expect(inspection.degraded).toBe(true)
    expect(inspection.hasSourceBreakdown).toBe(false)
    expect(inspection.direct).toEqual([])
    expect(inspection.inherited).toEqual([])
    expect(inspection.effective).toEqual([])
    expect(inspection.permissions).toEqual([])
    expect(inspection.blockedByNamespaceAdmission).toEqual([])
    const outcome = describePermissionWrite({
      action: 'revoke',
      requestedUserId: 'user-1',
      selectedUserId: 'user-1',
      permission: 'crm:read',
      ok: true,
      inspection,
    })
    expect(outcome.applyInspection).toBe(false)
    expect(outcome.tone).toBe('error')
    expect(outcome.message).toContain('权限来源暂时不可用')
  })

  it('keeps an in-flight permission write off a later selected user', () => {
    const outcome = describePermissionWrite({
      action: 'grant',
      requestedUserId: 'user-1',
      selectedUserId: 'user-2',
      permission: 'workflow:read',
      ok: true,
      inspection: readUserPermissionInspection({
        userId: 'user-1',
        permissions: ['workflow:read'],
        direct: ['workflow:read'],
        inherited: [],
        legacy: [],
        effective: ['workflow:read'],
        blockedByNamespaceAdmission: [],
      }, 'user-1'),
    })
    expect(outcome.applyInspection).toBe(false)
    expect(outcome.message).toContain('未覆盖当前选中用户 user-2')
  })

  it('does not treat an old empty effective list as a verified grant', () => {
    const inspection = readUserPermissionInspection({
      userId: 'subject-a',
      permissions: [],
      isAdmin: false,
    }, 'subject-a')
    expect(inspection.hasSourceBreakdown).toBe(false)
    expect(inspection.sourceKnown).toBe(false)
    expect(inspection.effective).toEqual([])
    const outcome = describePermissionWrite({
      action: 'grant',
      requestedUserId: 'subject-a',
      selectedUserId: 'subject-a',
      permission: 'crm:read',
      ok: true,
      writeAcknowledged: true,
      inspection,
    })
    expect(outcome.tone).toBe('error')
    expect(outcome.message).not.toContain('且已出现在生效权限中')
    expect(outcome.message).toContain('不能当作已核对成功')
  })

  it('rejects invalid JSON, partial source arrays, and a mismatched subject', () => {
    const invalid = readUserPermissionInspection({}, 'subject-a')
    expect(invalid.degraded).toBe(true)
    expect(invalid.subjectMatched).toBe(false)
    expect(invalid.direct).toEqual([])
    const partial = readUserPermissionInspection({
      userId: 'subject-a',
      permissions: ['crm:read'],
      direct: ['crm:read'],
      isAdmin: false,
    }, 'subject-a')
    expect(partial.hasSourceBreakdown).toBe(false)
    expect(partial.sourceKnown).toBe(false)
    expect(partial.direct).toEqual([])
    expect(partial.effective).toEqual(['crm:read'])
    const wrongSubject = readUserPermissionInspection({
      userId: 'subject-b',
      permissions: ['crm:read'],
      direct: ['crm:read'],
      inherited: [],
      legacy: [],
      effective: ['crm:read'],
      blockedByNamespaceAdmission: [],
      isAdmin: false,
    }, 'subject-a')
    expect(wrongSubject.direct).toEqual([])
    expect(wrongSubject.effective).toEqual([])
    const outcome = describePermissionWrite({
      action: 'grant',
      requestedUserId: 'subject-a',
      selectedUserId: 'subject-a',
      permission: 'crm:read',
      ok: true,
      writeAcknowledged: true,
      inspection: wrongSubject,
    })
    expect(outcome.applyInspection).toBe(false)
    expect(outcome.tone).toBe('error')
    expect(outcome.message).not.toContain('且已出现在生效权限中')
  })

  it('rejects a degraded or incomplete write acknowledgement', () => {
    const degraded = readPermissionWriteAcknowledgement({ success: true, degraded: true }, 'subject-a', 'crm:read')
    expect(degraded.accepted).toBe(false)
    expect(degraded.degraded).toBe(true)
    const missing = readPermissionWriteAcknowledgement({ success: true, userId: 'subject-a' }, 'subject-a', 'crm:read')
    expect(missing.accepted).toBe(false)
    const wrongUser = readPermissionWriteAcknowledgement({
      success: true,
      userId: 'subject-b',
      permission: 'crm:read',
    }, 'subject-a', 'crm:read')
    expect(wrongUser.accepted).toBe(false)
    const accepted = readPermissionWriteAcknowledgement({
      success: true,
      userId: 'subject-a',
      permission: 'crm:read',
    }, 'subject-a', 'crm:read')
    expect(accepted.accepted).toBe(true)
    expect(permissionUserPayloadUnavailable({ degraded: true, permissions: [] })).toBe(true)
    expect(permissionUserPayloadUnavailable({ unavailable: true })).toBe(true)
    expect(permissionUserPayloadUnavailable({ permissions: [] })).toBe(false)
    const template = describePermissionTemplateApply({
      templateName: '现场模板',
      inspection: readUserPermissionInspection({
        userId: 'subject-a',
        degraded: true,
        unavailable: true,
        permissions: [],
        isAdmin: false,
      }, 'subject-a'),
    })
    expect(template.tone).toBe('error')
    expect(template.message).toContain('回读不可用')
    expect(template.message).not.toContain('补齐权限')

    const rejected = readPermissionTemplateApplyAcknowledgement({ ok: false }, 'subject-a', 'tpl-1')
    const empty = readPermissionTemplateApplyAcknowledgement({}, 'subject-a', 'tpl-1')
    const degradedAck = readPermissionTemplateApplyAcknowledgement({ ok: true, degraded: true }, 'subject-a', 'tpl-1')
    const acceptedAck = readPermissionTemplateApplyAcknowledgement({
      success: true,
      userId: 'subject-a',
      template: { id: 'tpl-1' },
      permissions: ['workflow:read'],
      isAdmin: false,
    }, 'subject-a', 'tpl-1')
    expect(rejected.accepted).toBe(false)
    expect(empty.accepted).toBe(false)
    expect(degradedAck.accepted).toBe(false)
    expect(degradedAck.degraded).toBe(true)
    expect(acceptedAck.accepted).toBe(true)
    for (const result of [rejected, empty, degradedAck]) {
      expect(result.message).not.toContain('补齐权限')
    }
  })
})

describe('PermissionManagementView grant readback', () => {
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
    app = createApp(PermissionManagementView)
    app.mount(container)
    return container
  }

  function createPermissionApi(options: {
    delayGrant?: Promise<void>
    holdUserAccess?: boolean
    failUserAccessIds?: string[]
    failUserAccessAfter?: number
    degradeReadbackAfterWrite?: boolean
    failReadbackAfterWrite?: boolean
    invalidJsonReadbackAfterWrite?: boolean
    wrongSubjectReadbackAfterWrite?: boolean
    degradedAck?: boolean
    oldEffective?: boolean
    withTemplate?: boolean
    holdCatalogOnRefresh?: Promise<void>
    failCatalogOnRefresh?: boolean
    templateAck?: 'ok-false' | 'degraded' | 'invalid-json'
    legacyEffectiveReadbackAfterWrite?: boolean
  } = {}) {
    const state: Record<string, {
      direct: string[]
      inherited: string[]
      effective: string[]
      blocked: string[]
    }> = {
      'user-1': { direct: [], inherited: ['crm:admin'], effective: [], blocked: ['crm:admin'] },
      'user-2': { direct: ['workflow:read'], inherited: [], effective: ['workflow:read'], blocked: [] },
    }
    const calls: string[] = []
    const pendingAccess: Array<{ userId: string; release: () => void }> = []
    const stats = { userAccessReads: 0 }
    let permissionCatalogReads = 0
    let degradeNextAccess = false
    let failNextAccess = false
    let invalidJsonNextAccess = false
    let wrongSubjectNextAccess = false
    let legacyEffectiveNextAccess = false

    const userPayload = (userId: string) => {
      const grants = state[userId]
      return {
        userId,
        permissions: grants.effective,
        isAdmin: false,
        direct: grants.direct,
        inherited: grants.inherited,
        legacy: [],
        effective: grants.effective,
        blockedByNamespaceAdmission: grants.blocked,
      }
    }

    apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const rawUrl = String(input)
      const url = new URL(rawUrl, 'http://localhost')
      const pathname = url.pathname
      const method = (init?.method || 'GET').toUpperCase()
      calls.push(`${method} ${pathname}`)

      if (pathname === '/api/admin/users') {
        return createJsonResponse({
          ok: true,
          data: {
            items: [
              { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
              { id: 'user-2', email: 'bravo@example.com', name: 'Bravo', role: 'user', is_active: true },
            ],
          },
        })
      }
      if (pathname === '/api/permissions') {
        permissionCatalogReads += 1
        if (permissionCatalogReads > 1 && options.holdCatalogOnRefresh) await options.holdCatalogOnRefresh
        if (permissionCatalogReads > 1 && options.failCatalogOnRefresh) {
          return createJsonResponse({ error: '加载权限目录失败' }, 500)
        }
        return createJsonResponse({
          data: [
            { code: 'crm:read', name: 'CRM 读取', description: null },
            { code: 'crm:admin', name: 'CRM 管理', description: null },
            { code: 'workflow:read', name: '流程读取', description: null },
          ],
        })
      }
      if (pathname.startsWith('/api/admin/permission-templates') && method === 'GET') {
        if (!options.withTemplate) return createJsonResponse({ data: [] })
        return createJsonResponse({
          data: [{
            id: 'tpl-1',
            name: '现场模板',
            description: '补齐现场权限',
            productMode: 'platform',
            permissions: ['workflow:read'],
            presetId: null,
            roleId: null,
          }],
        })
      }
      if (pathname === '/api/admin/permission-templates/apply' && method === 'POST') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { userId?: string; templateId?: string } : {}
        if (options.templateAck === 'ok-false') return createJsonResponse({ ok: false })
        if (options.templateAck === 'degraded') return createJsonResponse({ ok: true, degraded: true })
        if (options.templateAck === 'invalid-json') {
          return {
            ok: true,
            status: 200,
            json: async () => { throw new Error('bad json') },
          }
        }
        if (options.degradeReadbackAfterWrite) degradeNextAccess = true
        if (options.invalidJsonReadbackAfterWrite) invalidJsonNextAccess = true
        if (options.wrongSubjectReadbackAfterWrite) wrongSubjectNextAccess = true
        if (options.legacyEffectiveReadbackAfterWrite) legacyEffectiveNextAccess = true
        return createJsonResponse({
          success: true,
          userId: body.userId,
          template: { id: body.templateId },
          permissions: ['workflow:read'],
          isAdmin: false,
        })
      }
      const userMatch = pathname.match(/^\/api\/permissions\/user\/([^/]+)$/)
      if (userMatch) {
        const userId = decodeURIComponent(userMatch[1])
        stats.userAccessReads += 1
        const captured = options.oldEffective
          ? { userId, permissions: [] as string[], isAdmin: false }
          : userPayload(userId)
        if (options.holdUserAccess) {
          await new Promise<void>((resolve) => {
            pendingAccess.push({ userId, release: resolve })
          })
        }
        if (invalidJsonNextAccess) {
          invalidJsonNextAccess = false
          return {
            ok: true,
            status: 200,
            json: async () => { throw new Error('bad json') },
          }
        }
        if (degradeNextAccess) {
          degradeNextAccess = false
          return createJsonResponse({
            userId,
            permissions: [],
            isAdmin: false,
            degraded: true,
            unavailable: true,
            direct: [],
            inherited: [],
            legacy: [],
            effective: [],
            blockedByNamespaceAdmission: [],
          })
        }
        if (failNextAccess || (options.failUserAccessAfter != null && stats.userAccessReads > options.failUserAccessAfter) || options.failUserAccessIds?.includes(userId)) {
          failNextAccess = false
          return createJsonResponse({ error: '加载用户权限失败' }, 500)
        }
        if (wrongSubjectNextAccess) {
          wrongSubjectNextAccess = false
          return createJsonResponse({ ...captured, userId: 'someone-else' })
        }
        if (legacyEffectiveNextAccess) {
          legacyEffectiveNextAccess = false
          return createJsonResponse({ userId, permissions: ['workflow:read'], isAdmin: false })
        }
        return createJsonResponse(captured)
      }

      if (pathname === '/api/permissions/grant' && method === 'POST') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { userId?: string; permission?: string } : {}
        const userId = String(body.userId || '')
        const permission = String(body.permission || '')
        if (options.delayGrant) await options.delayGrant
        const grants = state[userId]
        if (!grants.direct.includes(permission)) grants.direct.push(permission)
        if (permission.startsWith('crm:')) {
          grants.blocked = Array.from(new Set([...grants.blocked, permission]))
          grants.effective = grants.effective.filter((code) => code !== permission)
        } else if (!grants.effective.includes(permission)) {
          grants.effective.push(permission)
        }
        if (options.degradedAck) return createJsonResponse({ success: true, degraded: true })
        if (options.degradeReadbackAfterWrite) degradeNextAccess = true
        if (options.failReadbackAfterWrite) failNextAccess = true
        if (options.invalidJsonReadbackAfterWrite) invalidJsonNextAccess = true
        if (options.wrongSubjectReadbackAfterWrite) wrongSubjectNextAccess = true
        return createJsonResponse({ success: true, userId, permission })
      }

      if (pathname === '/api/permissions/revoke' && method === 'POST') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { userId?: string; permission?: string } : {}
        const userId = String(body.userId || '')
        const permission = String(body.permission || '')
        const grants = state[userId]
        if (!grants.direct.includes(permission)) {
          return createJsonResponse({ error: 'Permission not found for user' }, 404)
        }
        grants.direct = grants.direct.filter((code) => code !== permission)
        grants.blocked = grants.blocked.filter((code) => code !== permission)
        grants.effective = grants.effective.filter((code) => code !== permission)
        if (options.degradedAck) return createJsonResponse({ success: true, degraded: true })
        if (options.degradeReadbackAfterWrite) degradeNextAccess = true
        if (options.failReadbackAfterWrite) failNextAccess = true
        if (options.invalidJsonReadbackAfterWrite) invalidJsonNextAccess = true
        if (options.wrongSubjectReadbackAfterWrite) wrongSubjectNextAccess = true
        return createJsonResponse({ success: true, userId, permission })
      }

      throw new Error(`Unhandled apiFetch call: ${method} ${rawUrl}`)
    })

    return {
      state,
      calls,
      stats,
      pendingAccess,
      releaseOldestAccess() {
        pendingAccess.shift()?.release()
      },
    }
  }

  it('keeps a direct namespaced grant visible after readback even when admission blocks effective permission', async () => {
    const api = createPermissionApi()
    const root = mountView()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="permission-select"]')))

    expect(root.querySelector('[data-testid="permission-direct-section"]')?.textContent).toContain('暂无直接授予')
    expect(root.querySelector('[data-testid="permission-inherited-section"]')?.textContent).toContain('crm:admin')
    expect(root.querySelector('[data-testid="permission-blocked-section"]')?.textContent).toContain('crm:admin')
    expect(root.querySelector('[data-testid="permission-effective-section"]')?.textContent).toContain('暂无生效权限')

    const select = root.querySelector('[data-testid="permission-select"]') as HTMLSelectElement
    select.value = 'crm:read'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    ;(root.querySelector('[data-testid="grant-permission-button"]') as HTMLButtonElement).click()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="permission-action-feedback"]')?.textContent?.includes('直接授予 crm:read')))

    expect(root.querySelector('[data-testid="permission-direct-section"]')?.textContent).toContain('crm:read')
    expect(root.querySelector('[data-testid="permission-blocked-section"]')?.textContent).toContain('crm:read')
    expect(root.querySelector('[data-testid="permission-effective-section"]')?.textContent).not.toContain('crm:read')
    expect(root.querySelector('[data-testid="permission-action-feedback"]')?.textContent).toContain('未自动开通准入')
    expect(api.calls.some((call) => call.includes('/namespaces/') || call.includes('admission'))).toBe(false)
  })

  it('refuses inherited-only revoke and does not apply a grant to a later selected user', async () => {
    let release: (() => void) | undefined
    const delayGrant = new Promise<void>((resolve) => { release = resolve })
    const api = createPermissionApi({ delayGrant })
    const root = mountView()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="permission-select"]')))

    const select = root.querySelector('[data-testid="permission-select"]') as HTMLSelectElement
    select.value = 'crm:admin'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    ;(root.querySelector('[data-testid="revoke-permission-button"]') as HTMLButtonElement).click()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="permission-action-feedback"]')?.textContent?.includes('不是用户 user-1 的直接授予')))

    select.value = 'crm:read'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    ;(root.querySelector('[data-testid="grant-permission-button"]') as HTMLButtonElement).click()
    await flushUi(4)

    const otherUser = Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes('Bravo'))
    otherUser?.click()
    await waitForCondition(() => (root.querySelector('[data-testid="permission-effective-section"]')?.textContent || '').includes('workflow:read'))

    release?.()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="permission-action-feedback"]')?.textContent?.includes('user-1')))
    expect(root.querySelector('[data-testid="permission-action-feedback"]')?.textContent).toContain('未覆盖当前选中用户 user-2')
    expect(root.querySelector('[data-testid="permission-effective-section"]')?.textContent).toContain('workflow:read')
    expect(root.querySelector('[data-testid="permission-direct-section"]')?.textContent).not.toContain('crm:read')
    expect(api.state['user-1'].direct).toContain('crm:read')
  })

  it('shows unavailable inspection instead of healthy empty grants', async () => {
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const pathname = new URL(String(input), 'http://localhost').pathname
      if (pathname === '/api/admin/users') {
        return createJsonResponse({
          ok: true,
          data: {
            items: [
              { id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true },
            ],
          },
        })
      }
      if (pathname === '/api/permissions') return createJsonResponse({ data: [] })
      if (pathname.startsWith('/api/admin/permission-templates')) return createJsonResponse({ data: [] })
      if (pathname.startsWith('/api/permissions/user/')) {
        return createJsonResponse({
          userId: 'user-1',
          permissions: [],
          isAdmin: false,
          degraded: true,
          unavailable: true,
          direct: [],
          inherited: [],
          legacy: [],
          effective: [],
          blockedByNamespaceAdmission: [],
        })
      }
      throw new Error(`Unhandled apiFetch call: ${pathname}`)
    })

    const root = mountView()
    await waitForCondition(() => Boolean(root.querySelector('[data-testid="permission-inspection-unavailable"]')))
    expect(root.querySelector('[data-testid="permission-direct-section"]')?.textContent).not.toContain('暂无直接授予')
    expect(root.querySelector('[data-testid="permission-inherited-section"]')?.textContent).not.toContain('暂无角色继承权限')
    expect(root.querySelector('[data-testid="permission-effective-section"]')?.textContent).not.toContain('暂无生效权限')
    expect(root.querySelector('[data-testid="permission-direct-section"]')?.textContent).toContain('未读')
    expect(root.querySelector('[data-testid="permission-direct-section"]')?.textContent).not.toContain('0 项')
    expect(root.querySelector('[data-testid="permission-inherited-section"]')?.textContent).not.toContain('0 项')
    expect(root.querySelector('[data-testid="permission-effective-section"]')?.textContent).not.toContain('0 项')
    expect(root.textContent).toContain('身份未读')
    expect(root.textContent).not.toContain('普通用户')
  })

  async function selectPermission(root: HTMLElement, code: string): Promise<void> {
    const select = root.querySelector('[data-testid="permission-select"]') as HTMLSelectElement
    select.value = code
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
  }

  function clickNamedUser(root: HTMLElement, name: string): void {
    const button = Array.from(root.querySelectorAll('button')).find((item) => item.textContent?.includes(name))
    button?.click()
  }

  async function applyNamedTemplate(root: HTMLElement): Promise<void> {
    const applyButton = root.querySelector('[data-testid="apply-permission-template-button"]') as HTMLButtonElement
    const templateSelect = Array.from(root.querySelectorAll('select')).find((select) => select.innerHTML.includes('现场模板')) as HTMLSelectElement
    templateSelect.value = 'tpl-1'
    templateSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(applyButton.disabled).toBe(false)
    applyButton.click()
  }

  it('marks a healthy inspection unread after a degraded or failed write readback', async () => {
    const degraded = createPermissionApi({ degradeReadbackAfterWrite: true })
    const degradedRoot = mountView()
    await waitForCondition(() => (degradedRoot.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').includes('crm:admin'))
    clickNamedUser(degradedRoot, 'Bravo')
    await waitForCondition(() => (degradedRoot.querySelector('[data-testid="permission-direct-section"]')?.textContent || '').includes('workflow:read'))
    await selectPermission(degradedRoot, 'workflow:read')
    ;(degradedRoot.querySelector('[data-testid="revoke-permission-button"]') as HTMLButtonElement).click()
    await waitForCondition(() => Boolean(degradedRoot.querySelector('[data-testid="permission-inspection-unavailable"]')))
    expect(degradedRoot.querySelector('[data-testid="permission-direct-section"]')?.textContent).not.toContain('workflow:read')
    expect(degradedRoot.querySelector('[data-testid="permission-direct-section"]')?.textContent).toContain('未读')
    expect(degradedRoot.querySelector('[data-testid="permission-action-feedback"]')?.textContent).toContain('权限来源暂时不可用')
    expect(degradedRoot.querySelector('[data-testid="permission-action-feedback"]')?.textContent).not.toContain('生效权限不再包含它')
    expect(degraded.state['user-2'].direct).not.toContain('workflow:read')
    app?.unmount()
    container?.remove()
    app = null
    container = null
    apiFetchMock.mockReset()

    const failed = createPermissionApi({ failReadbackAfterWrite: true })
    const failedRoot = mountView()
    await waitForCondition(() => (failedRoot.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').includes('crm:admin'))
    clickNamedUser(failedRoot, 'Bravo')
    await waitForCondition(() => (failedRoot.querySelector('[data-testid="permission-direct-section"]')?.textContent || '').includes('workflow:read'))
    await selectPermission(failedRoot, 'workflow:read')
    ;(failedRoot.querySelector('[data-testid="revoke-permission-button"]') as HTMLButtonElement).click()
    await waitForCondition(() => Boolean(failedRoot.querySelector('[data-testid="permission-inspection-unavailable"]')))
    expect(failedRoot.querySelector('[data-testid="permission-direct-section"]')?.textContent).not.toContain('workflow:read')
    expect(failedRoot.querySelector('[data-testid="permission-direct-section"]')?.textContent).toContain('未读')
    expect(failedRoot.textContent).not.toContain('普通用户')
  })

  it('marks refresh and selection failures unread instead of keeping the previous grants or an empty list', async () => {
    const refreshed = createPermissionApi({ failUserAccessAfter: 1 })
    const refreshedRoot = mountView()
    await waitForCondition(() => (refreshedRoot.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').includes('crm:admin'))
    const refresh = Array.from(refreshedRoot.querySelectorAll('button')).find((button) => button.textContent?.includes('刷新'))
    refresh?.click()
    await waitForCondition(() => Boolean(refreshedRoot.querySelector('[data-testid="permission-inspection-unavailable"]')))
    expect(refreshedRoot.querySelector('[data-testid="permission-inherited-section"]')?.textContent).not.toContain('crm:admin')
    expect(refreshedRoot.querySelector('[data-testid="permission-inherited-section"]')?.textContent).toContain('未读')
    expect(refreshedRoot.querySelector('[data-testid="permission-direct-section"]')?.textContent).not.toContain('暂无直接授予')
    expect(refreshedRoot.textContent).not.toContain('普通用户')
    app?.unmount()
    container?.remove()
    app = null
    container = null
    apiFetchMock.mockReset()

    createPermissionApi({ failUserAccessIds: ['user-2'] })
    const selectedRoot = mountView()
    await waitForCondition(() => (selectedRoot.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').includes('crm:admin'))
    clickNamedUser(selectedRoot, 'Bravo')
    await waitForCondition(() => Boolean(selectedRoot.querySelector('[data-testid="permission-inspection-unavailable"]')))
    expect(selectedRoot.querySelector('[data-testid="permission-inherited-section"]')?.textContent).not.toContain('crm:admin')
    expect(selectedRoot.querySelector('[data-testid="permission-direct-section"]')?.textContent).not.toContain('暂无直接授予')
    expect(selectedRoot.querySelector('[data-testid="permission-effective-section"]')?.textContent).not.toContain('暂无生效权限')
    expect(selectedRoot.querySelector('[data-testid="permission-effective-section"]')?.textContent).not.toContain('0 项')
    expect(selectedRoot.textContent).toContain('身份未读')
    expect(selectedRoot.textContent).not.toContain('普通用户')
  })

  it('keeps an overlapping A to B to A access read on the current generation', async () => {
    const api = createPermissionApi({ holdUserAccess: true })
    const root = mountView()
    await waitForCondition(() => api.pendingAccess.length >= 1)
    api.state['user-1'].inherited = []
    clickNamedUser(root, 'Bravo')
    await waitForCondition(() => api.pendingAccess.some((item) => item.userId === 'user-2'))
    clickNamedUser(root, 'Alpha')
    await waitForCondition(() => api.pendingAccess.filter((item) => item.userId === 'user-1').length >= 2)

    api.releaseOldestAccess()
    await flushUi()
    expect(root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').not.toContain('crm:admin')
    expect(root.querySelector('[data-testid="permission-inspection-unavailable"]')).toBeTruthy()

    const bravo = api.pendingAccess.findIndex((item) => item.userId === 'user-2')
    expect(bravo).toBeGreaterThanOrEqual(0)
    api.pendingAccess.splice(bravo, 1)[0]?.release()
    await flushUi()
    expect(root.querySelector('[data-testid="permission-direct-section"]')?.textContent || '').not.toContain('workflow:read')
    expect(root.textContent).not.toContain('普通用户')

    api.releaseOldestAccess()
    await waitForCondition(() => {
      const inherited = root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || ''
      return inherited.includes('暂无角色继承权限') && !root.querySelector('[data-testid="permission-inspection-unavailable"]')
    })
    expect(root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').not.toContain('crm:admin')
    expect(Array.from(root.querySelectorAll('h2')).some((heading) => heading.textContent?.includes('Alpha'))).toBe(true)
  })

  it('does not call an old empty effective readback or a degraded acknowledgement a verified grant', async () => {
    const oldRootApi = createPermissionApi({ oldEffective: true })
    const oldRoot = mountView()
    await waitForCondition(() => (oldRoot.querySelector('[data-testid="permission-direct-section"]')?.textContent || '').includes('未知'))
    expect(oldRoot.querySelector('[data-testid="permission-direct-section"]')?.textContent).not.toContain('暂无直接授予')
    expect(oldRoot.querySelector('[data-testid="permission-inherited-section"]')?.textContent).toContain('未知')
    expect(oldRoot.querySelector('[data-testid="permission-inherited-section"]')?.textContent).not.toContain('暂无角色继承权限')
    await selectPermission(oldRoot, 'crm:read')
    ;(oldRoot.querySelector('[data-testid="grant-permission-button"]') as HTMLButtonElement).click()
    await waitForCondition(() => Boolean(oldRoot.querySelector('[data-testid="permission-action-feedback"]')))
    expect(oldRoot.querySelector('[data-testid="permission-action-feedback"]')?.textContent).not.toContain('且已出现在生效权限中')
    expect(oldRoot.querySelector('[data-testid="permission-action-feedback"]')?.textContent).toContain('不能当作已核对成功')
    expect(oldRootApi.state['user-1'].direct).toContain('crm:read')
    app?.unmount()
    container?.remove()
    app = null
    container = null
    apiFetchMock.mockReset()

    createPermissionApi({ degradedAck: true })
    const ackRoot = mountView()
    await waitForCondition(() => (ackRoot.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').includes('crm:admin'))
    clickNamedUser(ackRoot, 'Bravo')
    await waitForCondition(() => (ackRoot.querySelector('[data-testid="permission-direct-section"]')?.textContent || '').includes('workflow:read'))
    await selectPermission(ackRoot, 'workflow:read')
    ;(ackRoot.querySelector('[data-testid="revoke-permission-button"]') as HTMLButtonElement).click()
    await waitForCondition(() => Boolean(ackRoot.querySelector('[data-testid="permission-inspection-unavailable"]')))
    expect(ackRoot.querySelector('[data-testid="permission-direct-section"]')?.textContent).not.toContain('workflow:read')
    expect(ackRoot.querySelector('[data-testid="permission-action-feedback"]')?.textContent).toContain('降级')
    expect(ackRoot.querySelector('[data-testid="permission-action-feedback"]')?.textContent).not.toContain('生效权限不再包含它')
  })

  it('reads template apply back from the apply button for source, legacy, degraded, invalid, and foreign payloads', async () => {
    const completion = '已按模板 现场模板 补齐权限'
    const legacyStatus = '模板已提交，但权限来源回读不完整，不能把当前列表当作已按模板 现场模板 补齐'
    const unavailableStatus = '模板已提交，但权限回读不可用，不能把当前列表当作已按模板 现场模板 补齐'

    async function readTemplate(options: {
      degradeReadbackAfterWrite?: boolean
      invalidJsonReadbackAfterWrite?: boolean
      wrongSubjectReadbackAfterWrite?: boolean
      legacyEffectiveReadbackAfterWrite?: boolean
    }, statusText: string): Promise<HTMLDivElement> {
      if (app) app.unmount()
      if (container) container.remove()
      app = null
      container = null
      apiFetchMock.mockReset()
      const api = createPermissionApi({ withTemplate: true, ...options })
      const root = mountView()
      await waitForCondition(() => (root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').includes('crm:admin'))
      await selectPermission(root, 'crm:read')
      expect((root.querySelector('[data-testid="grant-permission-button"]') as HTMLButtonElement).disabled).toBe(false)
      const getsBefore = api.calls.filter((call) => call === 'GET /api/permissions/user/user-1').length
      expect(root.querySelector('[data-testid="apply-permission-template-button"]')).toBeTruthy()
      await applyNamedTemplate(root)
      await waitForCondition(() => (root.querySelector('.permission-admin__status')?.textContent || '').trim() === statusText)
      expect(api.calls.filter((call) => call === 'POST /api/admin/permission-templates/apply')).toEqual(['POST /api/admin/permission-templates/apply'])
      expect(api.calls.filter((call) => call === 'GET /api/permissions/user/user-1').length).toBe(getsBefore + 1)
      expect(api.calls.filter((call) => call === 'GET /api/permissions/user/user-2')).toEqual([])
      expect(api.calls.some((call) => call === 'POST /api/permissions/grant' || call === 'POST /api/permissions/revoke')).toBe(false)
      expect(root.querySelector('[data-testid="permission-action-feedback"]')).toBeNull()
      return root
    }

    function section(root: HTMLElement, testId: string): string {
      return root.querySelector(`[data-testid="${testId}"]`)?.textContent || ''
    }

    const healthy = await readTemplate({}, completion)
    expect(healthy.querySelector('.permission-admin__status')?.textContent?.trim()).toBe(completion)
    expect(healthy.querySelector('[data-testid="permission-inspection-unavailable"]')).toBeNull()
    expect(section(healthy, 'permission-direct-section')).toContain('暂无直接授予')
    expect(section(healthy, 'permission-direct-section')).toContain('0 项')
    expect(section(healthy, 'permission-direct-section')).not.toContain('未读')
    expect(section(healthy, 'permission-direct-section')).not.toContain('未知')
    expect(section(healthy, 'permission-inherited-section')).toContain('crm:admin')
    expect(section(healthy, 'permission-inherited-section')).toContain('1 项')
    expect(section(healthy, 'permission-inherited-section')).not.toContain('未读')
    expect(section(healthy, 'permission-effective-section')).toContain('暂无生效权限')
    expect(section(healthy, 'permission-blocked-section')).toContain('crm:admin')
    expect(healthy.textContent).toContain('普通用户')
    expect(healthy.textContent).not.toContain('身份未读')
    expect((healthy.querySelector('[data-testid="grant-permission-button"]') as HTMLButtonElement).disabled).toBe(false)
    expect((healthy.querySelector('[data-testid="apply-permission-template-button"]') as HTMLButtonElement).disabled).toBe(false)

    const legacy = await readTemplate({ legacyEffectiveReadbackAfterWrite: true }, legacyStatus)
    expect(legacy.querySelector('.permission-admin__status')?.textContent?.trim()).toBe(legacyStatus)
    expect(legacy.querySelector('.permission-admin__status')?.textContent?.trim()).not.toContain('补齐权限')
    expect(legacy.querySelector('[data-testid="permission-inspection-unavailable"]')).toBeNull()
    expect(section(legacy, 'permission-direct-section')).toContain('未知')
    expect(section(legacy, 'permission-direct-section')).not.toContain('未读')
    expect(section(legacy, 'permission-direct-section')).not.toContain('暂无直接授予')
    expect(section(legacy, 'permission-direct-section')).not.toContain('0 项')
    expect(section(legacy, 'permission-direct-section')).not.toContain('crm:admin')
    expect(section(legacy, 'permission-inherited-section')).toContain('未知')
    expect(section(legacy, 'permission-inherited-section')).not.toContain('crm:admin')
    expect(section(legacy, 'permission-inherited-section')).not.toContain('暂无角色继承权限')
    expect(section(legacy, 'permission-effective-section')).toContain('workflow:read')
    expect(section(legacy, 'permission-effective-section')).toContain('1 项')
    expect(section(legacy, 'permission-effective-section')).not.toContain('未知')
    expect(section(legacy, 'permission-effective-section')).not.toContain('未读')
    expect(section(legacy, 'permission-effective-section')).not.toContain('暂无生效权限')
    expect(legacy.querySelector('[data-testid="permission-blocked-section"]')).toBeNull()
    expect(legacy.textContent).toContain('普通用户')
    expect(legacy.textContent).not.toContain('身份未读')
    expect((legacy.querySelector('[data-testid="grant-permission-button"]') as HTMLButtonElement).disabled).toBe(false)
    expect((legacy.querySelector('[data-testid="apply-permission-template-button"]') as HTMLButtonElement).disabled).toBe(false)

    for (const options of [
      { degradeReadbackAfterWrite: true },
      { invalidJsonReadbackAfterWrite: true },
      { wrongSubjectReadbackAfterWrite: true },
    ]) {
      const root = await readTemplate(options, unavailableStatus)
      expect(root.querySelector('.permission-admin__status')?.textContent?.trim()).toBe(unavailableStatus)
      expect(root.querySelector('.permission-admin__status')?.textContent?.trim()).not.toContain('补齐权限')
      expect(root.querySelector('[data-testid="permission-inspection-unavailable"]')).toBeTruthy()
      expect(section(root, 'permission-direct-section')).toContain('未读')
      expect(section(root, 'permission-direct-section')).not.toContain('暂无直接授予')
      expect(section(root, 'permission-direct-section')).not.toContain('0 项')
      expect(section(root, 'permission-direct-section')).not.toContain('crm:read')
      expect(section(root, 'permission-direct-section')).not.toContain('crm:admin')
      expect(section(root, 'permission-inherited-section')).toContain('未读')
      expect(section(root, 'permission-inherited-section')).not.toContain('crm:admin')
      expect(section(root, 'permission-effective-section')).toContain('未读')
      expect(section(root, 'permission-effective-section')).not.toContain('workflow:read')
      expect(section(root, 'permission-effective-section')).not.toContain('暂无生效权限')
      expect(root.querySelector('[data-testid="permission-blocked-section"]')).toBeNull()
      expect(root.textContent).toContain('身份未读')
      expect(root.textContent).not.toContain('普通用户')
      expect((root.querySelector('[data-testid="grant-permission-button"]') as HTMLButtonElement).disabled).toBe(true)
      expect((root.querySelector('[data-testid="apply-permission-template-button"]') as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('does not let a stale degraded acknowledgement clear a newer A to B to A inspection', async () => {
    let release: (() => void) | undefined
    const delayGrant = new Promise<void>((resolve) => { release = resolve })
    const api = createPermissionApi({ delayGrant, degradedAck: true })
    const root = mountView()
    await waitForCondition(() => (root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').includes('crm:admin'))
    await selectPermission(root, 'crm:read')
    ;(root.querySelector('[data-testid="grant-permission-button"]') as HTMLButtonElement).click()
    await waitForCondition(() => api.calls.some((call) => call.includes('POST /api/permissions/grant')))

    clickNamedUser(root, 'Bravo')
    await waitForCondition(() => (root.querySelector('[data-testid="permission-direct-section"]')?.textContent || '').includes('workflow:read'))
    clickNamedUser(root, 'Alpha')
    await waitForCondition(() => {
      const inherited = root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || ''
      return inherited.includes('crm:admin') && !root.querySelector('[data-testid="permission-inspection-unavailable"]')
    })

    release?.()
    await flushUi()
    expect(root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').toContain('crm:admin')
    expect(root.querySelector('[data-testid="permission-inspection-unavailable"]')).toBeNull()
    expect(root.querySelector('[data-testid="permission-direct-section"]')?.textContent || '').not.toContain('未读')
  })

  it('marks the selected inspection unread when refresh fails before the access read', async () => {
    let releaseCatalog: (() => void) | undefined
    const holdCatalogOnRefresh = new Promise<void>((resolve) => { releaseCatalog = resolve })
    const api = createPermissionApi({ holdCatalogOnRefresh, failCatalogOnRefresh: true })
    const root = mountView()
    await waitForCondition(() => (root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').includes('crm:admin'))
    await selectPermission(root, 'crm:read')
    const grant = root.querySelector('[data-testid="grant-permission-button"]') as HTMLButtonElement
    expect(grant.disabled).toBe(false)
    const readsBeforeRefresh = api.stats.userAccessReads

    const refresh = Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes('刷新'))
    refresh?.click()
    await flushUi()
    expect(root.querySelector('[data-testid="permission-inspection-unavailable"]')).toBeTruthy()
    expect(root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').not.toContain('crm:admin')
    expect(root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').toContain('未读')
    expect(grant.disabled).toBe(true)
    expect(api.stats.userAccessReads).toBe(readsBeforeRefresh)

    releaseCatalog?.()
    await flushUi()
    expect(root.querySelector('.permission-admin__status')?.textContent || '').toContain('加载权限目录失败')
    expect(root.querySelector('[data-testid="permission-inspection-unavailable"]')).toBeTruthy()
    expect(root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').not.toContain('crm:admin')
    expect(grant.disabled).toBe(true)
    expect(api.stats.userAccessReads).toBe(readsBeforeRefresh)
  })

  it('does not let a delayed catalog failure clear a newer A to B to A inspection', async () => {
    let releaseCatalog: (() => void) | undefined
    const holdCatalogOnRefresh = new Promise<void>((resolve) => { releaseCatalog = resolve })
    const api = createPermissionApi({ holdCatalogOnRefresh, failCatalogOnRefresh: true })
    const root = mountView()
    await waitForCondition(() => (root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').includes('crm:admin'))
    expect(root.textContent).toContain('普通用户')
    await selectPermission(root, 'crm:read')
    const userLists = () => api.calls.filter((call) => call === 'GET /api/admin/users').length
    const listsBeforeRefresh = userLists()

    const refresh = Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes('刷新'))
    refresh?.click()
    await waitForCondition(() => (
      userLists() > listsBeforeRefresh
      && Boolean(root.querySelector('[data-testid="permission-inspection-unavailable"]'))
    ))
    expect(root.querySelector('.permission-admin__status')?.textContent || '').not.toContain('加载权限目录失败')
    expect((root.querySelector('[data-testid="grant-permission-button"]') as HTMLButtonElement).disabled).toBe(true)
    const bravo = Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes('Bravo')) as HTMLButtonElement
    expect(bravo.disabled).toBe(false)
    bravo.click()
    await waitForCondition(() => (root.querySelector('[data-testid="permission-direct-section"]')?.textContent || '').includes('workflow:read'))
    expect(root.querySelector('[data-testid="permission-inspection-unavailable"]')).toBeNull()

    clickNamedUser(root, 'Alpha')
    await waitForCondition(() => {
      const inherited = root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || ''
      return inherited.includes('crm:admin') && !root.querySelector('[data-testid="permission-inspection-unavailable"]')
    })
    expect(root.textContent).toContain('普通用户')
    await selectPermission(root, 'crm:read')
    expect((root.querySelector('[data-testid="grant-permission-button"]') as HTMLButtonElement).disabled).toBe(false)
    const readsAfterReselect = api.stats.userAccessReads

    releaseCatalog?.()
    await waitForCondition(() => (root.querySelector('.permission-admin__status')?.textContent || '').includes('加载权限目录失败'))
    expect(root.querySelector('[data-testid="permission-inspection-unavailable"]')).toBeNull()
    expect(root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').toContain('crm:admin')
    expect(root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').not.toContain('未读')
    expect(root.querySelector('[data-testid="permission-direct-section"]')?.textContent || '').toContain('暂无直接授予')
    expect(root.querySelector('[data-testid="permission-direct-section"]')?.textContent || '').not.toContain('未读')
    expect(root.querySelector('[data-testid="permission-direct-section"]')?.textContent || '').not.toContain('workflow:read')
    expect(root.textContent).toContain('普通用户')
    expect(root.textContent).not.toContain('身份未读')
    expect(Array.from(root.querySelectorAll('h2')).some((heading) => heading.textContent?.includes('Alpha'))).toBe(true)
    expect((root.querySelector('[data-testid="grant-permission-button"]') as HTMLButtonElement).disabled).toBe(false)
    expect(api.stats.userAccessReads).toBe(readsAfterReselect)
  })

  it('does not announce template completion for a rejected, empty, or degraded acknowledgement', async () => {
    for (const templateAck of ['ok-false', 'invalid-json', 'degraded'] as const) {
      const api = createPermissionApi({ withTemplate: true, templateAck })
      const root = mountView()
      await waitForCondition(() => (root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').includes('crm:admin'))
      const readsBeforeApply = api.stats.userAccessReads
      await applyNamedTemplate(root)
      await waitForCondition(() => (root.querySelector('.permission-admin__status')?.textContent || '').includes('模板写入回执'))
      const status = root.querySelector('.permission-admin__status')?.textContent || ''
      expect(status).not.toContain('补齐权限')
      expect(status).not.toContain('已按模板')
      expect(root.querySelector('[data-testid="permission-inspection-unavailable"]')).toBeTruthy()
      expect(root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').not.toContain('crm:admin')
      expect((root.querySelector('[data-testid="apply-permission-template-button"]') as HTMLButtonElement).disabled).toBe(true)
      expect(api.calls.some((call) => call.includes('/api/admin/permission-templates/apply'))).toBe(true)
      expect(api.stats.userAccessReads).toBe(readsBeforeApply)
      app?.unmount()
      container?.remove()
      app = null
      container = null
      apiFetchMock.mockReset()
    }
  })

  it('wires this spec into the required web lane', () => {
    const script = readFileSync(resolve(join(__dirname, '..', 'scripts', 'run-required-web-tests.sh')), 'utf8')
    expect(script).toContain('permissionManagementView')
  })
})
