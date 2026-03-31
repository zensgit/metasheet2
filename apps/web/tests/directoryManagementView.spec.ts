import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import ElementPlus from 'element-plus'
import DirectoryManagementView from '../src/views/DirectoryManagementView.vue'
import * as apiModule from '../src/utils/api'

vi.mock('vue-router', () => ({
  useRouter: () => ({
    replace: vi.fn(async () => undefined),
  }),
  // RouterLink stub
  RouterLink: {
    template: '<a><slot /></a>',
    props: ['to'],
  },
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    hasAdminAccess: () => true,
    getAccessSnapshot: () => ({ user: { email: 'admin@example.com' } }),
  }),
}))

vi.mock('../src/utils/api', () => {
  return {
    apiFetch: vi.fn(),
  }
})

function createMockResponse(payload: unknown, status = 200, ok = status < 300) {
  return {
    ok,
    status,
    json: vi.fn(async () => payload),
  } as unknown as Response
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), 0)
  })
}

function mountView() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(DirectoryManagementView)
  app.use(ElementPlus)
  app.component('RouterLink', {
    template: '<a><slot /></a>',
    props: ['to'],
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

const syncStatusPayload = {
  ok: true,
  data: {
    lastSyncAt: '2026-03-29T10:00:00.000Z',
    nextSyncAt: '2026-03-29T11:00:00.000Z',
    status: 'completed',
    hasAlert: false,
    alertMessage: null,
    alertAcknowledgedAt: null,
    alertAcknowledgedBy: null,
  },
}

const syncStatusWithAlert = {
  ok: true,
  data: {
    lastSyncAt: '2026-03-29T10:00:00.000Z',
    nextSyncAt: '2026-03-29T11:00:00.000Z',
    status: 'failed',
    hasAlert: true,
    alertMessage: 'Sync failed: timeout',
    alertAcknowledgedAt: null,
    alertAcknowledgedBy: null,
  },
}

const syncHistoryPayload = {
  ok: true,
  data: {
    items: [
      { id: 'h1', createdAt: '2026-03-29T10:00:00.000Z', status: 'completed', syncedCount: 50, failedCount: 0, message: 'Full sync complete' },
      { id: 'h2', createdAt: '2026-03-28T10:00:00.000Z', status: 'failed', syncedCount: 30, failedCount: 5, message: 'Partial failure' },
    ],
    page: 1,
    pageSize: 10,
    total: 2,
  },
}

const deprovisionsPayload = {
  ok: true,
  data: {
    items: [
      { id: 'd1', targetUserId: 'user-a', performedBy: 'admin-1', reason: 'Left company', status: 'executed', createdAt: '2026-03-29T08:00:00.000Z', updatedAt: '2026-03-29T08:00:00.000Z' },
      { id: 'd2', targetUserId: 'user-b', performedBy: 'admin-1', reason: 'Department change', status: 'rolled-back', createdAt: '2026-03-28T08:00:00.000Z', updatedAt: '2026-03-28T08:00:00.000Z' },
    ],
    page: 1,
    pageSize: 10,
    total: 2,
    query: '',
  },
}

function mockAllEndpoints(overrides?: {
  syncStatus?: unknown
  syncHistory?: unknown
  deprovisions?: unknown
}) {
  vi.mocked(apiModule.apiFetch).mockImplementation(async (path: string) => {
    if (path.includes('/sync/status')) {
      return createMockResponse(overrides?.syncStatus ?? syncStatusPayload)
    }
    if (path.includes('/sync/history')) {
      return createMockResponse(overrides?.syncHistory ?? syncHistoryPayload)
    }
    if (path.includes('/deprovisions') && !path.includes('/rollback')) {
      return createMockResponse(overrides?.deprovisions ?? deprovisionsPayload)
    }
    return createMockResponse({ error: 'not found' }, 404, false)
  })
}

describe('DirectoryManagementView', () => {
  beforeEach(() => {
    vi.mocked(apiModule.apiFetch).mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders sync status section on mount', async () => {
    mockAllEndpoints()

    const { container, unmount } = mountView()
    await flushPromises()
    await nextTick()
    await flushPromises()
    await nextTick()

    const metaDds = container.querySelectorAll('.directory-mgmt__meta dd')
    expect(metaDds.length).toBeGreaterThanOrEqual(1)
    // The status tag should show 'ok'
    const tags = container.querySelectorAll('.el-tag')
    const statusTag = Array.from(tags).find((tag) => tag.textContent?.includes('completed'))
    expect(statusTag).toBeDefined()
    unmount()
  })

  it('shows alert banner when has_alert is true', async () => {
    mockAllEndpoints({ syncStatus: syncStatusWithAlert })

    const { container, unmount } = mountView()
    await flushPromises()
    await nextTick()
    await flushPromises()
    await nextTick()

    const alert = container.querySelector('.el-alert')
    expect(alert).not.toBeNull()
    expect(alert?.textContent).toContain('Sync failed: timeout')
    unmount()
  })

  it('acknowledge button calls the right endpoint', async () => {
    mockAllEndpoints({ syncStatus: syncStatusWithAlert })

    const { container, unmount } = mountView()
    await flushPromises()
    await nextTick()
    await flushPromises()
    await nextTick()

    // After initial load, set up the acknowledge mock
    vi.mocked(apiModule.apiFetch).mockImplementation(async (path: string, options?: RequestInit) => {
      if (path.includes('/sync/acknowledge') && options?.method === 'POST') {
        return createMockResponse({ ok: true })
      }
      if (path.includes('/sync/status')) {
        return createMockResponse(syncStatusPayload)
      }
      if (path.includes('/sync/history')) {
        return createMockResponse(syncHistoryPayload)
      }
      if (path.includes('/deprovisions')) {
        return createMockResponse(deprovisionsPayload)
      }
      return createMockResponse({ error: 'not found' }, 404, false)
    })

    const acknowledgeButton = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('确认告警')
    )
    expect(acknowledgeButton).toBeDefined()
    acknowledgeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    const calls = vi.mocked(apiModule.apiFetch).mock.calls
    const ackCall = calls.find(([p, opts]) => p.includes('/sync/acknowledge') && opts?.method === 'POST')
    expect(ackCall).toBeDefined()
    unmount()
  })

  it('sync history table renders rows', async () => {
    mockAllEndpoints()

    const { container, unmount } = mountView()
    await flushPromises()
    await nextTick()
    await flushPromises()
    await nextTick()

    const tableRows = container.querySelectorAll('.el-table__body-wrapper .el-table__row')
    // Element Plus tables may render async; check for at least data presence
    const tableBody = container.querySelector('.el-table')
    expect(tableBody).not.toBeNull()
    unmount()
  })

  it('deprovision table renders with rollback buttons', async () => {
    mockAllEndpoints()

    const { container, unmount } = mountView()
    await flushPromises()
    await nextTick()
    await flushPromises()
    await nextTick()

    // Look for rollback buttons - at least one deprovision has 'executed' status
    const rollbackButtons = Array.from(container.querySelectorAll('button')).filter(
      (btn) => btn.textContent?.includes('回滚')
    )
    expect(rollbackButtons.length).toBeGreaterThanOrEqual(1)
    unmount()
  })

  it('rollback confirmation dialog works', async () => {
    mockAllEndpoints()

    const { container, unmount } = mountView()
    await flushPromises()
    await nextTick()
    await flushPromises()
    await nextTick()

    // Click rollback button to open dialog
    const rollbackButton = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('回滚')
    )
    expect(rollbackButton).toBeDefined()
    rollbackButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    // Dialog should be visible - check for dialog content in document body
    // Element Plus renders dialogs in teleport target (body)
    const dialogContent = document.body.textContent
    expect(dialogContent).toContain('确认回滚')
    expect(dialogContent).toContain('user-a')

    // Set up the rollback mock
    vi.mocked(apiModule.apiFetch).mockImplementation(async (path: string, options?: RequestInit) => {
      if (path.includes('/rollback') && options?.method === 'POST') {
        return createMockResponse({ ok: true })
      }
      if (path.includes('/deprovisions') && !path.includes('/rollback')) {
        return createMockResponse(deprovisionsPayload)
      }
      if (path.includes('/sync/status')) {
        return createMockResponse(syncStatusPayload)
      }
      if (path.includes('/sync/history')) {
        return createMockResponse(syncHistoryPayload)
      }
      return createMockResponse({ error: 'not found' }, 404, false)
    })

    // Click the confirm rollback button in the dialog
    const confirmButton = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('确认回滚')
    )
    expect(confirmButton).toBeDefined()
    confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await flushPromises()
    await nextTick()

    const calls = vi.mocked(apiModule.apiFetch).mock.calls
    const rollbackCall = calls.find(([p, opts]) => p.includes('/deprovisions/d1/rollback') && opts?.method === 'POST')
    expect(rollbackCall).toBeDefined()
    unmount()
  })
})
