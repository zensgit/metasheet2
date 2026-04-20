import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdminAuditView from '../src/views/AdminAuditView.vue'

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

async function flushUi(cycles = 6): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function createJsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    blob: async () => new Blob([''], { type: 'text/csv' }),
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === 'content-disposition') return 'attachment; filename="audit-logs.csv"'
        return null
      },
    },
  }
}

function registerRouterLink(app: App<Element>): void {
  app.component('RouterLink', {
    props: ['to'],
    template: '<a><slot /></a>',
  })
}

function createLogItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'log-1',
    occurred_at: '2026-04-08T01:00:00.000Z',
    actor_id: 'actor-42',
    actor_type: 'admin',
    action: 'grant',
    resource_type: 'user-role',
    resource_id: 'user-100',
    request_id: 'req-abc',
    ip: '10.0.0.42',
    user_agent: 'Mozilla/5.0',
    meta: { roleId: 'role-1', reason: '上岗授权' },
    route: 'POST /api/admin/user-roles',
    status_code: 200,
    latency_ms: 42,
    ...overrides,
  }
}

function createListPayload(items: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      items,
      total: items.length,
      page: 1,
      pageSize: 20,
      ...overrides,
    },
  }
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(text)) as HTMLButtonElement | undefined
}

function getLastFetchUrl(): string {
  const calls = apiFetchMock.mock.calls
  const last = calls[calls.length - 1]
  return typeof last?.[0] === 'string' ? String(last[0]) : ''
}

describe('AdminAuditView', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  const originalCreateObjectURL = globalThis.URL.createObjectURL
  const originalRevokeObjectURL = globalThis.URL.revokeObjectURL

  beforeEach(() => {
    apiFetchMock.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-url')
    globalThis.URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    globalThis.URL.createObjectURL = originalCreateObjectURL
    globalThis.URL.revokeObjectURL = originalRevokeObjectURL
  })

  it('loads audit logs from /api/audit-logs on mount', async () => {
    apiFetchMock.mockResolvedValueOnce(createJsonResponse(createListPayload([
      createLogItem({ action: 'create', resource_type: 'user', resource_id: 'user-100', actor_id: 'admin-1' }),
      createLogItem({ id: 'log-2', action: 'revoke', resource_type: 'user-session', resource_id: 'user-200', actor_id: 'admin-2' }),
    ], { total: 2 })))

    app = createApp(AdminAuditView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi()

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const url = String(apiFetchMock.mock.calls[0]?.[0] || '')
    expect(url.startsWith('/api/audit-logs?')).toBe(true)
    expect(url).toContain('page=1')
    expect(url).toContain('pageSize=20')

    expect(container?.textContent).toContain('操作审计日志')
    expect(container?.textContent).toContain('admin-1')
    expect(container?.textContent).toContain('create')
    expect(container?.textContent).toContain('user-100')
    expect(container?.textContent).toContain('user-session')
    // session revocation placeholder is rendered (no network call)
    expect(container?.textContent).toContain('暂未提供后端数据源')
  })

  it('renders empty state when the API returns no items', async () => {
    apiFetchMock.mockResolvedValueOnce(createJsonResponse(createListPayload([], { total: 0 })))

    app = createApp(AdminAuditView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi()

    expect(container?.textContent).toContain('暂无审计日志')
  })

  it('rebuilds the query string when resource/action/date filters are applied', async () => {
    apiFetchMock.mockResolvedValue(createJsonResponse(createListPayload([createLogItem()], { total: 1 })))

    app = createApp(AdminAuditView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi()

    // Initial mount call happened; now set filters and click 刷新.
    const resourceSelect = container?.querySelectorAll('select')[0] as HTMLSelectElement
    const actionSelect = container?.querySelectorAll('select')[1] as HTMLSelectElement
    const dateInputs = container?.querySelectorAll('input[type="date"]') as NodeListOf<HTMLInputElement>
    const actorInput = container?.querySelectorAll('input[type="search"]')[1] as HTMLInputElement

    resourceSelect.value = 'user-role'
    resourceSelect.dispatchEvent(new Event('change'))
    actionSelect.value = 'grant'
    actionSelect.dispatchEvent(new Event('change'))
    dateInputs[0].value = '2026-04-01'
    dateInputs[0].dispatchEvent(new Event('input'))
    dateInputs[1].value = '2026-04-15'
    dateInputs[1].dispatchEvent(new Event('input'))
    actorInput.value = 'admin-42'
    actorInput.dispatchEvent(new Event('input'))
    await flushUi(2)

    const refreshBtn = findButtonByText(container!, '刷新')
    expect(refreshBtn).toBeTruthy()
    refreshBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    const url = getLastFetchUrl()
    expect(url.startsWith('/api/audit-logs?')).toBe(true)
    expect(url).toContain('resourceType=user-role')
    expect(url).toContain('action=grant')
    expect(url).toContain('actorId=admin-42')
    // Date inputs are translated to ISO 8601 bounds
    expect(url).toContain('from=2026-04-01T00%3A00%3A00.000Z')
    expect(url).toContain('to=2026-04-15T23%3A59%3A59.999Z')
    // Pagination always resets to page=1 on refresh
    expect(url).toContain('page=1')
  })

  it('advances page when 下一页 is clicked', async () => {
    // Total 60 items -> 3 pages of 20.
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse(createListPayload([createLogItem()], { total: 60 })))
      .mockResolvedValueOnce(createJsonResponse(createListPayload([createLogItem({ id: 'log-page-2' })], { total: 60, page: 2 })))

    app = createApp(AdminAuditView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi()

    expect(container?.textContent).toContain('第 1 / 3 页')

    const next = findButtonByText(container!, '下一页')
    expect(next).toBeTruthy()
    next?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    const url = getLastFetchUrl()
    expect(url).toContain('page=2')
    expect(container?.textContent).toContain('第 2 / 3 页')
  })

  it('hits the CSV export endpoint with format=csv and filter params', async () => {
    apiFetchMock
      // Initial load
      .mockResolvedValueOnce(createJsonResponse(createListPayload([createLogItem()], { total: 1 })))
      // CSV export call
      .mockResolvedValueOnce(createJsonResponse('id,occurred_at\nlog-1,2026-04-08T01:00:00.000Z\n'))

    app = createApp(AdminAuditView)
    registerRouterLink(app)
    app.mount(container!)
    await flushUi()

    // Apply a resource filter so it must propagate to the export URL.
    const resourceSelect = container?.querySelectorAll('select')[0] as HTMLSelectElement
    resourceSelect.value = 'user'
    resourceSelect.dispatchEvent(new Event('change'))
    await flushUi(2)

    const exportBtn = findButtonByText(container!, '导出 CSV')
    expect(exportBtn).toBeTruthy()
    exportBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi()

    // Last call should be the CSV export
    const url = getLastFetchUrl()
    expect(url.startsWith('/api/audit-logs?')).toBe(true)
    expect(url).toContain('format=csv')
    expect(url).toContain('limit=100000')
    expect(url).toContain('resourceType=user')
    const options = apiFetchMock.mock.calls[apiFetchMock.mock.calls.length - 1]?.[1] as Record<string, unknown> | undefined
    expect(options?.method).toBe('GET')

    expect(container?.textContent).toContain('审计日志 CSV 已导出')
  })
})
