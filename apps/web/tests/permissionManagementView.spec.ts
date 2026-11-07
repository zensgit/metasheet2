import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
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
      requestedPermissions: ['workflow:read'],
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

    const missingDirect = describePermissionTemplateApply({
      templateName: '现场模板',
      requestedPermissions: ['workflow:read', 'crm:read'],
      inspection: readUserPermissionInspection({
        userId: 'subject-a',
        direct: ['workflow:read'],
        inherited: [],
        legacy: [],
        effective: ['workflow:read', 'crm:read'],
        blockedByNamespaceAdmission: [],
        permissions: ['workflow:read', 'crm:read'],
        isAdmin: false,
      }, 'subject-a'),
    })
    expect(missingDirect.tone).toBe('error')
    expect(missingDirect.message).toContain('crm:read')
    expect(missingDirect.message).not.toContain('已确认模板')
    expect(missingDirect.message).not.toContain('角色与插件准入未改变')

    const blockedDirect = describePermissionTemplateApply({
      templateName: '现场模板',
      requestedPermissions: ['crm:read'],
      inspection: readUserPermissionInspection({
        userId: 'subject-a',
        direct: ['crm:read'],
        inherited: [],
        legacy: [],
        effective: [],
        blockedByNamespaceAdmission: ['crm:read'],
        permissions: [],
        isAdmin: false,
      }, 'subject-a'),
    })
    expect(blockedDirect.tone).toBe('info')
    expect(blockedDirect.message).toContain('已把模板 现场模板')
    expect(blockedDirect.message).toContain('不能说明插件已经可用')
    expect(blockedDirect.message).toContain('角色和插件准入没有改变')

    const confirmedDirect = describePermissionTemplateApply({
      templateName: '现场模板',
      requestedPermissions: ['workflow:read'],
      inspection: readUserPermissionInspection({
        userId: 'subject-a',
        direct: ['workflow:read'],
        inherited: ['workflow:read'],
        legacy: [],
        effective: ['workflow:read'],
        blockedByNamespaceAdmission: [],
        permissions: ['workflow:read'],
        isAdmin: false,
      }, 'subject-a'),
    })
    expect(confirmedDirect.tone).toBe('info')
    expect(confirmedDirect.message).toContain('角色和插件准入没有改变')
    expect(confirmedDirect.message).not.toContain('不能说明插件已经可用')
    expect(confirmedDirect.message).not.toContain('最终')

    const retainedLegacy = describePermissionWrite({
      action: 'revoke',
      requestedUserId: 'subject-a',
      selectedUserId: 'subject-a',
      permission: 'crm:read',
      ok: true,
      writeAcknowledged: true,
      inspection: readUserPermissionInspection({
        userId: 'subject-a',
        direct: [],
        inherited: ['crm:read'],
        legacy: ['crm:read'],
        effective: ['crm:read'],
        blockedByNamespaceAdmission: [],
        permissions: ['crm:read'],
        isAdmin: false,
      }, 'subject-a'),
    })
    expect(retainedLegacy.tone).toBe('info')
    expect(retainedLegacy.message).toContain('角色继承')
    expect(retainedLegacy.message).toContain('历史授权')
    expect(retainedLegacy.message).not.toContain('生效权限不再包含它')

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
    templatePermissions?: string[]
    skipTemplateDirectWrite?: boolean
    delayTemplateApply?: Promise<void>
    throwOnGrant?: boolean
    legacyByUser?: Record<string, string[]>
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
    const bodies: Array<Record<string, unknown>> = []
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
        legacy: options.legacyByUser?.[userId] ?? [],
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
            permissions: options.templatePermissions ?? ['workflow:read'],
            presetId: null,
            roleId: null,
          }, {
            id: 'tpl-2',
            name: '其他模板',
            description: '另一套权限',
            productMode: 'platform',
            permissions: ['crm:admin'],
            presetId: null,
            roleId: null,
          }],
        })
      }
      if (pathname === '/api/admin/permission-templates/apply' && method === 'POST') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { userId?: string; templateId?: string } : {}
        bodies.push(body)
        if (options.delayTemplateApply) await options.delayTemplateApply
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
        const templatePermissions = options.templatePermissions ?? ['workflow:read']
        if (!options.skipTemplateDirectWrite) {
          const grants = state[String(body.userId || '')]
          if (grants) {
            for (const permission of templatePermissions) {
              if (!grants.direct.includes(permission)) grants.direct.push(permission)
              if (permission.startsWith('crm:')) {
                if (!grants.blocked.includes(permission)) grants.blocked.push(permission)
                grants.effective = grants.effective.filter((code) => code !== permission)
              } else if (!grants.effective.includes(permission)) {
                grants.effective.push(permission)
              }
            }
          }
        }
        return createJsonResponse({
          success: true,
          userId: body.userId,
          template: { id: body.templateId },
          permissions: templatePermissions,
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
        if (options.throwOnGrant) throw new Error('timeout')
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
      bodies,
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

    createPermissionApi({ failReadbackAfterWrite: true })
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
    createPermissionApi({ failUserAccessAfter: 1 })
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
    expect(oldRoot.querySelector('[data-testid="permission-legacy-section"]')?.textContent).toContain('未知')
    expect(oldRoot.querySelector('[data-testid="permission-legacy-section"]')?.textContent).not.toContain('暂无历史授权')
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
    const completion = '已把模板 现场模板 的权限写入直接授权。角色和插件准入没有改变。'
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
    expect(section(healthy, 'permission-direct-section')).toContain('workflow:read')
    expect(section(healthy, 'permission-direct-section')).toContain('1 项')
    expect(section(healthy, 'permission-direct-section')).not.toContain('暂无直接授予')
    expect(section(healthy, 'permission-direct-section')).not.toContain('未读')
    expect(section(healthy, 'permission-direct-section')).not.toContain('未知')
    expect(section(healthy, 'permission-inherited-section')).toContain('crm:admin')
    expect(section(healthy, 'permission-inherited-section')).toContain('1 项')
    expect(section(healthy, 'permission-inherited-section')).not.toContain('未读')
    expect(section(healthy, 'permission-effective-section')).toContain('workflow:read')
    expect(section(healthy, 'permission-effective-section')).not.toContain('暂无生效权限')
    expect(healthy.querySelector('.permission-admin__status')?.textContent).not.toContain('插件可用')
    expect(section(healthy, 'permission-blocked-section')).toContain('crm:admin')
    expect(healthy.textContent).toContain('普通用户')
    expect(healthy.textContent).not.toContain('身份未读')
    expect((healthy.querySelector('[data-testid="grant-permission-button"]') as HTMLButtonElement).disabled).toBe(false)
    expect(healthy.querySelector('[data-testid="grant-permission-button"]')?.textContent).toContain('添加直接授权')
    expect(healthy.querySelector('[data-testid="revoke-permission-button"]')?.textContent).toContain('移除直接授权')
    expect((healthy.querySelector('[data-testid="permission-legacy-details"]') as HTMLDetailsElement).open).toBe(false)
    expect(section(healthy, 'permission-legacy-section')).toContain('暂无历史授权')
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
      expect(section(root, 'permission-legacy-section')).toContain('未读')
      expect(section(root, 'permission-legacy-section')).not.toContain('暂无历史授权')
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

  it('shows collapsed historical grants and keeps them distinct from direct and inherited grants', async () => {
    createPermissionApi({ legacyByUser: { 'user-1': ['spreadsheet:share'] } })
    const root = mountView()
    await waitForCondition(() => (root.querySelector('[data-testid="permission-legacy-section"]')?.textContent || '').includes('spreadsheet:share'))
    const details = root.querySelector('[data-testid="permission-legacy-details"]') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.textContent).toContain('历史授权')
    expect(root.querySelector('[data-testid="permission-direct-section"]')?.textContent).not.toContain('spreadsheet:share')
    expect(root.querySelector('[data-testid="permission-inherited-section"]')?.textContent).not.toContain('spreadsheet:share')
  })

  it('pages 41 users, resets search to page 1, and ignores a late list response', async () => {
    const allUsers = Array.from({ length: 41 }, (_, index) => {
      const number = index + 1
      return {
        id: `user-${number}`,
        email: `user${number}@example.com`,
        name: `Member ${String(number).padStart(2, '0')}`,
        role: 'user',
        is_active: true,
      }
    })
    const seen: string[] = []
    let releasePage2: (() => void) | undefined
    let holdNextPage2 = false
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const url = new URL(String(input), 'http://localhost')
      const pathname = url.pathname
      if (pathname === '/api/admin/users') {
        const pageNumber = Number(url.searchParams.get('page') || '1')
        const size = Number(url.searchParams.get('pageSize') || '0')
        const q = url.searchParams.get('q') || ''
        seen.push(`users:${pageNumber}:${size}:${q}`)
        if (pageNumber === 2 && holdNextPage2) {
          holdNextPage2 = false
          await new Promise<void>((resolve) => {
            releasePage2 = resolve
          })
        }
        const filtered = q
          ? allUsers.filter((user) => `${user.name} ${user.email} ${user.id}`.includes(q))
          : allUsers
        const start = (pageNumber - 1) * size
        return createJsonResponse({
          ok: true,
          data: {
            items: filtered.slice(start, start + size),
            total: filtered.length,
            page: pageNumber,
            pageSize: size,
          },
        })
      }
      if (pathname === '/api/permissions') {
        return createJsonResponse({
          data: [
            { code: 'attendance:read', name: 'Attendance Read', description: 'Read attendance records and summaries' },
            { code: 'plugin:made', name: 'Floor only', description: 'Site note' },
            { code: 'mystery:code', name: '', description: null },
          ],
        })
      }
      if (pathname.startsWith('/api/admin/permission-templates')) return createJsonResponse({ data: [] })
      const userMatch = pathname.match(/^\/api\/permissions\/user\/([^/]+)$/)
      if (userMatch) {
        return createJsonResponse({
          userId: decodeURIComponent(userMatch[1] || ''),
          permissions: [],
          isAdmin: false,
          direct: [],
          inherited: [],
          legacy: [],
          effective: [],
          blockedByNamespaceAdmission: [],
        })
      }
      throw new Error(`Unhandled ${pathname}`)
    })

    const root = mountView()
    const listNames = () => Array.from(root.querySelectorAll('.permission-admin__user strong')).map((node) => node.textContent || '')
    await waitForCondition(() => listNames().length === 20 && listNames().includes('Member 01'))
    expect(root.querySelector('[data-testid="user-list-total"]')?.textContent).toContain('41')
    expect(root.querySelector('[data-testid="user-list-page"]')?.textContent).toContain('第 1 / 3 页')
    expect((root.querySelector('[data-testid="user-list-prev"]') as HTMLButtonElement).disabled).toBe(true)
    expect((root.querySelector('[data-testid="user-list-next"]') as HTMLButtonElement).disabled).toBe(false)
    expect(seen[0]).toBe('users:1:20:')
    expect(listNames()).not.toContain('Member 21')
    expect(Array.from(root.querySelectorAll('h2')).some((heading) => heading.textContent?.includes('Member 01'))).toBe(true)

    ;(root.querySelector('[data-testid="user-list-next"]') as HTMLButtonElement).click()
    await waitForCondition(() => listNames().includes('Member 21') && listNames().length === 20)
    expect(root.querySelector('[data-testid="user-list-page"]')?.textContent).toContain('第 2 / 3 页')
    expect(listNames()).not.toContain('Member 01')
    expect(Array.from(root.querySelectorAll('h2')).some((heading) => heading.textContent?.includes('Member 01'))).toBe(true)
    ;(root.querySelector('[data-testid="user-list-next"]') as HTMLButtonElement).click()
    await waitForCondition(() => listNames().includes('Member 41') && listNames().length === 1)
    expect((root.querySelector('[data-testid="user-list-next"]') as HTMLButtonElement).disabled).toBe(true)
    expect((root.querySelector('[data-testid="user-list-prev"]') as HTMLButtonElement).disabled).toBe(false)

    const search = root.querySelector('input[type="search"]') as HTMLInputElement
    search.value = 'Member 05'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    search.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
    await waitForCondition(() => listNames().length === 1 && listNames()[0] === 'Member 05')
    expect(seen.at(-1)).toBe('users:1:20:Member 05')
    expect(root.querySelector('[data-testid="user-list-page"]')?.textContent).toContain('第 1 / 1 页')
    expect(root.querySelector('[data-testid="user-list-total"]')?.textContent).toContain('1')

    search.value = ''
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    search.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
    await waitForCondition(() => listNames().includes('Member 01') && listNames().length === 20)
    clickNamedUser(root, 'Member 02')
    await waitForCondition(() => Array.from(root.querySelectorAll('h2')).some((heading) => heading.textContent?.includes('Member 02')))
    const seenBeforeLate = seen.length
    holdNextPage2 = true
    ;(root.querySelector('[data-testid="user-list-next"]') as HTMLButtonElement).click()
    await waitForCondition(() => seen.length > seenBeforeLate && seen[seen.length - 1] === 'users:2:20:')
    expect(root.querySelector('[data-testid="user-list-page"]')?.textContent).toContain('第 1 / 3 页')
    const seenBeforeReturn = seen.length
    search.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
    await waitForCondition(() => seen.length > seenBeforeReturn && seen[seen.length - 1] === 'users:1:20:' && listNames().includes('Member 01'))
    releasePage2?.()
    await flushUi(12)
    expect(listNames()).toContain('Member 01')
    expect(listNames()).not.toContain('Member 21')
    expect(Array.from(root.querySelectorAll('h2')).some((heading) => heading.textContent?.includes('Member 02'))).toBe(true)
    expect(root.querySelector('.permission-admin__permission strong')?.textContent).toBe('考勤读取')
    expect(root.textContent).toContain('Floor only')
    expect(root.textContent).toContain('技术明细')
    expect(root.textContent).toContain('attendance:read')
    const articles = Array.from(root.querySelectorAll('.permission-admin__permission'))
    const mystery = articles.find((article) => article.textContent?.includes('mystery:code'))
    const attendance = articles.find((article) => article.textContent?.includes('考勤读取'))
    expect(mystery?.textContent?.match(/mystery:code/g)).toEqual(['mystery:code'])
    expect(mystery?.querySelector('details')).toBeNull()
    expect(attendance?.querySelector('details')?.textContent).toContain('attendance:read')
    expect(root.querySelector('[data-testid="permission-effective-section"]')?.textContent).toContain('权限码快照')
    expect(root.querySelector('[data-testid="permission-effective-section"]')?.textContent).not.toContain('∪')
  })

  it('keeps the committed page when the next page request fails', async () => {
    const allUsers = Array.from({ length: 41 }, (_, index) => {
      const number = index + 1
      return {
        id: `user-${number}`,
        email: `user${number}@example.com`,
        name: `Member ${String(number).padStart(2, '0')}`,
        role: 'user',
        is_active: true,
      }
    })
    let failPage2 = false
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const url = new URL(String(input), 'http://localhost')
      const pathname = url.pathname
      if (pathname === '/api/admin/users') {
        const pageNumber = Number(url.searchParams.get('page') || '1')
        const size = Number(url.searchParams.get('pageSize') || '20')
        if (failPage2 && pageNumber === 2) {
          return createJsonResponse({ ok: false, error: { message: 'synthetic failure' } }, 500)
        }
        const start = (pageNumber - 1) * size
        return createJsonResponse({
          ok: true,
          data: { items: allUsers.slice(start, start + size), total: allUsers.length, page: pageNumber, pageSize: size },
        })
      }
      if (pathname === '/api/permissions') return createJsonResponse({ data: [] })
      if (pathname.startsWith('/api/admin/permission-templates')) return createJsonResponse({ data: [] })
      const userMatch = pathname.match(/^\/api\/permissions\/user\/([^/]+)$/)
      if (userMatch) {
        return createJsonResponse({
          userId: decodeURIComponent(userMatch[1] || ''),
          permissions: [],
          isAdmin: false,
          direct: [],
          inherited: [],
          legacy: [],
          effective: [],
          blockedByNamespaceAdmission: [],
        })
      }
      throw new Error(`Unhandled ${pathname}`)
    })
    const root = mountView()
    const listNames = () => Array.from(root.querySelectorAll('.permission-admin__user strong')).map((node) => node.textContent || '')
    await waitForCondition(() => listNames().includes('Member 01') && listNames().length === 20)
    failPage2 = true
    ;(root.querySelector('[data-testid="user-list-next"]') as HTMLButtonElement).click()
    await waitForCondition(() => (root.querySelector('.permission-admin__status')?.textContent || '').includes('synthetic failure'))
    expect(root.querySelector('[data-testid="user-list-page"]')?.textContent).toContain('第 1 / 3 页')
    expect(listNames()).toContain('Member 01')
    expect(listNames()).not.toContain('Member 21')
  })

  it('refetches the last valid page when a refresh says the total no longer covers the current page', async () => {
    const allUsers = Array.from({ length: 41 }, (_, index) => {
      const number = index + 1
      return {
        id: `user-${number}`,
        email: `user${number}@example.com`,
        name: `Member ${String(number).padStart(2, '0')}`,
        role: 'user',
        is_active: true,
      }
    })
    const seen: string[] = []
    let shrink = false
    apiFetchMock.mockImplementation(async (input: unknown) => {
      const url = new URL(String(input), 'http://localhost')
      const pathname = url.pathname
      if (pathname === '/api/admin/users') {
        const pageNumber = Number(url.searchParams.get('page') || '1')
        const size = Number(url.searchParams.get('pageSize') || '20')
        seen.push(`users:${pageNumber}`)
        if (shrink && pageNumber > 1) {
          return createJsonResponse({ ok: true, data: { items: [], total: 1, page: pageNumber, pageSize: size } })
        }
        const source = shrink ? allUsers.slice(0, 1) : allUsers
        const start = (pageNumber - 1) * size
        return createJsonResponse({
          ok: true,
          data: { items: source.slice(start, start + size), total: source.length, page: pageNumber, pageSize: size },
        })
      }
      if (pathname === '/api/permissions') return createJsonResponse({ data: [] })
      if (pathname.startsWith('/api/admin/permission-templates')) return createJsonResponse({ data: [] })
      const userMatch = pathname.match(/^\/api\/permissions\/user\/([^/]+)$/)
      if (userMatch) {
        return createJsonResponse({
          userId: decodeURIComponent(userMatch[1] || ''),
          permissions: [],
          isAdmin: false,
          direct: [],
          inherited: [],
          legacy: [],
          effective: [],
          blockedByNamespaceAdmission: [],
        })
      }
      throw new Error(`Unhandled ${pathname}`)
    })
    const root = mountView()
    const listNames = () => Array.from(root.querySelectorAll('.permission-admin__user strong')).map((node) => node.textContent || '')
    await waitForCondition(() => listNames().length === 20)
    ;(root.querySelector('[data-testid="user-list-next"]') as HTMLButtonElement).click()
    await waitForCondition(() => (root.querySelector('[data-testid="user-list-page"]')?.textContent || '').includes('第 2 / 3 页'))
    ;(root.querySelector('[data-testid="user-list-next"]') as HTMLButtonElement).click()
    await waitForCondition(() => listNames().includes('Member 41'))
    shrink = true
    const refresh = Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.trim() === '刷新')
    refresh?.click()
    await waitForCondition(() => (root.querySelector('[data-testid="user-list-page"]')?.textContent || '').includes('第 1 / 1 页'))
    expect(root.querySelector('[data-testid="user-list-total"]')?.textContent).toContain('共 1 人')
    expect(listNames()).toEqual(['Member 01'])
    expect(seen.filter((entry) => entry === 'users:3').length).toBeGreaterThan(0)
    expect(seen.at(-1)).toBe('users:1')
  })

  it('does not call a template applied when a requested direct code is missing', async () => {
    const api = createPermissionApi({ withTemplate: true, skipTemplateDirectWrite: true })
    const root = mountView()
    await waitForCondition(() => (root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').includes('crm:admin'))
    await applyNamedTemplate(root)
    await waitForCondition(() => (root.querySelector('.permission-admin__status')?.textContent || '').includes('不能算全部完成'))
    const status = root.querySelector('.permission-admin__status')?.textContent || ''
    expect(status).toContain('workflow:read')
    expect(status).not.toContain('已确认模板')
    expect(status).not.toContain('角色与插件准入未改变')
    expect(root.querySelector('[data-testid="permission-direct-section"]')?.textContent).toContain('暂无直接授予')
    expect(api.calls.filter((call) => call === 'POST /api/admin/permission-templates/apply')).toHaveLength(1)
  })

  it('treats admission-blocked direct grants as a saved direct source without proving the plugin is usable', async () => {
    createPermissionApi({ withTemplate: true, templatePermissions: ['crm:read'] })
    const root = mountView()
    await waitForCondition(() => (root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').includes('crm:admin'))
    await applyNamedTemplate(root)
    await waitForCondition(() => (root.querySelector('.permission-admin__status')?.textContent || '').includes('角色和插件准入没有改变'))
    const status = root.querySelector('.permission-admin__status')?.textContent || ''
    expect(status).toContain('不能说明插件已经可用')
    expect(status).not.toContain('插件已可用')
    expect(root.querySelector('[data-testid="permission-direct-section"]')?.textContent).toContain('crm:read')
    expect(root.querySelector('[data-testid="permission-blocked-section"]')?.textContent).toContain('crm:read')
    expect(root.querySelector('[data-testid="permission-effective-section"]')?.textContent).not.toContain('crm:read')
  })

  it('checks the user and template captured at submission when the selection changes', async () => {
    let release: (() => void) | undefined
    const delayTemplateApply = new Promise<void>((resolve) => { release = resolve })
    const api = createPermissionApi({ withTemplate: true, delayTemplateApply })
    const root = mountView()
    await waitForCondition(() => (root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').includes('crm:admin'))
    await applyNamedTemplate(root)
    await waitForCondition(() => api.calls.includes('POST /api/admin/permission-templates/apply'))
    clickNamedUser(root, 'Bravo')
    await waitForCondition(() => (root.querySelector('[data-testid="permission-direct-section"]')?.textContent || '').includes('workflow:read'))
    const templateSelect = Array.from(root.querySelectorAll('select')).find((select) => select.innerHTML.includes('其他模板')) as HTMLSelectElement
    templateSelect.value = 'tpl-2'
    templateSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    release?.()
    await waitForCondition(() => (root.querySelector('.permission-admin__status')?.textContent || '').includes('未覆盖当前选中用户 user-2'))
    const status = root.querySelector('.permission-admin__status')?.textContent || ''
    expect(status).toContain('现场模板')
    expect(status).not.toContain('其他模板')
    expect(root.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').not.toContain('crm:admin')
    expect(api.calls.filter((call) => call === 'POST /api/admin/permission-templates/apply')).toHaveLength(1)
    expect(api.bodies.at(-1)).toMatchObject({ userId: 'user-1', templateId: 'tpl-1' })
  })

  it('offers a read-only refresh after an unconfirmed write and does not replay POST', async () => {
    const failed = createPermissionApi({ failReadbackAfterWrite: true })
    const failedRoot = mountView()
    await waitForCondition(() => (failedRoot.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').includes('crm:admin'))
    clickNamedUser(failedRoot, 'Bravo')
    await waitForCondition(() => (failedRoot.querySelector('[data-testid="permission-direct-section"]')?.textContent || '').includes('workflow:read'))
    await selectPermission(failedRoot, 'workflow:read')
    ;(failedRoot.querySelector('[data-testid="revoke-permission-button"]') as HTMLButtonElement).click()
    await waitForCondition(() => Boolean(failedRoot.querySelector('[data-testid="permission-unconfirmed-refresh"]')))
    expect(failedRoot.querySelector('.permission-admin__status')?.textContent).toContain('未确认')
    expect(failedRoot.querySelector('.permission-admin__status')?.textContent).toContain('不会再次提交')
    const postsBefore = failed.calls.filter((call) => call.startsWith('POST'))
    clickNamedUser(failedRoot, 'Alpha')
    await waitForCondition(() => (failedRoot.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').includes('crm:admin'))
    expect(failedRoot.querySelector('[data-testid="permission-unconfirmed-refresh"]')).toBeNull()
    const readsOnAlpha = failed.calls.filter((call) => call === 'GET /api/permissions/user/user-1').length
    clickNamedUser(failedRoot, 'Bravo')
    await waitForCondition(() => Boolean(failedRoot.querySelector('[data-testid="permission-unconfirmed-refresh"]')))
    expect(failed.calls.filter((call) => call === 'GET /api/permissions/user/user-1').length).toBe(readsOnAlpha)
    const readsBefore = failed.calls.filter((call) => call === 'GET /api/permissions/user/user-2').length
    ;(failedRoot.querySelector('[data-testid="permission-unconfirmed-refresh"]') as HTMLButtonElement).click()
    await waitForCondition(() => failed.calls.filter((call) => call === 'GET /api/permissions/user/user-2').length > readsBefore)
    expect(failed.calls.filter((call) => call.startsWith('POST'))).toEqual(postsBefore)
    app?.unmount()
    container?.remove()
    app = null
    container = null
    apiFetchMock.mockReset()

    const timedOut = createPermissionApi({ throwOnGrant: true })
    const timedRoot = mountView()
    await waitForCondition(() => (timedRoot.querySelector('[data-testid="permission-inherited-section"]')?.textContent || '').includes('crm:admin'))
    await selectPermission(timedRoot, 'crm:read')
    ;(timedRoot.querySelector('[data-testid="grant-permission-button"]') as HTMLButtonElement).click()
    await waitForCondition(() => Boolean(timedRoot.querySelector('[data-testid="permission-unconfirmed-refresh"]')))
    const grantPosts = timedOut.calls.filter((call) => call.startsWith('POST'))
    expect(grantPosts).toEqual(['POST /api/permissions/grant'])
    const grantReadsBefore = timedOut.calls.filter((call) => call === 'GET /api/permissions/user/user-1').length
    ;(timedRoot.querySelector('[data-testid="permission-unconfirmed-refresh"]') as HTMLButtonElement).click()
    await waitForCondition(() => timedOut.calls.filter((call) => call === 'GET /api/permissions/user/user-1').length > grantReadsBefore)
    expect(timedOut.calls.filter((call) => call.startsWith('POST'))).toEqual(grantPosts)
  })

  it('does not warn when the permission page is mounted without a router', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    createPermissionApi()
    const root = mountView()
    await waitForCondition(() => (root.textContent || '').includes('Alpha'))
    const output = [...warn.mock.calls, ...error.mock.calls].map((call) => call.map(String).join(' ')).join('\n')
    expect(output).not.toMatch(/injection|vue-router|route location/i)
    warn.mockRestore()
    error.mockRestore()
  })

  describe('permission route userId target', () => {
    type HeldAccess = { userId: string; order: number; release: (body: unknown, status?: number) => void }

    function detailHeading(root: ParentNode): string {
      return root.querySelector('.permission-admin__panel--detail h2')?.textContent?.trim() || ''
    }

    function listNames(root: ParentNode): string[] {
      return Array.from(root.querySelectorAll('.permission-admin__user strong')).map((node) => node.textContent?.trim() || '')
    }

    function member(number: number) {
      return {
        id: `user-${number}`,
        email: `user${number}@example.com`,
        name: `Member ${String(number).padStart(2, '0')}`,
        role: 'user',
        is_active: true,
        is_admin: false,
        last_login_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
      }
    }

    async function mountRoutedView(url: string): Promise<{ root: HTMLDivElement; router: Router }> {
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }],
      })
      await router.replace(url)
      await router.isReady()
      container = document.createElement('div')
      document.body.appendChild(container)
      app = createApp(PermissionManagementView)
      const push = vi.spyOn(router, 'push')
      const replace = vi.spyOn(router, 'replace')
      app.use(router)
      app.mount(container)
      await flushUi()
      expect(push).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
      return { root: container, router }
    }

    function installDeepLinkApi(options: {
      total?: number
      holdUsers?: Promise<void>
      holdAccess?: boolean
      accessResult?: (userId: string, order: number) => { body: unknown; status?: number }
      permissionResult?: (userId: string) => Record<string, unknown>
    } = {}) {
      const total = options.total ?? 41
      const allUsers = Array.from({ length: total }, (_, index) => member(index + 1))
      const calls: string[] = []
      const heldAccess: HeldAccess[] = []
      let accessOrder = 0
      apiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost')
        const method = (init?.method || 'GET').toUpperCase()
        calls.push(`${method} ${url.pathname}`)
        if (method === 'POST') return createJsonResponse({ ok: false }, 500)
        if (url.pathname === '/api/admin/users') {
          if (options.holdUsers) await options.holdUsers
          const pageNumber = Number(url.searchParams.get('page') || '1')
          const size = Number(url.searchParams.get('pageSize') || '20')
          const start = (pageNumber - 1) * size
          return createJsonResponse({
            ok: true,
            data: { items: allUsers.slice(start, start + size), total: allUsers.length, page: pageNumber, pageSize: size },
          })
        }
        const accessMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/access$/)
        if (accessMatch) {
          const userId = decodeURIComponent(accessMatch[1] || '')
          accessOrder += 1
          const order = accessOrder
          if (options.holdAccess) {
            return new Promise((resolve) => {
              heldAccess.push({
                userId,
                order,
                release: (body, status = 200) => resolve(createJsonResponse(body, status)),
              })
            })
          }
          const result = options.accessResult?.(userId, order) ?? {
            body: { ok: true, data: { user: member(Number(userId.replace('user-', '')) || 0) } },
          }
          return createJsonResponse(result.body, result.status ?? 200)
        }
        if (url.pathname === '/api/permissions') {
          return createJsonResponse({ data: [{ code: 'site:keep', name: '现场保留', description: null }] })
        }
        if (url.pathname.startsWith('/api/admin/permission-templates')) return createJsonResponse({ data: [] })
        const permissionMatch = url.pathname.match(/^\/api\/permissions\/user\/([^/]+)$/)
        if (permissionMatch) {
          const userId = decodeURIComponent(permissionMatch[1] || '')
          return createJsonResponse(options.permissionResult?.(userId) ?? {
            userId,
            permissions: ['site:keep'],
            isAdmin: false,
            direct: ['site:keep'],
            inherited: [],
            legacy: [],
            effective: ['site:keep'],
            blockedByNamespaceAdmission: [],
          })
        }
        throw new Error(`Unhandled apiFetch call: ${method} ${url.pathname}`)
      })
      return { calls, heldAccess }
    }

    it('opens a userId outside the first page and keeps the rest of the route', async () => {
      const api = installDeepLinkApi({
        permissionResult: (userId) => ({
          userId,
          permissions: ['site:keep'],
          isAdmin: false,
          direct: [`direct:${userId}`],
          inherited: [],
          legacy: [],
          effective: [`direct:${userId}`],
          blockedByNamespaceAdmission: [],
        }),
      })
      const { root, router } = await mountRoutedView('/admin/permissions?userId=user-41&tab=members#kept')
      await waitForCondition(() => detailHeading(root) === 'Member 41' && listNames(root).includes('Member 01'))
      expect(listNames(root)).toHaveLength(20)
      expect(listNames(root)).not.toContain('Member 41')
      expect(root.querySelector('[data-testid="user-list-page"]')?.textContent).toContain('第 1 / 3 页')
      expect(root.querySelector('[data-testid="permission-direct-section"]')?.textContent).toContain('direct:user-41')
      expect(api.calls).toContain('GET /api/admin/users/user-41/access')
      expect(api.calls).toContain('GET /api/permissions/user/user-41')
      expect(api.calls.some((call) => call.startsWith('POST'))).toBe(false)
      expect(router.currentRoute.value.path).toBe('/admin/permissions')
      expect(router.currentRoute.value.hash).toBe('#kept')
      expect(router.currentRoute.value.query.tab).toBe('members')
      expect(router.currentRoute.value.query.userId).toBe('user-41')
    })

    it('follows a later userId without rewriting unrelated query or hash', async () => {
      const api = installDeepLinkApi()
      const { root, router } = await mountRoutedView('/admin/permissions?userId=user-41&tab=members#kept')
      await waitForCondition(() => detailHeading(root) === 'Member 41')
      await router.replace({ path: '/admin/permissions', query: { userId: 'user-22', tab: 'members' }, hash: '#kept' })
      await waitForCondition(() => detailHeading(root) === 'Member 22' && (root.querySelector('[data-testid="permission-direct-section"]')?.textContent || '').includes('site:keep'))
      expect(root.querySelector('[data-testid="permission-direct-section"]')?.textContent).toContain('site:keep')
      expect(listNames(root)).not.toContain('Member 22')
      expect(api.calls.some((call) => call.startsWith('POST'))).toBe(false)
      expect(router.currentRoute.value.query).toMatchObject({ userId: 'user-22', tab: 'members' })
      expect(router.currentRoute.value.hash).toBe('#kept')
    })

    it('keeps the target when the user list resolves before or after the identity read', async () => {
      let releaseUsers: (() => void) | undefined
      const holdUsers = new Promise<void>((resolve) => { releaseUsers = resolve })
      const earlyIdentity = installDeepLinkApi({ holdUsers })
      const early = await mountRoutedView('/admin/permissions?userId=user-41&tab=members#kept')
      await waitForCondition(() => detailHeading(early.root) === 'Member 41')
      expect(listNames(early.root)).not.toContain('Member 01')
      releaseUsers?.()
      await waitForCondition(() => listNames(early.root).includes('Member 01'))
      expect(detailHeading(early.root)).toBe('Member 41')
      expect(early.root.querySelector('.permission-admin__user--active')).toBeNull()
      expect(earlyIdentity.calls.some((call) => call.startsWith('POST'))).toBe(false)
      expect(early.router.currentRoute.value.hash).toBe('#kept')
      app?.unmount()
      container?.remove()
      app = null
      container = null
      apiFetchMock.mockReset()

      const held = installDeepLinkApi({ holdAccess: true })
      const late = await mountRoutedView('/admin/permissions?userId=user-41&tab=members#kept')
      await waitForCondition(() => listNames(late.root).includes('Member 01') && held.heldAccess.length === 1)
      expect(detailHeading(late.root)).toBe('')
      expect(late.root.querySelector('.permission-admin__panel--detail')?.textContent).toContain('请选择用户')
      expect(late.root.querySelector('.permission-admin__user--active')).toBeNull()
      const pending = held.heldAccess[0]
      expect(pending?.userId).toBe('user-41')
      pending?.release({ ok: true, data: { user: member(41) } })
      await waitForCondition(() => detailHeading(late.root) === 'Member 41')
      expect(detailHeading(late.root)).not.toBe('Member 01')
      expect(held.calls.some((call) => call.startsWith('POST'))).toBe(false)
      expect(late.router.currentRoute.value.query.tab).toBe('members')
    })

    it('ignores stale identity responses when the target changes A to B to A', async () => {
      const api = installDeepLinkApi({
        holdAccess: true,
        permissionResult: (userId) => ({
          userId,
          permissions: [`perm:${userId}`],
          isAdmin: false,
          direct: [`perm:${userId}`],
          inherited: [],
          legacy: [],
          effective: [`perm:${userId}`],
          blockedByNamespaceAdmission: [],
        }),
      })
      const { root, router } = await mountRoutedView('/admin/permissions?userId=user-41&tab=members#kept')
      await waitForCondition(() => api.heldAccess.length === 1)
      await router.replace({ path: '/admin/permissions', query: { userId: 'user-22', tab: 'members' }, hash: '#kept' })
      await waitForCondition(() => api.heldAccess.length === 2)
      await router.replace({ path: '/admin/permissions', query: { userId: 'user-41', tab: 'members' }, hash: '#kept' })
      await waitForCondition(() => api.heldAccess.length === 3)
      const [staleA, staleB, freshA] = api.heldAccess
      expect(api.calls.filter((call) => call.startsWith('GET /api/permissions/user/'))).toEqual([])
      staleA?.release({ ok: true, data: { user: { ...member(41), name: 'Stale 41' } } })
      await flushUi(6)
      expect(detailHeading(root)).not.toBe('Stale 41')
      staleB?.release({ ok: true, data: { user: { ...member(22), name: 'Member 22' } } })
      await flushUi(6)
      expect(detailHeading(root)).not.toBe('Member 22')
      expect(api.calls.some((call) => call === 'GET /api/permissions/user/user-22')).toBe(false)
      freshA?.release({ ok: true, data: { user: { ...member(41), name: 'Fresh 41' } } })
      await waitForCondition(() => detailHeading(root) === 'Fresh 41' && (root.querySelector('[data-testid="permission-direct-section"]')?.textContent || '').includes('perm:user-41'))
      expect(root.querySelector('[data-testid="permission-direct-section"]')?.textContent).toContain('perm:user-41')
      expect(detailHeading(root)).not.toBe('Stale 41')
      expect(api.calls.some((call) => call.startsWith('POST'))).toBe(false)
      expect(router.currentRoute.value.query).toMatchObject({ userId: 'user-41', tab: 'members' })
      expect(router.currentRoute.value.hash).toBe('#kept')
    })

    it('does not select the first member for an empty, failed, or foreign target', async () => {
      installDeepLinkApi()
      const empty = await mountRoutedView('/admin/permissions?userId=&tab=members#kept')
      await waitForCondition(() => listNames(empty.root).includes('Member 01'))
      expect(empty.router.currentRoute.value.query.userId ?? '').toBe('')
      expect(detailHeading(empty.root)).toBe('')
      expect(empty.root.querySelector('.permission-admin__panel--detail')?.textContent).toContain('请选择用户')
      expect(empty.root.querySelector('.permission-admin__user--active')).toBeNull()
      expect(empty.root.querySelector('.permission-admin__status')?.textContent).toContain('没有打开指定用户')
      expect(empty.root.querySelector('.permission-admin__status')?.textContent).toContain('列表中的其他人')
      expect(empty.router.currentRoute.value.hash).toBe('#kept')
      expect(empty.router.currentRoute.value.query.tab).toBe('members')
      app?.unmount()
      container?.remove()
      app = null
      container = null
      apiFetchMock.mockReset()

      const failedApi = installDeepLinkApi({
        accessResult: () => ({ body: { ok: false, error: { message: 'missing' } }, status: 404 }),
      })
      const failed = await mountRoutedView('/admin/permissions?userId=user-41&tab=members#kept')
      await waitForCondition(() => (failed.root.querySelector('.permission-admin__status')?.textContent || '').includes('没有打开用户 user-41'))
      expect(listNames(failed.root)).toContain('Member 01')
      expect(detailHeading(failed.root)).toBe('')
      expect(failed.root.querySelector('.permission-admin__user--active')).toBeNull()
      expect(failed.root.textContent).not.toContain('没有打开用户 user-1')
      expect(failedApi.calls.some((call) => call.startsWith('POST'))).toBe(false)
      expect(failedApi.calls).not.toContain('GET /api/permissions/user/user-41')
      app?.unmount()
      container?.remove()
      app = null
      container = null
      apiFetchMock.mockReset()

      const foreignApi = installDeepLinkApi({
        accessResult: () => ({
          body: { ok: true, data: { user: { ...member(1), name: 'Foreign Alpha' } } },
        }),
      })
      const foreign = await mountRoutedView('/admin/permissions?userId=user-41&tab=members#kept')
      await waitForCondition(() => (foreign.root.querySelector('.permission-admin__status')?.textContent || '').includes('没有打开用户 user-41'))
      expect(detailHeading(foreign.root)).toBe('')
      expect(foreign.root.textContent).not.toContain('Foreign Alpha')
      expect(foreign.root.querySelector('.permission-admin__user--active')).toBeNull()
      expect(listNames(foreign.root)).toContain('Member 01')
      expect(foreignApi.calls.some((call) => call.startsWith('POST'))).toBe(false)
      expect(foreign.router.currentRoute.value.query.tab).toBe('members')
      expect(foreign.router.currentRoute.value.hash).toBe('#kept')
    })

    it('clears a selected target when the query userId becomes empty', async () => {
      installDeepLinkApi()
      const { root, router } = await mountRoutedView('/admin/permissions?userId=user-41&tab=members#kept')
      await waitForCondition(() => detailHeading(root) === 'Member 41')
      await router.replace({ path: '/admin/permissions', query: { userId: '   ', tab: 'members' }, hash: '#kept' })
      await waitForCondition(() => (root.querySelector('.permission-admin__status')?.textContent || '').includes('没有打开指定用户'))
      expect(detailHeading(root)).toBe('')
      expect(root.querySelector('.permission-admin__user--active')).toBeNull()
      expect(listNames(root)).toContain('Member 01')
      expect(router.currentRoute.value.query.tab).toBe('members')
      expect(router.currentRoute.value.hash).toBe('#kept')
    })
  })

  it('wires this spec into the required web lane', () => {
    const script = readFileSync(resolve(join(__dirname, '..', 'scripts', 'run-required-web-tests.sh')), 'utf8')
    expect(script).toContain('permissionManagementView')
  })
})
