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
            installResult: status === 'failed'
              ? {
                  status: 'failed',
                  createdObjects: [],
                  createdViews: [],
                  warnings: ['customer projection failed'],
                  reportRef: 'install-customers-failed',
                }
              : undefined,
            reportRef: status === 'failed' ? 'install-customers-failed' : undefined,
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
          throw new Error('customers should not load for non-operational after-sales state')
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

      expect(container.textContent).not.toContain('Customer registry')
      expect(apiFetchMock).not.toHaveBeenCalledWith('/api/after-sales/customers', undefined)

      app.unmount()
      container.remove()
      app = null
      container = null
      vi.clearAllMocks()
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
})
