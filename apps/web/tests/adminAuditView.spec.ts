import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import AdminAuditView from '../src/views/AdminAuditView.vue'
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

function mountAdminAudit() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(AdminAuditView)
  app.component('router-link', {
    props: ['to'],
    template: '<a><slot /></a>',
  })
  app.mount(container)

  return {
    container,
    unmount: () => {
      app.unmount()
      container.remove()
    },
  }
}

describe('AdminAuditView', () => {
  beforeEach(() => {
    vi.mocked(apiModule.apiFetch).mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('shows top-level error message when audit activity loading fails', async () => {
    vi.mocked(apiModule.apiFetch).mockImplementation((url: string) => {
      if (url.startsWith('/api/admin/audit-activity?')) {
        return Promise.resolve(createMockResponse({ error: { message: 'audit activity blocked' } }, 500, false))
      }

      if (url.startsWith('/api/admin/session-revocations?')) {
        return Promise.resolve(
          createMockResponse({
            ok: true,
            data: {
              items: [],
              total: 0,
              page: 1,
            },
          }),
        )
      }

      return Promise.reject(new Error(`Unexpected apiFetch call: ${url}`))
    })

    const { container, unmount } = mountAdminAudit()
    await flushPromises()
    await nextTick()

    const status = container.querySelector('.admin-audit__status')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('audit activity blocked')
    unmount()
  })
})
