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

async function setSelectValue(select: HTMLSelectElement, value: string): Promise<void> {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await flushUi()
}

describe('AfterSalesView customers panel', () => {
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

  it('loads customers when after-sales is installed', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'customer' }],
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
            reportRef: 'install-customers-001',
          },
          reportRef: 'install-customers-001',
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

      if (path === '/api/after-sales/customers') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          customers: [
            {
              id: 'customer-001',
              version: 1,
              data: {
                customerCode: 'CUS-1001',
                name: 'Alice Plant',
                phone: '13800138000',
                email: 'alice@example.com',
                status: 'active',
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

    await waitForText(container, 'Alice Plant')

    expect(container.textContent).toContain('Customer registry')
    expect(container.textContent).toContain('CUS-1001')
    expect(container.textContent).toContain('alice@example.com')
    expect(container.textContent).toContain('13800138000')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/customers', undefined)
  })

  it('skips customer loading when after-sales is not installed or failed', async () => {
    for (const status of ['not-installed', 'failed'] as const) {
      apiFetchMock.mockReset()
      apiFetchMock.mockImplementation(async (path: string) => {
        if (path === '/api/after-sales/app-manifest') {
          return createResponse({
            id: 'after-sales-default',
            displayName: 'After Sales',
            platformDependencies: ['core-backend'],
            objects: [{ id: 'customer' }],
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
            installResult: {
              status,
              createdObjects: [],
              createdViews: [],
              warnings: status === 'failed' ? ['customer projection failed'] : [],
              reportRef: `install-customers-skip-${status}`,
            },
            reportRef: `install-customers-skip-${status}`,
          })
        }

        throw new Error(`Unexpected request: ${path}`)
      })

      const mounted = mountAfterSalesView()
      app = mounted.app
      container = mounted.container

      await waitForText(container, status === 'failed' ? 'Initialization failed' : 'Enable the after-sales project shell')

      expect(container.textContent).not.toContain('Customer registry')
      expect(apiFetchMock).not.toHaveBeenCalledWith('/api/after-sales/customers', undefined)

      app?.unmount()
      container?.remove()
      app = null
      container = null
    }
  })

  it('supports partial-state filters and refreshes only the customer list', async () => {
    let currentCalls = 0
    let ticketCalls = 0
    let installedAssetCalls = 0
    let serviceRecordCalls = 0
    const customerPaths: string[] = []

    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'customer' }],
          workflows: [],
        })
      }

      if (path === '/api/after-sales/projects/current') {
        currentCalls += 1
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
            warnings: ['customer-grid recreated'],
            reportRef: 'install-customers-002',
          },
          reportRef: 'install-customers-002',
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
        installedAssetCalls += 1
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          installedAssets: [],
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

      if (path === '/api/after-sales/customers') {
        customerPaths.push(path)
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          customers: [
            {
              id: 'customer-001',
              version: 1,
              data: {
                customerCode: 'CUS-BASE',
                name: 'Base Customer',
                phone: '',
                email: '',
                status: 'inactive',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/customers?status=active&search=Alice') {
        customerPaths.push(path)
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          customers: [
            {
              id: 'customer-002',
              version: 2,
              data: {
                customerCode: 'CUS-2001',
                name: 'Alice Plant',
                phone: '13800138000',
                email: 'alice@example.com',
                status: 'active',
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

    await waitForText(container, 'Base Customer')

    const customerSection = findSection(container, 'Customer registry')
    const statusSelect = customerSection.querySelector<HTMLSelectElement>('#after-sales-customer-filter-status')
    const searchInput = customerSection.querySelector<HTMLInputElement>('#after-sales-customer-filter-search')
    expect(statusSelect).toBeTruthy()
    expect(searchInput).toBeTruthy()
    if (!statusSelect || !searchInput) return

    await setSelectValue(statusSelect, 'active')
    await setInputValue(searchInput, 'Alice')

    findButtonWithin(customerSection, 'Apply filters').click()
    await waitForText(customerSection, 'Alice Plant')

    expect(customerPaths).toEqual([
      '/api/after-sales/customers',
      '/api/after-sales/customers?status=active&search=Alice',
    ])
    expect(currentCalls).toBe(1)
    expect(ticketCalls).toBe(1)
    expect(installedAssetCalls).toBe(1)
    expect(serviceRecordCalls).toBe(1)

    findButtonWithin(customerSection, 'Refresh list').click()
    await flushUi()

    expect(customerPaths).toEqual([
      '/api/after-sales/customers',
      '/api/after-sales/customers?status=active&search=Alice',
      '/api/after-sales/customers?status=active&search=Alice',
    ])
    expect(currentCalls).toBe(1)
    expect(ticketCalls).toBe(1)
    expect(installedAssetCalls).toBe(1)
    expect(serviceRecordCalls).toBe(1)
  })

  it('creates customers from the panel and prepends matching rows', async () => {
    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'customer' }],
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
            reportRef: 'install-customers-003',
          },
          reportRef: 'install-customers-003',
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

      if (path === '/api/after-sales/customers') {
        if (options?.method === 'POST') {
          expect(JSON.parse(String(options.body))).toEqual({
            customer: {
              customerCode: 'CUS-3001',
              name: 'Charlie Logistics',
              status: 'active',
              phone: '13700137000',
              email: 'charlie@example.com',
            },
          })
          return createResponse({
            projectId: 'tenant:after-sales',
            customer: {
              id: 'customer-003',
              version: 1,
              data: {
                customerCode: 'CUS-3001',
                name: 'Charlie Logistics',
                phone: '13700137000',
                email: 'charlie@example.com',
                status: 'active',
              },
            },
          }, { status: 201 })
        }

        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          customers: [
            {
              id: 'customer-001',
              version: 1,
              data: {
                customerCode: 'CUS-1001',
                name: 'Alice Plant',
                phone: '13800138000',
                email: 'alice@example.com',
                status: 'active',
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

    await waitForText(container, 'Alice Plant')

    const customerSection = findSection(container, 'Customer registry')
    const customerCodeInput = customerSection.querySelector<HTMLInputElement>('#after-sales-customer-code')
    const nameInput = customerSection.querySelector<HTMLInputElement>('#after-sales-customer-name')
    const phoneInput = customerSection.querySelector<HTMLInputElement>('#after-sales-customer-phone')
    const emailInput = customerSection.querySelector<HTMLInputElement>('#after-sales-customer-email')
    const statusSelect = customerSection.querySelector<HTMLSelectElement>('#after-sales-customer-status')
    expect(customerCodeInput).toBeTruthy()
    expect(nameInput).toBeTruthy()
    expect(phoneInput).toBeTruthy()
    expect(emailInput).toBeTruthy()
    expect(statusSelect).toBeTruthy()
    if (!customerCodeInput || !nameInput || !phoneInput || !emailInput || !statusSelect) return

    await setInputValue(customerCodeInput, 'CUS-3001')
    await setInputValue(nameInput, 'Charlie Logistics')
    await setInputValue(phoneInput, '13700137000')
    await setInputValue(emailInput, 'charlie@example.com')
    await setSelectValue(statusSelect, 'active')

    findButtonWithin(customerSection, 'Create customer').click()
    await waitForText(customerSection, 'Charlie Logistics')

    const customerRows = Array.from(customerSection.querySelectorAll('.after-sales-view__customer-row'))
    expect(customerRows[0]?.textContent).toContain('Charlie Logistics')
    expect(customerRows[1]?.textContent).toContain('Alice Plant')
    expect(customerSection.textContent).toContain('Created customer CUS-3001')
  })

  it('keeps the visible customer list unchanged when a created customer does not match active filters', async () => {
    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'customer' }],
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
            reportRef: 'install-customers-005',
          },
          reportRef: 'install-customers-005',
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

      if (path === '/api/after-sales/customers?status=active&search=Alice') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          customers: [
            {
              id: 'customer-001',
              version: 1,
              data: {
                customerCode: 'CUS-1001',
                name: 'Alice Plant',
                phone: '13800138000',
                email: 'alice@example.com',
                status: 'active',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/customers') {
        if (options?.method === 'POST') {
          return createResponse({
            projectId: 'tenant:after-sales',
            customer: {
              id: 'customer-004',
              version: 1,
              data: {
                customerCode: 'CUS-3002',
                name: 'Delta Warehouse',
                phone: '13600136000',
                email: 'delta@example.com',
                status: 'inactive',
              },
            },
          }, { status: 201 })
        }

        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          customers: [
            {
              id: 'customer-001',
              version: 1,
              data: {
                customerCode: 'CUS-1001',
                name: 'Alice Plant',
                phone: '13800138000',
                email: 'alice@example.com',
                status: 'active',
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

    await waitForText(container, 'Alice Plant')

    const customerSection = findSection(container, 'Customer registry')
    const statusFilter = customerSection.querySelector<HTMLSelectElement>('#after-sales-customer-filter-status')
    const searchFilter = customerSection.querySelector<HTMLInputElement>('#after-sales-customer-filter-search')
    const customerCodeInput = customerSection.querySelector<HTMLInputElement>('#after-sales-customer-code')
    const nameInput = customerSection.querySelector<HTMLInputElement>('#after-sales-customer-name')
    expect(statusFilter).toBeTruthy()
    expect(searchFilter).toBeTruthy()
    expect(customerCodeInput).toBeTruthy()
    expect(nameInput).toBeTruthy()
    if (!statusFilter || !searchFilter || !customerCodeInput || !nameInput) return

    await setSelectValue(statusFilter, 'active')
    await setInputValue(searchFilter, 'Alice')
    findButtonWithin(customerSection, 'Apply filters').click()
    await waitForText(customerSection, 'Alice Plant')

    await setInputValue(customerCodeInput, 'CUS-3002')
    await setInputValue(nameInput, 'Delta Warehouse')

    findButtonWithin(customerSection, 'Create customer').click()
    await waitForText(customerSection, 'Created customer CUS-3002')

    expect(customerSection.textContent).toContain('Alice Plant')
    expect(customerSection.textContent).not.toContain('Delta Warehouse')
    expect(customerCodeInput.value).toBe('')
    expect(nameInput.value).toBe('')
  })

  it('keeps the customer draft open when create fails', async () => {
    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'customer' }],
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
            reportRef: 'install-customers-004',
          },
          reportRef: 'install-customers-004',
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

      if (path === '/api/after-sales/customers') {
        if (options?.method === 'POST') {
          return createResponse({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'customer.customerCode is required',
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
          customers: [
            {
              id: 'customer-001',
              version: 1,
              data: {
                customerCode: 'CUS-1001',
                name: 'Alice Plant',
                phone: '13800138000',
                email: 'alice@example.com',
                status: 'active',
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

    await waitForText(container, 'Alice Plant')

    const customerSection = findSection(container, 'Customer registry')
    const customerCodeInput = customerSection.querySelector<HTMLInputElement>('#after-sales-customer-code')
    const nameInput = customerSection.querySelector<HTMLInputElement>('#after-sales-customer-name')
    expect(customerCodeInput).toBeTruthy()
    expect(nameInput).toBeTruthy()
    if (!customerCodeInput || !nameInput) return

    await setInputValue(customerCodeInput, 'CUS-DRAFT')
    await setInputValue(nameInput, 'Draft Customer')

    findButtonWithin(customerSection, 'Create customer').click()
    await waitForText(customerSection, 'customer.customerCode is required')

    expect(customerCodeInput.value).toBe('CUS-DRAFT')
    expect(nameInput.value).toBe('Draft Customer')
    expect(customerSection.textContent).toContain('Alice Plant')
  })

  it('updates a customer inline with a partial patch and keeps omitted fields intact', async () => {
    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'customer' }],
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
            reportRef: 'install-customers-008',
          },
          reportRef: 'install-customers-008',
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

      if (path === '/api/after-sales/customers') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 2,
          customers: [
            {
              id: 'customer-edit',
              version: 1,
              data: {
                customerCode: 'CUS-EDIT',
                name: 'Customer Before Edit',
                phone: '13800138000',
                email: 'before@example.com',
                status: 'active',
              },
            },
            {
              id: 'customer-keep',
              version: 1,
              data: {
                customerCode: 'CUS-KEEP',
                name: 'Keep Me Customer',
                phone: '13900139000',
                email: 'keep@example.com',
                status: 'inactive',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/customers/customer-edit' && options?.method === 'PATCH') {
        expect(JSON.parse(String(options.body))).toEqual({
          customer: {
            name: 'Customer After Edit',
            phone: '',
            email: 'after@example.com',
          },
        })
        return createResponse({
          projectId: 'tenant:after-sales',
          customer: {
            id: 'customer-edit',
            version: 4,
            data: {
              customerCode: 'CUS-EDIT',
              name: 'Customer After Edit',
              phone: null,
              email: 'after@example.com',
              status: 'active',
            },
          },
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'Customer Before Edit')

    const customerSection = findSection(container, 'Customer registry')
    const editButton = customerSection.querySelector<HTMLButtonElement>('button[aria-label="Edit customer CUS-EDIT"]')
    expect(editButton).toBeTruthy()
    if (!editButton) return

    editButton.click()
    await flushUi()

    const customerCodeInput = customerSection.querySelector<HTMLInputElement>('#after-sales-customer-edit-code-customer-edit')
    const nameInput = customerSection.querySelector<HTMLInputElement>('#after-sales-customer-edit-name-customer-edit')
    const phoneInput = customerSection.querySelector<HTMLInputElement>('#after-sales-customer-edit-phone-customer-edit')
    const emailInput = customerSection.querySelector<HTMLInputElement>('#after-sales-customer-edit-email-customer-edit')
    const statusSelect = customerSection.querySelector<HTMLSelectElement>('#after-sales-customer-edit-status-customer-edit')

    expect(customerCodeInput).toBeTruthy()
    expect(nameInput).toBeTruthy()
    expect(phoneInput).toBeTruthy()
    expect(emailInput).toBeTruthy()
    expect(statusSelect).toBeTruthy()
    if (!customerCodeInput || !nameInput || !phoneInput || !emailInput || !statusSelect) return

    await setInputValue(nameInput, 'Customer After Edit')
    await setInputValue(phoneInput, '')
    await setInputValue(emailInput, 'after@example.com')

    findButtonWithin(customerSection, 'Save changes').click()

    await waitForText(customerSection, 'Updated customer CUS-EDIT')

    expect(customerSection.textContent).toContain('Customer After Edit')
    expect(customerSection.textContent).toContain('after@example.com')
    expect(customerSection.textContent).toContain('CUS-KEEP')
    expect(customerSection.textContent).not.toContain('Customer Before Edit')
    expect(customerSection.querySelector('#after-sales-customer-edit-name-customer-edit')).toBeNull()
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/customers/customer-edit', {
      method: 'PATCH',
      body: JSON.stringify({
        customer: {
          name: 'Customer After Edit',
          phone: '',
          email: 'after@example.com',
        },
      }),
    })
  })

  it('keeps the customer edit draft open when update fails', async () => {
    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'customer' }],
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
            reportRef: 'install-customers-009',
          },
          reportRef: 'install-customers-009',
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

      if (path === '/api/after-sales/customers') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          customers: [
            {
              id: 'customer-edit-error',
              version: 1,
              data: {
                customerCode: 'CUS-ERR',
                name: 'Customer Still Visible',
                phone: '13800138000',
                email: 'before@example.com',
                status: 'active',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/customers/customer-edit-error' && options?.method === 'PATCH') {
        return createResponse({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Customer update failed',
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

    await waitForText(container, 'Customer Still Visible')

    const customerSection = findSection(container, 'Customer registry')
    const editButton = customerSection.querySelector<HTMLButtonElement>('button[aria-label="Edit customer CUS-ERR"]')
    expect(editButton).toBeTruthy()
    if (!editButton) return

    editButton.click()
    await flushUi()

    const nameInput = customerSection.querySelector<HTMLInputElement>('#after-sales-customer-edit-name-customer-edit-error')
    const emailInput = customerSection.querySelector<HTMLInputElement>('#after-sales-customer-edit-email-customer-edit-error')
    expect(nameInput).toBeTruthy()
    expect(emailInput).toBeTruthy()
    if (!nameInput || !emailInput) return

    await setInputValue(nameInput, 'Customer Failed Edit')
    await setInputValue(emailInput, 'failed@example.com')

    findButtonWithin(customerSection, 'Save changes').click()

    await waitForText(customerSection, 'Customer update failed')
    expect(customerSection.textContent).toContain('CUS-ERR')
    expect(customerSection.querySelector('#after-sales-customer-edit-name-customer-edit-error')).not.toBeNull()
    expect(nameInput.value).toBe('Customer Failed Edit')
    expect(emailInput.value).toBe('failed@example.com')
  })

  it('deletes a customer from the visible list without reloading the page', async () => {
    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'customer' }],
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
            reportRef: 'install-customers-006',
          },
          reportRef: 'install-customers-006',
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

      if (path === '/api/after-sales/customers') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 2,
          customers: [
            {
              id: 'customer-delete',
              version: 1,
              data: {
                customerCode: 'CUS-DELETE',
                name: 'Delete Me Customer',
                phone: '13800138000',
                email: 'delete-me@example.com',
                status: 'active',
              },
            },
            {
              id: 'customer-keep',
              version: 1,
              data: {
                customerCode: 'CUS-KEEP',
                name: 'Keep Me Customer',
                phone: '13900139000',
                email: 'keep@example.com',
                status: 'inactive',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/customers/customer-delete' && options?.method === 'DELETE') {
        return createResponse({
          projectId: 'tenant:after-sales',
          customerId: 'customer-delete',
          version: 4,
          deleted: true,
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'Delete Me Customer')

    const customerSection = findSection(container, 'Customer registry')
    const deleteButton = customerSection.querySelector<HTMLButtonElement>('button[aria-label="Delete customer CUS-DELETE"]')
    expect(deleteButton).toBeTruthy()
    if (!deleteButton) return

    deleteButton.click()

    await waitForText(customerSection, 'Deleted customer CUS-DELETE')

    expect(customerSection.textContent).not.toContain('Delete Me Customer')
    expect(customerSection.textContent).toContain('Keep Me Customer')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/customers/customer-delete', { method: 'DELETE' })
  })

  it('keeps the customer list intact when delete fails', async () => {
    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'customer' }],
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
            reportRef: 'install-customers-007',
          },
          reportRef: 'install-customers-007',
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

      if (path === '/api/after-sales/customers') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          customers: [
            {
              id: 'customer-delete',
              version: 1,
              data: {
                customerCode: 'CUS-DELETE',
                name: 'Delete Me Customer',
                phone: '13800138000',
                email: 'delete-me@example.com',
                status: 'active',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/customers/customer-delete' && options?.method === 'DELETE') {
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

    await waitForText(container, 'Delete Me Customer')

    const customerSection = findSection(container, 'Customer registry')
    const deleteButton = customerSection.querySelector<HTMLButtonElement>('button[aria-label="Delete customer CUS-DELETE"]')
    expect(deleteButton).toBeTruthy()
    if (!deleteButton) return

    deleteButton.click()
    await waitForText(customerSection, 'After-sales write access required')

    expect(customerSection.textContent).toContain('Delete Me Customer')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/customers/customer-delete', { method: 'DELETE' })
  })

  it('blocks concurrent customer deletes while one delete is in flight', async () => {
    let resolveDelete: ((response: Response) => void) | null = null
    let deleteCalls = 0

    apiFetchMock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'customer' }],
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
            reportRef: 'install-customers-008',
          },
          reportRef: 'install-customers-008',
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

      if (path === '/api/after-sales/customers') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 2,
          customers: [
            {
              id: 'customer-delete',
              version: 1,
              data: {
                customerCode: 'CUS-DELETE',
                name: 'Delete Me Customer',
                phone: '13800138000',
                email: 'delete-me@example.com',
                status: 'active',
              },
            },
            {
              id: 'customer-keep',
              version: 1,
              data: {
                customerCode: 'CUS-KEEP',
                name: 'Keep Me Customer',
                phone: '13900139000',
                email: 'keep@example.com',
                status: 'inactive',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/customers/customer-delete' && options?.method === 'DELETE') {
        deleteCalls += 1
        return await new Promise<Response>((resolve) => {
          resolveDelete = resolve
        })
      }

      if (path === '/api/after-sales/customers/customer-keep' && options?.method === 'DELETE') {
        deleteCalls += 1
        return createResponse({
          projectId: 'tenant:after-sales',
          customerId: 'customer-keep',
          version: 7,
          deleted: true,
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'Delete Me Customer')

    const customerSection = findSection(container, 'Customer registry')
    const deleteFirstButton = customerSection.querySelector<HTMLButtonElement>('button[aria-label="Delete customer CUS-DELETE"]')
    const deleteSecondButton = customerSection.querySelector<HTMLButtonElement>('button[aria-label="Delete customer CUS-KEEP"]')
    const createButton = findButtonWithin(customerSection, 'Create customer')
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
        customerId: 'customer-delete',
        version: 4,
        deleted: true,
      }),
    )
    await waitForText(customerSection, 'Deleted customer CUS-DELETE')

    expect(customerSection.textContent).not.toContain('Delete Me Customer')
    expect(customerSection.textContent).toContain('Keep Me Customer')
    expect(deleteCalls).toBe(1)
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/customers/customer-delete', { method: 'DELETE' })
  })
})
