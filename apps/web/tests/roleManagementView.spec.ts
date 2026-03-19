import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import RoleManagementView from '../src/views/RoleManagementView.vue'
import * as apiModule from '../src/utils/api'

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

function createMockResponse(payload: unknown, status = 200, ok = status < 300) {
  return {
    ok,
    status,
    json: vi.fn(async () => payload),
  } as Response
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), 0)
  })
}

function mountRoleManagement() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(RoleManagementView)
  app.mount(container)

  return {
    container,
    unmount: () => {
      app.unmount()
      container.remove()
    },
  }
}

const sampleRoles = [
  {
    id: 'attendance_admin',
    name: 'Attendance Admin',
    permissions: ['attendance:read', 'attendance:write'],
    memberCount: 2,
  },
]

const samplePermissions = [
  {
    code: 'attendance:read',
    name: '查看考勤',
    description: 'Read attendance data',
  },
  {
    code: 'attendance:write',
    name: '编辑考勤',
    description: 'Write attendance data',
  },
]

function setupApiMocks({
  rolesResponses,
  permissionsResponse = createMockResponse({ data: samplePermissions }),
  createResponse = createMockResponse({ ok: true, data: { id: 'workflow_admin', name: 'Workflow Admin' } }),
  deleteResponse = createMockResponse({ ok: true, data: { id: 'attendance_admin' } }),
}: {
  rolesResponses: Response[]
  permissionsResponse?: Response
  createResponse?: Response
  deleteResponse?: Response
}) {
  let rolesCallCount = 0
  vi.mocked(apiModule.apiFetch).mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/admin/roles') {
      const nextResponse = rolesResponses[rolesCallCount] ?? rolesResponses[rolesResponses.length - 1]
      rolesCallCount += 1
      return Promise.resolve(nextResponse)
    }
    if (url === '/api/permissions') {
      return Promise.resolve(permissionsResponse)
    }
    if (url === '/api/roles' && init?.method === 'POST') {
      return Promise.resolve(createResponse)
    }
    if (url === '/api/roles/attendance_admin' && init?.method === 'DELETE') {
      return Promise.resolve(deleteResponse)
    }
    return Promise.reject(new Error(`Unexpected apiFetch call: ${url}`))
  })
}

describe('RoleManagementView', () => {
  beforeEach(() => {
    vi.mocked(apiModule.apiFetch).mockReset()
    vi.stubGlobal('confirm', vi.fn(() => true))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('renders loaded role catalog and permission directory', async () => {
    setupApiMocks({
      rolesResponses: [
        createMockResponse({
          ok: true,
          data: { items: sampleRoles },
        }),
      ],
    })

    const { container, unmount } = mountRoleManagement()
    await flushPromises()
    await nextTick()

    expect(container.textContent).toContain('Attendance Admin')
    expect(container.textContent).toContain('成员数：2')
    expect(container.textContent).toContain('attendance:read')
    unmount()
  })

  it('creates a new role and refreshes the catalog', async () => {
    setupApiMocks({
      rolesResponses: [
        createMockResponse({ ok: true, data: { items: [] } }),
        createMockResponse({
          ok: true,
          data: {
            items: [
              {
                id: 'workflow_admin',
                name: 'Workflow Admin',
                permissions: ['attendance:read'],
                memberCount: 0,
              },
            ],
          },
        }),
      ],
    })

    const { container, unmount } = mountRoleManagement()
    await flushPromises()
    await nextTick()

    const inputs = Array.from(container.querySelectorAll('input.admin-page__input')) as HTMLInputElement[]
    expect(inputs).toHaveLength(2)
    inputs[0].value = 'workflow_admin'
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }))
    inputs[1].value = 'Workflow Admin'
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }))

    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    expect(checkbox).not.toBeNull()
    checkbox!.checked = true
    checkbox!.dispatchEvent(new Event('change', { bubbles: true }))

    await nextTick()

    const createButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('创建角色'))
    expect(createButton).not.toBeNull()
    createButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    expect(apiModule.apiFetch).toHaveBeenCalledWith('/api/roles', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        id: 'workflow_admin',
        name: 'Workflow Admin',
        permissions: ['attendance:read'],
      }),
    }))
    expect(container.textContent).toContain('角色已创建')
    expect(container.textContent).toContain('Workflow Admin')
    unmount()
  })

  it('deletes an existing role after confirmation', async () => {
    setupApiMocks({
      rolesResponses: [
        createMockResponse({
          ok: true,
          data: { items: sampleRoles },
        }),
        createMockResponse({
          ok: true,
          data: { items: [] },
        }),
      ],
    })

    const { container, unmount } = mountRoleManagement()
    await flushPromises()
    await nextTick()

    const roleButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Attendance Admin'))
    expect(roleButton).not.toBeNull()
    roleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await nextTick()

    const deleteButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('删除角色'))
    expect(deleteButton).not.toBeNull()
    deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    expect(globalThis.confirm).toHaveBeenCalled()
    expect(apiModule.apiFetch).toHaveBeenCalledWith('/api/roles/attendance_admin', expect.objectContaining({
      method: 'DELETE',
    }))
    expect(container.textContent).toContain('角色已删除')
    unmount()
  })
})
