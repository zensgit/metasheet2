import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import AfterSalesView from '../src/views/AfterSalesView.vue'

const apiFetchMock = vi.hoisted(() => vi.fn())

vi.mock('../src/utils/api', () => ({
  apiFetch: apiFetchMock,
}))

function createResponse(payload: unknown, options: { ok?: boolean; status?: number; statusText?: string } = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    json: async () => ({
      ok: options.ok ?? true,
      data: payload,
      error: payload && typeof payload === 'object' && 'error' in payload ? (payload as { error?: unknown }).error : undefined,
    }),
  } as Response
}

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function waitForText(container: HTMLElement, text: string, cycles = 24): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    if (container.textContent?.includes(text)) {
      return
    }
    await flushUi(1)
  }

  throw new Error(`Timed out waiting for text: ${text}`)
}

function mountAfterSalesView() {
  const container = document.createElement('div')
  document.body.appendChild(container)

  const app = createApp(AfterSalesView)
  app.mount(container)

  return { app, container }
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(label))
  if (!button) {
    throw new Error(`Button with label ${label} not found`)
  }
  return button as HTMLButtonElement
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushUi()
}

async function setSelectValue(select: HTMLSelectElement, value: string): Promise<void> {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await flushUi()
}

async function setTextareaValue(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  textarea.value = value
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await flushUi()
}

