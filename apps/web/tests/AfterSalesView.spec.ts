import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import AfterSalesView from '../src/views/AfterSalesView.vue'

const apiFetchMock = vi.hoisted(() => vi.fn())

vi.mock('../src/utils/api', () => ({
  apiFetch: apiFetchMock,
}))

interface MockResponseOptions {
  ok?: boolean
  status?: number
  statusText?: string
}

function createResponse(payload: unknown, options: MockResponseOptions = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    json: async () => ({
      ok: options.ok ?? true,
      data: payload,
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

describe('AfterSalesView', () => {
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

  it('loads recent tickets and approval status once installed', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend', 'plugin-after-sales'],
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

      if (path === '/api/after-sales/tickets') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 2,
          tickets: [
            {
              id: 'ticket-1',
              version: 1,
              data: {
                ticketNo: 'AF-001',
                title: 'Install compressor',
                status: 'open',
                refundStatus: 'pending',
                refundAmount: 120.5,
              },
            },
            {
              id: 'ticket-2',
              version: 1,
              data: {
                ticketNo: 'AF-002',
                title: 'Return filter kit',
                status: 'closed',
                refundStatus: 'approved',
                refundAmount: 0,
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/tickets/ticket-1/refund-approval') {
        return createResponse({
          approval: {
            id: 'approval-1',
            status: 'approved',
            currentStep: 2,
            totalSteps: 3,
            updatedAt: '2026-04-09T06:00:00.000Z',
          },
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'AF-001')

    expect(container?.textContent).toContain('Recent tickets')
    expect(container?.textContent).toContain('AF-001')
    expect(container?.textContent).toContain('Install compressor')
    expect(container?.textContent).toContain('open')
    expect(container?.textContent).toContain('pending')
    expect(container?.textContent).toContain('¥120.50')
    expect(container?.textContent).toContain('approved step 2/3')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/tickets', undefined)
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/tickets/ticket-1/refund-approval', undefined)
  })

  it('refreshes current state and tickets without resetting the config draft', async () => {
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
            defaultSlaHours: currentCall === 1 ? 24 : 48,
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

      if (path === '/api/after-sales/tickets') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          tickets: [
            {
              id: 'ticket-1',
              version: 1,
              data: {
                ticketNo: 'AF-001',
                title: 'Install compressor',
                status: 'open',
                refundStatus: 'pending',
                refundAmount: 120.5,
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/tickets/ticket-1/refund-approval') {
        return createResponse({ approval: null })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'AF-001')

    const configInput = container?.querySelector<HTMLInputElement>('input[type="number"]')
    expect(configInput).toBeTruthy()
    if (!configInput) return

    await setInputValue(configInput, '99')
    expect(configInput.value).toBe('99')

    findButton(container, 'Refresh').click()
    await waitForText(container, 'After Sales v2')
    await waitForText(container, 'Approval unavailable')

    expect(configInput.value).toBe('99')
    expect(container?.textContent).toContain('After Sales v2')
    expect(container?.textContent).toContain('Approval unavailable')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/tickets', undefined)
  })

  it('creates a ticket, prepends it to the list, and resets the draft', async () => {
    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
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
            reportRef: 'install-004',
          },
          reportRef: 'install-004',
        })
      }

      if (path === '/api/after-sales/tickets' && !options?.method) {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          tickets: [
            {
              id: 'ticket-1',
              version: 1,
              data: {
                ticketNo: 'AF-001',
                title: 'Install compressor',
                status: 'open',
                refundStatus: '',
                refundAmount: 0,
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/tickets' && options?.method === 'POST') {
        return createResponse({
          projectId: 'tenant:after-sales',
          ticket: {
            id: 'ticket-created',
            version: 2,
            data: {
              ticketNo: 'AF-101',
              title: 'Broken condenser',
              status: 'new',
              refundStatus: '',
              refundAmount: 88.5,
            },
          },
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'AF-001')

    const ticketNoInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-no')
    const titleInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-title')
    const sourceSelect = container?.querySelector<HTMLSelectElement>('#after-sales-ticket-source')
    const refundInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-refund-amount')
    expect(ticketNoInput).toBeTruthy()
    expect(titleInput).toBeTruthy()
    expect(sourceSelect).toBeTruthy()
    expect(refundInput).toBeTruthy()
    if (!ticketNoInput || !titleInput || !sourceSelect || !refundInput) return

    await setInputValue(ticketNoInput, 'AF-101')
    await setInputValue(titleInput, 'Broken condenser')
    await setSelectValue(sourceSelect, 'phone')
    await setInputValue(refundInput, '88.5')

    findButton(container, 'Create ticket').click()
    await waitForText(container, 'Created ticket AF-101')

    expect(container?.textContent).toContain('Broken condenser')
    expect(ticketNoInput.value).toBe('')
    expect(titleInput.value).toBe('')
    expect(sourceSelect.value).toBe('web')
    expect(refundInput.value).toBe('')
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/after-sales/tickets',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          ticket: {
            ticketNo: 'AF-101',
            title: 'Broken condenser',
            priority: 'normal',
            source: 'phone',
            refundAmount: 88.5,
          },
        }),
      }),
    )
  })

  it('keeps the ticket draft and existing list when ticket creation fails', async () => {
    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
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
            reportRef: 'install-005',
          },
          reportRef: 'install-005',
        })
      }

      if (path === '/api/after-sales/tickets' && !options?.method) {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          tickets: [
            {
              id: 'ticket-1',
              version: 1,
              data: {
                ticketNo: 'AF-001',
                title: 'Install compressor',
                status: 'open',
                refundStatus: '',
                refundAmount: 0,
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/tickets' && options?.method === 'POST') {
        return createResponse(
          {
            message: 'Ticket number already exists',
          },
          {
            ok: false,
            status: 409,
            statusText: 'Conflict',
          },
        )
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'AF-001')

    const ticketNoInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-no')
    const titleInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-title')
    expect(ticketNoInput).toBeTruthy()
    expect(titleInput).toBeTruthy()
    if (!ticketNoInput || !titleInput) return

    await setInputValue(ticketNoInput, 'AF-001')
    await setInputValue(titleInput, 'Duplicate ticket')

    findButton(container, 'Create ticket').click()
    await waitForText(container, '409 Conflict')

    expect(ticketNoInput.value).toBe('AF-001')
    expect(titleInput.value).toBe('Duplicate ticket')
    expect(container?.textContent).toContain('Install compressor')
    expect(container?.textContent).not.toContain('Created ticket')
  })

  it('keeps the install CTA visible and skips ticket loading when not installed', async () => {
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

      if (path === '/api/after-sales/tickets') {
        throw new Error('tickets should not load before install')
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await flushUi(4)

    expect(container?.textContent).toContain('Enable After Sales')
    expect(container?.textContent).not.toContain('Recent tickets')
    expect(apiFetchMock).not.toHaveBeenCalledWith('/api/after-sales/tickets', undefined)
  })

  it('keeps the tickets panel active in partial state', async () => {
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
            warnings: ['ticket board missing'],
            reportRef: 'install-002',
          },
          reportRef: 'install-002',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          tickets: [
            {
              id: 'ticket-partial',
              version: 1,
              data: {
                ticketNo: 'AF-Partial',
                title: 'Handle degraded project',
                status: 'open',
                refundStatus: '',
                refundAmount: 0,
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

    await waitForText(container, 'AF-Partial')

    expect(container?.textContent).toContain('Recent tickets')
    expect(container?.textContent).toContain('Handle degraded project')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/tickets', undefined)
  })

  it('skips ticket loading when install state is failed', async () => {
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
            warnings: ['service ticket provisioning failed'],
            reportRef: 'install-003',
          },
          reportRef: 'install-003',
        })
      }

      if (path === '/api/after-sales/tickets') {
        throw new Error('tickets should not load for failed install state')
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await flushUi(4)

    expect(container?.textContent).not.toContain('Recent tickets')
    expect(apiFetchMock).not.toHaveBeenCalledWith('/api/after-sales/tickets', undefined)
  })
})
