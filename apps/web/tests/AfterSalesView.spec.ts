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

function createFieldPoliciesResponse(
  policy: { visibility: 'hidden' | 'visible'; editability: 'readonly' | 'editable' },
) {
  return createResponse({
    projectId: 'tenant:after-sales',
    fields: {
      serviceTicket: {
        refundAmount: policy,
      },
    },
  })
}

function createRuntimeAdminResponse(options: {
  projectId?: string
  automations?: Array<{ id: string; name: string; triggerEvent: string; enabled: boolean }>
  fieldPolicies?: Array<{
    roleSlug: string
    roleLabel: string
    visibility: 'hidden' | 'visible'
    editability: 'readonly' | 'editable'
  }>
} = {}) {
  return createResponse({
    projectId: options.projectId ?? 'tenant:after-sales',
    automations:
      options.automations ?? [
        { id: 'ticket-triage', name: 'Ticket triage', triggerEvent: 'ticket.created', enabled: true },
        { id: 'sla-watcher', name: 'SLA watcher', triggerEvent: 'ticket.overdue', enabled: true },
        { id: 'refund-approval', name: 'Refund approval', triggerEvent: 'ticket.refundRequested', enabled: true },
        { id: 'service-record-notify', name: 'Service record notify', triggerEvent: 'service.recorded', enabled: true },
      ],
    fieldPolicies: {
      objectId: 'serviceTicket',
      field: 'refundAmount',
      roles:
        options.fieldPolicies ?? [
          { roleSlug: 'finance', roleLabel: 'Finance', visibility: 'visible', editability: 'editable' },
          { roleSlug: 'supervisor', roleLabel: 'Supervisor', visibility: 'visible', editability: 'readonly' },
          { roleSlug: 'customer_service', roleLabel: 'Customer Service', visibility: 'hidden', editability: 'readonly' },
          { roleSlug: 'technician', roleLabel: 'Technician', visibility: 'hidden', editability: 'readonly' },
        ],
    },
  })
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

async function waitForElementMissing(container: HTMLElement, selector: string, cycles = 24): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    if (!container.querySelector(selector)) {
      return
    }
    await flushUi(1)
  }

  throw new Error(`Timed out waiting for element to disappear: ${selector}`)
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

