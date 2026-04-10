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
      error:
        payload && typeof payload === 'object' && 'error' in payload
          ? (payload as { error?: unknown }).error
          : undefined,
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

function findSection(container: HTMLElement, headingText: string): HTMLElement {
  const heading = Array.from(container.querySelectorAll('h2')).find((item) => item.textContent?.includes(headingText))
  const section = heading?.closest('section')
  if (!section) {
    throw new Error(`Section with heading ${headingText} not found`)
  }
  return section as HTMLElement
}

function findButtonWithin(container: HTMLElement, label: string): HTMLButtonElement {
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

async function setTextareaValue(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  textarea.value = value
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await flushUi()
}

async function setSelectValue(select: HTMLSelectElement, value: string): Promise<void> {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await flushUi()
}

describe('AfterSalesView follow-ups panel', () => {
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

  it('loads follow-ups in partial state and supports filters with panel-local refresh', async () => {
    let currentStateCalls = 0
    let ticketCalls = 0
    let followUpBaseCalls = 0
    let followUpFilteredCalls = 0

    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'followUp' }],
          workflows: [],
        })
      }

      if (path === '/api/after-sales/projects/current') {
        currentStateCalls += 1
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
            warnings: ['follow-up queue missing owner coverage'],
            reportRef: 'install-follow-ups-partial',
          },
          reportRef: 'install-follow-ups-partial',
        })
      }

      if (path === '/api/after-sales/tickets') {
        ticketCalls += 1
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          tickets: [],
        })
      }

      if (path === '/api/after-sales/installed-assets') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          installedAssets: [],
        })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          serviceRecords: [],
        })
      }

      if (path === '/api/after-sales/follow-ups') {
        followUpBaseCalls += 1
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          followUps: [
            {
              id: 'follow-up-001',
              version: 1,
              data: {
                ticketNo: 'TK-5001',
                customerName: 'Alice Plant',
                dueAt: '2026-04-10T09:00:00Z',
                followUpType: 'visit',
                ownerName: 'CSR Chen',
                status: 'pending',
                summary: 'Call Alice after onsite service',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/follow-ups?status=pending&ticketNo=TK-5001&search=alice') {
        followUpFilteredCalls += 1
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          followUps: [
            {
              id: 'follow-up-001',
              version: 1,
              data: {
                ticketNo: 'TK-5001',
                customerName: 'Alice Plant',
                dueAt: '2026-04-10T09:00:00Z',
                followUpType: 'visit',
                ownerName: 'CSR Chen',
                status: 'pending',
                summary: 'Call Alice after onsite service',
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

    await waitForText(container, 'Follow-up queue')
    await waitForText(container, 'Call Alice after onsite service')

    const section = findSection(container, 'Follow-up queue')
    const statusFilter = section.querySelector<HTMLSelectElement>('#after-sales-follow-up-filter-status')
    const ticketFilter = section.querySelector<HTMLInputElement>('#after-sales-follow-up-filter-ticket-no')
    const searchFilter = section.querySelector<HTMLInputElement>('#after-sales-follow-up-filter-search')
    const applyButton = findButtonWithin(section, 'Apply filters')
    const refreshButton = findButtonWithin(section, 'Refresh list')

    expect(statusFilter).not.toBeNull()
    expect(ticketFilter).not.toBeNull()
    expect(searchFilter).not.toBeNull()

    await setSelectValue(statusFilter!, 'pending')
    await setInputValue(ticketFilter!, 'TK-5001')
    await setInputValue(searchFilter!, 'alice')

    applyButton.click()
    await flushUi(6)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/after-sales/follow-ups?status=pending&ticketNo=TK-5001&search=alice',
      undefined,
    )

    refreshButton.click()
    await flushUi(6)

    expect(currentStateCalls).toBe(1)
    expect(ticketCalls).toBe(1)
    expect(followUpBaseCalls).toBe(1)
    expect(followUpFilteredCalls).toBe(2)
    expect(section.textContent).toContain('CSR Chen')
  })

  it('skips follow-up loading when after-sales is not installed or failed', async () => {
    for (const status of ['not-installed', 'failed'] as const) {
      apiFetchMock.mockReset()
      apiFetchMock.mockImplementation(async (path: string) => {
        if (path === '/api/after-sales/app-manifest') {
          return createResponse({
            id: 'after-sales-default',
            displayName: 'After Sales',
            platformDependencies: ['core-backend'],
            objects: [{ id: 'followUp' }],
            workflows: [],
          })
        }

        if (path === '/api/after-sales/projects/current') {
          return createResponse({
            status,
            projectId: 'tenant:after-sales',
            displayName: 'After Sales',
            config: {
              defaultSlaHours: 24,
              urgentSlaHours: 4,
              followUpAfterDays: 7,
            },
            installResult: status === 'failed'
              ? {
                  status: 'failed',
                  createdObjects: [],
                  createdViews: [],
                  warnings: ['follow-up queue is unavailable'],
                  reportRef: 'install-follow-ups-failed',
                }
              : undefined,
            reportRef: status === 'failed' ? 'install-follow-ups-failed' : undefined,
          })
        }

        if (path === '/api/after-sales/follow-ups') {
          throw new Error('follow-ups should not load for non-operational after-sales state')
        }

        throw new Error(`Unexpected request: ${path}`)
      })

      const mounted = mountAfterSalesView()
      app = mounted.app
      container = mounted.container

      await waitForText(
        container,
        status === 'failed' ? 'Initialization failed' : 'Enable the after-sales project shell',
      )

      expect(container.textContent).not.toContain('Follow-up queue')
      expect(apiFetchMock).not.toHaveBeenCalledWith('/api/after-sales/follow-ups', undefined)

      app.unmount()
      container.remove()
      app = null
      container = null
    }
  })

  it('creates a follow-up and prepends it to the current list', async () => {
    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'followUp' }],
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
            reportRef: 'install-follow-ups-create',
          },
          reportRef: 'install-follow-ups-create',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, tickets: [] })
      }

      if (path === '/api/after-sales/installed-assets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, installedAssets: [] })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, serviceRecords: [] })
      }

      if (path === '/api/after-sales/follow-ups') {
        if (options?.method === 'POST') {
          return createResponse({
            projectId: 'tenant:after-sales',
            followUp: {
              id: 'follow-up-002',
              version: 1,
              data: {
                ticketNo: 'TK-5002',
                customerName: 'Charlie Logistics',
                dueAt: '2026-04-12T09:30:00Z',
                followUpType: 'message',
                ownerName: 'CSR Wang',
                status: 'pending',
                summary: 'Send delivery confirmation follow-up',
              },
            },
          }, { status: 201 })
        }

        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          followUps: [
            {
              id: 'follow-up-001',
              version: 1,
              data: {
                ticketNo: 'TK-5001',
                customerName: 'Alice Plant',
                dueAt: '2026-04-10T09:00:00Z',
                followUpType: 'visit',
                ownerName: 'CSR Chen',
                status: 'pending',
                summary: 'Call Alice after onsite service',
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

    await waitForText(container, 'Call Alice after onsite service')

    const section = findSection(container, 'Follow-up queue')
    const ticketInput = section.querySelector<HTMLInputElement>('#after-sales-follow-up-ticket-no')
    const customerInput = section.querySelector<HTMLInputElement>('#after-sales-follow-up-customer-name')
    const dueAtInput = section.querySelector<HTMLInputElement>('#after-sales-follow-up-due-at')
    const typeSelect = section.querySelector<HTMLSelectElement>('#after-sales-follow-up-type')
    const ownerInput = section.querySelector<HTMLInputElement>('#after-sales-follow-up-owner-name')
    const summaryInput = section.querySelector<HTMLTextAreaElement>('#after-sales-follow-up-summary')
    expect(ticketInput).toBeTruthy()
    expect(customerInput).toBeTruthy()
    expect(dueAtInput).toBeTruthy()
    expect(typeSelect).toBeTruthy()
    expect(ownerInput).toBeTruthy()
    expect(summaryInput).toBeTruthy()
    if (!ticketInput || !customerInput || !dueAtInput || !typeSelect || !ownerInput || !summaryInput) return

    await setInputValue(ticketInput, 'TK-5002')
    await setInputValue(customerInput, 'Charlie Logistics')
    await setInputValue(dueAtInput, '2026-04-12T09:30')
    await setSelectValue(typeSelect, 'message')
    await setInputValue(ownerInput, 'CSR Wang')
    summaryInput.value = 'Send delivery confirmation follow-up'
    summaryInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    findButtonWithin(section, 'Create follow-up').click()
    await waitForText(section, 'Charlie Logistics')

    const followUpRows = Array.from(section.querySelectorAll('.after-sales-view__follow-up-row'))
    expect(followUpRows[0]?.textContent).toContain('Charlie Logistics')
    expect(followUpRows[1]?.textContent).toContain('Alice Plant')
    expect(section.textContent).toContain('Created follow-up for TK-5002')
  })

  it('keeps the visible follow-up list unchanged when a created follow-up does not match active filters', async () => {
    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'followUp' }],
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
            warnings: [],
            reportRef: 'install-follow-ups-filtered-create',
          },
          reportRef: 'install-follow-ups-filtered-create',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, tickets: [] })
      }

      if (path === '/api/after-sales/installed-assets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, installedAssets: [] })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, serviceRecords: [] })
      }

      if (path === '/api/after-sales/follow-ups?status=pending&ticketNo=TK-5001&search=Alice') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          followUps: [
            {
              id: 'follow-up-001',
              version: 1,
              data: {
                ticketNo: 'TK-5001',
                customerName: 'Alice Plant',
                dueAt: '2026-04-10T09:00:00Z',
                followUpType: 'visit',
                ownerName: 'CSR Chen',
                status: 'pending',
                summary: 'Call Alice after onsite service',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/follow-ups') {
        if (options?.method === 'POST') {
          return createResponse({
            projectId: 'tenant:after-sales',
            followUp: {
              id: 'follow-up-003',
              version: 1,
              data: {
                ticketNo: 'TK-5009',
                customerName: 'Delta Warehouse',
                dueAt: '2026-04-13T10:00:00Z',
                followUpType: 'phone',
                ownerName: 'CSR Sun',
                status: 'done',
                summary: 'Completed warehouse confirmation call',
              },
            },
          }, { status: 201 })
        }

        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          followUps: [
            {
              id: 'follow-up-001',
              version: 1,
              data: {
                ticketNo: 'TK-5001',
                customerName: 'Alice Plant',
                dueAt: '2026-04-10T09:00:00Z',
                followUpType: 'visit',
                ownerName: 'CSR Chen',
                status: 'pending',
                summary: 'Call Alice after onsite service',
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

    await waitForText(container, 'Call Alice after onsite service')

    const section = findSection(container, 'Follow-up queue')
    const statusFilter = section.querySelector<HTMLSelectElement>('#after-sales-follow-up-filter-status')
    const ticketFilter = section.querySelector<HTMLInputElement>('#after-sales-follow-up-filter-ticket-no')
    const searchFilter = section.querySelector<HTMLInputElement>('#after-sales-follow-up-filter-search')
    const ticketInput = section.querySelector<HTMLInputElement>('#after-sales-follow-up-ticket-no')
    const customerInput = section.querySelector<HTMLInputElement>('#after-sales-follow-up-customer-name')
    const dueAtInput = section.querySelector<HTMLInputElement>('#after-sales-follow-up-due-at')
    expect(statusFilter).toBeTruthy()
    expect(ticketFilter).toBeTruthy()
    expect(searchFilter).toBeTruthy()
    expect(ticketInput).toBeTruthy()
    expect(customerInput).toBeTruthy()
    expect(dueAtInput).toBeTruthy()
    if (!statusFilter || !ticketFilter || !searchFilter || !ticketInput || !customerInput || !dueAtInput) return

    await setSelectValue(statusFilter, 'pending')
    await setInputValue(ticketFilter, 'TK-5001')
    await setInputValue(searchFilter, 'Alice')
    findButtonWithin(section, 'Apply filters').click()
    await waitForText(section, 'Alice Plant')

    await setInputValue(ticketInput, 'TK-5009')
    await setInputValue(customerInput, 'Delta Warehouse')
    await setInputValue(dueAtInput, '2026-04-13T10:00')

    findButtonWithin(section, 'Create follow-up').click()
    await waitForText(section, 'Created follow-up for TK-5009')

    expect(section.textContent).toContain('Alice Plant')
    expect(section.textContent).not.toContain('Delta Warehouse')
    expect(ticketInput.value).toBe('')
    expect(customerInput.value).toBe('')
  })

  it('keeps the follow-up draft open when create fails', async () => {
    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'followUp' }],
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
            reportRef: 'install-follow-ups-create-error',
          },
          reportRef: 'install-follow-ups-create-error',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, tickets: [] })
      }

      if (path === '/api/after-sales/installed-assets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, installedAssets: [] })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, serviceRecords: [] })
      }

      if (path === '/api/after-sales/follow-ups') {
        if (options?.method === 'POST') {
          return createResponse({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'followUp.customerName is required',
            },
          }, {
            ok: false,
            status: 400,
            statusText: 'Bad Request',
          })
        }

        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          followUps: [
            {
              id: 'follow-up-001',
              version: 1,
              data: {
                ticketNo: 'TK-5001',
                customerName: 'Alice Plant',
                dueAt: '2026-04-10T09:00:00Z',
                followUpType: 'visit',
                ownerName: 'CSR Chen',
                status: 'pending',
                summary: 'Call Alice after onsite service',
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

    await waitForText(container, 'Call Alice after onsite service')

    const section = findSection(container, 'Follow-up queue')
    const ticketInput = section.querySelector<HTMLInputElement>('#after-sales-follow-up-ticket-no')
    const customerInput = section.querySelector<HTMLInputElement>('#after-sales-follow-up-customer-name')
    const dueAtInput = section.querySelector<HTMLInputElement>('#after-sales-follow-up-due-at')
    expect(ticketInput).toBeTruthy()
    expect(customerInput).toBeTruthy()
    expect(dueAtInput).toBeTruthy()
    if (!ticketInput || !customerInput || !dueAtInput) return

    await setInputValue(ticketInput, 'TK-DRAFT')
    await setInputValue(customerInput, 'Draft Customer')
    await setInputValue(dueAtInput, '2026-04-14T09:00')

    findButtonWithin(section, 'Create follow-up').click()
    await waitForText(section, 'followUp.customerName is required')

    expect(ticketInput.value).toBe('TK-DRAFT')
    expect(customerInput.value).toBe('Draft Customer')
    expect(dueAtInput.value).toBe('2026-04-14T09:00')
    expect(section.textContent).toContain('Alice Plant')
  })

  it('updates a follow-up inline with a partial patch and keeps ticketNo intact', async () => {
    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'followUp' }],
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
            reportRef: 'install-follow-ups-edit',
          },
          reportRef: 'install-follow-ups-edit',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, tickets: [] })
      }

      if (path === '/api/after-sales/installed-assets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, installedAssets: [] })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, serviceRecords: [] })
      }

      if (path === '/api/after-sales/follow-ups') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 2,
          followUps: [
            {
              id: 'follow-up-edit',
              version: 1,
              data: {
                ticketNo: 'TK-EDIT',
                customerName: 'Before Edit Follow-up',
                dueAt: '2026-04-19T08:00:00Z',
                followUpType: 'phone',
                ownerName: 'CSR Chen',
                status: 'pending',
                summary: 'Original summary',
              },
            },
            {
              id: 'follow-up-keep',
              version: 1,
              data: {
                ticketNo: 'TK-KEEP',
                customerName: 'Keep Me Follow-up',
                dueAt: '2026-04-16T08:00:00Z',
                followUpType: 'message',
                ownerName: 'CSR Sun',
                status: 'pending',
                summary: 'Keep this follow-up',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/follow-ups/follow-up-edit' && options?.method === 'PATCH') {
        expect(JSON.parse(String(options.body))).toEqual({
          followUp: {
            customerName: 'After Edit Follow-up',
            dueAt: '2026-04-20T10:30',
            followUpType: 'message',
            ownerName: '',
            status: 'done',
            summary: '',
          },
        })
        return createResponse({
          projectId: 'tenant:after-sales',
          followUp: {
            id: 'follow-up-edit',
            version: 4,
            data: {
              ticketNo: 'TK-EDIT',
              customerName: 'After Edit Follow-up',
              dueAt: '2026-04-20T10:30',
              followUpType: 'message',
              ownerName: null,
              status: 'done',
              summary: null,
            },
          },
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'Before Edit Follow-up')

    const section = findSection(container, 'Follow-up queue')
    const editButton = section.querySelector<HTMLButtonElement>('button[aria-label="Edit follow-up TK-EDIT"]')
    expect(editButton).toBeTruthy()
    if (!editButton) return

    editButton.click()
    await flushUi()

    const ticketInput = section.querySelector<HTMLInputElement>('#after-sales-follow-up-edit-ticket-no-follow-up-edit')
    const customerInput = section.querySelector<HTMLInputElement>('#after-sales-follow-up-edit-customer-name-follow-up-edit')
    const dueAtInput = section.querySelector<HTMLInputElement>('#after-sales-follow-up-edit-due-at-follow-up-edit')
    const typeSelect = section.querySelector<HTMLSelectElement>('#after-sales-follow-up-edit-type-follow-up-edit')
    const ownerInput = section.querySelector<HTMLInputElement>('#after-sales-follow-up-edit-owner-name-follow-up-edit')
    const statusSelect = section.querySelector<HTMLSelectElement>('#after-sales-follow-up-edit-status-follow-up-edit')
    const summaryInput = section.querySelector<HTMLTextAreaElement>('#after-sales-follow-up-edit-summary-follow-up-edit')
    expect(ticketInput).toBeTruthy()
    expect(customerInput).toBeTruthy()
    expect(dueAtInput).toBeTruthy()
    expect(typeSelect).toBeTruthy()
    expect(ownerInput).toBeTruthy()
    expect(statusSelect).toBeTruthy()
    expect(summaryInput).toBeTruthy()
    if (!ticketInput || !customerInput || !dueAtInput || !typeSelect || !ownerInput || !statusSelect || !summaryInput) return

    expect(ticketInput.value).toBe('TK-EDIT')
    await setInputValue(customerInput, 'After Edit Follow-up')
    await setInputValue(dueAtInput, '2026-04-20T10:30')
    await setSelectValue(typeSelect, 'message')
    await setInputValue(ownerInput, '')
    await setSelectValue(statusSelect, 'done')
    await setTextareaValue(summaryInput, '')

    findButtonWithin(section, 'Save changes').click()
    await waitForText(section, 'Updated follow-up for TK-EDIT')

    expect(section.textContent).toContain('After Edit Follow-up')
    expect(section.textContent).toContain('TK-KEEP')
    expect(section.textContent).not.toContain('Before Edit Follow-up')
    expect(section.querySelector('#after-sales-follow-up-edit-customer-name-follow-up-edit')).toBeNull()
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/follow-ups/follow-up-edit', {
      method: 'PATCH',
      body: JSON.stringify({
        followUp: {
          customerName: 'After Edit Follow-up',
          dueAt: '2026-04-20T10:30',
          followUpType: 'message',
          ownerName: '',
          status: 'done',
          summary: '',
        },
      }),
    })
  })

  it('keeps the follow-up edit draft open when update fails', async () => {
    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'followUp' }],
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
            reportRef: 'install-follow-ups-edit-error',
          },
          reportRef: 'install-follow-ups-edit-error',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, tickets: [] })
      }

      if (path === '/api/after-sales/installed-assets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, installedAssets: [] })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, serviceRecords: [] })
      }

      if (path === '/api/after-sales/follow-ups') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          followUps: [
            {
              id: 'follow-up-edit',
              version: 1,
              data: {
                ticketNo: 'TK-EDIT',
                customerName: 'Before Edit Follow-up',
                dueAt: '2026-04-19T08:00:00Z',
                followUpType: 'phone',
                ownerName: 'CSR Chen',
                status: 'pending',
                summary: 'Original summary',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/follow-ups/follow-up-edit' && options?.method === 'PATCH') {
        return createResponse({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Follow-up update failed',
          },
        }, {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'Before Edit Follow-up')

    const section = findSection(container, 'Follow-up queue')
    const editButton = section.querySelector<HTMLButtonElement>('button[aria-label="Edit follow-up TK-EDIT"]')
    expect(editButton).toBeTruthy()
    if (!editButton) return

    editButton.click()
    await flushUi()

    const customerInput = section.querySelector<HTMLInputElement>('#after-sales-follow-up-edit-customer-name-follow-up-edit')
    const summaryInput = section.querySelector<HTMLTextAreaElement>('#after-sales-follow-up-edit-summary-follow-up-edit')
    expect(customerInput).toBeTruthy()
    expect(summaryInput).toBeTruthy()
    if (!customerInput || !summaryInput) return

    await setInputValue(customerInput, 'Failed Follow-up Edit')
    await setTextareaValue(summaryInput, 'Keep this draft open')

    findButtonWithin(section, 'Save changes').click()
    await waitForText(section, 'Follow-up update failed')

    expect(section.textContent).toContain('TK-EDIT')
    expect(section.querySelector('#after-sales-follow-up-edit-customer-name-follow-up-edit')).not.toBeNull()
    expect(customerInput.value).toBe('Failed Follow-up Edit')
    expect(summaryInput.value).toBe('Keep this draft open')
  })

  it('deletes a follow-up from the visible list without reloading the page', async () => {
    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'followUp' }],
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
            reportRef: 'install-follow-ups-delete',
          },
          reportRef: 'install-follow-ups-delete',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, tickets: [] })
      }

      if (path === '/api/after-sales/installed-assets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, installedAssets: [] })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, serviceRecords: [] })
      }

      if (path === '/api/after-sales/follow-ups') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 2,
          followUps: [
            {
              id: 'follow-up-delete',
              version: 1,
              data: {
                ticketNo: 'TK-DELETE',
                customerName: 'Delete Me Follow-up',
                dueAt: '2026-04-15T08:00:00Z',
                followUpType: 'phone',
                ownerName: 'CSR Chen',
                status: 'pending',
                summary: 'Delete this follow-up',
              },
            },
            {
              id: 'follow-up-keep',
              version: 1,
              data: {
                ticketNo: 'TK-KEEP',
                customerName: 'Keep Me Follow-up',
                dueAt: '2026-04-16T08:00:00Z',
                followUpType: 'message',
                ownerName: 'CSR Sun',
                status: 'pending',
                summary: 'Keep this follow-up',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/follow-ups/follow-up-delete' && options?.method === 'DELETE') {
        return createResponse({
          projectId: 'tenant:after-sales',
          followUpId: 'follow-up-delete',
          version: 4,
          deleted: true,
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'Delete Me Follow-up')

    const section = findSection(container, 'Follow-up queue')
    const deleteButton = section.querySelector<HTMLButtonElement>('button[aria-label="Delete follow-up TK-DELETE"]')
    expect(deleteButton).toBeTruthy()
    if (!deleteButton) return

    deleteButton.click()
    await waitForText(section, 'Deleted follow-up for TK-DELETE')

    expect(section.textContent).not.toContain('Delete Me Follow-up')
    expect(section.textContent).toContain('Keep Me Follow-up')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/follow-ups/follow-up-delete', { method: 'DELETE' })
  })

  it('keeps the follow-up list intact when delete fails', async () => {
    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'followUp' }],
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
            reportRef: 'install-follow-ups-delete-error',
          },
          reportRef: 'install-follow-ups-delete-error',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, tickets: [] })
      }

      if (path === '/api/after-sales/installed-assets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, installedAssets: [] })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, serviceRecords: [] })
      }

      if (path === '/api/after-sales/follow-ups') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          followUps: [
            {
              id: 'follow-up-delete',
              version: 1,
              data: {
                ticketNo: 'TK-DELETE',
                customerName: 'Delete Me Follow-up',
                dueAt: '2026-04-15T08:00:00Z',
                followUpType: 'phone',
                ownerName: 'CSR Chen',
                status: 'pending',
                summary: 'Delete this follow-up',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/follow-ups/follow-up-delete' && options?.method === 'DELETE') {
        return createResponse({
          error: {
            code: 'FORBIDDEN',
            message: 'After-sales write access required',
          },
        }, {
          ok: false,
          status: 403,
          statusText: 'Forbidden',
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'Delete Me Follow-up')

    const section = findSection(container, 'Follow-up queue')
    const deleteButton = section.querySelector<HTMLButtonElement>('button[aria-label="Delete follow-up TK-DELETE"]')
    expect(deleteButton).toBeTruthy()
    if (!deleteButton) return

    deleteButton.click()
    await waitForText(section, 'After-sales write access required')

    expect(section.textContent).toContain('Delete Me Follow-up')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/follow-ups/follow-up-delete', { method: 'DELETE' })
  })

  it('blocks concurrent follow-up deletes while one delete is in flight', async () => {
    let resolveDelete: ((response: Response) => void) | null = null
    let deleteCalls = 0

    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'followUp' }],
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
            reportRef: 'install-follow-ups-delete-race',
          },
          reportRef: 'install-follow-ups-delete-race',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, tickets: [] })
      }

      if (path === '/api/after-sales/installed-assets') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, installedAssets: [] })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({ projectId: 'tenant:after-sales', count: 0, serviceRecords: [] })
      }

      if (path === '/api/after-sales/follow-ups') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 2,
          followUps: [
            {
              id: 'follow-up-delete',
              version: 1,
              data: {
                ticketNo: 'TK-DELETE',
                customerName: 'Delete Me Follow-up',
                dueAt: '2026-04-15T08:00:00Z',
                followUpType: 'phone',
                ownerName: 'CSR Chen',
                status: 'pending',
                summary: 'Delete this follow-up',
              },
            },
            {
              id: 'follow-up-keep',
              version: 1,
              data: {
                ticketNo: 'TK-KEEP',
                customerName: 'Keep Me Follow-up',
                dueAt: '2026-04-16T08:00:00Z',
                followUpType: 'message',
                ownerName: 'CSR Sun',
                status: 'pending',
                summary: 'Keep this follow-up',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/follow-ups/follow-up-delete' && options?.method === 'DELETE') {
        deleteCalls += 1
        return await new Promise<Response>((resolve) => {
          resolveDelete = resolve
        })
      }

      if (path === '/api/after-sales/follow-ups/follow-up-keep' && options?.method === 'DELETE') {
        deleteCalls += 1
        return createResponse({
          projectId: 'tenant:after-sales',
          followUpId: 'follow-up-keep',
          version: 3,
          deleted: true,
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'Delete Me Follow-up')

    const section = findSection(container, 'Follow-up queue')
    const deleteFirstButton = section.querySelector<HTMLButtonElement>('button[aria-label="Delete follow-up TK-DELETE"]')
    const deleteSecondButton = section.querySelector<HTMLButtonElement>('button[aria-label="Delete follow-up TK-KEEP"]')
    const createButton = findButtonWithin(section, 'Create follow-up')
    expect(deleteFirstButton).toBeTruthy()
    expect(deleteSecondButton).toBeTruthy()
    if (!deleteFirstButton || !deleteSecondButton) return

    deleteFirstButton.click()
    await flushUi()

    expect(deleteFirstButton.disabled).toBe(true)
    expect(deleteSecondButton.disabled).toBe(true)
    expect(createButton.disabled).toBe(true)

    deleteSecondButton.click()
    await flushUi()

    expect(deleteCalls).toBe(1)
    expect(resolveDelete).toBeTruthy()
    if (!resolveDelete) return

    resolveDelete(
      createResponse({
        projectId: 'tenant:after-sales',
        followUpId: 'follow-up-delete',
        version: 4,
        deleted: true,
      }),
    )
    await waitForText(section, 'Deleted follow-up for TK-DELETE')

    expect(section.textContent).not.toContain('Delete Me Follow-up')
    expect(section.textContent).toContain('Keep Me Follow-up')
    expect(deleteCalls).toBe(1)
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/follow-ups/follow-up-delete', { method: 'DELETE' })
  })
})
