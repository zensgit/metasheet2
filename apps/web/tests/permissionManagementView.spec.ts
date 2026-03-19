import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import PermissionManagementView from '../src/views/PermissionManagementView.vue'
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

function mountPermissionManagement() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(PermissionManagementView)
  app.mount(container)

  return {
    container,
    unmount: () => {
      app.unmount()
      container.remove()
    },
  }
}

const userId = 'user-1'
const encodedUserId = encodeURIComponent(userId)
const sampleUser = {
  id: userId,
  email: 'admin@example.com',
  name: 'Admin',
  role: 'admin',
  is_active: true,
  is_admin: true,
  last_login_at: '2026-03-01T00:00:00.000Z',
  created_at: '2026-03-01T00:00:00.000Z',
}

const samplePermissions = [
  { code: 'permission.read', name: '查看权限', description: 'Read permissions' },
  { code: 'permission.write', name: '编辑权限', description: 'Write permissions' },
]

const sampleTemplates = [
  {
    id: 'tpl-1',
    name: '平台管理员',
    description: 'Platform permission template',
    productMode: 'platform' as const,
    permissions: ['permission.read'],
    presetId: null,
    roleId: null,
  },
]

function setupApiMocks({
  usersResponse,
  permissionsResponse = createMockResponse({ ok: true, data: samplePermissions }),
  templatesResponse = createMockResponse({ ok: true, data: sampleTemplates }),
  userAccessResponse = createMockResponse({
    userId,
    permissions: ['permission.read'],
    isAdmin: true,
  }),
  grantResponse = createMockResponse({ ok: true, data: { ok: true } }),
  templateApplyResponse = createMockResponse({ ok: true, data: { ok: true } }),
}: {
  usersResponse: Response
  permissionsResponse?: Response
  templatesResponse?: Response
  userAccessResponse?: Response
  grantResponse?: Response
  templateApplyResponse?: Response
}) {
  vi.mocked(apiModule.apiFetch).mockImplementation((url: string) => {
    if (url === '/api/admin/users') {
      return Promise.resolve(usersResponse)
    }
    if (url === '/api/permissions') {
      return Promise.resolve(permissionsResponse)
    }
    if (url === '/api/admin/permission-templates' || url.startsWith('/api/admin/permission-templates?')) {
      return Promise.resolve(templatesResponse)
    }
    if (url === `/api/permissions/user/${encodedUserId}`) {
      return Promise.resolve(userAccessResponse)
    }
    if (url === '/api/permissions/grant') {
      return Promise.resolve(grantResponse)
    }
    if (url === '/api/admin/permission-templates/apply') {
      return Promise.resolve(templateApplyResponse)
    }
    return Promise.reject(new Error(`Unexpected apiFetch call: ${url}`))
  })
}

describe('PermissionManagementView', () => {
  beforeEach(() => {
    vi.mocked(apiModule.apiFetch).mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('shows nested data error when loading permissions catalog fails', async () => {
    setupApiMocks({
      usersResponse: createMockResponse({
        ok: true,
        data: {
          items: [sampleUser],
        },
      }),
      permissionsResponse: createMockResponse(
        { data: { error: 'permission catalog blocked' } },
        500,
        false,
      ),
    })

    const { container, unmount } = mountPermissionManagement()
    await flushPromises()
    await nextTick()

    const status = container.querySelector('.permission-admin__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('permission catalog blocked')
    unmount()
  })

  it('shows nested data error when loading permission templates fails', async () => {
    setupApiMocks({
      usersResponse: createMockResponse({
        ok: true,
        data: {
          items: [sampleUser],
        },
      }),
      templatesResponse: createMockResponse(
        { data: { error: 'permission templates unavailable' } },
        500,
        false,
      ),
    })

    const { container, unmount } = mountPermissionManagement()
    await flushPromises()
    await nextTick()

    const status = container.querySelector('.permission-admin__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('permission templates unavailable')
    unmount()
  })

  it('shows nested data error when loading selected user permission state fails', async () => {
    setupApiMocks({
      usersResponse: createMockResponse({
        ok: true,
        data: { items: [sampleUser] },
      }),
      userAccessResponse: createMockResponse(
        { data: { error: 'unable to load user permissions' } },
        500,
        false,
      ),
    })

    const { container, unmount } = mountPermissionManagement()
    await flushPromises()
    await nextTick()

    const status = container.querySelector('.permission-admin__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('unable to load user permissions')
    unmount()
  })

  it('shows nested data error when granting permission fails', async () => {
    setupApiMocks({
      usersResponse: createMockResponse({
        ok: true,
        data: { items: [sampleUser] },
      }),
      grantResponse: createMockResponse(
        { data: { error: 'grant denied for permission' } },
        500,
        false,
      ),
    })

    const { container, unmount } = mountPermissionManagement()
    await flushPromises()
    await nextTick()

    const grantSelectButton = container.querySelector('.permission-admin__link')
    expect(grantSelectButton).not.toBeNull()
    grantSelectButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    await nextTick()

    const grantButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('授予'),
    )
    expect(grantButton).not.toBeNull()
    grantButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    const status = container.querySelector('.permission-admin__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('grant denied for permission')
    unmount()
  })

  it('shows nested data error when template application fails', async () => {
    setupApiMocks({
      usersResponse: createMockResponse({
        ok: true,
        data: { items: [sampleUser] },
      }),
      templateApplyResponse: createMockResponse(
        { data: { error: 'template apply denied' } },
        500,
        false,
      ),
    })

    const { container, unmount } = mountPermissionManagement()
    await flushPromises()
    await nextTick()

    const templatePicker = Array.from(container.querySelectorAll('select'))
      .find((select) => Array.from(select.options).some((option) => option.value === 'tpl-1'))
    expect(templatePicker).not.toBeNull()
    expect(templatePicker).not.toBeUndefined()

    templatePicker.value = 'tpl-1'
    templatePicker.dispatchEvent(new Event('change'))
    await nextTick()

    const applyButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('按模板补齐'),
    )
    expect(applyButton).not.toBeNull()
    applyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    const status = container.querySelector('.permission-admin__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('template apply denied')
    unmount()
  })
})