async function setCheckboxValue(input: HTMLInputElement, value: boolean): Promise<void> {
  input.checked = value
  input.dispatchEvent(new Event('change', { bubbles: true }))
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

  it('refreshes only tickets and preserves the local ticket draft and filters', async () => {
    let currentCalls = 0
    let serviceRecordCalls = 0
    const ticketPaths: string[] = []

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
        currentCalls += 1
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
            reportRef: 'install-ticket-refresh',
          },
          reportRef: 'install-ticket-refresh',
        })
      }

      if (path === '/api/after-sales/tickets') {
        ticketPaths.push(path)
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          tickets: [
            {
              id: 'ticket-001',
              version: 1,
              data: {
                ticketNo: 'AF-001',
                title: 'Initial ticket',
                status: 'open',
                refundStatus: '',
                refundAmount: 0,
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/tickets?status=open&search=compressor') {
        ticketPaths.push(path)
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          tickets: [
            {
              id: 'ticket-002',
              version: 2,
              data: {
                ticketNo: 'AF-002',
                title: 'Compressor refresh result',
                status: 'open',
                refundStatus: '',
                refundAmount: 0,
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/service-records') {
        serviceRecordCalls += 1
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          serviceRecords: [],
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'Initial ticket')

    const statusInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-filter-status')
    const searchInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-filter-search')
    const ticketNoInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-no')
    const titleInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-title')
    expect(statusInput).toBeTruthy()
    expect(searchInput).toBeTruthy()
    expect(ticketNoInput).toBeTruthy()
    expect(titleInput).toBeTruthy()
    if (!statusInput || !searchInput || !ticketNoInput || !titleInput) return

    await setInputValue(statusInput, 'open')
    await setInputValue(searchInput, 'compressor')
    await setInputValue(ticketNoInput, 'AF-NEW')
    await setInputValue(titleInput, 'Draft title')

    findButton(container, 'Refresh list').click()
    await waitForText(container, 'Compressor refresh result')

    expect(statusInput.value).toBe('open')
    expect(searchInput.value).toBe('compressor')
    expect(ticketNoInput.value).toBe('AF-NEW')
    expect(titleInput.value).toBe('Draft title')
    expect(currentCalls).toBe(1)
    expect(serviceRecordCalls).toBe(1)
    expect(ticketPaths).toEqual([
      '/api/after-sales/tickets',
      '/api/after-sales/tickets?status=open&search=compressor',
    ])
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

  it('blocks ticket creation when refund amount is not numeric', async () => {
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
            reportRef: 'install-006',
          },
          reportRef: 'install-006',
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
        throw new Error('ticket POST should not fire for invalid refund amount')
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'AF-001')

    const ticketNoInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-no')
    const titleInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-title')
    const refundInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-refund-amount')
    const createButton = findButton(container, 'Create ticket')
    expect(ticketNoInput).toBeTruthy()
    expect(titleInput).toBeTruthy()
    expect(refundInput).toBeTruthy()
    if (!ticketNoInput || !titleInput || !refundInput) return

    await setInputValue(ticketNoInput, 'AF-401')
    await setInputValue(titleInput, 'Invalid refund amount')
    await setInputValue(refundInput, 'abc')

    expect(container?.textContent).toContain('Refund amount must be a valid number')
    expect(createButton.disabled).toBe(true)
    expect(apiFetchMock).not.toHaveBeenCalledWith(
      '/api/after-sales/tickets',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('updates a ticket in place and exits edit mode', async () => {
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
            reportRef: 'install-006d',
          },
          reportRef: 'install-006d',
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
                status: 'new',
                priority: 'high',
                source: 'phone',
                refundStatus: '',
                refundAmount: 0,
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/tickets/ticket-1' && options?.method === 'PATCH') {
        return createResponse({
          projectId: 'tenant:after-sales',
          ticket: {
            id: 'ticket-1',
            version: 2,
            data: {
              ticketNo: 'AF-001',
              title: 'Updated compressor diagnosis',
              status: 'assigned',
              priority: 'urgent',
              source: 'wechat',
              refundStatus: '',
              refundAmount: 0,
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

    const editButton = container?.querySelector<HTMLButtonElement>('button[aria-label="Edit ticket AF-001"]')
    expect(editButton).toBeTruthy()
    if (!editButton) return

    editButton.click()
    await flushUi()

    const titleInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-edit-title-ticket-1')
    const prioritySelect = container?.querySelector<HTMLSelectElement>('#after-sales-ticket-edit-priority-ticket-1')
    const sourceSelect = container?.querySelector<HTMLSelectElement>('#after-sales-ticket-edit-source-ticket-1')
    const statusSelect = container?.querySelector<HTMLSelectElement>('#after-sales-ticket-edit-status-ticket-1')
    expect(titleInput).toBeTruthy()
    expect(prioritySelect).toBeTruthy()
    expect(sourceSelect).toBeTruthy()
    expect(statusSelect).toBeTruthy()
    if (!titleInput || !prioritySelect || !sourceSelect || !statusSelect) return

    await setInputValue(titleInput, 'Updated compressor diagnosis')
    await setSelectValue(prioritySelect, 'urgent')
    await setSelectValue(sourceSelect, 'wechat')
    await setSelectValue(statusSelect, 'assigned')

    findButton(container, 'Save changes').click()
    await waitForText(container, 'Updated ticket AF-001')

    expect(container?.textContent).toContain('Updated compressor diagnosis')
    expect(container?.textContent).toContain('assigned')
    expect(container?.querySelector('#after-sales-ticket-edit-title-ticket-1')).toBeNull()
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/after-sales/tickets/ticket-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          ticket: {
            title: 'Updated compressor diagnosis',
            priority: 'urgent',
            source: 'wechat',
            status: 'assigned',
          },
        }),
      }),
    )
  })

  it('keeps the edit draft open when ticket update fails', async () => {
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
            reportRef: 'install-006e',
          },
          reportRef: 'install-006e',
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
                status: 'new',
                priority: 'normal',
                source: 'web',
                refundStatus: '',
                refundAmount: 0,
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/tickets/ticket-1' && options?.method === 'PATCH') {
        return createResponse(
          { message: 'Ticket update rejected' },
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

    const editButton = container?.querySelector<HTMLButtonElement>('button[aria-label="Edit ticket AF-001"]')
    expect(editButton).toBeTruthy()
    if (!editButton) return

    editButton.click()
    await flushUi()

    const titleInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-edit-title-ticket-1')
    expect(titleInput).toBeTruthy()
    if (!titleInput) return

    await setInputValue(titleInput, 'Still editing')
    findButton(container, 'Save changes').click()
    await waitForText(container, '409 Conflict')

    expect(titleInput.value).toBe('Still editing')
    expect(container?.textContent).toContain('Save changes')
    expect(container?.textContent).toContain('AF-001')
  })

  it('requests a refund for a ticket and updates the row in place', async () => {
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
            reportRef: 'install-006a',
          },
          reportRef: 'install-006a',
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

      if (path === '/api/after-sales/tickets/ticket-1/refund-request' && options?.method === 'POST') {
        return createResponse({
          projectId: 'tenant:after-sales',
          ticket: {
            id: 'ticket-1',
            version: 2,
            data: {
              ticketNo: 'AF-001',
              title: 'Install compressor',
              status: 'open',
              refundStatus: 'pending',
              refundAmount: 120.5,
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

    const refundInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-refund-request-ticket-1')
    expect(refundInput).toBeTruthy()
    if (!refundInput) return

    await setInputValue(refundInput, '120.5')
    findButton(container, 'Request refund').click()
    await waitForText(container, 'Requested refund for AF-001')

    expect(container?.textContent).toContain('pending')
    expect(container?.textContent).toContain('¥120.50')
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/after-sales/tickets/ticket-1/refund-request',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          refundAmount: 120.5,
        }),
      }),
    )
  })

  it('hides refund controls when the field policy is hidden', async () => {
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
            reportRef: 'install-006-hidden',
          },
          reportRef: 'install-006-hidden',
        })
      }

      if (path === '/api/after-sales/field-policies') {
        return createFieldPoliciesResponse({
          visibility: 'hidden',
          editability: 'readonly',
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
                refundAmount: 88.5,
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

    await waitForText(container, 'AF-001')

    expect(container?.querySelector('#after-sales-ticket-refund-amount')).toBeNull()
    expect(container?.querySelector('#after-sales-ticket-refund-request-ticket-1')).toBeNull()
    const refundButton = Array.from(container?.querySelectorAll('button') ?? []).find((item) =>
      item.textContent?.includes('Request refund'),
    )
    expect(refundButton).toBeUndefined()
    expect(container?.textContent).not.toContain('¥88.50')
  })

  it('renders refund controls as readonly when the field policy is readonly', async () => {
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
            reportRef: 'install-006-readonly',
          },
          reportRef: 'install-006-readonly',
        })
      }

      if (path === '/api/after-sales/field-policies') {
        return createFieldPoliciesResponse({
          visibility: 'visible',
          editability: 'readonly',
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
                refundAmount: 88.5,
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

    await waitForText(container, 'AF-001')

    const createRefundInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-refund-amount')
    const inlineRefundInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-refund-request-ticket-1')
    const refundButton = findButton(container!, 'Request refund')

    expect(createRefundInput).toBeTruthy()
    expect(inlineRefundInput).toBeTruthy()
    expect(createRefundInput?.disabled).toBe(true)
    expect(inlineRefundInput?.disabled).toBe(true)
    expect(refundButton.disabled).toBe(true)
    expect(container?.textContent).toContain('¥88.50')
  })

  it('keeps refund controls editable when the field policy is editable', async () => {
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
            reportRef: 'install-006-editable',
          },
          reportRef: 'install-006-editable',
        })
      }

      if (path === '/api/after-sales/field-policies') {
        return createFieldPoliciesResponse({
          visibility: 'visible',
          editability: 'editable',
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

      if (path === '/api/after-sales/tickets/ticket-1/refund-request' && options?.method === 'POST') {
        return createResponse({
          projectId: 'tenant:after-sales',
          ticket: {
            id: 'ticket-1',
            version: 2,
            data: {
              ticketNo: 'AF-001',
              title: 'Install compressor',
              status: 'open',
              refundStatus: 'pending',
              refundAmount: 120.5,
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

    const createRefundInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-refund-amount')
    const inlineRefundInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-refund-request-ticket-1')
    const refundButton = findButton(container!, 'Request refund')

    expect(createRefundInput).toBeTruthy()
    expect(inlineRefundInput).toBeTruthy()
    expect(createRefundInput?.disabled).toBe(false)
    expect(inlineRefundInput?.disabled).toBe(false)
    expect(refundButton.disabled).toBe(false)

    await setInputValue(inlineRefundInput!, '120.5')
    refundButton.click()
    await waitForText(container!, 'Requested refund for AF-001')
  })

  it('renders runtime admin controls when the manifest exposes the runtime-admin workflow', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [],
          workflows: [
            { id: 'ticket-triage', name: 'Ticket Triage' },
            { id: 'sla-watcher', name: 'SLA Watcher' },
            { id: 'refund-approval', name: 'Refund Approval' },
            { id: 'service-record-notify', name: 'Service Record Notification' },
          ],
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
            reportRef: 'install-runtime-admin',
          },
          reportRef: 'install-runtime-admin',
        })
      }

      if (path === '/api/after-sales/runtime-admin') {
        return createRuntimeAdminResponse()
      }

      if (path === '/api/after-sales/field-policies') {
        return createFieldPoliciesResponse({
          visibility: 'visible',
          editability: 'editable',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          tickets: [],
        })
      }

      if (path === '/api/after-sales/installed-assets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, installedAssets: [] })
      }

      if (path === '/api/after-sales/customers') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, customers: [] })
      }

      if (path === '/api/after-sales/follow-ups') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, followUps: [] })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, serviceRecords: [] })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'Default automation rules')

    expect(container?.querySelector('#after-sales-runtime-admin')).not.toBeNull()
    expect(container?.textContent).toContain('Default automation rules')
    expect(container?.textContent).toContain('SLA Watcher')
    expect(container?.textContent).toContain('refundAmount role matrix')
  })

  it('hides runtime admin controls when the backend denies access', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [],
          workflows: [
            { id: 'ticket-triage', name: 'Ticket Triage' },
            { id: 'sla-watcher', name: 'SLA Watcher' },
            { id: 'refund-approval', name: 'Refund Approval' },
            { id: 'service-record-notify', name: 'Service Record Notification' },
          ],
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
            reportRef: 'install-runtime-admin-403',
          },
          reportRef: 'install-runtime-admin-403',
        })
      }

      if (path === '/api/after-sales/runtime-admin') {
        return createResponse({ message: 'Forbidden' }, { ok: false, status: 403, statusText: 'Forbidden' })
      }

      if (path === '/api/after-sales/field-policies') {
        return createFieldPoliciesResponse({
          visibility: 'visible',
          editability: 'editable',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, tickets: [] })
      }

      if (path === '/api/after-sales/installed-assets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, installedAssets: [] })
      }

      if (path === '/api/after-sales/customers') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, customers: [] })
      }

      if (path === '/api/after-sales/follow-ups') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, followUps: [] })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, serviceRecords: [] })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForElementMissing(container!, '#after-sales-runtime-admin')
    expect(container?.textContent).not.toContain('Runtime admin')
  })

  it('saves runtime admin automation toggles with the selected payload', async () => {
    let runtimeAdminLoads = 0
    let savedPayload: unknown = null

    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [],
          workflows: [
            { id: 'ticket-triage', name: 'Ticket Triage' },
            { id: 'sla-watcher', name: 'SLA Watcher' },
            { id: 'refund-approval', name: 'Refund Approval' },
            { id: 'service-record-notify', name: 'Service Record Notification' },
          ],
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
            reportRef: 'install-runtime-admin-save',
          },
          reportRef: 'install-runtime-admin-save',
        })
      }

      if (path === '/api/after-sales/runtime-admin' && !options?.method) {
        runtimeAdminLoads += 1
        return createRuntimeAdminResponse({
          automations:
            runtimeAdminLoads === 1
              ? [
                  { id: 'ticket-triage', name: 'Ticket triage', triggerEvent: 'ticket.created', enabled: true },
                  { id: 'sla-watcher', name: 'SLA watcher', triggerEvent: 'ticket.overdue', enabled: true },
                  { id: 'refund-approval', name: 'Refund approval', triggerEvent: 'ticket.refundRequested', enabled: true },
                  { id: 'service-record-notify', name: 'Service record notify', triggerEvent: 'service.recorded', enabled: true },
                ]
              : [
                  { id: 'ticket-triage', name: 'Ticket triage', triggerEvent: 'ticket.created', enabled: true },
                  { id: 'sla-watcher', name: 'SLA watcher', triggerEvent: 'ticket.overdue', enabled: false },
                  { id: 'refund-approval', name: 'Refund approval', triggerEvent: 'ticket.refundRequested', enabled: true },
                  { id: 'service-record-notify', name: 'Service record notify', triggerEvent: 'service.recorded', enabled: true },
                ],
        })
      }

      if (path === '/api/after-sales/runtime-admin/automations' && options?.method === 'PUT') {
        savedPayload = JSON.parse(String(options.body || '{}'))
        return createRuntimeAdminResponse({
          automations: [
            { id: 'ticket-triage', name: 'Ticket triage', triggerEvent: 'ticket.created', enabled: true },
            { id: 'sla-watcher', name: 'SLA watcher', triggerEvent: 'ticket.overdue', enabled: false },
            { id: 'refund-approval', name: 'Refund approval', triggerEvent: 'ticket.refundRequested', enabled: true },
            { id: 'service-record-notify', name: 'Service record notify', triggerEvent: 'service.recorded', enabled: true },
          ],
        })
      }

      if (path === '/api/after-sales/field-policies') {
        return createFieldPoliciesResponse({
          visibility: 'visible',
          editability: 'editable',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, tickets: [] })
      }

      if (path === '/api/after-sales/installed-assets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, installedAssets: [] })
      }

      if (path === '/api/after-sales/customers') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, customers: [] })
      }

      if (path === '/api/after-sales/follow-ups') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, followUps: [] })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, serviceRecords: [] })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'Default automation rules')

    const toggle = container?.querySelector<HTMLInputElement>('#after-sales-runtime-admin-automation-sla-watcher')
    expect(toggle).toBeTruthy()
    if (!toggle) return

    await setCheckboxValue(toggle, false)
    findButton(container, 'Save automations').click()
    await waitForText(container, 'Saved automation controls')

    expect(savedPayload).toEqual({
      automations: [
        { id: 'ticket-triage', enabled: true },
        { id: 'sla-watcher', enabled: false },
        { id: 'refund-approval', enabled: true },
        { id: 'service-record-notify', enabled: true },
      ],
    })
    expect(toggle.checked).toBe(false)
  })

  it('saves runtime admin field policies and refreshes refund controls', async () => {
    let fieldPolicyMode: 'hidden' | 'visible' = 'hidden'
    let fieldPolicyEditability: 'readonly' | 'editable' = 'readonly'
    let savePayload: unknown = null

    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [],
          workflows: [
            { id: 'ticket-triage', name: 'Ticket Triage' },
            { id: 'sla-watcher', name: 'SLA Watcher' },
            { id: 'refund-approval', name: 'Refund Approval' },
            { id: 'service-record-notify', name: 'Service Record Notification' },
          ],
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
            reportRef: 'install-runtime-admin-field-policies',
          },
          reportRef: 'install-runtime-admin-field-policies',
        })
      }

      if (path === '/api/after-sales/runtime-admin') {
        return createRuntimeAdminResponse({
          fieldPolicies: [
            {
              roleSlug: 'finance',
              roleLabel: 'Finance',
              visibility: fieldPolicyMode,
              editability: fieldPolicyEditability,
            },
            {
              roleSlug: 'supervisor',
              roleLabel: 'Supervisor',
              visibility: 'visible',
              editability: 'readonly',
            },
            {
              roleSlug: 'customer_service',
              roleLabel: 'Customer Service',
              visibility: 'hidden',
              editability: 'readonly',
            },
            {
              roleSlug: 'technician',
              roleLabel: 'Technician',
              visibility: 'hidden',
              editability: 'readonly',
            },
          ],
        })
      }

      if (path === '/api/after-sales/runtime-admin/field-policies' && options?.method === 'PUT') {
        savePayload = JSON.parse(String(options.body || '{}'))
        fieldPolicyMode = 'visible'
        fieldPolicyEditability = 'editable'
        return createRuntimeAdminResponse({
          fieldPolicies: [
            {
              roleSlug: 'finance',
              roleLabel: 'Finance',
              visibility: fieldPolicyMode,
              editability: fieldPolicyEditability,
            },
            {
              roleSlug: 'supervisor',
              roleLabel: 'Supervisor',
              visibility: 'visible',
              editability: 'readonly',
            },
            {
              roleSlug: 'customer_service',
              roleLabel: 'Customer Service',
              visibility: 'hidden',
              editability: 'readonly',
            },
            {
              roleSlug: 'technician',
              roleLabel: 'Technician',
              visibility: 'hidden',
              editability: 'readonly',
            },
          ],
        })
      }

      if (path === '/api/after-sales/field-policies') {
        return createFieldPoliciesResponse({
          visibility: fieldPolicyMode,
          editability: fieldPolicyEditability,
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
                refundStatus: '',
                refundAmount: 88.5,
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/installed-assets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, installedAssets: [] })
      }

      if (path === '/api/after-sales/customers') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, customers: [] })
      }

      if (path === '/api/after-sales/follow-ups') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, followUps: [] })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, serviceRecords: [] })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'refundAmount role matrix')
    expect(container?.querySelector('#after-sales-ticket-refund-amount')).toBeNull()

    const visibilitySelect = container?.querySelector<HTMLSelectElement>('#after-sales-runtime-admin-field-policy-finance-visibility')
    const editabilitySelect = container?.querySelector<HTMLSelectElement>('#after-sales-runtime-admin-field-policy-finance-editability')
    expect(visibilitySelect).toBeTruthy()
    expect(editabilitySelect).toBeTruthy()
    if (!visibilitySelect || !editabilitySelect) return

    await setSelectValue(visibilitySelect, 'visible')
    await setSelectValue(editabilitySelect, 'editable')
    findButton(container, 'Save field policies').click()
    await waitForText(container, 'Saved field policies')
    await waitForText(container, '¥88.50')

    expect(savePayload).toEqual({
      roles: [
        { roleSlug: 'finance', visibility: 'visible', editability: 'editable' },
        { roleSlug: 'supervisor', visibility: 'visible', editability: 'readonly' },
        { roleSlug: 'customer_service', visibility: 'hidden', editability: 'readonly' },
        { roleSlug: 'technician', visibility: 'hidden', editability: 'readonly' },
      ],
    })
    expect(container?.querySelector('#after-sales-ticket-refund-amount')).not.toBeNull()
    expect(container?.querySelector<HTMLInputElement>('#after-sales-ticket-refund-amount')?.disabled).toBe(false)
    expect(container?.querySelector<HTMLInputElement>('#after-sales-ticket-refund-request-ticket-1')?.disabled).toBe(false)
  })

  it('reloads the refund controls after a field-policy save', async () => {
    let fieldPolicyVisible = false

    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [],
          workflows: [
            { id: 'ticket-triage', name: 'Ticket Triage' },
            { id: 'sla-watcher', name: 'SLA Watcher' },
            { id: 'refund-approval', name: 'Refund Approval' },
            { id: 'service-record-notify', name: 'Service Record Notification' },
          ],
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
            reportRef: 'install-runtime-admin-refresh',
          },
          reportRef: 'install-runtime-admin-refresh',
        })
      }

      if (path === '/api/after-sales/runtime-admin') {
        return createRuntimeAdminResponse({
          fieldPolicies: [
            {
              roleSlug: 'finance',
              roleLabel: 'Finance',
              visibility: fieldPolicyVisible ? 'visible' : 'hidden',
              editability: fieldPolicyVisible ? 'editable' : 'readonly',
            },
            {
              roleSlug: 'supervisor',
              roleLabel: 'Supervisor',
              visibility: 'visible',
              editability: 'readonly',
            },
            {
              roleSlug: 'customer_service',
              roleLabel: 'Customer Service',
              visibility: 'hidden',
              editability: 'readonly',
            },
            {
              roleSlug: 'technician',
              roleLabel: 'Technician',
              visibility: 'hidden',
              editability: 'readonly',
            },
          ],
        })
      }

      if (path === '/api/after-sales/runtime-admin/field-policies' && options?.method === 'PUT') {
        fieldPolicyVisible = true
        return createRuntimeAdminResponse({
          fieldPolicies: [
            {
              roleSlug: 'finance',
              roleLabel: 'Finance',
              visibility: 'visible',
              editability: 'editable',
            },
            {
              roleSlug: 'supervisor',
              roleLabel: 'Supervisor',
              visibility: 'visible',
              editability: 'readonly',
            },
            {
              roleSlug: 'customer_service',
              roleLabel: 'Customer Service',
              visibility: 'hidden',
              editability: 'readonly',
            },
            {
              roleSlug: 'technician',
              roleLabel: 'Technician',
              visibility: 'hidden',
              editability: 'readonly',
            },
          ],
        })
      }

      if (path === '/api/after-sales/field-policies') {
        return createFieldPoliciesResponse({
          visibility: fieldPolicyVisible ? 'visible' : 'hidden',
          editability: fieldPolicyVisible ? 'editable' : 'readonly',
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
                refundStatus: '',
                refundAmount: 88.5,
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/installed-assets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, installedAssets: [] })
      }

      if (path === '/api/after-sales/customers') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, customers: [] })
      }

      if (path === '/api/after-sales/follow-ups') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, followUps: [] })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, serviceRecords: [] })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'refundAmount role matrix')
    expect(container?.querySelector('#after-sales-ticket-refund-amount')).toBeNull()

    const visibilitySelect = container?.querySelector<HTMLSelectElement>('#after-sales-runtime-admin-field-policy-finance-visibility')
    expect(visibilitySelect).toBeTruthy()
    if (!visibilitySelect) return

    await setSelectValue(visibilitySelect, 'visible')
    findButton(container, 'Save field policies').click()
    await waitForText(container, 'Saved field policies')
    await waitForText(container, '¥88.50')

    expect(container?.querySelector('#after-sales-ticket-refund-amount')).not.toBeNull()
    expect(container?.querySelector<HTMLInputElement>('#after-sales-ticket-refund-amount')?.disabled).toBe(false)
    expect(container?.querySelector<HTMLInputElement>('#after-sales-ticket-refund-request-ticket-1')?.disabled).toBe(false)
  })

  it('blocks refund requests when the inline refund amount is invalid', async () => {
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
            reportRef: 'install-006b',
          },
          reportRef: 'install-006b',
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

      if (path === '/api/after-sales/tickets/ticket-1/refund-request' && options?.method === 'POST') {
        throw new Error('refund request should not submit with invalid amount')
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'AF-001')

    const refundInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-refund-request-ticket-1')
    expect(refundInput).toBeTruthy()
    if (!refundInput) return

    await setInputValue(refundInput, 'abc')
    findButton(container, 'Request refund').click()
    await waitForText(container, 'Refund amount must be a valid number')

    expect(apiFetchMock).not.toHaveBeenCalledWith(
      '/api/after-sales/tickets/ticket-1/refund-request',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('disables refund requests while ticket delete is in flight', async () => {
    let resolveDelete: ((value: Response) => void) | null = null

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
            reportRef: 'install-006c',
          },
          reportRef: 'install-006c',
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

      if (path === '/api/after-sales/tickets/ticket-1' && options?.method === 'DELETE') {
        return await new Promise<Response>((resolve) => {
          resolveDelete = resolve
        })
      }

      if (path === '/api/after-sales/tickets/ticket-1/refund-request' && options?.method === 'POST') {
        throw new Error('refund request should stay disabled while delete is in flight')
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'AF-001')

    const deleteButton = container?.querySelector<HTMLButtonElement>('button[aria-label="Delete ticket AF-001"]')
    const refundButton = findButton(container!, 'Request refund')
    expect(deleteButton).toBeTruthy()
    expect(refundButton).toBeTruthy()
    if (!deleteButton) return

    deleteButton.click()
    await flushUi(2)

    expect(deleteButton.disabled).toBe(true)
    expect(refundButton.disabled).toBe(true)

    resolveDelete?.(
      createResponse({
        projectId: 'tenant:after-sales',
        ticketId: 'ticket-1',
        deleted: true,
      }),
    )

    await waitForText(container!, 'Deleted ticket AF-001')
  })

  it('disables ticket create controls while tickets are still loading', async () => {
    let resolveTickets: ((value: Response) => void) | null = null

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
            reportRef: 'install-007',
          },
          reportRef: 'install-007',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return await new Promise<Response>((resolve) => {
          resolveTickets = resolve
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await flushUi(6)

    const ticketNoInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-no')
    const titleInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-title')
    const createButton = findButton(container, 'Create ticket')
    const resetButton = findButton(container, 'Reset ticket draft')
    expect(ticketNoInput).toBeTruthy()
    expect(titleInput).toBeTruthy()
    if (!ticketNoInput || !titleInput) return

    await setInputValue(ticketNoInput, 'AF-777')
    await setInputValue(titleInput, 'Pending list load')

    expect(createButton.disabled).toBe(true)
    expect(resetButton.disabled).toBe(true)

    resolveTickets?.(
      createResponse({
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
      }),
    )

    await waitForText(container, 'AF-001')

    expect(createButton.disabled).toBe(false)
    expect(resetButton.disabled).toBe(false)
  })

  it('deletes a ticket from the visible list without reloading the page', async () => {
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
            reportRef: 'install-008',
          },
          reportRef: 'install-008',
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
                title: 'Delete me',
                status: 'open',
                refundStatus: '',
                refundAmount: 0,
              },
            },
            {
              id: 'ticket-2',
              version: 1,
              data: {
                ticketNo: 'AF-002',
                title: 'Keep me',
                status: 'closed',
                refundStatus: '',
                refundAmount: 0,
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/tickets/ticket-1' && options?.method === 'DELETE') {
        return createResponse({
          projectId: 'tenant:after-sales',
          ticketId: 'ticket-1',
          deleted: true,
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'AF-001')
    const deleteButton = container?.querySelector<HTMLButtonElement>('button[aria-label="Delete ticket AF-001"]')
    expect(deleteButton).toBeTruthy()
    if (!deleteButton) return

    deleteButton.click()
    await waitForText(container, 'Deleted ticket AF-001')

    expect(container?.textContent).not.toContain('Delete me')
    expect(container?.textContent).toContain('Keep me')
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/after-sales/tickets/ticket-1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('keeps the ticket list intact when delete fails', async () => {
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
            reportRef: 'install-009',
          },
          reportRef: 'install-009',
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
                title: 'Delete me',
                status: 'open',
                refundStatus: '',
                refundAmount: 0,
              },
            },
            {
              id: 'ticket-2',
              version: 1,
              data: {
                ticketNo: 'AF-002',
                title: 'Keep me',
                status: 'closed',
                refundStatus: '',
                refundAmount: 0,
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/tickets/ticket-1' && options?.method === 'DELETE') {
        throw new Error('Delete failed')
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'AF-001')
    const deleteButton = container?.querySelector<HTMLButtonElement>('button[aria-label="Delete ticket AF-001"]')
    expect(deleteButton).toBeTruthy()
    if (!deleteButton) return

    deleteButton.click()
    await waitForText(container, 'Delete failed')

    expect(container?.textContent).toContain('Delete me')
    expect(container?.textContent).toContain('Keep me')
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/after-sales/tickets/ticket-1',
      expect.objectContaining({ method: 'DELETE' }),
    )
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

  it('applies ticket filters through the tickets query contract', async () => {
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
              id: 'ticket-base',
              version: 1,
              data: {
                ticketNo: 'AF-001',
                title: 'Baseline ticket',
                status: 'closed',
                refundStatus: '',
                refundAmount: 0,
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/tickets?status=open&search=compressor') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          tickets: [
            {
              id: 'ticket-filtered',
              version: 1,
              data: {
                ticketNo: 'AF-009',
                title: 'Compressor restart on site',
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

    await waitForText(container, 'AF-001')

    const statusInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-filter-status')
    const searchInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-filter-search')
    expect(statusInput).toBeTruthy()
    expect(searchInput).toBeTruthy()
    if (!statusInput || !searchInput) return

    await setInputValue(statusInput, 'open')
    await setInputValue(searchInput, 'compressor')
    findButton(container, 'Apply ticket filters').click()

    await waitForText(container, 'AF-009')

    expect(container?.textContent).toContain('Compressor restart on site')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/tickets?status=open&search=compressor', undefined)
  })

  it('clears ticket filters and reloads the default list', async () => {
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
            reportRef: 'install-005',
          },
          reportRef: 'install-005',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          tickets: [
            {
              id: 'ticket-base',
              version: 1,
              data: {
                ticketNo: 'AF-001',
                title: 'Baseline ticket',
                status: 'closed',
                refundStatus: '',
                refundAmount: 0,
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/tickets?status=open&search=compressor') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          tickets: [
            {
              id: 'ticket-filtered',
              version: 1,
              data: {
                ticketNo: 'AF-009',
                title: 'Compressor restart on site',
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

    await waitForText(container, 'AF-001')

    const statusInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-filter-status')
    const searchInput = container?.querySelector<HTMLInputElement>('#after-sales-ticket-filter-search')
    expect(statusInput).toBeTruthy()
    expect(searchInput).toBeTruthy()
    if (!statusInput || !searchInput) return

    await setInputValue(statusInput, 'open')
    await setInputValue(searchInput, 'compressor')
    findButton(container, 'Apply ticket filters').click()
    await waitForText(container, 'AF-009')

    findButton(container, 'Clear ticket filters').click()
    await waitForText(container, 'AF-001')

    expect(statusInput.value).toBe('')
    expect(searchInput.value).toBe('')
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