describe('AfterSalesView service records panel', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    apiFetchMock.mockReset()
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  it('loads service records only when installed and preserves config draft across refresh', async () => {
    let currentCall = 0

    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [],
          workflows: [],
        })
      }

      if (path === '/api/after-sales/projects/current') {
        currentCall += 1
        return createResponse({
          status: 'installed',
          projectId: 'tenant:after-sales',
          displayName: currentCall === 1 ? 'After Sales' : 'After Sales v2',
          config: {
            defaultSlaHours: currentCall === 1 ? 24 : 36,
            urgentSlaHours: 4,
            followUpAfterDays: 7,
          },
          installResult: {
            status: 'installed',
            createdObjects: [],
            createdViews: [],
            warnings: [],
            reportRef: `install-00${currentCall}`,
          },
          reportRef: `install-00${currentCall}`,
        })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          serviceRecords: [
            {
              id: 'sr-001',
              version: 1,
              data: {
                ticketNo: 'AF-SR-001',
                visitType: 'onsite',
                scheduledAt: '2026-04-09T08:00:00.000Z',
                completedAt: '2026-04-09T09:30:00.000Z',
                technicianName: '张三',
                workSummary: '已完成压缩机检查与阀门更换',
                result: 'done',
              },
            },
          ],
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'AF-SR-001')

    expect(container.textContent).toContain('Recent visits')
    expect(container.textContent).toContain('AF-SR-001')
    expect(container.textContent).toContain('onsite')
    expect(container.textContent).toContain('张三')
    expect(container.textContent).toContain('已完成压缩机检查与阀门更换')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/service-records', undefined)

    const configInput = container.querySelector<HTMLInputElement>('input[type="number"]')
    expect(configInput).toBeTruthy()
    if (!configInput) return

    await setInputValue(configInput, '99')
    expect(configInput.value).toBe('99')

    findButton(container, 'Refresh').click()
    await waitForText(container, 'After Sales v2')
    expect(configInput.value).toBe('99')
  })

  it('shows an inline error for service-records failures without blocking the rest of the page', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [],
          workflows: [],
        })
      }

      if (path === '/api/after-sales/projects/current') {
        return createResponse({
          status: 'installed',
          projectId: 'tenant:after-sales',
          displayName: 'After Sales',
          config: {
            defaultSlaHours: 24,
            urgentSlaHours: 4,
            followUpAfterDays: 7,
          },
          installResult: {
            status: 'installed',
            createdObjects: [],
            createdViews: [],
            warnings: [],
            reportRef: 'install-001',
          },
          reportRef: 'install-001',
        })
      }

      if (path === '/api/after-sales/service-records') {
        throw new Error('service records unavailable')
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'service records unavailable')

    expect(container.textContent).toContain('Install state')
    expect(container.textContent).toContain('Service records')
    expect(container.textContent).toContain('service records unavailable')
    expect(container.textContent).toContain('Statusinstalled')
  })

  it('creates a service record inline and prepends it without refreshing the page', async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [],
          workflows: [],
        })
      }

      if (path === '/api/after-sales/projects/current') {
        return createResponse({
          status: 'installed',
          projectId: 'tenant:after-sales',
          displayName: 'After Sales',
          config: {
            defaultSlaHours: 24,
            urgentSlaHours: 4,
            followUpAfterDays: 7,
          },
          installResult: {
            status: 'installed',
            createdObjects: [],
            createdViews: [],
            warnings: [],
            reportRef: 'install-101',
          },
          reportRef: 'install-101',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          tickets: [
            {
              id: 'ticket-100',
              version: 1,
              data: {
                ticketNo: 'AF-100',
                title: 'Compressor inspection',
                status: 'open',
                refundStatus: 'approved',
                refundAmount: 0,
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/service-records' && (!init || !init.method)) {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          serviceRecords: [
            {
              id: 'sr-existing',
              version: 1,
              data: {
                ticketNo: 'AF-001',
                visitType: 'onsite',
                scheduledAt: '2026-04-09T08:00:00.000Z',
                technicianName: '张三',
                workSummary: 'Old visit still visible',
                result: 'resolved',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/service-records' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body ?? '{}'))).toEqual({
          serviceRecord: {
            ticketNo: 'AF-100',
            visitType: 'remote',
            scheduledAt: '2026-04-10T09:15',
            technicianName: 'Alex',
            workSummary: 'Replaced control board',
            result: 'resolved',
          },
        })

        return createResponse(
          {
            projectId: 'tenant:after-sales',
            serviceRecord: {
              id: 'sr-new',
              version: 1,
              data: {
                ticketNo: 'AF-100',
                visitType: 'remote',
                scheduledAt: '2026-04-10T09:15',
                technicianName: 'Alex',
                workSummary: 'Replaced control board',
                result: 'resolved',
              },
            },
            event: { accepted: true, event: 'service.recorded' },
          },
          { status: 201 },
        )
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'Old visit still visible')

    const ticketInput = container.querySelector<HTMLInputElement>('#after-sales-service-record-ticket-no')
    const visitTypeSelect = container.querySelector<HTMLSelectElement>('#after-sales-service-record-visit-type')
    const scheduledAtInput = container.querySelector<HTMLInputElement>('#after-sales-service-record-scheduled-at')
    const technicianInput = container.querySelector<HTMLInputElement>('#after-sales-service-record-technician')
    const resultSelect = container.querySelector<HTMLSelectElement>('#after-sales-service-record-result')
    const summaryTextarea = container.querySelector<HTMLTextAreaElement>('#after-sales-service-record-summary')

    expect(ticketInput).toBeTruthy()
    expect(visitTypeSelect).toBeTruthy()
    expect(scheduledAtInput).toBeTruthy()
    expect(technicianInput).toBeTruthy()
    expect(resultSelect).toBeTruthy()
    expect(summaryTextarea).toBeTruthy()
    if (!ticketInput || !visitTypeSelect || !scheduledAtInput || !technicianInput || !resultSelect || !summaryTextarea) return

    await setInputValue(ticketInput, 'AF-100')
    await setSelectValue(visitTypeSelect, 'remote')
    await setInputValue(scheduledAtInput, '2026-04-10T09:15')
    await setInputValue(technicianInput, 'Alex')
    await setSelectValue(resultSelect, 'resolved')
    await setTextareaValue(summaryTextarea, 'Replaced control board')

    findButton(container, 'Create service record').click()

    await waitForText(container, 'Created service record for AF-100')

    expect(container.textContent).toContain('Replaced control board')
    expect(container.textContent).toContain('Old visit still visible')
    expect(ticketInput.value).toBe('')
    expect(summaryTextarea.value).toBe('')

    const serviceRecordCalls = apiFetchMock.mock.calls.filter((call) => call[0] === '/api/after-sales/service-records')
    expect(serviceRecordCalls).toHaveLength(2)
    expect(serviceRecordCalls[1]?.[1]).toMatchObject({ method: 'POST' })
  })

  it('deletes a service record inline and removes it from the current list', async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [],
          workflows: [],
        })
      }

      if (path === '/api/after-sales/projects/current') {
        return createResponse({
          status: 'installed',
          projectId: 'tenant:after-sales',
          displayName: 'After Sales',
          config: {
            defaultSlaHours: 24,
            urgentSlaHours: 4,
            followUpAfterDays: 7,
          },
          installResult: {
            status: 'installed',
            createdObjects: [],
            createdViews: [],
            warnings: [],
            reportRef: 'install-103',
          },
          reportRef: 'install-103',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          tickets: [],
        })
      }

      if (path === '/api/after-sales/service-records' && (!init || !init.method)) {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 2,
          serviceRecords: [
            {
              id: 'sr-delete',
              version: 1,
              data: {
                ticketNo: 'AF-DELETE',
                visitType: 'onsite',
                scheduledAt: '2026-04-09T08:00:00.000Z',
                technicianName: 'Alex',
                workSummary: 'Delete me',
                result: 'resolved',
              },
            },
            {
              id: 'sr-keep',
              version: 1,
              data: {
                ticketNo: 'AF-KEEP',
                visitType: 'remote',
                scheduledAt: '2026-04-09T09:00:00.000Z',
                technicianName: 'Jamie',
                workSummary: 'Keep me',
                result: 'partial',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/service-records/sr-delete' && init?.method === 'DELETE') {
        return createResponse({
          projectId: 'tenant:after-sales',
          serviceRecordId: 'sr-delete',
          version: 4,
          deleted: true,
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'Delete me')

    const deleteButton = container.querySelector<HTMLButtonElement>('button[aria-label="Delete service record AF-DELETE"]')
    expect(deleteButton).toBeTruthy()
    if (!deleteButton) return

    deleteButton.click()

    await waitForText(container, 'Deleted service record for AF-DELETE')

    expect(container.textContent).not.toContain('Delete me')
    expect(container.textContent).toContain('Keep me')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/service-records/sr-delete', { method: 'DELETE' })
  })

  it('surfaces create errors inline without clearing existing service records', async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [],
          workflows: [],
        })
      }

      if (path === '/api/after-sales/projects/current') {
        return createResponse({
          status: 'installed',
          projectId: 'tenant:after-sales',
          displayName: 'After Sales',
          config: {
            defaultSlaHours: 24,
            urgentSlaHours: 4,
            followUpAfterDays: 7,
          },
          installResult: {
            status: 'installed',
            createdObjects: [],
            createdViews: [],
            warnings: [],
            reportRef: 'install-102',
          },
          reportRef: 'install-102',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          tickets: [],
        })
      }

      if (path === '/api/after-sales/service-records' && (!init || !init.method)) {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          serviceRecords: [
            {
              id: 'sr-existing',
              version: 1,
              data: {
                ticketNo: 'AF-002',
                visitType: 'onsite',
                scheduledAt: '2026-04-09T08:00:00.000Z',
                technicianName: '李四',
                workSummary: 'Existing service record',
                result: 'partial',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/service-records' && init?.method === 'POST') {
        return createResponse(
          {
            error: {
              code: 'NOT_FOUND',
              message: 'After-sales ticket AF-404 not found',
            },
          },
          { ok: false, status: 404, statusText: 'Not Found' },
        )
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'Existing service record')

    const ticketInput = container.querySelector<HTMLInputElement>('#after-sales-service-record-ticket-no')
    const scheduledAtInput = container.querySelector<HTMLInputElement>('#after-sales-service-record-scheduled-at')
    const technicianInput = container.querySelector<HTMLInputElement>('#after-sales-service-record-technician')

    expect(ticketInput).toBeTruthy()
    expect(scheduledAtInput).toBeTruthy()
    expect(technicianInput).toBeTruthy()
    if (!ticketInput || !scheduledAtInput || !technicianInput) return

    await setInputValue(ticketInput, 'AF-404')
    await setInputValue(scheduledAtInput, '2026-04-10T09:15')
    await setInputValue(technicianInput, 'Alex')

    findButton(container, 'Create service record').click()

    await waitForText(container, 'After-sales ticket AF-404 not found')

    expect(container.textContent).toContain('Existing service record')
    expect(container.textContent).toContain('After-sales ticket AF-404 not found')
    expect(ticketInput.value).toBe('AF-404')
    expect(scheduledAtInput.value).toBe('2026-04-10T09:15')
    expect(technicianInput.value).toBe('Alex')
  })

  it('surfaces delete errors inline without clearing existing service records', async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [],
          workflows: [],
        })
      }

      if (path === '/api/after-sales/projects/current') {
        return createResponse({
          status: 'installed',
          projectId: 'tenant:after-sales',
          displayName: 'After Sales',
          config: {
            defaultSlaHours: 24,
            urgentSlaHours: 4,
            followUpAfterDays: 7,
          },
          installResult: {
            status: 'installed',
            createdObjects: [],
            createdViews: [],
            warnings: [],
            reportRef: 'install-104',
          },
          reportRef: 'install-104',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          tickets: [],
        })
      }

      if (path === '/api/after-sales/service-records' && (!init || !init.method)) {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          serviceRecords: [
            {
              id: 'sr-delete-error',
              version: 1,
              data: {
                ticketNo: 'AF-DELETE-ERR',
                visitType: 'onsite',
                scheduledAt: '2026-04-09T08:00:00.000Z',
                technicianName: 'Alex',
                workSummary: 'Still visible after delete failure',
                result: 'resolved',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/service-records/sr-delete-error' && init?.method === 'DELETE') {
        return createResponse(
          {
            error: {
              code: 'NOT_FOUND',
              message: 'Service record already deleted',
            },
          },
          { ok: false, status: 404, statusText: 'Not Found' },
        )
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'Still visible after delete failure')

    const deleteButton = container.querySelector<HTMLButtonElement>('button[aria-label="Delete service record AF-DELETE-ERR"]')
    expect(deleteButton).toBeTruthy()
    if (!deleteButton) return

    deleteButton.click()

    await waitForText(container, 'Service record already deleted')

    expect(container.textContent).toContain('Still visible after delete failure')
    expect(container.textContent).toContain('Service record already deleted')
  })

  it('skips service-records loading before install and keeps the install CTA visible', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [],
          workflows: [],
        })
      }

      if (path === '/api/after-sales/projects/current') {
        return createResponse({
          status: 'not-installed',
        })
      }

      if (path === '/api/after-sales/service-records') {
        throw new Error('service-records should not load before install')
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await flushUi(4)

    expect(container.textContent).toContain('Enable After Sales')
    expect(container.textContent).not.toContain('Service records')
    expect(container.textContent).not.toContain('Create service record')
    expect(apiFetchMock).not.toHaveBeenCalledWith('/api/after-sales/service-records', undefined)
  })

  it('keeps the service-records panel active in partial state', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [],
          workflows: [],
        })
      }

      if (path === '/api/after-sales/projects/current') {
        return createResponse({
          status: 'partial',
          projectId: 'tenant:after-sales',
          displayName: 'After Sales',
          config: {
            defaultSlaHours: 24,
            urgentSlaHours: 4,
            followUpAfterDays: 7,
          },
          installResult: {
            status: 'partial',
            createdObjects: [],
            createdViews: [],
            warnings: ['serviceRecord view missing'],
            reportRef: 'install-002',
          },
          reportRef: 'install-002',
        })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          serviceRecords: [
            {
              id: 'sr-partial',
              version: 1,
              data: {
                ticketNo: 'AF-SR-Partial',
                visitType: 'remote',
                scheduledAt: '2026-04-09T08:00:00.000Z',
                technicianName: 'Alex',
                workSummary: 'Remote triage',
                result: 'partial',
              },
            },
          ],
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'AF-SR-Partial')

    expect(container.textContent).toContain('Recent visits')
    expect(container.textContent).toContain('Create service record')
    expect(container.textContent).toContain('Remote triage')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/service-records', undefined)
  })

  it('allows creating a service record while install state is partial', async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [],
          workflows: [],
        })
      }

      if (path === '/api/after-sales/projects/current') {
        return createResponse({
          status: 'partial',
          projectId: 'tenant:after-sales',
          displayName: 'After Sales',
          config: {
            defaultSlaHours: 24,
            urgentSlaHours: 4,
            followUpAfterDays: 7,
          },
          installResult: {
            status: 'partial',
            createdObjects: [],
            createdViews: [],
            warnings: ['serviceRecord view missing'],
            reportRef: 'install-004',
          },
          reportRef: 'install-004',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          tickets: [
            {
              id: 'ticket-partial-1',
              version: 1,
              data: {
                ticketNo: 'AF-PARTIAL-1',
                title: 'Partial-state visit',
                status: 'open',
                refundStatus: 'approved',
                refundAmount: 0,
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/service-records' && (!init || !init.method)) {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          serviceRecords: [
            {
              id: 'sr-partial-existing',
              version: 1,
              data: {
                ticketNo: 'AF-OLD',
                visitType: 'onsite',
                scheduledAt: '2026-04-09T08:00:00.000Z',
                technicianName: 'Alex',
                workSummary: 'Partial-state baseline',
                result: 'partial',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/service-records' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body ?? '{}'))).toEqual({
          serviceRecord: {
            ticketNo: 'AF-PARTIAL-1',
            visitType: 'pickup',
            scheduledAt: '2026-04-11T10:00',
            workSummary: 'Pickup arranged in partial state',
            result: 'partial',
          },
        })

        return createResponse(
          {
            projectId: 'tenant:after-sales',
            serviceRecord: {
              id: 'sr-partial-new',
              version: 1,
              data: {
                ticketNo: 'AF-PARTIAL-1',
                visitType: 'pickup',
                scheduledAt: '2026-04-11T10:00',
                workSummary: 'Pickup arranged in partial state',
                result: 'partial',
              },
            },
          },
          { status: 201 },
        )
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'Partial-state baseline')

    const ticketInput = container.querySelector<HTMLInputElement>('#after-sales-service-record-ticket-no')
    const visitTypeSelect = container.querySelector<HTMLSelectElement>('#after-sales-service-record-visit-type')
    const scheduledAtInput = container.querySelector<HTMLInputElement>('#after-sales-service-record-scheduled-at')
    const resultSelect = container.querySelector<HTMLSelectElement>('#after-sales-service-record-result')
    const summaryTextarea = container.querySelector<HTMLTextAreaElement>('#after-sales-service-record-summary')

    expect(ticketInput).toBeTruthy()
    expect(visitTypeSelect).toBeTruthy()
    expect(scheduledAtInput).toBeTruthy()
    expect(resultSelect).toBeTruthy()
    expect(summaryTextarea).toBeTruthy()
    if (!ticketInput || !visitTypeSelect || !scheduledAtInput || !resultSelect || !summaryTextarea) return

    await setInputValue(ticketInput, 'AF-PARTIAL-1')
    await setSelectValue(visitTypeSelect, 'pickup')
    await setInputValue(scheduledAtInput, '2026-04-11T10:00')
    await setSelectValue(resultSelect, 'partial')
    await setTextareaValue(summaryTextarea, 'Pickup arranged in partial state')

    findButton(container, 'Create service record').click()

    await waitForText(container, 'Created service record for AF-PARTIAL-1')

    expect(container.textContent).toContain('Pickup arranged in partial state')
    expect(container.textContent).toContain('Partial-state baseline')
    expect(container.textContent).toContain('Initialization completed with warnings')
  })

  it('skips service-record loading when install state is failed', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [],
          workflows: [],
        })
      }

      if (path === '/api/after-sales/projects/current') {
        return createResponse({
          status: 'failed',
          projectId: 'tenant:after-sales',
          displayName: 'After Sales',
          config: {
            defaultSlaHours: 24,
            urgentSlaHours: 4,
            followUpAfterDays: 7,
          },
          installResult: {
            status: 'failed',
            createdObjects: [],
            createdViews: [],
            warnings: ['service record provisioning failed'],
            reportRef: 'install-003',
          },
          reportRef: 'install-003',
        })
      }

      if (path === '/api/after-sales/service-records') {
        throw new Error('service-records should not load for failed install state')
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await flushUi(4)

    expect(container.textContent).not.toContain('Recent visits')
    expect(container.textContent).not.toContain('Create service record')
    expect(apiFetchMock).not.toHaveBeenCalledWith('/api/after-sales/service-records', undefined)
  })
})
