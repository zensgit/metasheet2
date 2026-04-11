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

function createErrorResponse(
  code: string,
  message: string,
  options: MockResponseOptions = {},
) {
  return {
    ok: false,
    status: options.status ?? 409,
    statusText: options.statusText ?? 'Conflict',
    json: async () => ({
      ok: false,
      error: {
        code,
        message,
      },
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

describe('AfterSalesView part items panel', () => {
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

  it('hides the parts panel when the manifest does not provision partItem', async () => {
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
            reportRef: 'install-parts-001',
          },
          reportRef: 'install-parts-001',
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

      if (path === '/api/after-sales/field-policies') {
        return createResponse({
          projectId: 'tenant:after-sales',
          fields: {
            serviceTicket: {
              refundAmount: { visibility: 'visible', editability: 'editable' },
            },
          },
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'Install state')

    expect(container.textContent).not.toContain('Part inventory')
    expect(container.textContent).not.toContain('No parts found yet.')
  })

  it('loads, filters, creates, edits, and deletes parts through the live parts panel', async () => {
    const partItems = [
      {
        id: 'part-001',
        version: 1,
        data: {
          partNo: 'PRT-1001',
          name: 'Compressor filter',
          category: 'spare',
          stockQty: 12,
          status: 'available',
        },
      },
    ]

    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'partItem', name: 'Parts', backing: 'multitable' }],
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
            createdObjects: ['partItem'],
            createdViews: ['partItem-grid'],
            warnings: [],
            reportRef: 'install-parts-002',
          },
          reportRef: 'install-parts-002',
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

      if (path === '/api/after-sales/field-policies') {
        return createResponse({
          projectId: 'tenant:after-sales',
          fields: {
            serviceTicket: {
              refundAmount: { visibility: 'visible', editability: 'editable' },
            },
          },
        })
      }

      if (path.startsWith('/api/after-sales/parts')) {
        const url = new URL(path, 'http://localhost')
        const method = init?.method ?? 'GET'

        if (method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            partItem?: {
              partNo?: string
              name?: string
              category?: string
              stockQty?: number
              status?: string
            }
          }
          const nextPartItem = {
            id: `part-${partItems.length + 1}`,
            version: 1,
            data: {
              partNo: body.partItem?.partNo ?? '',
              name: body.partItem?.name ?? '',
              category: body.partItem?.category ?? 'spare',
              stockQty: typeof body.partItem?.stockQty === 'number' ? body.partItem.stockQty : null,
              status: body.partItem?.status ?? 'available',
            },
          }
          partItems.unshift(nextPartItem)
          return createResponse({
            projectId: 'tenant:after-sales',
            partItem: nextPartItem,
          })
        }

        if (method === 'PATCH') {
          const partId = url.pathname.split('/').pop() ?? ''
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            partItem?: Record<string, unknown>
          }
          const part = partItems.find((item) => item.id === partId)
          if (!part) {
            return createResponse({ error: { message: 'missing part' } }, { ok: false, status: 404, statusText: 'Not Found' })
          }

          part.data = {
            ...part.data,
            ...body.partItem,
          }
          part.version += 1
          return createResponse({
            projectId: 'tenant:after-sales',
            partItem: part,
          })
        }

        if (method === 'DELETE') {
          const partId = url.pathname.split('/').pop() ?? ''
          const index = partItems.findIndex((item) => item.id === partId)
          if (index === -1) {
            return createResponse({ error: { message: 'missing part' } }, { ok: false, status: 404, statusText: 'Not Found' })
          }
          const [deleted] = partItems.splice(index, 1)
          return createResponse({
            projectId: 'tenant:after-sales',
            partItem: deleted,
          })
        }

        const status = url.searchParams.get('status')
        const search = url.searchParams.get('search')?.toLowerCase() ?? ''
        const filtered = partItems.filter((item) => {
          if (status && item.data.status !== status) return false
          if (search) {
            return JSON.stringify(item.data).toLowerCase().includes(search)
          }
          return true
        })

        return createResponse({
          projectId: 'tenant:after-sales',
          count: filtered.length,
          partItems: filtered,
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'PRT-1001')

    const section = findSection(container, 'Part inventory')
    expect(section.textContent).toContain('Compressor filter')

    const statusFilter = section.querySelector<HTMLSelectElement>('#after-sales-part-item-filter-status')
    const searchFilter = section.querySelector<HTMLInputElement>('#after-sales-part-item-filter-search')
    expect(statusFilter).toBeTruthy()
    expect(searchFilter).toBeTruthy()
    await setSelectValue(statusFilter as HTMLSelectElement, 'available')
    await setInputValue(searchFilter as HTMLInputElement, 'compressor')
    findButtonWithin(section, 'Apply filters').click()
    await flushUi(2)
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/parts?status=available&search=compressor', undefined)

    const partNoInput = section.querySelector<HTMLInputElement>('#after-sales-part-item-part-no')
    const nameInput = section.querySelector<HTMLInputElement>('#after-sales-part-item-name')
    const categorySelect = section.querySelector<HTMLSelectElement>('#after-sales-part-item-category')
    const statusSelect = section.querySelector<HTMLSelectElement>('#after-sales-part-item-status')
    const stockQtyInput = section.querySelector<HTMLInputElement>('#after-sales-part-item-stock-qty')
    expect(partNoInput).toBeTruthy()
    expect(nameInput).toBeTruthy()
    expect(categorySelect).toBeTruthy()
    expect(statusSelect).toBeTruthy()
    expect(stockQtyInput).toBeTruthy()

    await setInputValue(partNoInput as HTMLInputElement, 'PRT-2002')
    await setInputValue(nameInput as HTMLInputElement, 'Compressor pack')
    await setSelectValue(categorySelect as HTMLSelectElement, 'consumable')
    await setSelectValue(statusSelect as HTMLSelectElement, 'available')
    await setInputValue(stockQtyInput as HTMLInputElement, '4')
    findButtonWithin(section, 'Create part').click()
    await flushUi(2)

    const postCall = apiFetchMock.mock.calls.find(
      ([path, init]) => path === '/api/after-sales/parts' && (init as RequestInit | undefined)?.method === 'POST',
    )
    expect(postCall).toBeTruthy()
    expect(JSON.parse(String((postCall?.[1] as RequestInit | undefined)?.body))).toEqual({
      partItem: {
        partNo: 'PRT-2002',
        name: 'Compressor pack',
        category: 'consumable',
        status: 'available',
        stockQty: 4,
      },
    })
    await waitForText(section, 'PRT-2002')

    const editButton = section.querySelector<HTMLButtonElement>('button[aria-label="Edit part PRT-2002"]')
    expect(editButton).toBeTruthy()
    editButton.click()
    await flushUi(1)

    const editNameInput = section.querySelector<HTMLInputElement>('#after-sales-part-item-edit-name-part-2')
    const editStockQtyInput = section.querySelector<HTMLInputElement>('#after-sales-part-item-edit-stock-qty-part-2')
    expect(editNameInput).toBeTruthy()
    expect(editStockQtyInput).toBeTruthy()
    await setInputValue(editNameInput as HTMLInputElement, 'Compressor filter v2')
    await setInputValue(editStockQtyInput as HTMLInputElement, '18')
    findButtonWithin(section, 'Save changes').click()
    await flushUi(2)

    const patchCall = apiFetchMock.mock.calls.find(
      ([path, init]) =>
        path === '/api/after-sales/parts/part-2' && (init as RequestInit | undefined)?.method === 'PATCH',
    )
    expect(patchCall).toBeTruthy()
    expect(JSON.parse(String((patchCall?.[1] as RequestInit | undefined)?.body))).toEqual({
      partItem: {
        partNo: 'PRT-2002',
        name: 'Compressor filter v2',
        category: 'consumable',
        status: 'available',
        stockQty: 18,
      },
    })
    await waitForText(section, 'Updated part PRT-2002')
    expect(section.textContent).toContain('Compressor filter v2')

    const deleteCreatedButton = section.querySelector<HTMLButtonElement>('button[aria-label="Delete part PRT-2002"]')
    expect(deleteCreatedButton).toBeTruthy()
    deleteCreatedButton.click()
    await flushUi(2)

    const deleteCall = apiFetchMock.mock.calls.find(
      ([path, init]) =>
        path === '/api/after-sales/parts/part-2' && (init as RequestInit | undefined)?.method === 'DELETE',
    )
    expect(deleteCall).toBeTruthy()
    await waitForText(section, 'Deleted part PRT-2002')
    await waitForText(section, 'PRT-1001')

    const deleteInitialButton = section.querySelector<HTMLButtonElement>('button[aria-label="Delete part PRT-1001"]')
    expect(deleteInitialButton).toBeTruthy()
    deleteInitialButton.click()
    await flushUi(2)

    const deleteInitialCall = apiFetchMock.mock.calls.find(
      ([path, init]) =>
        path === '/api/after-sales/parts/part-001' && (init as RequestInit | undefined)?.method === 'DELETE',
    )
    expect(deleteInitialCall).toBeTruthy()
    await waitForText(section, 'No parts found yet.')
  })

  it('hides the parts panel when partial install leaves the part projection unavailable', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'partItem', name: 'Parts', backing: 'multitable' }],
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
            createdObjects: ['serviceTicket', 'installedAsset', 'customer', 'serviceRecord'],
            createdViews: ['ticket-board'],
            warnings: ['partItem provisioning failed'],
            reportRef: 'install-parts-003',
          },
          reportRef: 'install-parts-003',
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

      if (path === '/api/after-sales/field-policies') {
        return createResponse({
          projectId: 'tenant:after-sales',
          fields: {
            serviceTicket: {
              refundAmount: { visibility: 'visible', editability: 'editable' },
            },
          },
        })
      }

      if (path === '/api/after-sales/parts') {
        return createErrorResponse(
          'AFTER_SALES_OBJECT_UNAVAILABLE',
          'After-sales part inventory is unavailable for the current install state',
        )
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'Install state')
    await waitForElementMissing(container, '.after-sales-view__part-items-shell')

    expect(container.textContent).not.toContain('Part inventory')
    expect(container.textContent).not.toContain('Failed to load parts')
  })
})
