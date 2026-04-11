import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import UserManagementView from '../src/views/UserManagementView.vue'

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

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text))
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`)
  }
  return button
}

function createApiImplementation(callLog: string[]) {
  return async (input: unknown) => {
    const rawUrl = String(input)
    callLog.push(rawUrl)
    const url = new URL(rawUrl, 'http://localhost')
    const pathname = url.pathname

    if (pathname === '/api/admin/roles') {
      return createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 'crm_admin',
              name: 'CRM 管理员',
              memberCount: 1,
              permissions: ['crm:admin'],
            },
          ],
        },
      })
    }

    if (pathname === '/api/admin/access-presets') {
      return createJsonResponse({
        ok: true,
        data: { items: [] },
      })
    }

    if (pathname === '/api/admin/users') {
      return createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 'user-1',
              email: 'alpha@example.com',
              name: 'Alpha',
              role: 'user',
              is_active: true,
            },
          ],
        },
      })
    }

    if (pathname === '/api/admin/users/user-1/access') {
      return createJsonResponse({
        ok: true,
        data: {
          user: {
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
            role: 'user',
            is_active: true,
          },
          roles: ['crm_admin'],
          permissions: ['crm:admin'],
          isAdmin: false,
        },
      })
    }

    if (pathname === '/api/admin/invites') {
      return createJsonResponse({
        ok: true,
        data: { items: [] },
      })
    }

    if (pathname === '/api/admin/users/user-1/sessions') {
      return createJsonResponse({
        ok: true,
        data: { items: [] },
      })
    }

    if (pathname === '/api/admin/users/user-1/dingtalk-access') {
      return createJsonResponse({
        ok: true,
        data: {
          userId: 'user-1',
          requireGrant: true,
          grant: {
            exists: true,
            enabled: true,
            grantedBy: 'admin-1',
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T00:00:00.000Z',
          },
          identity: {
            exists: true,
            corpId: 'dingcorp',
            lastLoginAt: '2026-04-09T00:00:00.000Z',
            createdAt: '2026-04-09T00:00:00.000Z',
            updatedAt: '2026-04-09T00:00:00.000Z',
          },
        },
      })
    }

    if (pathname === '/api/admin/users/user-1/member-admission') {
      return createJsonResponse({
        ok: true,
        data: {
          userId: 'user-1',
          accountEnabled: true,
          platformAdminEnabled: false,
          attendanceAdminEnabled: false,
          businessRoleIds: ['crm_admin'],
          directoryMemberships: [],
          dingtalk: {
            userId: 'user-1',
            requireGrant: true,
            grant: {
              exists: true,
              enabled: true,
              grantedBy: 'admin-1',
              createdAt: '2026-04-09T00:00:00.000Z',
              updatedAt: '2026-04-09T00:00:00.000Z',
            },
            identity: {
              exists: true,
              corpId: 'dingcorp',
              lastLoginAt: '2026-04-09T00:00:00.000Z',
              createdAt: '2026-04-09T00:00:00.000Z',
              updatedAt: '2026-04-09T00:00:00.000Z',
            },
          },
          namespaceAdmissions: [
            {
              namespace: 'crm',
              enabled: false,
              effective: false,
              hasRole: true,
              updatedAt: '2026-04-09T00:00:00.000Z',
            },
          ],
        },
      })
    }

    if (pathname === '/api/admin/users/user-1/namespaces/crm/admission') {
      return createJsonResponse({
        ok: true,
        data: {
          namespaceAdmissions: [
            {
              namespace: 'crm',
              enabled: true,
              effective: true,
              hasRole: true,
              updatedAt: '2026-04-10T00:00:00.000Z',
            },
          ],
        },
      })
    }

    throw new Error(`Unhandled apiFetch call: ${rawUrl}`)
  }
}

describe('UserManagementView', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let callLog: string[] = []

  beforeEach(() => {
    apiFetchMock.mockReset()
    callLog = []
    apiFetchMock.mockImplementation(createApiImplementation(callLog))
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('distinguishes DingTalk login from plugin usage and can open namespace admission', async () => {
    app = createApp(UserManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await waitForCondition(() => callLog.includes('/api/admin/users/user-1/member-admission'))

    expect(container?.textContent).toContain('钉钉扫码登录')
    expect(container?.textContent).toContain('插件使用')
    expect(container?.textContent).toContain('已开通钉钉扫码')
    expect(container?.textContent).toContain('插件使用未开通')
    expect(container?.textContent).toContain('当前不可用')

    findButtonByText(container!, '开通插件使用').click()
    await waitForCondition(() => callLog.some((url) => url.includes('/api/admin/users/user-1/namespaces/crm/admission')))

    expect(container?.textContent).toContain('已开通 crm 插件使用')
    expect(container?.textContent).toContain('当前实际可用')
  })
})
