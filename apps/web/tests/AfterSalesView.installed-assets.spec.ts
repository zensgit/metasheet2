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

describe('AfterSalesView installed assets panel', () => {
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

  it('loads installed assets when after-sales is installed', async () => {
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
            reportRef: 'install-assets-001',
          },
          reportRef: 'install-assets-001',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          tickets: [],
        })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          serviceRecords: [],
        })
      }

      if (path === '/api/after-sales/installed-assets') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          installedAssets: [
            {
              id: 'asset-001',
              version: 1,
              data: {
                assetCode: 'AST-1001',
                serialNo: 'SN-1001',
                model: 'Compressor X',
                location: 'Plant 1',
                installedAt: '2026-04-09T08:00:00Z',
                warrantyUntil: '2027-04-09T00:00:00Z',
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

    await waitForText(container, 'AST-1001')

    expect(container.textContent).toContain('Installed asset registry')
    expect(container.textContent).toContain('SN-1001')
    expect(container.textContent).toContain('Compressor X')
    expect(container.textContent).toContain('Plant 1')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/installed-assets', undefined)
  })

  it('supports partial-state filters and refreshes only the installed-asset list', async () => {
    let currentCalls = 0
    let ticketCalls = 0
    let serviceRecordCalls = 0
    const assetPaths: string[] = []

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
            warnings: ['installedAsset view recreated'],
            reportRef: 'install-assets-002',
          },
          reportRef: 'install-assets-002',
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

      if (path === '/api/after-sales/service-records') {
        serviceRecordCalls += 1
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          serviceRecords: [],
        })
      }

      if (path === '/api/after-sales/installed-assets') {
        assetPaths.push(path)
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          installedAssets: [
            {
              id: 'asset-001',
              version: 1,
              data: {
                assetCode: 'AST-BASE',
                serialNo: '',
                model: 'Base unit',
                location: 'Dock',
                installedAt: '2026-04-09T08:00:00Z',
                warrantyUntil: '',
                status: 'active',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/installed-assets?status=active&search=compressor') {
        assetPaths.push(path)
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          installedAssets: [
            {
              id: 'asset-002',
              version: 1,
              data: {
                assetCode: 'AST-2002',
                serialNo: 'SN-2002',
                model: 'Compressor X',
                location: 'Plant 2',
                installedAt: '2026-04-10T08:00:00Z',
                warrantyUntil: '2027-04-10T00:00:00Z',
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

    await waitForText(container, 'AST-BASE')

    const section = findSection(container, 'Installed asset registry')
    const statusSelect = section.querySelector<HTMLSelectElement>('#after-sales-installed-asset-filter-status')
    const searchInput = section.querySelector<HTMLInputElement>('#after-sales-installed-asset-filter-search')
    expect(statusSelect).toBeTruthy()
    expect(searchInput).toBeTruthy()
    if (!statusSelect || !searchInput) return

    await setSelectValue(statusSelect, 'active')
    await setInputValue(searchInput, 'compressor')

    findButtonWithin(section, 'Apply filters').click()
    await waitForText(section, 'AST-2002')

    expect(statusSelect.value).toBe('active')
    expect(searchInput.value).toBe('compressor')
    expect(currentCalls).toBe(1)
    expect(ticketCalls).toBe(1)
    expect(serviceRecordCalls).toBe(1)
    expect(assetPaths).toEqual([
      '/api/after-sales/installed-assets',
      '/api/after-sales/installed-assets?status=active&search=compressor',
    ])

    findButtonWithin(section, 'Refresh list').click()
    await waitForText(section, 'AST-2002')

    expect(statusSelect.value).toBe('active')
    expect(searchInput.value).toBe('compressor')
    expect(currentCalls).toBe(1)
    expect(ticketCalls).toBe(1)
    expect(serviceRecordCalls).toBe(1)
    expect(assetPaths).toEqual([
      '/api/after-sales/installed-assets',
      '/api/after-sales/installed-assets?status=active&search=compressor',
      '/api/after-sales/installed-assets?status=active&search=compressor',
    ])
  })

  it('creates installed assets inline and prepends them without reloading the page', async () => {
    let assetListCalls = 0

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
            reportRef: 'install-assets-003',
          },
          reportRef: 'install-assets-003',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          tickets: [],
        })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          serviceRecords: [],
        })
      }

      if (path === '/api/after-sales/installed-assets' && (!init || !init.method)) {
        assetListCalls += 1
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          installedAssets: [
            {
              id: 'asset-001',
              version: 1,
              data: {
                assetCode: 'AST-BASE',
                serialNo: 'SN-BASE',
                model: 'Base unit',
                location: 'Dock',
                installedAt: '2026-04-09T08:00:00Z',
                warrantyUntil: '',
                status: 'active',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/installed-assets' && init?.method === 'POST') {
        return createResponse({
          projectId: 'tenant:after-sales',
          installedAsset: {
            id: 'asset-002',
            version: 1,
            data: {
              assetCode: 'AST-3001',
              serialNo: 'SN-3001',
              model: 'Compressor Z',
              location: 'Plant 3',
              installedAt: '2026-04-11T08:00:00Z',
              warrantyUntil: '2027-04-11',
              status: 'active',
            },
          },
        }, { status: 201 })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'AST-BASE')

    const section = findSection(container, 'Installed asset registry')
    const assetCodeInput = section.querySelector<HTMLInputElement>('#after-sales-installed-asset-code')
    const serialNoInput = section.querySelector<HTMLInputElement>('#after-sales-installed-asset-serial-no')
    const modelInput = section.querySelector<HTMLInputElement>('#after-sales-installed-asset-model')
    const locationInput = section.querySelector<HTMLInputElement>('#after-sales-installed-asset-location')
    expect(assetCodeInput).toBeTruthy()
    expect(serialNoInput).toBeTruthy()
    expect(modelInput).toBeTruthy()
    expect(locationInput).toBeTruthy()
    if (!assetCodeInput || !serialNoInput || !modelInput || !locationInput) return

    await setInputValue(assetCodeInput, 'AST-3001')
    await setInputValue(serialNoInput, 'SN-3001')
    await setInputValue(modelInput, 'Compressor Z')
    await setInputValue(locationInput, 'Plant 3')

    findButtonWithin(section, 'Create asset').click()

    await waitForText(section, 'Created installed asset AST-3001')
    expect(section.textContent).toContain('AST-3001')
    expect(section.textContent).toContain('SN-3001')
    expect(section.textContent).toContain('Compressor Z')
    expect(assetListCalls).toBe(1)
  })

  it('deletes installed assets inline and removes only the targeted row', async () => {
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
            reportRef: 'install-assets-003b',
          },
          reportRef: 'install-assets-003b',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          tickets: [],
        })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          serviceRecords: [],
        })
      }

      if (path === '/api/after-sales/installed-assets' && (!init || !init.method)) {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 2,
          installedAssets: [
            {
              id: 'asset-delete',
              version: 1,
              data: {
                assetCode: 'AST-DELETE',
                serialNo: 'SN-DELETE',
                model: 'Temporary unit',
                location: 'Plant 9',
                installedAt: '2026-04-09T08:00:00Z',
                warrantyUntil: '',
                status: 'active',
              },
            },
            {
              id: 'asset-keep',
              version: 1,
              data: {
                assetCode: 'AST-KEEP',
                serialNo: 'SN-KEEP',
                model: 'Primary unit',
                location: 'Plant 1',
                installedAt: '2026-04-08T08:00:00Z',
                warrantyUntil: '',
                status: 'active',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/installed-assets/asset-delete' && init?.method === 'DELETE') {
        return createResponse({
          projectId: 'tenant:after-sales',
          installedAssetId: 'asset-delete',
          version: 4,
          deleted: true,
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'AST-DELETE')

    const deleteButton = container.querySelector<HTMLButtonElement>('button[aria-label="Delete installed asset AST-DELETE"]')
    expect(deleteButton).toBeTruthy()
    if (!deleteButton) return

    deleteButton.click()

    await waitForText(container, 'Deleted installed asset AST-DELETE')

    expect(container.textContent).not.toContain('Temporary unit')
    expect(container.textContent).toContain('AST-KEEP')
    expect(container.querySelector('button[aria-label="Delete installed asset AST-DELETE"]')).toBeNull()
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/installed-assets/asset-delete', { method: 'DELETE' })
  })

  it('keeps the installed-asset draft when create fails', async () => {
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
            reportRef: 'install-assets-004',
          },
          reportRef: 'install-assets-004',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          tickets: [],
        })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          serviceRecords: [],
        })
      }

      if (path === '/api/after-sales/installed-assets' && (!init || !init.method)) {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          installedAssets: [
            {
              id: 'asset-001',
              version: 1,
              data: {
                assetCode: 'AST-BASE',
                serialNo: 'SN-BASE',
                model: 'Base unit',
                location: 'Dock',
                installedAt: '2026-04-09T08:00:00Z',
                warrantyUntil: '',
                status: 'active',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/installed-assets' && init?.method === 'POST') {
        return createResponse({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to create after-sales installed asset',
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

    await waitForText(container, 'AST-BASE')

    const section = findSection(container, 'Installed asset registry')
    const assetCodeInput = section.querySelector<HTMLInputElement>('#after-sales-installed-asset-code')
    const modelInput = section.querySelector<HTMLInputElement>('#after-sales-installed-asset-model')
    expect(assetCodeInput).toBeTruthy()
    expect(modelInput).toBeTruthy()
    if (!assetCodeInput || !modelInput) return

    await setInputValue(assetCodeInput, 'AST-DUPLICATE')
    await setInputValue(modelInput, 'Compressor X')

    findButtonWithin(section, 'Create asset').click()

    await waitForText(section, 'Failed to create after-sales installed asset')
    expect(assetCodeInput.value).toBe('AST-DUPLICATE')
    expect(modelInput.value).toBe('Compressor X')
    expect(section.textContent).toContain('AST-BASE')
  })

  it('surfaces delete errors inline without clearing existing installed assets', async () => {
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
            reportRef: 'install-assets-005',
          },
          reportRef: 'install-assets-005',
        })
      }

      if (path === '/api/after-sales/tickets') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          tickets: [],
        })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          serviceRecords: [],
        })
      }

      if (path === '/api/after-sales/installed-assets' && (!init || !init.method)) {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          installedAssets: [
            {
              id: 'asset-delete-error',
              version: 1,
              data: {
                assetCode: 'AST-DELETE-ERR',
                serialNo: 'SN-BASE',
                model: 'Still visible after delete failure',
                location: 'Dock',
                installedAt: '2026-04-09T08:00:00Z',
                warrantyUntil: '',
                status: 'active',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/installed-assets/asset-delete-error' && init?.method === 'DELETE') {
        return createResponse(
          {
            error: {
              code: 'NOT_FOUND',
              message: 'Installed asset already deleted',
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

    const deleteButton = container.querySelector<HTMLButtonElement>('button[aria-label="Delete installed asset AST-DELETE-ERR"]')
    expect(deleteButton).toBeTruthy()
    if (!deleteButton) return

    deleteButton.click()

    await waitForText(container, 'Installed asset already deleted')

    expect(container.textContent).toContain('Still visible after delete failure')
    expect(container.textContent).toContain('Installed asset already deleted')
  })
})
